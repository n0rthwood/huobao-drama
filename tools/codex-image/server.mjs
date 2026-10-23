#!/usr/bin/env node
/**
 * codex 生图本机包装服务 —— OpenAI 兼容的 /v1/images/generations 与 /v1/images/edits。
 *
 * 每个请求 one-shot 调用 `codex exec`（本机已登录的 ChatGPT 账号），
 * 图片由 codex 写入 ~/.codex/generated_images/<session-id>/，session-id 取自 codex 输出，
 * 因此并发请求互不串图，也不会误取旧图。
 *
 * 配置只读自仓库外：$HUOBAO_LOCAL_CONFIG_DIR/codex-image.json（默认 ~/.config/huobao-drama-local/）
 *   { "port": 5681, "token": "...", "concurrency": 3, "timeout_s": 600 }
 * 环境变量 CODEX_BIN 可覆盖 codex 可执行文件（默认从 PATH 查找）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const configDir = process.env.HUOBAO_LOCAL_CONFIG_DIR || path.join(os.homedir(), '.config', 'huobao-drama-local')
const configFile = path.join(configDir, 'codex-image.json')
if (!fs.existsSync(configFile)) {
  console.error(`未找到配置文件: ${configFile}`)
  process.exit(1)
}
const { port, token, concurrency = 3, timeout_s: timeoutS = 600 } = JSON.parse(fs.readFileSync(configFile, 'utf8'))
if (!port || !token) {
  console.error(`${configFile} 需要 port 与 token`)
  process.exit(1)
}

const CODEX_BIN = process.env.CODEX_BIN || 'codex'
const GENERATED_DIR = path.join(os.homedir(), '.codex', 'generated_images')
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i
const MAX_BODY = 100 * 1024 * 1024

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// ── 并发闸门 ────────────────────────────────────────────────
let running = 0
const waiters = []
async function acquire() {
  if (running < concurrency) {
    running++
    return
  }
  const { promise, resolve } = Promise.withResolvers()
  waiters.push(resolve)
  await promise
}
function release() {
  const next = waiters.shift()
  if (next) next()
  else running--
}

// ── 提示词 ──────────────────────────────────────────────────
function gcd(a, b) {
  return b ? gcd(b, a % b) : a
}

function buildPrompt(userPrompt, size, refCount) {
  let text = `$imagegen ${userPrompt.trim()}.`
  if (refCount === 1) {
    text += " Use the attached reference image faithfully: keep the subject's identity, composition cues and details consistent with what is shown."
  } else if (refCount > 1) {
    text += ' Use the attached reference images: the first defines the main subject, the others provide style/detail cues.'
  }
  const m = /^(\d+)x(\d+)$/.exec(size || '')
  if (m) {
    const w = Number(m[1])
    const h = Number(m[2])
    const g = gcd(w, h)
    text += ` Output aspect ratio ${w / g}:${h / g}.`
  }
  return `${text} Generate the image now; reply with only: done.`
}

// ── codex 调用 ──────────────────────────────────────────────
function runCodex(args, cwd) {
  const { promise, resolve, reject } = Promise.withResolvers()
  const child = spawn(CODEX_BIN, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (d) => { output += d })
  child.stderr.on('data', (d) => { output += d })
  const timer = setTimeout(() => {
    child.kill('SIGKILL')
    reject(new HttpError(504, `codex 超时（${timeoutS}s）`))
  }, timeoutS * 1000)
  child.on('error', (err) => {
    clearTimeout(timer)
    reject(new HttpError(502, `无法启动 codex: ${err.message}`))
  })
  child.on('close', (code) => {
    clearTimeout(timer)
    resolve({ code, output })
  })
  return promise
}

function pickGeneratedImage(sessionId) {
  const dir = path.join(GENERATED_DIR, sessionId)
  if (!fs.existsSync(dir)) return null
  const files = fs.readdirSync(dir)
    .filter((f) => IMAGE_EXT.test(f))
    .map((f) => ({ file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return files[0]?.file ?? null
}

async function generate({ prompt, size, refs }) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-image-'))
  try {
    const refPaths = refs.map((ref, i) => {
      const ext = path.extname(ref.name || '').toLowerCase()
      const file = path.join(workDir, `ref${i}${IMAGE_EXT.test(ext) ? ext : '.png'}`)
      fs.writeFileSync(file, ref.data)
      return file
    })
    // 注意：提示词必须在 -i 之前，否则会被 -i 的变长参数吞掉
    const args = ['exec', '--skip-git-repo-check', '-C', workDir, '--sandbox', 'workspace-write', buildPrompt(prompt, size, refPaths.length)]
    for (const p of refPaths) args.push('-i', p)

    await acquire()
    let result
    try {
      result = await runCodex(args, workDir)
    } finally {
      release()
    }

    const sessionId = /session id:\s*([0-9a-f-]{36})/i.exec(result.output)?.[1]
    const image = sessionId ? pickGeneratedImage(sessionId) : null
    if (!image) {
      throw new HttpError(502, `codex 未生成图片 (rc=${result.code}): ${result.output.slice(-400)}`)
    }
    return fs.readFileSync(image)
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}

// ── HTTP ────────────────────────────────────────────────────
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new HttpError(413, '请求体过大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function parseRequest(req, endpoint) {
  const contentType = req.headers['content-type'] || ''
  const body = await readBody(req)
  if (endpoint === 'generations') {
    if (!contentType.includes('application/json')) throw new HttpError(415, '需要 application/json')
    const json = JSON.parse(body.toString('utf8') || '{}')
    return { prompt: json.prompt, size: json.size, refs: [] }
  }
  if (!contentType.includes('multipart/form-data')) throw new HttpError(415, '需要 multipart/form-data')
  const form = await new Request('http://localhost/', { method: 'POST', headers: { 'content-type': contentType }, body }).formData()
  const refs = []
  for (const [key, value] of form.entries()) {
    if ((key === 'image' || key === 'image[]') && typeof value !== 'string') {
      refs.push({ name: value.name, data: Buffer.from(await value.arrayBuffer()) })
    }
  }
  return { prompt: form.get('prompt'), size: form.get('size'), refs }
}

function sendJson(res, status, payload) {
  const data = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) })
  res.end(data)
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { status: 'ok' })
    }
    if (req.headers.authorization !== `Bearer ${token}`) throw new HttpError(401, 'invalid token')

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return sendJson(res, 200, { object: 'list', data: [{ id: 'gpt-image-2', object: 'model' }] })
    }

    const endpoint = req.method === 'POST' ? { '/v1/images/generations': 'generations', '/v1/images/edits': 'edits' }[url.pathname] : null
    if (!endpoint) throw new HttpError(404, 'not found')

    const params = await parseRequest(req, endpoint)
    if (typeof params.prompt !== 'string' || !params.prompt.trim()) throw new HttpError(400, 'prompt 不能为空')

    const started = Date.now()
    const image = await generate(params)
    console.log(`[codex-image] ${endpoint} ok ${Date.now() - started}ms refs=${params.refs.length} bytes=${image.length}`)
    sendJson(res, 200, { created: Math.floor(Date.now() / 1000), data: [{ b64_json: image.toString('base64') }] })
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500
    console.error(`[codex-image] ${status} ${err.message}`)
    sendJson(res, status, { error: { message: err.message } })
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[codex-image] listening on 127.0.0.1:${port} concurrency=${concurrency}`)
})
