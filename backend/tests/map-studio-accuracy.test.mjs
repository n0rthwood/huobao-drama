/**
 * Issue #99 phase ② accuracy contract: real offline dataset anchors, evidence and hard gates.
 * Research-stage blocking and confirmation-to-base execution also run in map-studio-agent.test.mjs.
 * Every subprocess has its own SQLite/data/storage directories; no upstream models or images are called.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const backend = fileURLToPath(new URL('..', import.meta.url))
const dataDir = mkdtempSync(path.join(tmpdir(), 'map-accuracy-'))
after(() => rmSync(dataDir, { recursive: true, force: true }))
const isolatedEnv = dir => ({
  ...process.env,
  HUOBAO_DATA_DIR: dir,
  SQLITE_PATH: path.join(dir, 'test.sqlite3'),
  STORAGE_PATH: path.join(dir, 'static'),
})

const script = `
  import assert from 'node:assert/strict'
  import { normalizeMapSpec } from './src/modules/map-studio/geo/base-render.ts'
  import { searchDataset, extractDatasetGeometry } from './src/modules/map-studio/geo/datasets.ts'
  import { validateFeatureSubmission, drawingProblems } from './src/modules/map-studio/validate.ts'
  import { geometryUnverified, labelOverflowProblems, excerptSupportsPoint } from './src/modules/map-studio/accuracy.ts'
  import { emptyBrief } from './src/modules/map-studio/types.ts'

  const out = {}
  const adapters = ['wikipedia-zh', 'wikipedia-en', 'europeana', 'smithsonian']
  const source = { id: 'S1', adapter: 'wikipedia-zh', title: '喀什里克', url: 'https://example.org/kashlyk', institution: '', date: '', license: '', tier: 'B',
    excerpt: '喀什里克位于托博尔斯克附近，距托博尔斯克约 20 公里；沿托博尔河而上可到托博尔斯克。坐标为 68.4E, 58.1N。' }
  // Production prop 239's bad longitude is inside this extent: bbox alone cannot detect it.
  const extent = [55, 56.5, 70, 60]
  const ctx = (extra = {}) => ({ brief: { ...emptyBrief(), subject: '托博尔斯克', schematic: false }, sources: [source],
    searchedAdapters: adapters, requiredAdapters: adapters, confirmed: null, extent, ...extra })
  const place = (name, lon, lat, extra = {}) => ({ kind: 'place', name, lon, lat, category: 'settlement', geometry_source: 'model',
    coordinate_basis: 'well_known', source_ids: ['S1'], basis: '检索资料所述位置', uncertainty: 'medium', ...extra })
  const ack = (code, reason) => [{ code, reason }]

  const candidates = searchDataset('place', 'Tobolsk')
  assert.ok(candidates.length, 'Tobolsk must exist in the real place dataset')
  const anchor = extractDatasetGeometry(candidates[0].ref)
  out.anchor = { ref: anchor.ref, layer: anchor.layer, kind: anchor.kind, lon: anchor.lon, lat: anchor.lat, names: anchor.names }
  const tobolsk = (extra = {}) => ({ kind: 'place', name: 'Tobolsk', category: 'settlement', geometry_source: 'dataset', dataset_ref: { ref: anchor.ref },
    coordinate_basis: 'well_known', source_ids: ['S1'], basis: 'Natural Earth 地点原始坐标', uncertainty: 'low', ...extra })
  const kashlyk = (lon, lat, extra = {}) => place('喀什里克', lon, lat, extra)
  const relation = (extra = {}) => ({ id: 'R1', subject: '喀什里克', object: 'Tobolsk', relation: 'distance_km', value_km: 20, tolerance_km: 3,
    excerpt: '距托博尔斯克约 20 公里', source_id: 'S1', ...extra })

  out.swapped = validateFeatureSubmission([place('托博尔斯克（待核）', 58.2, 68.25)], ctx())
  out.outside = validateFeatureSubmission([place('范围外地点', 10, 58)], ctx())
  out.missingExtent = validateFeatureSubmission([place('托博尔斯克', 68.3, 58.2)], ctx({ extent: undefined }))
  // A whole dataset river outside the extent: one aggregated problem, not one line per vertex.
  const volgaGroup = searchDataset('river', 'Volga', [20, 40, 55, 58]).find(hit => hit.group)
  out.wholeRiverVertices = extractDatasetGeometry(volgaGroup.ref).vertices
  out.wholeRiver = validateFeatureSubmission([{ kind: 'route', name: '伏尔加河', category: 'river', geometry_source: 'dataset',
    dataset_ref: { ref: volgaGroup.ref }, coordinate_basis: 'well_known', source_ids: [], basis: 'Natural Earth 组引用', uncertainty: 'low' }],
    ctx({ extent: [20, 40, 55, 58] }))
  // Production regression (task 1 / run 2): clip_bbox equal to the extent itself must be accepted.
  out.clippedToExtent = validateFeatureSubmission([{ kind: 'route', name: '伏尔加河', category: 'river', geometry_source: 'dataset',
    dataset_ref: { ref: volgaGroup.ref, clip_bbox: [20, 40, 55, 58] }, coordinate_basis: 'well_known', source_ids: [], basis: 'Natural Earth 组引用', uncertainty: 'low' }],
    ctx({ extent: [20, 40, 55, 58] }))
  out.missingCategory = validateFeatureSubmission([place('托博尔斯克', 68.3, 58.2, { category: undefined })], ctx())
  out.missingGeometrySource = validateFeatureSubmission([place('托博尔斯克', 68.3, 58.2, { geometry_source: undefined })], ctx())
  out.conflict = validateFeatureSubmission([
    kashlyk(58.2, 58.16, { acknowledge: ack('lon_lat_similar', '先回应数值接近提示，仍须核对距离关系') }), tobolsk(),
  ], ctx({ relations: [relation()] }))
  out.corrected = validateFeatureSubmission([kashlyk(68.4, 58.1), tobolsk()], ctx({ relations: [relation({ tolerance_km: 10 })] }))
  out.conflictAcknowledged = validateFeatureSubmission([
    kashlyk(60, 58, { acknowledge: ack('relation_conflict', '两份资料给出的定位有分歧，请人工裁决') }), tobolsk(),
  ], ctx({ relations: [relation()] }))
  out.wrongFeatureAcknowledged = validateFeatureSubmission([
    kashlyk(60, 58), tobolsk({ acknowledge: ack('relation_conflict', '锚点的说明不能代替主语回应') }),
  ], ctx({ relations: [relation()] }))
  out.badRelationExcerpt = validateFeatureSubmission([kashlyk(68.4, 58.1), tobolsk()], ctx({ relations: [relation({ excerpt: '原文并没有写这段距离证据' })] }))
  out.badRelationSource = validateFeatureSubmission([kashlyk(68.4, 58.1), tobolsk()], ctx({ relations: [relation({ source_id: 'S99' })] }))
  out.lonLatSimilar = validateFeatureSubmission([kashlyk(58.2, 58.16)], ctx())
  out.lonLatAcknowledged = validateFeatureSubmission([
    kashlyk(58.2, 58.16, { acknowledge: ack('lon_lat_similar', '两数值恰好接近，保留冲突交用户裁决') }),
  ], ctx())

  const riverCandidates = searchDataset('river', 'Tobol')
  assert.ok(riverCandidates.length, 'Tobol must exist in the real river dataset')
  const clip = [65, 56.5, 72, 60]
  const river = extractDatasetGeometry(riverCandidates[0].ref, clip)
  assert.ok(river.parts.length && river.parts[0].length >= 2, 'near_river anchor must have real segments')
  const vertex = river.parts[0][0]
  const riverFeature = (extra = {}) => ({ kind: 'route', name: '托博尔河', category: 'river', geometry_source: 'dataset', dataset_ref: { ref: river.ref, clip_bbox: clip },
    coordinate_basis: 'well_known', source_ids: ['S1'], basis: 'Natural Earth 河道原始顶点', uncertainty: 'low', ...extra })
  const nearRiver = { id: 'R2', subject: '喀什里克', object: '托博尔河', relation: 'near_river', tolerance_km: 15, excerpt: '沿托博尔河而上', source_id: 'S1' }
  const riverCtx = extra => ctx({ extent: [64.5, 56, 72.5, 60.5], ...extra })
  out.nearRiver = validateFeatureSubmission([kashlyk(vertex[0], vertex[1]), riverFeature()], riverCtx({ relations: [nearRiver] }))
  const manualRiver = normalizeMapSpec({ bbox: clip, routes: [{ id: 'r_manual', name: '托博尔河', points: [[65.5, 57], [68.2, 58.2], [71, 59.5]] }] })
  out.nearRiverNotDataset = validateFeatureSubmission([kashlyk(68.2, 58.2)], riverCtx({ confirmed: manualRiver, relations: [nearRiver] }))
  out.categoryMismatch = validateFeatureSubmission([riverFeature({ category: 'lake' })], riverCtx({}))
  out.kindMismatch = validateFeatureSubmission([riverFeature({ kind: 'place' })], riverCtx({}))
  out.unknownRef = validateFeatureSubmission([riverFeature({ dataset_ref: { ref: 'ne:10m_rivers_lake_centerlines:99999' } })], riverCtx({}))
  out.datasetWithHandCoordinates = validateFeatureSubmission([tobolsk({ lon: anchor.lon, lat: anchor.lat })], ctx())
  const missingRiver = (extra = {}) => ({ kind: 'route', name: '资料中的古河道', category: 'river', geometry_source: 'model', points: [[66.5, 57.2], [68, 57.6]],
    coordinate_basis: 'well_known', source_ids: ['S1'], basis: '检索正文走向', uncertainty: 'high', ...extra })
  const missingClaim = { dataset_missing: { queries: ['historical unnamed tributary'], reason: '该历史支流在数据集中没有命中，请人工裁决' } }
  out.naturalNoDataset = validateFeatureSubmission([missingRiver()], riverCtx({}))
  out.datasetMissingUnsearched = validateFeatureSubmission([missingRiver(missingClaim)], riverCtx({ datasetQueries: [] }))
  out.datasetMissing = validateFeatureSubmission([missingRiver(missingClaim)], riverCtx({ datasetQueries: [{ layer: 'river', query: 'historical unnamed tributary', hits: 0, refs: [] }] }))

  out.excerpt = {
    decimal: excerptSupportsPoint('坐标 68.3E, 58.2N', [68.3, 58.2]),
    dms: excerptSupportsPoint('坐标 68°15′0″E, 58°12′0″N', [68.25, 58.2]),
    labelled: excerptSupportsPoint('经度: 68.3 纬度: 58.2', [68.3, 58.2]),
    wrong: excerptSupportsPoint('坐标 68.3E, 58.2N', [60, 58.2]),
    placeMentionOnly: excerptSupportsPoint('喀什里克位于托博尔斯克附近', [68.4, 58.1]),
  }
  out.coordinateExcerpt = validateFeatureSubmission([kashlyk(68.4, 58.1, {
    geometry_source: 'source', coordinate_basis: 'excerpt', supporting_excerpt: '坐标为 68.4E, 58.1N',
  })], ctx())

  const gateSpec = normalizeMapSpec({ bbox: extent, places: [
    { id: 'p_dataset', name: 'Tobolsk', lon: anchor.lon, lat: anchor.lat, proposed: true, origin: 'dataset', verification: { status: 'verified', reasons: ['数据集'] } },
    { id: 'p_source', name: '来源点', lon: 68.4, lat: 58.1, proposed: true, origin: 'source', verification: { status: 'verified', reasons: ['原文经纬度'] } },
    { id: 'p_model', name: '模型点', lon: 67.6, lat: 57.9, proposed: true, origin: 'model', verification: { status: 'unverified', reasons: ['尚无可核验依据'] } },
    { id: 'p_confirmed', name: '已确认点', lon: 67.2, lat: 57.7, origin: 'model', verification: { status: 'unverified', reasons: ['旧说明'] } },
  ] })
  const confirmedGateSpec = JSON.parse(JSON.stringify(gateSpec))
  for (const item of confirmedGateSpec.places) delete item.proposed
  out.gate = { blocked: geometryUnverified(gateSpec), released: geometryUnverified(confirmedGateSpec), absent: geometryUnverified(null) }

  const longTitle = '中俄百年变局：从彼得大帝到叶卡捷琳娜二世的北方争霸与边疆经略'
  const layer = (id, extra) => ({ id, name: id, visible: true, locked: false, z: 0, opacity: 1, rotation: 0, ...extra })
  const label = (text, h) => layer('title', { type: 'label', box: { x: 0.05, y: 0.05, w: 0.4, h }, text, style: { size: 0.05 } })
  const card = text => layer('year-card', { type: 'card', template: 'year', box: { x: 0.05, y: 0.2, w: 0.4, h: 0.05 }, fields: { title: text, years: '', sub: '', meta: '' }, style: { scale: 1 } })
  const doc = layers => ({ version: 1, base: { path: 'static/map-bases/fixture.png', width: 1280, height: 720 }, theme: 'archival', layers })
  const registration = { mode: 'program', width: 1280, height: 720, bbox: extent,
    program: { projection: 'equirectangular', bbox: extent, fit: 'd3.fitExtent', extent: [[0, 0], [1280, 720]] } }
  out.labels = {
    overflow: labelOverflowProblems(doc([label(longTitle, 0.05)])),
    fits: labelOverflowProblems(doc([label('托博尔斯克', 0.1)])),
    cardOverflow: labelOverflowProblems(doc([card(longTitle)])),
    cardFits: labelOverflowProblems(doc([card('托博尔斯克')])),
    drawing: drawingProblems({ doc: doc([label(longTitle, 0.05)]), features: [], registration, omitted: [] }).problems,
  }
  console.log('@@' + JSON.stringify(out))
`

const stdout = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
  cwd: backend, encoding: 'utf8', timeout: 120000, env: isolatedEnv(dataDir),
})
const result = JSON.parse(stdout.slice(stdout.lastIndexOf('@@') + 2))

test('硬闸：Tobolsk 经纬度互换、extent 外、缺少 extent/category/geometry_source 都整批拒收', () => {
  assert.deepEqual(result.swapped.features, [])
  assert.match(result.swapped.problems.join('\n'), /经纬度互换/)
  assert.deepEqual(result.outside.features, [])
  assert.match(result.outside.problems.join('\n'), /超出 extent/)
  assert.match(result.missingExtent.problems.join('\n'), /extent 必填/)
  assert.match(result.missingCategory.problems.join('\n'), /category/)
  assert.match(result.missingGeometrySource.problems.join('\n'), /geometry_source/)
})

test('extent 违规按要素聚合成一条问题，并给出 clip_bbox 修法', () => {
  assert.ok(result.wholeRiverVertices >= 300)
  assert.deepEqual(result.wholeRiver.features, [])
  assert.equal(result.wholeRiver.problems.length, 1)
  assert.match(result.wholeRiver.problems[0], /^「伏尔加河」：\d+ 个顶点超出 extent（/)
  assert.match(result.wholeRiver.problems[0], /经度 [\d.]+–[\d.]+，纬度 [\d.]+–[\d.]+/)
  assert.match(result.wholeRiver.problems[0], /dataset_ref\.clip_bbox/)
  assert.match(result.wholeRiver.problems[0], /clip_bbox=\[20,40,55,58\]/)
  assert.doesNotMatch(result.wholeRiver.problems[0], /经纬度互换/)
})

test('dataset 要素按 extent 本身裁剪即通过：不再有内缩留边的第二层框', () => {
  assert.deepEqual(result.clippedToExtent.problems, [])
  assert.ok(result.clippedToExtent.features.length >= 1)
})

test('托博尔斯克来自真实 place 数据集；喀什里克错误经度与 20km 证据冲突，改正后 verified', () => {
  assert.equal(result.anchor.layer, 'place')
  assert.equal(result.anchor.kind, 'place')
  assert.match(result.anchor.ref, /^ne:/)
  assert.ok(Math.abs(result.anchor.lon - 68.264815) < 0.001)
  assert.ok(Math.abs(result.anchor.lat - 58.199793) < 0.001)
  assert.deepEqual(result.conflict.features, [])
  assert.match(result.conflict.problems.join('\n'), /relation_conflict.*声明.*20 km.*按坐标计算/)
  assert.equal(result.conflict.relations[0].computed.consistent, false)
  assert.ok(result.conflict.relations[0].computed.value_km > 550)
  assert.ok(result.conflict.relations[0].computed.value_km < 620)
  assert.deepEqual(result.corrected.problems, [])
  assert.equal(result.corrected.relations[0].computed.consistent, true)
  assert.ok(result.corrected.relations[0].computed.value_km > 10)
  assert.ok(result.corrected.relations[0].computed.value_km < 17)
  assert.equal(result.corrected.features[0].verification.status, 'verified')
  assert.match(result.corrected.features[0].verification.reasons.join(), /关系证据一致/)
  assert.equal(result.corrected.features[1].verification.status, 'verified')
})

test('软证据：acknowledge 接受说明但保留 conflict，锚点不被主语冲突污染', () => {
  assert.match(result.lonLatSimilar.problems.join(), /lon_lat_similar/)
  assert.deepEqual(result.lonLatAcknowledged.problems, [])
  assert.equal(result.lonLatAcknowledged.features[0].verification.status, 'conflict')
  assert.match(result.lonLatAcknowledged.features[0].verification.reasons.join(), /lon_lat_similar.*用户裁决/)
  assert.deepEqual(result.conflictAcknowledged.problems, [])
  assert.equal(result.conflictAcknowledged.features[0].verification.status, 'conflict')
  assert.match(result.conflictAcknowledged.features[0].verification.reasons.join(), /人工裁决/)
  assert.equal(result.conflictAcknowledged.features[1].verification.status, 'verified', 'dataset object remains an independently verified anchor')
  assert.match(result.wrongFeatureAcknowledged.problems.join(), /relation_conflict/, 'acknowledgement on the object cannot acknowledge the subject conflict')
  assert.match(result.badRelationExcerpt.problems.join(), /excerpt.*逐字引用/)
  assert.match(result.badRelationSource.problems.join(), /source_id/)
})

test('near_river 必须指向数据集河流，真实原始顶点上的点由一致关系核验', () => {
  assert.deepEqual(result.nearRiver.problems, [])
  assert.equal(result.nearRiver.relations[0].computed.consistent, true)
  assert.ok(result.nearRiver.relations[0].computed.value_km < 0.001)
  assert.equal(result.nearRiver.features[0].verification.status, 'verified')
  assert.equal(result.nearRiver.features[1].origin, 'dataset')
  assert.match(result.nearRiverNotDataset.problems.join(), /near_river 必须指向数据集河流/)
})

test('自然要素严格核对类别、几何类型与引用；dataset_missing 只接受真正查过的零命中', () => {
  assert.match(result.categoryMismatch.problems.join(), /category=lake.*dataset 图层 river/)
  assert.match(result.kindMismatch.problems.join(), /dataset 几何为 route/)
  assert.ok(result.unknownRef.problems.length > 0)
  assert.deepEqual(result.unknownRef.features, [])
  assert.match(result.datasetWithHandCoordinates.problems.join(), /dataset 不得手写/)
  assert.match(result.naturalNoDataset.problems.join(), /自然要素必须取自 dataset/)
  assert.match(result.datasetMissingUnsearched.problems.join(), /本阶段.*真正查过/)
  assert.deepEqual(result.datasetMissing.problems, [])
  assert.equal(result.datasetMissing.features[0].verification.status, 'needs_user')
})

test('出处中的十进制与度分秒经纬度可核验，只有地名提及不能冒充坐标证据', () => {
  assert.deepEqual(result.excerpt, { decimal: true, dms: true, labelled: true, wrong: false, placeMentionOnly: false })
  assert.deepEqual(result.coordinateExcerpt.problems, [])
  assert.equal(result.coordinateExcerpt.features[0].excerpt_verified, true)
  assert.equal(result.coordinateExcerpt.features[0].verification.status, 'verified')
})

test('几何闸门保留规范化后的核验元数据：verified 及已确认放行，AI 未核验提议阻断', () => {
  assert.deepEqual(result.gate.blocked.map(feature => feature.id), ['p_model'])
  assert.match(result.gate.blocked[0].reasons.join(), /尚无可核验依据/)
  assert.deepEqual(result.gate.released, [])
  assert.equal(result.gate.absent.length, 1)
})

test('label/card 长标题放入矮 box 返回 label_overflow；作图交付使用同一规则，不缩字号截断', () => {
  for (const problems of [result.labels.overflow, result.labels.cardOverflow]) {
    assert.ok(problems.length)
    assert.match(problems[0].message, /label_overflow.*(?:title|year-card).*需要 \d+ 行.*高度为 \d+(?:\.\d+)?px/)
  }
  assert.deepEqual(result.labels.fits, [])
  assert.deepEqual(result.labels.cardFits, [])
  assert.match(result.labels.drawing.join(), /label_overflow.*title/)
})

test('HTTP base 启动先以 geometry_unverified 拒绝；PUT 确认释放研究阻断，人工图层保存拒绝溢出', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'map-accuracy-gate-'))
  const probe = path.join(dir, 'probe.mts')
  writeFileSync(probe, `
    import assert from 'node:assert/strict'
    import { initMapStudio, mapStudioRoutes } from 'file://${backend}src/modules/map-studio/index.ts'
    import { createStandaloneTask } from 'file://${backend}src/modules/map-studio/tasks.ts'
    import { mutateTask, loadTask } from 'file://${backend}src/modules/map-studio/store.ts'
    import { geometryUnverified } from 'file://${backend}src/modules/map-studio/accuracy.ts'
    import { saveMapLayerDoc, MapLayerDocInvalidError } from 'file://${backend}src/modules/map-studio/run.ts'
    import { selectRunsByTask } from 'file://${backend}src/modules/map-studio/db.ts'
    await initMapStudio({
      async submitImage() { throw Error('Unexpected billed image call') },
      async pollImage() { return { status: 'missing', path: null, error: 'fixture' } },
    })
    const extent = [55, 56.5, 70, 60]
    const spec = () => ({ version: 1, projection: { type: 'mercator' }, bbox: extent, layers: {}, routes: [], regions: [], style: { theme: 'archival' }, places: [
      { id: 'p_kashlyk', name: '喀什里克', lon: 68.4, lat: 58.1, proposed: true, category: 'settlement', origin: 'model', verification: { status: 'unverified', reasons: ['尚无可核验依据，请人工确认'] } },
    ] })
    const detail = await createStandaloneTask({ title: '托博尔斯克', brief: { era: '1580 年代', location: '西伯利亚 托博尔斯克', purpose: '位置示意图' } })
    const id = detail.task_id
    // Fixture starts at base so the HTTP assertion has no configured model to accidentally call.
    await mutateTask(id, { action: 'fixture_base_gate', actor: 'system', mutate: ctx => {
      ctx.mapSpec = spec(); ctx.state.stage = 'base'; ctx.state.status = 'idle'
    } })
    const denied = await mapStudioRoutes.request('/tasks/' + id + '/advance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(denied.status, 400)
    const deniedBody = await denied.json()
    assert.equal(deniedBody.error, 'geometry_unverified')
    assert.match(deniedBody.message, /喀什里克.*尚无可核验依据/)
    assert.equal(selectRunsByTask(id, 10).length, 0, 'reject before creating a run or looking up a model')

    // The real research execution is covered by map-studio-agent; exercise its persisted confirmation state here.
    await mutateTask(id, { action: 'fixture_research_blocked', actor: 'system', mutate: ctx => {
      ctx.state.stage = 'research'; ctx.state.status = 'blocked'
      ctx.state.research = { queries: [], sources: [], features: [], uncertainties: [], notes: [], searched_at: new Date().toISOString() }
      ctx.state.issues = [{ field: 'research', code: 'geometry_unverified', blocking: true, message: '「喀什里克」：尚无可核验依据，请人工确认' }]
    } })
    const before = await loadTask(id)
    const confirmed = JSON.parse(JSON.stringify(before.mapSpec))
    for (const item of confirmed.places) delete item.proposed
    const response = await mapStudioRoutes.request('/tasks/' + id, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_revision: before.state.revision, map_spec: confirmed }) })
    assert.equal(response.status, 200)
    const released = (await response.json()).data
    assert.equal(released.stage, 'base')
    assert.equal(released.status, 'awaiting_review')
    assert.equal(released.steps.find(step => step.id === 'research').status, 'completed')
    assert.ok(!released.issues.some(issue => issue.code === 'geometry_unverified'))
    assert.deepEqual(geometryUnverified((await loadTask(id)).mapSpec), [])

    const doc = (text, h) => ({ version: 1, base: { path: 'static/map-bases/fixture.png', width: 1280, height: 720 }, theme: 'archival', layers: [
      { id: 'title', name: 'title', visible: true, locked: false, z: 0, opacity: 1, rotation: 0, type: 'label', box: { x: 0.05, y: 0.05, w: 0.4, h }, text, style: { size: 0.05 } },
    ] })
    await mutateTask(id, { action: 'fixture_manual_layer_doc', actor: 'system', mutate: ctx => {
      ctx.state.stage = 'drawing'; ctx.state.status = 'awaiting_review'
      ctx.state.outputs.base_image = { path: 'static/map-bases/fixture.png', width: 1280, height: 720, source: 'fixture', run_id: null, provenance: null }
      ctx.state.outputs.layer_doc = doc('托博尔斯克', 0.1)
    } })
    await assert.rejects(saveMapLayerDoc(id, { layerDoc: doc('中俄百年变局：从彼得大帝到叶卡捷琳娜二世的北方争霸与边疆经略', 0.05) }),
      err => err instanceof MapLayerDocInvalidError && err.problems.some(problem => /label_overflow.*title/.test(problem.message)))
    const overflowResponse = await mapStudioRoutes.request('/tasks/' + id + '/layer-doc', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layer_doc: doc('中俄百年变局：从彼得大帝到叶卡捷琳娜二世的北方争霸与边疆经略', 0.05) }) })
    assert.equal(overflowResponse.status, 400)
    const overflowBody = await overflowResponse.json()
    assert.equal(overflowBody.error, 'layer_doc_invalid')
    assert.ok(overflowBody.problems.some(problem => /label_overflow.*title/.test(problem.message)))
    console.log('MAP_ACCURACY_GATE_OK')
  `)
  try {
    const output = execFileSync('node_modules/.bin/tsx', [probe], { cwd: backend, encoding: 'utf8', timeout: 120000, env: isolatedEnv(dir) })
    assert.match(output, /MAP_ACCURACY_GATE_OK/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
