/**
 * Poster 文字图层前端规则（Issue #39）：归一化、变量渲染、字体栈与字号自适应。
 * 与后端 poster-layout.ts 同口径的行为由 backend/tests/poster-layout.test.mjs 对照。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizePosterLayout,
  resolveTexts,
  fitFontSize,
} from '../app/utils/posterLayout.js'

const VARS = { project_title: '中俄纪录', episode_title: '利哈列夫远征', episode_no: 'EP01' }

test('normalizePosterLayout: variable boxes drop content and clamp ranges', () => {
  const layout = normalizePosterLayout({
    texts: [
      { kind: 'episode_no', text: 'ignored', x: 2, fontSize: 0.001, strokeWidth: 1 },
      { id: 'title', kind: 'project_title', x: 0.25, y: 0.1 },
      { kind: 'text', text: '  副标题  ', x: '0.3' },
      null,
    ],
  })
  assert.equal(layout.texts.length, 3)
  assert.equal(layout.texts[0].text, '')
  assert.equal(layout.texts[0].x, 1)
  assert.equal(layout.texts[0].fontSize, 0.02)
  assert.equal(layout.texts[0].strokeWidth, 0.12)
  assert.equal(layout.texts[1].id, 'title')
  assert.equal(layout.texts[1].kind, 'project_title')
})

test('normalizePosterLayout: invalid input becomes empty layout', () => {
  for (const input of [null, 7, 'not-json', { texts: 'x' }]) {
    assert.deepEqual(normalizePosterLayout(input), { texts: [] })
  }
})

test('resolveTexts: renders all three variables in layer order', () => {
  const layout = normalizePosterLayout({
    texts: [
      { kind: 'episode_title', x: 0.1, y: 0.1 },
      { kind: 'text', text: '副标题' },
      { kind: 'episode_no' },
      { kind: 'project_title' },
    ],
  })
  assert.deepEqual(resolveTexts(layout, VARS), ['利哈列夫远征', '副标题', 'EP01', '中俄纪录'])
})


test('fitFontSize: shrinks until the line fits, never below 40%', () => {
  const measure = (text, size) => text.length * size
  assert.equal(fitFontSize(measure, '中俄纪录', 40, 1000), 40)
  const shrunk = fitFontSize(measure, '很长的标题文字', 40, 100)
  assert.ok(shrunk < 40)
  assert.ok(shrunk >= 16)
})
