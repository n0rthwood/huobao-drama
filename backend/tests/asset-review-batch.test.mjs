import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('..', import.meta.url))
function isolated(script) {
  const dir = mkdtempSync(path.join(tmpdir(), 'review-batch-'))
  try {
    const output = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: root, encoding: 'utf8', env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3') },
    })
    return JSON.parse(output.slice(output.lastIndexOf('@@') + 2))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const fixture = `
  import { db, schema } from './src/db/index.ts'
  import { eq } from 'drizzle-orm'
  import { fingerprintOf } from './src/services/asset-review.ts'
  import { episodeAssetReview } from './src/routes/asset-review.ts'
  const at = '2026-01-01T00:00:00.000Z'
  db.insert(schema.dramas).values({id:1,title:'doc',projectType:'documentary',createdAt:at,updatedAt:at}).run()
  db.insert(schema.episodes).values({id:1,dramaId:1,episodeNumber:1,title:'E1',createdAt:at,updatedAt:at}).run()
  db.insert(schema.episodes).values({id:2,dramaId:1,episodeNumber:2,title:'E2',createdAt:at,updatedAt:at}).run()
  const seed = (id, needKind, needDesc, status='missing', episodeId=1) => db.insert(schema.assetReviewItems).values({
    id, episodeId, runId:1, segmentNo:1, narrationExcerpt:'x', infoPoint:'point'+id, needKind, needDesc,
    status, fingerprint:fingerprintOf('point'+id, needKind), createdAt:at, updatedAt:at,
  }).run()
  const post = async (route, body) => {
    const response = await episodeAssetReview.request('/1/asset-review/'+route, {
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body),
    })
    return {status:response.status, body:await response.json()}
  }
`

test('批量建卡严格同名去重，单条 review 建卡返回候选；普通建卡保持不变', () => {
  const result = isolated(`${fixture}
    import characters from './src/routes/characters.ts'
    import scenes from './src/routes/scenes.ts'
    import props from './src/routes/props.ts'
    seed(1,'character','张 三')
    seed(2,'character','张_三')
    seed(3,'prop_faithful','古图')
    seed(4,'scene','古城')
    seed(5,'none','旁白')
    seed(6,'exposition','事件')
    seed(7,'prop','外集', 'missing', 2)
    const batch = await post('create-assets',{item_ids:[1,2,3,4,5,6,7]})
    const assetPost = async (app, name) => {
      const r = await app.request('/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({drama_id:1,episode_id:1,asset_review_item_id:2,...name})})
      return {status:r.status,body:await r.json()}
    }
    const duplicate = [await assetPost(characters,{name:'张 三'}),await assetPost(scenes,{location:'古城'}),await assetPost(props,{name:'古图'})]
    const normal = await characters.request('/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({drama_id:1,episode_id:1,name:'张 三'})})
    const rows = db.select().from(schema.assetReviewItems).all()
    const prop = db.select().from(schema.props).get()
    const scene = db.select().from(schema.scenes).get()
    console.log('@@'+JSON.stringify({batch,duplicate,normal:normal.status,rows,prop,scene}))
  `)
  assert.equal(result.batch.status, 200)
  assert.deepEqual(result.batch.body.data.created.map(x => x.item_id), [1, 3, 4])
  assert.deepEqual(result.batch.body.data.skipped.map(x => x.reason), ['existing_asset', 'no_kind', 'no_kind', 'not_found'])
  assert.equal(result.batch.body.data.skipped[0].candidate.name, '张_三')
  assert.equal(result.rows.find(x => x.id === 2).status, 'missing')
  assert.equal(result.rows.find(x => x.id === 1).status, 'added')
  assert.equal(result.prop.faithful, 1)
  assert.equal(result.scene.time, '')
  for (const duplicate of result.duplicate) {
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.body.error, 'duplicate_asset')
    assert.ok(duplicate.body.candidate.id)
  }
  assert.equal(result.normal, 201)
})

