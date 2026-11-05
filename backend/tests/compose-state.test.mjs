/**
 * 每镜融合的对外行为回归（Issue #42）——真跑 ffmpeg 合成 + 真读接口返回。
 *
 * 覆盖：刚合成即「最新」、各类输入变化的失效口径、纯画面不被无关改动带歪、
 * 依赖缺失/字幕为空的阻断、转场 T 取当前采用视频、旧签名判「无法比较」、
 * 批量必须显式勾选、导出不静默少镜也不用过期成片。
 *
 * 和仓库其它数据库用例一样：临时 SQLite + 临时数据目录 + 仓库自带 tsx 子进程，
 * 断言全部针对服务/路由的返回值，不匹配源码文本。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
const workDir = mkdtempSync(path.join(tmpdir(), 'huobao-compose-'))

const scenario = `
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { eq } from 'drizzle-orm'
import { db, schema, initDb } from './src/db/index.ts'
import { sha256 } from './src/services/narration.ts'

const ffmpegBin = createRequire(path.join(process.cwd(), 'tests-entry.cjs'))('ffmpeg-static')
const DATA = process.env.HUOBAO_DATA_DIR
fs.mkdirSync(path.join(DATA, 'static/videos'), { recursive: true })
fs.mkdirSync(path.join(DATA, 'static/narration'), { recursive: true })
const abs = (rel) => path.join(DATA, rel)

// 真实媒体：直接 spawn ffmpeg 二进制（lavfi 在命令行可用，fluent-ffmpeg 的格式校验才不认）
const makeVideo = (rel, seconds) => execFileSync(ffmpegBin, [
  '-y', '-f', 'lavfi', '-i', \`color=c=black:s=320x180:r=12:d=\${seconds}\`,
  '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', abs(rel),
], { stdio: 'ignore' })
const makeAudio = (rel, seconds) => execFileSync(ffmpegBin, [
  '-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(seconds), abs(rel),
], { stdio: 'ignore' })

makeVideo('static/videos/v1.mp4', 6)
makeVideo('static/videos/v2.mp4', 6)
makeAudio('static/narration/a1.wav', 3)
const SRT = '1\\n00:00:00,000 --> 00:00:03,000\\n一七二〇年的草原。\\n'
fs.writeFileSync(abs('static/narration/a1.srt'), SRT, 'utf8')

initDb()
const ts = new Date().toISOString()
const TEXT = '一七二〇年，清、准、俄三方，都在这片草原上押下重注。'
await db.insert(schema.dramas).values({ id: 1, title: 'd', createdAt: ts, updatedAt: ts })
await db.insert(schema.episodes).values({
  id: 1, dramaId: 1, episodeNumber: 1, title: 'e',
  narrationEnabled: true, createdAt: ts, updatedAt: ts,
})
await db.insert(schema.storyboards).values({
  id: 10, episodeId: 1, storyboardNumber: 1, title: '草原落子',
  videoUrl: 'static/videos/v1.mp4',
  narrationEnabled: true,
  narrationText: TEXT,
  narrationAudioUrl: 'static/narration/a1.wav',
  subtitleUrl: 'static/narration/a1.srt',
  narrationMeta: JSON.stringify({ audio: { url: 'static/narration/a1.wav', duration_ms: 3000, text_sha256: sha256(TEXT), voice: 'v', provider: 'voxcpm', generated_at: ts } }),
  createdAt: ts, updatedAt: ts,
})
await db.insert(schema.storyboards).values({
  id: 11, episodeId: 1, storyboardNumber: 2, title: '纯画面',
  videoUrl: 'static/videos/v2.mp4',
  narrationEnabled: false,
  createdAt: ts, updatedAt: ts,
})

const { composeShot, previewComposeBatch, startComposeBatch, getComposeBatchStatus } = await import('./src/services/shot-compose.ts')
const { composeStatesForEpisode } = await import('./src/services/compose-state.ts')
const { default: episodesApp } = await import('./src/routes/episodes.ts')
const { default: mergeApp } = await import('./src/routes/merge.ts')

const stateOf = async (id) => (await composeStatesForEpisode(1)).find(s => s.storyboard_id === id)
const pick = (s) => s && ({
  status: s.status, checked: s.checked, selectable: s.selectable, exportable: s.exportable,
  reason: s.reason, change_reasons: s.change_reasons, inputs: s.inputs,
})
const setShot = (id, patch) => db.update(schema.storyboards).set(patch).where(eq(schema.storyboards.id, id))
const post = async (app, url, body) => {
  const res = await app.request(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  })
  return { status: res.status, body: await res.json() }
}

const out = {}

out.beforeCompose = pick(await stateOf(10))

const composed = await composeShot(10)
out.composeResult = { hasUrl: Boolean(composed.composedVideoUrl), burned: composed.burned, durationMs: composed.durationMs }
out.afterCompose = pick(await stateOf(10))

// 分镜列表接口与状态同源
const listRes = await episodesApp.request('/1/storyboards')
const listRows = (await listRes.json()).data
const listed = listRows.find(r => r.id === 10)
out.listed = { status: listed.compose_state.status, exportable: listed.compose_state.exportable, narration_status: listed.narration_status }

// 匹配参数变化 → 已变化；改回来 → 最新
await setShot(10, { narrationFit: JSON.stringify({ mode: 'pad', pad_ms: 1800, pad_position: 'tail' }) })
out.fitChanged = pick(await stateOf(10))
await setShot(10, { narrationFit: null })
out.fitReverted = pick(await stateOf(10))

// 文本改了没重配音 → 阻断；改回来 → 最新
await setShot(10, { narrationText: TEXT + '（改）' })
out.textEdited = pick(await stateOf(10))
await setShot(10, { narrationText: TEXT })
out.textReverted = pick(await stateOf(10))

// 字幕文件被清空 → 阻断（不能当作「没字幕可烧」照样成功）
fs.writeFileSync(abs('static/narration/a1.srt'), '   ', 'utf8')
out.subtitleEmpty = pick(await stateOf(10))
fs.writeFileSync(abs('static/narration/a1.srt'), SRT, 'utf8')
out.subtitleRestored = pick(await stateOf(10))

// 视频文件丢失 → 阻断
fs.renameSync(abs('static/videos/v1.mp4'), abs('static/videos/v1.bak'))
out.videoMissing = pick(await stateOf(10))
fs.renameSync(abs('static/videos/v1.bak'), abs('static/videos/v1.mp4'))
out.videoRestored = pick(await stateOf(10))

// 转场 T：当前采用视频对应的任务才算数
await db.insert(schema.sysTask).values({
  id: 100, type: 'video', storyboardId: 10, episodeId: 1, localPath: 'static/videos/v1.mp4',
  params: JSON.stringify({ transition: { T: 1 } }), status: 'completed', createdAt: ts, updatedAt: ts,
})
out.transitionAdopted = pick(await stateOf(10))
await db.delete(schema.sysTask).where(eq(schema.sysTask.id, 100))
await db.insert(schema.sysTask).values({
  id: 101, type: 'video', storyboardId: 10, episodeId: 1, localPath: 'static/videos/other.mp4',
  params: JSON.stringify({ transition: { T: 3 } }), status: 'failed', createdAt: ts, updatedAt: ts,
})
out.transitionUnrelated = pick(await stateOf(10))
await db.delete(schema.sysTask).where(eq(schema.sysTask.id, 101))

// 旧版签名记录 → 无法比较，不冒充最新
const [row10] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, 10))
const freshMeta = row10.narrationMeta
const legacy = JSON.parse(freshMeta)
delete legacy.composed.signature_version
delete legacy.composed.inputs
await setShot(10, { narrationMeta: JSON.stringify(legacy) })
out.legacySignature = pick(await stateOf(10))
await setShot(10, { narrationMeta: freshMeta })

// 纯画面镜头：合成走静音轨，且无关的文本/字幕/转场改动不该让它过期
out.pureVisualBefore = pick(await stateOf(11))
const pureComposed = await composeShot(11)
out.pureVisualComposed = { hasUrl: Boolean(pureComposed.composedVideoUrl), burned: pureComposed.burned }
out.pureVisualAfter = pick(await stateOf(11))
await setShot(11, {
  narrationText: '这条文案不参与纯画面产出',
  subtitleUrl: 'static/narration/a1.srt',
  narrationFit: JSON.stringify({ mode: 'pad', pad_ms: 2500, pad_position: 'head' }),
})
await db.insert(schema.sysTask).values({
  id: 102, type: 'video', storyboardId: 11, episodeId: 1, localPath: 'static/videos/v2.mp4',
  params: JSON.stringify({ transition: { T: 2 } }), status: 'completed', createdAt: ts, updatedAt: ts,
})
out.pureVisualUnaffected = pick(await stateOf(11))

// 队列预约在 ffmpeg 尚未启动时也应阻止单镜重复提交。
await db.insert(schema.sysTask).values({
  id: 103, type: 'text', episodeId: 1, status: 'processing',
  params: JSON.stringify({ kind: 'shot_compose', progress: {
    total: 1, completed: 0, failed: 0, items: [
      { storyboard_id: 11, storyboard_number: 2, state: 'pending', reason: null },
    ],
  } }),
  createdAt: ts, updatedAt: ts,
})
try {
  await composeShot(11)
  out.queuedSingleError = null
} catch (error) {
  out.queuedSingleError = error.message
}
await db.delete(schema.sysTask).where(eq(schema.sysTask.id, 103))

// 批量：必须显式勾选，显式空选不等于整集
out.batchNoIds = await post(episodesApp, '/1/compose-batch', {})
out.batchEmptyIds = await post(episodesApp, '/1/compose-batch', { storyboard_ids: [] })
out.batchForeignId = await post(episodesApp, '/1/compose-batch', { storyboard_ids: [999] })
out.previewEmptyScope = (await post(episodesApp, '/1/compose-batch/preview', { storyboard_ids: [] })).body.data.scope.included.length
out.previewEpisodeScope = (await post(episodesApp, '/1/compose-batch/preview', {})).body.data.items
  .map(i => ({ id: i.storyboard_id, status: i.status, checked: i.checked }))
out.previewScoped = (await previewComposeBatch(1, [10])).map(i => i.storyboard_id)

// 导出：所选镜头里有过期/未融合的，整单拒绝并给逐镜原因
await setShot(10, { narrationFit: JSON.stringify({ mode: 'pad', pad_ms: 1800, pad_position: 'tail' }) })
out.mergeStale = await post(mergeApp, '/episodes/1/merge', { storyboard_ids: [10, 11] })
out.mergeEmptySelection = await post(mergeApp, '/episodes/1/merge', { storyboard_ids: [] })
out.mergeImplicitAll = await post(mergeApp, '/episodes/1/merge', {})
await setShot(10, { narrationFit: null })

// 批量执行：勾选已变化的镜头 → 跑完后回到最新，逐项结果落盘可查
await setShot(10, { narrationFit: JSON.stringify({ mode: 'pad', pad_ms: 1200, pad_position: 'tail' }) })
out.beforeBatch = pick(await stateOf(10))
out.concurrentStarts = (await Promise.allSettled([
  startComposeBatch(1, 1, [10]),
  startComposeBatch(1, 1, [10]),
])).map(result => result.status)
for (let i = 0; i < 600; i++) {
  const status = await getComposeBatchStatus(1)
  if (status && status.status !== 'running') break
  await new Promise(r => setTimeout(r, 200))
}
out.batchStatus = await getComposeBatchStatus(1)
out.afterBatch = pick(await stateOf(10))
out.secondPreview = (await previewComposeBatch(1)).map(i => ({ id: i.storyboard_id, status: i.status, checked: i.checked }))
await db.update(schema.episodes).set({ narrationEnabled: false }).where(eq(schema.episodes.id, 1))
await setShot(11, { videoUrl: 'static/videos/missing.mp4' })
out.disabledMissingSource = pick(await stateOf(11))

process.stdout.write('@@' + JSON.stringify(out))
`

function runScenario() {
  const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', scenario], {
    cwd: backendRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      SQLITE_PATH: path.join(workDir, 'test.sqlite3'),
      HUOBAO_DATA_DIR: workDir,
      STORAGE_PATH: path.join(workDir, 'static'),
    },
  })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

const R = runScenario()

test('依赖齐备但没合成过 → 未合成、默认勾选、不可导出', () => {
  assert.equal(R.beforeCompose.status, 'missing')
  assert.equal(R.beforeCompose.checked, true)
  assert.equal(R.beforeCompose.selectable, true)
  assert.equal(R.beforeCompose.exportable, false)
  assert.deepEqual(R.beforeCompose.inputs, { video: true, audio: true, subtitle: true, pure_visual: false })
})

test('刚合成完、输入没动 → 立即是最新且可导出，不会误报过期', () => {
  assert.equal(R.composeResult.hasUrl, true)
  assert.equal(R.composeResult.burned, true)
  assert.ok(R.composeResult.durationMs > 0)
  assert.equal(R.afterCompose.status, 'unchanged')
  assert.equal(R.afterCompose.exportable, true)
  assert.equal(R.afterCompose.checked, false)
  assert.deepEqual(R.afterCompose.change_reasons, [])
})

test('分镜列表接口与融合状态同源', () => {
  assert.equal(R.listed.status, 'unchanged')
  assert.equal(R.listed.exportable, true)
  assert.equal(R.listed.narration_status, 'composed')
})

test('匹配参数变化即过期，改回去又变最新', () => {
  assert.equal(R.fitChanged.status, 'changed')
  assert.equal(R.fitChanged.checked, true)
  assert.equal(R.fitChanged.exportable, false)
  assert.ok(R.fitChanged.change_reasons.some(r => r.includes('匹配参数')), R.fitChanged.change_reasons.join('|'))
  assert.equal(R.fitReverted.status, 'unchanged')
})

test('文本改过没重配音 → 阻断，不可勾选也不可导出', () => {
  assert.equal(R.textEdited.status, 'blocked')
  assert.equal(R.textEdited.selectable, false)
  assert.equal(R.textEdited.exportable, false)
  assert.ok(R.textEdited.reason.includes('重新生成配音'), R.textEdited.reason)
  assert.equal(R.textReverted.status, 'unchanged')
})

test('该烧录的字幕为空 → 阻断，不会无字幕照样成功', () => {
  assert.equal(R.subtitleEmpty.status, 'blocked')
  assert.equal(R.subtitleEmpty.inputs.subtitle, false)
  assert.ok(R.subtitleEmpty.reason.includes('字幕'), R.subtitleEmpty.reason)
  assert.equal(R.subtitleRestored.status, 'unchanged')
})

test('视频文件丢失 → 阻断；文件回来后恢复最新', () => {
  assert.equal(R.videoMissing.status, 'blocked')
  assert.equal(R.videoMissing.inputs.video, false)
  assert.equal(R.videoRestored.status, 'unchanged')
})

test('转场偏移只认当前采用视频的那条任务', () => {
  assert.equal(R.transitionAdopted.status, 'changed')
  assert.ok(R.transitionAdopted.change_reasons.some(r => r.includes('转场偏移')), R.transitionAdopted.change_reasons.join('|'))
  // 另一条（更新但不是当前采用视频的）任务不得把成片判成过期
  assert.equal(R.transitionUnrelated.status, 'unchanged')
})

test('旧版签名记录判「无法比较」，不冒充最新也不可导出', () => {
  assert.equal(R.legacySignature.status, 'unknown')
  assert.equal(R.legacySignature.exportable, false)
  assert.equal(R.legacySignature.checked, false)
  assert.equal(R.legacySignature.selectable, true)
  assert.ok(R.legacySignature.reason.includes('重新合成'), R.legacySignature.reason)
})

test('纯画面镜头可以真的合成，且无关的文本/字幕/转场改动不让它过期', () => {
  assert.equal(R.pureVisualBefore.status, 'missing')
  assert.equal(R.pureVisualBefore.inputs.pure_visual, true)
  assert.equal(R.pureVisualComposed.hasUrl, true)
  assert.equal(R.pureVisualComposed.burned, false)
  assert.equal(R.pureVisualAfter.status, 'unchanged')
  assert.equal(R.pureVisualUnaffected.status, 'unchanged')
  assert.equal(R.pureVisualUnaffected.exportable, true)
})

test('批量必须带明确勾选的镜头；显式空选不等于整集', () => {
  assert.equal(R.batchNoIds.status, 400)
  assert.equal(R.batchEmptyIds.status, 400)
  assert.equal(R.batchForeignId.status, 400)
  assert.ok(R.batchForeignId.body.message.includes('999'), R.batchForeignId.body.message)
  assert.equal(R.previewEmptyScope, 0)
  assert.equal(R.previewEpisodeScope.length, 2)
  assert.deepEqual(R.previewScoped, [10])
})

test('批量队列中的镜头不能通过单镜接口重复提交', () => {
  assert.match(R.queuedSingleError, /批量融合/)
})

test('同时启动同集批量只接受一个请求，不创建重叠任务', () => {
  assert.deepEqual(R.concurrentStarts.sort(), ['fulfilled', 'rejected'])
})

test('导出所选镜头里有过期的 → 400 并逐镜给出原因，不静默少镜', () => {
  assert.equal(R.mergeStale.status, 400)
  assert.equal(R.mergeStale.body.success, false)
  assert.equal(R.mergeStale.body.blocked.length, 1)
  assert.equal(R.mergeStale.body.blocked[0].storyboard_id, 10)
  assert.equal(R.mergeStale.body.blocked[0].status, 'changed')
  assert.ok(R.mergeStale.body.blocked[0].reason.includes('过期'), R.mergeStale.body.blocked[0].reason)
  assert.equal(R.mergeEmptySelection.status, 400)
  assert.equal(R.mergeImplicitAll.status, 400)
  assert.equal(R.mergeImplicitAll.body.blocked[0].storyboard_id, 10)
})

test('批量跑完后回到最新，逐项结果落盘，第二次预览默认不勾任何镜头', () => {
  assert.equal(R.beforeBatch.status, 'changed')
  assert.equal(R.batchStatus.status, 'done')
  assert.equal(R.batchStatus.total, 1)
  assert.equal(R.batchStatus.completed, 1)
  assert.equal(R.batchStatus.failed, 0)
  assert.equal(R.batchStatus.skipped, 0)
  assert.deepEqual(R.batchStatus.items.map(i => [i.storyboard_id, i.state]), [[10, 'completed']])
  assert.equal(R.afterBatch.status, 'unchanged')
  assert.ok(R.secondPreview.every(i => i.status === 'unchanged' && i.checked === false), JSON.stringify(R.secondPreview))
})

test('旁白关闭时丢失的原始文件也不能在导出界面冒充可用', () => {
  assert.equal(R.disabledMissingSource.status, 'disabled')
  assert.equal(R.disabledMissingSource.inputs.video, false)
})
