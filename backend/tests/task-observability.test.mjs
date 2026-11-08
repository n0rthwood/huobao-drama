import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

/** 每个场景一套隔离库：观测表是启动建表，初始化由 db/index.ts 完成 */
function runScenario(name, script) {
  const dir = mkdtempSync(path.join(tmpdir(), `${name}-`))
  try {
    const output = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3') },
    })
    return JSON.parse(output.slice(output.lastIndexOf('@@') + 2))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const PRELUDE = `
  import {
    runObservedWork, observeTaskOperation, observeTextCall, recordFinalToolResults,
    freezeInterruptedObservations, listObservedWork, listObservedCalls, listObservedMessages,
  } from './src/services/task-observability.ts'
  import { sqlite } from './src/db/index.ts'
  const NL = String.fromCharCode(10)
  const enc = new TextEncoder()
  const sseFrom = (chunks) => new ReadableStream({
    start(controller) {
      for (const obj of chunks) controller.enqueue(enc.encode('data: ' + JSON.stringify(obj) + NL + NL))
      controller.enqueue(enc.encode('data: [DONE]' + NL + NL))
      controller.close()
    },
  })
  const sseResponse = (chunks) => new Response(sseFrom(chunks), { headers: { 'content-type': 'text/event-stream' } })
  const META = { kind: 'llm', configId: 14, configName: 'GLM 5.3', provider: 'openai', model: 'glm-5.3', baseUrl: 'https://gw.example.com/v1' }
`

