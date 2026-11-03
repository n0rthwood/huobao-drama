/**
 * 图层编辑器（Issue #48）结构验收：编辑能力、同源渲染、演示页只进 dev 构建。
 * 渲染口径本身由 backend/tests/layer-svg.test.mjs 前后端逐例对照，这里只盯接线。
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')

test('画布用同源 layerDocToSvg 出画，不自己画一套', () => {
  const canvas = read('app/components/LayerCanvas/LayerCanvas.vue')
  assert.match(canvas, /import \{ baseFilterLayers, layerBounds, layerDocToSvg \} from '~\/utils\/layerSvg'/)
  assert.match(canvas, /layerDocToSvg\(props\.doc, \{ width: docWidth\.value, height: docHeight\.value \}/)
  assert.match(canvas, /v-html="svgMarkup"/)
  // 底图地址必须过 mediaUrl（子路径部署），字体走后端打包字体
  assert.match(canvas, /import \{ apiBase, mediaUrl \} from '~\/utils\/url'/)
  assert.match(canvas, /layer-docs\/fonts\//)
  assert.match(canvas, /font-family:'\$\{family\}'/)
})

test('画布具备 Q3 确认的编辑能力：选择/框选、拖动、八向缩放、旋转、吸附、键盘', () => {
  const canvas = read('app/components/LayerCanvas/LayerCanvas.vue')
  assert.match(canvas, /const HANDLE_KEYS = \['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'\]/)
  assert.match(canvas, /function startResize\(/)
  assert.match(canvas, /function startRotate\(/)
  assert.match(canvas, /function snapDelta\(/)
  assert.match(canvas, /mode: 'marquee'/)
  assert.match(canvas, /mode: 'pan'/)
  assert.match(canvas, /arrowleft: \[-step, 0\]/)
  assert.match(canvas, /key === 'delete' \|\| key === 'backspace'/)
  assert.match(canvas, /emit\(event\.shiftKey \? 'redo' : 'undo'\)/)
  // 锁定图层不能被拖动
  assert.match(canvas, /if \(layer\.locked\) return/)
  // 不做钢笔/模板市场（#48「明确不做」）
  assert.doesNotMatch(canvas, /pen-tool|钢笔|模板市场/)
})

test('图层列表给出 z 序拖拽、显隐、锁定、重命名与增删', () => {
  const list = read('app/components/LayerCanvas/LayerList.vue')
  assert.match(list, /draggable="true"/)
  assert.match(list, /@drop\.prevent="onDrop\(index\)"/)
  assert.match(list, /props\.doc\.layers\.length - 1 - displayIndex/)
  assert.match(list, /toggle\(layer, 'visible'\)/)
  assert.match(list, /toggle\(layer, 'locked'\)/)
  assert.match(list, /function commitRename\(/)
  assert.match(list, /const LAYER_TYPES = \['polygon', 'polyline', 'marker', 'label', 'card', 'image'\]/)
})

test('样式面板按类型分支，并用同源主题预设兜底', () => {
  const style = read('app/components/LayerCanvas/LayerStyle.vue')
  assert.match(style, /import \{ THEME_PRESETS, unsupportedChars \} from '~\/utils\/layerSvg'/)
  assert.match(style, /return THEME_PRESETS\[props\.doc\.theme\]\[props\.layer\.type\]\[key\]/)
  for (const type of ['polygon', 'polyline', 'marker', 'label', 'card']) {
    assert.match(style, new RegExp(`layer\\.type === '${type}'`), `缺少 ${type} 样式分支`)
  }
  // 底图风格化（父 Issue Q1 的确定性滤镜）在文档区
  for (const key of ['tint', 'tintStrength', 'paper', 'vignette']) {
    assert.match(style, new RegExp(`layerCanvas\\.style\\.${key}`), `缺少风格化字段 ${key}`)
  }
  // 打包字体覆盖不到的字符要当场提示（服务端会 400）
  assert.match(style, /missingChars/)
})

test('useLayerDoc：撤销栈 ≤100、300ms 防抖保存、人工移动解除语义锚点', () => {
  const composable = read('app/composables/useLayerDoc.ts')
  assert.match(composable, /const HISTORY_LIMIT = 100/)
  assert.match(composable, /const SAVE_DELAY_MS = 300/)
  assert.match(composable, /if \(past\.value\.length > HISTORY_LIMIT\) past\.value\.shift\(\)/)
  assert.match(composable, /setTimeout\(\(\) => onSave\(JSON\.parse\(JSON\.stringify\(doc\.value\)\)\), SAVE_DELAY_MS\)/)
  assert.match(composable, /layer\.anchor\.detached = true/)
  assert.match(composable, /doc\.value\.layers\.forEach\(\(layer, index\) => \{ layer\.z = index \}\)/)
})

test('演示页加载示例文档并能对照服务端渲染；只在 dev 构建注册', () => {
  const page = read('app/pages/dev/layer-canvas.vue')
  for (const id of ['dzungar', 'irtysh', 'zaysan', 'label-dzungar', 'card-lihalev', 'portrait']) {
    assert.match(page, new RegExp(`id: '${id}'`), `示例文档缺少 ${id}`)
  }
  assert.match(page, /\$\{apiBase\(\)\}\/layer-docs\/render/)
  assert.match(page, /X-Render-Ms/)

  const config = read('nuxt.config.ts')
  assert.match(config, /pages\[index\]\.path\.startsWith\('\/dev\/'\)/)
  assert.match(config, /process\.env\.NODE_ENV === 'production'/)
})

test('四语文案齐备且键结构一致', () => {
  const locales = ['zh', 'en', 'ja', 'ko'].map(lang => JSON.parse(read(`app/locales/${lang}.json`)).layerCanvas)
  const flatten = (value, prefix = '') => Object.entries(value).flatMap(([key, item]) =>
    item && typeof item === 'object' ? flatten(item, `${prefix}${key}.`) : [`${prefix}${key}`])
  const base = flatten(locales[0]).sort()
  assert.ok(base.length > 60, `文案条数异常：${base.length}`)
  for (const locale of locales.slice(1)) assert.deepEqual(flatten(locale).sort(), base)
})

test('Poster 既有实现未被改动（#48 不迁移 Poster）', () => {
  const stage = read('app/components/PosterCanvasStage.vue')
  assert.match(stage, /drawPoster\(canvasEl\.value/)
  assert.doesNotMatch(stage, /layerSvg|LayerCanvas/)
})
