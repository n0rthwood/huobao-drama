/**
 * h3-jobs 视频队列（Issue #100）的行为测试：提交/跟踪/取消/重启恢复/批量停止。
 * 跑在 tsx 子进程里：独立临时库 + 按契约 v1 实现的内存假队列（替换 global fetch），不碰网络。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('..', import.meta.url))

const PRELUDE = `
  import { eq } from 'drizzle-orm'
  import { db, schema } from './src/db/index.ts'
  const ts = new Date().toISOString()
  const png = n => 'data:image/png;base64,' + Buffer.from('fake-png-' + n).toString('base64')
  const queue = { version: '1', jobs: new Map(), posts: [], uploads: 0, cancels: [], failNextPost: 0 }
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const view = job => ({
    id: job.id, object: 'job', client: 'huobao', status: job.status, input: job.input,
    queue: job.status === 'queued' ? { position: 1, length: 2, estimated_start_seconds: 30 } : null,
    progress: job.status === 'running' ? { phase: 'sampling', step: 3, total_steps: 8, fraction: 0.4, elapsed_seconds: 20, remaining_seconds: 30 } : null,
    estimate: { run_seconds: 50, basis: 'measured', samples: 4, duration_key: job.input.duration_seconds },
    estimated_finish_seconds: job.status === 'queued' ? 80 : job.status === 'running' ? 30 : null,
    cancel_requested: !!job.cancelRequested,
    outputs: job.status === 'succeeded' ? [{ index: 0, url: '/v1/jobs/' + job.id + '/outputs/0', content_type: 'video/mp4' }] : [],
    error: null,
  })
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    const method = init.method || 'GET'
    if (u.pathname === '/healthz') return json({ ok: true, service: 'h3-central', version: queue.version })
    if (u.pathname === '/v1/files') { queue.uploads++; return json({ id: 'file_' + queue.uploads }, 201) }
    if (u.pathname === '/v1/jobs' && method === 'POST') {
      const body = JSON.parse(init.body)
      queue.posts.push({ body, key: init.headers['Idempotency-Key'] })
      if (queue.failNextPost > 0) { queue.failNextPost--; return json({ error: { code: 'internal', message: 'boom' } }, 503) }
      const job = { id: 'job_' + (queue.jobs.size + 1), status: 'queued', input: body }
      queue.jobs.set(job.id, job)
      return json(view(job), 202)
    }
    if (u.pathname === '/v1/jobs') {
      const ids = (u.searchParams.get('ids') || '').split(',')
      return json({ object: 'list', data: ids.filter(id => queue.jobs.has(id)).map(id => view(queue.jobs.get(id))) })
    }
    const cancel = /^\\/v1\\/jobs\\/([^/]+)\\/cancel$/.exec(u.pathname)
    if (cancel) {
      const job = queue.jobs.get(cancel[1])
      queue.cancels.push(job.id)
      if (job.status === 'queued') job.status = 'cancelled'
      else if (job.status === 'running') job.cancelRequested = true
      return json(view(job))
    }
    if (/\\/outputs\\/0$/.test(u.pathname)) return new Response(Buffer.from('fake-mp4-bytes'), { status: 200, headers: { 'content-type': 'video/mp4' } })
    return json({ error: { code: 'not_found', message: u.pathname } }, 404)
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  async function until(check, label, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = await check()
      if (value) return value
      if (Date.now() > deadline) throw new Error('timeout: ' + label)
      await sleep(50)
    }
  }
  const taskRow = async id => (await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)))[0]
  const [drama] = await db.insert(schema.dramas).values({ title: 'h3 test', createdAt: ts, updatedAt: ts }).returning()
  const [episode] = await db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 1, title: 'e1', createdAt: ts, updatedAt: ts }).returning()
  const [config] = await db.insert(schema.aiServiceConfigs).values({
    serviceType: 'video', provider: 'h3-jobs', name: 'queue', baseUrl: 'http://h3.invalid', apiKey: '',
    model: JSON.stringify(['MiniMax-H3-INT8-ComfyUI']), priority: 100, isActive: true, createdAt: ts, updatedAt: ts,
  }).returning()
  const newShot = async n => (await db.insert(schema.storyboards).values({ episodeId: episode.id, storyboardNumber: n, createdAt: ts, updatedAt: ts }).returning())[0]
  const CONTRACT_PROMPT = 'integrated_multimodal_description: a slow push toward the gate.\\noverall_soundscape: wind.\\nnon_diegetic_music: none.'
`

function isolated(body) {
  const dir = mkdtempSync(path.join(tmpdir(), 'h3-jobs-'))
  try {
    const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', PRELUDE + body + '\nprocess.exit(0)'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3'), HUOBAO_DATA_DIR: dir },
    })
    return JSON.parse(out.slice(out.lastIndexOf('@@') + 2).split('\n')[0])
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('submission persists the request first, sends the H3 contract body and the tracker writes the video back', () => {
  const result = isolated(`
    import { generateVideo } from './src/services/generation.ts'
    import { startH3JobsTracker } from './src/services/h3-jobs.ts'
    const shot = await newShot(1)
    const id = await generateVideo({
      storyboardId: shot.id, prompt: CONTRACT_PROMPT, configId: config.id, duration: 5.4,
      firstFrameUrl: png(1), midFrameUrl: png(2), midFrameTime: 2.5, lastFrameUrl: png(3),
      referenceImageUrls: [png(1), png(4)], aspectRatio: '16:9', resolution: '720p',
    })
    const submitted = await until(async () => (await taskRow(id))?.taskId && taskRow(id), 'task_id')
    const state = JSON.parse(submitted.remoteState)
    queue.jobs.get(submitted.taskId).status = 'running'
    startH3JobsTracker()
    const running = await until(async () => { const r = await taskRow(id); return r.status === 'processing' && r }, 'running')
    queue.jobs.get(submitted.taskId).status = 'succeeded'
    const done = await until(async () => { const r = await taskRow(id); return r.status === 'completed' && r }, 'completed')
    const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, shot.id))
    console.log('@@' + JSON.stringify({
      posts: queue.posts, persisted: state.request, statusAfterSubmit: submitted.status,
      runningProgress: JSON.parse(running.remoteState).progress, runningEstimate: JSON.parse(running.remoteState).estimate,
      done: { localPath: done.localPath }, videoUrl: sb.videoUrl,
    }))
  `)
  assert.equal(result.posts.length, 1)
  const body = result.posts[0].body
  assert.deepEqual(result.persisted, body, 'the exact request body is on disk before the job is created')
  assert.equal(result.statusAfterSubmit, 'queued')
  assert.equal(body.mode, 'reference')
  assert.equal(body.model, 'minimax-h3-int8')
  assert.equal(body.duration_seconds, 5, 'whole seconds only, like the ComfyUI path')
  assert.deepEqual([body.width, body.height], [960, 544])
  assert.equal(body.mid_frame.time_seconds, 2.5)
  assert.ok(body.first_frame && body.last_frame && body.mid_frame.file)
  assert.equal(body.reference_images.length, 2)
  assert.equal(body.steps, undefined, 'steps are left to the queue default')
  assert.match(body.prompt, /<Picture 1> is the first frame/)
  assert.equal(result.runningProgress.phase, 'sampling')
  assert.equal(result.runningEstimate.duration_key, 5)
  assert.match(result.done.localPath, /^static\/videos\/.+\.mp4$/)
  assert.equal(result.videoUrl, result.done.localPath)
})

test('a running job cancelled locally is never written back even if the queue finishes it', () => {
  const result = isolated(`
    import { generateVideo } from './src/services/generation.ts'
    import { cancelVideoTask, startH3JobsTracker } from './src/services/h3-jobs.ts'
    const shot = await newShot(1)
    const id = await generateVideo({ storyboardId: shot.id, prompt: CONTRACT_PROMPT, configId: config.id, duration: 5, firstFrameUrl: png(1), referenceImageUrls: [png(1)] })
    const submitted = await until(async () => (await taskRow(id))?.taskId && taskRow(id), 'task_id')
    queue.jobs.get(submitted.taskId).status = 'running'
    const afterCancel = await cancelVideoTask(id)
    queue.jobs.get(submitted.taskId).status = 'succeeded'
    startH3JobsTracker()
    const final = await until(async () => { const r = await taskRow(id); return r.status === 'cancelled' && r }, 'cancelled')
    const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, shot.id))
    console.log('@@' + JSON.stringify({ statusAfterCancel: afterCancel.status, cancels: queue.cancels, final: { localPath: final.localPath }, videoUrl: sb.videoUrl }))
  `)
  assert.ok(['queued', 'processing'].includes(result.statusAfterCancel), 'a running job stays active until the queue confirms the cancel')
  assert.equal(result.cancels.length, 1)
  assert.equal(result.final.localPath, null)
  assert.equal(result.videoUrl, null)
})

test('a contract version mismatch fails the task without creating a job', () => {
  const result = isolated(`
    import { generateVideo } from './src/services/generation.ts'
    queue.version = '2'
    const shot = await newShot(1)
    const id = await generateVideo({ storyboardId: shot.id, prompt: CONTRACT_PROMPT, configId: config.id, duration: 5 })
    const failed = await until(async () => { const r = await taskRow(id); return r.status === 'failed' && r }, 'failed')
    console.log('@@' + JSON.stringify({ error: failed.errorMsg, posts: queue.posts.length }))
  `)
  assert.match(result.error, /契约版本不匹配/)
  assert.equal(result.posts, 0)
})

test('a transient create failure is retried by the tracker with the same idempotency key', () => {
  const result = isolated(`
    import { generateVideo } from './src/services/generation.ts'
    import { startH3JobsTracker } from './src/services/h3-jobs.ts'
    queue.failNextPost = 1
    const shot = await newShot(1)
    const id = await generateVideo({ storyboardId: shot.id, prompt: CONTRACT_PROMPT, configId: config.id, duration: 5 })
    await until(() => queue.posts.length === 1, 'first post')
    await sleep(200)
    const pending = await taskRow(id)
    startH3JobsTracker()
    const submitted = await until(async () => (await taskRow(id))?.taskId && taskRow(id), 'task_id after retry')
    console.log('@@' + JSON.stringify({ pending: { status: pending.status, taskId: pending.taskId }, keys: queue.posts.map(p => p.key), jobs: queue.jobs.size, taskId: submitted.taskId }))
  `)
  assert.deepEqual(result.pending, { status: 'queued', taskId: null })
  assert.equal(result.keys.length, 2)
  assert.equal(result.keys[0], result.keys[1])
  assert.equal(result.jobs, 1)
  assert.equal(result.taskId, 'job_1')
})

test('a resumed parallel batch follows its persisted tasks instead of resubmitting', () => {
  const result = isolated(`
    import { resumeVideoBatches } from './src/services/video-batch.ts'
    const a = await newShot(1)
    const b = await newShot(2)
    const [done] = await db.insert(schema.sysTask).values({ type: 'video', provider: 'h3-jobs', storyboardId: a.id, status: 'completed', localPath: 'static/videos/a.mp4', createdAt: ts, updatedAt: ts }).returning()
    const [cancelled] = await db.insert(schema.sysTask).values({ type: 'video', provider: 'h3-jobs', storyboardId: b.id, status: 'cancelled', createdAt: ts, updatedAt: ts }).returning()
    await db.update(schema.storyboards).set({ videoUrl: 'static/videos/a.mp4' }).where(eq(schema.storyboards.id, a.id))
    const [batch] = await db.insert(schema.videoBatches).values({
      episodeId: episode.id, status: 'running', options: JSON.stringify({ parallel: true }),
      items: JSON.stringify([
        { storyboard_id: a.id, storyboard_number: 1, state: 'running', task_id: done.id, error: null },
        { storyboard_id: b.id, storyboard_number: 2, state: 'running', task_id: cancelled.id, error: null },
      ]),
      createdAt: ts, updatedAt: ts,
    }).returning()
    await resumeVideoBatches()
    const row = await until(async () => { const [r] = await db.select().from(schema.videoBatches).where(eq(schema.videoBatches.id, batch.id)); return r.status !== 'running' && r }, 'batch end')
    console.log('@@' + JSON.stringify({ status: row.status, items: JSON.parse(row.items), tasks: (await db.select().from(schema.sysTask)).length }))
  `)
  assert.equal(result.status, 'done')
  assert.deepEqual(result.items.map(item => [item.state, item.error]), [['completed', null], ['failed', '已取消']])
  assert.equal(result.tasks, 2, 'no task was resubmitted')
})

test('stopping a parallel batch cancels queued shots and never submits pending ones', () => {
  const result = isolated(`
    import { resumeVideoBatches } from './src/services/video-batch.ts'
    const a = await newShot(1)
    const b = await newShot(2)
    queue.jobs.set('job_q', { id: 'job_q', status: 'queued', input: { duration_seconds: 5 } })
    const [queuedTask] = await db.insert(schema.sysTask).values({
      type: 'video', provider: 'h3-jobs', storyboardId: a.id, status: 'queued', taskId: 'job_q',
      remoteState: JSON.stringify({ config_id: config.id }), createdAt: ts, updatedAt: ts,
    }).returning()
    const [batch] = await db.insert(schema.videoBatches).values({
      episodeId: episode.id, status: 'running', options: JSON.stringify({ parallel: true, cancelRequested: true }),
      items: JSON.stringify([
        { storyboard_id: a.id, storyboard_number: 1, state: 'running', task_id: queuedTask.id, error: null },
        { storyboard_id: b.id, storyboard_number: 2, state: 'pending', task_id: null, error: null },
      ]),
      createdAt: ts, updatedAt: ts,
    }).returning()
    await resumeVideoBatches()
    const row = await until(async () => { const [r] = await db.select().from(schema.videoBatches).where(eq(schema.videoBatches.id, batch.id)); return r.status !== 'running' && r }, 'batch end')
    console.log('@@' + JSON.stringify({ status: row.status, items: JSON.parse(row.items), cancels: queue.cancels, task: (await taskRow(queuedTask.id)).status, tasks: (await db.select().from(schema.sysTask)).length }))
  `)
  assert.equal(result.status, 'cancelled')
  assert.deepEqual(result.cancels, ['job_q'])
  assert.equal(result.task, 'cancelled')
  assert.deepEqual(result.items.map(item => [item.state, item.error]), [['failed', '已取消'], ['pending', null]])
  assert.equal(result.tasks, 1, 'the pending shot was not submitted after stop')
})
