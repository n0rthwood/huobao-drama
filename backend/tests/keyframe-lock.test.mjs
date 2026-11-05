/**
 * 衔接帧锁定（Issue #58，契约 §3.3）：C 首帧锁、D 尾帧锁、D + 承接首尾双锁，
 * 以及「衔接帧 hash 变化 → 确认作废（`junction_updated`）」。
 *
 * 走真实 DB + 真实服务（临时 SQLite，独立进程），断言 `buildState()` 的可观察结果：
 * `locked` / `locked_slots` / `slot_locks` / `ready` / `first` / `last`，以及
 * `PUT`/生成端点的锁定拒绝（`SlotLockedError.code === 'slot_locked'`）。
 * 衔接帧文件用一张真实 PNG 占位，`junctionFrameOf` 只认路径存在 + 段签名新鲜。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(body, env) {
  const script = `
    import { db, schema } from './src/db/index.ts'
    import { sql, eq } from 'drizzle-orm'
    import { now } from './src/utils/response.ts'
    import {
      loadEpisodeKeyframes, loadStoryboardKeyframes, keyframesJson,
      assertSlotWritable, invalidateKeyframeConfirmation, SlotLockedError,
    } from './src/services/keyframes.ts'
    import { junctionFrameOf } from './src/services/junction-frame.ts'
    import {
      saveLayerSegment, markSegmentRendered, resolveEpisodeSegmentSpec, layerSegmentSignatureOf,
    } from './src/services/layer-segment.ts'
    import { normalizeLayerDoc } from './src/services/layer-doc.ts'
    import { normalizeTimeline } from './src/services/segment-timeline.ts'
    const out = (value) => console.log('@@' + JSON.stringify(value))
    ${body}
  `
  const text = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return JSON.parse(text.slice(text.lastIndexOf('@@') + 2))
}

/** 造一集 4 镜：C、D、D+承接、B */
const SEED = `
  const ts = now()
  const dramaId = Number(db.insert(schema.dramas).values({ title: 'D', aspectRatio: '16:9', projectType: 'documentary', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({ dramaId, episodeNumber: 1, title: 'E', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
  const mk = (number, combo, continuity) => Number(db.insert(schema.storyboards).values({
    episodeId, storyboardNumber: number, combo, continuityBoundary: continuity || null,
    midFramePrompt: (number === 2 || number === 3) ? '中间帧提示词' : null,
    createdAt: ts, updatedAt: ts,
  }).run().lastInsertRowid)
  const sbC = mk(1, 'C', null)
  const sbD = mk(2, 'D', null)
  const sbDC = mk(3, 'D', 'continue')
  const sbB = mk(4, 'B', null)
  out({ episodeId, sbC, sbD, sbDC, sbB })
`

/**
 * 给某镜写入一段「已渲染」的图层段：签名与当前输入一致、衔接帧 PNG 真实落盘。
 * `hash` 由调用方给（测试里用固定串，便于断言）。
 */
function renderedSegment(sbId, hash) {
  return `
    const doc = normalizeLayerDoc({ version: 1, theme: 'archival', base: { path: 'static/uploads/base.png', width: 320, height: 180 }, layers: [] })
    const timeline = normalizeTimeline({ fps: 10, ease: 'inout', fade_ms: 100, keyframes: [{ t: 0, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: [] }, { t: 2, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: [] }] })
    const segment = await saveLayerSegment(${sbId}, { layer_doc: doc, timeline, duration: 2 })
    const [sbRow] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, ${sbId}))
    const spec = await resolveEpisodeSegmentSpec(sbRow.episodeId)
    const fs = await import('node:fs')
    const nodePath = await import('node:path')
    fs.mkdirSync(process.env.STORAGE_PATH + '/layer-frames', { recursive: true })
    fs.mkdirSync(process.env.STORAGE_PATH + '/layer-segments', { recursive: true })
    const junctionHash = '${hash}'
    const junctionPath = 'static/layer-frames/' + segment.id + '-' + junctionHash + '.png'
    fs.writeFileSync(nodePath.join(process.env.STORAGE_PATH, 'layer-frames', segment.id + '-' + junctionHash + '.png'), 'PNG')
    fs.writeFileSync(nodePath.join(process.env.STORAGE_PATH, 'layer-segments', 'seg.mp4'), 'MP4')
    await markSegmentRendered(segment.id, {
      render_path: 'static/layer-segments/seg.mp4',
      render_signature: layerSegmentSignatureOf(segment, spec, sbRow.combo),
      status: 'ready', junction_path: junctionPath, junction_hash: junctionHash,
    })
  `
}

