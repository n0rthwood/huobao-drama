/**
 * 地图画中画（Issue #107）：取景框校验、版式预案与标注排布的行为。
 * 纯函数放在 tsx 子进程里跑（与其它 map-studio 测试同口径）。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

const script = `
  import { validateFrames, expandBboxToAspect } from './src/modules/map-studio/pip/frames.ts'
  import { chooseLayoutId, layoutFor } from './src/modules/map-studio/pip/layouts.ts'
  import { pipLabels } from './src/modules/map-studio/pip/labels.ts'
  import { geoMercator } from 'd3-geo'

  const OVERVIEW = [20, 42, 85, 64]
  const frame = (label, bbox, extra = {}) => ({ label, reason: '旁白反复强调该处地形', bbox, ...extra })
  const out = {}

  out.ok = validateFrames(OVERVIEW, [frame('乌格拉河口', [32, 53, 40, 56], { role: 'primary' }), frame('喀山', [47, 54.5, 52, 57])], '16:9')
  out.empty = validateFrames(OVERVIEW, [], '16:9')
  out.notArray = validateFrames(OVERVIEW, 'x', '16:9')
  out.outside = validateFrames(OVERVIEW, [frame('海外', [100, 50, 110, 55])], '16:9')
  out.tiny = validateFrames(OVERVIEW, [frame('针尖', [40, 55, 40.5, 55.4])], '16:9')
  out.huge = validateFrames(OVERVIEW, [frame('半个大陆', [25, 44, 70, 62])], '16:9')
  out.overlap = validateFrames(OVERVIEW, [frame('甲', [32, 53, 40, 56]), frame('乙', [33, 53.2, 40.5, 56.1])], '16:9')
  out.five = validateFrames(OVERVIEW, [1, 2, 3, 4, 5].map(i => frame('框' + i, [22 + i * 10, 45, 26 + i * 10, 48])), '16:9')
  out.twoPrimary = validateFrames(OVERVIEW, [frame('甲', [30, 50, 36, 53], { role: 'primary' }), frame('乙', [50, 50, 56, 53], { role: 'primary' })], '16:9')
  out.noReason = validateFrames(OVERVIEW, [{ label: '甲', reason: '', bbox: [30, 50, 36, 53] }], '16:9')
  out.autoPrimary = validateFrames(OVERVIEW, [frame('甲', [30, 50, 36, 53]), frame('乙', [50, 50, 56, 53])], '9:16')

  const grown = expandBboxToAspect([30, 50, 36, 52], 16 / 9)
  out.expand = { grown, widthKept: grown[2] - grown[0] >= 6 - 1e-6, heightGrew: grown[3] - grown[1] > 2, centerLon: (grown[0] + grown[2]) / 2 }
  out.expandPortrait = expandBboxToAspect([30, 50, 36, 52], 9 / 16)

  out.choose = {
    zero: chooseLayoutId({ detailCount: 0, aspect: '16:9', hasPrimary: false }),
    one: chooseLayoutId({ detailCount: 1, aspect: '16:9', hasPrimary: true }),
    two: chooseLayoutId({ detailCount: 2, aspect: '16:9', hasPrimary: true }),
    twoEq: chooseLayoutId({ detailCount: 2, aspect: '16:9', hasPrimary: false }),
    three: chooseLayoutId({ detailCount: 3, aspect: '16:9', hasPrimary: true }),
    threeEq: chooseLayoutId({ detailCount: 3, aspect: '4:3', hasPrimary: false }),
    four: chooseLayoutId({ detailCount: 4, aspect: '16:9', hasPrimary: true }),
    twoPortrait: chooseLayoutId({ detailCount: 2, aspect: '9:16', hasPrimary: true }),
    threePortrait: chooseLayoutId({ detailCount: 3, aspect: '3:4', hasPrimary: true }),
  }

  const canvases = { '16:9': { width: 3840, height: 2160 }, '9:16': { width: 2160, height: 3840 } }
  const ids = ['L1', 'L1b-A', 'L1b-B', 'L2a-A', 'L2b-A', 'L2b-B', 'L3a-B', 'L3b-B', 'L4a-B']
  out.layouts = {}
  for (const [aspect, canvas] of Object.entries(canvases)) for (const id of ids) {
    const l = layoutFor(id, canvas)
    const inside = l.slots.every(s => s.x >= 0 && s.y >= 0 && s.x + s.w <= canvas.width && s.y + s.h <= canvas.height)
    let overlap = false
    for (let i = 0; i < l.slots.length; i++) for (let j = i + 1; j < l.slots.length; j++) {
      const a = l.slots[i], b = l.slots[j]
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlap = true
    }
    out.layouts[aspect + ':' + id] = { family: l.family, n: l.slots.length, inside, overlap, tier: l.label_tier, short: l.min_slot_short_side, locator: !!l.locator }
  }
  let unknown = null
  try { layoutFor('L9', canvases['16:9']) } catch (e) { unknown = e.message }
  out.unknownLayout = unknown

  // 标注：同一地点集 → 同一 SVG（确定性）；落在取景外的地点不出现；示意区域带「（示意）」
  const spec = {
    version: 1, projection: { type: 'mercator' }, bbox: [32, 53, 40.5, 56.1], layers: { land: true, coastline: true, rivers: true, lakes: true, countries: false },
    places: [{ id: 'p1', name: '莫斯科', lon: 37.6, lat: 55.75 }, { id: 'p2', name: '喀山', lon: 49.1, lat: 55.8 }, { id: 'p3', name: '卡卢加', lon: 36.26, lat: 54.51 }],
    routes: [{ id: 'r1', name: '奥卡河', points: [[34, 54.2], [36.5, 54.7], [39, 54.9]], dataset_ref: { ref: 'ne-group:10m_rivers_lake_centerlines:oka' } }],
    regions: [{ id: 'g1', name: '莫斯科公国', proposed: true, origin: 'model', verification: { status: 'unverified', reasons: ['示意'] }, points: [[35, 54.5], [38.5, 54.5], [38.5, 56], [35, 56], [35, 54.5]] }],
    style: { theme: 'archival' },
  }
  const size = { width: 3840, height: 2160 }
  const projection = geoMercator().fitExtent([[0, 0], [size.width, size.height]], { type: 'Polygon', coordinates: [[[32, 53], [32, 56.1], [40.5, 56.1], [40.5, 53], [32, 53]]] })
  const a = pipLabels(spec, projection, size, { tier: 'full', fontScale: 1 })
  const b = pipLabels(spec, projection, size, { tier: 'full', fontScale: 1 })
  const reduced = pipLabels(spec, projection, size, { tier: 'reduced', fontScale: 1 })
  const verified = pipLabels({ ...spec, regions: spec.regions.map(region => ({ ...region, origin: 'dataset', verification: { status: 'verified', reasons: ['数据集'] } })) }, projection, size, { tier: 'full', fontScale: 1 })
  out.labels = {
    deterministic: a.over === b.over && a.under === b.under,
    hasMoscow: a.over.includes('莫斯科'), hasKazan: a.over.includes('喀山'), hasKaluga: a.over.includes('卡卢加'),
    hasRiver: a.over.includes('奥卡河'), reducedHasRiver: reduced.over.includes('奥卡河'),
    hasSchematicTag: a.over.includes('（示意）'), underHasRegion: a.under.includes('polygon'),
    verifiedHasTag: verified.over.includes('（示意）'),
  }
  console.log('@@' + JSON.stringify(out))
`

const stdout = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], { cwd: backendRoot, encoding: 'utf8', timeout: 120000 })
const r = JSON.parse(stdout.slice(stdout.lastIndexOf('@@') + 2))

test('取景框：合格方案规整成带编号/角色/扩框的帧；空数组合法（单张全览就够）', () => {
  assert.deepEqual(r.ok.problems, [])
  assert.equal(r.ok.frames.length, 2)
  assert.deepEqual(r.ok.frames.map(f => [f.no, f.role]), [[1, 'primary'], [2, 'aux']])
  const [f1] = r.ok.frames
  assert.deepEqual(f1.focus_bbox, [32, 53, 40, 56])
  // 实际渲染框按 16:9 扩出且仍包住模型要看清的范围
  assert.ok(f1.bbox[0] <= 32 && f1.bbox[2] >= 40 && f1.bbox[1] <= 53 && f1.bbox[3] >= 56)
  assert.deepEqual(r.empty, { frames: [], problems: [] })
})

test('取景框：不合格逐条说明并整批拒收（越界/太小/太大/重叠/超数/双重点/缺理由/非数组）', () => {
  const has = (res, re) => assert.ok(res.problems.some(p => re.test(p)), `${re} 应出现在 ${JSON.stringify(res.problems)}`)
  assert.equal(r.notArray.frames.length, 0); has(r.notArray, /必须是数组/)
  has(r.outside, /不在全览范围/)
  has(r.tiny, /范围太小/)
  has(r.huge, /不是细节/)
  has(r.overlap, /重叠过半/)
  has(r.five, /最多 4 个/)
  has(r.twoPrimary, /至多一个 role=primary/)
  has(r.noReason, /reason 不能为空/)
  for (const res of [r.outside, r.tiny, r.huge, r.overlap, r.five, r.twoPrimary, r.noReason]) assert.deepEqual(res.frames, [])
})

test('取景框：≥2 个细节且无人标重点时第一个自动为 primary', () => {
  assert.deepEqual(r.autoPrimary.frames.map(f => f.role), ['primary', 'aux'])
})

test('扩框：保持中心、只扩不裁；竖版画幅同样成立', () => {
  assert.ok(r.expand.widthKept && r.expand.heightGrew)
  assert.ok(Math.abs(r.expand.centerLon - 33) < 1e-3)
  const [w, , e] = r.expandPortrait
  assert.ok(e - w >= 6 - 1e-6)
})

test('版式选择：按细节数、画幅与重点选预置版式；≥3 个细节不用 A 族，竖屏一律 B 族', () => {
  assert.deepEqual(r.choose, {
    zero: 'L1', one: 'L1b-A', two: 'L2b-A', twoEq: 'L2a-A', three: 'L3b-B', threeEq: 'L3a-B', four: 'L4a-B',
    twoPortrait: 'L2b-B', threePortrait: 'L3b-B',
  })
})

test('版式几何：所有版式的槽位都在画布内、互不重叠；A 族有全览槽，B 族有角标定位图', () => {
  for (const [key, l] of Object.entries(r.layouts)) {
    assert.ok(l.inside, `${key} 槽位越界`)
    assert.equal(l.overlap, false, `${key} 槽位重叠`)
    if (key.endsWith(':L1')) continue
    assert.equal(l.locator, l.family === 'B', `${key} 角标定位图与族别不一致`)
  }
  assert.equal(r.layouts['16:9:L1'].n, 1)
  assert.equal(r.layouts['16:9:L4a-B'].n, 4)
  assert.equal(r.layouts['9:16:L3b-B'].n, 3)
  assert.match(r.unknownLayout, /未知画中画版式/)
})

test('版式面板阈值：4K 下短边≥900 完整标注、700–900 二级、<700 仅重点', () => {
  assert.equal(r.layouts['16:9:L2b-B'].tier, 'full')
  assert.ok(r.layouts['16:9:L3b-B'].short >= 900 || r.layouts['16:9:L3b-B'].tier !== 'full')
  for (const l of Object.values(r.layouts)) {
    if (l.short === 0) continue
    assert.equal(l.tier, l.short >= 900 ? 'full' : l.short >= 700 ? 'reduced' : 'focus_only')
  }
})

test('细节标注：确定性；取景外地点不出现；河名只在 full 层级；示意区域带「（示意）」', () => {
  assert.equal(r.labels.deterministic, true)
  assert.ok(r.labels.hasMoscow && r.labels.hasKaluga)
  assert.equal(r.labels.hasKazan, false)
  assert.ok(r.labels.hasRiver)
  assert.equal(r.labels.reducedHasRiver, false)
  assert.ok(r.labels.hasSchematicTag && r.labels.underHasRegion)
  assert.equal(r.labels.verifiedHasTag, false)
})