test('streamed multi-step agent calls persist the full public conversation, tool arguments and final tool results', () => {
  const result = runScenario('obs-stream', `${PRELUDE}
    const tools = [{ type: 'function', function: { name: 'read_image', description: '读取资产原图', parameters: { type: 'object' } } }]
    const argsText = '{"path": "static/a.png"}'
    const baseMessages = [
      { role: 'system', content: 'SKILL 全文：设计卡填写规则 —— 以现有资产和既有制作能力完成设计' },
      { role: 'user', content: '请为分镜 #1 填写设计卡' },
    ]
    const req1 = { model: 'glm-5.3', stream: true, max_tokens: 32768, tools, messages: baseMessages }
    const req2 = { model: 'glm-5.3', stream: true, max_tokens: 32768, tools, messages: baseMessages.concat([
      { role: 'assistant', content: '先读资产', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_image', arguments: argsText } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '图片描述：东部地理底图，没有标注航线' },
    ]) }
    const step1 = [
      { choices: [{ delta: { content: '先读' } }] },
      { choices: [{ delta: { content: '资产' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_image', arguments: '{"path": ' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"static/a.png"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 120, completion_tokens: 30 } },
    ]
    const step2 = [
      { choices: [{ delta: { content: '设计卡已写入' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 300, completion_tokens: 40 } },
    ]
    const taskId = 9001
    await runObservedWork(
      { taskId, stage: 'design_card', sourceChars: 86, sampleKey: 'design_card|cfg:14|model:glm-5.3', storyboardId: 433, storyboardNumber: 1 },
      async () => {
        const first = observeTextCall(META, async () => sseResponse(step1))
        const r1 = await first('https://gw.example.com/v1/chat/completions', { method: 'POST', body: JSON.stringify(req1) })
        await r1.text()
        const second = observeTextCall(META, async () => sseResponse(step2))
        const r2 = await second('https://gw.example.com/v1/chat/completions', { method: 'POST', body: JSON.stringify(req2) })
        await r2.text()
        await recordFinalToolResults({ toolResults: [
          { type: 'tool-result', payload: { toolCallId: 'call_2', toolName: 'update_storyboard', result: { saved: true, storyboard_id: 433 } } },
          { type: 'tool-result', payload: { toolCallId: 'call_1', toolName: 'read_image', result: '重复的工具结果不应再存一次' } },
        ] })
      },
    )
    const works = listObservedWork(taskId)
    const calls = listObservedCalls(taskId, { limit: 50 })
    const first = listObservedMessages(calls[0].id, { limit: 200 })
    const second = listObservedMessages(calls[1].id, { limit: 200 })
    const page1 = listObservedMessages(calls[0].id, { limit: 2 })
    const page2 = listObservedMessages(calls[0].id, { limit: 2, afterId: page1[page1.length - 1].id })
    process.stdout.write('@@' + JSON.stringify({ works, calls, first, second, page1, page2 }))
  `)

  assert.equal(result.works.length, 1)
  assert.equal(result.works[0].status, 'completed')
  assert.equal(result.works[0].source_chars, 86)
  assert.equal(result.works[0].storyboard_number, 1)
  assert.equal(result.works[0].call_count, 2)
  assert.ok(result.works[0].finished_at >= result.works[0].started_at)

  assert.equal(result.calls.length, 2)
  assert.ok(result.calls.every(call => call.status === 'completed' && call.stream === 1 && call.duration_ms !== null))
  assert.equal(result.calls[0].prompt_tokens, 120)
  assert.equal(result.calls[1].prompt_tokens, 300)
  assert.equal(result.calls[0].model, 'glm-5.3')
  assert.equal(result.calls[0].config_id, 14)

  // 发出的全部公开消息（含注入的技能全文与工具定义）都逐字保留
  const roles = result.first.map(m => m.role)
  assert.ok(roles.includes('system') && roles.includes('user') && roles.includes('tool_definitions'))
  assert.ok(result.first.find(m => m.role === 'system').body.includes('SKILL 全文'))
  assert.ok(result.first.find(m => m.role === 'tool_definitions').body.includes('read_image'))
  // 流式正文与流式拼接出来的工具参数
  const assistant = result.first.find(m => m.phase === 'response' && m.role === 'assistant')
  assert.equal(assistant.body, '先读资产')
  assert.equal(assistant.streaming, 0)
  const toolCall = result.first.find(m => m.phase === 'response' && m.role === 'tool_call')
  assert.equal(toolCall.name, 'read_image')
  assert.equal(toolCall.tool_call_id, 'call_1')
  assert.equal(toolCall.body, '{"path": "static/a.png"}')
  // 工具返回随下一次请求落盘
  const toolReply = result.second.find(m => m.role === 'tool')
  assert.equal(toolReply.tool_call_id, 'call_1')
  assert.ok(toolReply.body.includes('东部地理底图'))
  // 无后续模型请求的收尾工具结果补记，且不重复已存在的 call_1
  const finals = result.second.filter(m => m.phase === 'final')
  assert.equal(finals.length, 1)
  assert.equal(finals[0].tool_call_id, 'call_2')
  assert.ok(finals[0].body.includes('"saved": true'))

  // 分页：游标继续读，不是「只给最近 N 条」
  assert.equal(result.page1.length, 2)
  assert.equal(result.page1[0].id, result.first[0].id)
  assert.ok(result.page2[0].id > result.page1[1].id)
})

