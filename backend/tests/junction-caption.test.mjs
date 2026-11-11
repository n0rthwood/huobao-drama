/**
 * 锁定衔接帧（Issue #95）的行为验收。
 *
 * 真实 DB + 真实服务 + 本地脚本化的 OpenAI 兼容视觉模型（与图层底图验证同一条通路），
 * 断言的是可观察结果：
 * - C/D 的上下文带 `locked_frames`（槽位/来源/底图/取景），A/B 不带；
 * - 衔接帧画面描述按 `junction_hash` 缓存：第二次读不调模型，hash 变了才重算；
 * - 描述调用挂在发起它的任务观测里（stage `junction_caption`）；
 * - 视频提示词批次在 Agent 开跑前算好描述，并把锁定槽位与 caption 写进话术；
 * - 保存校验只拦 C 的首段 / D 的末段切镜（zh/en 与 `0-2.5秒:`、`0–3 s:` 等写法都认），
 *   A/B 与剧情镜头不受影响；被退回的提示词一个字都不落库。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mockFixture = `file://${backendRoot}/tests/fixtures/mock-openai-chat.mjs`

function run(body, env) {
  const script = `
    import { initDb, db, schema, getInsertId } from './src/db/index.ts'
    import { eq } from 'drizzle-orm'
    import { now } from './src/utils/response.ts'
    import { normalizeLayerDoc } from './src/services/layer-doc.ts'
    import { normalizeTimeline } from './src/services/segment-timeline.ts'
    import {
      saveLayerSegment, markSegmentRendered, getLayerSegment,
      layerSegmentSignatureOf, resolveEpisodeSegmentSpec,
    } from './src/services/layer-segment.ts'
    import { writeLayerBaseCheck, layerBaseCheckSignatureOf } from './src/services/layer-base-check.ts'
    import {
      lockedFramesOfEpisode, ensureJunctionCaption, junctionPromptRejections, junctionPromptReasons,
    } from './src/services/junction-caption.ts'
    import { storyboardTools } from './src/agents/tools/storyboard-tools.ts'
    import { buildAgentRequestContext } from './src/agents/context.ts'
    import { createTextTask, finishTextTask } from './src/services/text-task.ts'
    import { runWithTextTask } from './src/services/text-task-context.ts'
    import { listObservedWork, listObservedCalls } from './src/services/task-observability.ts'
    import { startVideoPromptBatch, getVideoPromptBatchStatus } from './src/services/video-prompts.ts'
    import { startMockOpenAIChat, toolResults, userText } from '${mockFixture}'
    import { getAbsolutePath } from './src/utils/storage.ts'
    import { createRequire } from 'node:module'
    import path from 'node:path'
    const require = createRequire('file://${backendRoot}/package.json')
    const sharp = require('sharp')
    const fs = require('node:fs')
    initDb()
    const out = (value) => console.log('@@' + JSON.stringify(value))
    ${body}
  `
  const text = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 240_000,
  })
  return JSON.parse(text.slice(text.lastIndexOf('@@') + 2))
}

/**
 * 一集六镜：C（含留白：方形底图）、C（裁切）、D（推近）、D（整图）、A、B。
 * 只有前四镜有图层段与渲染好的衔接帧；A 有段但整镜由图层段替代，B 没有段。
 */
const SEED = `
  const ts = now()
  const dramaId = getInsertId(await db.insert(schema.dramas).values({
    title: 'D', aspectRatio: '16:9', projectType: 'documentary', createdAt: ts, updatedAt: ts,
  }))
  const episodeId = getInsertId(await db.insert(schema.episodes).values({
    dramaId, episodeNumber: 1, title: 'E', scriptContent: '甲。乙。', createdAt: ts, updatedAt: ts,
  }))
  const sceneId = getInsertId(await db.insert(schema.scenes).values({
    dramaId, location: '大殿', time: '夜', prompt: '', createdAt: ts, updatedAt: ts,
  }))
  const mk = async (number, combo) => getInsertId(await db.insert(schema.storyboards).values({
    episodeId, storyboardNumber: number, combo, designCardStatus: 'confirmed', createdAt: ts, updatedAt: ts,
  }))
  const ids = {
    contain: await mk(1, 'C'), crop: await mk(2, 'C'),
    zoomed: await mk(3, 'D'), full: await mk(4, 'D'),
    layerOnly: await mk(5, 'A'), generated: await mk(6, 'B'),
  }
  out({ dramaId, episodeId, sceneId, ids })
`

