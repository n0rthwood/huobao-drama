/**
 * 资产名规则（Issue #34）：规范化与存量 @引用 改写的行为测试。
 * 后端规则在 TS 里，用仓库自带的 tsx 子进程跑并以 JSON 回传；前端同源实现直接 import，两边逐例对照。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeAssetName as normalizeInFrontend, suggestUniqueName } from '../../frontend/app/utils/assetName.js'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function call(fn, args) {
  const script = `
    import { normalizeAssetName, rewriteAssetMentions } from './src/services/asset-name.ts'
    const api = { normalizeAssetName, rewriteAssetMentions }
    const [fn, calls] = JSON.parse(process.env.NAME_INPUT)
    process.stdout.write('@@' + JSON.stringify(calls.map(args => api[fn](...args))))
  `
  const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, NAME_INPUT: JSON.stringify([fn, args]) },
  })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

const NORMALIZE_CASES = [
  ['1720 年初三方局势图（原文 p1）', '1720_年初三方局势图（原文_p1）'],
  ['  斋桑湖　北岸 ', '斋桑湖_北岸'],
  ['A / B', 'A_B'],
  ['a\\b:c*d?e"f<g>h|i', 'a_b_c_d_e_f_g_h_i'],
  ['@小明', '小明'],
  ['名字\t\n换行', '名字_换行'],
  ['..隐藏.', '隐藏'],
  ['火车站（候车厅）', '火车站（候车厅）'],
  ['已有_下划线', '已有_下划线'],
  [' / @ ', ''],
]

test('normalizeAssetName: whitespace and filename-unsafe runs become one _, edges trimmed, legal names untouched', () => {
  const backend = call('normalizeAssetName', NORMALIZE_CASES.map(([raw]) => [raw]))
  NORMALIZE_CASES.forEach(([raw, expected], index) => {
    assert.equal(backend[index], expected, `backend: ${JSON.stringify(raw)}`)
    assert.equal(normalizeInFrontend(raw), expected, `frontend: ${JSON.stringify(raw)}`)
  })
})

test('suggestUniqueName normalizes the base before checking collisions', () => {
  assert.equal(suggestUniqueName('斋桑湖 北岸', ['斋桑湖_北岸']), '斋桑湖_北岸-2')
  assert.equal(suggestUniqueName('斋桑湖 北岸', []), '斋桑湖_北岸')
})

const MAP = { from: '1720 年初三方局势图（原文 p1）', to: '1720_年初三方局势图（原文_p1）' }
const SHORE = { from: '斋桑湖 北岸', to: '斋桑湖_北岸' }

test('rewriteAssetMentions rewrites both the spaced and the space-dropped spelling of a renamed asset', () => {
  const [spaced, dropped] = call('rewriteAssetMentions', [
    ['以参考图片为准，@1720 年初三方局势图（原文 p1） 保持原图图面一致', [MAP], []],
    ['@斋桑湖北岸，1720年7月，阴天', [SHORE], []],
  ])
  assert.equal(spaced, '以参考图片为准，@1720_年初三方局势图（原文_p1） 保持原图图面一致')
  assert.equal(dropped, '@斋桑湖_北岸，1720年7月，阴天')
})

test('rewriteAssetMentions keeps a longer legal name that starts with the space-dropped spelling', () => {
  // 「斋桑湖北岸码头」是项目里另一个合法资产：去空白写法「斋桑湖北岸」不能把它吞掉
  const [text] = call('rewriteAssetMentions', [
    ['@斋桑湖北岸码头 远处是 @斋桑湖北岸 与 @斋桑湖 北岸', [SHORE], ['斋桑湖北岸码头', '斋桑湖_北岸']],
  ])
  assert.equal(text, '@斋桑湖北岸码头 远处是 @斋桑湖_北岸 与 @斋桑湖_北岸')
})

test('rewriteAssetMentions leaves plain text and unrelated mentions alone and is idempotent', () => {
  const source = '斋桑湖 北岸的湖面，@彼得一世 站在 @斋桑湖 北岸'
  const [once] = call('rewriteAssetMentions', [[source, [SHORE], ['彼得一世']]])
  assert.equal(once, '斋桑湖 北岸的湖面，@彼得一世 站在 @斋桑湖_北岸')
  const [twice] = call('rewriteAssetMentions', [[once, [SHORE], ['彼得一世', '斋桑湖_北岸']]])
  assert.equal(twice, once)
})
