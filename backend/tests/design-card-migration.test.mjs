/**
 * `intent` → 设计卡的一次性启动迁移（Issue #57，契约 §7）：
 * - 映射表逐行（device × deterministic → combo，以及迁出的计划）；
 * - 无 intent / 坏 JSON 的镜头置空白（drama 3 的 74 镜走这条）；
 * - 孤儿 intent（指向已不存在的分镜）不计数——迁移按 `storyboards` 行驱动；
 * - 幂等：第二次执行直接返回，`intent` / `intent_reviewed` 两列已被 DROP。
 * 临时 SQLITE_PATH + 仓库自带 tsx 子进程，绝不碰开发库。
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
  const dir = mkdtempSync(path.join(tmpdir(), 'design-card-migration-'))
  try {
    const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot,
      encoding: 'utf8',
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3') },
    })
    return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

/**
 * 升级前的库：新 schema 不再建 `intent` 两列，所以这里手工补回来，
 * 模拟「存量库刚升级、迁移还没跑」的状态。
 */
const PRE_MIGRATION = `
  import { initDb, db, schema } from './src/db/index.ts'
  import { sql } from 'drizzle-orm'
  initDb()
  db.run(sql.raw('ALTER TABLE storyboards ADD COLUMN intent TEXT'))
  db.run(sql.raw('ALTER TABLE storyboards ADD COLUMN intent_reviewed INTEGER NOT NULL DEFAULT 0'))
  const at = '2026-01-01T00:00:00.000Z'
  await db.insert(schema.dramas).values([
    { id: 6, title: 'doc', projectType: 'documentary', createdAt: at, updatedAt: at },
    { id: 3, title: 'legacy', projectType: 'documentary', createdAt: at, updatedAt: at },
  ])
  await db.insert(schema.episodes).values([
    { id: 7, dramaId: 6, episodeNumber: 1, title: 'E1', createdAt: at, updatedAt: at },
    { id: 5, dramaId: 3, episodeNumber: 1, title: 'E1', createdAt: at, updatedAt: at },
  ])
  const mapAnim = {
    info_point: '清军两路进藏', device: 'map_anim',
    must_show: [
      { kind: 'region', asset_id: 39, asset_kind: 'prop', semantic: 'rg-1', semantic_id: 'rg-1', semantic_name: '准噶尔汗国' },
      { kind: 'portrait', asset_id: 25, asset_kind: 'character' },
    ],
    overlay_plan: [
      { layer: 'polygon', anchor: { asset_id: 39, semantic_id: 'rg-1' }, reveal_at: 3 },
      { layer: 'marker', anchor: { asset_id: 39, semantic_id: 'pt-1' }, reveal_at: 6 },
      { layer: 'card', template: 'year', fields: { title: '1716' }, reveal_at: 1 },
    ],
    deterministic: 'replace', rationale: '先交代地理',
  }
  const rows = [
    // drama 6：四种映射各一（A / B / C / D）+ 空 intent + 坏 JSON + 软删行
    { id: 101, episodeId: 7, storyboardNumber: 1, duration: 12, intent: JSON.stringify(mapAnim) },
    { id: 102, episodeId: 7, storyboardNumber: 2, duration: 9, intent: JSON.stringify({ ...mapAnim, device: 'reenact_video', deterministic: 'none' }) },
    { id: 103, episodeId: 7, storyboardNumber: 3, duration: 40, intent: JSON.stringify({ ...mapAnim, device: 'archival', deterministic: 'pre' }) },
    { id: 104, episodeId: 7, storyboardNumber: 4, duration: 2, intent: JSON.stringify({ ...mapAnim, device: 'reenact_still', deterministic: 'post' }) },
    { id: 105, episodeId: 7, storyboardNumber: 5, duration: 8, intent: null },
    { id: 106, episodeId: 7, storyboardNumber: 6, duration: 8, intent: '{ broken json' },
    { id: 107, episodeId: 7, storyboardNumber: 7, duration: 8, intent: JSON.stringify({ ...mapAnim, device: 'card' }), deletedAt: at },
    // drama 3：存量集，一条 intent 都没有
    { id: 201, episodeId: 5, storyboardNumber: 1, duration: 8, intent: null },
    { id: 202, episodeId: 5, storyboardNumber: 2, duration: 8, intent: null },
  ]
  for (const row of rows) {
    db.run(sql\`INSERT INTO storyboards (id, episode_id, storyboard_number, duration, intent, intent_reviewed, deleted_at, created_at, updated_at)
      VALUES (\${row.id}, \${row.episodeId}, \${row.storyboardNumber}, \${row.duration}, \${row.intent}, 1, \${row.deletedAt ?? null}, \${at}, \${at})\`)
  }
  // 孤儿 intent：指向一条根本不存在的分镜（生产库里确实有一条）
  db.run(sql\`INSERT INTO storyboard_clips (storyboard_id, position, layer_doc, timeline, duration, render_path, render_signature, status, created_at, updated_at)
    VALUES (125, 'replace', '{}', '{}', 10, 'static/clips/orphan.mp4', 'sig-orphan', 'ready', \${at}, \${at})\`)
`

