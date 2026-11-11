/**
 * 图层底图视觉验证（Issue #94，修改思路 2）的闸门行为。
 *
 * 真实 DB + 真实服务（临时 SQLite + 临时数据目录，仓库自带 tsx 子进程），
 * 断言可观察结果：视频批次预览的 blocked/reason、合成检查的 ok/reason、
 * 验证签名对裁切与文字图层的敏感度，以及加列迁移的幂等。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(body, env) {
  const script = `
    import { db, schema, initDb } from './src/db/index.ts'
    import { eq } from 'drizzle-orm'
    import { now } from './src/utils/response.ts'
    import {
      saveLayerSegment, markSegmentRendered, getLayerSegment,
      resolveEpisodeSegmentSpec, layerSegmentSignatureOf,
    } from './src/services/layer-segment.ts'
    import {
      baseCheckRequired, baseCheckSatisfied, baseCheckBlockReason,
      layerBaseCheckSignatureOf, writeLayerBaseCheck, overrideLayerBaseCheck,
    } from './src/services/layer-base-check.ts'
    import { normalizeLayerDoc } from './src/services/layer-doc.ts'
    import { normalizeTimeline } from './src/services/segment-timeline.ts'
    import { previewEpisodeVideoBatch } from './src/services/video-batch.ts'
    import { inspectComposeInputs } from './src/services/compose-state.ts'
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

/** 纪录片一集三镜：C（底图带裁切）、C（比例一致无裁切）、A（整镜由图层段替代，没有衔接帧） */
const SEED = `
  const ts = now()
  const dramaId = Number(db.insert(schema.dramas).values({ title: 'D', aspectRatio: '16:9', projectType: 'documentary', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({ dramaId, episodeNumber: 1, title: 'E', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
  const mk = (number, combo) => Number(db.insert(schema.storyboards).values({
    episodeId, storyboardNumber: number, combo, designCardStatus: 'confirmed',
    createdAt: ts, updatedAt: ts,
  }).run().lastInsertRowid)
  out({ dramaId, episodeId, cropped: mk(1, 'C'), plain: mk(2, 'C'), replaced: mk(3, 'A') })
`

/** 已渲染的图层段：crop 决定是否需要底图验证 */
function renderedSegment(sbId, { crop }) {
  return `
    const doc = normalizeLayerDoc({
      version: 1, theme: 'archival',
      base: { path: 'static/uploads/base.png', width: 1920, height: 1088, source_width: 1920, source_height: 1088${crop ? `, crop: ${JSON.stringify(crop)}` : ''} },
      layers: [{ id: 'l1', type: 'label', name: '标签', text: '甲', at: [0.5, 0.5] }],
    })
    const timeline = normalizeTimeline({ fps: 10, ease: 'inout', fade_ms: 100, keyframes: [
      { t: 0, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: ['l1'] },
      { t: 2, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: ['l1'] },
    ] })
    const segment = await saveLayerSegment(${sbId}, { layer_doc: doc, timeline, duration: 2 })
    const [sbRow] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, ${sbId}))
    const spec = await resolveEpisodeSegmentSpec(sbRow.episodeId)
    const fs = await import('node:fs')
    fs.mkdirSync(process.env.STORAGE_PATH + '/layer-frames', { recursive: true })
    fs.mkdirSync(process.env.STORAGE_PATH + '/layer-segments', { recursive: true })
    const junctionHash = 'h-${sbId}'
    const junctionPath = 'static/layer-frames/' + segment.id + '-' + junctionHash + '.png'
    fs.writeFileSync(process.env.STORAGE_PATH + '/layer-frames/' + segment.id + '-' + junctionHash + '.png', 'PNG')
    fs.writeFileSync(process.env.STORAGE_PATH + '/layer-segments/seg-${sbId}.mp4', 'MP4')
    await markSegmentRendered(segment.id, {
      render_path: 'static/layer-segments/seg-${sbId}.mp4',
      render_signature: layerSegmentSignatureOf(segment, spec, sbRow.combo),
      status: 'ready', junction_path: junctionPath, junction_hash: junctionHash,
    })
  `
}

