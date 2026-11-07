/**
 * 旁白骨架 + 当前有效配音硬门禁的对外行为回归（Issue #70）。
 *
 * 覆盖：骨架状态与覆盖校验、确认绑定 revision、拆分只影响受影响镜（无关镜的音频与设计卡原样保留）、
 * 缺口/陈旧 revision 的错误形状、配音参数变化与音频文件丢失让「当前有效配音」失效、
 * 没有有效配音时设计卡批量被 tts_required 挡住、批量配音以「骨架已确认」为前置。
 *
 * 与仓库其它数据库用例一致：临时 SQLite + 临时数据目录 + 仓库自带 tsx 子进程，
 * 断言全部针对服务/路由的返回值，不匹配源码文本。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(script) {
  const dir = mkdtempSync(path.join(tmpdir(), 'huobao-skeleton-'))
  try {
    const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot,
      encoding: 'utf8',
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3'), HUOBAO_DATA_DIR: dir },
    })
    return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const S1 = '一七二〇年，清、准、俄三方都在这片草原上押下重注。'
const S2 = '额尔齐斯河是唯一一条能把军队送进腹地的水道。'
const S3 = '这一年冬天，布赫霍尔茨奉命率领近三千人溯流而上。'

const SETUP = `
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import http from 'node:http'
import { eq } from 'drizzle-orm'
import { db, schema, initDb } from './src/db/index.ts'
import { sha256 } from './src/services/narration.ts'

const ffmpegBin = createRequire(path.join(process.cwd(), 'tests-entry.cjs'))('ffmpeg-static')
const DATA = process.env.HUOBAO_DATA_DIR
fs.mkdirSync(path.join(DATA, 'static/narration'), { recursive: true })
const abs = (rel) => path.join(DATA, rel)
const makeAudio = (rel, seconds) => execFileSync(ffmpegBin, [
  '-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(seconds), abs(rel),
], { stdio: 'ignore' })

const S1 = ${JSON.stringify(S1)}
const S2 = ${JSON.stringify(S2)}
const S3 = ${JSON.stringify(S3)}
const SCRIPT = [S1, S2, S3].join('\\n\\n')

// 配音参数校验会向 VoxCPM Studio 要音色列表：用本地桩服务回一个固定列表，
// 既不碰真服务，也不让「音色必须在列表里」这条校验变成网络依赖。
const voiceStub = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ items: [{ name: 'v1' }, { name: 'v2' }], voices: ['v1', 'v2'] }))
})
await new Promise(resolve => voiceStub.listen(0, '127.0.0.1', resolve))
voiceStub.unref()
const voiceBase = 'http://127.0.0.1:' + voiceStub.address().port

initDb()
const ts = new Date().toISOString()
await db.insert(schema.aiServiceConfigs).values({
  id: 1, name: 'tts', serviceType: 'tts', provider: 'voxcpm',
  baseUrl: voiceBase, apiKey: 'k', model: JSON.stringify(['voxcpm']),
  settings: JSON.stringify({ voice: 'v1' }),
  isActive: true, priority: 1, createdAt: ts, updatedAt: ts,
})
await db.insert(schema.dramas).values({ id: 1, title: 'doc', projectType: 'documentary', documentaryRules: 'on', createdAt: ts, updatedAt: ts })
await db.insert(schema.episodes).values({
  id: 1, dramaId: 1, episodeNumber: 1, title: 'e',
  scriptContent: SCRIPT, narrationEnabled: true, ttsConfigId: 1,
  scriptConfirmedAt: ts, assetReviewStatus: 'passed',
  createdAt: ts, updatedAt: ts,
})

const gate = await import('./src/services/narration-tts-gate.ts')
const [episodeRow] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, 1))
const config = await gate.resolveTtsConfig(episodeRow)
const params = gate.effectiveVoiceParams(episodeRow, null, config)

const voiced = (id, number, text, file, seconds) => {
  makeAudio(file, seconds)
  return {
    id, episodeId: 1, storyboardNumber: number, title: 't' + number,
    narrationEnabled: true, narrationText: text,
    narrationAudioUrl: file,
    narrationMeta: JSON.stringify({
      text_sha256: sha256(text),
      audio: {
        duration_ms: seconds * 1000, chars: text.length, voice: params.voice,
        seed: params.seed, job_id: null, provider: 'voxcpm', config_id: 1,
        generated_at: ts, text_sha256: sha256(text), params,
      },
    }),
    createdAt: ts, updatedAt: ts,
  }
}
await db.insert(schema.storyboards).values([
  voiced(10, 1, S1, 'static/narration/a1.wav', 3),
  voiced(11, 2, S2, 'static/narration/a2.wav', 4),
  // 第三镜还没有配音：它是「部分失败只挡受影响镜」的对照组
  { id: 12, episodeId: 1, storyboardNumber: 3, title: 't3', narrationEnabled: true, narrationText: S3, createdAt: ts, updatedAt: ts },
])

const skeleton = await import('./src/services/narration-skeleton.ts')
const { default: skeletonApp } = await import('./src/routes/narration-skeleton.ts')
const json = async (res) => ({ status: res.status, body: await res.json() })
const get = () => skeletonApp.request('/1/narration-skeleton')
const put = (body) => skeletonApp.request('/1/narration-skeleton', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const confirm = (body) => skeletonApp.request('/1/narration-skeleton/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const emit = (payload) => console.log('@@' + JSON.stringify(payload))
`

test('skeleton state reports verbatim coverage and per-shot current-valid TTS', () => {
  const result = run(`${SETUP}
    const state = (await (await get()).json()).data
    const byNumber = Object.fromEntries(state.shots.map(s => [s.storyboard_number, s]))
    emit({
      enabled: state.enabled,
      confirmed: state.confirmed,
      complete: state.coverage.complete,
      uncovered: state.coverage.uncovered_chars,
      confirmable: state.confirmable,
      shots: state.shots.length,
      s1Valid: byNumber[1].tts.valid,
      s1Duration: byNumber[1].tts.duration_ms,
      s1Fillable: byNumber[1].design_fillable,
      s3Valid: byNumber[3].tts.valid,
      s3Reason: byNumber[3].tts.reason,
      s3Fillable: byNumber[3].design_fillable,
      s3Ready: byNumber[3].design_ready,
      ttsCounts: state.tts,
    })
  `)
  assert.equal(result.enabled, true)
  assert.equal(result.confirmed, false)
  assert.equal(result.complete, true)
  assert.equal(result.uncovered, 0)
  assert.equal(result.confirmable, true)
  assert.equal(result.shots, 3)
  // 实测时长来自音频文件本身，不是 narration_meta 里的旧数字
  assert.equal(result.s1Valid, true)
  assert.ok(result.s1Duration > 0)
  assert.equal(result.s1Fillable, true)
  // 没配过音的那一镜单独失效，不拖累前两镜
  assert.equal(result.s3Valid, false)
  assert.equal(result.s3Reason, 'audio_missing')
  assert.equal(result.s3Fillable, false)
  assert.equal(result.s3Ready, false)
  assert.deepEqual(result.ttsCounts, { valid: 2, invalid: 1, total: 3 })
})

test('confirming the skeleton is bound to the current revision and released by any edit', () => {
  const result = run(`${SETUP}
    const before = (await (await get()).json()).data
    const stale = await json(await confirm({ revision: 'deadbeefdeadbeef' }))
    const ok = await json(await confirm({ revision: before.revision }))
    // 确认之后改标题：revision 变了，确认自动失效
    const edited = await json(await put({
      revision: ok.body.data.revision,
      shots: [
        { id: 10, narration_text: S1, title: '改过的标题' },
        { id: 11, narration_text: S2 },
        { id: 12, narration_text: S3 },
      ],
    }))
    emit({
      staleStatus: stale.status,
      staleError: stale.body.error,
      okStatus: ok.status,
      confirmed: ok.body.data.confirmed,
      confirmedRevision: ok.body.data.confirmed_revision === ok.body.data.revision,
      editedStatus: edited.status,
      editedConfirmed: edited.body.data.confirmed,
      revisionChanged: edited.body.data.revision !== ok.body.data.revision,
      stillConfirmedRevision: edited.body.data.confirmed_revision === ok.body.data.revision,
    })
  `)
  assert.equal(result.staleStatus, 409)
  assert.equal(result.staleError, 'revision_conflict')
  assert.equal(result.okStatus, 200)
  assert.equal(result.confirmed, true)
  assert.equal(result.confirmedRevision, true)
  assert.equal(result.editedStatus, 200)
  // 骨架一改，确认立刻失效，但确认过的那个 revision 仍作为溯源保留
  assert.equal(result.editedConfirmed, false)
  assert.equal(result.revisionChanged, true)
  assert.equal(result.stillConfirmedRevision, true)
})

test('splitting a shot keeps untouched shots and their audio, and only stales affected design cards', () => {
  const result = run(`${SETUP}
    await db.update(schema.storyboards)
      .set({ designCard: JSON.stringify({ version: 2, suggested_combo: 'A' }), designCardStatus: 'confirmed', designCardConfirmedAt: ts })
      .where(eq(schema.storyboards.episodeId, 1))
    const before = (await (await get()).json()).data
    const head = S3.slice(0, S3.indexOf('，') + 1)
    const tail = S3.slice(S3.indexOf('，') + 1)
    const res = await json(await put({
      revision: before.revision,
      shots: [
        { id: 10, narration_text: S1 },
        { id: 11, narration_text: S2 },
        { id: 12, narration_text: head },
        { narration_text: tail, title: '续写' },
      ],
    }))
    const rows = await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, 1))
    const row = id => rows.find(r => r.id === id)
    emit({
      status: res.status,
      shots: res.body.data.shots.length,
      complete: res.body.data.coverage.complete,
      numbers: res.body.data.shots.map(s => s.storyboard_number),
      texts: res.body.data.shots.map(s => s.narration_text),
      keptAudio: row(10).narrationAudioUrl,
      keptMeta: row(10).narrationMeta === rows.find(r => r.id === 10).narrationMeta,
      untouchedCard: row(10).designCardStatus,
      splitCard: row(12).designCardStatus,
      splitAudioless: row(12).narrationAudioUrl,
      neighbourCard: row(11).designCardStatus,
      s1Valid: res.body.data.shots.find(s => s.storyboard_number === 1).tts.valid,
    })
  `)
  assert.equal(result.status, 200)
  assert.equal(result.shots, 4)
  assert.equal(result.complete, true)
  assert.deepEqual(result.numbers, [1, 2, 3, 4])
  assert.equal(result.texts[0], S1)
  // 无关镜（#01）的音频与已确认设计卡原样保留
  assert.equal(result.keptAudio, 'static/narration/a1.wav')
  assert.equal(result.untouchedCard, 'confirmed')
  assert.equal(result.s1Valid, true)
  // 被拆开的那一镜要重审；拆点另一侧的新镜也是受影响镜
  assert.equal(result.splitCard, 'stale')
  // #02 既没改字，也不在这次拆点的两侧：它的已确认设计原样保留
  assert.equal(result.neighbourCard, 'confirmed')
  assert.equal(result.splitAudioless, null)
})

test('skeleton edits reject gaps, rewrites and stale revisions', () => {
  const result = run(`${SETUP}
    const before = (await (await get()).json()).data
    const gap = await json(await put({
      revision: before.revision,
      shots: [{ id: 10, narration_text: S1 }, { id: 12, narration_text: S3 }],
    }))
    const rewritten = await json(await put({
      revision: before.revision,
      shots: [
        { id: 10, narration_text: S1 },
        { id: 11, narration_text: '这一句是模型自己改写的旁白。' },
        { id: 12, narration_text: S3 },
      ],
    }))
    const conflict = await json(await put({
      revision: 'deadbeefdeadbeef',
      shots: [{ id: 10, narration_text: S1 }, { id: 11, narration_text: S2 }, { id: 12, narration_text: S3 }],
    }))
    const rows = await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, 1))
    emit({
      gapStatus: gap.status,
      gapError: gap.body.error,
      gapCodes: gap.body.problems.map(p => p.code),
      rewriteCodes: rewritten.body.problems.map(p => p.code),
      conflictStatus: conflict.status,
      conflictError: conflict.body.error,
      alive: rows.filter(r => !r.deletedAt).length,
      texts: rows.filter(r => !r.deletedAt).sort((a, b) => a.storyboardNumber - b.storyboardNumber).map(r => r.narrationText),
    })
  `)
  assert.equal(result.gapStatus, 400)
  assert.equal(result.gapError, 'skeleton_invalid')
  assert.ok(result.gapCodes.includes('gap'))
  assert.ok(result.rewriteCodes.includes('not_verbatim'))
  assert.equal(result.conflictStatus, 409)
  assert.equal(result.conflictError, 'revision_conflict')
  // 任何一次被拒的编辑都不留半条记录
  assert.equal(result.alive, 3)
  assert.deepEqual(result.texts, [S1, S2, S3])
})

test('current-valid TTS fails on voice-parameter change and on a missing audio file', () => {
  const result = run(`${SETUP}
    const beforeState = (await (await get()).json()).data
    const beforeValid = beforeState.shots.map(s => s.tts.valid)
    // 只改音色：音频文件还在，但它不再是「当前生效参数」下的配音
    await db.update(schema.episodes).set({ ttsSettings: JSON.stringify({ voice: 'v2' }) }).where(eq(schema.episodes.id, 1))
    const afterVoice = (await (await get()).json()).data
    await db.update(schema.episodes).set({ ttsSettings: null }).where(eq(schema.episodes.id, 1))
    // 文件丢失：旧元数据里的 duration_ms 不得顶替实测
    fs.rmSync(abs('static/narration/a1.wav'))
    const afterDelete = (await (await get()).json()).data
    const byNumber = s => Object.fromEntries(s.shots.map(x => [x.storyboard_number, x]))
    emit({
      beforeValid,
      voiceReason1: byNumber(afterVoice)[1].tts.reason,
      voiceReason2: byNumber(afterVoice)[2].tts.reason,
      deletedReason: byNumber(afterDelete)[1].tts.reason,
      deletedDuration: byNumber(afterDelete)[1].tts.duration_ms,
      otherStillValid: byNumber(afterDelete)[2].tts.valid,
    })
  `)
  assert.deepEqual(result.beforeValid, [true, true, false])
  assert.equal(result.voiceReason1, 'voice_params_changed')
  assert.equal(result.voiceReason2, 'voice_params_changed')
  assert.equal(result.deletedReason, 'audio_file_missing')
  assert.equal(result.deletedDuration, null)
  assert.equal(result.otherStillValid, true)
})

test('design-card fill needs a confirmed skeleton and blocks shots without current-valid audio', () => {
  const result = run(`${SETUP}
    const { startDesignCardBatch } = await import('./src/services/design-card-batch.ts')
    const { default: cardsApp } = await import('./src/routes/design-cards.ts')
    const fill = (body) => cardsApp.request('/1/design-cards/fill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const state = (await (await get()).json()).data
    let unconfirmed = null
    try { await startDesignCardBatch(1, 1, {}, [10]) } catch (err) { unconfirmed = err.name }
    const unconfirmedHttp = await json(await fill({ storyboard_ids: [10] }))
    await confirm({ revision: state.revision })
    let blocked = null
    try { await startDesignCardBatch(1, 1, {}, [12]) } catch (err) {
      blocked = { name: err.name, blocked: err.blocked.map(b => ({ id: b.storyboard_id, reason: b.reason })) }
    }
    emit({
      unconfirmed,
      blocked,
      unconfirmedStatus: unconfirmedHttp.status,
      unconfirmedError: unconfirmedHttp.body.error,
    })
  `)
  assert.equal(result.unconfirmed, 'SkeletonNotConfirmedError')
  // 未确认骨架就点「AI 填卡」是操作顺序问题，必须是 400 指路，不是 500
  assert.equal(result.unconfirmedStatus, 400)
  assert.equal(result.unconfirmedError, 'skeleton_unconfirmed')
  assert.equal(result.blocked.name, 'TtsRequiredError')
  assert.deepEqual(result.blocked.blocked, [{ id: 12, reason: 'audio_missing' }])
})

test('batch voice-over requires a confirmed skeleton instead of a confirmed design card', () => {
  const result = run(`${SETUP}
    const { previewVoiceBatch, startVoiceBatch } = await import('./src/services/narration-voice.ts')
    const settings = { voice: params.voice, inference_timesteps: params.inference_timesteps, cfg_value: params.cfg_value, seed: params.seed, instructions: params.instructions, normalize: params.normalize }
    const state = (await (await get()).json()).data
    const beforeItems = await previewVoiceBatch(1, settings)
    let beforeStart = null
    try { await startVoiceBatch(1, 1) } catch (err) { beforeStart = err.name }
    await confirm({ revision: state.revision })
    const afterItems = await previewVoiceBatch(1, settings)
    const pick = (items, number) => items.find(i => i.storyboard_number === number)
    emit({
      beforeStatuses: beforeItems.map(i => i.status),
      beforeReason: pick(beforeItems, 3).reason,
      beforeStart,
      afterS3: pick(afterItems, 3).status,
      afterS1: pick(afterItems, 1).status,
      // 设计卡一张都没有确认，批量配音照样可以进行（旧顺序已经倒过来了）
      cards: (await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, 1))).map(r => r.designCardStatus),
    })
  `)
  assert.deepEqual(result.beforeStatuses, ['skipped', 'skipped', 'skipped'])
  assert.match(result.beforeReason, /骨架/)
  assert.equal(result.beforeStart, 'SkeletonNotConfirmedError')
  assert.equal(result.afterS3, 'missing')
  assert.equal(result.afterS1, 'unchanged')
  assert.deepEqual(result.cards, ['blank', 'blank', 'blank'])
})

test('a short missing stretch still blocks confirmation, and unconfirming the final script withdraws it', () => {
  const result = run(`${SETUP}
    // 少领 3 个字（句尾标点前）：narrationCoverage 的 8 字容差会放过，严格分配不放过
    await db.update(schema.storyboards).set({ narrationText: S2.slice(0, S2.length - 4) }).where(eq(schema.storyboards.id, 11))
    const shortGap = (await (await get()).json()).data
    const shortConfirm = await json(await confirm({ revision: shortGap.revision }))
    // 改回原文后可以确认
    await db.update(schema.storyboards).set({ narrationText: S2 }).where(eq(schema.storyboards.id, 11))
    const restored = (await (await get()).json()).data
    const ok = await json(await confirm({ revision: restored.revision }))
    // 撤销最终旁白稿确认：骨架确认随之失效，批量配音重新被挡
    await db.update(schema.episodes).set({ scriptConfirmedAt: null }).where(eq(schema.episodes.id, 1))
    const afterUnconfirm = (await (await get()).json()).data
    const { startVoiceBatch } = await import('./src/services/narration-voice.ts')
    let batch = null
    try { await startVoiceBatch(1, 1) } catch (err) { batch = err.name }
    emit({
      shortComplete: shortGap.coverage.complete,
      shortConfirmable: shortGap.confirmable,
      shortConfirmStatus: shortConfirm.status,
      okConfirmed: ok.body.data.confirmed,
      afterUnconfirmConfirmed: afterUnconfirm.confirmed,
      afterUnconfirmRevisionSame: afterUnconfirm.revision === restored.revision,
      batch,
    })
  `)
  assert.equal(result.shortComplete, false)
  assert.equal(result.shortConfirmable, false)
  assert.equal(result.shortConfirmStatus, 400)
  assert.equal(result.okConfirmed, true)
  // 骨架一个字都没动（revision 不变），但剧本确认被撤销 → 骨架确认失效
  assert.equal(result.afterUnconfirmRevisionSame, true)
  assert.equal(result.afterUnconfirmConfirmed, false)
  assert.equal(result.batch, 'SkeletonNotConfirmedError')
})

test('batch voice-over re-voices a shot whose audio file disappeared even though its metadata still matches', () => {
  const result = run(`${SETUP}
    const { previewVoiceBatch } = await import('./src/services/narration-voice.ts')
    const settings = { voice: params.voice, inference_timesteps: params.inference_timesteps, cfg_value: params.cfg_value, seed: params.seed, instructions: params.instructions, normalize: params.normalize }
    const state = (await (await get()).json()).data
    await confirm({ revision: state.revision })
    const healthy = await previewVoiceBatch(1, settings)
    fs.rmSync(abs('static/narration/a1.wav'))
    const broken = await previewVoiceBatch(1, settings)
    const pick = (items, number) => items.find(i => i.storyboard_number === number)
    emit({
      healthyS1: pick(healthy, 1).status,
      healthyChecked: pick(healthy, 1).checked,
      brokenS1: pick(broken, 1).status,
      brokenChecked: pick(broken, 1).checked,
      brokenReason: pick(broken, 1).reason,
      otherS2: pick(broken, 2).status,
    })
  `)
  assert.equal(result.healthyS1, 'unchanged')
  assert.equal(result.healthyChecked, false)
  // 元数据仍然对得上，但文件没了：必须进本批重配，而不是按「未变化」跳过
  assert.equal(result.brokenS1, 'changed')
  assert.equal(result.brokenChecked, true)
  assert.match(result.brokenReason, /配音文件/)
  assert.equal(result.otherS2, 'unchanged')
})

test('a longer re-voice blocks production of a confirmed card instead of silently widening the budget', () => {
  const result = run(`${SETUP}
    const { productionGateReason } = await import('./src/services/workflow-gates.ts')
    const card = JSON.stringify({ version: 2, suggested_combo: 'A', budget: { layer_s: 5, gen_s: null }, layer_plan: { base: { kind: 'inherit_prev' } } })
    await db.update(schema.storyboards)
      .set({ designCard: card, combo: 'A', designCardStatus: 'confirmed', designCardConfirmedAt: ts })
      .where(eq(schema.storyboards.id, 10))
    const fits = await productionGateReason(1, { storyboardId: 10, status: 'confirmed', number: 1 })
    // 重新配音到 20 秒：音频本身有效，但已确认的 5 秒预算装不下
    makeAudio('static/narration/a1.wav', 20)
    const after = await productionGateReason(1, { storyboardId: 10, status: 'confirmed', number: 1 })
    const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, 10))
    emit({
      fitsUnlocked: fits.unlocked,
      afterUnlocked: after.unlocked,
      afterReason: after.reason,
      afterTtsBlocked: after.tts_blocked,
      budgetUntouched: JSON.parse(row.designCard).budget.layer_s,
      confirmationKept: row.designCardStatus,
    })
  `)
  assert.equal(result.fitsUnlocked, true)
  assert.equal(result.afterUnlocked, false)
  // 阻断原因是「卡与新实测不匹配」，不是「没有有效配音」
  assert.equal(result.afterTtsBlocked, null)
  assert.match(result.afterReason, /不再匹配/)
  // 既不改预算，也不撤销人工确认记录
  assert.equal(result.budgetUntouched, 5)
  assert.equal(result.confirmationKept, 'confirmed')
})

test('a readable media file without an audio track is not current-valid TTS', () => {
  const result = run(`${SETUP}
    const { previewVoiceBatch } = await import('./src/services/narration-voice.ts')
    const settings = { voice: params.voice, inference_timesteps: params.inference_timesteps, cfg_value: params.cfg_value, seed: params.seed, instructions: params.instructions, normalize: params.normalize }
    const state = (await (await get()).json()).data
    await confirm({ revision: state.revision })
    // 把配音文件换成一段无音轨的视频：文件读得出、时长也是正数，但它不是配音
    execFileSync(ffmpegBin, [
      '-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=10:d=3',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-an',
      abs('static/narration/a1.mp4'),
    ], { stdio: 'ignore' })
    await db.update(schema.storyboards).set({ narrationAudioUrl: 'static/narration/a1.mp4' }).where(eq(schema.storyboards.id, 10))
    const after = (await (await get()).json()).data
    const shot = after.shots.find(s => s.storyboard_number === 1)
    const plan = (await previewVoiceBatch(1, settings)).find(i => i.storyboard_number === 1)
    const { productionGateReason } = await import('./src/services/workflow-gates.ts')
    await db.update(schema.storyboards).set({ designCardStatus: 'confirmed', combo: 'A' }).where(eq(schema.storyboards.id, 10))
    const prodGate = await productionGateReason(1, { storyboardId: 10, status: 'confirmed', number: 1 })
    emit({
      valid: shot.tts.valid,
      reason: shot.tts.reason,
      duration: shot.tts.duration_ms,
      planStatus: plan.status,
      planChecked: plan.checked,
      gateUnlocked: prodGate.unlocked,
      gateBlockedReason: prodGate.tts_blocked && prodGate.tts_blocked.reason,
    })
  `)
  assert.equal(result.valid, false)
  assert.equal(result.reason, 'audio_no_stream')
  assert.equal(result.duration, null)
  // 预览把它排进重配，制作入口按 tts_required 阻断
  assert.equal(result.planStatus, 'changed')
  assert.equal(result.planChecked, true)
  assert.equal(result.gateUnlocked, false)
  assert.equal(result.gateBlockedReason, 'audio_no_stream')
})