const COLUMNS = `
  const columnsOf = () => db.all(sql.raw('PRAGMA table_info(storyboards)')).map(c => c.name)
`

test('映射表逐行：device × deterministic → combo，计划与信息点原样迁出', () => {
  const result = run(`
    ${PRE_MIGRATION}${COLUMNS}
    const { migrateIntentToDesignCard } = await import('./src/services/design-card-migration.ts')
    const migrated = await migrateIntentToDesignCard()
    const migratedRows = db.all(sql.raw("SELECT id, combo, design_card, design_card_status, design_card_stale_reason FROM storyboards ORDER BY id"))
    console.log('@@' + JSON.stringify({ migrated, rows: migratedRows.map(r => ({ ...r, design_card: r.design_card ? JSON.parse(r.design_card) : null })) }))
  `)
  const byId = Object.fromEntries(result.rows.map(row => [row.id, row]))
  assert.deepEqual(
    [101, 102, 103, 104].map(id => byId[id].combo),
    ['A', 'B', 'C', 'D'],
    'replace→A / none→B / pre→C / post→D',
  )
  for (const id of [101, 102, 103, 104]) {
    assert.equal(byId[id].design_card_status, 'pending', 'schema 变了，所有迁移过来的卡一律回到待审')
    assert.equal(byId[id].design_card_stale_reason, 'migrated_from_intent')
  }

  const a = byId[101].design_card
  assert.equal(a.info_points[0].text, '清军两路进藏')
  assert.equal(a.info_points[0].via, 'layer', '组合 A 的信息点由图层段表达')
  assert.equal(a.layer_plan.planned_layers.length, 3, 'overlay_plan 条数等于计划图层条数')
  assert.deepEqual(a.layer_plan.planned_layers.map(l => l.at_s), [1, 3, 6], 'reveal_at → at_s 并按时刻升序')
  assert.equal(a.layer_plan.planned_layers.find(l => l.type === 'card').text, '1716', 'card 的 fields.title 迁成文案')
  assert.deepEqual(a.layer_plan.must_mark, [{ asset_id: 39, semantic_id: 'rg-1', name: '准噶尔汗国' }],
    '带语义的 must_show → 必须标注')
  assert.equal(a.layer_plan.base.asset_id, 39, '底图沿用第一张被锚定的资产，信息不丢')
  assert.equal(a.gen_plan, undefined, '组合 A 没有生成段计划')
  assert.equal(a.budget.layer_s, 12, '图层段预算 = 本镜时长（钳 4–30）')
  assert.equal(a.budget.gen_s, null)
  assert.equal(a.suggested_combo, 'A')
  assert.equal(a.rationale, '先交代地理')

  const b = byId[102].design_card
  assert.equal(b.layer_plan, undefined, '组合 B 没有图层段计划')
  assert.deepEqual(b.gen_plan.reference_assets, [{ kind: 'character', id: 25, name: '' }],
    '资产级 must_show（portrait）→ 生成段参考素材')
  assert.equal(b.budget.layer_s, null)
  assert.equal(b.budget.gen_s, 9)
  assert.equal(b.info_points[0].via, 'generated')

  const c = byId[103].design_card
  assert.ok(c.layer_plan && c.gen_plan, '组合 C 两段计划都有')
  assert.equal(c.gen_plan.first, undefined, '组合 C 的首帧由衔接帧锁定，迁移留空')
  assert.equal(c.budget.layer_s, 30, '时长 40s 被钳到图层段上限 30s')
  assert.equal(c.budget.gen_s, 15, '生成段钳到 15s')

  const d = byId[104].design_card
  assert.ok(d.layer_plan && d.gen_plan)
  assert.equal(d.gen_plan.last, undefined, '组合 D 的尾帧由衔接帧锁定，迁移留空')
  assert.equal(d.budget.layer_s, 4, '时长 2s 被抬到下限 4s')
})