/** 写入一条指定状态的验证结论（签名取当前输入，模拟模型刚刚跑完） */
function storeCheck(sbId, status, extra = {}) {
  return `
    {
      const segment = await getLayerSegment(${sbId})
      const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, ${sbId}))
      const spec = await resolveEpisodeSegmentSpec(row.episodeId)
      await writeLayerBaseCheck(segment.id, {
        required: true, signature: layerBaseCheckSignatureOf(segment, spec),
        status: '${status}', problems: ${JSON.stringify(extra.problems || [])}, notes: null,
        task_id: 77, config_id: 10, model: 'vlm', checked_at: now(),
        override_reason: null, error: ${extra.error ? JSON.stringify(extra.error) : 'null'},
      })
    }
  `
}

function prepare() {
  const dir = mkdtempSync(path.join(tmpdir(), 'base-check-'))
  mkdirSync(path.join(dir, 'static', 'uploads'), { recursive: true })
  writeFileSync(path.join(dir, 'static', 'uploads', 'base.png'), 'PNG-BYTES')
  const env = { SQLITE_PATH: path.join(dir, 'db.sqlite3'), HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') }
  const seeded = run(SEED, env)
  return { dir, env, seeded }
}

test('裁切底图：未验证 / 未通过时阻断视频批次预览与合成，通过或人工放行后放行', () => {
  const { dir, env, seeded } = prepare()
  try {
    run(`${renderedSegment(String(seeded.cropped), { crop: { x: 0, y: 0, w: 0.5, h: 1 } })}
      out({ ok: true })
    `, env)

    const pending = run(`
      const segment = await getLayerSegment(${seeded.cropped})
      const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, ${seeded.cropped}))
      const spec = await resolveEpisodeSegmentSpec(row.episodeId)
      const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, row.episodeId))
      const items = await previewEpisodeVideoBatch(${seeded.episodeId}, { storyboardIds: [${seeded.cropped}] })
      const compose = await inspectComposeInputs(row, ep, { t: 0, source: 'none' })
      out({
        required: baseCheckRequired(segment.layer_doc, spec),
        satisfied: baseCheckSatisfied(segment, spec),
        item: items[0], compose: { ok: compose.ok, reason: compose.reason },
      })
    `, env)
    assert.equal(pending.required, true, '有裁切 → 必须做底图视觉验证')
    assert.equal(pending.satisfied, false, '从未验证 → 不满足')
    assert.equal(pending.item.status, 'blocked')
    assert.equal(pending.item.reason, '图层底图待视觉验证')
    assert.equal(pending.compose.ok, false)
    assert.match(pending.compose.reason, /图层底图待视觉验证/)

    // 显式写入的 pending（任务已起但还没结论）与 error（没有视觉配置 / 调用失败）
    const pendingRow = run(`${storeCheck(seeded.cropped, 'pending')}
      const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, ${seeded.cropped}))
      const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, row.episodeId))
      const items = await previewEpisodeVideoBatch(${seeded.episodeId}, { storyboardIds: [${seeded.cropped}] })
      const compose = await inspectComposeInputs(row, ep, { t: 0, source: 'none' })
      out({ item: items[0], compose: { ok: compose.ok, reason: compose.reason } })
    `, env)
    assert.equal(pendingRow.item.status, 'blocked')
    assert.equal(pendingRow.item.reason, '图层底图待视觉验证')
    assert.equal(pendingRow.compose.ok, false)
    assert.match(pendingRow.compose.reason, /图层底图待视觉验证/)

    const errored = run(`${storeCheck(seeded.cropped, 'error', { error: '没有可用的视觉配置' })}
      const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, ${seeded.cropped}))
      const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, row.episodeId))
      const items = await previewEpisodeVideoBatch(${seeded.episodeId}, { storyboardIds: [${seeded.cropped}] })
      const compose = await inspectComposeInputs(row, ep, { t: 0, source: 'none' })
      out({ item: items[0], compose: { ok: compose.ok, reason: compose.reason } })
    `, env)
    assert.equal(errored.item.reason, '图层底图视觉验证未通过：没有可用的视觉配置', 'error 绝不放行')
    assert.equal(errored.compose.ok, false)
    assert.match(errored.compose.reason, /图层底图视觉验证未通过：没有可用的视觉配置/)

    const failed = run(`${storeCheck(seeded.cropped, 'failed', { problems: ['城楼顶部被画面上沿切掉'] })}
      const items = await previewEpisodeVideoBatch(${seeded.episodeId}, { storyboardIds: [${seeded.cropped}] })
      const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, ${seeded.cropped}))
      const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, row.episodeId))
      const compose = await inspectComposeInputs(row, ep, { t: 0, source: 'none' })
      out({ item: items[0], compose: { ok: compose.ok, reason: compose.reason } })
    `, env)
    assert.equal(failed.item.status, 'blocked')
    assert.equal(failed.item.reason, '图层底图视觉验证未通过：城楼顶部被画面上沿切掉')
    assert.equal(failed.compose.ok, false)
    assert.match(failed.compose.reason, /图层底图视觉验证未通过：城楼顶部被画面上沿切掉/)

    const passed = run(`${storeCheck(seeded.cropped, 'passed')}
      const segment = await getLayerSegment(${seeded.cropped})
      const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, ${seeded.cropped}))
      const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, row.episodeId))
      const spec = await resolveEpisodeSegmentSpec(row.episodeId)
      const items = await previewEpisodeVideoBatch(${seeded.episodeId}, { storyboardIds: [${seeded.cropped}] })
      const compose = await inspectComposeInputs(row, ep, { t: 0, source: 'none' })
      out({
        satisfied: baseCheckSatisfied(segment, spec), reason: baseCheckBlockReason(segment, spec),
        item: items[0], compose: { ok: compose.ok, reason: compose.reason },
      })
    `, env)
    assert.equal(passed.satisfied, true)
    assert.equal(passed.reason, null)
    assert.doesNotMatch(String(passed.item.reason), /图层底图/, 'passed 之后不再因底图验证被拦（余下是关键帧等常规闸门）')
    assert.doesNotMatch(String(passed.compose.reason || ''), /图层底图/, '合成同样不再因底图验证失败')

    const overridden = run(`
      await overrideLayerBaseCheck(${seeded.cropped}, '人工看图确认主体完整')
      const segment = await getLayerSegment(${seeded.cropped})
      const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, ${seeded.cropped}))
      const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, row.episodeId))
      const spec = await resolveEpisodeSegmentSpec(row.episodeId)
      const items = await previewEpisodeVideoBatch(${seeded.episodeId}, { storyboardIds: [${seeded.cropped}] })
      const compose = await inspectComposeInputs(row, ep, { t: 0, source: 'none' })
      let refused = null
      try { await overrideLayerBaseCheck(${seeded.cropped}, '   ') } catch (err) { refused = err.message }
      out({
        check: segment.base_check, satisfied: baseCheckSatisfied(segment, spec),
        item: items[0], compose: { ok: compose.ok, reason: compose.reason }, refused,
      })
    `, env)
    assert.equal(overridden.check.status, 'overridden')
    assert.equal(overridden.check.override_reason, '人工看图确认主体完整')
    assert.ok(overridden.check.checked_at, '放行要记时间')
    assert.equal(overridden.satisfied, true)
    assert.doesNotMatch(String(overridden.item.reason), /图层底图/)
    assert.doesNotMatch(String(overridden.compose.reason || ''), /图层底图/)
    assert.match(overridden.refused, /理由/, '空理由的人工放行必须被拒绝')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A 组合（没有衔接帧）同样被拦：预览报底图原因而不是「无生成段」，通过后恢复 excluded', () => {
  const { dir, env, seeded } = prepare()
  try {
    run(`${renderedSegment(String(seeded.replaced), { crop: { x: 0.1, y: 0, w: 0.5, h: 1 } })}
      out({ ok: true })
    `, env)
    const blocked = run(`
      const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, ${seeded.replaced}))
      const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, row.episodeId))
      const items = await previewEpisodeVideoBatch(${seeded.episodeId}, { storyboardIds: [${seeded.replaced}] })
      const compose = await inspectComposeInputs(row, ep, { t: 0, source: 'none' })
      out({ item: items[0], compose: { ok: compose.ok, reason: compose.reason } })
    `, env)
    assert.equal(blocked.item.status, 'blocked')
    assert.equal(blocked.item.reason, '图层底图待视觉验证')
    assert.equal(blocked.compose.ok, false)
    assert.match(blocked.compose.reason, /图层底图待视觉验证/)

    const allowed = run(`${storeCheck(seeded.replaced, 'passed')}
      const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, ${seeded.replaced}))
      const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, row.episodeId))
      const items = await previewEpisodeVideoBatch(${seeded.episodeId}, { storyboardIds: [${seeded.replaced}] })
      const compose = await inspectComposeInputs(row, ep, { t: 0, source: 'none' })
      out({ item: items[0], compose: { ok: compose.ok, reason: compose.reason } })
    `, env)
    assert.equal(allowed.item.status, 'excluded', 'A 组合本来就不生成视频')
    assert.equal(allowed.item.reason, 'no_generated_segment')
    assert.doesNotMatch(String(allowed.compose.reason || ''), /图层底图/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('底图比例与成片一致且无裁切：不需要验证，闸门不受影响', () => {
  const { dir, env, seeded } = prepare()
  try {
    run(`${renderedSegment(String(seeded.plain), { crop: null })}
      out({ ok: true })
    `, env)
    const got = run(`
      const segment = await getLayerSegment(${seeded.plain})
      const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, ${seeded.plain}))
      const spec = await resolveEpisodeSegmentSpec(row.episodeId)
      const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, row.episodeId))
      const items = await previewEpisodeVideoBatch(${seeded.episodeId}, { storyboardIds: [${seeded.plain}] })
      const compose = await inspectComposeInputs(row, ep, { t: 0, source: 'none' })
      out({
        required: baseCheckRequired(segment.layer_doc, spec),
        satisfied: baseCheckSatisfied(segment, spec),
        reason: baseCheckBlockReason(segment, spec),
        item: items[0], compose: { ok: compose.ok, reason: compose.reason },
      })
    `, env)
    assert.equal(got.required, false, '比例一致且无裁切 → 不需要验证')
    assert.equal(got.satisfied, true)
    assert.equal(got.reason, null)
    assert.doesNotMatch(String(got.item.reason), /图层底图/)
    assert.doesNotMatch(String(got.compose.reason || ''), /图层底图/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('验证签名：裁切改变即作废，文字图层改动不作废', () => {
  const { dir, env, seeded } = prepare()
  try {
    run(`${renderedSegment(String(seeded.cropped), { crop: { x: 0, y: 0, w: 0.5, h: 1 } })}
      out({ ok: true })
    `, env)
    const got = run(`${storeCheck(seeded.cropped, 'passed')}
      const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, ${seeded.cropped}))
      const spec = await resolveEpisodeSegmentSpec(row.episodeId)
      const before = await getLayerSegment(${seeded.cropped})
      const baseSignature = layerBaseCheckSignatureOf(before, spec)

      // 只改文字：验证签名不变，结论继续有效
      const textDoc = JSON.parse(JSON.stringify(before.layer_doc))
      textDoc.layers[0].text = '乙'
      await saveLayerSegment(${seeded.cropped}, { layer_doc: textDoc })
      const afterText = await getLayerSegment(${seeded.cropped})
      const textSignature = layerBaseCheckSignatureOf(afterText, spec)

      // 改裁切：验证签名变化，旧结论作废
      const cropDoc = JSON.parse(JSON.stringify(afterText.layer_doc))
      cropDoc.base.crop = { x: 0.2, y: 0, w: 0.5, h: 1 }
      await saveLayerSegment(${seeded.cropped}, { layer_doc: cropDoc })
      const afterCrop = await getLayerSegment(${seeded.cropped})
      const cropSignature = layerBaseCheckSignatureOf(afterCrop, spec)

      out({
        baseSignature, textSignature, cropSignature,
        textSatisfied: baseCheckSatisfied(afterText, spec),
        cropSatisfied: baseCheckSatisfied(afterCrop, spec),
        cropReason: baseCheckBlockReason(afterCrop, spec),
      })
    `, env)
    assert.equal(got.textSignature, got.baseSignature, '文字图层不进底图验证签名')
    assert.equal(got.textSatisfied, true, '只改文案不该让底图重新验证')
    assert.notEqual(got.cropSignature, got.baseSignature, '裁切变了 → 验证签名变')
    assert.equal(got.cropSatisfied, false)
    assert.equal(got.cropReason, '图层底图待视觉验证')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('base_check 加列迁移幂等：重复初始化不报错、已有结论不丢', () => {
  const { dir, env, seeded } = prepare()
  try {
    run(`${renderedSegment(String(seeded.cropped), { crop: { x: 0, y: 0, w: 0.5, h: 1 } })}
      out({ ok: true })
    `, env)
    const got = run(`${storeCheck(seeded.cropped, 'passed')}
      initDb()
      initDb()
      const columns = db.$client.prepare("PRAGMA table_info(storyboard_layer_segments)").all()
      const segment = await getLayerSegment(${seeded.cropped})
      out({
        columns: columns.filter(col => col.name === 'base_check').length,
        status: segment.base_check?.status || null,
      })
    `, env)
    assert.equal(got.columns, 1, '重复启动只保留一列 base_check')
    assert.equal(got.status, 'passed', '迁移不影响已有结论')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
