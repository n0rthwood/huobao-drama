/**
 * 资产按项目画幅出图（Issue #94）的行为测试：
 * 1. `assetImageSizeFor` 尺寸表；
 * 2. qwen-jobs 请求体：画幅锁定 + 有参考图 → reference_to_image 带 width/height（其余模式不变）；
 * 3. 画幅锁定任务完成时的出图比例核验（真图 + 真任务行，比例不符标 failed 且不回写）；
 * 4. 画幅版本接口对忠实素材 / 地图道具 / 已是项目画幅的拒绝；
 * 5. 场景最终提示词的画幅校验（9:16 退回、16:9 原样放行）。
 *
 * 纯函数走一次 tsx 子进程以 JSON 回传；要落库的用例用临时 SQLITE_PATH + STORAGE_PATH。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

/** 纯函数批次：单进程跑完所有无副作用判定 */
function runPure() {
  const root = mkdtempSync(join(tmpdir(), 'huobao-asset-aspect-pure-'))
  try {
    const script = `
      import { assetImageSizeFor, aspectLockedMismatchMessage } from './src/services/asset-image-size.ts'
      import { buildImageJobBody } from './src/services/adapters/qwen-jobs-client.ts'
      import { aspectVersionRefusal } from './src/services/asset-aspect-version.ts'
      import { sceneAspectIssue } from './src/services/aspect.ts'
      import { OpenAIImageAdapter } from './src/services/adapters/openai-image.ts'
      import { GeminiImageAdapter } from './src/services/adapters/gemini-image.ts'
      import { VolcEngineImageAdapter } from './src/services/adapters/volcengine-image.ts'
      const config = { provider: 'x', apiKey: 'k', baseUrl: 'https://example.com', model: '' }
      const imageRecord = (model, size) => ({ model, size, prompt: 'p', referenceImages: null })
      const openai = new OpenAIImageAdapter()
      const gemini = new GeminiImageAdapter()
      const volcengine = new VolcEngineImageAdapter()
      // 竖版资产画幅在各 provider 上必须保持竖向（不能被压回横图/方图）
      const adapters = {
        dalle: openai.buildGenerateRequest(config, imageRecord('dall-e-3', '1080x1920')).body.size,
        dalleLandscape: openai.buildGenerateRequest(config, imageRecord('dall-e-3', '1920x1080')).body.size,
        gptImage: openai.buildGenerateRequest(config, imageRecord('gpt-image-1', '1080x1920')).body.size,
        gptImage2: openai.buildGenerateRequest(config, imageRecord('gpt-image-2', '1080x1920')).body.size,
        openaiCompatible: openai.buildGenerateRequest(config, imageRecord('fixture-image', '1344x768')).body.size,
        gemini: gemini.buildGenerateRequest(config, imageRecord('gemini-2.5-flash-image', '1080x1920')).body.generationConfig.imageConfig.aspectRatio,
        volcengine: [
          volcengine.buildGenerateRequest(config, imageRecord('doubao-seedream', '1080x1920')).body.width,
          volcengine.buildGenerateRequest(config, imageRecord('doubao-seedream', '1080x1920')).body.height,
        ],
      }
      const sizes = {
        scene: ['16:9', '9:16', '4:3', '3:4', '1:1', '', '21:9'].map(a => assetImageSizeFor('scene', a)),
        character: assetImageSizeFor('character', '9:16'),
        prop: assetImageSizeFor('prop', '9:16'),
      }
      const mismatch = {
        // qwen-jobs 对齐 32：1080x1920 → 1088x1920 仍算符合
        aligned: aspectLockedMismatchMessage('1080x1920', { width: 1088, height: 1920 }),
        landscapeResult: aspectLockedMismatchMessage('1080x1920', { width: 1920, height: 1088 }),
        unknown: aspectLockedMismatchMessage('1080x1920', { width: 0, height: 0 }),
      }
      const body = {
        lockedWithRefs: buildImageJobBody({ prompt: 'p', fileIds: ['f1'], isKeyframe: false, size: '1080x1920', flux: false, aspectLocked: true }),
        editWithRefs: buildImageJobBody({ prompt: 'p', fileIds: ['f1'], isKeyframe: false, size: '1024x1024', flux: false }),
        keyframe: buildImageJobBody({ prompt: 'p', fileIds: ['f1'], isKeyframe: true, size: '768x1344', flux: false }),
        lockedNoRefs: buildImageJobBody({ prompt: 'p', fileIds: [], isKeyframe: false, size: '1080x1920', flux: false, aspectLocked: true }),
      }
      const refusal = {
        map: aspectVersionRefusal({ isMap: true, faithful: false, hasImage: true, alreadyProjectAspect: false }),
        faithful: aspectVersionRefusal({ isMap: false, faithful: true, hasImage: true, alreadyProjectAspect: false }),
        noImage: aspectVersionRefusal({ isMap: false, faithful: false, hasImage: false, alreadyProjectAspect: false }),
        already: aspectVersionRefusal({ isMap: false, faithful: false, hasImage: true, alreadyProjectAspect: true }),
        ok: aspectVersionRefusal({ isMap: false, faithful: false, hasImage: true, alreadyProjectAspect: false }),
      }
      const scenePrompt = {
        portraitMissing: sceneAspectIssue('固定机位广角镜头，午后的城楼', '9:16'),
        portraitOk: sceneAspectIssue('固定机位广角镜头，9:16 竖构图，午后的城楼', '9:16'),
        portraitConflict: sceneAspectIssue('9:16 竖构图，但其实是 16:9 横构图', '9:16'),
        landscapeLegacy: sceneAspectIssue('固定机位广角镜头，午后的城楼', '16:9'),
        landscapeConflict: sceneAspectIssue('固定机位广角镜头，竖构图的城楼', '16:9'),
      }
      console.log('@@' + JSON.stringify({ sizes, mismatch, body, refusal, scenePrompt, adapters }))
    `
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot,
      encoding: 'utf8',
      env: { ...process.env, SQLITE_PATH: join(root, 'db.sqlite3'), HUOBAO_DATA_DIR: root },
    })
    return JSON.parse(stdout.slice(stdout.lastIndexOf('@@') + 2))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const pure = runPure()