test('non-stream vision calls and TTS operations persist placeholders instead of credentials or binary bytes', () => {
  const result = runScenario('obs-binary', `${PRELUDE}
    const dataUrl = 'data:image/jpeg;base64,' + 'A'.repeat(4096)
    const request = { model: 'deepseek-vl', messages: [
      { role: 'system', content: '读图并描述' },
      { role: 'user', content: [{ type: 'text', text: '这张图里有什么' }, { type: 'image_url', image_url: { url: dataUrl } }] },
    ] }
    const body = JSON.stringify({ choices: [{ message: { content: '一张东部水系地图' }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 12 } })
    const visionMeta = { kind: 'vision_chat', configId: 10, configName: 'DeepSeek', provider: 'openai', model: 'deepseek-vl' }
    const taskId = 9002
    await runObservedWork(
      { taskId, stage: 'voice', sourceChars: 42, sampleKey: 'voice|cfg:7|model:voxcpm|voice:narrator' },
      async () => {
        const call = observeTextCall(visionMeta, async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }))
        const res = await call('https://gw.example.com/v1/chat/completions?api_key=sk-livesecretvalue123456', { method: 'POST', body: JSON.stringify(request) })
        await res.json()
        await observeTaskOperation(
          { kind: 'tts', configId: 7, model: 'voxcpm', request: { text: '邗沟开凿', voice: 'narrator', token: 'sk-ttssecretvalue1234', audio_prompt: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]) } },
          async () => ({ audio_url: '/static/narration/1.wav', duration_ms: 7200, bytes: Buffer.alloc(64), inline_b64: 'B'.repeat(2048) }),
        )
      },
    )
    const calls = listObservedCalls(taskId, { limit: 50 })
    const vision = listObservedMessages(calls[0].id, { limit: 200 })
    const tts = listObservedMessages(calls[1].id, { limit: 200 })
    process.stdout.write('@@' + JSON.stringify({ calls, vision, tts }))
  `)

  const [vision, tts] = result.calls
  assert.equal(vision.kind, 'vision_chat')
  assert.equal(vision.status, 'completed')
  assert.equal(vision.prompt_tokens, 900)
  // URL 里的凭据脱敏后才入库
  assert.ok(!vision.url.includes('sk-livesecretvalue'))

  const userMessage = result.vision.find(m => m.role === 'user')
  assert.ok(userMessage.body.includes('这张图里有什么'))
  assert.ok(!userMessage.body.includes('A'.repeat(64)))
  assert.equal(result.vision.find(m => m.phase === 'response' && m.role === 'assistant').body, '一张东部水系地图')

  // TTS：请求/结果元信息留存，音频字节与凭据不留存；模型耗时不是音频长度
  assert.equal(tts.kind, 'tts')
  assert.equal(tts.model, 'voxcpm')
  assert.ok(tts.duration_ms !== null && tts.duration_ms < 7200)
  const ttsRequest = result.tts.find(m => m.phase === 'request')
  assert.ok(ttsRequest.body.includes('邗沟开凿'))
  assert.ok(!ttsRequest.body.includes('sk-ttssecretvalue'))
  const ttsResult = result.tts.find(m => m.phase === 'response')
  assert.ok(ttsResult.body.includes('7200'))
  assert.ok(!ttsResult.body.includes('B'.repeat(64)))
})

