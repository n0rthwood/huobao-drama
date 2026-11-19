/**
 * 地图资产引用机制（Issue #125）的行为测试——纯函数层：
 *
 * 1. 反查：设计卡四条计划态路径 + 段落/目标资产两条已落态路径，按镜聚合、vias 去重、planned/materialized 分开；
 * 2. 细节资产身份：取景 IoU ≥0.5 贪心一对一复用、低于阈值与零面积/非法框新建；
 * 3. 语义规范化：description/keywords 白名单与上限、人工标记、交付生成值不覆盖人工字段；
 * 4. 语义描述拼接：坐标依据 + 原文摘录 + 来源名，keywords 只取 category。
 *
 * 纯函数走一次 tsx 子进程以 JSON 回传；模块加载需要临时 SQLITE_PATH（不写生产库）。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

/** 设计卡夹具：底图 259、must_mark/planned_layers 指向 292、gen_plan 引用 259（六个引用路径的样例） */
const CARD_JSON = {
  version: 2,
  info_points: [],
  budget: { layer_s: 6, gen_s: null },
  layer_plan: {
    base: { kind: 'asset', asset_kind: 'prop', asset_id: 259, version_task_id: null },
    must_mark: [{ asset_id: 292, semantic_id: 'p_4e2c9af3', name: '决战地' }],
    planned_layers: [{ type: 'marker', at_s: 0, anchor: { asset_id: 292, semantic_id: 'p_4e2c9af3', name: '决战地' } }],
  },
  gen_plan: { reference_assets: [{ kind: 'prop', id: 259, name: '全览' }] },
  rationale: '',
  suggested_combo: 'C',
}

function run(body) {
  const script = `
    import { referenceViasOf, segmentBaseAssetId, aggregateReferences, semanticRefsOfRow } from './src/services/map-asset-references.ts'
    import { matchPipDetailRows, semanticIdSet, sameSemanticIdSet } from './src/services/map-pip-assets.ts'
    import { normalizeSemantics, markManualSupplements, withGeneratedSupplements, SemanticsValidationError } from './src/services/asset-semantics.ts'
    import { semanticAnnotationsOf } from './src/services/map-semantic-annotations.ts'
    import { validateFrames } from './src/modules/map-studio/pip/frames.ts'
    import { parseDesignCard } from './src/services/design-card.ts'
    const out = (value) => console.log('@@' + JSON.stringify(value))
    const CARD = ${JSON.stringify(JSON.stringify(CARD_JSON))}
    ${body}
  `
  const text = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, SQLITE_PATH: path.join(mkdtempSync(path.join(tmpdir(), 'map-refs-')), 'test.sqlite3') },
  })
  return JSON.parse(text.slice(text.lastIndexOf('@@') + 2))
}

// ─── 1. 反查 ────────────────────────────────────────────────

test('反查：六个引用路径按镜聚合、vias 去重、planned/materialized 分开', () => {
  const result = run(`out(aggregateReferences([
      {
        episode_id: 30, episode_number: 30, storyboard_id: 67, storyboard_number: 67,
        design_card: CARD, segment_base_ref: JSON.stringify({ kind: 'asset', asset_kind: 'prop', asset_id: 292, version_task_id: null }),
        segment_layer_doc: null, target_rows: 0,
      },
      {
        episode_id: 31, episode_number: 31, storyboard_id: 88, storyboard_number: 5,
        design_card: CARD, segment_base_ref: null, segment_layer_doc: null, target_rows: 1,
      },
      {
        episode_id: 31, episode_number: 31, storyboard_id: 89, storyboard_number: 6,
        design_card: null, segment_base_ref: null, segment_layer_doc: null, target_rows: 0,
      },
    ], 292))`)
  assert.equal(result.total, 2)
  // 67：卡里 must_mark + planned_layers 都指向 292（layer 与 mark 去重各一份）+ 段底图
  const first = result.references[0]
  assert.deepEqual(first.vias, ['mark', 'layer', 'segment'])
  assert.equal(first.materialized, true)
  // 88：只有目标资产（已落态）+ 卡引用
  const second = result.references[1]
  assert.deepEqual(second.vias, ['mark', 'layer', 'target'])
  assert.equal(second.materialized, true)
  assert.equal(result.materialized, 2)
  assert.equal(result.planned, 0)
})

test('反查：只有设计卡引用时算 planned（仅规划），全览底图 + gen_plan 两条路径都命中', () => {
  const vias = run(`out(referenceViasOf(parseDesignCard(CARD), 259))`)
  assert.deepEqual(vias, ['base', 'gen'])
  const counts = run(`out(aggregateReferences([{
    episode_id: 30, episode_number: 30, storyboard_id: 64, storyboard_number: 64,
    design_card: CARD, segment_base_ref: null, segment_layer_doc: null, target_rows: 0,
  }], 259))`)
  assert.equal(counts.planned, 1)
  assert.equal(counts.materialized, 0)
})