test('资产尺寸表：场景按项目画幅，角色横版、道具方图不变', () => {
  assert.deepEqual(pure.sizes.scene, [
    '1920x1080', '1080x1920', '1664x1248', '1248x1664', '1440x1440',
    // 空画幅与白名单外的画幅都回落默认 16:9
    '1920x1080', '1920x1080',
  ])
  assert.equal(pure.sizes.character, '1920x1080')
  assert.equal(pure.sizes.prop, '1024x1024')
})

test('qwen-jobs：画幅锁定 + 有参考图走 reference_to_image 并带画幅；普通资产编辑仍是 image_edit', () => {
  assert.equal(pure.body.lockedWithRefs.mode, 'reference_to_image')
  assert.equal(pure.body.lockedWithRefs.width, 1088)
  assert.equal(pure.body.lockedWithRefs.height, 1920)
  assert.deepEqual(pure.body.lockedWithRefs.reference_images, ['f1'])
  // 未锁画幅的参考图编辑保持原行为：不带 width/height（跟随第 1 张参考图）
  assert.equal(pure.body.editWithRefs.mode, 'image_edit')
  assert.equal(pure.body.editWithRefs.width, undefined)
  assert.equal(pure.body.editWithRefs.height, undefined)
  // 关键帧不受影响
  assert.equal(pure.body.keyframe.mode, 'reference_to_image')
  assert.equal(pure.body.keyframe.width, 768)
  // 无参考图仍是文生图，画幅照常
  assert.equal(pure.body.lockedNoRefs.mode, 'text_to_image')
  assert.equal(pure.body.lockedNoRefs.height, 1920)
})

test('其它图像 provider：竖版资产画幅映射到各自支持的竖向档位', () => {
  // DALL-E 3 只认三档，1080x1920 必须映射成 1024x1792 而不是原样透传
  assert.equal(pure.adapters.dalle, '1024x1792')
  assert.equal(pure.adapters.dalleLandscape, '1792x1024')
  assert.equal(pure.adapters.gptImage, '1024x1536')
  assert.equal(pure.adapters.gptImage2, '1088x1920')
  // 自建/第三方 OpenAI 兼容模型的尺寸能力未知：原样透传，不替它改写
  assert.equal(pure.adapters.openaiCompatible, '1344x768')
  assert.equal(pure.adapters.gemini, '9:16')
  assert.deepEqual(pure.adapters.volcengine, [1080, 1920])
})

test('出图比例核验：对齐到 32 放行，横图结果拒绝，探测不到尺寸不拦截', () => {
  assert.equal(pure.mismatch.aligned, null)
  assert.match(pure.mismatch.landscapeResult, /出图比例 1920×1088/)
  assert.equal(pure.mismatch.unknown, null)
})

test('画幅版本拒绝判定：地图 > 忠实素材 > 无当前图 > 已是项目画幅', () => {
  assert.match(pure.refusal.map, /地图资产/)
  assert.match(pure.refusal.faithful, /不能重绘/)
  assert.match(pure.refusal.noImage, /还没有当前图/)
  assert.match(pure.refusal.already, /已经是项目画幅/)
  assert.equal(pure.refusal.ok, null)
})