test('没有 intent / 坏 JSON 的镜头置空白；drama 3 的存量镜不受影响', () => {
  const result = run(`
    ${PRE_MIGRATION}
    const { migrateIntentToDesignCard } = await import('./src/services/design-card-migration.ts')
    const migrated = await migrateIntentToDesignCard()
    const blank = db.all(sql.raw("SELECT id, combo, design_card, design_card_status FROM storyboards WHERE id IN (105,106,201,202) ORDER BY id"))
    const drama3 = db.all(sql.raw("SELECT count(*) AS n FROM storyboards WHERE episode_id = 5 AND deleted_at IS NULL AND design_card_status = 'blank' AND combo IS NULL"))[0]
    const drama3Cards = db.all(sql.raw('SELECT count(*) AS n FROM storyboards WHERE episode_id = 5 AND design_card IS NOT NULL'))[0]
    console.log('@@' + JSON.stringify({ migrated, blank, drama3: drama3.n, drama3Cards: drama3Cards.n }))
  `)
  for (const row of result.blank) {
    assert.equal(row.combo, null)
    assert.equal(row.design_card, null)
    assert.equal(row.design_card_status, 'blank')
  }
  assert.equal(result.drama3, 2, '存量集逐镜置空白、不选组合')
  assert.equal(result.drama3Cards, 0, '存量集一张设计卡都没有')
})

test('软删行一并转换但不计数；孤儿片段行原样保留（迁移按分镜行驱动）', () => {
  const result = run(`
    ${PRE_MIGRATION}
    const { migrateIntentToDesignCard } = await import('./src/services/design-card-migration.ts')
    const migrated = await migrateIntentToDesignCard()
    const soft = db.all(sql.raw('SELECT combo, design_card_status FROM storyboards WHERE id = 107'))[0]
    const clips = db.all(sql.raw('SELECT count(*) AS n, count(DISTINCT render_signature) AS sigs FROM storyboard_clips'))[0]
    console.log('@@' + JSON.stringify({ migrated, soft, clips }))
  `)
  assert.equal(result.migrated, 4, '只数存活行：101–104；软删的 107 与两个空白镜不计入')
  assert.equal(result.soft.combo, 'A', '软删行也转换，回收站恢复后设计卡还在')
  assert.equal(result.soft.design_card_status, 'pending')
  assert.equal(result.clips.n, 1, '孤儿片段行原样保留')
  assert.equal(result.clips.sigs, 1, '渲染签名没有被迁移改动')
})

test('幂等：第二次执行直接返回 -1，intent / intent_reviewed 两列已被删除', () => {
  const result = run(`
    ${PRE_MIGRATION}${COLUMNS}
    const { migrateIntentToDesignCard } = await import('./src/services/design-card-migration.ts')
    const before = columnsOf()
    const first = await migrateIntentToDesignCard()
    const afterFirst = columnsOf()
    const snapshot = db.all(sql.raw('SELECT id, combo, design_card, design_card_status FROM storyboards ORDER BY id'))
    const second = await migrateIntentToDesignCard()
    const afterSecond = db.all(sql.raw('SELECT id, combo, design_card, design_card_status FROM storyboards ORDER BY id'))
    console.log('@@' + JSON.stringify({
      hadIntent: before.includes('intent') && before.includes('intent_reviewed'),
      first, second,
      stillHasIntent: afterFirst.includes('intent') || afterFirst.includes('intent_reviewed'),
      hasNewColumns: ['combo','design_card','design_card_status','design_card_confirmed_at','design_card_stale_reason'].every(c => afterFirst.includes(c)),
      unchanged: JSON.stringify(snapshot) === JSON.stringify(afterSecond),
    }))
  `)
  assert.equal(result.hadIntent, true, '迁移前确实有旧列')
  assert.equal(result.first, 4)
  assert.equal(result.second, -1, '列没了就直接返回，不再打印统计')
  assert.equal(result.stillHasIntent, false, 'intent / intent_reviewed 已被 DROP COLUMN')
  assert.equal(result.hasNewColumns, true)
  assert.equal(result.unchanged, true, '第二次执行一行都不改')
})
