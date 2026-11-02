/**
 * Issue #37：配音参数弹窗 —— 生效参数优先级、弹窗参数合法化、批量「缺失 + 已变化」分类。
 * 纯函数走 tsx 入口真实调用（与 narration-ux.test.mjs 同一套做法）。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
const entry = join(mkdtempSync(join(tmpdir(), 'huobao-nvp-')), 'entry.mts')
writeFileSync(entry, `
import * as params from '${backendRoot}src/services/narration-voice-params.ts'
import { sha256 } from '${backendRoot}src/services/narration.ts'

const api = { ...params, sha256 } as unknown as Record<string, (...args: any[]) => unknown>
const [name, args] = JSON.parse(process.env.NVP_INPUT!)
try {
  process.stdout.write(JSON.stringify({ ok: api[name](...args) ?? null }))
} catch (err) {
  process.stdout.write(JSON.stringify({ error: (err as Error).message }))
}
`)
const tsxBin = join(backendRoot, 'node_modules', '.bin', 'tsx')
function call(name, ...args) {
  const out = JSON.parse(execFileSync(tsxBin, [entry], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, NVP_INPUT: JSON.stringify([name, args]) },
  }))
  if ('error' in out) throw new Error(out.error)
  return out.ok
}

const CONFIG = { voice: '纪录片·沉稳男声', seed: 1720, instructions: '低沉克制', cfgValue: null, inferenceTimesteps: null }
const DESIRED = { voice: '纪录片·沉稳男声', inference_timesteps: 10, cfg_value: 2, seed: 1720, instructions: '低沉克制', normalize: true }
const TEXT = '1720年初，三方势力在这片草原上交汇。'

test('生效参数：集级 → TTS 配置 → VoxCPM 默认；规范化镜级覆盖优先', () => {
  const fromConfig = call('resolveVoiceParams', { episodeSettings: {}, configSettings: CONFIG, episodeNormalize: true, shotNormalize: null })
  assert.deepEqual(fromConfig, { ...DESIRED, normalize: true }, '配置没填的步数/cfg 用 VoxCPM 默认 10 / 2.0')

  const episode = call('parseEpisodeVoiceSettings', JSON.stringify({ voice: '新闻·男主播', inference_timesteps: 30, seed: null, instructions: '' }))
  const fromEpisode = call('resolveVoiceParams', { episodeSettings: episode, configSettings: CONFIG, episodeNormalize: true, shotNormalize: false })
  assert.equal(fromEpisode.voice, '新闻·男主播')
  assert.equal(fromEpisode.inference_timesteps, 30)
  assert.equal(fromEpisode.cfg_value, 2, '集级没存 cfg → 配置也没填 → 默认')
  assert.equal(fromEpisode.seed, null, '集级显式选了随机，不回落到配置的 1720')
  assert.equal(fromEpisode.instructions, '', '集级显式清空风格描述')
  assert.equal(fromEpisode.normalize, false, '镜级覆盖优先于集级')
})

test('弹窗参数合法化：范围钳制、音色必须在列表里、seed 非负整数或随机', () => {
  const ok = call('sanitizeVoiceSettings', { voice: '新闻·男主播', inference_timesteps: 99, cfg_value: 0.2, seed: '', instructions: '  平稳 ', normalize: true }, ['新闻·男主播'])
  assert.deepEqual(ok, { voice: '新闻·男主播', inference_timesteps: 30, cfg_value: 1, seed: null, instructions: '平稳', normalize: true })
  assert.throws(() => call('sanitizeVoiceSettings', { voice: '不存在的音色' }, ['新闻·男主播']), /音色不存在/)
  assert.throws(() => call('sanitizeVoiceSettings', { voice: '' }, null), /请选择音色/)
  assert.throws(() => call('sanitizeVoiceSettings', { voice: 'a', seed: -3 }, null), /seed/)
})

test('批量分类：缺失 / 文本改过 / 参数不同 / 未变化 / 跳过', () => {
  const textSha = call('sha256', TEXT)
  const audio = { duration_ms: 9000, chars: 18, voice: DESIRED.voice, seed: 1720, job_id: 'j', provider: 'voxcpm', config_id: 13, generated_at: 'x', text_sha256: textSha, params: DESIRED }
  const base = { narrationEnabled: true, text: TEXT, blocked: false, audio, desired: DESIRED, configSettings: CONFIG }
  assert.equal(call('classifyVoiceShot', { ...base, audio: undefined }), 'missing')
  assert.equal(call('classifyVoiceShot', base), 'unchanged')
  assert.equal(call('classifyVoiceShot', { ...base, text: `${TEXT}补一句。` }), 'changed', '旁白原文改过')
  assert.equal(call('classifyVoiceShot', { ...base, desired: { ...DESIRED, voice: '新闻·男主播' } }), 'changed', '换音色')
  assert.equal(call('classifyVoiceShot', { ...base, desired: { ...DESIRED, inference_timesteps: 30 } }), 'changed', '换步数')
  assert.equal(call('classifyVoiceShot', { ...base, desired: { ...DESIRED, normalize: false } }), 'changed', '换规范化')
  assert.equal(call('classifyVoiceShot', { ...base, narrationEnabled: false }), 'skipped')
  assert.equal(call('classifyVoiceShot', { ...base, text: '  ' }), 'skipped')
  assert.equal(call('classifyVoiceShot', { ...base, blocked: true }), 'skipped')
})

test('随机 seed 比较的是所选值：随机 = 随机视为未变化', () => {
  const random = { ...DESIRED, seed: null }
  const audio = { duration_ms: 1, chars: 1, voice: DESIRED.voice, seed: null, job_id: null, provider: 'voxcpm', config_id: 13, generated_at: 'x', text_sha256: call('sha256', TEXT), params: random }
  assert.equal(call('classifyVoiceShot', { narrationEnabled: true, text: TEXT, blocked: false, audio, desired: random, configSettings: CONFIG }), 'unchanged')
})

test('存量音频（没有 params）按当时事实重建：从未发送规范化', () => {
  const legacy = { duration_ms: 9000, chars: 18, voice: DESIRED.voice, seed: 1720, job_id: 'j', provider: 'voxcpm', config_id: 13, generated_at: 'x', text_sha256: call('sha256', TEXT) }
  const rebuilt = call('paramsOfAudio', legacy, CONFIG)
  assert.deepEqual(rebuilt, { ...DESIRED, normalize: false })
  const base = { narrationEnabled: true, text: TEXT, blocked: false, audio: legacy, configSettings: CONFIG }
  assert.equal(call('classifyVoiceShot', { ...base, desired: { ...DESIRED, normalize: false } }), 'unchanged', '参数一致的老配音不重配')
  assert.equal(call('classifyVoiceShot', { ...base, desired: DESIRED }), 'changed', '开启规范化后老配音算已变化')
})

test('RTF 与 Studio 一致：预设点取实测值，中间线性插值，越界取端点', () => {
  assert.equal(call('rtfForSteps', 4), 0.35)
  assert.equal(call('rtfForSteps', 10), 0.49)
  assert.equal(call('rtfForSteps', 30), 0.93)
  assert.ok(Math.abs(call('rtfForSteps', 20) - 0.71) < 1e-9)
  assert.equal(call('rtfForSteps', 2), 0.35)
})

test('音色分组：我的音色在前，预置按分类聚合并按创建时间排序', () => {
  const grouped = call('groupVoices', [
    { name: '男性旁白', tags: ['设计音色'], created_at: '3' },
    { name: '新闻·女主播', tags: ['预置', '新闻播报'], created_at: '2' },
    { name: '纪录片·沉稳男声', tags: ['预置', '纪录片旁白'], created_at: '1' },
    { name: '新闻·男主播', tags: ['预置', '新闻播报'], created_at: '0' },
  ])
  assert.deepEqual(grouped, [
    { name: '男性旁白', group: '我的音色' },
    { name: '新闻·男主播', group: '预置 · 新闻播报' },
    { name: '新闻·女主播', group: '预置 · 新闻播报' },
    { name: '纪录片·沉稳男声', group: '预置 · 纪录片旁白' },
  ])
})
