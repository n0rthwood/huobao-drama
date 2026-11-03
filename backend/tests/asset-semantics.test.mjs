/**
 * 语义标注 schema 与规范化的行为测试（Issue #47 验收 4 / 6）。
 *
 * 纯函数在 TS 里，但 `asset-semantics.ts` 同时承担持久化（唯一读写口），
 * 会连带加载带顶层 await 的 `db/index.ts`，所以必须用 ESM 口径的 tsx 子进程
 * （`node --import tsx --input-type=module`）并给一个隔离的 SQLITE_PATH；
 * 迁移日志会混进 stdout，结果按 `@@` 标记截取（与 storyboard-pool 测试同口径）。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

const script = `
  import {
    countSemantics, mergeSemantics, normalizeSemantics, parseSemantics,
  } from './src/services/asset-semantics.ts'
  const input = JSON.parse(process.env.SEMANTICS_INPUT)
  const run = (fn) => { try { return { ok: fn() } } catch (err) { return { error: err.message } } }
  process.stdout.write('@@' + JSON.stringify({
    normalize: input.normalize.map(raw => run(() => normalizeSemantics(raw))),
    parse: input.parse.map(raw => parseSemantics(raw)),
    merge: run(() => mergeSemantics(
      normalizeSemantics(input.merge.existing), normalizeSemantics(input.merge.fresh))),
    counts: countSemantics(normalizeSemantics(input.counts)),
    review: Object.fromEntries(Object.entries(input.review).map(([k, v]) => [k, run(() => normalizeSemantics(v))])),
  }))
`

const image = { width: 2000, height: 1000, source_task_id: 501 }

const normalizeCases = [
  // 0 完整文档：补 id/source/confidence 默认值，坐标取整
  {
    image,
    labels: [{ text: '斋桑湖', bbox: [100.4, 200.6, 180, 230], source: 'cv', confidence: 0.9 }],
    points: [{ name: '西宁', at: [400.2, 500.8] }],
    regions: [{ name: '准噶尔汗国', points: [[10, 10], [900, 10], [900, 600], [10, 600]] }],
    lines: [{ name: '额尔齐斯河', points: [[0, 0], [100, 50], [200, 120]], kind: 'river', color: '#3A6FB0' }],
  },
  // 1 空组省略：只给 image 也是合法文档
  { image },
  // 2 bbox 写反（右下 → 左上）：规范化成左上→右下，不报错
  { image, labels: [{ text: '拉萨', bbox: [300, 400, 200, 350] }] },
  // 3 坐标越界到画幅之外 → 400
  { image, points: [{ name: '错点', at: [9999, 10] }] },
  // 4 多边形不足三点 → 400
  { image, regions: [{ name: '太短', points: [[1, 1], [2, 2]] }] },
  // 5 折线不足两点 → 400
  { image, lines: [{ name: '太短', points: [[1, 1]] }] },
  // 6 缺 image → 400
  { labels: [{ text: 'x', bbox: [1, 2, 3, 4] }] },
  // 7 非法 source → 400
  { image, points: [{ name: 'x', at: [1, 1], source: 'guess' }] },
  // 8 非法颜色 → 400（颜色要进 CV 阈值，不能是「蓝色」这种字面）
  { image, lines: [{ name: 'x', points: [[1, 1], [2, 2]], color: '蓝色' }] },
  // 9 超出画幅一点点（<10%）：钳制到边界，不报错
  { image, labels: [{ text: '边上', bbox: [-5, -3, 2005, 12] }] },
]

const parseCases = [
  null,
  '',
  '{ not json',
  JSON.stringify({ image, labels: [{ text: '北京', bbox: [1, 2, 3, 4] }] }),
]

const merge = {
  existing: {
    image,
    lines: [
      { id: 'ln-1', name: '额尔齐斯河', points: [[0, 0], [10, 10]], kind: 'river', source: 'manual', confidence: 1 },
      { id: 'ln-2', name: '南路', points: [[0, 0], [20, 20]], kind: 'route', source: 'cv', confidence: 0.6 },
    ],
    labels: [{ id: 'lbl-1', text: '人工改过的', bbox: [1, 1, 2, 2], source: 'manual', confidence: 1 }],
  },
  fresh: {
    image,
    lines: [
      { id: 'ln-1', name: '自动重算的河', points: [[5, 5], [6, 6]], kind: 'river', source: 'cv', confidence: 0.5 },
      { id: 'ln-3', name: '北路', points: [[1, 1], [2, 2]], kind: 'route', source: 'cv', confidence: 0.7 },
    ],
    labels: [{ id: 'lbl-9', text: '新发现的', bbox: [3, 3, 4, 4], source: 'vlm', confidence: 0.8 }],
    warnings: ['某条线抽取失败'],
    generated_at: '2026-11-03T00:00:00.000Z',
    model: 'deepseek-chat',
  },
}

const counts = {
  image,
  labels: [{ text: 'a', bbox: [1, 1, 2, 2] }, { text: 'b', bbox: [3, 3, 4, 4] }],
  points: [{ name: 'c', at: [1, 1] }],
  regions: [{ name: 'd', points: [[1, 1], [2, 2], [3, 3]] }],
  lines: [],
}

/** 审阅标记（Issue #47 评审决议）：低置信 / 显式标记 / 只有 warnings 三种触发路径 */
const review = {
  // 0 低置信自动条目 → 条目标 needs_review，根级汇总 true/1
  lowConfidence: {
    image,
    lines: [{ id: 'ln-1', name: '模糊路线', points: [[1, 1], [2, 2]], source: 'cv', confidence: 0.4 }],
  },
  // 1 管线显式标记（质量启发式不达标，但置信度不低）
  explicit: {
    image,
    regions: [{ id: 'rg-1', name: '漏出去的范围', points: [[1, 1], [2, 2], [3, 3]], source: 'cv', confidence: 0.9, needs_review: true }],
  },
  // 2 人工条目永不标记，哪怕置信度写得很低
  manual: {
    image,
    points: [{ id: 'pt-1', name: '人改过的', at: [5, 5], source: 'manual', confidence: 0.1 }],
  },
  // 3 条目全都合格、但有 warnings（被判掉的线条没有条目可标）→ 根级仍须提醒
  warningsOnly: {
    image,
    lines: [{ id: 'ln-1', name: '好线', points: [[1, 1], [2, 2]], source: 'cv', confidence: 0.95 }],
    warnings: ['「某条边界」的颜色 #000000 是黑/白/灰，未写入 lines'],
  },
  // 4 全部合格且无 warnings → 根级不设标记
  clean: {
    image,
    labels: [{ id: 'lbl-1', text: '好标签', bbox: [1, 1, 9, 9], source: 'cv', confidence: 0.95 }],
  },
}

