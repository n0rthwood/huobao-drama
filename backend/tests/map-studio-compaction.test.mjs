/**
 * 地图工作室工具循环的上下文压缩（Issue #99 用户批准：「压缩上下文来提高作图速度」）。
 *
 * 生产证据（drama 21 / 地图工作室 run 7–10 的作图阶段）：单次请求输入从 21k 涨到 339k 字，
 * 因为每一步都把全部历史工具结果原样重发；输出很小，耗时主要是重读输入。
 *
 * 这里用本地脚本化的 OpenAI 兼容模型跑真实的 runDrawingStage / runResearchStage（走 runStageAgent），断言：
 * (a) 第 20 步的请求体积与第 5 步同量级（并给出未压缩口径的对照数字）；
 * (b) 最近 3 步的工具结果原文在，更早的结果被占位替换；
 * (c) 状态消息包含当前草稿与最近一次检查（submit_check）问题；
 * (d) 早先的拒收原因仍在状态消息里；
 * (e) 观测表记录的是压缩后实际发出的请求（完整原始结果只留在当初那次调用里）。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const backend = fileURLToPath(new URL('../', import.meta.url))

function probe(script) {
  const dir = mkdtempSync(path.join(tmpdir(), 'map-studio-compaction-'))
  const file = path.join(dir, 'probe.mts')
  writeFileSync(file, script.replaceAll('__BACKEND__', backend))
  const env = { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3'), HUOBAO_DATA_DIR: dir }
  delete env.STORAGE_PATH
  try {
    return execFileSync('node_modules/.bin/tsx', [file], { cwd: backend, env, encoding: 'utf8', timeout: 240000 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const HELPERS = `
  const PLACEHOLDER = '[已压缩：'
  const messageText = message => {
    const content = message.content
    if (typeof content === 'string') return content
    if (!content || typeof content !== 'object') return ''
    if (typeof content.content === 'string') return content.content
    if (Array.isArray(content.parts)) return content.parts.map(part => part && typeof part === 'object' && typeof part.text === 'string' ? part.text : '').join('')
    return JSON.stringify(content)
  }
  const toolTexts = messages => messages.filter(message => message.role === 'tool').map(messageText)
  const compactedOf = messages => toolTexts(messages).filter(text => text.startsWith(PLACEHOLDER))
  const stateOf = messages => {
    const message = messages.filter(message => message.role === 'user' && messageText(message).startsWith('当前状态')).at(-1)
    return message ? messageText(message) : ''
  }
  const sizeOf = messages => JSON.stringify(messages).length
  /** 占位里记着原结果的字数：按它还原本步请求在未压缩时的体积 */
  const expandedSizeOf = messages => messages.reduce((sum, message) => {
    const text = typeof message.content === 'string' ? message.content : message.content == null ? '' : JSON.stringify(message.content)
    if (message.role === 'tool' && text.startsWith(PLACEHOLDER)) {
      const from = text.indexOf('（')
      const to = text.indexOf(' 字）', from)
      const recorded = from >= 0 && to > from ? Number(text.slice(from + 1, to)) : NaN
      return sum + (Number.isFinite(recorded) ? recorded : text.length)
    }
    return sum + text.length + (message.tool_calls ? JSON.stringify(message.tool_calls).length : 0)
  }, 0)
  const report = async (label, model) => {
    // 只统计阶段循环里的模型调用（read_image 的视觉请求也打到同一个假服务器）
    const agentCalls = model.requests.filter(request => messageText(request.messages[0] ?? {}).includes('地图工作室'))
    const sizes = agentCalls.map(request => sizeOf(request.messages))
    const expanded = agentCalls.map(request => expandedSizeOf(request.messages))
    console.log('@@' + JSON.stringify({ label, calls: sizes.length, sizes, expanded }))
  }