test('反查：段落底图优先读 layer_doc.base.ref（旧行没有 base_ref 时仍能命中）', () => {
  const doc = JSON.stringify({ base: { path: 'x', width: 10, height: 10, ref: { asset_kind: 'prop', asset_id: 287, version_task_id: null } } })
  const id = run(`out(segmentBaseAssetId(null, ${JSON.stringify(doc)}))`)
  assert.equal(id, 287)
  assert.equal(run(`out(segmentBaseAssetId(JSON.stringify({ kind: 'inherit_prev' }), null))`), null)
})

test('反查：语义条目引用清单只取该资产（行动的 anchor 与 must_mark）', () => {
  const ids = run(`out(semanticRefsOfRow({
    episode_id: 30, episode_number: 30, storyboard_id: 94, storyboard_number: 94,
    design_card: CARD, segment_base_ref: null, segment_layer_doc: null, target_rows: 0,
  }, 292))`)
  assert.deepEqual(ids, ['p_4e2c9af3'])
  assert.deepEqual(run(`out(semanticRefsOfRow({
    episode_id: 30, episode_number: 30, storyboard_id: 94, storyboard_number: 94,
    design_card: CARD, segment_base_ref: null, segment_layer_doc: null, target_rows: 0,
  }, 259))`), [])
})

// ─── 2. 细节资产身份（一对一 IoU）────────────────────────────

test('IoU 匹配：≥0.5 复用、<0.5 新建、一对一贪心、非法/零面积框一律新建', () => {
  const result = run(`out(matchPipDetailRows(
    [
      { no: 1, bbox: [0, 0, 10, 10] },
      { no: 2, bbox: [20, 0, 30, 10] },
      { no: 3, bbox: [40, 0, 50, 10] },
      { no: 4, bbox: [0, 0, 0, 0] },
    ],
    [
      { prop_id: 9001, bbox: [0, 0, 10, 10] },
      { prop_id: 9002, bbox: [20, 0, 30, 4] },
      { prop_id: 9003, bbox: [40, 0, 50, 10] },
    ],
  ))`)
  assert.deepEqual(result.matches.map(item => [item.no, item.prop_id]), [[1, 9001], [3, 9003]])
  assert.deepEqual(result.unmatched_frames, [2, 4])
  assert.deepEqual(result.unmatched_props, [9002])
})

test('IoU 匹配：两个新框抢同一条旧行时只给重叠更高的那个（一一对应）', () => {
  const result = run(`out(matchPipDetailRows(
    [{ no: 1, bbox: [0, 0, 10, 10] }, { no: 2, bbox: [0, 0, 10, 8] }],
    [{ prop_id: 7, bbox: [0, 0, 10, 9] }],
  ))`)
  assert.deepEqual(result.matches.map(item => [item.no, item.prop_id]), [[1, 7]])
  assert.deepEqual(result.unmatched_frames, [2])
})

test('set_frames 只接受不消费 storyboard_numbers：产出 frame 里没有这个字段', () => {
  const result = run(`out(validateFrames([0, 0, 40, 40], [
    { label: '决战地', reason: '看清汇流处', bbox: [2, 2, 12, 12], storyboard_numbers: [67, 94] },
  ], '16:9'))`)
  assert.equal(result.problems.length, 0)
  assert.equal(result.frames.length, 1)
  assert.equal('storyboard_numbers' in result.frames[0], false)
})

// ─── 3. 语义补充字段与人工所有权 ────────────────────────────

const BASE_DOC = {
  image: { width: 1000, height: 800, source_task_id: 5 },
  points: [{ id: 'p_1', name: '决战地', at: [100, 100], source: 'cv', confidence: 1 }],
}

test('语义规范化：description/keywords 白名单收纳并去重截断', () => {
  const doc = run(`out(normalizeSemantics({
    image: { width: 1000, height: 800 },
    points: [{
      id: 'p_1', name: '决战地', at: [100, 100],
      description: '  坐标依据：河口汇流 \\n  ', keywords: ['河流', '河流', '城镇'],
    }],
  }))`)
  assert.equal(doc.points[0].description, '坐标依据：河口汇流')
  assert.deepEqual(doc.points[0].keywords, ['河流', '城镇'])
  assert.equal(doc.points[0].manual, undefined)
})

test('语义规范化：超长描述与超长关键词被拒收（400 口径）', () => {
  const result = run(`try {
    normalizeSemantics({ image: { width: 10, height: 10 }, points: [{ id: 'p', name: 'x', at: [1, 1], description: 'a'.repeat(501) }] })
    out({ ok: true })
  } catch (err) { out({ ok: false, error: err instanceof SemanticsValidationError ? 'validation' : String(err) }) }`)
  assert.deepEqual(result, { ok: false, error: 'validation' })
  const longWord = run(`try {
    normalizeSemantics({ image: { width: 10, height: 10 }, points: [{ id: 'p', name: 'x', at: [1, 1], keywords: ['a'.repeat(21)] }] })
    out({ ok: true })
  } catch (err) { out({ ok: false, error: err instanceof SemanticsValidationError ? 'validation' : String(err) }) }`)
  assert.deepEqual(longWord, { ok: false, error: 'validation' })
})

