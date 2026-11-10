/**
 * 本地 OpenAI 兼容的 /v1/chat/completions 夹具：按脚本回答文本或工具调用。
 * 流式请求回 SSE（AI SDK 的 chat 通道），非流式请求回 JSON（callTextChat 直连）。
 * `respond(body)` 返回 `{ text }` 或 `{ toolCalls: [{ name, args }] }`。
 */
import http from 'node:http'

export async function startMockOpenAIChat(respond) {
  const requests = []
  let callSeq = 0
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', async () => {
      let body
      try {
        body = JSON.parse(raw || '{}')
      } catch {
        res.writeHead(400).end('bad json')
        return
      }
      requests.push(body)
      let reply
      try {
        reply = await respond(body)
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: String(err?.message ?? err) } }))
        return
      }
      const usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          id: 'mock', object: 'chat.completion', created: 1, model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: reply.text ?? '' }, finish_reason: 'stop' }],
          usage,
        }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const send = (payload) => res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1, model: body.model, ...payload })}\n\n`)
      if (reply.toolCalls?.length) {
        send({
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: reply.toolCalls.map((call, index) => ({
                index, id: `call_${++callSeq}`, type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
              })),
            },
            finish_reason: null,
          }],
        })
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage })
      } else {
        send({ choices: [{ index: 0, delta: { role: 'assistant', content: reply.text ?? '' }, finish_reason: null }] })
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })
      }
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

/** 本次请求里已经发生过的工具结果（按工具名），供脚本决定下一步 */
export function toolResults(body, name) {
  const ids = new Map()
  for (const message of body.messages ?? []) {
    for (const call of message.tool_calls ?? []) ids.set(call.id, call.function?.name)
  }
  return (body.messages ?? [])
    .filter(message => message.role === 'tool' && (!name || ids.get(message.tool_call_id) === name))
    .map(message => {
      const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
      try { return JSON.parse(text) } catch { return text }
    })
}

export function systemText(body) {
  return (body.messages ?? []).filter(m => m.role === 'system').map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')
}

export function userText(body) {
  return (body.messages ?? []).filter(m => m.role === 'user').map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')
}
