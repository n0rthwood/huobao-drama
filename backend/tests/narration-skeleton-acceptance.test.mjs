/**
 * 旁白骨架生成的验收口径回归（Issue #70 DEFECT-2）。
 *
 * 实测缺陷：模型把同一句话同时分给两镜（重叠，而不是漏切）时，覆盖缺口为 0，
 * 旧的 gap-only 验收于是把任务判成 completed，界面却怎么也确认不了骨架。
 * 现在拆镜任务用与「能否确认骨架」完全相同的严格分配校验，重叠/顺序颠倒一律判失败，
 * 并保留已拆出来的分镜供人工修边界。
 *
 * 真跑整条异步链路：本地回环的 OpenAI 兼容流式桩服务驱动 Agent 调用 save_storyboards，
 * 断言落库的 sys_task 状态与保留下来的分镜行，不匹配源码文本。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(script) {
  const dir = mkdtempSync(path.join(tmpdir(), 'huobao-skeleton-accept-'))
  try {
    const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot,
      encoding: 'utf8',
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3'), HUOBAO_DATA_DIR: dir },
    })
    return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const A = '一七二〇年，三方都在草原上押下重注。'
const B = '额尔齐斯河是唯一一条水道。'
const C = '这一年冬天，三千人溯流而上。'

const SETUP = (shots) => `
import http from 'node:http'
import { eq } from 'drizzle-orm'
import { db, schema, initDb } from './src/db/index.ts'

const A = ${JSON.stringify(A)}
const B = ${JSON.stringify(B)}
const C = ${JSON.stringify(C)}
const SCRIPT = [A, B, C].join('\\n\\n')
const SHOTS = ${JSON.stringify(shots)}

// OpenAI 兼容的流式桩：第一轮回一次 save_storyboards 工具调用，第二轮回一句收尾文本
let calls = 0
const sse = (res, chunks) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  for (const chunk of chunks) res.write('data: ' + JSON.stringify(chunk) + '\\n\\n')
  res.write('data: [DONE]\\n\\n')
  res.end()
}
const frame = (delta, finish = null) => ({
  id: 'stub', object: 'chat.completion.chunk', created: 0, model: 'stub-model',
  choices: [{ index: 0, delta, finish_reason: finish }],
})
const upstream = http.createServer((req, res) => {
  let body = ''
  req.on('data', part => { body += part })
  req.on('end', () => {
    calls += 1
    if (calls === 1) {
      const args = JSON.stringify({
        replace_existing: true,
        storyboards: SHOTS.map((text, index) => ({ shot_number: index + 1, title: 'S' + (index + 1), narration_text: text })),
      })
      return sse(res, [
        frame({ role: 'assistant', content: '' }),
        frame({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'save_storyboards', arguments: args } }] }),
        frame({}, 'tool_calls'),
      ])
    }
    return sse(res, [frame({ role: 'assistant', content: '已完成拆分。' }), frame({}, 'stop')])
  })
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
upstream.unref()
const upstreamBase = 'http://127.0.0.1:' + upstream.address().port + '/v1'

initDb()
const ts = new Date().toISOString()
await db.insert(schema.aiServiceConfigs).values({
  id: 1, name: 'stub text', serviceType: 'text', provider: 'openai',
  baseUrl: upstreamBase, apiKey: 'k', model: JSON.stringify(['stub-model']),
  isActive: true, vision: true, priority: 100, createdAt: ts, updatedAt: ts,
})
await db.insert(schema.dramas).values({ id: 1, title: 'doc', projectType: 'documentary', documentaryRules: 'on', createdAt: ts, updatedAt: ts })
await db.insert(schema.episodes).values({
  id: 1, dramaId: 1, episodeNumber: 1, title: 'e',
  scriptContent: SCRIPT, narrationEnabled: true,
  scriptConfirmedAt: ts, assetReviewStatus: 'passed',
  createdAt: ts, updatedAt: ts,
})

const { startSkeletonGeneration, narrationSkeletonState } = await import('./src/services/narration-skeleton.ts')
const started = await startSkeletonGeneration(1)
const deadline = Date.now() + 60_000
let task = null
while (Date.now() < deadline) {
  const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, started.task_id))
  if (row && (row.status === 'completed' || row.status === 'failed')) { task = row; break }
  await new Promise(resolve => setTimeout(resolve, 100))
}
const rows = (await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, 1))).filter(r => !r.deletedAt)
const state = await narrationSkeletonState(1)
const emit = (extra) => console.log('@@' + JSON.stringify({
  started: started.started,
  status: task && task.status,
  error: task && task.errorMsg,
  shots: rows.length,
  texts: rows.sort((a, b) => a.storyboardNumber - b.storyboardNumber).map(r => r.narrationText),
  confirmed: state.confirmed,
  confirmable: state.confirmable,
  uncovered: state.coverage.uncovered_chars,
  ...extra,
}))
`

test('a skeleton run whose shots overlap is marked failed even though no script is left uncovered', () => {
  // 第三镜把第二镜已经领走的句子又领了一遍：没有缺口，但分配重叠
  const result = run(`${SETUP([A, B + C, C])}
    emit({})
  `)
  assert.equal(result.started, true)
  // 缺口为 0，旧口径会判成功；严格分配判失败
  assert.equal(result.uncovered, 0)
  assert.equal(result.status, 'failed')
  assert.match(result.error, /旁白骨架不合法/)
  // 拆出来的分镜全部保留，人可以直接去改边界
  assert.equal(result.shots, 3)
  assert.deepEqual(result.texts, [A, B + C, C])
  assert.equal(result.confirmed, false)
  assert.equal(result.confirmable, false)
})

test('a verbatim, ordered, gapless skeleton run completes and becomes confirmable', () => {
  const result = run(`${SETUP([A, B, C])}
    emit({})
  `)
  assert.equal(result.status, 'completed')
  assert.equal(result.shots, 3)
  assert.deepEqual(result.texts, [A, B, C])
  assert.equal(result.uncovered, 0)
  assert.equal(result.confirmable, true)
  assert.equal(result.confirmed, false)
})