test('人工打点：改过的描述/名称才标 manual / name_manual，没改的不标记', () => {
  const result = run(`{
    const previous = normalizeSemantics({
      image: { width: 1000, height: 800 },
      points: [
        { id: 'p_1', name: '决战地', at: [100, 100], description: '旧描述', keywords: ['河流'] },
        { id: 'p_2', name: '托博尔斯克', at: [200, 200] },
      ],
    })
    const next = normalizeSemantics({
      image: { width: 1000, height: 800 },
      points: [
        { id: 'p_1', name: '决战地', at: [100, 100], description: '人工改的描述', keywords: ['河流'] },
        { id: 'p_2', name: '托博尔斯克', at: [200, 200] },
        { id: 'p_3', name: '新条目', at: [300, 300] },
      ],
    })
    const marked = markManualSupplements(next, previous)
    out(marked.points.map(item => ({ id: item.id, manual: item.manual === true, name_manual: item.name_manual === true })))
  }`)
  assert.deepEqual(result, [
    { id: 'p_1', manual: true, name_manual: false },
    { id: 'p_2', manual: false, name_manual: false },
    { id: 'p_3', manual: false, name_manual: true },
  ])
})

test('交付生成值不覆盖人工字段：manual 条目的描述/关键词保留，人工改名保留', () => {
  const result = run(`{
    const previous = normalizeSemantics({
      image: { width: 1000, height: 800 },
      points: [
        { id: 'p_1', name: '决战地', at: [100, 100], description: '人工描述', keywords: ['人工'], manual: true },
        { id: 'p_2', name: '我改的名字', at: [200, 200], name_manual: true },
      ],
    })
    const generated = normalizeSemantics({
      image: { width: 1000, height: 800 },
      points: [
        { id: 'p_1', name: '决战地', at: [110, 110], description: '生成描述', keywords: ['河流'] },
        { id: 'p_2', name: '托博尔斯克', at: [200, 200], description: '生成描述' },
      ],
    })
    const supplements = new Map([
      ['p_1', { description: '生成描述', keywords: ['河流'] }],
      ['p_2', { description: '生成描述', keywords: ['城镇'] }],
    ])
    const doc = withGeneratedSupplements(generated, previous, supplements)
    out(doc.points.map(item => ({ id: item.id, name: item.name, description: item.description, keywords: item.keywords, manual: item.manual === true })))
  }`)
  assert.deepEqual(result, [
    { id: 'p_1', name: '决战地', description: '人工描述', keywords: ['人工'], manual: true },
    { id: 'p_2', name: '我改的名字', description: '生成描述', keywords: ['城镇'], manual: false },
  ])
})

test('语义 id 集合变化判据：增删任一 id 即不同（内容换了）', () => {
  const result = run(`{
    const a = semanticIdSet(normalizeSemantics({ image: { width: 10, height: 10 }, points: [{ id: 'p1', name: 'a', at: [1, 1] }] }))
    const b = semanticIdSet(normalizeSemantics({ image: { width: 10, height: 10 }, points: [{ id: 'p1', name: 'a', at: [1, 1] }, { id: 'p2', name: 'b', at: [2, 2] }] }))
    out({ same: sameSemanticIdSet(a, a), different: sameSemanticIdSet(a, b) })
  }`)
  assert.deepEqual(result, { same: true, different: false })
})

// ─── 4. 描述拼接 ────────────────────────────────────────────

test('description 拼接坐标依据 + 原文摘录 + 来源名；keywords 只取 category', () => {
  const result = run(`out([...semanticAnnotationsOf([
    { feature_id: 'f_river', name: '额尔齐斯河', category: 'river', basis: '两段河链端点相距 0.004°', excerpt: '额尔齐斯河自南向北流过', source_ids: ['S2'], coordinate_basis: 'excerpt' },
    { feature_id: 'f_site', name: '决战地', category: 'settlement', basis: '', excerpt: '', source_ids: ['S9'], coordinate_basis: 'well_known' },
    { feature_id: 'f_empty', name: '无名', basis: '', excerpt: '', source_ids: [], coordinate_basis: 'approximate_schematic' },
  ], [{ id: 'S2', title: '维基百科：额尔齐斯河' }])])`)
  const first = result.find(item => item[0] === 'f_river')[1]
  assert.match(first.description, /坐标依据：两段河链端点相距 0\.004°/)
  assert.match(first.description, /原文摘录：额尔齐斯河自南向北流过/)
  assert.match(first.description, /来源：维基百科：额尔齐斯河/)
  assert.deepEqual(first.keywords, ['河流'])
  const second = result.find(item => item[0] === 'f_site')[1]
  assert.match(second.description, /按现代地名公认位置定位/)
  assert.deepEqual(second.keywords, ['城镇'])
  // 只有示意标记的要素：描述只说明定位不精确，不编造依据
  const empty = result.find(item => item[0] === 'f_empty')[1]
  assert.equal(empty.description, '示意定位（不精确）')
  assert.equal(empty.keywords, undefined)
})