test('场景提示词画幅校验：9:16 必须逐字写画幅短语，16:9 旧提示词不受影响', () => {
  assert.match(pure.scenePrompt.portraitMissing, /9:16 竖构图/)
  assert.equal(pure.scenePrompt.portraitOk, null)
  assert.match(pure.scenePrompt.portraitConflict, /16:9/)
  assert.equal(pure.scenePrompt.landscapeLegacy, null)
  assert.match(pure.scenePrompt.landscapeConflict, /竖构图/)
})

test('画幅锁定任务完成：比例不符标 failed 且不回写场景当前图，比例相符照常完成', () => {
  const root = mkdtempSync(join(tmpdir(), 'huobao-aspect-complete-'))
  try {
    const script = `
      import sharp from 'sharp'
      import { eq } from 'drizzle-orm'
      import { db, getInsertId, schema } from './src/db/index.ts'
      import { completeImageTaskFromBytes } from './src/services/generation.ts'
      import { now } from './src/utils/response.ts'
      const ts = now()
      const dramaId = getInsertId(await db.insert(schema.dramas).values({ title: '竖版测试', aspectRatio: '9:16', createdAt: ts, updatedAt: ts }))
      const sceneId = getInsertId(await db.insert(schema.scenes).values({ dramaId, location: '城楼', time: '', prompt: '城楼', createdAt: ts, updatedAt: ts }))
      const newTask = async () => getInsertId(await db.insert(schema.sysTask).values({
        type: 'image', provider: 'qwen-jobs', sceneId, dramaId, prompt: 'p', status: 'processing',
        params: JSON.stringify({ size: '1080x1920', aspect_locked: true }), createdAt: ts, updatedAt: ts,
      }))
      const landscape = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#223344' } }).png().toBuffer()
      const portrait = await sharp({ create: { width: 1088, height: 1920, channels: 3, background: '#223344' } }).png().toBuffer()
      const run = async (bytes) => {
        const id = await newTask()
        const [record] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
        await completeImageTaskFromBytes(record, bytes, 'image/png')
        const [after] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
        const [scene] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, sceneId))
        return { status: after.status, error: after.errorMsg, sceneImage: scene.imageUrl }
      }
      const rejected = await run(landscape)
      const accepted = await run(portrait)
      console.log('@@' + JSON.stringify({ rejected, accepted }))
    `
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot,
      encoding: 'utf8',
      env: { ...process.env, SQLITE_PATH: join(root, 'db.sqlite3'), HUOBAO_DATA_DIR: root, STORAGE_PATH: join(root, 'static') },
    })
    const result = JSON.parse(stdout.slice(stdout.lastIndexOf('@@') + 2))
    assert.equal(result.rejected.status, 'failed')
    assert.match(result.rejected.error, /出图比例 1920×1080/)
    assert.equal(result.rejected.sceneImage, null)
    assert.equal(result.accepted.status, 'completed')
    assert.match(result.accepted.sceneImage, /^static\/images\//)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('画幅版本接口：地图道具 / 忠实素材 / 已是项目画幅的资产都拒绝重绘', () => {
  const root = mkdtempSync(join(tmpdir(), 'huobao-aspect-version-'))
  try {
    const script = `
      import fs from 'node:fs'
      import path from 'node:path'
      import sharp from 'sharp'
      import { db, getInsertId, schema } from './src/db/index.ts'
      import { startAspectVersion } from './src/services/asset-aspect-version.ts'
      import { now } from './src/utils/response.ts'
      const ts = now()
      const storage = process.env.STORAGE_PATH
      fs.mkdirSync(path.join(storage, 'images'), { recursive: true })
      const writeImage = async (name, width, height) => {
        await sharp({ create: { width, height, channels: 3, background: '#445566' } }).png().toFile(path.join(storage, 'images', name))
        return 'static/images/' + name
      }
      const dramaId = getInsertId(await db.insert(schema.dramas).values({ title: '竖版测试', aspectRatio: '9:16', createdAt: ts, updatedAt: ts }))
      const episodeId = getInsertId(await db.insert(schema.episodes).values({ dramaId, episodeNumber: 1, title: '第一集', createdAt: ts, updatedAt: ts }))
      const mapId = getInsertId(await db.insert(schema.props).values({ dramaId, name: '行军地图', assetType: 'map', imageUrl: await writeImage('map.png', 1024, 1024), createdAt: ts, updatedAt: ts }))
      const faithfulId = getInsertId(await db.insert(schema.props).values({ dramaId, name: '导入照片', faithful: 1, imageUrl: await writeImage('faithful.png', 1600, 1200), createdAt: ts, updatedAt: ts }))
      const portraitSceneId = getInsertId(await db.insert(schema.scenes).values({ dramaId, location: '竖版场景', time: '', prompt: 'x', imageUrl: await writeImage('portrait.png', 1080, 1920), createdAt: ts, updatedAt: ts }))
      const emptySceneId = getInsertId(await db.insert(schema.scenes).values({ dramaId, location: '无图场景', time: '', prompt: 'x', createdAt: ts, updatedAt: ts }))
      const call = async (kind, id) => {
        try {
          await startAspectVersion(kind, id, { episodeId })
          return null
        } catch (err) { return err.message }
      }
      console.log('@@' + JSON.stringify({
        map: await call('prop', mapId),
        faithful: await call('prop', faithfulId),
        already: await call('scene', portraitSceneId),
        noImage: await call('scene', emptySceneId),
      }))
    `
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot,
      encoding: 'utf8',
      env: { ...process.env, SQLITE_PATH: join(root, 'db.sqlite3'), HUOBAO_DATA_DIR: root, STORAGE_PATH: join(root, 'static') },
    })
    const result = JSON.parse(stdout.slice(stdout.lastIndexOf('@@') + 2))
    assert.match(result.map, /地图资产/)
    assert.match(result.faithful, /不能重绘/)
    assert.match(result.already, /已经是项目画幅/)
    assert.match(result.noImage, /还没有当前图/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('save_scene_final_prompt：9:16 项目退回漏写画幅的提示词，16:9 项目原样保存', () => {
  const root = mkdtempSync(join(tmpdir(), 'huobao-scene-prompt-aspect-'))
  try {
    const script = `
      import { eq } from 'drizzle-orm'
      import { db, getInsertId, schema } from './src/db/index.ts'
      import { buildAgentRequestContext } from './src/agents/context.ts'
      import { imagePromptTools } from './src/agents/tools/image-prompt-tools.ts'
      import { now } from './src/utils/response.ts'
      const ts = now()
      const portraitDrama = getInsertId(await db.insert(schema.dramas).values({ title: '竖版', aspectRatio: '9:16', createdAt: ts, updatedAt: ts }))
      const landscapeDrama = getInsertId(await db.insert(schema.dramas).values({ title: '横版', aspectRatio: '16:9', createdAt: ts, updatedAt: ts }))
      const portraitScene = getInsertId(await db.insert(schema.scenes).values({ dramaId: portraitDrama, location: '长城关口', time: '', prompt: '', createdAt: ts, updatedAt: ts }))
      const landscapeScene = getInsertId(await db.insert(schema.scenes).values({ dramaId: landscapeDrama, location: '客厅', time: '', prompt: '', createdAt: ts, updatedAt: ts }))
      const save = imagePromptTools.saveSceneFinalPrompt
      const ctxOf = dramaId => ({ requestContext: buildAgentRequestContext({ episodeId: 1, dramaId }) })
      const read = imagePromptTools.readScenes
      const portraitCtx = ctxOf(portraitDrama)
      const listed = await read.execute({}, portraitCtx)
      const missing = await save.execute({ scene_id: portraitScene, prompt: '固定机位广角镜头，关城全貌' }, portraitCtx)
      const conflict = await save.execute({ scene_id: portraitScene, prompt: '16:9 横构图，关城全貌' }, portraitCtx)
      const ok = await save.execute({ scene_id: portraitScene, prompt: '固定机位广角镜头，9:16 竖构图，关城全貌完整入画' }, portraitCtx)
      const legacy = await save.execute({ scene_id: landscapeScene, prompt: '固定机位广角镜头，客厅全景' }, ctxOf(landscapeDrama))
      const stored = async id => (await db.select().from(schema.scenes).where(eq(schema.scenes.id, id)))[0].finalPrompt
      console.log('@@' + JSON.stringify({
        listed: { aspect_ratio: listed.aspect_ratio, composition: listed.composition },
        missing, conflict, okSaved: ok.saved, legacySaved: legacy.saved,
        portraitStored: await stored(portraitScene), landscapeStored: await stored(landscapeScene),
      }))
    `
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot,
      encoding: 'utf8',
      env: { ...process.env, SQLITE_PATH: join(root, 'db.sqlite3'), HUOBAO_DATA_DIR: root, STORAGE_PATH: join(root, 'static') },
    })
    const result = JSON.parse(stdout.slice(stdout.lastIndexOf('@@') + 2))
    assert.deepEqual(result.listed, { aspect_ratio: '9:16', composition: '竖构图' })
    assert.equal(result.missing.saved, false)
    assert.match(result.missing.error, /9:16 竖构图/)
    assert.equal(result.conflict.saved, false)
    assert.match(result.conflict.error, /16:9/)
    assert.equal(result.okSaved, true)
    assert.match(result.portraitStored, /9:16 竖构图/)
    // 16:9 项目的老写法不受影响
    assert.equal(result.legacySaved, true)
    assert.match(result.landscapeStored, /客厅全景/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
