/**
 * Poster 构想 harness 工具循环（Issue #128）：本地 OpenAI 兼容桩 + 临时 SQLite。
 * 覆盖：拒收→下一轮修正→接受（#4991 复刻）、资产校验进反馈环（#2991 复刻）、
 * 8 轮拒收判失败、运行中取消不覆盖终态、正文 JSON 纠偏一次、观测逐轮可回看。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(mode) {
  const dir = mkdtempSync(path.join(tmpdir(), 'poster-concept-agent-'))
  const script = `
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { db, schema, getInsertId } from './src/db/index.ts'
import { startPosterConcept } from './src/services/poster-concept.ts'
import { cancelTextTask } from './src/services/text-task.ts'
import { abortBatchTask } from './src/services/text-batch-cancel.ts'
import { listObservedWork, listObservedCalls, listObservedMessages } from './src/services/task-observability.ts'
import { startMockOpenAIChat, toolResults } from './tests/fixtures/mock-openai-chat.mjs'
const MODE = ${JSON.stringify(mode)}
const ts = new Date().toISOString()

// #4991 同款：9:16 项目，c1/c2 主标题每行 4 字却选了 3 字×2 行的窄侧栏套
const badTitle = { role: 'poster_title', fields: { main: '尖叫出发\\n温泉收尾' } }
const goodTitle = { role: 'poster_title', fields: { main: '尖叫出发\\n温泉收尾' } }
const project = { role: 'poster_project', fields: { main: 'Florence', sub: '第1集 · Ski' } }
const details = { role: 'poster_details', fields: { subtitle: '全家滑雪假期', era: '当代冬季', place: '山中酒店', items: ['客厅收拾行李', '公路指认酒店', '温泉姐弟泼水'] } }
const comp = (id, layout, title, prompt) => ({
  id, approach: '构图' + id, rationale: '理由', recommended: id === 'c1',
  assets: [{ kind: 'scene', id: 1, name: '客厅', role_in_poster: '背景', reason: '开场' }],
  image_prompt: prompt, text_description: '竖版分层', copy: { title: '尖叫出发', subtitle: '全家滑雪假期', era: '当代冬季', place: '山中酒店', notes: [] },
  layer_plan: { text_layout: layout, items: [project, title, details] },
})
const badConcept = { theme: '家庭滑雪假期', theme_reason: '剧本围绕旅程', compositions: [
  comp('c1', 'p-vertical-left', badTitle, '@客厅 的清晨'),
  comp('c2', 'p-vertical-right', badTitle, '@客厅 的上午'),
  comp('c3', 'p-vertical-bottom', goodTitle, '@客厅 的清晨'),
] }
const goodConcept = { theme: '家庭滑雪假期', theme_reason: '剧本围绕旅程', compositions: [
  comp('c1', 'p-vertical-top', goodTitle, '@客厅 的清晨'),
  comp('c2', 'p-vertical-bottom', goodTitle, '@客厅 的上午'),
  comp('c3', 'p-vertical-bottom', goodTitle, '@客厅 的清晨'),
] }
// #2991 同款：image_prompt @ 了未选中的资产
const badRefConcept = { ...goodConcept, compositions: goodConcept.compositions.map((c, i) => i === 1 ? { ...c, image_prompt: '@客厅 与 @哥萨克火枪' } : c) }

let mockRelease = null
const mock = await startMockOpenAIChat(async (body) => {
  const results = toolResults(body, 'submitPosterConcept')
  const last = results[results.length - 1]
  if (MODE === 'cancel') {
    if (!results.length) {
      held = new Promise(resolve => { mockRelease = resolve })
      await held
      return { toolCalls: [{ name: 'submitPosterConcept', args: goodConcept }] }
    }
    return { text: '已取消' }
  }
  if (MODE === 'prose') {
    if (!results.length && !(body.messages ?? []).some(m => m.role === 'user' && String(m.content).includes('没有调用 submit_poster_concept'))) {
      return { text: JSON.stringify(goodConcept) }
    }
    return { toolCalls: [{ name: 'submitPosterConcept', args: goodConcept }] }
  }
  if (MODE === 'stubborn') return { toolCalls: [{ name: 'submitPosterConcept', args: badConcept }] }
  if (MODE === 'badref') {
    if (!results.length) return { toolCalls: [{ name: 'submitPosterConcept', args: badRefConcept }] }
    return { toolCalls: [{ name: 'submitPosterConcept', args: goodConcept }] }
  }
  // fix：首轮溢出被拒，第二轮换套通过
  if (!results.length) return { toolCalls: [{ name: 'submitPosterConcept', args: badConcept }] }
  if (last && last.accepted === false) return { toolCalls: [{ name: 'submitPosterConcept', args: goodConcept }] }
  return { text: '构想已完成' }
})


const dramaId = getInsertId(await db.insert(schema.dramas).values({ title: 'Florence', projectType: 'drama', aspectRatio: '9:16', createdAt: ts, updatedAt: ts }))
const episodeId = getInsertId(await db.insert(schema.episodes).values({ dramaId, episodeNumber: 1, title: 'Ski', scriptContent: '清晨客厅收拾行李，姐弟打闹；上午公路指认酒店；夜晚温泉泼水。', createdAt: ts, updatedAt: ts }))
const sceneId = getInsertId(await db.insert(schema.scenes).values({ dramaId, location: '客厅', time: '清晨', prompt: '浅灰地毯与沙发', imageUrl: 'static/poster-agent-test/scene.png', createdAt: ts, updatedAt: ts }))
await db.insert(schema.episodeScenes).values({ episodeId, sceneId, createdAt: ts })
const configId = getInsertId(await db.insert(schema.aiServiceConfigs).values({
  serviceType: 'text', provider: 'openai', name: 'Mock poster model', baseUrl: mock.baseUrl, apiKey: 'not-a-credential',
  model: '["mock-poster"]', isActive: true, vision: false, priority: 100, createdAt: ts, updatedAt: ts,
}))

const started = await startPosterConcept(episodeId, { configId })
assert.equal(started.started, true)
const taskId = started.task_id
const settle = async () => {
  for (const deadline = Date.now() + 30000; Date.now() < deadline;) {
    const row = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId)).get()
    if (['completed', 'failed', 'cancelled'].includes(row.status)) return row
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('poster concept task did not settle')
}
let row
if (MODE === 'cancel') {
  // 等首次请求真正发出（桩挂住），再走与 POST /tasks/:id/cancel 相同的取消路径
  for (const deadline = Date.now() + 10000; Date.now() < deadline;) {
    if (mock.requests.length) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  await cancelTextTask(taskId, '用户取消')
  abortBatchTask(taskId, '用户取消')
  mockRelease?.()
  row = await settle()
} else {
  row = await settle()
}
const params = JSON.parse(row.params)
const poster = db.select().from(schema.episodePosters).where(eq(schema.episodePosters.episodeId, episodeId)).get()
const works = listObservedWork(taskId)
const calls = listObservedCalls(taskId, { limit: 100 })
const messages = calls.flatMap(call => listObservedMessages(call.id, { limit: 200 }))
const toolMessages = messages.filter(m => m.role === 'tool' || m.role === 'tool_call')
await mock.close()
console.log('@@' + JSON.stringify({
  status: row.status, error: row.errorMsg, rounds: params.concept_rounds ?? null,
  concept: poster?.concept ? JSON.parse(poster.concept) : null,
  outputText: params.output_text ?? null,
  works: works.map(w => ({ stage: w.stage, status: w.status, call_count: w.call_count })),
  calls: calls.length,
  toolRoles: [...new Set(toolMessages.map(m => m.role))],
  firstToolResult: toolMessages.find(m => m.role === 'tool')?.body ?? null,
  requests: mock.requests.length,
}))
`
  try {
    const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot,
      encoding: 'utf8',
      timeout: 90_000,
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3'), HUOBAO_DATA_DIR: dir },
    })
    return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('首轮文字层溢出被拒（含容量与换套提示），第二轮修正后接受并落库（#4991 复刻）', () => {
  const r = run('fix')
  assert.equal(r.status, 'completed', r.error)
  assert.deepEqual(r.rounds.map(x => x.outcome), ['rejected', 'accepted'])
  assert.match(r.rounds[0].problems.join('；'), /「海报主标题」的「主标题」放不下/)
  assert.match(r.rounds[0].problems.join('；'), /poster_title\.main「主标题」基准容量：3 字×2 行/)
  assert.match(r.rounds[0].problems.join('；'), /p-vertical-top/)
  assert.equal(r.concept.compositions.length, 3)
  assert.equal(r.concept.compositions[0].layer_plan.text_layout, 'p-vertical-top')
  // 观测：一个 poster_concept 工作项，逐次调用与工具往返全部落盘
  assert.deepEqual(r.works, [{ stage: 'poster_concept', status: 'completed', call_count: r.calls }])
  // 两次模型调用：首轮提交被拒 → 修正提交被接受后立即中止会话（不再多烧一次收尾调用）
  assert.equal(r.calls, 2)
  assert.equal(r.requests, 2)
  assert.deepEqual(r.toolRoles.sort(), ['tool', 'tool_call'])
  const firstResult = JSON.parse(r.firstToolResult)
  assert.equal(firstResult.accepted, false)
  assert.equal(firstResult.rounds_left, 7)
})

test('资产校验违例（@未选资产）进反馈环并可修正（#2991 复刻）', () => {
  const r = run('badref')
  assert.equal(r.status, 'completed', r.error)
  assert.deepEqual(r.rounds.map(x => x.outcome), ['rejected', 'accepted'])
  assert.match(r.rounds[0].problems.join('；'), /未选中的资产「@哥萨克火枪」/)
  assert.equal(r.concept.compositions.length, 3)
})

test('连续 8 轮拒收：rounds_exhausted 判失败，保留最后提交原文与逐轮摘要', () => {
  const r = run('stubborn')
  assert.equal(r.status, 'failed')
  assert.match(r.error, /8 轮提交均未通过校验/)
  assert.match(r.error, /第1轮拒收/)
  assert.match(r.error, /第8轮拒收/)
  assert.equal(r.rounds.length, 8)
  assert.ok(r.rounds.every(x => x.outcome === 'rejected'))
  assert.ok(r.outputText && JSON.parse(r.outputText).compositions.length === 3, '保留最后一次提交原文')
  assert.equal(r.concept, null, '失败不写 concept')
})

test('运行中取消：任务 cancelled，收尾不覆盖终态', () => {
  const r = run('cancel')
  assert.equal(r.status, 'cancelled')
  assert.equal(r.error, '用户取消')
  assert.equal(r.concept, null)
})

test('模型只回正文 JSON：纠偏一次后用工具提交并完成', () => {
  const r = run('prose')
  assert.equal(r.status, 'completed', r.error)
  assert.deepEqual(r.rounds.map(x => x.outcome), ['accepted'])
  assert.equal(r.concept.compositions.length, 3)
})
