import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('主题选择入口已移除：无 MapStylePicker 引用，需求表单只显示固定默认与历史记录', () => {
  assert.equal(existsSync(new URL('../app/map-studio/components/MapStylePicker.vue', import.meta.url)), false)
  const brief = read('../app/map-studio/components/MapBriefForm.vue')
  assert.ok(!brief.includes('MapStylePicker'), 'MapBriefForm 不得再引用主题选择器')
  assert.ok(!brief.includes('styleOption'), '需求表单不得渲染主题选项卡')
  assert.ok(brief.includes('styles.effectiveHint'), '需求表单应显示固定默认样式说明')
  assert.ok(brief.includes('styles.legacyTheme'), '历史主题只作记录展示')
  const settings = read('../app/map-studio/components/ModuleSettings.vue')
  assert.ok(!settings.includes('default_style'), '模块设置不得再提供默认主题编辑')
  assert.ok(!settings.includes('THEME_PRESETS'), '模块设置不得保留主题预设列表')
})

test('深链登记包含成图与 AI 活动键，且不含主题键', () => {
  const source = read('../app/composables/useQuerySync.ts')
  const block = source.slice(source.indexOf('export const DEEPLINK_KEYS'))
  assert.match(block, /mapStudioImage: \['mssnapshot', 'mspreview', 'mslayers'\]/)
  assert.match(block, /mapStudioActivity: \['msactivity'\]/)
  assert.ok(!/msstyle|mstheme/.test(block), '主题选择已移除，不得登记主题深链键')
})

test('深链恢复只还原界面状态：快照/视图工具不含任何请求调用', () => {
  for (const file of ['../app/map-studio/utils/mapSnapshot.ts', '../app/map-studio/utils/mapDock.ts']) {
    const source = read(file)
    assert.ok(!/\bfetch\(/.test(source), `${file} 不得发起请求`)
    assert.ok(!/\bapi\./.test(source), `${file} 不得调用业务 API`)
    assert.ok(!/localStorage|sessionStorage/.test(source), `${file} 不得承载持久业务写入`)
  }
  const page = read('../app/map-studio/pages/task.vue')
  assert.ok(page.includes('restoreMapSelection'), '主界面恢复选中版本应走只读恢复工具')
})

test('四语 locale 均提供成图尺寸与固定样式说明键', () => {
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const data = JSON.parse(read(`../app/locales/${lang}.json`))
    const image = data.mapStudio?.image
    assert.ok(image && typeof image.size === 'string', `${lang} 缺少 mapStudio.image.size`)
    assert.ok(!image.size.includes('{w}') && !image.size.includes('{h}'), `${lang} 的 image.size 是标签，不应带占位符`)
    const resultsSize = data.mapStudio.results?.size
    assert.ok(resultsSize && resultsSize.includes('{w}') && resultsSize.includes('{h}'), `${lang} 缺少 results.size 值模板`)
    assert.ok(typeof data.mapStudio.styles?.effectiveHint === 'string', `${lang} 缺少 styles.effectiveHint`)
    assert.ok(typeof data.mapStudio.styles?.legacyTheme === 'string', `${lang} 缺少 styles.legacyTheme`)
  }
})
