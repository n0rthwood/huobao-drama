/**
 * 地图资产工作流的纯函数行为（Issue #84）：
 * 类别判定、需求校验与路径围栏、检索结果并入几何时「人工确认过的坐标不被覆盖」、
 * 「非示意图模式不虚构历史疆域」、坏 JSON 的容错读取。
 *
 * 纯函数在 TS 里，用仓库自带的 tsx 子进程跑一次并以 JSON 回传（不碰数据库、不发网络请求）。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
// 被测模块经 db/index.ts 建连接：数据目录与库文件一律指到临时目录，绝不碰仓库 data/
const dataDir = mkdtempSync(path.join(tmpdir(), 'map-studio-state-'))
after(() => rmSync(dataDir, { recursive: true, force: true }))

const script = `
  import { normalizeBrief, emptyBrief } from 'file://${backendRoot}src/modules/map-studio/types.ts'
  import { parseWorkflow, restoreSnapshot } from 'file://${backendRoot}src/modules/map-studio/store.ts'
  import { adoptResearchIntoSpec } from 'file://${backendRoot}src/modules/map-studio/run.ts'
  import { judgeBrief, parseBriefVerdict } from 'file://${backendRoot}src/modules/map-studio/brief.ts'

  import { parseAssetType } from 'file://${backendRoot}src/services/prop-asset-type.ts'
  const input = JSON.parse(process.env.MAP_WF_INPUT)
  const tryCall = (fn) => {
    try { return { ok: true, value: fn() } } catch (err) {
      return { ok: false, name: err?.name ?? '', code: err?.code ?? '', message: String(err?.message ?? '') }
    }
  }

  const adopted = tryCall(() => adoptResearchIntoSpec(input.spec, input.research, input.brief))

  // 回退：历史里有两次进入 base（旧的一次 + 重跑的一次），
  // 且当前几何里有一条人工确认过的地点，回退不能把它抹掉
  const rollbackCtx = {
    task: {},
    brief: input.brief,
    state: JSON.parse(JSON.stringify(input.rollbackState)),
    mapSpec: JSON.parse(JSON.stringify(input.rollbackSpec)),

  }
  const rollbackNote = restoreSnapshot(rollbackCtx, 'base')

  // 充分性判定（纯函数，不调模型）：模糊值 / 不成形结论 / 调用失败 / 唯一隐含推断
  const codes = (result) => result.issues.filter(issue => issue.blocking).map(issue => issue.code)
  const judged = {
    ambiguousEra: codes(judgeBrief(input.ambiguousBrief, parseBriefVerdict(input.ambiguousVerdict))),
    malformed: codes(judgeBrief(input.filledBrief, parseBriefVerdict(input.malformedVerdict))),
    emptyObject: codes(judgeBrief(input.filledBrief, parseBriefVerdict({}))),
    modelFailed: codes(judgeBrief(input.filledBrief, null, '连接超时')),
    clean: codes(judgeBrief(input.filledBrief, parseBriefVerdict({ inferred: [], ambiguous: [], missing: [], notes: [] }))),
  }
  const inferredRun = judgeBrief(input.implicitBrief, parseBriefVerdict(input.implicitVerdict))
  const lowRun = judgeBrief(input.implicitBrief, parseBriefVerdict(input.lowConfidenceVerdict))

  process.stdout.write('MAP_WORKFLOW_RESULT=' + JSON.stringify({
    assetType: input.assetTypes.map(([raw, fallback]) => parseAssetType(raw, fallback)),
    briefOk: tryCall(() => normalizeBrief(input.briefPatch, emptyBrief())),
    briefBadMode: tryCall(() => normalizeBrief({ base_mode: 'satellite' }, emptyBrief())),
    briefImageWithoutRef: tryCall(() => normalizeBrief({ base_mode: 'image' }, emptyBrief())),
    briefBadPath: tryCall(() => normalizeBrief({
      base_mode: 'image',
      reference_image: {
        path: '../../etc/passwd', source_url: 'https://example.org/a', license: 'CC0',
        control_points: [
          { x: 0, y: 0, lon: 0, lat: 0 },
          { x: 10, y: 0, lon: 1, lat: 0 },
          { x: 0, y: 10, lon: 0, lat: 1 },
        ],
      },
    }, emptyBrief())),
    adopted: adopted.ok
      ? { places: adopted.value.spec.places, regions: adopted.value.spec.regions, notes: adopted.value.notes, bbox: adopted.value.spec.bbox }
      : adopted,
    brokenJson: parseWorkflow('{not json'),
    rollback: {
      note: rollbackNote,
      places: rollbackCtx.mapSpec?.places ?? [],
      research: rollbackCtx.state.research,
      outputs: rollbackCtx.state.outputs,
    },
    judged,
    inferredRun: { era: inferredRun.brief.era, inferred: inferredRun.brief.inferred, blocking: inferredRun.issues.filter(i => i.blocking).map(i => i.code) },
    lowRun: { era: lowRun.brief.era, blocking: lowRun.issues.filter(i => i.blocking).map(i => i.code) },
  }))
`

const feature = (over) => ({
  id: 'F', kind: 'place', name: '', lon: null, lat: null, points: [],
  coordinate_basis: 'well_known', basis: '', supporting_excerpt: '', excerpt_verified: false,
  source_ids: ['S1'], source_url: null, source_title: '', uncertainty: 'high', approximate: true, conflicts: [],
  ...over,
})

const input = {
  assetTypes: [['map', 'prop'], ['prop', 'prop'], [undefined, 'map'], ['', 'prop'], ['chart', 'prop']],
  briefPatch: { subject: '邗沟', era: '春秋', location: '江淮之间', purpose: '路线示意', schematic: true, style: 'ink' },
  // ── 充分性判定夹具（全部不调模型，verdict 直接喂进纯函数）──
  // 四个字段都非空，但「古代 / 中国 / 地图」谁都画不出来
  ambiguousBrief: {
    subject: '京杭运河通州段', era: '古代', location: '中国', purpose: '地图',
    detail_level: 'regional', schematic: false, base_mode: 'program', style: 'archival',
    notes: '', reference_image: null, inferred: [],
  },
  ambiguousVerdict: {
    inferred: [],
    ambiguous: [
      { field: 'era', reason: '「古代」跨越元明清，河道多次改道', hint: '请指明元代 / 明代 / 清末' },
      { field: 'location', reason: '「中国」比该河段实际范围大几个数量级', hint: '请缩到通州一带' },
      { field: 'purpose', reason: '「地图」没有说明详略取舍', hint: '例：河道走向示意图' },
    ],
    missing: [],
    notes: [],
  },
  // 四个字段都非空且明确：只有在模型给出成形结论时才放行
  filledBrief: {
    subject: '邗沟', era: '春秋末期', location: '江淮之间（今扬州—淮安）', purpose: '河道走向示意图',
    detail_level: 'regional', schematic: true, base_mode: 'program', style: 'ink',
    notes: '', reference_image: null, inferred: [],
  },
  // 半截 / 不成形回复：不能被当成「四个维度都通过」
  malformedVerdict: { notes: ['随便说点什么'] },
  // 时代留空，但对象唯一指向商代晚期
  implicitBrief: {
    subject: '殷墟车马坑', era: '', location: '河南安阳小屯', purpose: '遗址位置图',
    detail_level: 'site', schematic: false, base_mode: 'program', style: 'archival',
    notes: '', reference_image: null, inferred: [],
  },
  implicitVerdict: {
    inferred: [{ field: 'era', value: '商代晚期（约前13—前11世纪）', basis: '殷墟是商代晚期都城遗址', confidence: 'high' }],
    ambiguous: [], missing: [], notes: [],
  },
  lowConfidenceVerdict: {
    inferred: [{ field: 'era', value: '商代', basis: '大致猜测', confidence: 'low' }],
    ambiguous: [], missing: [], notes: [],
  },
  brief: {
    subject: '殷墟', era: '商代晚期', location: '河南安阳', purpose: '遗址位置图',
    detail_level: 'site', schematic: false, base_mode: 'program', style: 'archival',
    notes: '', reference_image: null, inferred: [],
  },
  // 已有几何：安阳是人工确认过的（没有 proposed 标记）
  spec: {
    version: 1,
    projection: { type: 'mercator' },
    bbox: [113, 35.2, 115.6, 36.8],
    layers: { land: true, coastline: true, rivers: true, lakes: true, countries: true },
    places: [{ id: 'p_manual', name: '安阳', lon: 114.3931, lat: 36.0975 }],
    routes: [],
    regions: [],
    style: { theme: 'archival' },
  },
  research: {
    queries: [],
    sources: [],
    features: [
      // 人工已确认过的安阳：检索给出的新坐标不得覆盖它
      feature({ id: 'F1', name: '安阳', lon: 114.9, lat: 36.4 }),
      // 新地点：以候选（proposed）身份并入
      feature({ id: 'F2', name: '殷墟', lon: 114.3148, lat: 36.1256, coordinate_basis: 'excerpt', excerpt_verified: true, uncertainty: 'low', approximate: false }),
      // 非示意图模式下的面：不虚构历史边界
      feature({ id: 'F3', kind: 'region', name: '商王畿', points: [[113.5, 35.5], [115.2, 35.5], [115.2, 36.6]], coordinate_basis: 'approximate_schematic' }),
    ],
    uncertainties: [],
    notes: [],
    searched_at: '2026-11-08T00:00:00.000Z',
  },
  // 回退夹具：两次进入 base 的历史快照（旧的检索结果 + 重跑后的检索结果）
  rollbackState: {
    ...{
      version: 1, stage: 'drawing', status: 'awaiting_review', mode: 'manual', revision: 9,
      run_id: null, error: null, brief: null, brief_hash: null, steps: [], issues: [],
      research: { queries: [], sources: [], features: [], uncertainties: [], notes: ['第二轮检索'], searched_at: '2026-11-08T02:00:00.000Z' },
      outputs: { base_image: { path: 'static/map-bases/new.png', width: 10, height: 10, source: 'map-base:program', run_id: 120, provenance: null }, texture_image: null, final_image: null, kmz: null, layer_doc: null },
      text_config_id: null, image_config_id: null, image_model: null, updated_at: '2026-11-08T02:30:00.000Z',
    },
    history: [
      // 第一轮：进入 base 之前的快照（旧检索）
      {
        revision: 3, at: '2026-11-08T00:10:00.000Z', stage: 'style', status: 'running', action: 'stage_done:base', actor: 'auto', note: null,
        snapshot: {
          stage: 'base',
          brief: null,
          map_spec: { version: 1, projection: { type: 'mercator' }, bbox: [113, 35.2, 115.6, 36.8], layers: { land: true, coastline: true, rivers: true, lakes: true, countries: true }, places: [{ id: 'p_old', name: '旧候选', lon: 114, lat: 36, proposed: true }], routes: [], regions: [], style: { theme: 'archival' } },
          outputs: { base_image: null, texture_image: null, final_image: null, kmz: null, layer_doc: null },
          research: { queries: [], sources: [], features: [], uncertainties: [], notes: ['第一轮检索'], searched_at: '2026-11-08T00:00:00.000Z' },
        },
      },
      // 中间人工确认（stage 回到 research 之前的那一步不参与本次回退）
      { revision: 5, at: '2026-11-08T01:00:00.000Z', stage: 'research', status: 'idle', action: 'edit_map_spec', actor: 'manual', note: null },
      // 第二轮重跑：这才是「最近一次进入 base 之前」的快照
      {
        revision: 7, at: '2026-11-08T01:30:00.000Z', stage: 'style', status: 'running', action: 'stage_done:base', actor: 'auto', note: null,
        snapshot: {
          stage: 'base',
          brief: null,
          map_spec: { version: 1, projection: { type: 'mercator' }, bbox: [113, 35.2, 115.6, 36.8], layers: { land: true, coastline: true, rivers: true, lakes: true, countries: true }, places: [{ id: 'p_second', name: '第二轮候选', lon: 114.5, lat: 36.2, proposed: true }], routes: [], regions: [], style: { theme: 'archival' } },
          outputs: { base_image: null, texture_image: null, final_image: null, kmz: null, layer_doc: null },
          research: { queries: [], sources: [], features: [], uncertainties: [], notes: ['第二轮检索'], searched_at: '2026-11-08T01:20:00.000Z' },
        },
      },
    ],
  },
  // 当前几何：含一条人工确认过的地点（没有 proposed 标记）
  rollbackSpec: {
    version: 1, projection: { type: 'mercator' }, bbox: [113, 35.2, 115.6, 36.8],
    layers: { land: true, coastline: true, rivers: true, lakes: true, countries: true },
    places: [
      { id: 'p_confirmed', name: '人工确认点', lon: 114.39, lat: 36.09 },
      { id: 'p_second', name: '第二轮候选', lon: 114.5, lat: 36.2, proposed: true },
    ],
    routes: [], regions: [], style: { theme: 'archival' },
  },
}

// 必须以 .mts 文件（ESM）执行：被测模块链路里的 db/index.ts 带顶层 await，
// `tsx -e` 走 CJS 会直接 transform 失败
const probe = path.join(dataDir, 'probe.mts')
writeFileSync(probe, script)
const probeOutput = execFileSync('node_modules/.bin/tsx', [probe], {
  cwd: backendRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    MAP_WF_INPUT: JSON.stringify(input),
    HUOBAO_DATA_DIR: dataDir,
    STORAGE_PATH: path.join(dataDir, 'static'),
    SQLITE_PATH: path.join(dataDir, 'test.sqlite3'),
  },
})
const out = JSON.parse(probeOutput.slice(probeOutput.lastIndexOf('MAP_WORKFLOW_RESULT=') + 'MAP_WORKFLOW_RESULT='.length))

test('asset_type 必须显式，非法值不静默回落', () => {
  assert.deepEqual(out.assetType, ['map', 'prop', 'map', 'prop', null])
})

test('需求合并校验：合法值写入，非法枚举/缺外部底图/越权路径一律拒绝', () => {
  assert.equal(out.briefOk.ok, true)
  assert.equal(out.briefOk.value.subject, '邗沟')
  assert.equal(out.briefOk.value.style, 'ink')
  assert.equal(out.briefOk.value.schematic, true)
  assert.equal(out.briefBadMode.ok, false)
  assert.match(out.briefBadMode.message, /base_mode/)
  assert.equal(out.briefImageWithoutRef.ok, false)
  assert.equal(out.briefImageWithoutRef.code, 'missing_reference_image')
  assert.equal(out.briefBadPath.ok, false)
  assert.equal(out.briefBadPath.code, 'bad_reference_path')
})

test('检索结果并入几何：人工坐标不被覆盖，新地点是候选，非示意图模式不画历史边界', () => {
  const anyang = out.adopted.places.find(place => place.name === '安阳')
  assert.equal(anyang.lon, 114.3931, '人工确认过的坐标必须原样保留')
  assert.notEqual(anyang.proposed, true)
  assert.ok(out.adopted.notes.some(note => note.includes('安阳')), '与人工值的分歧必须可见')
  const yinxu = out.adopted.places.find(place => place.name === '殷墟')
  assert.equal(yinxu.proposed, true, '检索得到的新地点只能是候选')
  assert.equal(out.adopted.regions.length, 0, '非示意图模式下不采纳面状历史边界')
  assert.equal(out.adopted.places.some(place => place.name === '商王畿'), false, '历史疆域不得被悄悄降级成地点')
  assert.ok(out.adopted.notes.some(note => note.includes('商王畿')), '未采纳的历史边界必须留下可见说明')
  assert.deepEqual(out.adopted.bbox, [113, 35.2, 115.6, 36.8], '已有 bbox 不被检索结果改写')
})

test('坏 JSON 的工作流读取不炸，回到初始状态', () => {
  assert.equal(out.brokenJson.stage, 'brief')
  assert.equal(out.brokenJson.status, 'idle')
  assert.equal(out.brokenJson.steps.length, 6)
})


test('回退取「最近一次」快照，并保留人工确认过的几何', () => {
  assert.deepEqual(out.rollback.research.notes, ['第二轮检索'])
  const names = out.rollback.places.map(place => place.name)
  assert.ok(names.includes('人工确认点'), '人工确认过的地点不能被回退抹掉')
  assert.ok(names.includes('第二轮候选'), '快照里的候选照常恢复')
  assert.equal(names.includes('旧候选'), false, '不能把更早一轮的候选翻回来')
  assert.equal(out.rollback.outputs.base_image, null, '回退要清掉该阶段之后的产出')
})

test('充分性判的是语义，不是字段非空', () => {
  // 四个字段都填了，但值本身不唯一 → 照样阻塞，逐字段给出 ambiguous_* 原因
  assert.deepEqual(out.judged.ambiguousEra.sort(), ['ambiguous_era', 'ambiguous_location', 'ambiguous_purpose'])
  // 结论不成形 / 半截 / 空对象 / 模型调用失败：一律阻塞，绝不因为字段都非空就放行
  assert.deepEqual(out.judged.malformed, ['sufficiency_check_failed'])
  assert.deepEqual(out.judged.emptyObject, ['sufficiency_check_failed'])
  assert.deepEqual(out.judged.modelFailed, ['sufficiency_check_failed'])
  // 成形结论 + 四项都明确 → 放行
  assert.deepEqual(out.judged.clean, [])
})

test('唯一隐含的时代可由 AI 补全并留痕；低置信度推断不算补上', () => {
  assert.equal(out.inferredRun.era, '商代晚期（约前13—前11世纪）')
  assert.equal(out.inferredRun.inferred.length, 1)
  assert.deepEqual(out.inferredRun.blocking, [])
  assert.equal(out.lowRun.era, '', '低置信度猜测不得写进需求')
  assert.deepEqual(out.lowRun.blocking, ['missing_era'])
})