/** 一镜的图层段：底图、取景、渲染好的衔接帧 PNG；需要底图验证的镜子直接记通过 */
const SEGMENTS = `
  const png = async (file, color, width, height) => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer()
  const write = async (rel, color, width = 1920, height = 1080) => {
    const abs = getAbsolutePath(rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, await png(rel, color, width, height))
  }
  const baseDoc = (path_, width, height, crop) => ({
    path: path_, width, height, source_width: width, source_height: height, ...(crop ? { crop } : {}),
  })
  const prepare = async (sbId, combo, base, viewportAt0, viewportAtEnd, baseRef) => {
    const doc = normalizeLayerDoc({ version: 1, theme: 'archival', base, layers: [] })
    const timeline = normalizeTimeline({ fps: 10, ease: 'linear', fade_ms: 100, keyframes: [
      { t: 0, viewport: viewportAt0, visible: [] },
      { t: 2, viewport: viewportAtEnd, visible: [] },
    ] })
    const segment = await saveLayerSegment(sbId, { layer_doc: doc, timeline, duration: 4, base_ref: baseRef || null })
    const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sbId))
    const spec = await resolveEpisodeSegmentSpec(row.episodeId)
    const hash = 'h-' + sbId + '-a'
    const rel = 'static/layer-frames/' + segment.id + '-' + hash + '.png'
    await write(rel, { r: (sbId * 37) % 256, g: 40, b: 60 }, 64, 64)
    fs.mkdirSync(path.dirname(getAbsolutePath('static/layer-segments/seg-' + sbId + '.mp4')), { recursive: true })
    fs.writeFileSync(getAbsolutePath('static/layer-segments/seg-' + sbId + '.mp4'), 'MP4')
    await markSegmentRendered(segment.id, {
      render_path: 'static/layer-segments/seg-' + sbId + '.mp4',
      render_signature: layerSegmentSignatureOf(segment, spec, row.combo),
      status: 'ready',
      junction_path: rel,
      junction_hash: hash,
    })
    return segment.id
  }
  /** 底图有裁切 / 留白时必须先过底图视觉验证，否则衔接帧被判未就绪（#94） */
  const passBaseCheck = async (sbId) => {
    const segment = await getLayerSegment(sbId)
    const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sbId))
    const spec = await resolveEpisodeSegmentSpec(row.episodeId)
    await writeLayerBaseCheck(segment.id, {
      required: true, signature: layerBaseCheckSignatureOf(segment, spec),
      status: 'passed', problems: [], notes: null, task_id: null, config_id: null, model: null,
      checked_at: now(), override_reason: null, error: null,
    })
  }
`

const seedAndPrepare = (seeded) => `
  await write('static/uploads/square.png', { r: 20, g: 30, b: 40 }, 1024, 1024)
  await write('static/uploads/wide.png', { r: 50, g: 40, b: 30 }, 1920, 1080)
  const square = baseDoc('static/uploads/square.png', 1024, 1024)
  const wide = baseDoc('static/uploads/wide.png', 1920, 1080)
  const cropped = baseDoc('static/uploads/wide.png', 1920, 1080, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 })
  const full = { x: 0, y: 0, w: 1, h: 1 }
  const zoom = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }
  await prepare(${seeded.ids.contain}, 'C', square, full, full, { kind: 'asset', asset_kind: 'scene', asset_id: ${seeded.sceneId} })
  await passBaseCheck(${seeded.ids.contain})
  await prepare(${seeded.ids.crop}, 'C', cropped, full, full, null)
  await passBaseCheck(${seeded.ids.crop})
  await prepare(${seeded.ids.zoomed}, 'D', wide, zoom, zoom, null)
  await prepare(${seeded.ids.full}, 'D', wide, full, full, { kind: 'inherit_prev' })
  await prepare(${seeded.ids.layerOnly}, 'A', wide, full, full, null)
  out({ ok: true })
`

