/**
 * Poster 文字图层（Issue #39）：后端 TS 规则与前端同源实现逐例对照。
 * 布局归一化决定服务端保存的排版、前端合成与二次生成文字说明，前后端必须一致。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizePosterLayout as normalizeInFrontend,
  resolveTexts as resolveTextsInFrontend,
} from '../../frontend/app/utils/posterLayout.js'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function call(fn, args) {
  const script = `
    import { normalizePosterLayout, resolveTexts, buildPosterTextInstruction } from './src/services/poster-layout.ts'
    const api = { normalizePosterLayout, resolveTexts, buildPosterTextInstruction }
    const [fn, calls] = JSON.parse(process.env.POSTER_INPUT)
    process.stdout.write('@@' + JSON.stringify(calls.map(callArgs => api[fn](...callArgs))))
  `
  const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, POSTER_INPUT: JSON.stringify([fn, args]) },
  })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

const RAW_LAYOUT = {
  texts: [
    {
      kind: 'episode_no',
      text: '这段内容必须被清空',
      x: 2,
      y: -1,
      width: 0.5,
      fontSize: 0.001,
      fontFamily: 'unknown-font',
      color: '',
      bold: false,
      italic: true,
      strokeWidth: 1,
      align: 'diagonal',
    },
    { id: 'title', kind: 'project_title', x: 0.2, y: 0.1, fontSize: 0.1, color: '#00ff00' },
    { kind: 'unknown', text: '  普通文本  ', x: '0.3', y: 0.4 },
    null,
    'not-a-box',
  ],
}

const VARS = { project_title: '中俄纪录', episode_title: '利哈列夫远征', episode_no: 'EP01' }

test('normalizePosterLayout: 变量框清空、范围裁剪、默认值前后端一致', () => {
  const [backend, frontend] = [
    call('normalizePosterLayout', [[RAW_LAYOUT]])[0],
    normalizeInFrontend(RAW_LAYOUT),
  ]
  assert.deepEqual(backend, frontend)

  assert.equal(backend.texts.length, 3)
  assert.equal(backend.texts[0].text, '')
  assert.equal(backend.texts[0].x, 1)
  assert.equal(backend.texts[0].y, 0)
  assert.equal(backend.texts[0].fontSize, 0.02)
  assert.equal(backend.texts[0].fontFamily, 'sans')
  assert.equal(backend.texts[0].color, '#ffffff')
  assert.equal(backend.texts[0].strokeWidth, 0.12)
  assert.equal(backend.texts[0].align, 'center')
  assert.equal(backend.texts[1].id, 'title')
  assert.equal(backend.texts[2].kind, 'text')
  assert.equal(backend.texts[2].text, '普通文本')
  assert.equal(backend.texts[2].x, 0.3)
})

test('normalizePosterLayout: 非法输入退化为空布局', () => {
  for (const input of [null, 42, 'not json', { texts: 'nope' }]) {
    assert.deepEqual(call('normalizePosterLayout', [[input]])[0], { texts: [] })
    assert.deepEqual(normalizeInFrontend(input), { texts: [] })
  }
})

test('resolveTexts: 三个变量与普通文本按图层顺序渲染', () => {
  const layout = normalizeInFrontend({
    texts: [
      { kind: 'project_title', x: 0.1, y: 0.1 },
      { kind: 'episode_title', x: 0.1, y: 0.3 },
      { kind: 'episode_no', x: 0.1, y: 0.5 },
      { kind: 'text', text: '副标题', x: 0.1, y: 0.7 },
    ],
  })
  const expected = ['中俄纪录', '利哈列夫远征', 'EP01', '副标题']
  assert.deepEqual(resolveTextsInFrontend(layout, VARS), expected)
  assert.deepEqual(call('resolveTexts', [[layout, VARS]])[0], expected)
})

test('buildPosterTextInstruction: 只列必须原样呈现的文字，无文字返回空串', () => {
  const layout = normalizeInFrontend({
    texts: [
      { kind: 'project_title', x: 0.1, y: 0.1 },
      { kind: 'text', text: '引号"测试', x: 0.1, y: 0.3 },
    ],
  })
  const instruction = call('buildPosterTextInstruction', [[layout, VARS]])[0]
  const textElements = instruction.split('\n').slice(1).map(line => JSON.parse(line.slice(2)))
  assert.deepEqual(textElements, ['中俄纪录', '引号"测试'])
  assert.equal(call('buildPosterTextInstruction', [[{ texts: [] }, VARS]])[0], '')
})