`

const DRAWING = `
  import assert from 'node:assert/strict'
  import fs from 'node:fs'
  import { createRequire } from 'node:module'
  import { db, schema, getInsertId } from '__BACKEND__src/db/index.ts'
  import { initMapStudio } from '__BACKEND__src/modules/map-studio/index.ts'
  import { createStandaloneTask } from '__BACKEND__src/modules/map-studio/tasks.ts'
  import { insertRun } from '__BACKEND__src/modules/map-studio/db.ts'
  import { mutateTask } from '__BACKEND__src/modules/map-studio/store.ts'
  import { resolveStageModel } from '__BACKEND__src/services/ai-stages.ts'
  import { emptyBrief } from '__BACKEND__src/modules/map-studio/types.ts'
  import { normalizeMapSpec } from '__BACKEND__src/modules/map-studio/geo/base-render.ts'
  import { runDrawingStage } from '__BACKEND__src/modules/map-studio/drawing.ts'
  import { runObservedWork, listObservedCalls, listObservedMessages } from '__BACKEND__src/services/task-observability.ts'
  import { startMockOpenAIChat, toolResults } from '__BACKEND__tests/fixtures/mock-openai-chat.mjs'
  const require = createRequire('file://__BACKEND__package.json')
  const sharp = require('sharp')
  ${HELPERS}

  await initMapStudio({ async submitImage() { throw Error('no generation') }, async pollImage() { throw Error('no generation') } })
  fs.mkdirSync(process.env.HUOBAO_DATA_DIR + '/static', { recursive: true })
  await sharp({ create: { width: 1000, height: 600, channels: 3, background: '#e2d5ba' } }).png().toFile(process.env.HUOBAO_DATA_DIR + '/static/base.png')

  // 8 个地名 + 1 条河流：草稿摘要有 9 个图层，每次 update_layer 的返回都有一定体积，
  // 未压缩时历史会随步数线性变重（生产 run 9 的真实形态）。
  const names = ['甲乙丙丁戊己庚辛']
  const places = Array.from({ length: 8 }, (_, i) => ({
    id: 'p' + (i + 1), name: names[0][i], lon: 11 + i * 0.9, lat: 15, origin: 'dataset',
    verification: { status: 'verified', reasons: ['dataset fixture'] },
  }))
  const spec = normalizeMapSpec({
    bbox: [10, 10, 20, 20],
    places,
    routes: [{ id: 'river', name: '长河', points: [[11.2, 16.5], [13.5, 15.2], [16.2, 17.4], [18.6, 15.8]], origin: 'dataset', verification: { status: 'verified', reasons: ['dataset fixture'] } }],
  })
  const registration = { mode: 'program', width: 1000, height: 600, bbox: spec.bbox, program: { projection: 'mercator', bbox: spec.bbox } }
  const titleLayer = text => ({ id: 'title', type: 'label', name: 'title', visible: true, locked: false, z: 20, opacity: 1, rotation: 0, box: { x: 0.04, y: 0.04, w: 0.4, h: 0.1 }, text, style: { size: 0.05 } })

  const model = await startMockOpenAIChat(async body => {
    // read_image 走视觉模型：同样打到这个假服务器
    if (JSON.stringify(body.messages ?? []).includes('image_url')) {
      return { text: '图上能看到 8 个地名、长河折线与标题，标签互不重叠。细节点：' + '两岸地形以平原为主，河道弯曲自然。'.repeat(40) + '结尾标记：河湾左岸有沙洲。' }
    }
    const adds = toolResults(body, 'add_feature_layers').length
    const titles = toolResults(body, 'add_layer').length
    const updates = toolResults(body, 'update_layer').length
    const removes = toolResults(body, 'remove_layer').length
    const renders = toolResults(body, 'render_draft').length
    const images = toolResults(body, 'read_image').length
    const submits = toolResults(body, 'submit_draft').length
    if (adds === 0) return { toolCalls: [{ name: 'add_feature_layers', args: { items: [...places.map(place => ({ feature_id: place.id })), { feature_id: 'river' }] } }] }
    if (titles === 0) return { toolCalls: [{ name: 'add_layer', args: { layer: titleLayer('长河流域示意') } }] }
    if (updates < 12) return { toolCalls: [{ name: 'update_layer', args: { layer_id: 'title', patch: { text: '长河流域示意 ' + (updates + 1) } } }] }
    if (renders === 0) return { toolCalls: [{ name: 'render_draft', args: {} }] }
    if (removes === 0) return { toolCalls: [{ name: 'remove_layer', args: { layer_id: 'feature-river' } }] }
    if (renders === 1) return { toolCalls: [{ name: 'render_draft', args: {} }] }
    if (images === 0) {
      const previews = toolResults(body, 'render_draft').filter(item => item && typeof item === 'object' && item.path)
      return { toolCalls: [{ name: 'read_image', args: { path: previews.at(-1).path, question: '图上地名与标题是否重叠？' } }] }
    }
    if (submits === 0) return { toolCalls: [{ name: 'submit_draft', args: {} }] }
    if (adds === 1) return { toolCalls: [{ name: 'add_feature_layers', args: { items: [{ feature_id: 'river' }] } }] }
    if (renders === 2) return { toolCalls: [{ name: 'render_draft', args: {} }] }
    if (submits === 1) return { toolCalls: [{ name: 'submit_draft', args: {} }] }
    return { text: '无事可做' }
  })

  const stamp = new Date().toISOString()
  const configId = getInsertId(await db.insert(schema.aiServiceConfigs).values({
    serviceType: 'text', provider: 'openai', name: 'Compaction drawing mock', baseUrl: model.baseUrl, apiKey: 'not-a-credential',
    model: '["mock-agent"]', isActive: true, vision: true, createdAt: stamp, updatedAt: stamp,
  }))
  const task = await createStandaloneTask({ title: 'compaction drawing QA' })
  const runId = insertRun({ taskId: task.task_id, mode: 'manual', startStage: 'drawing', stage: 'drawing', textConfigId: configId, imageConfigId: null, imageModel: null, params: {} })
  await mutateTask(task.task_id, { action: 'fixture_run', actor: 'system', mutate: ctx => { ctx.state.run_id = runId; ctx.state.status = 'running'; ctx.state.stage = 'drawing'; ctx.mapSpec = spec } })
  const stageModel = await resolveStageModel('read_image', { configId })
  const outcome = await runObservedWork(
    { taskId: task.task_id, scope: 'map_studio', stage: 'map_studio', sourceChars: 200, sampleKey: 'map_studio|cfg:' + configId },
    async () => runDrawingStage({ taskId: task.task_id, runId, stageModel, brief: { ...emptyBrief(), subject: '长河流域示意' }, spec, background: { path: 'static/base.png', width: 1000, height: 600, registration, warnings: [] }, startRounds: 0, feedback: null }),
  )
  assert.equal(outcome.kind, 'accepted', JSON.stringify(outcome))
  await model.close()
  await report('DRAWING', model)

  // read_image 会向同一个假服务器发一次视觉请求：只统计阶段循环里的模型调用
  const agentCalls = model.requests.filter(request => messageText(request.messages[0] ?? {}).includes('地图工作室'))
  const sizes = agentCalls.map(request => sizeOf(request.messages))
  const expanded = agentCalls.map(request => expandedSizeOf(request.messages))
  assert.ok(sizes.length >= 20, '脚本要跑满 20 步以上，实际 ' + sizes.length)

  // (a) 体积不随步数增长：第 20 步与第 5 步同量级
  assert.ok(sizes[20] < 60000, '作图阶段单次输入要远小于生产 run 9 的 339k，实际 ' + sizes[20])
  assert.ok(sizes[20] <= sizes[5] * 1.5, '第 20 步与第 5 步同量级：' + sizes[5] + ' → ' + sizes[20])
  assert.ok(expanded[20] > sizes[20] * 2, '压缩确实去掉了历史重量：压缩后 ' + sizes[20] + '，同脚本未压缩口径 ' + expanded[20])

  // (b) 最近 3 步的工具结果原文在，更早的是占位
  const lastMessages = agentCalls.at(-1).messages
  const lastToolTexts = toolTexts(lastMessages)
  assert.ok(lastToolTexts.slice(-3).every(text => !text.startsWith(PLACEHOLDER)), '最近 3 步的工具结果原文必须保留')
  assert.ok(compactedOf(lastMessages).length >= 8, '更早的结果换成占位，实际 ' + compactedOf(lastMessages).length)
  assert.match(toolTexts(model.requests[2].messages).join('\\n'), /feature-p1/, '早先那一步里 add_feature_layers 的结果还是原文')
  const addSummaries = lastToolTexts.filter(text => text.includes('feature-p1'))
  assert.equal(addSummaries.length, 1, '只有最近一次草稿摘要还是原文，更早的已被压缩')
  assert.ok(!addSummaries[0].startsWith(PLACEHOLDER))
  assert.ok(lastToolTexts.some(text => text.startsWith(PLACEHOLDER + 'add_feature_layers')), '同一位置由带工具名的占位说明')
  assert.ok(lastToolTexts.some(text => text.startsWith(PLACEHOLDER + 'read_image') && text.includes('看图结论：')), 'read_image 的结论保留在占位里')
  const readImageStub = lastToolTexts.filter(text => text.startsWith(PLACEHOLDER + 'read_image'))
  assert.ok(readImageStub.every(text => text.length < 700), '读图结论截到 600 字以内，实际 ' + readImageStub.map(text => text.length).join('/'))
  assert.ok(!readImageStub.some(text => text.includes('结尾标记')), '读图文本的尾部被截掉')

  // (c) 状态消息：当前草稿与最近一次 submit_check 问题
  const requestAfterBadPreview = agentCalls.find(request => {
    const state = stateOf(request.messages)
    return state && state.includes('最近一次检查问题：要素「长河」')
  })
  assert.ok(requestAfterBadPreview, '删掉要素后 render_draft 的 submit_check 问题要出现在状态消息里')
  const stateWithDraft = stateOf(agentCalls.at(-1).messages)
  assert.match(stateWithDraft, /当前草稿（不含顶点）：/, '状态消息要给出草稿摘要')
  assert.match(stateWithDraft, /"id":"feature-p1"/, '草稿摘要列出图层 id')
  assert.match(stateWithDraft, /"anchor":"p1"|"p1"/, '草稿摘要带锚定要素')
  assert.match(stateWithDraft, /最近一次检查问题：/, '状态消息带最近一次检查')
  for (const request of agentCalls) {
    const states = request.messages.filter(message => message.role === 'user' && messageText(message).startsWith('当前状态'))
    assert.equal(states.length, 1, '每一步只注入一条当前状态消息')
  }
  assert.equal(agentCalls.at(-1).messages.at(-1).role, 'user', '状态消息在最后一个 user/tool 消息之后')

  // (d) 早先的拒收原因在后续步骤仍可见
  assert.match(stateWithDraft, /最近一次交付被拒收的原因/, '状态消息带最近一次拒收原因')
  assert.match(stateWithDraft, /没有锚定的几何图层/, '拒收原因原文（缺少要素）仍在')

  // (e) 观测表记录的是压缩后实际发出的请求
  const calls = listObservedCalls(task.task_id, { scope: 'map_studio', limit: 200 })
  assert.ok(calls.length >= 20, '每次模型调用都要有观测记录，实际 ' + calls.length)
  const stored = listObservedMessages(calls.at(-1).id, { scope: 'map_studio', limit: 200 }).filter(message => message.phase === 'request')
  assert.ok(stored.some(message => message.role === 'tool' && message.body.startsWith(PLACEHOLDER)), '观测表里是压缩后的占位，不是原始工具结果')
  assert.ok(stored.some(message => message.role === 'user' && message.body.startsWith('当前状态')), '状态消息也进了观测的请求记录')
  assert.ok(!stored.some(message => message.body.includes('结尾标记')), '被截掉的读图长描述不在观测的请求里')
  assert.ok(stored.filter(message => message.body.startsWith('{"draft"')).length <= 1, '观测里只有最近一次草稿摘要还是原文')
  const observedChars = listObservedCalls(task.task_id, { scope: 'map_studio', limit: 200 }).at(-1).request_chars
  assert.ok(observedChars < sizes.at(-1) * 1.5, '观测记录的请求字数与实际发出的请求一致：' + observedChars + ' vs ' + sizes.at(-1))
  assert.match(agentCalls.at(-1).model ?? '', /mock-agent/)

  console.log('COMPACTION_DRAWING_OK')