const tmpDir = mkdtempSync(path.join(tmpdir(), 'asset-semantics-'))
let out
try {
  out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      SQLITE_PATH: path.join(tmpDir, 'test.sqlite3'),
      SEMANTICS_INPUT: JSON.stringify({ normalize: normalizeCases, parse: parseCases, merge, counts, review }),
    },
  })
} finally {
  rmSync(tmpDir, { recursive: true, force: true })
}
const result = JSON.parse(out.slice(out.lastIndexOf('@@') + 2))

test('规范化：补默认 id/source/confidence，坐标取整，空组保留为空数组', () => {
  const doc = result.normalize[0].ok
  assert.ok(doc, result.normalize[0].error)
  assert.deepEqual(doc.image, { width: 2000, height: 1000, source_task_id: 501 })
  assert.deepEqual(doc.labels[0].bbox, [100, 201, 180, 230])
  assert.equal(doc.labels[0].source, 'cv')
  assert.ok(doc.labels[0].id)
  // 未标来源的人工条目默认按 manual 处理（人填的才会缺字段）
  assert.equal(doc.points[0].source, 'manual')
  assert.equal(doc.points[0].confidence, 1)
  assert.deepEqual(doc.points[0].at, [400, 501])
  assert.equal(doc.lines[0].kind, 'river')
  assert.equal(doc.lines[0].color, '#3a6fb0')

  const empty = result.normalize[1].ok
  assert.deepEqual([empty.labels, empty.points, empty.regions, empty.lines], [[], [], [], []])
  assert.equal(empty.image.source_task_id, 501)
})

test('规范化：bbox 写反会被归位成左上→右下', () => {
  assert.deepEqual(result.normalize[2].ok.labels[0].bbox, [200, 350, 300, 400])
})

test('非法坐标/形状一律报错（路由翻成 400）', () => {
  for (const index of [3, 4, 5, 6, 7, 8]) {
    assert.ok(result.normalize[index].error, `case ${index} 应当报错`)
  }
  assert.match(result.normalize[3].error, /超出图片范围/)
})

test('轻微越界按钳制处理，不丢条目', () => {
  assert.deepEqual(result.normalize[9].ok.labels[0].bbox, [0, 0, 2000, 12])
})

test('parse：空值与坏 JSON 返回 null，合法 JSON 返回规范化文档', () => {
  assert.equal(result.parse[0], null)
  assert.equal(result.parse[1], null)
  assert.equal(result.parse[2], null)
  assert.equal(result.parse[3].labels[0].text, '北京')
})

test('合并：人工改过的条目永远保留，同 id 的自动结果让位', () => {
  const doc = result.merge.ok
  assert.ok(doc, result.merge.error)
  const river = doc.lines.find(line => line.id === 'ln-1')
  assert.equal(river.name, '额尔齐斯河', '人工那条必须原样留下')
  assert.equal(river.source, 'manual')
  // 自动新发现的条目照常进来；上一轮自动算的（ln-2）被这一轮结果取代
  assert.ok(doc.lines.some(line => line.id === 'ln-3'))
  assert.ok(!doc.lines.some(line => line.id === 'ln-2'))
  assert.deepEqual(doc.labels.map(label => label.id), ['lbl-1', 'lbl-9'])
  assert.deepEqual(doc.warnings, ['某条线抽取失败'])
  assert.equal(doc.model, 'deepseek-chat')
})

test('计数：四组各自统计', () => {
  assert.deepEqual(result.counts, { labels: 2, points: 1, regions: 1, lines: 0 })
})

test('审阅标记：低置信与显式标记的条目标 needs_review，人工条目永不标', () => {
  const low = result.review.lowConfidence.ok
  assert.equal(low.lines[0].needs_review, true, '置信度 0.4 < 0.6 必须标')
  assert.equal(low.needs_review, true)
  assert.equal(low.needs_review_count, 1)

  const explicit = result.review.explicit.ok
  assert.equal(explicit.regions[0].needs_review, true, '管线显式标记必须保留')
  assert.equal(explicit.needs_review_count, 1)

  const manual = result.review.manual.ok
  assert.equal(manual.points[0].needs_review, undefined, '人工条目不标')
  assert.equal(manual.needs_review, undefined)
})

test('审阅标记：只有 warnings（被判掉的几何没有条目）时根级仍然提醒', () => {
  const only = result.review.warningsOnly.ok
  assert.equal(only.lines[0].needs_review, undefined, '合格条目本身不标')
  assert.equal(only.needs_review, true, 'warnings 非空时根级必须提醒')
  assert.equal(only.needs_review_count, undefined, '没有待改条目就不给计数')

  const clean = result.review.clean.ok
  assert.equal(clean.needs_review, undefined)
  assert.equal(clean.needs_review_count, undefined)
})
