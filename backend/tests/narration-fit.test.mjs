/**
 * 旁白与画面的时长/音轨匹配纯函数（Issue #31）。
 * 与 narration-state.test.mjs 同一套 tsx 入口做法（模块间以 .js 后缀互相引用）。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
const entry = join(mkdtempSync(join(tmpdir(), 'huobao-fit-')), 'entry.mts')
writeFileSync(entry, `
import * as fit from '${backendRoot}src/services/narration-fit.ts'

const api = fit as unknown as Record<string, (...args: any[]) => unknown>
const [name, args] = JSON.parse(process.env.FIT_INPUT!)
if (name === 'constants') {
  process.stdout.write(JSON.stringify({
    MIN_TEMPO: fit.MIN_TEMPO, MAX_TEMPO: fit.MAX_TEMPO,
    MAX_PAD_SECONDS: fit.MAX_PAD_SECONDS, DEFAULT_BED_GAIN_DB: fit.DEFAULT_BED_GAIN_DB,
    DEFAULT_COMPOSE_FIT: fit.DEFAULT_COMPOSE_FIT, DEFAULT_FIT_RECORD: fit.DEFAULT_FIT_RECORD,
  }))
} else {
  process.stdout.write(JSON.stringify(api[name](...args) ?? null))
}
`)

const tsxBin = join(backendRoot, 'node_modules', '.bin', 'tsx')
function call(name, ...args) {
  const out = execFileSync(tsxBin, [entry], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, FIT_INPUT: JSON.stringify([name, args]) },
  })
  return JSON.parse(out)
}

const C = call('constants')
const resolve = (over = {}) => call('resolveComposeFit', {
  episodeDefault: null, shotFit: null, episodeMixMode: null, episodeBedGainDb: null,
  da: null, availSeconds: 10, videoHasAudio: true, ...over,
})

test('默认等价于 #30：替代模式 + 尾部留白 0.8 秒 + 不变速', () => {
  const fit = resolve()
  assert.equal(fit.mode, 'pad')
  assert.equal(fit.padHeadSeconds, 0)
  assert.ok(Math.abs(fit.padTailSeconds - 0.8) < 1e-9)
  assert.equal(fit.tempo, 1)
  assert.equal(fit.audioMixMode, 'replace')
  assert.equal(fit.bedGainDb, C.DEFAULT_BED_GAIN_DB)
})

test('留白位置：放前面时起播点后移，总时长不变', () => {
  const head = resolve({ shotFit: JSON.stringify({ mode: 'pad', pad_ms: 800, pad_position: 'head' }) })
  const tail = resolve({ shotFit: JSON.stringify({ mode: 'pad', pad_ms: 800, pad_position: 'tail' }) })
  const planHead = call('planCompose', { dv: 12, da: 8, t: 0, fit: head })
  const planTail = call('planCompose', { dv: 12, da: 8, t: 0, fit: tail })
  assert.ok(Math.abs(planHead.narrationStart - 0.8) < 1e-9)
  assert.equal(planTail.narrationStart, 0)
  assert.ok(Math.abs(planHead.d - planTail.d) < 1e-9)
})

test('留白位置叠加转场 T：起播点 = T + 头部留白', () => {
  const head = resolve({ shotFit: JSON.stringify({ mode: 'pad', pad_ms: 800, pad_position: 'head' }) })
  const plan = call('planCompose', { dv: 12, da: 6, t: 3, fit: head })
  assert.ok(Math.abs(plan.narrationStart - 3.8) < 1e-9)
})

test('倍速模式：差距 20% 时自动取正好贴合的倍率 ≈1.20', () => {
  const fit = resolve({ shotFit: JSON.stringify({ mode: 'tempo' }), da: 9.6, availSeconds: 8 })
  assert.ok(Math.abs(fit.tempo - 1.2) < 1e-6)
  const plan = call('planCompose', { dv: 8, da: 9.6, t: 0, fit })
  assert.ok(Math.abs(plan.daScaled - 8) < 1e-6)
  assert.equal(plan.blocked, false)
})

test('30% 闸：恰好 30% 允许，30.1% 阻断为 narration_gap_too_large', () => {
  const ok = resolve({ shotFit: JSON.stringify({ mode: 'tempo' }), da: 13, availSeconds: 10 })
  assert.equal(call('planCompose', { dv: 10, da: 13, t: 0, fit: ok }).blocked, false)

  const bad = resolve({ shotFit: JSON.stringify({ mode: 'tempo' }), da: 13.01, availSeconds: 10 })
  const plan = call('planCompose', { dv: 10, da: 13.01, t: 0, fit: bad })
  assert.equal(plan.blocked, true)
  assert.equal(plan.blockReason, 'narration_gap_too_large')
  assert.ok(plan.gapRatio > 0.3)
})

test('过短方向（−35%）不阻断：倍率钳到 1/1.3，余量走留白', () => {
  const fit = resolve({ shotFit: JSON.stringify({ mode: 'tempo' }), da: 6.5, availSeconds: 10 })
  assert.ok(Math.abs(fit.tempo - C.MIN_TEMPO) < 1e-6)
  const plan = call('planCompose', { dv: 10, da: 6.5, t: 0, fit })
  assert.equal(plan.blocked, false)
  assert.ok(plan.gapRatio < -0.3)
})

test('倍速越界被拒绝，留白越界被拒绝', () => {
  assert.equal(call('validateFitRecord', { mode: 'tempo', tempo_override: 1.31 }) === null, false)
  assert.equal(call('validateFitRecord', { mode: 'tempo', tempo_override: 0.7 }) === null, false)
  assert.equal(call('validateFitRecord', { mode: 'tempo', tempo_override: 1.3 }), null)
  assert.equal(call('validateFitRecord', { mode: 'pad', pad_ms: 3001 }) === null, false)
  assert.equal(call('validateFitRecord', { mode: 'pad', pad_ms: 3000 }), null)
})

test('手调倍率后旁白仍放不下 → 阻断，绝不截断语音', () => {
  const fit = resolve({
    shotFit: JSON.stringify({ mode: 'tempo', tempo_override: 1.0 }),
    da: 9.6,
    availSeconds: 8,
  })
  assert.equal(fit.tempo, 1)
  const plan = call('planCompose', { dv: 8, da: 9.6, t: 0, fit })
  assert.equal(plan.blocked, true)
  // 差距只有 20%（在 30% 闸内），但手调成 1.0 后旁白放不下 → 按「放不下」阻断
  assert.equal(plan.blockReason, 'narration_too_long')
})

test('音轨模式：镜级覆盖优先于集级，底音增益可按集设置', () => {
  assert.equal(resolve({ episodeMixMode: 'mix' }).audioMixMode, 'mix')
  assert.equal(resolve({
    episodeMixMode: 'mix',
    shotFit: JSON.stringify({ mode: 'pad', audio_mix_mode: 'replace' }),
  }).audioMixMode, 'replace')
  assert.equal(resolve({ episodeMixMode: 'mix', episodeBedGainDb: -12 }).bedGainDb, -12)
})

test('继承：镜级为空时取集级默认', () => {
  const fit = resolve({ episodeDefault: JSON.stringify({ mode: 'pad', pad_ms: 1500, pad_position: 'head' }) })
  assert.ok(Math.abs(fit.padHeadSeconds - 1.5) < 1e-9)
  assert.equal(fit.padTailSeconds, 0)
})

test('签名键只收录真正影响产出的参数：有旁白时留白变化即失效', () => {
  const a = resolve({ da: 8 })
  const b = resolve({ da: 8, shotFit: JSON.stringify({ mode: 'pad', pad_ms: 1200, pad_position: 'tail' }) })
  assert.notEqual(a.key, b.key)
})

test('纯画面镜头的留白/倍速不进签名键，改它们不该让成片过期', () => {
  const a = resolve({ da: null })
  const b = resolve({ da: null, shotFit: JSON.stringify({ mode: 'tempo', pad_ms: 2500, pad_position: 'head' }) })
  assert.equal(a.key, b.key)
})

test('源视频没有音轨时混音降级为替代，签名键与替代模式一致', () => {
  const downgraded = resolve({ da: 8, episodeMixMode: 'mix', videoHasAudio: false })
  assert.equal(downgraded.audioMixMode, 'replace')
  assert.equal(downgraded.key, resolve({ da: 8 }).key)
  // 有音轨时混音照常生效，且与替代模式签名不同
  const mixed = resolve({ da: 8, episodeMixMode: 'mix', videoHasAudio: true })
  assert.equal(mixed.audioMixMode, 'mix')
  assert.notEqual(mixed.key, downgraded.key)
})

test('建议字数按可用时长算，受 TTS 单段 80 字上限约束', () => {
  assert.equal(call('suggestedCharsForAvail', 10), 51)
  assert.equal(call('suggestedCharsForAvail', 60), 80)
  assert.equal(call('suggestedCharsForAvail', 0), 0)
})

test('parseFitRecord 对损坏/非法输入安全回退', () => {
  assert.equal(call('parseFitRecord', '{ broken'), null)
  assert.equal(call('parseFitRecord', null), null)
  assert.deepEqual(call('parseFitRecord', '{"mode":"nonsense"}'), { mode: 'pad' })
})
