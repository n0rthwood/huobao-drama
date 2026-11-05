/**
 * 视频输入签名的行为测试（Issue #12）：分项摘要、历史任务重算、缺字段 → null、变化原因。
 * 纯函数在 TS 里，用仓库自带的 tsx 跑一个临时 .mts 入口并以 JSON 回传结果（不碰数据库）。
 * 入口必须是 .mts 文件：storyboard-video.ts 间接引入的 db/index.ts 含顶层 await，`tsx --eval` 会按 CJS 失败。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
const entry = join(mkdtempSync(join(tmpdir(), 'huobao-video-sig-')), 'entry.mts')
writeFileSync(entry, `
import {
  computeVideoSignature,
  describeSignatureDiff,
  videoSignatureFromTask,
  assertGeneratedSegmentDuration,
} from '${backendRoot}src/services/storyboard-video.ts'

const [kind, payload] = JSON.parse(process.env.SIG_INPUT!)
const out = kind === 'request'
  ? computeVideoSignature(payload)
  : kind === 'task'
    ? videoSignatureFromTask(payload)
    : kind === 'duration'
      ? (() => { try { assertGeneratedSegmentDuration(...payload); return { valid: true } } catch (error) { return { valid: false, error: error.message } } })()
      : describeSignatureDiff(payload[0], payload[1])
process.stdout.write('@@' + JSON.stringify(out))
`)

function run(kind, payload) {
  const out = execFileSync('npx', ['tsx', entry], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, SQLITE_PATH: join(entry, '..', 'test.sqlite3'), SIG_INPUT: JSON.stringify([kind, payload]) },
  })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

const baseRequest = {
  prompt: '风格词，\n一只猴子做瑜伽',
  firstFrameUrl: 'data/images/aaa.png',
  midFrameUrl: 'data/images/bbb.png',
  midFrameTime: 3,
  lastFrameUrl: 'data/images/ccc.png',
  referenceImageUrls: ['data/images/aaa.png', 'data/images/ref1.png'],
  duration: 10,
  aspectRatio: '16:9',
  resolution: '1080p',
  provider: 'comfyui',
  model: 'minimax-h3',
}
const baseTask = {
  prompt: baseRequest.prompt,
  provider: 'comfyui',
  model: 'minimax-h3',
  params: JSON.stringify({
    firstFrameUrl: 'http://old-host/static/aaa.png',
    midFrameUrl: 'http://old-host/static/bbb.png',
    midFrameTime: 3,
    lastFrameUrl: 'http://old-host/static/ccc.png',
    referenceImageUrls: ['http://old-host/static/aaa.png', 'http://old-host/static/ref1.png'],
    duration: 10,
    aspectRatio: '16:9',
    resolution: '1080p',
  }),
}

test('same inputs match a historical task; signature only depends on file names', () => {
  const request = run('request', baseRequest)
  const task = run('task', baseTask)
  assert.equal(task.signature, request.signature)
  assert.deepEqual(task.parts, request.parts)
})

test('每个分项的变化都会改变总签名，并能报出变化原因', () => {
  const base = run('request', baseRequest)
  const cases = [
    ['提示词', { ...baseRequest, prompt: '风格词，\n一只猴子举哑铃' }],
    ['关键帧', { ...baseRequest, firstFrameUrl: 'data/images/zzz.png' }],
    ['关键帧', { ...baseRequest, midFrameTime: 4 }],
    ['参考图', { ...baseRequest, referenceImageUrls: ['data/images/aaa.png', 'data/images/ref2.png'] }],
    ['时长/画幅', { ...baseRequest, duration: 8 }],
    ['模型', { ...baseRequest, model: 'other-model' }],
  ]
  for (const [label, input] of cases) {
    const next = run('request', input)
    assert.notEqual(next.signature, base.signature, `${label} 应改变签名`)
    assert.deepEqual(run('diff', [next.parts, base.parts]), [label])
  }
})

test('historical tasks missing comparison fields yield null (classified as unknown)', () => {
  assert.equal(run('task', { ...baseTask, prompt: null }), null)
  assert.equal(run('task', { ...baseTask, model: null }), null)
  // #5 之前的视频任务没有 firstFrameUrl
  assert.equal(run('task', { ...baseTask, params: JSON.stringify({ duration: 10, aspectRatio: '16:9' }) }), null)
  assert.equal(run('task', { ...baseTask, params: 'not json' }), null)
})

test('junction slot/hash changes only guides and survives exact persisted task fields', () => {
  const legacy = run('request', baseRequest)
  const junction = { slot: 'first', hash: 'junction-sha256' }
  const current = run('request', { ...baseRequest, junction })
  assert.notEqual(current.signature, legacy.signature)
  assert.deepEqual(run('diff', [current.parts, legacy.parts]), ['关键帧'])
  const task = { ...baseTask, params: JSON.stringify({ ...JSON.parse(baseTask.params), junction_hash: junction.hash, junction_slot: junction.slot }) }
  assert.deepEqual(run('task', task), current)
  assert.notEqual(run('request', { ...baseRequest, junction: { ...junction, hash: 'new' } }).signature, current.signature)
  assert.equal(run('request', { ...baseRequest, junction: null }).signature, legacy.signature)
})

test('generated segment duration includes transition overhead rather than adapter clamping', () => {
  assert.equal(run('duration', [12, 15, 3]).valid, true)
  assert.equal(run('duration', [15, 15, 3]).valid, false)
  assert.equal(run('duration', [15, 18, 3]).valid, false)
  assert.equal(run('duration', [15, 15, 0]).valid, true)
  assert.equal(run('duration', [16, 16, 0]).valid, false)
})