test('failed responses, broken streams and restarts keep partial evidence without fabricating duration', () => {
  const result = runScenario('obs-recovery', `${PRELUDE}
    const request = { model: 'glm-5.3', stream: true, messages: [{ role: 'user', content: '生成旁白骨架' }] }
    const taskId = 9003
    // 1) 非 2xx：完整错误正文入库，调用记失败
    await runObservedWork({ taskId, stage: 'skeleton', sourceChars: 2186, sampleKey: 'skeleton|cfg:14|model:glm-5.3' }, async () => {
      const call = observeTextCall(META, async () => new Response('{"error":{"message":"no vision config"}}', { status: 500, headers: { 'content-type': 'application/json' } }))
      const res = await call('https://gw.example.com/v1/chat/completions', { method: 'POST', body: JSON.stringify(request) })
      await res.text()
    })
    // 2) 流中断：已收到的公开正文保留，调用记失败
    await runObservedWork({ taskId, stage: 'skeleton', sourceChars: 2186, sampleKey: 'skeleton|cfg:14|model:glm-5.3' }, async () => {
      let producer
      const broken = new ReadableStream({
        start(controller) {
          producer = controller
          controller.enqueue(enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: '已经写了一半' } }] }) + NL + NL))
        },
      })
      const call = observeTextCall(META, async () => new Response(broken, { headers: { 'content-type': 'text/event-stream' } }))
      const res = await call('https://gw.example.com/v1/chat/completions', { method: 'POST', body: JSON.stringify(request) })
      const reader = res.body.getReader()
      await reader.read() // 已真实收到首片，再制造传输中断；不是尚未读取便清空源队列。
      producer.error(new Error('connection reset'))
      try { await reader.read() } catch { /* 调用方同样会看到流错误 */ }
    })
    // 3) 重启冻结：在飞记录按最后一次持久心跳结算
    const started = Date.now() - 60000
    const beat = started + 5000
    const workInsert = sqlite.prepare('INSERT INTO task_observed_work (task_id, stage, source_chars, sample_key, started_at, status, heartbeat_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(taskId, 'voice', 120, 'voice|cfg:7|model:voxcpm', started, 'processing', beat, started)
    const workId = Number(workInsert.lastInsertRowid)
    sqlite.prepare('INSERT INTO task_observed_call (work_id, task_id, kind, model, status, started_at, queue_ms, heartbeat_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(workId, taskId, 'tts', 'voxcpm', 'processing', started, 3000, beat, started)
    const frozen = freezeInterruptedObservations()
    const frozenAgain = freezeInterruptedObservations()
    const works = listObservedWork(taskId)
    const calls = listObservedCalls(taskId, { limit: 50 })
    const brokenMessages = listObservedMessages(calls[1].id, { limit: 200 })
    process.stdout.write('@@' + JSON.stringify({ frozen, frozenAgain, works, calls, brokenMessages, started, beat }))
  `)

  const [httpCall, brokenCall, frozenCall] = result.calls
  assert.equal(httpCall.status, 'failed')
  assert.equal(httpCall.http_status, 500)
  assert.ok(httpCall.error_msg.includes('no vision config'))

  assert.equal(brokenCall.status, 'failed')
  assert.ok(brokenCall.error_msg.includes('connection reset'))
  const partial = result.brokenMessages.find(m => m.phase === 'response' && m.role === 'assistant')
  assert.equal(partial.body, '已经写了一半')

  // 失败调用的工作项仍然保留历史，不被当成成功样本
  assert.equal(result.works.filter(w => w.stage === 'skeleton').length, 2)
  assert.ok(result.works.filter(w => w.stage === 'skeleton').every(w => w.status === 'completed' || w.status === 'failed'))

  // 重启冻结：状态中断、结束时间 = 最后心跳、耗时 = 心跳 - 开始，模型耗时不补未落盘的尾巴
  assert.deepEqual(result.frozen, { works: 1, calls: 1 })
  const frozenWork = result.works.find(w => w.stage === 'voice')
  assert.equal(frozenWork.status, 'interrupted')
  assert.equal(frozenWork.finished_at, result.beat)
  assert.equal(frozenWork.work_ms, 5000)
  assert.equal(frozenWork.model_ms, 5000)
  assert.equal(frozenWork.queue_ms, 3000)
  assert.equal(frozenWork.call_count, 1)
  assert.deepEqual(result.frozenAgain, { works: 0, calls: 0 })
  assert.equal(frozenCall.status, 'interrupted')
  assert.equal(frozenCall.finished_at, result.beat)
  assert.equal(frozenCall.duration_ms, 5000)
})

