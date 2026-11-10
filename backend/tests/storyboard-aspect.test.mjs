/**
 * 画幅进上下文 + 保存校验（Issue #92）。
 * - `read_storyboard_context` 把项目画幅与构图方向交给模型；
 * - 关键帧提示词写了与项目不符的画幅/构图方向时，保存被退回且一个字都不落库；
 * - 不含画幅字样、含「10:30」时刻、含单独 portrait（肖像）的提示词照常放行。
 * 真跑库：临时 SQLITE_PATH + 仓库自带 tsx 子进程，绝不碰开发库。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function run(script) {
  const dir = mkdtempSync(path.join(tmpdir(), 'storyboard-aspect-'))
  try {
    const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot,
      encoding: 'utf8',
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3') },
    })
    return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const SEED = `
  import { initDb, db, schema } from './src/db/index.ts'
  import { eq } from 'drizzle-orm'
  import { storyboardTools } from './src/agents/tools/storyboard-tools.ts'
  import { buildAgentRequestContext } from './src/agents/context.ts'
  initDb()
  const at = '2026-01-01T00:00:00.000Z'
  // 1 = 9:16 竖屏短剧，2 = 16:9 横屏
  await db.insert(schema.dramas).values({ id: 1, title: 'portrait', aspectRatio: '9:16', createdAt: at, updatedAt: at })
  await db.insert(schema.dramas).values({ id: 2, title: 'landscape', aspectRatio: '16:9', createdAt: at, updatedAt: at })
  await db.insert(schema.episodes).values({ id: 1, dramaId: 1, episodeNumber: 1, title: 'E1', scriptContent: '刘邦入咸阳。', createdAt: at, updatedAt: at })
  await db.insert(schema.episodes).values({ id: 2, dramaId: 2, episodeNumber: 1, title: 'E2', scriptContent: '刘邦入咸阳。', createdAt: at, updatedAt: at })
  await db.insert(schema.storyboards).values({ id: 1, episodeId: 1, storyboardNumber: 1, title: 'S1', duration: 10, lastFramePrompt: '原稿尾帧', createdAt: at, updatedAt: at })
  await db.insert(schema.storyboards).values({ id: 2, episodeId: 2, storyboardNumber: 1, title: 'S1', duration: 10, createdAt: at, updatedAt: at })
  const portrait = { requestContext: buildAgentRequestContext({ episodeId: 1, dramaId: 1 }) }
  const landscape = { requestContext: buildAgentRequestContext({ episodeId: 2, dramaId: 2 }) }
  const update = storyboardTools.updateStoryboard.execute
  const readContext = storyboardTools.readStoryboardContext.execute
  const prompt = async id => (await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)))[0]
`

test('read_storyboard_context hands the project aspect and composition to the model', () => {
  const result = run(`${SEED}
    const portraitCtx = await readContext({}, portrait)
    const landscapeCtx = await readContext({}, landscape)
    console.log('@@' + JSON.stringify({
      portrait: { aspect_ratio: portraitCtx.aspect_ratio, composition: portraitCtx.composition },
      landscape: { aspect_ratio: landscapeCtx.aspect_ratio, composition: landscapeCtx.composition },
    }))
  `)
  assert.deepEqual(result.portrait, { aspect_ratio: '9:16', composition: '竖构图' })
  assert.deepEqual(result.landscape, { aspect_ratio: '16:9', composition: '横构图' })
})

test('a keyframe prompt that contradicts the project aspect is rejected and never written', () => {
  const result = run(`${SEED}
    const rejected = await update({ storyboard_id: 1, last_frame_prompt: '@咸阳宫，黄昏，16:9 横构图电影感剧照。@刘邦 立于阶前。' }, portrait)
    const afterReject = (await prompt(1)).lastFramePrompt
    const accepted = await update({ storyboard_id: 1, last_frame_prompt: '@咸阳宫，黄昏，9:16 竖构图电影感剧照。@刘邦 立于阶前。' }, portrait)
    const afterAccept = (await prompt(1)).lastFramePrompt
    // 同样的文字在 16:9 项目放行
    const landscapeOk = await update({ storyboard_id: 2, last_frame_prompt: '@咸阳宫，黄昏，16:9 横构图电影感剧照。@刘邦 立于阶前。' }, landscape)
    const landscapeSaved = (await prompt(2)).lastFramePrompt
    console.log('@@' + JSON.stringify({
      rejectedError: typeof rejected.error === 'string' ? rejected.error : null,
      rejectedAspect: rejected.aspect_ratio,
      afterReject,
      acceptedError: accepted.error || null,
      afterAccept,
      landscapeError: landscapeOk.error || null,
      landscapeSaved,
    }))
  `)
  assert.ok(result.rejectedError, 'a 16:9 prompt in a 9:16 project must come back as an error')
  assert.match(result.rejectedError, /9:16/)
  assert.equal(result.rejectedAspect, '9:16')
  assert.equal(result.afterReject, '原稿尾帧', 'the rejected prompt must not be written')
  assert.equal(result.acceptedError, null)
  assert.match(result.afterAccept, /9:16 竖构图/)
  assert.equal(result.landscapeError, null)
  assert.match(result.landscapeSaved, /16:9 横构图/)
})

test('prompts without aspect wording, with a clock time, or with a portrait painting are saved as-is', () => {
  const result = run(`${SEED}
    const plain = '@咸阳宫，黄昏，中景平视固定机位，@刘邦 立于阶前，双手垂于体侧。单帧静态画面。'
    const clock = '@书房，夜晚，墙上挂钟指向 10:30，@刘邦 坐在案前，右手按在竹简上。单帧静态画面。'
    const portraitPainting = '@厅堂，正午，墙上挂着一幅 portrait，@刘邦 站在画前，左手自然垂落。单帧静态画面。'
    const a = await update({ storyboard_id: 1, last_frame_prompt: plain }, portrait)
    const afterPlain = (await prompt(1)).lastFramePrompt
    const b = await update({ storyboard_id: 1, mid_frame_prompt: clock }, portrait)
    const afterClock = (await prompt(1)).midFramePrompt
    const c = await update({ storyboard_id: 1, first_frame_prompt: portraitPainting }, portrait)
    const afterPainting = (await prompt(1)).firstFramePrompt
    console.log('@@' + JSON.stringify({
      errors: [a.error || null, b.error || null, c.error || null],
      afterPlain, afterClock, afterPainting, plain, clock, portraitPainting,
    }))
  `)
  assert.deepEqual(result.errors, [null, null, null])
  assert.equal(result.afterPlain, result.plain)
  assert.equal(result.afterClock, result.clock)
  assert.equal(result.afterPainting, result.portraitPainting)
})

test('save_storyboards checks the aspect before replace_existing clears the episode', () => {
  const result = run(`${SEED}
    const save = storyboardTools.saveStoryboards.execute
    const rejected = await save({
      replace_existing: true,
      storyboards: [
        { shot_number: 1, title: '阶前', duration: 10, last_frame_prompt: '@咸阳宫，黄昏，16:9 横构图电影感剧照。@刘邦 立于阶前。' },
      ],
    }, portrait)
    const survivors = (await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, 1)))
      .filter(sb => !sb.deletedAt)
      .map(sb => ({ n: sb.storyboardNumber, last: sb.lastFramePrompt }))
    const accepted = await save({
      replace_existing: true,
      storyboards: [
        { shot_number: 1, title: '阶前', duration: 10, last_frame_prompt: '@咸阳宫，黄昏，9:16 竖构图电影感剧照。@刘邦 立于阶前。' },
      ],
    }, portrait)
    const afterAccept = (await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, 1)))
      .filter(sb => !sb.deletedAt)
      .map(sb => sb.lastFramePrompt)
    console.log('@@' + JSON.stringify({
      rejectedError: typeof rejected.error === 'string' ? rejected.error : null,
      rejectedShots: (rejected.rejected || []).map(item => item.shot_number),
      rejectedCount: rejected.count,
      survivors,
      acceptedError: accepted.error || null,
      afterAccept,
    }))
  `)
  assert.ok(result.rejectedError, 'the batch must be rejected')
  assert.deepEqual(result.rejectedShots, [1])
  assert.equal(result.rejectedCount, 0)
  // replace_existing 不得在校验前清空：原有分镜与提示词原样还在
  assert.deepEqual(result.survivors, [{ n: 1, last: '原稿尾帧' }])
  assert.equal(result.acceptedError, null)
  assert.deepEqual(result.afterAccept.map(text => /9:16 竖构图/.test(text)), [true])
})
