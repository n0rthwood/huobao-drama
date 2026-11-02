import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function scenario() {
  const dir = mkdtempSync(path.join(tmpdir(), 'storyboard-prompt-write-'))
  try {
    const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', `
      import { db, schema, initDb } from './src/db/index.ts'
      import { eq } from 'drizzle-orm'
      import { buildAgentRequestContext } from './src/agents/context.ts'
      import * as tools from './src/agents/tools/storyboard-tools.ts'
      initDb()
      const at = '2026-01-01T00:00:00.000Z'
      await db.insert(schema.dramas).values({ id: 1, title: 'approved project', createdAt: at, updatedAt: at })
      await db.insert(schema.episodes).values({ id: 1, dramaId: 1, episodeNumber: 1, title: 'episode one', createdAt: at, updatedAt: at })
      await db.insert(schema.episodes).values({ id: 2, dramaId: 1, episodeNumber: 2, title: 'episode two', createdAt: at, updatedAt: at })
      for (const [id, episodeId] of [[1,1],[2,1],[3,2]]) await db.insert(schema.storyboards).values({
        id, episodeId, storyboardNumber: id, title: 'approved title', description: 'approved scene',
        duration: 12, movement: 'push_in', continuityBoundary: 'cut',
        firstFramePrompt: 'approved first', midFramePrompt: 'approved mid', midFrameTime: 6,
        lastFramePrompt: 'approved last', videoPrompt: 'old video', createdAt: at, updatedAt: at,
      })
      const row = async id => (await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)))[0]
      const ctx = scope => ({ requestContext: buildAgentRequestContext({ episodeId: 1, dramaId: 1, storyboardId: 1, storyboardPromptScope: scope }) })
      const video = tools.promptStoryboardUpdaters.video
      const keyframes = tools.promptStoryboardUpdaters.keyframes
      const before = await row(1)
      const videoResult = await video.execute({ storyboard_id: 1, video_prompt: 'new video',
        title: '', description: '', duration: 0, scene_id: null, character_ids: [], prop_ids: [],
        movement: '', first_frame_prompt: '', mid_frame_prompt: '', mid_frame_time: 0, last_frame_prompt: '', continuity: 'continue',
      }, ctx('video'))
      const afterVideo = await row(1)
      const keyResult = await keyframes.execute({ storyboard_id: 1, first_frame_prompt: '', mid_frame_prompt: '',
        last_frame_prompt: 'new last', video_prompt: '', description: '', duration: 0,
      }, ctx('keyframes'))
      const afterKeys = await row(1)
      const wrongShot = await video.execute({ storyboard_id: 2, video_prompt: 'wrong shot' }, ctx('video'))
      const wrongEpisode = await video.execute({ storyboard_id: 3, video_prompt: 'wrong episode' }, {requestContext: buildAgentRequestContext({episodeId: 1, dramaId: 1})})
      process.stdout.write('@@' + JSON.stringify({before, afterVideo, afterKeys, videoResult, keyResult, wrongShot, wrongEpisode, otherShot: await row(2), otherEpisode: await row(3)}))
    `], { cwd: backendRoot, encoding: 'utf8', env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3') } })
    return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// Exercise real writes in an isolated database, including empty values and cross-shot attempts.
test('prompt generation cannot overwrite approved shot data or another prompt scope', () => {
  const r = scenario()
  const preserved = ['title', 'description', 'duration', 'movement', 'sceneId', 'continuityBoundary', 'firstFramePrompt', 'midFramePrompt', 'midFrameTime', 'lastFramePrompt']
  for (const key of preserved) assert.deepEqual(r.afterVideo[key], r.before[key], `video generation must preserve ${key}`)
  assert.equal(r.afterVideo.videoPrompt, 'new video')
  assert.equal(r.afterKeys.videoPrompt, 'new video')
  assert.equal(r.afterKeys.firstFramePrompt, '')
  assert.equal(r.afterKeys.midFramePrompt, '')
  assert.equal(r.afterKeys.lastFramePrompt, 'new last')
  for (const key of ['title', 'description', 'duration', 'movement', 'continuityBoundary']) assert.deepEqual(r.afterKeys[key], r.before[key])
  assert.match(r.wrongShot.error, /Only storyboard 1/)
  assert.equal(r.otherShot.videoPrompt, 'old video')
  assert.match(r.wrongEpisode.error, /current episode/)
  assert.equal(r.otherEpisode.videoPrompt, 'old video')
})