`

const RESEARCH = `
  import assert from 'node:assert/strict'
  import { initMapStudio } from '__BACKEND__src/modules/map-studio/index.ts'
  import { createStandaloneTask } from '__BACKEND__src/modules/map-studio/tasks.ts'
  import { insertRun } from '__BACKEND__src/modules/map-studio/db.ts'
  import { mutateTask } from '__BACKEND__src/modules/map-studio/store.ts'
  import { resolveStageModel } from '__BACKEND__src/services/ai-stages.ts'
  import { emptyBrief } from '__BACKEND__src/modules/map-studio/types.ts'
  import { runResearchStage, mapResearchIO } from '__BACKEND__src/modules/map-studio/research.ts'
  import { db, schema, getInsertId } from '__BACKEND__src/db/index.ts'
  import { startMockOpenAIChat, toolResults } from '__BACKEND__tests/fixtures/mock-openai-chat.mjs'
  ${HELPERS}

  await initMapStudio({ async submitImage() { throw Error('no generation') }, async pollImage() { throw Error('no generation') } })
  const adapters = ['wikipedia-zh', 'wikipedia-en', 'europeana', 'smithsonian']
  const body6000 = '邗沟是春秋末期吴王夫差开凿的运河，自今扬州引长江水北上，经射阳湖至今淮安入淮河。'.repeat(150)
  mapResearchIO.search = async (adapter, query) => [{
    adapter, title: (adapter === 'wikipedia-zh' ? '邗沟' : 'Han Canal'), url: 'https://example.org/' + adapter + '/' + encodeURIComponent(query),
    image: null, license: 'CC BY-SA', institution: adapter, date: '', tier: 'B', snippet: body6000.slice(0, 300),
  }]
  mapResearchIO.fetchText = async () => body6000

  const model = await startMockOpenAIChat(async body => {
    const searches = toolResults(body, 'search_sources').length
    if (searches < adapters.length) return { toolCalls: [{ name: 'search_sources', args: { adapter: adapters[searches], query: '邗沟' } }] }
    const reads = toolResults(body, 'read_source').length
    if (reads < 3) return { toolCalls: [{ name: 'read_source', args: { source_id: 'S' + (reads + 1) } }] }
    const datasets = toolResults(body, 'search_dataset').length
    if (datasets < 3) return { toolCalls: [{ name: 'search_dataset', args: { layer: 'lake', query: ['古射阳湖', '古淮河', '射水'][datasets] } }] }
    const submits = toolResults(body, 'submit_features').length
    const extent = [118.5, 31.9, 120.2, 33.9]
    // 第一次交付：自然要素没走 dataset（必然拒收），拒收原因要在后续步骤一直可见
    if (submits === 0) return { toolCalls: [{ name: 'submit_features', args: {
      extent,
      features: [{ kind: 'route', name: '邗沟', category: 'river', geometry_source: 'model', points: [[119.4, 32.3], [119.3, 32.8]], coordinate_basis: 'approximate_schematic', basis: '按资料所述走向示意', source_ids: ['S1'], uncertainty: 'high' }],
    } }] }
    if (submits === 1) return { toolCalls: [{ name: 'submit_features', args: {
      extent,
      features: [{ kind: 'place', name: '扬州', category: 'settlement', geometry_source: 'source', lon: 119.42, lat: 32.39, coordinate_basis: 'well_known', basis: '现代地名公认位置', source_ids: ['S1'], uncertainty: 'medium' }],
    } }] }
    return { text: '无事可做' }
  })

  const stamp = new Date().toISOString()
  const configId = getInsertId(await db.insert(schema.aiServiceConfigs).values({
    serviceType: 'text', provider: 'openai', name: 'Compaction research mock', baseUrl: model.baseUrl, apiKey: 'not-a-credential',
    model: '["mock-agent"]', isActive: true, vision: true, createdAt: stamp, updatedAt: stamp,
  }))
  const task = await createStandaloneTask({ title: 'compaction research QA' })
  const runId = insertRun({ taskId: task.task_id, mode: 'manual', startStage: 'research', stage: 'research', textConfigId: configId, imageConfigId: null, imageModel: null, params: {} })
  await mutateTask(task.task_id, { action: 'fixture_run', actor: 'system', mutate: ctx => { ctx.state.run_id = runId; ctx.state.status = 'running'; ctx.state.stage = 'research' } })
  const stageModel = await resolveStageModel('read_image', { configId })
  const outcome = await runResearchStage({ taskId: task.task_id, runId, stageModel, brief: { ...emptyBrief(), subject: '邗沟', era: '春秋末期' }, spec: null, startRounds: 0, feedback: null })
  assert.equal(outcome.kind, 'accepted', JSON.stringify(outcome))
  await model.close()
  await report('RESEARCH', model)

  const sizes = model.requests.map(request => sizeOf(request.messages))
  const expanded = model.requests.map(request => expandedSizeOf(request.messages))
  const lastMessages = model.requests.at(-1).messages
  const lastToolTexts = toolTexts(lastMessages)
  // (a) 两次 6000 字正文读入后体积回落：压缩前历史会一直带着它们
  assert.ok(sizes.at(-1) < expanded.at(-1) / 2, '两次 6000 字正文读入被压缩：最后 ' + sizes.at(-1) + '，同脚本未压缩口径 ' + expanded.at(-1))
  // (b) 早先 read_source 的正文换成一句状态，最近 3 步原文保留
  assert.ok(lastToolTexts.some(text => text.startsWith(PLACEHOLDER + 'read_source') && text.includes('正文 6000 字')), '早先的正文换成占位并给出状态句')
  assert.ok(!lastToolTexts.some(text => text.includes('经射阳湖至今淮安入淮河')), '6000 字正文不再重发')
  assert.ok(lastToolTexts.slice(-3).every(text => !text.startsWith(PLACEHOLDER)), '最近 3 步的工具结果原文保留')
  // (c) 状态消息：已登记来源 + dataset 查询历史
  const state = stateOf(lastMessages)
  assert.match(state, /已登记来源（只列编号与标题，正文需要时再 read_source）：S1「邗沟」/, '状态消息给出已登记来源')
  assert.match(state, /dataset 查询历史：lake「古射阳湖」0 命中/, '状态消息给出 dataset 查询历史')
  // (d) 第一次交付的拒收原因仍在
  assert.match(state, /最近一次交付被拒收的原因/, '状态消息带拒收原因')
  assert.match(state, /自然要素必须取自 dataset/, '拒收原因原文仍在')
  assert.equal(lastMessages.at(-1).role, 'user', '状态消息在最后一个 user/tool 消息之后')
  assert.equal(lastMessages.filter(message => message.role === 'user' && String(message.content).startsWith('当前状态')).length, 1, '只注入一条当前状态消息')

  console.log('COMPACTION_RESEARCH_OK')
