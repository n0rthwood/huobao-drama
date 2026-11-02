/**
 * 旁白状态机、阻断码与合成时长计划（Issue #30 / #31 的纯函数）。
 * 这些模块以 `.js` 后缀互相引用，裸 node 的类型剥离解析不了，所以沿用
 * transition-timing.test.mjs 的做法：用仓库自带的 tsx 跑一个临时 .mts 入口，JSON 回传。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
const entry = join(mkdtempSync(join(tmpdir(), 'huobao-narration-')), 'entry.mts')
writeFileSync(entry, `
import * as narration from '${backendRoot}src/services/narration.ts'
import * as fit from '${backendRoot}src/services/narration-fit.ts'

const api: Record<string, (...args: any[]) => unknown> = { ...narration, ...fit } as never
const [name, args] = JSON.parse(process.env.NARRATION_INPUT!)
if (name === 'constants') {
  process.stdout.write(JSON.stringify({
    MAX_NARRATION_CHARS: narration.MAX_NARRATION_CHARS,
    MIN_SHOT_SECONDS: narration.MIN_SHOT_SECONDS,
    MAX_SHOT_SECONDS: narration.MAX_SHOT_SECONDS,
    DEFAULT_COMPOSE_FIT: fit.DEFAULT_COMPOSE_FIT,
  }))
} else {
  process.stdout.write(JSON.stringify(api[name](...args) ?? null))
}
`)

// 直接用本地 tsx 二进制：npx 每次调用都要解析一次包，整套测试并发跑时会互相拖慢甚至超时
const tsxBin = join(backendRoot, 'node_modules', '.bin', 'tsx')

function call(name, ...args) {
  const out = execFileSync(tsxBin, [entry], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, NARRATION_INPUT: JSON.stringify([name, args]) },
  })
  return JSON.parse(out)
}

const C = call('constants')
const FIT = C.DEFAULT_COMPOSE_FIT
const TEXT = '一七二〇年，清、准、俄三方，都在这片草原上押下重注。'
const TEXT_SHA = call('sha256', TEXT)

const metaWithAudio = (sha, durationMs = 9000) => ({
  text_sha256: sha,
  audio: {
    duration_ms: durationMs,
    chars: 25,
    voice: '纪录片·沉稳男声',
    seed: null,
    job_id: 'job-1',
    provider: 'voxcpm',
    config_id: 12,
    generated_at: '2026-11-01 00:00:00',
    text_sha256: sha,
  },
})

test('字数统计忽略空白，预计时长按 4.5 字/秒', () => {
  assert.equal(call('narrationCharCount', ' 一 二 三 '), 3)
  assert.equal(call('estimateNarrationSeconds', '甲'.repeat(45)), 10)
  assert.equal(call('narrationCharCount', null), 0)
})

test('建议字数受语速与 TTS 单段上限双重约束', () => {
  assert.equal(call('suggestedCharsFor', 10), 51)
  // 15 秒按 5.1 字/秒 = 76 字，落在 TTS 单段 80 字上限内
  assert.equal(call('suggestedCharsFor', C.MAX_SHOT_SECONDS), 76)
  // 更长的时长被 TTS 单段上限截住
  assert.equal(call('suggestedCharsFor', 60), C.MAX_NARRATION_CHARS)
})

test('配音过期判定只看文本 sha256', () => {
  const meta = metaWithAudio(TEXT_SHA)
  assert.equal(call('isVoiceStale', TEXT, meta), false)
  assert.equal(call('isVoiceStale', TEXT + '改', meta), true)
  assert.equal(call('isVoiceStale', TEXT, {}), false)
})

test('开关关闭时状态恒为 disabled', () => {
  assert.equal(call('narrationStatus', {
    episodeNarrationEnabled: false,
    shotNarrationEnabled: true,
    narrationText: TEXT,
    narrationAudioUrl: 'static/narration/a.wav',
    meta: metaWithAudio(TEXT_SHA),
  }), 'disabled')
})

test('状态机：missing → text_only → voiced → voice_stale', () => {
  const base = { episodeNarrationEnabled: true, shotNarrationEnabled: true }
  assert.equal(call('narrationStatus', { ...base, narrationText: '', narrationAudioUrl: null, meta: {} }), 'missing')
  assert.equal(call('narrationStatus', { ...base, narrationText: TEXT, narrationAudioUrl: null, meta: {} }), 'text_only')
  assert.equal(call('narrationStatus', {
    ...base, narrationText: TEXT, narrationAudioUrl: 'static/narration/a.wav', meta: metaWithAudio(TEXT_SHA),
  }), 'voiced')
  assert.equal(call('narrationStatus', {
    ...base, narrationText: TEXT + '改', narrationAudioUrl: 'static/narration/a.wav', meta: metaWithAudio(TEXT_SHA),
  }), 'voice_stale')
})

test('阻断码：超 80 字 / 实测预算超 15 秒 / 配音过期', () => {
  const long = '甲'.repeat(C.MAX_NARRATION_CHARS + 1)
  const tooLong = call('narrationIssues', {
    episodeNarrationEnabled: true, shotNarrationEnabled: true, narrationText: long, meta: {},
  })
  assert.equal(tooLong.length, 1)
  assert.equal(tooLong[0].code, 'narration_too_long')
  assert.equal(tooLong[0].severity, 'block')

  const overBudget = call('narrationIssues', {
    episodeNarrationEnabled: true,
    shotNarrationEnabled: true,
    narrationText: TEXT,
    meta: metaWithAudio(TEXT_SHA, 14_500),
  })
  assert.equal(overBudget[0].code, 'narration_too_long')

  const stale = call('narrationIssues', {
    episodeNarrationEnabled: true,
    shotNarrationEnabled: true,
    narrationText: TEXT + '改',
    meta: metaWithAudio(TEXT_SHA),
  })
  assert.ok(stale.some(i => i.code === 'narration_voice_stale'))

  assert.deepEqual(call('narrationIssues', {
    episodeNarrationEnabled: false, shotNarrationEnabled: true, narrationText: long, meta: {},
  }), [])
  assert.deepEqual(call('narrationIssues', {
    episodeNarrationEnabled: true, shotNarrationEnabled: false, narrationText: long, meta: {},
  }), [])
})

test('回写时长 = clamp(ceil(Da + 尾部留白), 4, 15)，不含转场', () => {
  assert.equal(call('durationFromAudio', 9120), 10)
  assert.equal(call('durationFromAudio', 500), C.MIN_SHOT_SECONDS)
  assert.equal(call('durationFromAudio', 20_000), C.MAX_SHOT_SECONDS)
})

test('合成计划：画面短于目标时冻结末帧，长于目标时裁尾', () => {
  const short = call('planCompose', { dv: 8, da: 9.6, t: 0, fit: FIT })
  assert.ok(Math.abs(short.d - 10.4) < 1e-6)
  assert.ok(short.freezeSeconds > 2.3 && short.freezeSeconds < 2.5)
  assert.equal(short.trim, false)

  const long = call('planCompose', { dv: 15, da: 5, t: 0, fit: FIT })
  assert.ok(Math.abs(long.d - 5.8) < 1e-6)
  assert.equal(long.trim, true)
})

test('合成计划：转场偏移取 T，旁白起播点 = T；总时长封顶 15 秒', () => {
  const plan = call('planCompose', { dv: 15, da: 9.6, t: 3, fit: FIT })
  assert.equal(plan.narrationStart, 3)
  assert.ok(Math.abs(plan.d - 13.4) < 1e-6)
  assert.equal(plan.blocked, false)

  const capped = call('planCompose', { dv: 15, da: 14, t: 3, fit: FIT })
  assert.equal(capped.d, C.MAX_SHOT_SECONDS)
  // 旁白说完的时间点超过 15 秒 → 阻断，绝不截断语音
  assert.equal(capped.blocked, true)
  assert.equal(capped.blockReason, 'narration_too_long')
})

test('合成计划：极短旁白补到 4 秒下限；无旁白镜头画面原样', () => {
  assert.equal(call('planCompose', { dv: 6, da: 1.1, t: 0, fit: FIT }).d, C.MIN_SHOT_SECONDS)
  const silent = call('planCompose', { dv: 7.3, da: null, t: 3, fit: FIT })
  assert.equal(silent.d, 7.3)
  assert.equal(silent.narrationStart, 0)
  assert.equal(silent.blocked, false)
})

test('合成计划：差距比例按可用时长算，正=偏长 负=偏短', () => {
  const longer = call('planCompose', { dv: 8, da: 9.6, t: 0, fit: FIT })
  assert.ok(Math.abs(longer.gapRatio - 0.2) < 1e-6)
  const shorter = call('planCompose', { dv: 12, da: 6, t: 0, fit: FIT })
  assert.ok(shorter.gapRatio < 0)
  // 画面比旁白长是常态，不阻断
  assert.equal(shorter.blocked, false)
})

test('parseNarrationMeta 对损坏 JSON 返回空对象', () => {
  assert.deepEqual(call('parseNarrationMeta', '{ broken'), {})
  assert.deepEqual(call('parseNarrationMeta', null), {})
  assert.deepEqual(call('parseNarrationMeta', '[]'), {})
})
