/**
 * 「按史料画像补充外貌」（Issue #32）的纯函数行为：JSON 解析、外貌拼装、来源标注清洗。
 * 纯函数在 TS 里，用仓库自带的 tsx 子进程跑并以 JSON 回传（与 asset-name.test.mjs 同法），不连网不连库。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

/** 在子进程里调用一批 (fn, args)，返回 { ok, value } | { ok:false, error } 列表 */
function call(calls) {
  const script = `
    import { parseTraitJson, composeAppearance, stripSourceMarkers } from './src/services/portrait-appearance.ts'
    import { buildVisionProbeBody } from './src/services/vision-capability.ts'
    const api = { parseTraitJson, composeAppearance, stripSourceMarkers, buildVisionProbeBody }
    const calls = JSON.parse(process.env.PORTRAIT_INPUT)
    const out = calls.map(([fn, args]) => {
      try { return { ok: true, value: api[fn](...args) } }
      catch (err) { return { ok: false, error: String(err && err.message || err) } }
    })
    process.stdout.write('@@' + JSON.stringify(out))
  `
  const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, PORTRAIT_INPUT: JSON.stringify(calls) },
  })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

const FENCED = '```json\n{"face_shape":"方阔脸","hair":"深褐色卷发"}\n```'
const PROSE = '根据画像，可得如下特征：\n{"face_shape":"长脸","build":"高瘦"}\n以上。'

test('parseTraitJson accepts fenced and prose-wrapped JSON, throws on malformed output', () => {
  const [fenced, prose, notJson, broken, empty] = call([
    ['parseTraitJson', [FENCED]],
    ['parseTraitJson', [PROSE]],
    ['parseTraitJson', ['这个人看起来很威严，没有 JSON。']],
    ['parseTraitJson', ['{"face_shape": 方阔脸,}']],
    ['parseTraitJson', ['{"confidence_notes":"没把握"}']],
  ])
  assert.deepEqual(fenced.value, { face_shape: '方阔脸', hair: '深褐色卷发' })
  assert.deepEqual(prose.value, { face_shape: '长脸', build: '高瘦' })
  assert.equal(notJson.ok, false)
  assert.equal(broken.ok, false)
  // 只有被丢弃的 confidence_notes，没有任何可画特征：必须失败而不是写空外貌
  assert.equal(empty.ok, false)
})

test('composeAppearance keeps a stable field order and skips empty traits', () => {
  const [full, partial, none] = call([
    ['composeAppearance', [{
      distinguishing: '左眉上方小疤',
      build: '高大魁梧',
      hair: '及肩黑色时代假发',
      age_at_story: '四十八岁上下',
      face_shape: '方阔脸',
      facial_hair: '两撇上翘小髭',
    }]],
    ['composeAppearance', [{ hair: '银白卷发。', face_shape: '', build: '  ' }]],
    ['composeAppearance', [{}]],
  ])
  assert.equal(full.value, '方阔脸，及肩黑色时代假发，两撇上翘小髭，高大魁梧，四十八岁上下，左眉上方小疤。')
  assert.equal(partial.value, '银白卷发。')
  assert.equal(none.value, '')
})

test('stripSourceMarkers removes urls, bare domains, wiki attributions and footnote numbers', () => {
  const [url, domain, attribution, footnote, clean] = call([
    ['stripSourceMarkers', ['方阔脸，见 https://commons.wikimedia.org/wiki/File:Peter_I.jpg']],
    ['stripSourceMarkers', ['高大魁梧，zh.wikipedia.org']],
    ['stripSourceMarkers', ['据维基百科记载，鼻梁高挺']],
    ['stripSourceMarkers', ['深褐色卷发[1]，两撇小髭【12】']],
    ['stripSourceMarkers', ['方阔脸，深褐色卷发，身形高大。']],
  ])
  assert.equal(url.value, '方阔脸，见')
  assert.equal(domain.value, '高大魁梧')
  assert.equal(attribution.value, '鼻梁高挺')
  assert.equal(footnote.value, '深褐色卷发，两撇小髭')
  assert.equal(clean.value, '方阔脸，深褐色卷发，身形高大。')
})

test('composeAppearance strips source markers that slipped into a trait', () => {
  const [composed] = call([
    ['composeAppearance', [{ face_shape: '方阔脸[1]', hair: '时代假发（来源：commons.wikimedia.org）' }]],
  ])
  assert.equal(composed.value, '方阔脸，时代假发。')
})

test('buildVisionProbeBody sends a multimodal content array with an image_url data url', () => {
  const [body] = call([['buildVisionProbeBody', ['some-model']]])
  const content = body.value.messages[0].content
  assert.equal(body.value.model, 'some-model')
  assert.ok(Array.isArray(content), 'content 必须是数组形态，不收图的服务正是在这一步报错')
  assert.equal(content[0].type, 'text')
  assert.equal(content[1].type, 'image_url')
  assert.match(content[1].image_url.url, /^data:image\/png;base64,/)
})
