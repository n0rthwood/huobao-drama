/**
 * 地图工作流交付校验（Issue #90）：只判收/拒、逐条说明，绝不修正模型交付物。
 *
 * 覆盖：要素提交（占位坐标、非示意模式的面、离群、逐字出处、来源覆盖、人工确认）、
 * 底图取景（越界、取景过大）、LayerDoc 严格校验与锚定几何、从 LayerDoc 导出语义。
 * 渲染要 sharp + TS 源码，放在 tsx 子进程里跑；HUOBAO_DATA_DIR 指向临时目录。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
const dataDir = mkdtempSync(path.join(tmpdir(), 'map-validate-'))

const script = `
  import { normalizeMapSpec } from './src/modules/map-studio/geo/base-render.ts'
  import { createMapBaseArtifact, geoToNormalized } from './src/modules/map-studio/geo/geometry.ts'
  import { normalizeLayerDoc, strictLayerDocProblems } from './src/services/layer-doc.ts'
  import {
    validateFeatureSubmission, frameReport, specFeatures, drawingProblems, drawnGeometryOf,
  } from './src/modules/map-studio/validate.ts'
  import { emptyBrief } from './src/modules/map-studio/types.ts'

  const out = {}
  const adapters = ['wikipedia-zh', 'wikipedia-en', 'europeana', 'smithsonian']
  const sources = [
    { id: 'S1', adapter: 'wikipedia-zh', title: '邗沟', url: 'https://zh.wikipedia.org/wiki/邗沟', institution: '', date: '', license: '', tier: 'B',
      excerpt: '邗沟是春秋末期吴王夫差开凿的运河，自今扬州引长江水北上，经射阳湖至今淮安入淮河。' },
  ]
  // 阶段 ②：检索必须交 extent，所有坐标都要落在 extent 内
  const EXTENT = [110, 25, 130, 45]
  const ctx = (extra = {}) => ({
    brief: { ...emptyBrief(), subject: '邗沟', schematic: false },
    sources, searchedAdapters: adapters, requiredAdapters: adapters, confirmed: null, extent: EXTENT,
    datasetQueries: [{ layer: 'lake', query: '古射阳湖', hits: 0, refs: [] }], ...extra,
  })
  const place = (name, lon, lat, extra = {}) => ({
    kind: 'place', name, lon, lat, category: 'settlement', geometry_source: 'model',
    coordinate_basis: 'well_known', source_ids: ['S1'],
    basis: '现代地名公认位置', uncertainty: 'medium', ...extra,
  })
  const jiangsu = [place('扬州', 119.42, 32.39), place('高邮', 119.46, 32.78), place('宝应', 119.31, 33.24), place('淮安', 119.15, 33.5)]

  // 事故 #1353 的原始形状：非示意模式下的 region，lon/lat 抄了模板的 0,0
  const incident = validateFeatureSubmission([...jiangsu, {
    kind: 'region', name: '古射阳湖（示意范围）', lon: 0, lat: 0, category: 'lake', geometry_source: 'model',
    dataset_missing: { queries: ['古射阳湖'], reason: '历史湖岸不在现代数据集中，需人工裁决示意范围' },
    points: [[119.55, 33.3], [119.45, 33.45], [119.7, 33.35], [119.55, 33.1]],
    coordinate_basis: 'approximate_schematic', source_ids: ['S1'], basis: '据文字概括', uncertainty: 'high',
  }], ctx())
  out.incident = incident

  out.zeroPlace = validateFeatureSubmission([...jiangsu, place('射阳湖', 0, 0)], ctx())
  out.stringCoord = validateFeatureSubmission([...jiangsu, place('射阳湖', '<lon>', '<lat>')], ctx())
  out.outlier = validateFeatureSubmission([...jiangsu, place('远方', 128.5, 43)], ctx())
  out.outlierExplained = validateFeatureSubmission([...jiangsu, place('远方', 128.5, 43, { far_from_others_reason: '图中示意远方来使的出发地' })], ctx())
  out.badExcerpt = validateFeatureSubmission([place('扬州', 119.42, 32.39, { coordinate_basis: 'excerpt', supporting_excerpt: '扬州是唐代第一大港口城市' })], ctx())
  out.goodExcerpt = validateFeatureSubmission([place('扬州', 119.42, 32.39, { coordinate_basis: 'excerpt', supporting_excerpt: '自今扬州引长江水北上' })], ctx())
  out.unsearched = validateFeatureSubmission(jiangsu, ctx({ searchedAdapters: ['wikipedia-zh'] }))
  out.unknownSource = validateFeatureSubmission([place('扬州', 119.42, 32.39, { source_ids: ['S9'] })], ctx())
  out.confirmed = validateFeatureSubmission(jiangsu, ctx({ confirmed: normalizeMapSpec({ bbox: [118, 31, 121, 34], places: [{ id: 'p_x', name: '淮安', lon: 119.1, lat: 33.5 }] }) }))
  out.schematicRegion = validateFeatureSubmission([...jiangsu, {
    kind: 'region', name: '射阳湖', category: 'lake', geometry_source: 'model', points: [[119.55, 33.3], [119.45, 33.45], [119.7, 33.35]],
    dataset_missing: { queries: ['古射阳湖'], reason: '历史湖岸不在现代数据集中，需人工裁决示意范围' },
    coordinate_basis: 'approximate_schematic', source_ids: ['S1'], basis: '据文字概括', uncertainty: 'high',
  }], ctx({ brief: { ...emptyBrief(), subject: '邗沟', schematic: true } }))
  out.clean = validateFeatureSubmission(jiangsu, ctx())

  // 取景：同一组要素，东亚大图 vs 收紧到江淮之间
  const features = normalizeMapSpec({
    bbox: [118.5, 31.9, 120.2, 33.8],
    places: jiangsu.map((p, i) => ({ id: 'p' + i, name: p.name, lon: p.lon, lat: p.lat })),
    routes: [{ id: 'r_hangou', name: '邗沟', points: [[119.42, 32.3], [119.35, 32.85], [119.55, 33.3], [119.15, 33.52]] }],
  })
  const wide = await createMapBaseArtifact({ ...features, bbox: [100, 20, 130, 45] }, { mode: 'program', width: 1280 })
  const tight = await createMapBaseArtifact(features, { mode: 'program', width: 1280 })
  const outside = normalizeMapSpec({ ...features, places: [...features.places, { id: 'far', name: '远方', lon: 125, lat: 33 }] })
  out.frame = {
    wide: frameReport(specFeatures(features), wide.registration).problems,
    tight: frameReport(specFeatures(features), tight.registration),
    outside: frameReport(specFeatures(outside), tight.registration).problems,
  }

  // LayerDoc：按投影坐标画的合法文档
  const reg = tight.registration
  const n = (lonlat) => geoToNormalized(reg, lonlat)
  const layer = (id, z, extra) => ({ id, name: id, visible: true, locked: false, z, opacity: 1, rotation: 0, ...extra })
  const doc = {
    version: 1,
    base: { path: tight.path, width: tight.width, height: tight.height },
    theme: 'archival',
    layers: [
      layer('route', 0, { type: 'polyline', anchor: { semantic_id: 'r_hangou', semantic_name: '邗沟' }, points: features.routes[0].points.map(n), style: { stroke: '#1f5f8b', width: 0.008 } }),
      ...features.places.map((p, i) => layer('m' + i, i + 1, { type: 'marker', anchor: { semantic_id: p.id, semantic_name: p.name }, at: n([p.lon, p.lat]), text: '', style: {} })),
      layer('title', 10, { type: 'label', box: { x: 0.05, y: 0.05, w: 0.4, h: 0.1 }, text: '邗沟走向示意图', style: { size: 0.05 } }),
    ],
  }
  out.strict = {
    ok: strictLayerDocProblems(doc).problems,
    roundtrip: JSON.stringify(normalizeLayerDoc(doc)) === JSON.stringify(normalizeLayerDoc(normalizeLayerDoc(doc))),
    clamped: strictLayerDocProblems({ ...doc, layers: doc.layers.map((l, i) => i === 1 ? { ...l, at: [1.2, l.at[1]] } : l) }).problems,
    missingField: strictLayerDocProblems({ ...doc, layers: doc.layers.map((l, i) => { if (i !== 1) return l; const { visible, ...rest } = l; return rest }) }).problems,
    unsorted: strictLayerDocProblems({ ...doc, layers: [...doc.layers].reverse() }).problems,
    duplicate: strictLayerDocProblems({ ...doc, layers: doc.layers.map((l, i) => i === 2 ? { ...l, id: 'm0' } : l) }).problems,
    extraField: strictLayerDocProblems({ ...doc, layers: doc.layers.map((l, i) => i === 0 ? { ...l, style: { ...l.style, glow: 1 } } : l) }).problems,
  }
  const specFeats = specFeatures(features)
  const strictDoc = strictLayerDocProblems(doc).doc
  out.drawing = {
    ok: drawingProblems({ doc: strictDoc, features: specFeats, registration: reg, omitted: [] }).problems,
    shifted: drawingProblems({ doc: normalizeLayerDoc({ ...doc, layers: doc.layers.map((l, i) => i === 1 ? { ...l, at: [l.at[0] + 0.05, l.at[1]] } : l) }), features: specFeats, registration: reg, omitted: [] }).problems,
    missing: drawingProblems({ doc: normalizeLayerDoc({ ...doc, layers: doc.layers.filter(l => l.id !== 'm3') }), features: specFeats, registration: reg, omitted: [] }).problems,
    omitted: drawingProblems({ doc: normalizeLayerDoc({ ...doc, layers: doc.layers.filter(l => l.id !== 'm3') }), features: specFeats, registration: reg, omitted: [{ feature_id: 'p3', reason: '与标题重叠，改由图注说明' }] }),
    wrongType: drawingProblems({ doc: normalizeLayerDoc({ ...doc, layers: doc.layers.map(l => l.id === 'route' ? { ...l, type: 'marker', at: l.points[0], text: '' } : l) }), features: specFeats, registration: reg, omitted: [] }).problems,
    // 生产 #1364 的形状：想画画框却交了一个实心的全幅 polygon，把底图整片盖掉
    solidFrame: drawingProblems({ doc: normalizeLayerDoc({ ...doc, layers: [layer('frame', 0, { type: 'polygon', points: [[0.01, 0.01], [0.99, 0.01], [0.99, 0.99], [0.01, 0.99]], style: { fill: '#5b4024', fill_opacity: 1 } }), ...doc.layers.map(l => ({ ...l, z: l.z + 1 }))] }), features: specFeats, registration: reg, omitted: [] }).problems,
    hollowFrame: drawingProblems({ doc: normalizeLayerDoc({ ...doc, layers: [layer('frame', 0, { type: 'polygon', points: [[0.01, 0.01], [0.99, 0.01], [0.99, 0.99], [0.01, 0.99]], style: { stroke: '#5b4024', fill_opacity: 0 } }), ...doc.layers.map(l => ({ ...l, z: l.z + 1 }))] }), features: specFeats, registration: reg, omitted: [] }).problems,
    geometry: drawnGeometryOf(strictDoc, specFeats),
    expectedPx: features.places.map(p => { const v = n([p.lon, p.lat]); return [v[0] * tight.width, v[1] * tight.height] }),
  }
  console.log('@@' + JSON.stringify(out))
`

const stdout = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
  cwd: backendRoot,
  encoding: 'utf8',
  env: { ...process.env, HUOBAO_DATA_DIR: dataDir, STORAGE_PATH: path.join(dataDir, 'static'), SQLITE_PATH: path.join(dataDir, 'test.sqlite3') },
  timeout: 120000,
})
const result = JSON.parse(stdout.slice(stdout.lastIndexOf('@@') + 2))
after(() => rmSync(dataDir, { recursive: true, force: true }))

test('事故 #1353 形状：非示意模式的面 + 模板占位 lon/lat 整批拒收，且原因可照改', () => {
  const problems = result.incident.problems.join('\n')
  assert.equal(result.incident.features.length, 0, '拒收时不返回任何要素（不退化成点、不丢弃后继续）')
  assert.match(problems, /古射阳湖/)
  assert.match(problems, /没有开启示意图模式/)
  assert.match(problems, /不使用 lon\/lat/)
})

test('坐标占位、字符串坐标与离群点都被拒收；确有依据的远处要素可说明后通过', () => {
  assert.match(result.zeroPlace.problems.join(), /\(0,0\)/)
  assert.match(result.stringCoord.problems.join(), /必须是数字/)
  assert.match(result.outlier.problems.join(), /离群/)
  assert.deepEqual(result.outlierExplained.problems, [])
  assert.equal(result.outlierExplained.features.length, 5)
})

test('逐字出处、来源引用、来源覆盖与人工确认的要素都由校验拦下', () => {
  assert.match(result.badExcerpt.problems.join(), /逐字复制/)
  assert.deepEqual(result.goodExcerpt.problems, [])
  assert.equal(result.goodExcerpt.features[0].excerpt_verified, true)
  assert.match(result.unsearched.problems.join(), /wikipedia-en、europeana、smithsonian/)
  assert.match(result.unknownSource.problems.join(), /S9/)
  assert.match(result.confirmed.problems.join(), /淮安.*人工确认/)
  assert.deepEqual(result.schematicRegion.problems, [], '示意图模式下合法的面可以提交')
  assert.equal(result.schematicRegion.features.find(feature => feature.name === '射阳湖').verification.status, 'needs_user', '数据集缺失的古湖示意范围仍必须人工裁决')
  assert.deepEqual(result.clean.problems, [])
  assert.deepEqual(result.clean.features.map(f => f.name), ['扬州', '高邮', '宝应', '淮安'])
})

test('底图取景：东亚大图因要素只占一角被拒，收紧后通过；画外要素被点名', () => {
  assert.match(result.frame.wide.join(), /取景过大/)
  assert.deepEqual(result.frame.tight.problems, [])
  assert.ok(Math.max(result.frame.tight.extent.w, result.frame.tight.extent.h) >= 0.3)
  assert.match(result.frame.outside.join(), /远方.*画外/)
})

test('LayerDoc 严格校验：合法文档原样通过，任何会被规范化改动的地方逐字段指出', () => {
  assert.deepEqual(result.strict.ok, [])
  assert.ok(result.strict.roundtrip)
  assert.ok(result.strict.clamped.some(p => p.path === 'layers[1].at[0]'), '越界坐标不得被静默钳回')
  assert.ok(result.strict.missingField.some(p => p.path === 'layers[1].visible'), '缺省字段不得被静默补上')
  assert.ok(result.strict.unsorted.some(p => p.message.includes('按 z')), '乱序不得被静默重排')
  assert.ok(result.strict.duplicate.some(p => p.message.includes('重复')), '重复 id 不得被静默改名')
  assert.ok(result.strict.extraField.some(p => p.path === 'layers[0].style.glow'), '多余字段不得被静默丢弃')
})

test('作图交付：锚定几何须与投影一致、缺失要素须显式省略；语义从同一份文档导出', () => {
  assert.deepEqual(result.drawing.ok, [])
  assert.match(result.drawing.shifted.join(), /偏离/)
  assert.match(result.drawing.missing.join(), /淮安.*没有锚定/)
  assert.deepEqual(result.drawing.omitted.problems, [])
  assert.deepEqual(result.drawing.omitted.omitted, [{ feature_id: 'p3', reason: '与标题重叠，改由图注说明' }])
  assert.match(result.drawing.wrongType.join(), /type=polyline/)
  assert.match(result.drawing.solidFrame.join(), /盖住了画面的 9\d%.*frame/, '实心全幅面会盖住底图，必须拒收')
  assert.deepEqual(result.drawing.hollowFrame, [], '只描边的画框不遮挡底图')
  const { geometry, expectedPx } = result.drawing
  assert.deepEqual(geometry.points.map(p => p.id), ['p0', 'p1', 'p2', 'p3'])
  geometry.points.forEach((p, i) => assert.ok(Math.hypot(p.at[0] - expectedPx[i][0], p.at[1] - expectedPx[i][1]) < 0.01))
  assert.deepEqual(geometry.routes.map(r => [r.id, r.color]), [['r_hangou', '#1f5f8b']])
})
