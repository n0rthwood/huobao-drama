/**
 * 服务端批量视频「提交前复查」的绑定读取（Issue #119）。
 *
 * 批量 runner 只传分镜行与关键帧状态，没有整集绑定快照；旧实现把缺省快照当成空绑定，
 * 于是视频提示词里 @ 到的资产一律被判 `unbound_mention`，整批镜头被当成
 * 「视频提示词与参考图不一致」跳过。这里用真实临时 SQLite + 真实服务断言 `videoBlockReason`
 * 的判定结果（阻断/不阻断与问题码），不作任何 mock。
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
    import { db, schema } from './src/db/index.ts'
    import { eq } from 'drizzle-orm'
    import { now } from './src/utils/response.ts'
    import { loadEpisodeKeyframes } from './src/services/keyframes.ts'
    import { videoBlockReason } from './src/services/video-batch.ts'
    import { blockingIssuesFor, checkStoryboardRefs } from './src/services/storyboard-assets.ts'
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

/**
 * 一个短剧项目的一镜：视频提示词 @ 到本集角色「哥伦布」，首/尾关键帧已确认（图片真实落盘），
 * 视频目标绑定到该角色（可通过参数删掉这一行）。
 */
const SEED = `
  const ts = now()
  const dramaId = Number(db.insert(schema.dramas).values({ title: '绑定复查', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({ dramaId, episodeNumber: 1, title: 'E1', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
  const characterId = Number(db.insert(schema.characters).values({
    dramaId, name: '哥伦布', imageUrl: 'static/images/columbus.png', createdAt: ts, updatedAt: ts,
  }).run().lastInsertRowid)
  db.insert(schema.episodeCharacters).values({ episodeId, characterId, createdAt: ts }).run()
  const storyboardId = Number(db.insert(schema.storyboards).values({
    episodeId, storyboardNumber: 1,
    videoPrompt: '@哥伦布 缓步走向船舷，海风掀起斗篷',
    firstFrameImage: 'static/uploads/first.png', lastFrameImage: 'static/uploads/last.png',
    keyframesConfirmed: true, createdAt: ts, updatedAt: ts,
  }).run().lastInsertRowid)
  db.insert(schema.storyboardTargetAssets).values({
    storyboardId, target: 'video', kind: 'character', assetId: characterId, createdAt: ts,
  }).run()
  out({ dramaId, episodeId, characterId, storyboardId })
`

/** 真实判定：不传快照（批量 runner 的调用方式）；codes 取自同一条读库口径的一致性检查 */
function judge(seed, before = '') {
  return `${before}
    const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, ${seed.storyboardId}))
    const keyframes = await loadEpisodeKeyframes(${seed.episodeId})
    const reason = await videoBlockReason(sb, keyframes)
    const codes = blockingIssuesFor(await checkStoryboardRefs(sb), 'video_prompt').map(issue => issue.code)
    out({ reason, codes, keyframesConfirmed: keyframes.get(${seed.storyboardId})?.confirmed })
  `
}

function prepare() {
  const dir = mkdtempSync(path.join(tmpdir(), 'video-batch-bindings-'))
  mkdirSync(path.join(dir, 'static', 'uploads'), { recursive: true })
  writeFileSync(path.join(dir, 'static', 'uploads', 'first.png'), 'PNG')
  writeFileSync(path.join(dir, 'static', 'uploads', 'last.png'), 'PNG')
  const env = { SQLITE_PATH: path.join(dir, 'db.sqlite3'), HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') }
  return { dir, env, seed: run(SEED, env) }
}

test('库里有视频绑定：不传整集快照时现读绑定，@ 到的资产不再被判 unbound_mention', () => {
  const { dir, env, seed } = prepare()
  try {
    const result = run(judge(seed), env)
    assert.equal(result.keyframesConfirmed, true, '前置：关键帧已确认（否则根本走不到绑定判定）')
    assert.equal(result.reason, null, '绑定存在 → 提交前复查不阻断')
    assert.deepEqual(result.codes, [], '一致性检查没有任何阻断问题')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('库里有视频绑定：不传快照时按该镜真实绑定放行，且不受整集快照缺省影响', () => {
  const { dir, env, seed } = prepare()
  try {
    // 反向证据：把这一镜的绑定行删掉，同一份数据立刻被判 unbound_mention——
    // 说明上面那次放行是读到了真实绑定行，而不是「空绑定也不报」的宽松判定。
    const result = run(judge(seed, `
      db.delete(schema.storyboardTargetAssets)
        .where(eq(schema.storyboardTargetAssets.storyboardId, ${seed.storyboardId})).run()
    `), env)
    assert.ok(result.reason, '没有绑定行 → 阻断')
    assert.match(result.reason, /视频提示词与参考图不一致/)
    assert.match(result.reason, /@哥伦布 还没有绑定到视频/, '阻断文案来自 unbound_mention')
    assert.deepEqual(result.codes, ['unbound_mention'], '唯一阻断问题就是 unbound_mention')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('传入整集绑定快照时按快照判定：空快照阻断，含绑定的快照放行', () => {
  const { dir, env, seed } = prepare()
  try {
    const empty = run(`
      const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, ${seed.storyboardId}))
      const keyframes = await loadEpisodeKeyframes(${seed.episodeId})
      // 库里这一镜确实有绑定，但调用方给的整集快照是空的 → 按快照判定
      const reason = await videoBlockReason(sb, keyframes, { bindingsByShot: new Map() })
      out({ reason })
    `, env)
    assert.match(String(empty.reason), /@哥伦布 还没有绑定到视频/, '空快照按空绑定处理（快照优先于库）')

    const filled = run(`
      const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, ${seed.storyboardId}))
      const keyframes = await loadEpisodeKeyframes(${seed.episodeId})
      const bindingsByShot = new Map([[
        ${seed.storyboardId},
        { first: [], mid: [], last: [], video: [{ kind: 'character', assetId: ${seed.characterId}, selectedImage: null }] },
      ]])
      const reason = await videoBlockReason(sb, keyframes, { bindingsByShot })
      out({ reason })
    `, env)
    assert.equal(filled.reason, null, '快照里有这一镜的绑定 → 不阻断')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
