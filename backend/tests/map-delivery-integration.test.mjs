/**
 * 地图交付的集成行为测试（Issue #125）——真实 deliver 路径，不是纯函数替身。
 *
 * 场景（临时 SQLite + 临时数据目录，绝不触生产）：
 * 1. 第一次交付：全览 + 2 细节登记（细节 1/2 取景互不重叠）；
 * 2. 第二次交付：同全览、细节 1 取景整体换成另一区域（与旧的 IoU=0）→ 旧行标 stale、新建一颗资产；
 *    细节 2 取景不变（IoU=1）→ 复用该行；两行的语义要素 id 集合都变了；
 * 3. 断言：复用行 `map_pip.content_changed_at` 记录、全览同样记录、引用该资产的设计卡被
 *    `markStale('design_card','asset_content_changed')`、已落段 stale_reasons 含 `asset_version_changed`、
 *    组规划读时不再是 fresh；交付写入的 description/frame.reason 里没有镜号快照。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function runDeliveryScenario() {
  const script = `
    import fs from 'node:fs'
    import path from 'node:path'
    import { sqlite } from './src/db/index.ts'
    import { huobaoMapStudioHost } from './src/services/map-studio-host.ts'
    import { freshGroupPlan, saveGroupPlan } from './src/services/design-group-plan.ts'
    import { stripShotSnapshot } from './src/services/map-pip-assets.ts'
    const out = (value) => console.log('@@' + JSON.stringify(value))
    const dataRoot = process.env.HUOBAO_DATA_DIR
    const T0 = '2026-01-01T00:00:00.000Z'
    fs.mkdirSync(path.join(dataRoot, 'static/maps'), { recursive: true })
    const file = (name, text) => {
      const rel = 'static/maps/' + name
      fs.writeFileSync(path.join(dataRoot, rel), text)
      return rel
    }

    sqlite.prepare("INSERT INTO dramas (id,title,project_type,aspect_ratio,created_at,updated_at) VALUES (20,'测试项目','drama','16:9',?,?)").run(T0, T0)
    sqlite.prepare("INSERT INTO episodes (id,drama_id,episode_number,title,content,script_content,created_at,updated_at) VALUES (1,20,1,'E1','旁白。','旁白。',?,?)").run(T0, T0)
    sqlite.prepare("INSERT INTO props (id,drama_id,name,type,description,faithful,asset_type,created_at,updated_at) VALUES (259,20,'全览','地图','对象：测试地图。',1,'map',?,?)").run(T0, T0)
    sqlite.prepare("INSERT INTO episode_props (episode_id,prop_id,created_at) VALUES (1,259,?)").run(T0)
    const card = JSON.stringify({
      version: 2, info_points: [], budget: { layer_s: 5, gen_s: null },
      layer_plan: { base: { kind: 'asset', asset_kind: 'prop', asset_id: 259, version_task_id: null }, must_mark: [], planned_layers: [] },
      rationale: '', suggested_combo: 'A',
    })
    const insertShot = sqlite.prepare("INSERT INTO storyboards (id,episode_id,storyboard_number,combo,design_card,design_card_status,narration_text,created_at,updated_at) VALUES (?,1,?,'A',?,'confirmed','旁白。',?,?)")
    insertShot.run(67, 1, card, T0, T0)
    insertShot.run(71, 2, '', T0, T0)
    sqlite.prepare("INSERT INTO storyboard_layer_segments (storyboard_id,layer_doc,timeline,duration,base_ref,status,stale_reasons,created_at,updated_at) VALUES (71,?,?,8,?,'draft','[]',?,?)").run(
      JSON.stringify({ base: { path: file('seg-base.png', 'seg-base'), width: 100, height: 100 }, layers: [] }),
      JSON.stringify({ fps: 25, ease: 'inout', fade_ms: 400, keyframes: [] }),
      JSON.stringify({ kind: 'asset', asset_kind: 'prop', asset_id: 259, version_task_id: null }),
      T0, T0,
    )
    const group = {
      group_no: 1, paragraph_text: '旁白。', paragraph_chars: 3, warnings: [], signature: 'sig-test',
      shots: [{ storyboard_id: 67, storyboard_number: 1, narration: '旁白。', measured_s: 5 }],
    }
    saveGroupPlan(1, 1, {
      signature: 'sig-test', status: 'ok', error: null, taskId: null,
      plan: {
        task: '测试规划', geo_additions: [],
        asset_roles: [{ asset_kind: 'prop', asset_id: 259, name: '全览', role: 'background', establish_storyboard_id: 1, exit_after_storyboard_id: null, note: '' }],
        shots: [{ storyboard_id: 67, combo: 'A', base: { asset_kind: 'prop', asset_id: 259 }, pip: [], mode: 'new_items', task: 'x' }],
        junction: '',
      },
    })
    sqlite.prepare('UPDATE design_group_plans SET updated_at = ? WHERE episode_id = 1 AND group_no = 1').run(T0)
    const freshBefore = freshGroupPlan(1, group) !== null

    const layout = { id: 'L1', family: 'A', canvas: { width: 100, height: 100 }, slots: [], locator: null, label_tier: 'full', min_slot_short_side: 10 }
    const deliverable = (taskId, tag, frames, semantics) => ({
      task_id: taskId,
      final_image: { path: file('final-' + tag + '.png', 'final-' + tag), width: 100, height: 100, sha256: '' },
      base_image: { path: file('base-' + tag + '.png', 'base-' + tag), width: 100, height: 100, mode: 'program', provenance: null },
      texture_image: null,
      semantics: { width: 100, height: 100, points: semantics.overview, lines: [], regions: [], labels: [] },
      features: [], sources: [], kmz: null,
      editable_source: { version: 1, map_spec: {} }, manual_edit: false, summary: 'run ' + tag,
      pip: {
        version: 1, overview_bbox: [0, 0, 40, 40], aspect: '16:9', layout, frames, composite: null, usage: '用法文本。',
        details: frames.map(frame => ({
          no: frame.no, path: file('detail-' + tag + '-' + frame.no + '.png', 'd' + tag + frame.no), width: 100, height: 100, sha256: 'sha-' + tag + '-' + frame.no,
          semantics: { width: 100, height: 100, points: semantics.details[frame.no], lines: [], regions: [] },
        })),
      },
    })
    const point = (id, name, x, y) => ({ id, name, at: [x, y] })

    // 第一次交付：细节 1/2 取景互不重叠；细节 1 的 reason 带镜号句（写入时必须清洗）
    const first = deliverable(1, 'one', [
      { no: 1, label: '细节A', reason: '分镜 #59/#60 反复强调河口。需看清汇流处。', role: 'primary', focus_bbox: [2, 2, 12, 12], bbox: [2, 2, 12, 12] },
      { no: 2, label: '细节B', reason: '需看清山地走向。', role: 'aux', focus_bbox: [15, 15, 25, 25], bbox: [15, 15, 25, 25] },
    ], { overview: [point('f1', '河口', 5, 5), point('f2', '山地', 20, 20)], details: { 1: [point('f1', '河口', 5, 5)], 2: [point('f2', '山地', 20, 20)] } })
    const r1 = await huobaoMapStudioHost.deliver('prop:259', first)

    // 第二次交付：细节 1 换到另一区域（旧 bbox IoU=0）、细节 2 取景不变；两边语义要素 id 集合都变了
    const second = deliverable(2, 'two', [
      { no: 1, label: '细节A2', reason: '新的地理：山口。', role: 'primary', focus_bbox: [30, 30, 39, 39], bbox: [30, 30, 39, 39] },
      { no: 2, label: '细节B', reason: '需看清山地走向。', role: 'aux', focus_bbox: [15, 15, 25, 25], bbox: [15, 15, 25, 25] },
    ], { overview: [point('f3', '山口', 35, 35), point('f2', '山地', 20, 20)], details: { 1: [point('f3', '山口', 35, 35)], 2: [point('f2', '山地', 20, 20), point('f4', '河谷', 22, 22)] } })
    const r2 = await huobaoMapStudioHost.deliver('prop:259', second)

    const details = sqlite.prepare("SELECT id, name, description, map_pip, semantics FROM props WHERE drama_id = 20 AND map_pip LIKE '%\\"role\\":\\"detail\\"%' ORDER BY id").all()
    const overviewRow = sqlite.prepare('SELECT description, map_pip FROM props WHERE id = 259').get()
    const overviewMeta = JSON.parse(overviewRow.map_pip)
    const shot67 = sqlite.prepare('SELECT design_card_status, design_card_stale_reason FROM storyboards WHERE id = 67').get()
    const seg71 = sqlite.prepare('SELECT stale_reasons FROM storyboard_layer_segments WHERE storyboard_id = 71').get()
    const freshAfter = freshGroupPlan(1, group) !== null
    out({
      messages: [r1.message, r2.message],
      detailCount: details.length,
      details: details.map(row => {
        const meta = JSON.parse(row.map_pip)
        return {
          id: row.id,
          no: meta.frame?.no,
          stale: meta.stale === true,
          contentChangedAt: meta.content_changed_at ?? null,
          reason: meta.frame?.reason ?? '',
          description: row.description ?? '',
          semanticsIds: (JSON.parse(row.semantics ?? '{}').points ?? []).map(item => item.id),
        }
      }),
      overviewContentChangedAt: overviewMeta.content_changed_at ?? null,
      overviewDescription: overviewRow.description ?? '',
      shot67,
      seg71: JSON.parse(seg71.stale_reasons ?? '[]'),
      freshBefore,
      freshAfter,
      stripIsClean: stripShotSnapshot('分镜 #59 反复强调河口。需看清汇流处。'),
    })
  `
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'map-deliver-'))
  try {
    const text = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot,
      encoding: 'utf8',
      env: { ...process.env, SQLITE_PATH: path.join(dataRoot, 'test.sqlite3'), HUOBAO_DATA_DIR: dataRoot, STORAGE_PATH: '' },
    })
    return JSON.parse(text.slice(text.lastIndexOf('@@') + 2))
  } finally {
    rmSync(dataRoot, { recursive: true, force: true })
  }
}

test('deliver 集成：取景更换 → 旧行 stale、复用行记内容变更、设计卡/段/组规划读时过期', () => {
  const result = runDeliveryScenario()
  assert.equal(result.detailCount, 3, '细节 1 新建一颗 + 细节 2 复用 + 旧细节 1 保留')
  const byNo = result.details
  // 旧的细节 1（bbox 2..12）没有被复用：标 stale，不删除
  const staleRow = byNo.find(row => row.stale === true)
  assert.ok(staleRow, '旧细节行必须标 stale')
  assert.deepEqual(staleRow.semanticsIds, ['f1'])
  // 复用的细节 2（bbox 15..25，IoU=1）记录内容变更时间与新的语义 id 集合
  const reused = byNo.find(row => row.stale !== true && row.semanticsIds.includes('f4'))
  assert.ok(reused, '细节 2 应被复用（取景相同）')
  assert.ok(reused.contentChangedAt, '复用行语义 id 集合变化必须记 content_changed_at')
  assert.deepEqual(reused.semanticsIds, ['f2', 'f4'])
  // 新建的细节 1（bbox 30..39）
  const created = byNo.find(row => row.stale !== true && row.semanticsIds.includes('f3'))
  assert.ok(created, '细节 1 换到另一区域应新建资产')
  assert.equal(created.contentChangedAt, null, '新建资产没有旧内容可比，不记变更')
  // 全览语义 id 集合变化（f1,f2 → f2,f3）
  assert.ok(result.overviewContentChangedAt, '全览内容变更应记 content_changed_at')
  // 引用失效传播
  assert.equal(result.shot67.design_card_status, 'stale')
  assert.equal(result.shot67.design_card_stale_reason, 'asset_content_changed')
  assert.ok(result.seg71.includes('asset_version_changed'), '已落段应标 asset_version_changed')
  // 组规划读时过期
  assert.equal(result.freshBefore, true, '交付前规划是新鲜的')
  assert.equal(result.freshAfter, false, '资产内容变更后规划读时不再新鲜')
})

test('deliver 写入的 description/frame.reason 不含镜号快照，地理句保留', () => {
  const result = runDeliveryScenario()
  for (const row of result.details) {
    assert.doesNotMatch(row.description, /分镜\s*#/, 'description 不得含镜号')
    assert.doesNotMatch(row.reason, /分镜\s*#/, 'frame.reason 不得含镜号')
  }
  const detailB = result.details.find(row => row.semanticsIds.includes('f2') && row.reason)
  assert.match(detailB.reason, /山地走向/, '地理描述必须保留')
  assert.match(detailB.description, /山地走向/, 'description 里的地理句必须保留')
  assert.doesNotMatch(detailB.description, /；；/, 'description 不得留下连续标点残渣')
  assert.equal(result.stripIsClean, '河口。看清汇流处。')
})
