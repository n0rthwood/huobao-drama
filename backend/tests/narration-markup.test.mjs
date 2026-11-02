/**
 * 旁白发音标记（Issue #38）：源写法 → 字幕纯文字 / VoxCPM 语法 / 对齐文字，以及写错时的报错。
 * 后端规则在 TS 里，用 tsx 子进程跑并以 JSON 回传；前端同源实现直接 import，两边逐例对照。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as front from '../../frontend/app/utils/narrationMarkup.js'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function backend(sources) {
  const script = `
    import * as m from './src/services/narration-markup.ts'
    const sources = JSON.parse(process.env.MARKUP_INPUT)
    process.stdout.write('@@' + JSON.stringify(sources.map(s => ({
      spoken: m.spokenText(s),
      engineSpoken: m.engineSpokenText(s),
      voxcpm: m.toVoxcpmText(s),
      pause: m.pauseSeconds(s),
      phonemeNoNormalize: m.phonemeDisablesNormalize(s),
      errors: m.parseNarrationMarkup(s).errors.map(e => e.message),
      segments: m.parseNarrationMarkup(s).segments.map(x => x.type),
    }))))
  `
  const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, MARKUP_INPUT: JSON.stringify(sources) },
  })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

const CASES = [
  {
    src: '[[可汗|ke4 han2]]派使者[[停顿|1.5]]，[[单于|蝉于]]到了[[语气|sigh]]。',
    spoken: '可汗派使者，单于到了。',
    engineSpoken: '可汗派使者，蝉于到了。',
    voxcpm: '可汗(ke4 han2)派使者[停顿1.5秒]，蝉于到了[sigh]。',
    pause: 1.5,
  },
  {
    // 声调符号与 ü 规范成数字写法
    src: '[[重|chóng]]复与[[绿|lǜ]]洲',
    spoken: '重复与绿洲',
    engineSpoken: '重复与绿洲',
    voxcpm: '重(chong2)复与绿(lv4)洲',
    pause: 0,
  },
  {
    // 正文括号/方括号会被 VoxCPM 误当标记：一对一换成〔〕与全角，字幕保留原样
    src: '图上（原文 p1）标着 (ma1) 和 [tag] {x}',
    spoken: '图上（原文 p1）标着 (ma1) 和 [tag] {x}',
    engineSpoken: '图上〔原文 p1〕标着 〔ma1〕 和 ［tag］ ｛x｝',
    voxcpm: '图上〔原文 p1〕标着 〔ma1〕 和 ［tag］ ｛x｝',
    pause: 0,
  },
  {
    // 「停顿」二字本身也能注音：读音不是数字时按注音处理
    src: '[[停顿|ting2 dun4]]一下',
    spoken: '停顿一下',
    engineSpoken: '停顿一下',
    voxcpm: '停顿(ting2 dun4)一下',
    pause: 0,
  },
  { src: '没有任何标记的旁白。', spoken: '没有任何标记的旁白。', engineSpoken: '没有任何标记的旁白。', voxcpm: '没有任何标记的旁白。', pause: 0 },
]

const ERROR_CASES = [
  ['[[好|hao]]', /轻声/],
  ['[[好|hao5]]', /轻声/],
  ['[[可汗|ke4]]', /2 个字.*1 个音节/],
  ['[[单于|蝉]]', /字数相同/],
  ['[[停顿|20]]', /超出范围/],
  ['[[语气|cry]]', /未知的语气/],
  ['[[abc|a1]]', /只能给汉字注音/],
  ['[[可汗|xx4 han2]]', /不是有效的拼音音节/],
  ['开头[[未闭合', /没有闭合/],
]

test('源写法 → 字幕纯文字 / VoxCPM 语法 / 对齐文字（前后端一致）', () => {
  const results = backend(CASES.map(c => c.src))
  CASES.forEach((c, i) => {
    const r = results[i]
    assert.equal(r.spoken, c.spoken, `spoken: ${c.src}`)
    assert.equal(r.engineSpoken, c.engineSpoken, `engineSpoken: ${c.src}`)
    assert.equal(r.voxcpm, c.voxcpm, `voxcpm: ${c.src}`)
    assert.equal(r.pause, c.pause, `pause: ${c.src}`)
    assert.deepEqual(r.errors, [], `no errors: ${c.src}`)
    assert.equal(r.engineSpoken.replace(/\s+/g, '').length, r.spoken.replace(/\s+/g, '').length, '对齐文字与字幕逐字等长')
    assert.equal(front.spokenText(c.src), r.spoken, `前端 spokenText: ${c.src}`)
    assert.equal(front.pauseSeconds(c.src), r.pause, `前端 pauseSeconds: ${c.src}`)
    assert.deepEqual(front.parseNarrationMarkup(c.src).segments.map(x => x.type), r.segments, `前端分段: ${c.src}`)
  })
})

test('写错的标记给出可读错误（前后端一致），且不吞掉原文', () => {
  const results = backend(ERROR_CASES.map(([src]) => src))
  ERROR_CASES.forEach(([src, re], i) => {
    assert.equal(results[i].errors.length, 1, `一个错误: ${src}`)
    assert.match(results[i].errors[0], re, src)
    assert.deepEqual(front.parseNarrationMarkup(src).errors.map(e => e.message), results[i].errors, `前端错误一致: ${src}`)
  })
  assert.equal(backend(['[[可汗|ke4]]派'])[0].spoken, '可汗派', '注音写错时字幕仍是原字')
})

test('拼音注音 + 阿拉伯数字 → 规范化会被关掉的警告；同音字写法不触发', () => {
  const [pinyinWithDigits, homophoneWithDigits, pinyinNoDigits] = backend([
    '1720年，[[可汗|ke4 han2]]遣使',
    '1720年，[[可汗|克寒]]遣使',
    '[[可汗|ke4 han2]]遣使',
  ])
  assert.equal(pinyinWithDigits.phonemeNoNormalize, true)
  assert.equal(homophoneWithDigits.phonemeNoNormalize, false)
  assert.equal(pinyinNoDigits.phonemeNoNormalize, false)
})

test('编辑器的插入写法能被解析回同一个标记', () => {
  const src = `${front.rubyMarker('重庆', 'chong2 qing4')}${front.pauseMarker(0.5)}${front.toneMarker('Uhm')}`
  const [r] = backend([src])
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.segments, ['ruby', 'pause', 'tone'])
  assert.equal(front.markerAt(src, 3)?.type, 'ruby', '光标在标记内能定位到它')
  assert.equal(front.markerAt(src, 0), null, '标记边界上不算在标记内')
})
