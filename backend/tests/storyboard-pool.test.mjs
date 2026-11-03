/**
 * 本镜资产池（Issue #43）的行为回归测试。
 * 真跑库：临时 SQLITE_PATH + 仓库自带 tsx 子进程，绝不碰开发库。
 * 覆盖人工手选、真实 AI 工具写提示词、五个字段的 @、引用锁定、最后一处引用移除、
 * 全字段清空、跨集/已删/旁白拒绝、实际发送仍只由目标级绑定决定、删除清理与迁移幂等。
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
  const dir = mkdtempSync(path.join(tmpdir(), 'storyboard-pool-'))
  try {
    const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot,
      encoding: 'utf8',
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3') },
    })
    return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const poolScenario = () => run(`
  import { db, schema, initDb } from './src/db/index.ts'
  import { eq } from 'drizzle-orm'
  import {
    PROMPT_FIELDS, applyExplicitBindings, deletePoolSelections, loadPoolState,
    loadStoryboardTargetAssets, setPoolSelection, syncStoryboardBindingsFromPrompts,
  } from './src/services/storyboard-assets.ts'
  import { deleteAssetLinks } from './src/services/asset-links.ts'
  import { buildAgentRequestContext } from './src/agents/context.ts'
  import { promptStoryboardUpdaters } from './src/agents/tools/storyboard-tools.ts'
  initDb()
  const at = '2026-01-01T00:00:00.000Z'
  await db.insert(schema.dramas).values({ id: 1, title: 'pool drama', createdAt: at, updatedAt: at })
  for (const id of [1, 2]) {
    await db.insert(schema.episodes).values({ id, dramaId: 1, episodeNumber: id, title: 'E' + id, createdAt: at, updatedAt: at })
  }
  for (const [id, location, episodeId] of [[8, '客厅', 1], [9, '厨房', 1], [10, '卧室', 2]]) {
    await db.insert(schema.scenes).values({ id, dramaId: 1, location, time: '白天', prompt: '', imageUrl: 'static/s' + id + '.png', createdAt: at, updatedAt: at })
    await db.insert(schema.episodeScenes).values({ episodeId, sceneId: id, createdAt: at })
  }
  for (const [id, name, episodeId, role] of [[6, '猴宝宝', 1, '主角'], [7, '鼠妈妈', 1, '配角'], [99, '旁白', 1, '旁白'], [5, '猪爸爸', 2, '配角']]) {
    await db.insert(schema.characters).values({ id, dramaId: 1, name, role, imageUrl: 'static/c' + id + '.png', createdAt: at, updatedAt: at })
    await db.insert(schema.episodeCharacters).values({ episodeId, characterId: id, createdAt: at })
  }
  for (const [id, name] of [[17, '墨镜'], [18, '草帽']]) {
    await db.insert(schema.props).values({ id, dramaId: 1, name, imageUrl: 'static/p' + id + '.png', createdAt: at, updatedAt: at })
    await db.insert(schema.episodeProps).values({ episodeId: 1, propId: id, createdAt: at })
  }
  for (const [id, episodeId, sceneId] of [[24, 1, 8], [25, 2, 10]]) {
    await db.insert(schema.storyboards).values({
      id, episodeId, storyboardNumber: 1, sceneId, title: 'shot', duration: 10,
      firstFramePrompt: '', midFramePrompt: '', lastFramePrompt: '', videoPrompt: '', transitionPrompt: '',
      createdAt: at, updatedAt: at,
    })
  }
  const row = async id => (await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)))[0]
  const ctx = scope => ({ requestContext: buildAgentRequestContext({ episodeId: 1, dramaId: 1, storyboardId: 24, storyboardPromptScope: scope }) })
  const links = async () => ({
    characterIds: (await db.select().from(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, 24))).map(l => l.characterId).sort(),
    propIds: (await db.select().from(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, 24))).map(l => l.propId).sort(),
  })
  const fail = async fn => { try { await fn(); return null } catch (err) { return err.message } }
  const writePrompt = async (field, column, value) => {
    await db.update(schema.storyboards).set({ [column]: value }).where(eq(schema.storyboards.id, 24))
    return syncStoryboardBindingsFromPrompts(24, [field])
  }

  // 拆分分镜的显式初始绑定 = 手选
  const afterSplit = await applyExplicitBindings(24, { characterIds: [7], propIds: [], sceneId: 8 })
  // 用户在资产池里手选：第二个角色 + 第二个场景（不改主场景）
  await setPoolSelection(24, 'character', 6, true)
  const afterManual = await setPoolSelection(24, 'scene', 9, true)
  const manualLinks = await links()

  // AI 真实工具写首帧提示词（页面没开也要落地）
  const aiFirst = await promptStoryboardUpdaters.keyframes.execute(
    { storyboard_id: 24, first_frame_prompt: '@客厅 推门，@猴宝宝 站在门口' }, ctx('keyframes'))
  const afterAiFirst = await loadPoolState(await row(24))
  const afterAiLinks = await links()
  const targetsAfterFirst = await loadStoryboardTargetAssets(await row(24))

  // AI 真实工具写视频提示词：道具只靠 @ 进池（不是手选）
  await promptStoryboardUpdaters.video.execute({ storyboard_id: 24, video_prompt: '0-3秒：@墨镜 反光' }, ctx('video'))
  const afterAiVideo = await loadPoolState(await row(24))

  // 人工保存其余三个字段：中间帧 / 尾帧 / 转场
  await writePrompt('mid_frame_prompt', 'midFramePrompt', '@厨房 里 @鼠妈妈 回头')
  await writePrompt('last_frame_prompt', 'lastFramePrompt', '@墨镜 特写')
  await writePrompt('transition_prompt', 'transitionPrompt', '@草帽 挂在门后')
  const afterAllFields = await loadPoolState(await row(24))

  // 被引用的资产不能直接退选
  const lockedProp = await fail(() => setPoolSelection(24, 'prop', 17, false))
  const lockedChar = await fail(() => setPoolSelection(24, 'character', 6, false))
  // 同一资产跨字段：删掉视频里的引用，尾帧还在 → 仍锁定
  await promptStoryboardUpdaters.video.execute({ storyboard_id: 24, video_prompt: '空镜' }, ctx('video'))
  const lockedAfterOneRemoved = await fail(() => setPoolSelection(24, 'prop', 17, false))
  const poolAfterOneRemoved = await loadPoolState(await row(24))

  // 五个字段全部清空：自动加入的资产退出，手选全部保留
  for (const [field, column] of [['first_frame_prompt', 'firstFramePrompt'], ['mid_frame_prompt', 'midFramePrompt'],
    ['last_frame_prompt', 'lastFramePrompt'], ['video_prompt', 'videoPrompt'], ['transition_prompt', 'transitionPrompt']]) {
    await db.update(schema.storyboards).set({ [column]: '' }).where(eq(schema.storyboards.id, 24))
  }
  const afterClear = await syncStoryboardBindingsFromPrompts(24, PROMPT_FIELDS)
  const poolAfterClear = await loadPoolState(await row(24))
  const linksAfterClear = await links()
  const targetsAfterClear = await loadStoryboardTargetAssets(await row(24))
  const sceneIdAfterClear = (await row(24)).sceneId

  // 不再被引用的自动资产可以直接退选（本来就不是手选）
  const unselectAuto = await setPoolSelection(24, 'prop', 17, false)
  // 非法选择
  const missingAsset = await fail(() => setPoolSelection(24, 'character', 999, true))
  const crossEpisode = await fail(() => setPoolSelection(24, 'character', 5, true))
  const narrator = await fail(() => setPoolSelection(24, 'character', 99, true))
  const otherEpisodeShot = await fail(() => setPoolSelection(25, 'character', 6, true))
  const missingShot = await fail(() => setPoolSelection(4242, 'character', 6, true))

  // 同镜两张卡并发选择，不能用旧的手选全量覆盖另一张卡。
  await Promise.all([
    setPoolSelection(24, 'prop', 17, true),
    setPoolSelection(24, 'prop', 18, true),
  ])
  const concurrentSelections = await loadPoolState(await row(24))
  await Promise.all([
    setPoolSelection(24, 'prop', 17, false),
    setPoolSelection(24, 'prop', 18, false),
  ])
  // AI 保存时同步 @，同时用户手选另一项，两种来源必须同时保留。
  await Promise.all([
    promptStoryboardUpdaters.video.execute({ storyboard_id: 24, video_prompt: '@墨镜 反光' }, ctx('video')),
    setPoolSelection(24, 'prop', 18, true),
  ])
  const concurrentAiSelection = await loadPoolState(await row(24))
  await promptStoryboardUpdaters.video.execute({ storyboard_id: 24, video_prompt: '' }, ctx('video'))
  await setPoolSelection(24, 'prop', 18, false)

  // 资产删除清掉手选
  await deleteAssetLinks('character', 6)
  const poolAfterAssetDelete = await loadPoolState(await row(24))
  const selectionsAfterAssetDelete = (await db.select().from(schema.storyboardPoolSelections)).filter(r => r.storyboardId === 24).length
  // 分镜删除清掉手选
  await deletePoolSelections({ storyboardId: 24 })
  const selectionsAfterShotDelete = (await db.select().from(schema.storyboardPoolSelections)).length

  process.stdout.write('@@' + JSON.stringify({
    afterSplit, afterManual, manualLinks, aiFirst, afterAiFirst, afterAiLinks, targetsAfterFirst,
    afterAiVideo, afterAllFields, lockedProp, lockedChar, lockedAfterOneRemoved, poolAfterOneRemoved,
    afterClear: { bound: afterClear.sync.bound, unbound: afterClear.sync.unbound, poolAssets: afterClear.poolAssets },
    poolAfterClear, linksAfterClear, targetsAfterClear, sceneIdAfterClear, unselectAuto,
    missingAsset, crossEpisode, narrator, otherEpisodeShot, missingShot,
    concurrentSelections, concurrentAiSelection,
    poolAfterAssetDelete, selectionsAfterAssetDelete, selectionsAfterShotDelete,
  }))
`)

const migrationScenario = () => run(`
  import Database from 'better-sqlite3'
  import { sqliteSchemaStatements } from './src/db/sqlite-schema.ts'
  const at = '2026-01-01T00:00:00.000Z'
  const old = new Database(process.env.SQLITE_PATH)
  for (const statement of sqliteSchemaStatements) old.exec(statement)
  // 升级前的库没有资产池手选表
  old.exec('DROP TABLE storyboard_pool_selections')
  old.prepare('INSERT INTO dramas (id, title, created_at, updated_at) VALUES (1, ?, ?, ?)').run('old drama', at, at)
  old.prepare('INSERT INTO episodes (id, drama_id, episode_number, title, created_at, updated_at) VALUES (1, 1, 1, ?, ?, ?)').run('E1', at, at)
  old.prepare('INSERT INTO scenes (id, drama_id, location, time, prompt, image_url, created_at, updated_at) VALUES (8, 1, ?, ?, ?, ?, ?, ?)').run('客厅', '白天', '', 'static/s8.png', at, at)
  old.prepare('INSERT INTO episode_scenes (episode_id, scene_id, created_at) VALUES (1, 8, ?)').run(at)
  for (const [id, name] of [[6, '猴宝宝'], [7, '鼠妈妈']]) {
    old.prepare('INSERT INTO characters (id, drama_id, name, image_url, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?)').run(id, name, 'static/c' + id + '.png', at, at)
    old.prepare('INSERT INTO episode_characters (episode_id, character_id, created_at) VALUES (1, ?, ?)').run(id, at)
  }
  old.prepare('INSERT INTO props (id, drama_id, name, image_url, created_at, updated_at) VALUES (17, 1, ?, ?, ?, ?)').run('墨镜', 'static/p17.png', at, at)
  old.prepare('INSERT INTO episode_props (episode_id, prop_id, created_at) VALUES (1, 17, ?)').run(at)
  // 老分镜：主场景 8、老关联只有 猴宝宝 + 墨镜，提示词里另外 @ 了 鼠妈妈
  old.prepare('INSERT INTO storyboards (id, episode_id, scene_id, storyboard_number, first_frame_prompt, mid_frame_prompt, last_frame_prompt, video_prompt, transition_prompt, created_at, updated_at) VALUES (24, 1, 8, 1, ?, ?, ?, ?, ?, ?, ?)')
    .run('@客厅 @鼠妈妈 坐下', '', '', '@客厅 全景', '', at, at)
  old.prepare('INSERT INTO storyboard_characters (storyboard_id, character_id) VALUES (24, 6)').run()
  old.prepare('INSERT INTO storyboard_props (storyboard_id, prop_id) VALUES (24, 17)').run()
  old.prepare('INSERT INTO storyboard_target_assets (storyboard_id, target, kind, asset_id, selected_image, created_at) VALUES (24, ?, ?, ?, ?, ?)')
    .run('first', 'character', 6, 'static/c6-v2.png', at)
  old.close()

  const { db, schema, initDb } = await import('./src/db/index.ts')
  const { eq } = await import('drizzle-orm')
  const { backfillPoolProjection, loadPoolState, setPoolSelection } = await import('./src/services/storyboard-assets.ts')
  const row = async () => (await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, 24)))[0]
  const targetAssets = async () => (await db.select().from(schema.storyboardTargetAssets)).map(r => ({ target: r.target, kind: r.kind, assetId: r.assetId, selectedImage: r.selectedImage }))
  await backfillPoolProjection()
  const firstRun = await loadPoolState(await row())
  const firstRow = await row()
  const firstTargets = await targetAssets()
  const firstLinks = (await db.select().from(schema.storyboardCharacters)).map(l => l.characterId).sort()

  // 用户升级后退选了一个只靠迁移进来的手选（它没有被任何提示词 @）
  await setPoolSelection(24, 'character', 6, false)
  // 再次启动：建表 + 迁移 + 投影补齐
  initDb()
  await backfillPoolProjection()
  const secondRun = await loadPoolState(await row())
  const secondRow = await row()
  const secondTargets = await targetAssets()
  const selectionRows = (await db.select().from(schema.storyboardPoolSelections))
    .map(r => ({ kind: r.kind, assetId: r.assetId })).sort((a, b) => (a.kind + a.assetId).localeCompare(b.kind + b.assetId))

  process.stdout.write('@@' + JSON.stringify({
    firstRun, firstLinks, firstTargets, secondRun, secondTargets, selectionRows,
    prompts: { before: firstRow.firstFramePrompt, after: secondRow.firstFramePrompt, video: secondRow.videoPrompt },
    sceneId: { before: firstRow.sceneId, after: secondRow.sceneId },
  }))
`)

const pool = poolScenario()
const key = item => `${item.kind}:${item.asset_id}`
const find = (state, kind, assetId) => state.pool_assets.find(item => item.kind === kind && item.asset_id === assetId)

test('拆镜的显式初始绑定与用户手选都记为手选，主场景不被池选择改写', () => {
  assert.deepEqual(pool.afterSplit.pool_assets.map(key).sort(), ['character:7', 'scene:8'])
  assert.equal(find(pool.afterSplit, 'character', 7).manual, true)
  assert.equal(find(pool.afterSplit, 'character', 7).mentioned, false)
  // 两个场景可同时在池里，scene_id 仍是主场景
  assert.deepEqual(pool.afterManual.pool_assets.map(key).sort(), ['character:6', 'character:7', 'scene:8', 'scene:9'])
  assert.equal(pool.afterManual.scene_id, 8)
  // 角色/道具老关联表是有效池的投影
  assert.deepEqual(pool.manualLinks.characterIds, [6, 7])
  assert.deepEqual(pool.manualLinks.propIds, [])
})

test('AI 工具写提示词时后台自动加入 @ 资产，手选不被抹掉', () => {
  assert.equal(pool.aiFirst.message, 'Storyboard 24 updated')
  assert.deepEqual(pool.afterAiFirst.pool_assets.map(key).sort(), ['character:6', 'character:7', 'scene:8', 'scene:9'])
  assert.deepEqual(find(pool.afterAiFirst, 'character', 6), { kind: 'character', asset_id: 6, manual: true, mentioned: true })
  // 没被 @ 的手选角色保留
  assert.deepEqual(find(pool.afterAiFirst, 'character', 7), { kind: 'character', asset_id: 7, manual: true, mentioned: false })
  assert.deepEqual(pool.afterAiLinks.characterIds, [6, 7])
  // 手选不会凭空进入实际发送：首帧只绑定该字段 @ 到的资产
  assert.deepEqual(pool.targetsAfterFirst.first.map(item => `${item.kind}:${item.asset_id}`).sort(), ['character:6', 'scene:8'])
  assert.deepEqual(pool.targetsAfterFirst.video, [])
})

test('同镜并发选择及 AI 保存不会丢掉另一项手选', () => {
  assert.deepEqual(pool.concurrentSelections.pool_assets.filter(item => item.kind === 'prop').map(key).sort(), ['prop:17', 'prop:18'])
  assert.deepEqual(find(pool.concurrentAiSelection, 'prop', 17), { kind: 'prop', asset_id: 17, manual: false, mentioned: true })
  assert.deepEqual(find(pool.concurrentAiSelection, 'prop', 18), { kind: 'prop', asset_id: 18, manual: true, mentioned: false })
})

test('五个提示词字段的 @ 都能把资产带进池，只靠 @ 的资产不记成手选', () => {
  assert.equal(find(pool.afterAiVideo, 'prop', 17).manual, false)
  assert.equal(find(pool.afterAiVideo, 'prop', 17).mentioned, true)
  // 首帧(场景8/角色6) + 中间帧(场景9/角色7) + 尾帧与视频(道具17) + 转场(道具18)
  assert.deepEqual(pool.afterAllFields.pool_assets.map(key).sort(),
    ['character:6', 'character:7', 'prop:17', 'prop:18', 'scene:8', 'scene:9'])
  assert.equal(find(pool.afterAllFields, 'prop', 18).mentioned, true)
  assert.equal(find(pool.afterAllFields, 'prop', 18).manual, false)
})

test('被提示词引用的资产不能直接退选，错误指明具体字段', () => {
  assert.match(pool.lockedProp, /墨镜/)
  assert.match(pool.lockedProp, /尾帧提示词/)
  assert.match(pool.lockedProp, /视频提示词/)
  assert.match(pool.lockedChar, /猴宝宝/)
  assert.match(pool.lockedChar, /首帧提示词/)
  // 跨字段引用删掉一个，另一个字段仍引用 → 还是锁定，资产留在池里
  assert.match(pool.lockedAfterOneRemoved, /尾帧提示词/)
  assert.equal(find(pool.poolAfterOneRemoved, 'prop', 17).mentioned, true)
})

test('五个字段全部清空后只有自动加入的资产退出，手选与主场景保留', () => {
  assert.deepEqual(pool.afterClear.unbound.map(item => item.name).sort(), ['墨镜', '草帽'])
  assert.deepEqual(pool.poolAfterClear.pool_assets.map(key).sort(), ['character:6', 'character:7', 'scene:8', 'scene:9'])
  for (const item of pool.poolAfterClear.pool_assets) assert.equal(item.mentioned, false)
  assert.deepEqual(pool.linksAfterClear.characterIds, [6, 7])
  assert.deepEqual(pool.linksAfterClear.propIds, [])
  assert.equal(pool.sceneIdAfterClear, 8)
  // 提示词清空后目标级绑定也清空：手选不会留下任何实际发送的参考图
  for (const target of ['first', 'mid', 'last', 'video']) assert.deepEqual(pool.targetsAfterClear[target], [])
  // 不再被引用的自动资产可以直接退选
  assert.equal(pool.unselectAuto.pool_assets.some(item => item.kind === 'prop'), false)
})

test('跨集 / 已删除 / 旁白 / 不存在的资产与镜头都不能选择', () => {
  assert.match(pool.missingAsset, /不在本集可选资产里/)
  assert.match(pool.crossEpisode, /不在本集可选资产里/)
  assert.match(pool.narrator, /不在本集可选资产里/)
  assert.match(pool.otherEpisodeShot, /不在本集可选资产里/)
  assert.match(pool.missingShot, /镜头不存在/)
})

test('删除资产与删除分镜都会清掉手选', () => {
  assert.equal(pool.poolAfterAssetDelete.pool_assets.some(item => item.kind === 'character' && item.asset_id === 6), false)
  assert.equal(pool.selectionsAfterAssetDelete, 3)
  assert.equal(pool.selectionsAfterShotDelete, 0)
})

const migration = migrationScenario()

test('存量迁移把老关联与主场景保留为手选，并按现有 @ 补齐有效池', () => {
  assert.deepEqual(migration.firstRun.pool_assets.map(key).sort(), ['character:6', 'character:7', 'prop:17', 'scene:8'])
  // 老关联 + 主场景 = 手选
  assert.deepEqual(find(migration.firstRun, 'character', 6), { kind: 'character', asset_id: 6, manual: true, mentioned: false })
  assert.deepEqual(find(migration.firstRun, 'prop', 17), { kind: 'prop', asset_id: 17, manual: true, mentioned: false })
  assert.deepEqual(find(migration.firstRun, 'scene', 8), { kind: 'scene', asset_id: 8, manual: true, mentioned: true })
  // 提示词里已有的 @ 自动进池并补进投影
  assert.deepEqual(find(migration.firstRun, 'character', 7), { kind: 'character', asset_id: 7, manual: false, mentioned: true })
  assert.deepEqual(migration.firstLinks, [6, 7])
})

test('迁移重复运行不重复、不恢复用户后续的退选，且不改提示词 / 主场景 / 目标选版', () => {
  assert.deepEqual(migration.secondRun.pool_assets.map(key).sort(), ['character:7', 'prop:17', 'scene:8'])
  assert.deepEqual(migration.selectionRows, [{ kind: 'prop', assetId: 17 }, { kind: 'scene', assetId: 8 }])
  assert.equal(migration.prompts.before, '@客厅 @鼠妈妈 坐下')
  assert.equal(migration.prompts.after, '@客厅 @鼠妈妈 坐下')
  assert.equal(migration.prompts.video, '@客厅 全景')
  assert.equal(migration.sceneId.before, 8)
  assert.equal(migration.sceneId.after, 8)
  assert.deepEqual(migration.firstTargets, [{ target: 'first', kind: 'character', assetId: 6, selectedImage: 'static/c6-v2.png' }])
  assert.deepEqual(migration.secondTargets, migration.firstTargets)
})