test('C 组合：首帧锁定继承衔接帧（t=duration），列保持 NULL，mid/last 正常', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kf-lock-'))
  try {
    mkdirSync(path.join(dir, 'static', 'uploads'), { recursive: true })
    const env = { SQLITE_PATH: path.join(dir, 'db.sqlite3'), HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') }
    writeFileSync(path.join(dir, 'static', 'uploads', 'base.png'), 'PNG')
    const seeded = run(SEED, env)
    run(`${renderedSegment(String(seeded.sbC), 'h-abc')}
      out({ ok: true })
    `, env)

    const state = run(`
      const state = await loadStoryboardKeyframes(${seeded.sbC})
      const row = (await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, ${seeded.sbC})))[0]
      const junction = await junctionFrameOf(${seeded.sbC})
      out({ state, json: keyframesJson(state), firstColumn: row.firstFrameImage, junction })
    `, env)
    assert.deepEqual(state.state.lockedSlots, ['first'])
    assert.equal(state.state.locked.slot, 'first')
    assert.equal(state.state.locked.source, 'layer_last')
    assert.equal(state.state.locked.t, 2, '衔接帧时刻 = 段长（末帧/末尾停留画面）')
    assert.equal(state.state.locked.stale, false)
    assert.equal(state.state.first, state.state.locked.path, '生效首帧 = 衔接帧')
    assert.equal(state.json.first_image, state.state.locked.path)
    assert.equal(state.firstColumn, null, '锁定槽的列保持 NULL（衔接帧不写入槽位列）')
    assert.equal(state.state.ready, false, '尾帧还没有图 → 未就绪')
    assert.deepEqual(state.state.slotLocks.map(l => [l.slot, l.source]), [['first', 'layer_last']])
    assert.equal(state.junction.hash, 'h-abc')
    assert.equal(state.junction.source, 'layer_last')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('锁定槽写入被拒：PUT 与生成都抛 slot_locked；mid/last 放行', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kf-lock-'))
  try {
    mkdirSync(path.join(dir, 'static', 'uploads'), { recursive: true })
    const env = { SQLITE_PATH: path.join(dir, 'db.sqlite3'), HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') }
    writeFileSync(path.join(dir, 'static', 'uploads', 'base.png'), 'PNG')
    const seeded = run(SEED, env)
    run(`${renderedSegment(String(seeded.sbD), 'h-d')}
      out({ ok: true })
    `, env)
    const got = run(`
      const trySlot = async (sbId, slot) => {
        try { await assertSlotWritable(sbId, slot); return 'allowed' }
        catch (err) { return err instanceof SlotLockedError ? { code: err.code, slot: err.slot, message: err.message } : String(err) }
      }
      out({
        dFirst: await trySlot(${seeded.sbD}, 'first'),
        dMid: await trySlot(${seeded.sbD}, 'mid'),
        dLast: await trySlot(${seeded.sbD}, 'last'),
        bFirst: await trySlot(${seeded.sbB}, 'first'),
      })
    `, env)
    assert.equal(got.dFirst, 'allowed', 'D 组合首帧不受锁定（尾帧才是衔接帧）')
    assert.equal(got.dMid, 'allowed')
    assert.equal(got.dLast.code, 'slot_locked', 'D 组合尾帧被衔接帧锁定')
    assert.match(got.dLast.message, /衔接帧锁定继承/)
    assert.equal(got.bFirst, 'allowed', 'B 组合没有锁定槽')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('D + 承接：首尾双锁（首帧承接上一镜尾帧、尾帧衔接帧），仅 mid 可出图', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kf-lock-'))
  try {
    mkdirSync(path.join(dir, 'static', 'uploads'), { recursive: true })
    mkdirSync(path.join(dir, 'static', 'images'), { recursive: true })
    const env = { SQLITE_PATH: path.join(dir, 'db.sqlite3'), HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') }
    writeFileSync(path.join(dir, 'static', 'uploads', 'base.png'), 'PNG')
    // 上一镜尾帧文件必须真的在，否则按「没图」处理（生效图要求文件存在）
    writeFileSync(path.join(dir, 'static', 'images', 'prev-last.png'), 'PNG')
    const seeded = run(SEED, env)
    run(`
      await db.update(schema.storyboards).set({ lastFrameImage: 'static/images/prev-last.png' })
        .where(eq(schema.storyboards.id, ${seeded.sbD}))
      // A retained own-first slot must not defeat the explicit D + continue lock.
      await db.update(schema.storyboards).set({ firstFrameImage: 'static/uploads/base.png' })
        .where(eq(schema.storyboards.id, ${seeded.sbDC}))
      out({ ok: true })
    `, env)
    run(`${renderedSegment(String(seeded.sbDC), 'h-dc')}
      out({ ok: true })
    `, env)
    const got = run(`
      const state = await loadStoryboardKeyframes(${seeded.sbDC})
      const trySlot = async (slot) => {
        try { await assertSlotWritable(${seeded.sbDC}, slot); return 'allowed' }
        catch (err) { return err instanceof SlotLockedError ? { code: err.code, message: err.message } : String(err) }
      }
      out({ state, locks: state.slotLocks, first: await trySlot('first'), mid: await trySlot('mid'), last: await trySlot('last') })
    `, env)
    assert.deepEqual(got.state.lockedSlots, ['first', 'last'], 'D + 承接首尾双锁')
    assert.deepEqual(got.locks.map(l => [l.slot, l.source]), [
      ['first', 'previous_last'],
      ['last', 'layer_first'],
    ], '首帧锁的来源是上一镜尾帧，尾帧锁才是衔接帧')
    assert.equal(got.state.first, 'static/images/prev-last.png', '首帧 = 上一镜尾帧，不是图层段首帧')
    assert.equal(got.state.last, got.state.locked.path, '尾帧 = 衔接帧')
    assert.equal(got.first.code, 'slot_locked')
    assert.match(got.first.message, /承接上一镜尾帧/)
    assert.equal(got.mid, 'allowed', '只有中间帧可出图')
    assert.equal(got.last.code, 'slot_locked')
    assert.equal(got.state.midRequired, true, '有中间帧提示词 → 需要中间帧')
    assert.equal(got.state.ready, false, '中间帧还没出图 → 未就绪')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('衔接帧 hash 变化 → 关键帧确认作废并记 junction_updated；确认时快照 hash', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kf-lock-'))
  try {
    mkdirSync(path.join(dir, 'static', 'uploads'), { recursive: true })
    mkdirSync(path.join(dir, 'static', 'images'), { recursive: true })
    const env = { SQLITE_PATH: path.join(dir, 'db.sqlite3'), HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') }
    writeFileSync(path.join(dir, 'static', 'uploads', 'base.png'), 'PNG')
    writeFileSync(path.join(dir, 'static', 'images', 'last.png'), 'PNG')
    const seeded = run(SEED, env)
    run(`${renderedSegment(String(seeded.sbC), 'h-abc')}
      out({ ok: true })
    `, env)
    const got = run(`
      const sbId = ${seeded.sbC}
      // 先把尾帧图补上并确认
      await db.update(schema.storyboards).set({ lastFrameImage: 'static/images/last.png', keyframesConfirmed: true, keyframesJunctionHash: 'h-abc' }).where(eq(schema.storyboards.id, sbId))
      const before = await loadStoryboardKeyframes(sbId)
      // 衔接帧换了（重渲染后 hash 变）→ 作废
      await invalidateKeyframeConfirmation(sbId, 'junction_updated')
      const row = (await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sbId)))[0]
      const after = await loadStoryboardKeyframes(sbId)
      out({
        confirmedBefore: before.confirmed,
        readyBefore: before.ready,
        confirmedAfter: after.confirmed,
        staleReason: row.keyframesStaleReason,
        snapshot: row.keyframesJunctionHash,
        json: keyframesJson(after),
      })
    `, env)
    assert.equal(got.readyBefore, true, '锁定槽有衔接帧 + 尾帧有图 → 就绪')
    assert.equal(got.confirmedBefore, true)
    assert.equal(got.confirmedAfter, false, '衔接帧变了 → 确认作废')
    assert.equal(got.staleReason, 'junction_updated')
    assert.equal(got.json.stale_reason, 'junction_updated', 'API 形态带出原因（前端据此显示「衔接帧已更新」）')
    assert.equal(got.json.junction_hash, 'h-abc', '确认快照仍保留（供比对）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('衔接帧 stale（段未渲染 / 签名对不上）时锁定槽不就绪', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kf-lock-'))
  try {
    mkdirSync(path.join(dir, 'static', 'uploads'), { recursive: true })
    mkdirSync(path.join(dir, 'static', 'images'), { recursive: true })
    const env = { SQLITE_PATH: path.join(dir, 'db.sqlite3'), HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') }
    writeFileSync(path.join(dir, 'static', 'uploads', 'base.png'), 'PNG')
    // 尾帧文件真的在：这条用例要隔离「衔接帧 stale」这一个原因
    writeFileSync(path.join(dir, 'static', 'images', 'last.png'), 'PNG')
    const seeded = run(SEED, env)
    const got = run(`
      // C 镜只有一段草稿（从未渲染）：衔接帧不存在 → stale
      const doc = normalizeLayerDoc({ version: 1, theme: 'archival', base: { path: 'static/uploads/base.png', width: 320, height: 180 }, layers: [] })
      const timeline = normalizeTimeline({ fps: 10, keyframes: [{ t: 0, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: [] }] })
      await saveLayerSegment(${seeded.sbC}, { layer_doc: doc, timeline, duration: 2 })
      await db.update(schema.storyboards).set({ lastFrameImage: 'static/images/last.png' }).where(eq(schema.storyboards.id, ${seeded.sbC}))
      const state = await loadStoryboardKeyframes(${seeded.sbC})
      const junction = await junctionFrameOf(${seeded.sbC})
      out({
        locked: state.locked,
        ready: state.ready,
        first: state.first,
        junction,
      })
    `, env)
    assert.equal(got.junction.stale, true, '段未渲染 → 衔接帧 stale')
    assert.equal(got.locked.stale, true)
    assert.equal(got.first, null, '锁定槽没有可用的生效图')
    assert.equal(got.ready, false, '锁定槽不就绪 → 整镜未就绪')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('剧情镜头（combo=null）与 A/B 组合没有锁定槽，行为与 #58 之前一致', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kf-lock-'))
  try {
    mkdirSync(path.join(dir, 'static', 'uploads'), { recursive: true })
    mkdirSync(path.join(dir, 'static', 'images'), { recursive: true })
    const env = { SQLITE_PATH: path.join(dir, 'db.sqlite3'), HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') }
    writeFileSync(path.join(dir, 'static', 'uploads', 'base.png'), 'PNG')
    writeFileSync(path.join(dir, 'static', 'images', 'f.png'), 'PNG')
    writeFileSync(path.join(dir, 'static', 'images', 'l.png'), 'PNG')
    const seeded = run(SEED, env)
    const drama = run(`
      const dramaSb = Number(db.insert(schema.storyboards).values({
        episodeId: ${seeded.episodeId}, storyboardNumber: 9,
        firstFrameImage: 'static/images/f.png', lastFrameImage: 'static/images/l.png',
        createdAt: now(), updatedAt: now(),
      }).run().lastInsertRowid)
      out({ dramaSb })
    `, env)
    seeded.dramaSb = drama.dramaSb
    const got = run(`
      const a = await loadStoryboardKeyframes(${seeded.sbB})
      const drama = await loadStoryboardKeyframes(${seeded.dramaSb})
      out({
        b: { locked: a.locked, slots: a.lockedSlots, ready: a.ready, json: keyframesJson(a) },
        drama: { locked: drama.locked, slots: drama.lockedSlots, ready: drama.ready, json: keyframesJson(drama) },
      })
    `, env)
    assert.equal(got.b.locked, null)
    assert.deepEqual(got.b.slots, [])
    assert.equal(got.b.json.locked, null, '响应里 locked 为 null（验收 11：剧情项目字段不变）')
    assert.deepEqual(got.b.json.locked_slots, [])
    assert.equal(got.drama.locked, null)
    assert.deepEqual(got.drama.slots, [])
    assert.equal(got.drama.ready, true, '剧情项目的就绪口径不变（首尾都有图）')
    assert.equal(got.drama.json.stale_reason, null)
    void sharp
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * C 组合「首帧锁定 + 尾帧没图」必须是未就绪：页脚报「还缺：尾帧」、确认按钮禁用，
 * 后端 `POST /storyboards/:id/confirm-keyframes` 直接 400。
 * 列里残留一条文件已不在的死路径同样不算图（浏览器里那是破图，不是关键帧）。
 */
test('C 组合：首帧锁定 + 尾帧为空/文件丢失 → 未就绪且确认接口 400；补上尾帧才放行', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kf-lock-'))
  try {
    mkdirSync(path.join(dir, 'static', 'uploads'), { recursive: true })
    mkdirSync(path.join(dir, 'static', 'images'), { recursive: true })
    const env = { SQLITE_PATH: path.join(dir, 'db.sqlite3'), HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') }
    writeFileSync(path.join(dir, 'static', 'uploads', 'base.png'), 'PNG')
    const seeded = run(SEED, env)
    run(`${renderedSegment(String(seeded.sbC), 'h-ready')}
      out({ ok: true })
    `, env)

    const confirmCall = `
      const app = (await import('./src/routes/storyboards.ts')).default
      const confirm = async () => {
        const res = await app.request('/${seeded.sbC}/confirm-keyframes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirmed: true }),
        })
        return { status: res.status, body: await res.json() }
      }
    `
    // 1) 尾帧槽为空：衔接帧是新鲜的，但尾帧没出图
    const empty = run(`${confirmCall}
      const state = await loadStoryboardKeyframes(${seeded.sbC})
      const res = await confirm()
      const row = (await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, ${seeded.sbC})))[0]
      out({ json: keyframesJson(state), res, confirmedColumn: row.keyframesConfirmed })
    `, env)
    assert.equal(empty.json.locked.stale, false, '衔接帧新鲜（锁定槽本身就绪）')
    assert.equal(empty.json.first_image, empty.json.locked.path)
    assert.equal(empty.json.last_image, null, '尾帧没有图')
    assert.equal(empty.json.ready, false, '锁定槽就绪 ≠ 整镜就绪：尾帧仍然必填')
    assert.equal(empty.res.status, 400, '未就绪时确认接口必须 400')
    assert.match(empty.res.body.message, /未就绪/)
    assert.equal(empty.confirmedColumn, false, '400 时不写确认位')

    // 2) 尾帧列里有路径但文件不在：等同没图（否则前端是破图，确认却放行）
    const dangling = run(`${confirmCall}
      await db.update(schema.storyboards).set({ lastFrameImage: 'static/images/gone.png' }).where(eq(schema.storyboards.id, ${seeded.sbC}))
      const state = await loadStoryboardKeyframes(${seeded.sbC})
      const res = await confirm()
      out({ json: keyframesJson(state), res })
    `, env)
    assert.equal(dangling.json.last_image, null, '文件不在 → 生效尾帧为 null')
    assert.equal(dangling.json.ready, false)
    assert.equal(dangling.res.status, 400)

    // 3) 尾帧图真的落盘后才就绪，确认成功并快照衔接帧 hash
    writeFileSync(path.join(dir, 'static', 'images', 'gone.png'), 'PNG')
    const okRun = run(`${confirmCall}
      const state = await loadStoryboardKeyframes(${seeded.sbC})
      const res = await confirm()
      const row = (await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, ${seeded.sbC})))[0]
      out({ json: keyframesJson(state), res: { status: res.status }, confirmedColumn: row.keyframesConfirmed, hash: row.keyframesJunctionHash })
    `, env)
    assert.equal(okRun.json.last_image, 'static/images/gone.png')
    assert.equal(okRun.json.ready, true, '首帧（衔接帧）+ 尾帧都有图 → 就绪')
    assert.equal(okRun.res.status, 200)
    assert.equal(okRun.confirmedColumn, true)
    assert.equal(okRun.hash, 'h-ready', '确认时快照当前衔接帧 hash')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