function prepare() {
  const dir = mkdtempSync(path.join(tmpdir(), 'junction-caption-'))
  const env = {
    SQLITE_PATH: path.join(dir, 'db.sqlite3'),
    HUOBAO_DATA_DIR: dir,
    STORAGE_PATH: path.join(dir, 'static'),
  }
  mkdirSync(path.join(dir, 'static'), { recursive: true })
  const seeded = run(SEED, env)
  run(`${SEGMENTS}${seedAndPrepare(seeded)}`, env)
  return { dir, env, seeded }
}

test('C/D 的上下文带锁定衔接帧，A/B 不带；描述按 junction_hash 缓存并计入任务观测', () => {
  const { dir, env, seeded } = prepare()
  try {
    const got = run(`${SEGMENTS}
      let n = 0
      const mock = await startMockOpenAIChat(async (body) => {
        if (JSON.stringify(body.messages).includes('image_url')) {
          n += 1
          return { text: JSON.stringify({ caption: '画面描述 ' + n }) }
        }
        return { text: 'ok' }
      })
      await db.insert(schema.aiServiceConfigs).values({
        serviceType: 'text', provider: 'openai', name: 'mock vision', baseUrl: mock.baseUrl,
        apiKey: 'not-a-credential', model: '["mock-vision"]', isActive: true, vision: true,
        createdAt: now(), updatedAt: now(),
      })

      // 1) 只读上下文：四个 C/D 镜带 locked_frames，A/B 不带，且一次模型都不调
      const before = await lockedFramesOfEpisode(${seeded.episodeId})
      const beforeRequests = mock.requests.length

      // 2) 任务内确保描述（观测窗口），第二次读命中缓存
      const taskId = await createTextTask({
        kind: 'video_prompts', episodeId: ${seeded.episodeId}, dramaId: ${seeded.dramaId}, queued: true,
      })
      const first = await runWithTextTask(taskId, () => ensureJunctionCaption(${seeded.ids.contain}, { taskId, storyboardNumber: 1 }))
      await finishTextTask(taskId, 'completed', { outputText: 'done' })
      const afterFirst = mock.requests.length
      const second = await ensureJunctionCaption(${seeded.ids.contain}, { storyboardNumber: 1 })
      const afterSecond = mock.requests.length
      const work = listObservedWork(taskId).filter(row => row.stage === 'junction_caption')
      const calls = listObservedCalls(taskId)

      // 3) 上下文读的是同一份缓存，不额外调模型
      const cached = await lockedFramesOfEpisode(${seeded.episodeId})
      // 3b) 工具返回本身（read_storyboard_context）逐镜带 locked_frames
      const ctx = { requestContext: buildAgentRequestContext({ episodeId: ${seeded.episodeId}, dramaId: ${seeded.dramaId} }) }
      const contextPayload = await storyboardTools.readStoryboardContext.execute({}, ctx)
      const contextShots = contextPayload.existing_storyboards.map(sb => ({ id: sb.id, combo: sb.combo, locked: sb.locked_frames }))
      const afterContext = mock.requests.length

      // 4) 另一个 D 镜：不同衔接帧各算一次
      const zoomedFirst = await ensureJunctionCaption(${seeded.ids.zoomed}, { storyboardNumber: 3 })

      // 5) 衔接帧重渲（hash 变了）：旧描述作废，重新描述；再读时又命中
      const segment = await getLayerSegment(${seeded.ids.zoomed})
      const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, ${seeded.ids.zoomed}))
      const spec = await resolveEpisodeSegmentSpec(row.episodeId)
      const newHash = 'h-' + ${seeded.ids.zoomed} + '-b'
      const newRel = 'static/layer-frames/' + segment.id + '-' + newHash + '.png'
      await write(newRel, { r: 200, g: 10, b: 90 }, 64, 64)
      await markSegmentRendered(segment.id, {
        render_path: segment.render_path, render_signature: layerSegmentSignatureOf(segment, spec, 'D'),
        status: 'ready', junction_path: newRel, junction_hash: newHash,
      })
      const staleRead = await lockedFramesOfEpisode(${seeded.episodeId})
      const zoomedSecond = await ensureJunctionCaption(${seeded.ids.zoomed}, { storyboardNumber: 3 })

      out({
        beforeRequests,
        before: [...before].map(([id, frames]) => ({ id, frames })),
        first, second, afterFirst, afterSecond, afterContext,
        cachedCaption: (cached.get(${seeded.ids.contain}) || [])[0]?.caption ?? null,
        contextShots,
        work: work.map(row => ({ stage: row.stage, status: row.status, call_count: row.call_count })),
        calls: calls.map(call => ({ kind: call.kind, status: call.status })),
        zoomedFirst, zoomedSecond,
        staleCaption: (staleRead.get(${seeded.ids.zoomed}) || [])[0]?.caption ?? null,
        staleNote: (staleRead.get(${seeded.ids.zoomed}) || [])[0]?.caption_note ?? null,
        requests: mock.requests.length,
      })
      await mock.close()
    `, env)

    // 只读上下文：四个 C/D 镜带锁定槽位，A/B 一条都没有
    const byId = new Map(got.before.map(item => [item.id, item.frames]))
    assert.deepEqual([...byId.keys()].sort((a, b) => a - b), [
      seeded.ids.contain, seeded.ids.crop, seeded.ids.zoomed, seeded.ids.full,
    ].sort((a, b) => a - b), 'A/B 不出现 locked_frames')
    const contain = byId.get(seeded.ids.contain)[0]
    assert.deepEqual(
      { slot: contain.slot, source: contain.source, framing: contain.framing },
      { slot: 'first', source: 'layer_last', framing: 'contain' },
    )
    assert.deepEqual(contain.base, { kind: 'asset', asset_kind: 'scene', asset_id: seeded.sceneId, name: '大殿 · 夜' })
    assert.equal(contain.caption, null, '还没算过的描述必须是 null，不能编')
    assert.match(contain.caption_note, /尚未计算/)
    assert.equal(byId.get(seeded.ids.crop)[0].framing, 'crop')
    assert.equal(byId.get(seeded.ids.zoomed)[0].framing, 'zoomed')
    assert.deepEqual(
      { slot: byId.get(seeded.ids.zoomed)[0].slot, source: byId.get(seeded.ids.zoomed)[0].source },
      { slot: 'last', source: 'layer_first' },
    )
    assert.equal(byId.get(seeded.ids.full)[0].framing, 'full')
    assert.deepEqual(byId.get(seeded.ids.full)[0].base, { kind: 'inherit_prev' })
    assert.equal(got.beforeRequests, 0, '读上下文不调视觉模型（描述只在视频提示词批次里算）')

    // 描述：第一次调模型，第二次命中缓存
    assert.equal(got.first.called, true)
    assert.equal(got.first.caption, '画面描述 1')
    assert.equal(got.afterFirst, 1)
    assert.equal(got.second.called, false, '同一 junction hash 第二次不调模型')
    assert.equal(got.second.caption, '画面描述 1')
    assert.equal(got.afterSecond, 1)
    assert.equal(got.cachedCaption, '画面描述 1', '上下文读到同一份缓存')
    assert.equal(got.afterContext, 1, '上下文读缓存不额外调模型')
    // read_storyboard_context 的工具返回逐镜带 locked_frames：C/D 有，A/B 是空数组
    const contextById = new Map(got.contextShots.map(item => [item.id, item]))
    const ctxContain = contextById.get(seeded.ids.contain).locked
    assert.equal(ctxContain.length, 1)
    assert.deepEqual(
      { slot: ctxContain[0].slot, source: ctxContain[0].source, framing: ctxContain[0].framing, caption: ctxContain[0].caption },
      { slot: 'first', source: 'layer_last', framing: 'contain', caption: '画面描述 1' },
    )
    assert.deepEqual(contextById.get(seeded.ids.layerOnly).locked, [], 'A 组合不带 locked_frames')
    assert.deepEqual(contextById.get(seeded.ids.generated).locked, [], 'B 组合不带 locked_frames')

    // 观测：描述调用挂在发起它的任务上
    assert.deepEqual(got.work, [{ stage: 'junction_caption', status: 'completed', call_count: 1 }])
    assert.deepEqual(got.calls, [{ kind: 'vision_chat', status: 'completed' }])

    // 不同衔接帧各算一次；hash 变了旧描述作废并重算
    assert.equal(got.zoomedFirst.called, true)
    assert.equal(got.zoomedFirst.caption, '画面描述 2')
    assert.equal(got.staleCaption, null, 'hash 对不上的旧描述不能拿来用')
    assert.match(got.staleNote, /尚未计算/)
    assert.equal(got.zoomedSecond.called, true)
    assert.equal(got.zoomedSecond.caption, '画面描述 3')
    assert.equal(got.requests, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('C 的首段 / D 的末段不许切镜：zh/en 与多种时间写法都退回，A/B 与合规提示词放行', () => {
  const { dir, env, seeded } = prepare()
  try {
    const got = run(`${SEGMENTS}
      const containTitle = '出场人物：@甲；场景：@大殿。'
      // 合规：首段复述衔接帧构图，切镜挪到第二段
      const compliant = containTitle + '\\n0-1秒：俯拍全景，大殿殿脊占画面下方三分之二，上方留白，画面无人。\\n1-4秒：@甲 从画面右侧入画，右手扶柱，双腿站定。\\n4-7秒：切到殿门特写，@甲 推门。'
      // 违规（zh）：首段就切镜
      const cutFirstZh = containTitle + '\\n0-3秒：切到殿门全景，@甲 推门走入。\\n3-6秒：@甲 停在阶前。'
      // 违规（en）：首段 cut to
      const cutFirstEn = 'Characters: @Jia; Scene: @Hall.\\n0-3s: cut to the gate, wide shot.\\n3-6s: he stops.'
      // 违规（半秒写法 / en dash）
      const cutHalf = containTitle + '\\n0-2.5秒: 切回殿前，@甲 抬头。\\n2.5-6秒：@甲 站在阶前。'
      const cutEnDash = 'Characters: @Jia; Scene: @Hall.\\n0–3 s: cut to the gate, wide.\\n3-6s: he walks.'
      // D：首段切镜可以，末段不许
      const dCutFirstOk = '出场人物：@甲；场景：@大殿。\\n0-3秒：切到殿门全景，@甲 推门走入。\\n3-6秒：推近殿脊，晨雾，画面无人。'
      const dCutLastBad = '出场人物：@甲；场景：@大殿。\\n0-3秒：殿脊全景，晨雾。\\n3-6秒：切回殿前，@甲 抬头。'

      const aCut = '出场人物：@甲；场景：@大殿。\\n0-3秒：切到殿门全景，@甲 推门走入。'
      const bCut = 'Characters: @Jia.\\n0-3s: cut to the gate.'

      const ctxC = { requestContext: buildAgentRequestContext({ episodeId: ${seeded.episodeId}, dramaId: ${seeded.dramaId} }) }
      const update = storyboardTools.updateStoryboard.execute
      const promptOf = async id => (await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)))[0].videoPrompt

      const reasons = {
        compliant: await junctionPromptRejections(${seeded.ids.contain}, compliant),
        cutFirstZh: await junctionPromptRejections(${seeded.ids.contain}, cutFirstZh),
        cutFirstEn: await junctionPromptRejections(${seeded.ids.contain}, cutFirstEn),
        cutHalf: await junctionPromptRejections(${seeded.ids.contain}, cutHalf),
        cutEnDash: await junctionPromptRejections(${seeded.ids.contain}, cutEnDash),
        noSegments: await junctionPromptRejections(${seeded.ids.contain}, containTitle),
        dCutFirstOk: await junctionPromptRejections(${seeded.ids.full}, dCutFirstOk),
        dCutLastBad: await junctionPromptRejections(${seeded.ids.full}, dCutLastBad),
        aCut: await junctionPromptRejections(${seeded.ids.layerOnly}, aCut),
        bCut: await junctionPromptRejections(${seeded.ids.generated}, bCut),
      }

      // 工具路径：退回不落库，合规才写入
      const rejectedC = await update({ storyboard_id: ${seeded.ids.contain}, video_prompt: cutFirstZh }, ctxC)
      const afterRejectC = await promptOf(${seeded.ids.contain})
      const acceptedC = await update({ storyboard_id: ${seeded.ids.contain}, video_prompt: compliant }, ctxC)
      const afterAcceptC = await promptOf(${seeded.ids.contain})
      const rejectedD = await update({ storyboard_id: ${seeded.ids.full}, video_prompt: dCutLastBad }, ctxC)
      const afterRejectD = await promptOf(${seeded.ids.full})
      const acceptedD = await update({ storyboard_id: ${seeded.ids.full}, video_prompt: dCutFirstOk }, ctxC)
      const afterAcceptD = await promptOf(${seeded.ids.full})
      const acceptedA = await update({ storyboard_id: ${seeded.ids.layerOnly}, video_prompt: aCut }, ctxC)
      const acceptedB = await update({ storyboard_id: ${seeded.ids.generated}, video_prompt: bCut }, ctxC)
      // 纯段校验函数本身也能按槽位判断（不依赖 DB）
      const pureD = junctionPromptReasons(dCutLastBad, 'last', null)

      out({
        reasons, rejectedC, afterRejectC, acceptedC, afterAcceptC,
        rejectedD, afterRejectD, acceptedD, afterAcceptD,
        acceptedA, acceptedB, pureD,
      })
    `, env)

    assert.deepEqual(got.reasons.compliant, [], '首段复述构图、切镜在第二段 → 放行')
    assert.equal(got.reasons.cutFirstZh.length, 1)
    assert.match(got.reasons.cutFirstZh[0], /第一段/)
    assert.match(got.reasons.cutFirstZh[0], /切到/)
    assert.equal(got.reasons.cutFirstEn.length, 1, 'en 的 cut to 同样拦')
    assert.match(got.reasons.cutFirstEn[0], /cut to/i)
    assert.equal(got.reasons.cutHalf.length, 1, '0-2.5秒: 也是分段行')
    assert.equal(got.reasons.cutEnDash.length, 1, '0–3 s: 也是分段行')
    assert.equal(got.reasons.noSegments.length, 1, '没有分段行的提示词无从校验，退回并说明格式')
    assert.match(got.reasons.noSegments[0], /0-3秒/)
    assert.deepEqual(got.reasons.dCutFirstOk, [], 'D 只看末段')
    assert.equal(got.reasons.dCutLastBad.length, 1)
    assert.match(got.reasons.dCutLastBad[0], /最后一段/)
    assert.match(got.reasons.dCutLastBad[0], /切回/)
    assert.deepEqual(got.reasons.aCut, [], 'A 组合没有锁定衔接帧')
    assert.deepEqual(got.reasons.bCut, [], 'B 组合没有锁定衔接帧')

    // 工具路径：退回时 error/rejected 都带原因，且一个字都不落库
    assert.ok(got.rejectedC.error, 'C 的首段切镜必须退回')
    assert.equal(got.rejectedC.rejected.length, 1)
    assert.deepEqual(got.rejectedC.locked_frame, { slot: 'first', source: 'layer_last' })
    assert.equal(got.afterRejectC, null, '被退回的提示词不得落库')
    assert.equal(got.acceptedC.error, undefined)
    assert.equal(got.afterAcceptC.includes('切到殿门特写'), true, '合规提示词原样保存')

    assert.ok(got.rejectedD.error, 'D 的末段切镜必须退回')
    assert.deepEqual(got.rejectedD.locked_frame, { slot: 'last', source: 'layer_first' })
    assert.equal(got.afterRejectD, null)
    assert.equal(got.acceptedD.error, undefined)
    assert.equal(got.afterAcceptD.includes('推近殿脊'), true)

    assert.equal(got.acceptedA.error, undefined, 'A 组合不校验')
    assert.equal(got.acceptedB.error, undefined, 'B 组合不校验')
    assert.equal(got.pureD.length, 1, '槽位规则是纯函数，模型缺失 caption 时照样拦')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('视频提示词批次在 Agent 开跑前算好描述，并把锁定槽位与 caption 写进话术', () => {
  const { dir, env, seeded } = prepare()
  try {
    const got = run(`${SEGMENTS}
      const kinds = []
      const agentTexts = []
      let captionCount = 0
      const prompt = '出场人物：@甲；场景：@大殿。\\n0-1秒：俯拍全景，大殿殿脊占画面下方三分之二，上方留白，画面无人。\\n1-4秒：@甲 从画面右侧入画，右手扶柱，双腿站定。'
      const hasImagePart = body => (body.messages || []).some(m => Array.isArray(m.content) && m.content.some(part => part.type === 'image_url'))
      const mock = await startMockOpenAIChat(async (body) => {
        if (hasImagePart(body)) {
          kinds.push('caption')
          captionCount += 1
          return { text: JSON.stringify({ caption: '空镜：俯拍全景，殿脊占画面下方三分之二，上方留白，无人物。' }) }
        }
        kinds.push('agent')
        agentTexts.push(userText(body))
        if (!toolResults(body, 'read_storyboard_context').length) {
          return { toolCalls: [{ name: 'read_storyboard_context', args: {} }] }
        }
        if (!toolResults(body, 'update_storyboard').length) {
          return { toolCalls: [{ name: 'update_storyboard', args: { storyboard_id: ${seeded.ids.contain}, video_prompt: prompt } }] }
        }
        return { text: '已保存' }
      })
      await db.insert(schema.aiServiceConfigs).values({
        serviceType: 'text', provider: 'openai', name: 'mock model', baseUrl: mock.baseUrl,
        apiKey: 'not-a-credential', model: '["mock-model"]', isActive: true, vision: true,
        createdAt: now(), updatedAt: now(),
      })
      const started = await startVideoPromptBatch(${seeded.episodeId}, ${seeded.dramaId}, {}, [${seeded.ids.contain}])
      let status = null
      const deadline = Date.now() + 60000
      for (;;) {
        status = await getVideoPromptBatchStatus(${seeded.episodeId})
        if (status && status.status !== 'running') break
        if (Date.now() > deadline) throw new Error('video prompt batch did not settle')
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, ${seeded.ids.contain}))
      const segment = await getLayerSegment(${seeded.ids.contain})
      out({
        started, status: { status: status.status, completed: status.completed, failed: status.failed },
        kinds, captionCount, agentTexts, videoPrompt: row.videoPrompt,
        caption: segment.junction_caption?.caption ?? null,
      })
      await mock.close()
    `, env)

    assert.deepEqual(got.started, { started: true, total: 1 })
    assert.equal(got.captionCount, 1, '每个 C/D 镜只描述一次衔接帧')
    assert.equal(got.kinds[0], 'caption', '描述必须在 Agent 开跑之前算好')
    assert.ok(got.agentTexts.length >= 1)
    const instruction = got.agentTexts[0]
    assert.match(instruction, /锁定衔接帧（C 组合）/)
    assert.match(instruction, /锁定画面：空镜：俯拍全景/, '话术里带真实 caption')
    assert.match(instruction, /第一段必须从这个画面继续演/)
    assert.equal(got.videoPrompt, '出场人物：@甲；场景：@大殿。\n0-1秒：俯拍全景，大殿殿脊占画面下方三分之二，上方留白，画面无人。\n1-4秒：@甲 从画面右侧入画，右手扶柱，双腿站定。', '合规提示词经工具保存成功')
    assert.deepEqual(got.status, { status: 'done', completed: 1, failed: 0 })
    assert.match(got.caption, /俯拍全景/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('退回信息带 caption：模型按真实画面重写，而不是只收到一个错', () => {
  const { dir, env, seeded } = prepare()
  try {
    const got = run(`${SEGMENTS}
      let n = 0
      const mock = await startMockOpenAIChat(async (body) => {
        if (JSON.stringify(body.messages).includes('image_url')) {
          n += 1
          return { text: JSON.stringify({ caption: '空镜：俯拍全景，殿脊占画面下方三分之二，上方留白，无人物。' }) }
        }
        return { text: 'ok' }
      })
      await db.insert(schema.aiServiceConfigs).values({
        serviceType: 'text', provider: 'openai', name: 'mock vision', baseUrl: mock.baseUrl,
        apiKey: 'not-a-credential', model: '["mock-vision"]', isActive: true, vision: true,
        createdAt: now(), updatedAt: now(),
      })
      await ensureJunctionCaption(${seeded.ids.contain}, { storyboardNumber: 1 })
      const cut = '出场人物：@甲；场景：@大殿。\\n0-3秒：切到殿门全景，@甲 推门走入。'
      const reasons = await junctionPromptRejections(${seeded.ids.contain}, cut)
      // 没有视觉配置 / 模型失败时：caption 为空、note 给原因，校验照样拦首段切镜
      await db.delete(schema.aiServiceConfigs)
      const segment = await getLayerSegment(${seeded.ids.zoomed})
      const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, ${seeded.ids.zoomed}))
      const spec = await resolveEpisodeSegmentSpec(row.episodeId)
      // 换一张衔接帧让缓存作废，再在没有配置的情况下确保描述
      const newHash = 'h-' + ${seeded.ids.zoomed} + '-b'
      const newRel = 'static/layer-frames/' + segment.id + '-' + newHash + '.png'
      await write(newRel, { r: 5, g: 5, b: 5 }, 64, 64)
      await markSegmentRendered(segment.id, {
        render_path: segment.render_path, render_signature: layerSegmentSignatureOf(segment, spec, 'D'),
        status: 'ready', junction_path: newRel, junction_hash: newHash,
      })
      const noConfig = await ensureJunctionCaption(${seeded.ids.zoomed}, { storyboardNumber: 3 })
      const frames = await lockedFramesOfEpisode(${seeded.episodeId})
      out({ reasons, noConfig, cropFrames: frames.get(${seeded.ids.zoomed}), requests: mock.requests.length })
      await mock.close()
    `, env)

    assert.equal(got.reasons.length, 1)
    assert.match(got.reasons[0], /空镜：俯拍全景/, '退回信息必须复述 caption 里的真实构图')
    assert.match(got.reasons[0], /切到/)
    assert.match(got.reasons[0], /切镜挪到第二段之后/)

    assert.equal(got.noConfig.called, false)
    assert.equal(got.noConfig.caption, null, '没有视觉配置 → 不编描述')
    assert.match(got.noConfig.note, /没有可用的视觉配置/)
    const cropFrame = got.cropFrames[0]
    assert.equal(cropFrame.caption, null)
    assert.match(cropFrame.caption_note, /没有可用的视觉配置/)
    assert.equal(got.requests, 1, '只有第一次描述真的打了模型')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
