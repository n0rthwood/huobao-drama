/**
 * Issue #35：旁白可用性。
 * 纯函数部分（提示词拼装 / 文本规范化继承）走 tsx 入口真实调用；
 * 接线部分做结构性断言（与 narration-structure.test.mjs 同一套做法）。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')
const backendRoot = fileURLToPath(root)

const entry = join(mkdtempSync(join(tmpdir(), 'huobao-nux-')), 'entry.mts')
writeFileSync(entry, `
import * as prompt from '${backendRoot}src/services/narration-prompt.ts'
import * as narration from '${backendRoot}src/services/narration.ts'

const api = { ...prompt, ...narration } as unknown as Record<string, (...args: any[]) => unknown>
const [name, args] = JSON.parse(process.env.NUX_INPUT!)
process.stdout.write(JSON.stringify(api[name](...args) ?? null))
`)
const tsxBin = join(backendRoot, 'node_modules', '.bin', 'tsx')
function call(name, ...args) {
  const out = execFileSync(tsxBin, [entry], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, NUX_INPUT: JSON.stringify([name, args]) },
  })
  return JSON.parse(out)
}

const shot = (n, over = {}) => ({
  shotNumber: n,
  description: `第 ${n} 镜的画面`,
  atmosphere: '冷峻',
  duration: 8,
  continuityBoundary: 'cut',
  narrationText: '',
  narrationEnabled: true,
  ...over,
})
// 「剧本全文」用一个带尾部标记的长文本：摘要/截断会把尾部弄丢，断言能抓住
const SCRIPT = `${'康熙五十九年的西北边情。'.repeat(200)}\n【剧本结尾标记】`

test('分块：按顺序切块，最后一块可短', () => {
  const chunks = call('buildChunks', [1, 2, 3, 4, 5, 6, 7], 3)
  assert.deepEqual(chunks, [[1, 2, 3], [4, 5, 6], [7]])
})

test('阶段 A 的主线提示里带剧本全文与分段区间', () => {
  const shots = [shot(1), shot(2), shot(3), shot(4), shot(5), shot(6), shot(7)]
  const chunks = call('buildChunks', shots, 6)
  const msg = call('buildSpineMessage', { script: SCRIPT, shots, chunks })
  assert.ok(msg.includes(SCRIPT), '主线提示必须内联剧本全文')
  assert.ok(msg.includes('【剧本结尾标记】'), '剧本不得被截断')
  assert.match(msg, /save_narration_spine/)
  assert.match(msg, /第 1 段：镜 #1–#6/)
  assert.match(msg, /第 2 段：镜 #7–#7/)
})

test('阶段 B 的分块提示带剧本全文 + 主线 + 前后镜旁白，且只许写本段', () => {
  const chunk = [shot(3), shot(4)]
  const msg = call('buildChunkMessage', {
    script: SCRIPT,
    spine: '整集主线：三方在草原上落子。',
    chunk,
    prev: shot(2, { narrationText: '上一镜已经写好的旁白。' }),
    next: shot(5, { narrationEnabled: false }),
    chunkIndex: 1,
    chunkTotal: 4,
  })
  assert.ok(msg.includes(SCRIPT), '分块提示必须内联剧本全文，不能是摘要')
  assert.ok(msg.includes('【剧本结尾标记】'), '剧本不得被截断')
  assert.ok(msg.includes('整集主线：三方在草原上落子。'), '必须带整集主线')
  assert.ok(msg.includes('上一镜已经写好的旁白。'), '必须带上一镜旁白')
  assert.match(msg, /下一镜：镜 #5/)
  assert.match(msg, /不要碰本段以外的镜头/)
  assert.match(msg, /不要调用 read_storyboard_context/)
})

test('单镜提示同样带剧本全文与前后镜；没有主线时给出兜底说明', () => {
  const msg = call('buildShotMessage', {
    script: SCRIPT,
    spine: '',
    shot: shot(9),
    prev: shot(8, { narrationText: '前一镜旁白。' }),
    next: null,
  })
  assert.ok(msg.includes(SCRIPT))
  assert.ok(msg.includes('前一镜旁白。'))
  assert.match(msg, /镜 #9–#9/)
  assert.match(msg, /还没有保存主线/)
})

test('写作口径：数字写阿拉伯数字，禁止「〇」（实测会被念成「一七两年」）', () => {
  const msg = call('buildShotMessage', { script: SCRIPT, spine: '主线', shot: shot(1), prev: null, next: null })
  assert.match(msg, /1720年5月8日/)
  assert.match(msg, /禁止用中文数字写年份\/日期/)
  assert.ok(msg.includes('〇'), '必须显式点名被念错的「〇」')
})

test('文本规范化：集级默认开，镜级可覆盖', () => {
  assert.equal(call('resolveNarrationNormalize', null, null), true, '存量集没有设置时默认开')
  assert.equal(call('resolveNarrationNormalize', true, null), true)
  assert.equal(call('resolveNarrationNormalize', false, null), false)
  assert.equal(call('resolveNarrationNormalize', false, true), true, '镜级覆盖优先')
  assert.equal(call('resolveNarrationNormalize', true, false), false, '镜级覆盖优先')
})

test('迁移：主线与规范化三列都有补列，存量集规范化默认开', () => {
  const sqlite = read('src/db/sqlite-schema.ts')
  assert.match(sqlite, /episodes', column: 'narration_spine', type: 'TEXT'/)
  assert.match(sqlite, /episodes', column: 'narration_normalize', type: 'INTEGER NOT NULL DEFAULT 1'/)
  assert.match(sqlite, /storyboards', column: 'narration_normalize', type: 'INTEGER'/)
})

test('批量「已在运行」带回进度，前端不再误报「没有需要处理的镜头」', () => {
  const route = read('src/routes/episodes.ts')
  assert.match(route, /already_running: true,\s*\n\s*total: running\?\.total/)
  assert.match(route, /completed: running\?\.completed/)
  const page = read('../frontend/app/views/drama/episode.vue')
  assert.match(page, /if \(res\?\.already_running\)/)
  assert.match(page, /episode\.narration\.batchAlreadyRunning/)
  assert.match(page, /resumeNarrationBatch/)
})

test('分块落库范围受请求上下文限制，越界镜头被拒绝', () => {
  const tools = read('src/agents/tools/narration-tools.ts')
  assert.match(tools, /getNarrationShotNumbers\(context\?\.requestContext\)/)
  assert.match(tools, /out of scope for this run/)
  const ctx = read('src/agents/context.ts')
  assert.match(ctx, /narrationShotNumbers/)
  const script = read('src/services/narration-script.ts')
  assert.match(script, /contextFor\(chunk\.map\(s => s\.shotNumber\)\)/)
  assert.match(script, /narrationShotNumbers: \[sb\.storyboardNumber\]/)
})

test('进度按块推进且串行写入，不是跑完才写一次', () => {
  const script = read('src/services/narration-script.ts')
  assert.match(script, /writeProgress = writeProgress\.then\(\(\) => updateTextTaskProgress\(taskId, \{ \.\.\.progress \}\)\)/)
  assert.match(script, /progress\.phase = 'shots'/)
  assert.match(script, /NARRATION_CHUNK_CONCURRENCY/)
})

test('音色：不再自动取列表首项，必须由设置页选定', () => {
  const tts = read('src/services/tts.ts')
  assert.ok(!tts.includes('fetchDefaultVoice'), '自动取默认音色的函数必须删除')
  assert.ok(!/voices\[0\]/.test(tts), '不允许取列表第一个音色')
  assert.match(tts, /export async function fetchVoices/)
  const cfg = read('src/routes/aiConfigs.ts')
  assert.ok(!cfg.includes('pinDefaultVoice'), '保存时自动固定音色的逻辑必须删除')
  assert.match(cfg, /app\.get\('\/tts-voices'/)
  assert.match(cfg, /TTS 配置必须选定音色/)
  // 仍然只支持 voxcpm
  assert.match(tts, /provider !== 'voxcpm'/)
})

test('设置搬家：顶栏不再有任何旁白/音频控件，入口在分镜拆分区', () => {
  const page = read('../frontend/app/views/drama/episode.vue')
  const topbar = page.slice(0, page.indexOf('<div class="studio-actions">'))
  for (const key of [
    'episodeSubtitleTiming', 'episodeAudioMixMode', 'episodeBedGainDb',
    'episodeFitMode', 'episodeFitPadSeconds', 'episodeFitPadPosition',
  ]) {
    assert.ok(!topbar.includes(key), `顶栏不应再出现 ${key}`)
  }
  assert.match(page, /<NarrationSettingsPanel/)
  const kf = read('../frontend/app/components/StoryboardKeyframes.vue')
  assert.match(kf, /open-narration-settings/)
  assert.match(kf, /episode\.narration\.settingsEntry/)
})

test('每镜有单独的旁白写作按钮', () => {
  const block = read('../frontend/app/components/NarrationBlock.vue')
  assert.match(block, /episode\.narration\.rewriteShot/)
  assert.match(block, /storyboardAPI\.writeNarration/)
  const route = read('src/routes/storyboards.ts')
  assert.match(route, /'\/:id\/narration\/write'/)
})

test('四语文案：旁白是整集故事的一段，不是逐镜画面说明', () => {
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const dict = JSON.parse(read(`../frontend/app/locales/${lang}.json`))
    const nar = dict.episode.narration
    assert.ok(!/写清楚这一镜在讲什么/.test(nar.placeholder), `${lang} 仍把旁白写成逐镜说明`)
    for (const key of ['writeShot', 'rewriteShot', 'batchAlreadyRunning', 'settingsEntry', 'spineLabel', 'normalizeLabel']) {
      assert.ok(nar[key], `${lang} 缺少 episode.narration.${key}`)
    }
    assert.ok(dict.settings.cfg.ttsVoiceRefresh, `${lang} 缺少音色刷新文案`)
  }
})