test('sanitization replaces only real binary and credentials, never long legitimate text', () => {
  const result = runScenario('obs-sanitize', `${PRELUDE}
    const longRun = 'a1B2c3D4'.repeat(400)
    const shortImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
    const request = { model: 'glm-5.3', stream: true, messages: [
      { role: 'user', content: [
        { type: 'text', text: '这是一段合法长正文：' + longRun },
        { type: 'image_url', image_url: { url: shortImage } },
      ] },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'save_design_card', arguments: '{"rationale": "' + longRun + '"}' } }] },
    ] }
    const taskId = 9004
    await runObservedWork({ taskId, stage: 'design_card', sourceChars: 10, sampleKey: 'design_card|cfg:14|model:glm-5.3' }, async () => {
      const call = observeTextCall(META, async () => sseResponse([{ choices: [{ delta: { content: longRun }, finish_reason: 'stop' }] }]))
      const res = await call('https://gw.example.com/v1/chat/completions', { method: 'POST', body: JSON.stringify(request) })
      await res.text()
    })
    const calls = listObservedCalls(taskId, { limit: 10 })
    const messages = listObservedMessages(calls[0].id, { limit: 200 })
    process.stdout.write('@@' + JSON.stringify({ messages, longRun, shortImage }))
  `)

  const user = result.messages.find(m => m.role === 'user')
  // 合法长 ASCII 正文逐字保留：绝不按「看起来像 base64」猜二进制
  assert.ok(user.body.includes(result.longRun))
  // 短 data:URL 同样占位，不是只处理长载荷
  assert.ok(!user.body.includes('iVBORw0KGgo'))
  // 工具参数与流式正文也一样保留全文
  assert.ok(result.messages.find(m => m.role === 'tool_call').body.includes(result.longRun))
  const assistant = result.messages.find(m => m.phase === 'response' && m.role === 'assistant')
  assert.equal(assistant.body, result.longRun)
})

test('a stalled stream still persists received text before the next chunk arrives', () => {
  const result = runScenario('obs-stall', `${PRELUDE}
    const parts = ['先写一小段', '再补一句', '最后收尾']
    let step = 0
    const stalling = new ReadableStream({
      async pull(controller) {
        if (step < 2) {
          controller.enqueue(enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: parts[step] } }] }) + NL + NL))
          step += 1
          return
        }
        if (step === 2) {
          step += 1
          await new Promise(resolve => setTimeout(resolve, 900))
          controller.enqueue(enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: parts[2] }, finish_reason: 'stop' }] }) + NL + NL))
          return
        }
        controller.enqueue(enc.encode('data: [DONE]' + NL + NL))
        controller.close()
      },
    })
    const taskId = 9005
    let midFlight = []
    await runObservedWork({ taskId, stage: 'skeleton', sourceChars: 2186, sampleKey: 'skeleton|cfg:14|model:glm-5.3' }, async () => {
      const call = observeTextCall(META, async () => new Response(stalling, { headers: { 'content-type': 'text/event-stream' } }))
      const res = await call('https://gw.example.com/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'glm-5.3', stream: true, messages: [{ role: 'user', content: '生成旁白骨架' }] }) })
      const reading = res.text()
      await new Promise(resolve => setTimeout(resolve, 650))
      midFlight = sqlite.prepare("SELECT role, body, streaming FROM task_observed_message WHERE phase = 'response' ORDER BY id").all()
      await reading
    })
    const calls = listObservedCalls(taskId, { limit: 10 })
    const messages = listObservedMessages(calls[0].id, { limit: 200 })
    process.stdout.write('@@' + JSON.stringify({ midFlight, messages }))
  `)

  // 停流期间：已收到的两段必须已经落盘（首段立即写 + 500ms 定时兜底），且仍标记为接收中
  assert.equal(result.midFlight.length, 1)
  assert.equal(result.midFlight[0].streaming, 1)
  assert.equal(result.midFlight[0].body, '先写一小段再补一句')
  // 收尾后是全文，且转为已定稿
  const assistant = result.messages.find(m => m.phase === 'response' && m.role === 'assistant')
  assert.equal(assistant.body, '先写一小段再补一句最后收尾')
  assert.equal(assistant.streaming, 0)
})

