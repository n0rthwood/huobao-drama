/**
 * 地图工作流的模型阶段（Issue #90）：真实服务/数据库/渲染链 + 本地脚本化的 OpenAI 兼容模型。
 *
 * 覆盖验收：拒收 → 模型自我修正（检索、底图）、工具内部异常回给模型、回退全链路
 * （不扣发起方轮次、目标阶段轮次重置、下游版本作废、第 3 次回退被拒）、轮次耗尽交人且
 * 失败原因交给下一次运行、成图 = 交付文档的确定性渲染、人工编辑走同一渲染链、重启后记录不归零。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backend = fileURLToPath(new URL('..', import.meta.url))

function runProbe(body) {
  const dir = mkdtempSync(path.join(tmpdir(), 'map-agent-'))
  const probe = path.join(dir, 'probe.mts')
  writeFileSync(probe, `
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import { createRequire } from 'node:module'
    import { db, schema, getInsertId } from 'file://${backend}src/db/index.ts'
    import { now } from 'file://${backend}src/utils/response.ts'
    import { loadTask as loadWorkflow, serializeDetail, mutateTask as mutateWorkflow } from 'file://${backend}src/modules/map-studio/store.ts'
    import { startMapWorkflow, advanceMapWorkflow, saveMapWorkflowDraft, saveMapLayerDoc, MapLayerDocInvalidError } from 'file://${backend}src/modules/map-studio/run.ts'
    import { mapResearchIO } from 'file://${backend}src/modules/map-studio/research.ts'
    import { renderMapLayerDoc } from 'file://${backend}src/modules/map-studio/drawing.ts'
    import { startMockOpenAIChat, toolResults, systemText, userText } from 'file://${backend}tests/fixtures/mock-openai-chat.mjs'
    const require = createRequire('file://${backend}package.json')
    const sharp = require('sharp')
    const { eq } = require('drizzle-orm')

    import { initMapStudio, registerMapStudioHost, openHostTask } from 'file://${backend}src/modules/map-studio/index.ts'
    import { huobaoMapStudioHost } from 'file://${backend}src/services/map-studio-host.ts'
    import { insertRun, readRunParams, patchRunParams, selectRun } from 'file://${backend}src/modules/map-studio/db.ts'
    const platform = {
      async submitImage() { throw Error('Unexpected billed texture submission in test') },
      async pollImage(ref) {
        const row = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, Number(ref))).get()
        return row ? { status: row.status === 'completed' ? 'completed' : 'pending', path: row.localPath, error: row.errorMsg } : { status: 'missing', path: null, error: 'missing' }
      },
    }
    registerMapStudioHost(huobaoMapStudioHost)
    await initMapStudio(platform)
    const createMap = async (dramaId, name, description = '') => {
      const id = getInsertId(await db.insert(schema.props).values({ dramaId, name, description, assetType: 'map', createdAt: now(), updatedAt: now() }))
      return (await openHostTask({ host: 'huobao', ref: 'prop:' + id })).task_id
    }
    const getProp = async taskId => {
      const loaded = await loadWorkflow(taskId)
      return db.select().from(schema.props).where(eq(schema.props.id, Number(loaded.row.host_ref.split(':')[1]))).get()
    }
    const failInterruptedMapWorkflows = async () => initMapStudio(platform)

    const ts = now()
    const settle = async (id, ms = 90000) => {
      const deadline = Date.now() + ms
      for (;;) {
        const row = await loadWorkflow(id)
        if (row.state.status !== 'running') return serializeDetail(row)
        if (Date.now() > deadline) throw Error('map workflow did not settle: ' + row.state.stage)
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    const attemptsOf = (detail, stage) => detail.agent.attempts.filter(a => a.stage === stage).map(a => [a.outcome, a.round])
    ${body}
  `)
  try {
    return execFileSync('node_modules/.bin/tsx', [probe], {
      cwd: backend, encoding: 'utf8', timeout: 240000,
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3'), HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') },
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const SCRIPT = `
  const adapters = ['wikipedia-zh', 'wikipedia-en', 'europeana', 'smithsonian']
  mapResearchIO.search = async (adapter, query) => [{
    adapter, title: adapter === 'wikipedia-zh' ? '邗沟' : 'Han Canal ' + adapter, url: 'https://example.org/' + adapter + '/' + encodeURIComponent(query),
    image: null, license: 'CC BY-SA', institution: adapter, date: '', tier: 'B',
    snippet: '邗沟是春秋末期吴王夫差开凿的运河，自今扬州引长江水北上，经射阳湖至今淮安入淮河。',
  }]
  mapResearchIO.fetchText = async (hit) => hit.snippet
  const place = (name, lon, lat, extra = {}) => ({ kind: 'place', name, lon, lat, coordinate_basis: 'well_known', source_ids: ['S1'], basis: '现代地名公认位置', uncertainty: 'medium', ...extra })
  const places = [place('扬州', 119.42, 32.39, { coordinate_basis: 'excerpt', supporting_excerpt: '自今扬州引长江水北上' }), place('高邮', 119.46, 32.78), place('宝应', 119.31, 33.24), place('淮安', 119.15, 33.5)]
  const route = { kind: 'route', name: '邗沟', points: [[119.42, 32.3], [119.35, 32.85], [119.55, 33.3], [119.15, 33.52]], coordinate_basis: 'approximate_schematic', source_ids: ['S1'], basis: '按资料所述走向示意', uncertainty: 'high' }
  const incidentRegion = { kind: 'region', name: '古射阳湖（示意范围）', lon: 0, lat: 0, points: [[119.55, 33.3], [119.45, 33.45], [119.7, 33.35], [119.55, 33.1]], coordinate_basis: 'approximate_schematic', source_ids: ['S1'], basis: '据文字概括', uncertainty: 'high' }
  const sheyang = place('射阳湖（示意）', 119.56, 33.3, { coordinate_basis: 'approximate_schematic', uncertainty: 'high', basis: '取资料所述湖区中部' })
  const WIDE = [100, 20, 130, 45]
  const TIGHT = [118.7, 32.0, 120.0, 33.8]
  let baseRuns = 0
  let drawingVisits = 0
  const buildDoc = (user, title) => {
    const skeleton = JSON.parse(user.match(/起始文档骨架：\\n(\\{.*\\})/)[1])
    const layer = (id, z, extra) => ({ id, name: id, visible: true, locked: false, z, opacity: 1, rotation: 0, ...extra })
    const layers = []
    for (const m of user.matchAll(/- id=(\\S+) (place|route|region)「(.+?)」→ 归一化坐标 (\\[.*\\])/g)) {
      const coords = JSON.parse(m[4])
      const anchor = { semantic_id: m[1], semantic_name: m[3] }
      if (m[2] === 'route') layers.push(layer('l-' + m[1], layers.length, { type: 'polyline', anchor, points: coords, style: { stroke: '#8f2f1c', width: 0.008 } }))
      else layers.push(layer('l-' + m[1], layers.length, { type: 'marker', anchor, at: coords[0], text: m[3], style: { dot_radius: 0.01 } }))
    }
    layers.push(layer('title', layers.length, { type: 'label', box: { x: 0.04, y: 0.04, w: 0.4, h: 0.1 }, text: title, style: { size: 0.05 } }))
    return { ...skeleton, layers }
  }
  const mock = await startMockOpenAIChat(async (body) => {
    const sys = systemText(body)
    const user = userText(body)
    const fresh = !(body.messages ?? []).some(m => m.role === 'assistant')
    if (JSON.stringify(body.messages).includes('image_url')) return { text: '图上能看到运河折线、五个地名与标题，标签互不重叠。' }
    if (sys.includes('你在审核一张历史地图的需求')) {
      if (user.includes('永远答错')) return { text: '好的，我看完了。' }
      if (!user.includes('上一轮的情况')) return { text: '需求基本清楚，可以开工。' }
      return { text: JSON.stringify({ inferred: [], ambiguous: [], missing: [], notes: [] }) }
    }
    if (sys.includes('地图工作流：资料检索')) {
      const submits = toolResults(body, 'submit_features')
      if (!toolResults(body, 'search_sources').length) return { toolCalls: adapters.map(adapter => ({ name: 'search_sources', args: { adapter, query: '邗沟' } })) }
      if (!submits.length) return { toolCalls: [{ name: 'submit_features', args: { features: [...places, route, incidentRegion] } }] }
      return { toolCalls: [{ name: 'submit_features', args: { features: [...places, route, sheyang], uncertainties: ['射阳湖湖岸未定，按示意点表示'] } }] }
    }
    if (sys.includes('地图工作流：底图')) {
      if (fresh) baseRuns++
      const renders = toolResults(body, 'render_base')
      const submits = toolResults(body, 'submit_base')
      if (!renders.length) return { toolCalls: [{ name: 'render_base', args: { mode: 'program', bbox: baseRuns === 1 ? WIDE : TIGHT } }] }
      if (submits.length < renders.length) return { toolCalls: [{ name: 'submit_base', args: { artifact_id: renders[renders.length - 1].artifact_id } }] }
      return { toolCalls: [{ name: 'render_base', args: { mode: 'program', bbox: TIGHT } }] }
    }
    if (sys.includes('地图工作流：用图层文档作图')) {
      if (fresh) drawingVisits++
      const rollbacks = toolResults(body, 'request_rollback')
      const renders = toolResults(body, 'render_layer_doc')
      const submits = toolResults(body, 'submit_layer_doc')
      if (drawingVisits <= 3 && !rollbacks.length) return { toolCalls: [{ name: 'request_rollback', args: { stage: 'base', reason: '底图上要素偏挤，请重新确认取景是否合适' } }] }
      const doc = buildDoc(user, '邗沟走向示意图')
      if (!renders.length) return { toolCalls: [{ name: 'render_layer_doc', args: { layer_doc: buildDoc(user, '邗沟𠀀') } }] }
      if (!submits.length) return { toolCalls: [{ name: 'submit_layer_doc', args: { layer_doc: doc } }] }
      if (renders.length === 1) return { toolCalls: [{ name: 'render_layer_doc', args: { layer_doc: doc } }] }
      if (!toolResults(body, 'read_image').length) return { toolCalls: [{ name: 'read_image', args: { path: renders[1].path, question: '标签是否重叠？' } }] }
      return { toolCalls: [{ name: 'submit_layer_doc', args: { layer_doc: doc } }] }
    }
    return { text: '无事可做' }
  })
  const dramaId = getInsertId(await db.insert(schema.dramas).values({ title: '地图 Agent 回归', createdAt: ts, updatedAt: ts }))
  const configId = getInsertId(await db.insert(schema.aiServiceConfigs).values({
    serviceType: 'text', provider: 'openai', name: 'Mock agent model', baseUrl: mock.baseUrl, apiKey: 'not-a-credential',
    model: '["mock-agent"]', isActive: true, vision: true, createdAt: ts, updatedAt: ts,
  }))
`

test('拒收→自我修正、工具异常回馈、回退全链路与上限、成图即交付文档的确定性渲染、人工编辑同链', () => {
  const output = runProbe(`${SCRIPT}
    const propId = await createMap(dramaId, '邗沟走向示意图')
    let detail = await saveMapWorkflowDraft(propId, { expectedRevision: 0, brief: { era: '春秋末期', location: '江苏扬州至淮安一线', purpose: '运河走向示意图' } })

    // brief：第一次回复不合约 → 回给模型 → 第二轮合约
    await startMapWorkflow(propId, { mode: 'manual', expectedRevision: detail.revision, textConfigId: configId })
    detail = await settle(propId)
    assert.equal(detail.stage, 'research', detail.error)
    assert.deepEqual(attemptsOf(detail, 'brief'), [['rejected', 1], ['accepted', 2]])

    // research：事故形状（非示意面 + 0,0 占位）被拒收 → 模型改成示意点 → 通过
    await advanceMapWorkflow(propId, { expectedRevision: detail.revision })
    detail = await settle(propId)
    assert.equal(detail.stage, 'base', detail.error)
    assert.deepEqual(attemptsOf(detail, 'research'), [['rejected', 1], ['accepted', 2]])
    const researchRejection = detail.agent.attempts.find(a => a.stage === 'research' && a.outcome === 'rejected').problems.join('\\n')
    assert.match(researchRejection, /古射阳湖/)
    assert.match(researchRejection, /没有开启示意图模式/)
    assert.ok(detail.map_spec.places.every(p => !(p.lon === 0 && p.lat === 0)), '不得出现 (0,0) 地点')
    assert.ok(detail.map_spec.places.some(p => p.name === '射阳湖（示意）'))
    assert.equal(detail.research.queries.length, 4)

    // base：东亚大图被取景校验拒收 → 收紧后通过；模型选定的 bbox 写回几何
    await advanceMapWorkflow(propId, { expectedRevision: detail.revision })
    detail = await settle(propId)
    assert.equal(detail.stage, 'style', detail.error)
    assert.deepEqual(attemptsOf(detail, 'base'), [['rejected', 1], ['accepted', 2]])
    assert.match(detail.agent.attempts.find(a => a.stage === 'base' && a.outcome === 'rejected').problems.join(), /取景过大/)
    assert.deepEqual(detail.map_spec.bbox, TIGHT)
    const firstBaseTask = detail.outputs.base_image.run_id
    await advanceMapWorkflow(propId, { expectedRevision: detail.revision, skip: true })

    // 本运行链上已有付费底纹：回退后重跑 style 只认领它，不重复出图
    const texturePath = 'static/map-textures/fixture.png'
    fs.mkdirSync(process.env.STORAGE_PATH + '/map-textures', { recursive: true })
    await sharp({ create: { width: 64, height: 36, channels: 3, background: '#e2d5ba' } }).png().toFile(process.env.HUOBAO_DATA_DIR + '/' + texturePath)
    const textureTask = getInsertId(await db.insert(schema.sysTask).values({
      type: 'image', dramaId, provider: 'qwen-jobs', model: 'fixture-image',
      params: JSON.stringify({ map_texture: { prop_id: propId, prop_name: '邗沟走向示意图' } }),
      status: 'completed', localPath: texturePath, createdAt: ts, updatedAt: ts,
    }))
    detail = serializeDetail(await loadWorkflow(propId))
    patchRunParams(detail.run_id, { map_texture_ref: String(textureTask), map_texture_theme: 'archival' })
    const paidImages = async () => (await db.select().from(schema.sysTask).where(eq(schema.sysTask.type, 'image'))).filter(r => r.provider !== 'map-render' && r.provider !== 'map-workflow').length
    const paidBefore = await paidImages()

    // drawing（auto）：两次回退到 base 均登记成功，第 3 次被拒；随后工具异常 → 未渲染就交付被拒 → 预览 → 看图 → 交付通过 → 完成登记
    await startMapWorkflow(propId, { mode: 'auto', expectedRevision: detail.revision, textConfigId: configId })
    detail = await settle(propId, 180000)
    assert.equal(detail.status, 'completed', detail.error)
    const runTask = detail.agent.run_id
    const runAttempts = detail.agent.attempts.filter(a => a.run_id === runTask)
    assert.deepEqual(runAttempts.filter(a => a.outcome === 'rollback').map(a => [a.stage, a.target_stage]), [['drawing', 'base'], ['drawing', 'base']])
    assert.equal(detail.agent.rollbacks, 2)
    assert.deepEqual(runAttempts.filter(a => a.stage === 'base').map(a => [a.outcome, a.round]), [['accepted', 1], ['accepted', 1]], '回退后目标阶段轮次重置')
    assert.deepEqual(runAttempts.filter(a => a.stage === 'drawing' && a.outcome !== 'rollback').map(a => [a.outcome, a.round]), [['rejected', 1], ['accepted', 2]], '发起回退不消耗作图轮次')
    assert.match(runAttempts.find(a => a.stage === 'drawing' && a.outcome === 'rejected').problems.join(), /还没有用 render_layer_doc 成功渲染过/)
    assert.equal(detail.agent.rounds.drawing, 2)
    assert.equal((await db.select().from(schema.sysTask)).filter(row => row.provider === 'map-render').length, 1, 'only delivered base becomes a host version')
    assert.equal(detail.outputs.texture_image.path, texturePath)
    assert.equal(await paidImages(), paidBefore, '回退后重跑 style 只认领已付费底纹，不新出图')

    // 工具内部异常（缺字渲染失败）以工具结果回给了模型
    const glyphError = mock.requests.some(b => toolResults(b, 'render_layer_doc').some(r => typeof r === 'object' && String(r.error ?? '').includes('打包字体未覆盖')))
    assert.ok(glyphError, '渲染异常必须作为工具结果回给模型')
    const refused = mock.requests.some(b => toolResults(b, 'request_rollback').some(r => String(r.error ?? '').includes('回退已用完')))
    assert.ok(refused, '第 3 次回退必须被拒并说明')

    // 成图 = 交付文档经同一渲染链的确定性重渲染（字节一致）；语义从同一份文档导出
    const finalBytes = fs.readFileSync(process.env.HUOBAO_DATA_DIR + '/' + detail.outputs.final_image.path)
    const rerendered = await renderMapLayerDoc(detail.outputs.layer_doc)
    assert.equal(rerendered.path, detail.outputs.final_image.path)
    assert.ok(finalBytes.equals(fs.readFileSync(process.env.HUOBAO_DATA_DIR + '/' + rerendered.path)))
    let prop = await getProp(propId)
    assert.equal(prop.imageUrl, detail.outputs.final_image.path)
    const semantics = JSON.parse(prop.semantics)
    assert.deepEqual(semantics.points.map(p => p.id).sort(), detail.map_spec.places.map(p => p.id).sort())
    assert.deepEqual(semantics.lines.map(l => l.id), detail.map_spec.routes.map(r => r.id))
    assert.equal(semantics.image.source_task_id, detail.deliveries[0].version_ids[1])

    // 人工编辑：严格校验拒收（字段级），合法修改经同一渲染链成为当前图
    const doc = detail.outputs.layer_doc
    const bad = { ...doc, layers: doc.layers.map(l => l.type === 'marker' ? { ...l, at: [1.3, l.at[1]] } : l) }
    await assert.rejects(saveMapLayerDoc(propId, { layerDoc: bad, expectedRevision: detail.revision }),
      err => err instanceof MapLayerDocInvalidError && err.problems.some(p => /layers\\[\\d+\\]\\.at\\[0\\]/.test(p.path)))
    const edited = { ...doc, layers: doc.layers.map(l => l.id === 'title' ? { ...l, box: { ...l.box, x: 0.05 } } : l) }
    detail = await saveMapLayerDoc(propId, { layerDoc: edited, expectedRevision: detail.revision })
    assert.equal(detail.status, 'completed')
    prop = await getProp(propId)
    assert.equal(prop.imageUrl, detail.outputs.final_image.path)
    assert.equal((await renderMapLayerDoc(edited)).path, detail.outputs.final_image.path, '人工编辑后的成图就是该文档的确定性渲染')
    assert.equal(JSON.parse(prop.semantics).image.source_task_id, detail.deliveries[0].version_ids[1])

    // 重启：在飞运行标中断，轮次与尝试记录不归零
    const attemptsBefore = detail.agent.attempts.length
    const interruptedRun = insertRun({ taskId: propId, mode: 'manual', startStage: 'drawing', stage: 'drawing', textConfigId: configId, imageConfigId: null, imageModel: null, params: {} })
    await mutateWorkflow(propId, { action: 'fixture_running', actor: 'system', mutate: ctx => { ctx.state.status = 'running'; ctx.state.run_id = interruptedRun } })
    await failInterruptedMapWorkflows()
    detail = serializeDetail(await loadWorkflow(propId))
    assert.equal(detail.status, 'failed')
    assert.equal(detail.agent.attempts.length, attemptsBefore)
    assert.equal(detail.agent.rollbacks, 2)
    await mock.close()
    console.log('MAP_AGENT_FLOW_OK')
  `)
  assert.match(output, /MAP_AGENT_FLOW_OK/)
})

test('轮次耗尽交人，失败原因交给下一次运行的模型', () => {
  const output = runProbe(`${SCRIPT}
    const propId = await createMap(dramaId, '永远答错的地图')
    let detail = await saveMapWorkflowDraft(propId, { expectedRevision: 0, brief: { era: '春秋末期', location: '江苏', purpose: '示意图' } })
    await startMapWorkflow(propId, { mode: 'manual', expectedRevision: detail.revision, textConfigId: configId })
    detail = await settle(propId)
    assert.equal(detail.status, 'failed')
    assert.match(detail.error, /3 轮/)
    assert.deepEqual(attemptsOf(detail, 'brief'), [['rejected', 1], ['rejected', 2], ['rejected', 3]])
    const before = mock.requests.length
    await startMapWorkflow(propId, { mode: 'manual', expectedRevision: detail.revision, textConfigId: configId })
    detail = await settle(propId)
    assert.match(userText(mock.requests[before]), /上一次执行失败/)
    assert.equal(attemptsOf(detail, 'brief').length, 6, '历史尝试保留，新运行重新计数')
    await mock.close()
    console.log('MAP_AGENT_EXHAUST_OK')
  `)
  assert.match(output, /MAP_AGENT_EXHAUST_OK/)
})

test('独立地图跑完整模型阶段后可下载成图、语义与可编辑源，不向宿主交付', () => {
  const output = runProbe(`${SCRIPT}
    const { createStandaloneTask } = await import('file://${backend}src/modules/map-studio/tasks.ts')
    const { mapStudioRoutes } = await import('file://${backend}src/modules/map-studio/index.ts')
    let detail = await createStandaloneTask({ title: '独立邗沟地图', brief: { era: '春秋末期', location: '江苏扬州至淮安一线', purpose: '运河走向示意图' } })
    const taskId = detail.task_id
    for (let i = 0; i < 3; i++) {
      await startMapWorkflow(taskId, { mode: 'manual', expectedRevision: detail.revision, textConfigId: configId })
      detail = await settle(taskId)
      assert.notEqual(detail.status, 'failed', detail.error)
    }
    assert.equal(detail.stage, 'style')
    detail = await advanceMapWorkflow(taskId, { expectedRevision: detail.revision, skip: true })
    drawingVisits = 3
    await startMapWorkflow(taskId, { mode: 'auto', expectedRevision: detail.revision, textConfigId: configId })
    detail = await settle(taskId)
    assert.equal(detail.status, 'completed', detail.error)
    assert.equal(detail.host, null)
    assert.deepEqual(detail.deliveries, [])
    assert.equal((await db.select().from(schema.props)).length, 0)
    assert.equal((await renderMapLayerDoc(detail.outputs.layer_doc)).path, detail.outputs.final_image.path)
    for (const kind of ['final', 'semantics', 'source']) {
      const response = await mapStudioRoutes.request('/tasks/' + taskId + '/download/' + kind)
      assert.equal(response.status, 200)
      assert.ok(response.headers.get('content-disposition').includes('attachment'))
      if (kind === 'final') assert.ok((await response.arrayBuffer()).byteLength > 100)
      if (kind === 'semantics') assert.equal((await response.json()).points.length, detail.map_spec.places.length)
      if (kind === 'source') assert.deepEqual((await response.json()).layer_doc, detail.outputs.layer_doc)
    }
    const runs = await (await mapStudioRoutes.request('/tasks/' + taskId + '/runs')).json()
    assert.ok(runs.data.runs.every(run => run.status === 'completed'))
    const latest = runs.data.runs[0]
    const observed = await (await mapStudioRoutes.request('/runs/' + latest.id + '/observed?limit=1')).json()
    assert.ok(observed.data.works.every(work => work.scope === 'map_studio'))
    assert.equal(observed.data.calls.length, 1)
    const messages = await (await mapStudioRoutes.request('/calls/' + observed.data.calls[0].id + '/messages?limit=1')).json()
    assert.equal(messages.data.messages.length, 1)
    assert.equal(messages.data.has_more, true)
    await mock.close()
    console.log('MAP_STUDIO_STANDALONE_OK')
  `)
  assert.match(output, /MAP_STUDIO_STANDALONE_OK/)
})
