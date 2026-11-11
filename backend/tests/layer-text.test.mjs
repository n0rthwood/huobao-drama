/**
 * 模板文本框（Issue #96）：前后端同源实现逐例对照（全部 套 × 类型）+ 排版/检查行为。
 * 后端在 tsx 子进程里跑并以 JSON 回传；前端同源实现直接 import 并注入同一份规范 JSON。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as front from '../../frontend/app/utils/layerText.js'
import { layerDocToSvg as frontSvg } from '../../frontend/app/utils/layerSvg.js'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
const SPEC = JSON.parse(readFileSync(new URL('../src/config/layer-text-spec.json', import.meta.url), 'utf8'))
front.setLayerTextSpec(SPEC)

function backend(payload) {
  const script = `
    import { normalizeLayerDoc } from './src/services/layer-doc.ts'
    import { layerDocToSvg } from './src/services/layer-svg.ts'
    import { textCapacity, textLayerProblems, textLayerRects, textLayoutSelfCheck } from './src/services/layer-text.ts'
    const input = JSON.parse(process.env.TEXT_INPUT)
    process.stdout.write('@@' + JSON.stringify({
      cases: input.cases.map(item => {
        const doc = normalizeLayerDoc(item.doc)
        return {
          doc,
          svg: layerDocToSvg(doc, item.size, { viewport: item.viewport, variables: item.variables }),
          problems: textLayerProblems(doc, item.size, { beats: item.beats, variables: item.variables }),
          rects: textLayerRects(doc, item.size, item.variables),
        }
      }),
      capacities: input.capacities.map(([layout, role]) => textCapacity(layout, role)),
      selfcheck: input.layouts.map(id => textLayoutSelfCheck(id)),
    }))
  `
  const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, TEXT_INPUT: JSON.stringify(payload) },
    maxBuffer: 64 * 1024 * 1024,
  })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

const SIZES = { '16:9/video': [1920, 1080], '9:16/video': [1080, 1920], '16:9/poster': [1920, 1097], '9:16/poster': [1080, 1890] }
const SAMPLE = {
  main: '公元前207年11月14日', sub: '历史上的今天',
  items: ['条石为基', '青砖包砌', '顶宽五马并行'],
  subtitle: '从徭役到大火：秦亡的时间账', era: '公元前209—前206年', place: '大泽乡 · 巨鹿 · 轵道 · 咸阳',
}
const QUOTE = { main: '“王侯将相宁有种乎”', sub: '陈胜 · 大泽乡' }

function fieldsFor(role, long) {
  if (role === 'quote') return long ? { main: `“${'国'.repeat(60)}”`, sub: QUOTE.sub } : QUOTE
  const fields = {}
  for (const field of SPEC.roles[role].fields) {
    const value = SAMPLE[field.key] ?? '十五年'
    fields[field.key] = long ? (Array.isArray(value) ? value.map(item => item.repeat(4)) : value.repeat(4)) : value
  }
  return fields
}

function docFor(layout, layers, base = { path: 'static/uploads/base.png', width: 1920, height: 1080 }) {
  return { version: 1, theme: 'archival', base, text_layout: layout, layers }
}

const allLayouts = Object.entries(SPEC.layouts).flatMap(([key, list]) => list.map(layout => ({ key, layout })))

function parityCases() {
  const cases = []
  for (const { key, layout } of allLayouts) {
    const [width, height] = SIZES[key]
    for (const slot of layout.slots) {
      for (const long of [false, true]) {
        cases.push({
          name: `${layout.id}/${slot.role}/${long ? 'long' : 'short'}`,
          size: { width, height },
          doc: docFor(layout.id, [{ id: `t-${slot.role}`, type: 'text', role: slot.role, fields: fieldsFor(slot.role, long) }]),
        })
      }
    }
  }
  return cases
}

test('全部套 × 类型：前后端 SVG、问题清单、矩形、容量逐例一致；最坏内容自检全部通过', () => {
  const cases = parityCases()
  const capacities = allLayouts.flatMap(({ layout }) => layout.slots.map(slot => [layout.id, slot.role]))
  const layouts = allLayouts.map(({ layout }) => layout.id)
  const back = backend({ cases, capacities, layouts })
  cases.forEach((item, index) => {
    const doc = back.cases[index].doc
    assert.equal(frontSvg(doc, item.size), back.cases[index].svg, `${item.name} svg`)
    assert.deepEqual(front.textLayerProblems(doc, item.size), back.cases[index].problems, `${item.name} problems`)
    assert.deepEqual(front.textLayerRects(doc, item.size), back.cases[index].rects, `${item.name} rects`)
  })
  capacities.forEach(([layout, role], index) => {
    assert.deepEqual(front.textCapacity(layout, role), back.capacities[index], `${layout}/${role} capacity`)
  })
  back.selfcheck.forEach((errors, index) => assert.deepEqual(errors, [], `${layouts[index]} selfcheck`))
})

const H = { width: 1920, height: 1080 }
const V = { width: 1080, height: 1920 }

function problemsOf(layout, layers, size, options = {}) {
  return front.textLayerProblems(docFor(layout, layers), size, options)
}

function codes(problems) {
  return problems.map(problem => `${problem.level}:${problem.code}`)
}

test('容量边界：正好写满不报；超出先自动缩小（警告），缩到下限仍放不下即错误', () => {
  const [cap] = front.textCapacity('h-left-stack', 'statement').filter(item => item.field === 'main')
  const exact = '国'.repeat(cap.max_chars)
  assert.deepEqual(problemsOf('h-left-stack', [{ id: 'a', type: 'text', name: 'a', visible: true, opacity: 1, role: 'statement', fields: { main: exact } }], H), [])
  const slightly = '国'.repeat(cap.max_chars + 2)
  assert.deepEqual(codes(problemsOf('h-left-stack', [{ id: 'a', type: 'text', name: 'a', visible: true, opacity: 1, role: 'statement', fields: { main: slightly } }], H)), ['warning:text_scaled'])
  const far = '国'.repeat(cap.max_chars * 3)
  assert.deepEqual(codes(problemsOf('h-left-stack', [{ id: 'a', type: 'text', name: 'a', visible: true, opacity: 1, role: 'statement', fields: { main: far } }], H)), ['error:text_overflow'])
})

test('数字与紧随单位不拆行，短语优先断行与手动换行', () => {
  // 「207年11月14日」整体不拆；贪心断在它前面
  assert.deepEqual(front.wrapTemplateText('公元前207年11月14日', 8), ['公元前', '207年11月14日'])
  assert.deepEqual(front.wrapTemplateText('十五年，一个词失效了', 7, 0, 'phrase'), ['十五年，', '一个词失效了'])
  assert.deepEqual(front.wrapTemplateText('十五年\n大秦亡', 10), ['十五年', '大秦亡'])
})

const layer = (id, role, fields, extra = {}) => ({ id, type: 'text', name: id, visible: true, opacity: 1, role, fields, ...extra })

test('同屏：不同区可共存；同区（标题与说明）冲突；同拍文字重复是错误，相邻拍重复只警告', () => {
  const date = layer('date', 'date', { main: '公元前207年', sub: '咸阳' })
  const heading = layer('heading', 'heading', { main: '皇帝失效' })
  const statement = layer('statement', 'statement', { main: '这个称号只用了十五年。' })
  assert.deepEqual(codes(problemsOf('v-left-column', [heading, statement], V)), ['error:text_zone_conflict'])
  const sameBeat = layer('statement', 'statement', { main: '咸阳城门打开了' })
  const listed = layer('list', 'bullets', { items: ['咸阳城门打开了'] })
  // 分在两拍：只给相邻拍警告
  assert.deepEqual(codes(problemsOf('v-left-column', [sameBeat, listed], V, { beats: [['statement'], ['list']] })), ['warning:text_duplicate_adjacent'])
  // 同一图层内部字段重复不算（眉题与标题由同一作者把关）
  assert.deepEqual(problemsOf('v-left-column', [layer('h2', 'heading', { main: '咸阳', sub: '咸阳' })], V), [])
  // 同拍不同框重复：日期框的眉注「咸阳」与关键词框完全相同
  const same = problemsOf('v-left-column', [date, layer('kw', 'keyword', { main: '咸阳' })], V)
  assert.deepEqual(codes(same), ['error:text_duplicate_same_beat'])
})

test('字段规则：引文必须成对引号；必填缺失；Poster 专用类型不能进视频；套与画幅不符', () => {
  assert.deepEqual(codes(problemsOf('h-left-stack', [layer('q', 'quote', { main: '王侯将相宁有种乎', sub: '陈胜' })], H)), ['error:text_field_pattern'])
  assert.deepEqual(codes(problemsOf('h-left-stack', [layer('q', 'quote', { main: '“王侯将相宁有种乎”' })], H)), ['error:text_field_missing'])
  assert.deepEqual(codes(problemsOf('h-left-stack', [layer('p', 'poster_title', { main: '关沟咽喉' })], H)), ['error:text_role_medium'])
  assert.deepEqual(codes(problemsOf('h-left-stack', [layer('d', 'date', { main: '明代' })], V)), ['error:text_layout_aspect_mismatch'])
  assert.deepEqual(codes(front.textLayerProblems({ ...docFor(undefined, [layer('d', 'date', { main: '明代' })]) }, H)), ['error:text_layout_missing'])
  // 说明句里两处以上并列必须改成列表；一处并列仍是一句话
  assert.deepEqual(codes(problemsOf('h-left-stack', [layer('s', 'statement', { main: '条石为基、青砖包砌、顶宽五马并行' })], H)), ['error:text_statement_parallel'])
  assert.deepEqual(problemsOf('h-left-stack', [layer('s', 'statement', { main: '条石为基、青砖包砌。' })], H), [])
})

test('Poster 变量绑定：栏目名取项目名变量，项目改名后文字跟着变', () => {
  const doc = docFor('p-landscape-left', [layer('p', 'poster_project', { main: '占位' }, { field_vars: { main: 'project_title', sub: 'episode_no' } })])
  const variables = { project_title: '八达岭长城', episode_title: '关沟', episode_no: '第1集' }
  assert.deepEqual(front.textLayerTexts(doc.layers[0], variables), ['八达岭长城', '第1集'])
})

test('文本框是画面坐标：取景框推近时文字位置与字号不变', () => {
  const doc = docFor('h-left-stack', [layer('d', 'date', { main: '明代' })], { path: 'x.png', width: 1920, height: 1080 })
  const wide = frontSvg(doc, H)
  const zoomed = frontSvg(doc, H, { viewport: { x: 0.2, y: 0.2, w: 0.5, h: 0.5 } })
  const inner = svg => svg.slice(svg.indexOf('viewBox="0 0 1920 1080" preserveAspectRatio="none"'))
  assert.equal(inner(zoomed), inner(wide))
  assert.notEqual(zoomed, wide)
})