test('streamed credentials never enter either current rows or SQLite WAL, including escaped and unfinished values', () => {
  const inputs = [
    '{"title":"valid title","password":"PRIVATE_ALPHA',
    '{"password":"PRIVATE_ESCAPED_\\"TAILPRIVATE',
    '{"api_key":"PRIVATE_BACKSLASH\\',
    '{"token":1234567890',
    '{"url":"https://http-user:http-secret@provider.example"}',
    'Authorization: Basic dXNlcjpwYXNz',
  ]
  const secrets = ['PRIVATE_ALPHA', 'PRIVATE_ESCAPED_', 'TAILPRIVATE', 'PRIVATE_BACKSLASH', '1234567890', 'http-user', 'http-secret', 'dXNlcjpwYXNz']
  const result = runScenario('obs-credentials', `${PRELUDE}
    import { existsSync, readFileSync } from 'node:fs'
    const inputs = ${JSON.stringify(inputs)}
    await runObservedWork({ taskId: 9010, stage: 'design_card', sourceChars: 10, sampleKey: 'credentials' }, async () => {
      const call = observeTextCall(META, async () => sseResponse([{
        choices: [{ delta: { tool_calls: inputs.map((argumentsText, index) => ({
          index, id: 'sensitive-' + index, function: { name: 'capture', arguments: argumentsText },
        })) }, finish_reason: 'length' }],
      }]))
      const response = await call('https://gw.example.com/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'Check storage redaction' }] }) })
      await response.text()
    })
    const calls = listObservedCalls(9010)
    const messages = listObservedMessages(calls[0].id, { limit: 200 })
    const bytes = Buffer.concat([process.env.SQLITE_PATH, process.env.SQLITE_PATH + '-wal'].filter(existsSync).map(file => readFileSync(file)))
    process.stdout.write('@@' + JSON.stringify({ messages, leaked: ${JSON.stringify(secrets)}.filter(secret => bytes.includes(Buffer.from(secret))) }))
  `)
  assert.deepEqual(result.leaked, [])
  assert.ok(result.messages.some(message => message.role === 'tool_call' && message.body.includes('valid title')))
})

test('SSE error envelopes and non-2xx SSE-labelled bodies retain their actual failure', () => {
  const result = runScenario('obs-sse-errors', `${PRELUDE}
    const request = { stream: true, messages: [{ role: 'user', content: 'Inspect failed responses' }] }
    for (const mode of ['envelope', 'http']) {
      await runObservedWork({ taskId: 9011, stage: 'skeleton', sourceChars: 20, sampleKey: mode }, async () => {
        const call = observeTextCall(META, async () => mode === 'envelope'
          ? sseResponse([{ error: { message: 'provider quota exhausted' } }])
          : new Response('{"error":{"message":"provider rate limit"}}', { status: 429, headers: { 'content-type': 'text/event-stream' } }))
        await (await call('https://gw.example.com/v1/chat/completions', { method: 'POST', body: JSON.stringify(request) })).text()
      })
    }
    const calls = listObservedCalls(9011)
    process.stdout.write('@@' + JSON.stringify({ calls, messages: calls.map(call => listObservedMessages(call.id, { limit: 200 })) }))
  `)
  assert.deepEqual(result.calls.map(call => call.status), ['failed', 'failed'])
  assert.deepEqual(result.calls.map(call => call.http_status), [200, 429])
  assert.ok(result.messages[0].some(message => message.role === 'error' && message.body.includes('provider quota exhausted')))
  assert.ok(result.messages[1].some(message => message.role === 'error' && message.body.includes('provider rate limit')))
})

test('capture persistence failure is visible without rolling back completed business work or leaving a live timer', () => {
  const result = runScenario('obs-capture-failure', `${PRELUDE}
    sqlite.exec("CREATE TRIGGER reject_fixture_text BEFORE INSERT ON task_observed_text WHEN NEW.body LIKE '%fixture-response%' BEGIN SELECT RAISE(ABORT, 'fixture rejection'); END")
    let businessCompleted = false
    let failure = null
    try {
      await runObservedWork({ taskId: 9012, stage: 'skeleton', sourceChars: 20, sampleKey: 'capture-failure' }, async () => {
        const call = observeTextCall(META, async () => sseResponse([{ choices: [{ delta: { content: 'fixture-response' }, finish_reason: 'stop' }] }]))
        await (await call('https://gw.example.com/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'Do real work' }] }) })).text()
        businessCompleted = true
      })
    } catch (error) { failure = error.message }
    const works = listObservedWork(9012)
    const calls = listObservedCalls(9012)
    process.stdout.write('@@' + JSON.stringify({ failure, businessCompleted, works, calls, messages: listObservedMessages(calls[0].id) }))
  `)
  assert.equal(result.businessCompleted, true)
  assert.equal(result.works[0].status, 'failed')
  assert.equal(result.calls[0].status, 'failed')
  assert.match(result.works[0].error_msg, /fixture rejection/)
  assert.ok(result.messages.some(message => message.phase === 'response' && message.body === 'fixture-response'))
})