`

test('drawing：20+ 步请求体积不随步数增长，最近 3 步结果原文、更早占位，状态消息给草稿与最近检查，拒收原因一直可见，观测表存压缩后的请求', () => {
  const output = probe(DRAWING)
  assert.match(output, /COMPACTION_DRAWING_OK/)
  const numbers = JSON.parse(output.split('\n').find(line => line.startsWith('@@')).slice(2))
  assert.equal(numbers.sizes.length, numbers.expanded.length)
  assert.ok(numbers.calls >= 20)
  console.log('drawing request chars per call: ' + JSON.stringify(numbers.sizes))
  console.log('drawing uncompacted equivalent: ' + JSON.stringify(numbers.expanded))
})

test('research：早先 6000 字正文换成占位后，状态消息给出已登记来源、dataset 查询历史与拒收原因', () => {
  const output = probe(RESEARCH)
  assert.match(output, /COMPACTION_RESEARCH_OK/)
  const numbers = JSON.parse(output.split('\n').find(line => line.startsWith('@@')).slice(2))
  assert.ok(numbers.sizes.at(-1) < numbers.expanded.at(-1))
  console.log('research request chars per call: ' + JSON.stringify(numbers.sizes))
  console.log('research uncompacted equivalent: ' + JSON.stringify(numbers.expanded))
})