test('批量入队幂等、状态映射和执行前人工处置取消', () => {
  const result = isolated(`${fixture}
    import { withExtractionLock } from './src/services/extraction.ts'
    seed(1,'character','人物')
    seed(2,'character','人物二')
    seed(3,'scene','场景','ignored')
    seed(4,'prop','外集','missing',2)
    db.insert(schema.aiServiceConfigs).values({serviceType:'text',provider:'openai',name:'fake',baseUrl:'https://example.invalid',apiKey:'',model:'["fake"]',isActive:true,createdAt:at,updatedAt:at}).run()
    let release
    const gate = new Promise(resolve => { release = resolve })
    const blocker = withExtractionLock('episode:1:extract_characters', () => gate)
    const [first, second] = await Promise.all([
      post('extract-batch',{item_ids:[1,2,3,4]}), post('extract-batch',{item_ids:[1,2]}),
    ])
    const viewResponse = await episodeAssetReview.request('/1/asset-review')
    const view = (await viewResponse.json()).data
    const items = view.segments.flatMap(s => s.items)
    const status = await post('batch-status',{item_ids:[1,2,3,4],status:'not_needed',reason:'client reason'})
    release()
    await blocker
    for (let i=0;i<100;i++) {
      const tasks = db.select().from(schema.sysTask).all()
      if (tasks.length === 2 && tasks.every(t => t.status === 'cancelled')) break
      await new Promise(resolve => setImmediate(resolve))
    }
    const tasks = db.select().from(schema.sysTask).all()
    const rows = db.select().from(schema.assetReviewItems).all()
    console.log('@@'+JSON.stringify({first,second,items,status,tasks,rows}))
  `)
  assert.equal(result.first.body.data.queued.length + result.second.body.data.queued.length, 2)
  assert.equal(result.first.body.data.skipped.filter(x => x.reason === 'not_missing').length, 1)
  assert.equal(result.first.body.data.skipped.filter(x => x.reason === 'not_found').length, 1)
  assert.equal(result.second.body.data.skipped.filter(x => x.reason === 'already_queued').length, 2)
  assert.deepEqual(result.items.slice(0, 2).map(x => x.extraction.status), ['queued', 'queued'])
  assert.equal(result.items[2].extraction, null)
  assert.equal(result.status.body.data.updated, 2)
  assert.deepEqual(result.status.body.data.skipped.map(x => x.reason), ['not_missing', 'not_found'])
  assert.equal(result.rows[0].reason, '审核清单：批量标记无需素材')
  assert.equal(result.rows[2].status, 'ignored')
  assert.deepEqual(result.tasks.map(t => [t.status, t.errorMsg]), [
    ['cancelled', '条目已被人工处置'], ['cancelled', '条目已被人工处置'],
  ])
})

test('GET 只映射本集活跃提取任务，忽略其他任务及终态', () => {
  const result = isolated(`${fixture}
    seed(1,'character','甲')
    seed(2,'scene','乙')
    seed(3,'prop','丙')
    seed(4,'prop','丁')
    const add = (id, episodeId, type, status, params) => db.insert(schema.sysTask).values({
      id, episodeId, type, status, params:JSON.stringify(params), createdAt:at, updatedAt:at,
    }).run()
    add(10,1,'text','queued',{kind:'extract_characters',assetReviewItemId:1})
    add(11,1,'text','processing',{kind:'extract_scenes',assetReviewItemId:2})
    add(12,1,'text','completed',{kind:'extract_props',assetReviewItemId:3})
    add(13,1,'text','processing',{kind:'asset_review',assetReviewItemId:3})
    add(14,2,'text','queued',{kind:'extract_props',assetReviewItemId:4})
    add(15,1,'image','queued',{kind:'extract_props',assetReviewItemId:4})
    const response = await episodeAssetReview.request('/1/asset-review')
    console.log('@@'+JSON.stringify((await response.json()).data.segments.flatMap(s => s.items)))
  `)
  assert.deepEqual(result.map(x => x.extraction), [
    {task_id:10,status:'queued'}, {task_id:11,status:'processing'}, null, null,
  ])
})