test('real Agent step persists its tool return before another admission wait and attributes nested vision correctly', () => {
  const result = runScenario('obs-agent-step', `${PRELUDE}
    import { Agent } from '@mastra/core/agent'
    import { createTool } from '@mastra/core/tools'
    import { createOpenAI } from '@ai-sdk/openai'
    import { z } from 'zod'
    import { runAgent } from './src/agents/run.ts'
    let releaseNext, enteredNext
    const gate = new Promise(resolve => { releaseNext = resolve })
    const waiting = new Promise(resolve => { enteredNext = resolve })
    let requests = 0
    const transport = observeTextCall(META, async () => requests === 1
      ? sseResponse([{ id: 'fixture1', model: 'fixture', created: 1, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'read-fixture', type: 'function', function: { name: 'inspect_fixture', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }])
      : sseResponse([{ id: 'fixture2', model: 'fixture', created: 1, choices: [{ index: 0, delta: { content: 'Finished' }, finish_reason: 'stop' }] }]))
    const provider = createOpenAI({ apiKey: 'fixture', baseURL: 'https://fixture.example/v1', fetch: async (input, init) => {
      requests += 1
      if (requests > 1) { enteredNext(); await gate }
      return transport(input, init)
    } })
    const inspectFixture = createTool({
      id: 'inspect_fixture', description: 'Read a fixture through the vision boundary',
      inputSchema: z.object({}), outputSchema: z.object({ value: z.string() }),
      execute: async () => {
        const vision = observeTextCall({ ...META, kind: 'vision' }, async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Image read' } }] }), { headers: { 'content-type': 'application/json' } }))
        await (await vision('https://fixture.example/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'Read fixture' }] }) })).text()
        return { value: 'persisted-before-queue' }
      },
    })
    const agent = new Agent({ id: 'observed-fixture', name: 'Observed fixture', instructions: 'Use inspect_fixture, then finish.', model: provider.chat('fixture'), tools: { inspect_fixture: inspectFixture } })
    const running = runObservedWork({ taskId: 9013, stage: 'design_card', sourceChars: 40, sampleKey: 'agent-step' }, () => runAgent(agent, 'Read fixture', { maxSteps: 2 }))
    let timeout
    try {
      await Promise.race([waiting, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Agent did not reach the next admission boundary')), 10000) })])
    } finally { clearTimeout(timeout) }
    const callsBeforeRelease = listObservedCalls(9013)
    const messagesBeforeRelease = callsBeforeRelease.map(call => listObservedMessages(call.id, { limit: 200 }))
    releaseNext()
    await running
    process.stdout.write('@@' + JSON.stringify({ callsBeforeRelease, messagesBeforeRelease }))
  `)
  const modelIndex = result.callsBeforeRelease.findIndex(call => call.kind === 'llm')
  const visionIndex = result.callsBeforeRelease.findIndex(call => call.kind === 'vision')
  assert.ok(modelIndex >= 0 && visionIndex >= 0)
  assert.ok(result.messagesBeforeRelease[modelIndex].some(message => message.role === 'tool_result' && message.tool_call_id === 'read-fixture' && message.body.includes('persisted-before-queue')))
  assert.ok(!result.messagesBeforeRelease[visionIndex].some(message => message.role === 'tool_result'))
})
