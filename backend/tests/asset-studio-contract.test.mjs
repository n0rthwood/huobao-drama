/**
 * 草稿输入契约（Issue #123，取代 #73 轮次推进契约）—— 纯函数，不读库不发网络
 *
 * 对应产品硬约束：
 * - 精确草稿：参考图 = 人选定素材 + 选中检索候选，按路径去重后 ≤3 张；总输入 ≥1（图/文本/notes），
 *   0 图合法（纯文本走 t2i）；跨资产/已排除/无文件/重复一律拒绝。
 * - 美化草稿：必须解析到该资产已有版本图或当前图，无图拒绝。
 * - 检索引用：记录必须存在且 completed，sha/下标必须在结果内。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

const script = `
  import { validateDraftInputs, MAX_PIPELINE_REFERENCES } from './src/modules/asset-studio/contract.ts'

  const capture = (fn) => {
    try { return { ok: true, value: fn() } }
    catch (err) { return { ok: false, name: err.constructor.name, message: err.message } }
  }

  const sources = [
    { id: 11, asset_kind: 'prop', asset_id: 1, role: 'generation_reference', local_path: 'static/asset-sources/one.png', sha256: 'sha1' },
    { id: 12, asset_kind: 'prop', asset_id: 1, role: 'shape_only', local_path: 'static/asset-sources/two.png', sha256: 'sha2' },
    { id: 13, asset_kind: 'prop', asset_id: 1, role: 'generation_reference', local_path: 'static/asset-sources/three.png', sha256: 'sha3' },
    { id: 14, asset_kind: 'prop', asset_id: 1, role: 'rejected', local_path: 'static/asset-sources/four.png', sha256: 'sha4' },
    { id: 15, asset_kind: 'prop', asset_id: 1, role: 'generation_reference', local_path: 'static/asset-sources/five.png', sha256: 'sha5' },
    { id: 16, asset_kind: 'prop', asset_id: 1, role: 'generation_reference', local_path: 'static/asset-sources/six.png', sha256: 'sha6' },
    { id: 17, asset_kind: 'prop', asset_id: 1, role: 'generation_reference', local_path: '', sha256: 'sha7' },
    { id: 18, asset_kind: 'prop', asset_id: 2, role: 'generation_reference', local_path: 'static/asset-sources/other.png', sha256: 'sha8' },
    { id: 19, asset_kind: 'prop', asset_id: 1, role: 'generation_reference', local_path: 'static/asset-sources/one.png', sha256: 'sha1' },
  ]
  const researchRecords = [
    { id: 101, status: 'completed', result: {
      candidates: [
        { sha256: 'csha1', local_path: 'static/asset-sources/candidates/c1.png', role: 'generation_reference', title: '候选一', url: 'https://example.org/1', license: 'CC BY-SA 4.0', adapter: 'commons', image: null, institution: '', date: '', snippet: '', tier: 'B', depicts: '', what_it_proves: [], cautions: [] },
        { sha256: 'csha2', local_path: 'static/asset-sources/one.png', role: 'original', title: '与素材一同图', url: null, license: '', adapter: 'commons', image: null, institution: '', date: '', snippet: '', tier: 'B', depicts: '', what_it_proves: [], cautions: [] },
      ],
      texts: [
        { adapter: 'wikipedia-en', title: 'Text A', url: null, excerpt: 'excerpt a' },
        { adapter: 'wikipedia-zh', title: 'Text B', url: null, excerpt: 'excerpt b' },
      ],
    } },
    { id: 102, status: 'running', result: null },
  ]
  const versions = [
    { id: 501, url: 'static/images/v1.png', is_current: true },
    { id: 502, url: 'static/images/v2.png', is_current: false },
    { id: null, url: 'static/images/legacy.png', is_current: true },
  ]
  const ctx = { kind: 'prop', assetId: 1, sources, researchRecords, versions, currentImageUrl: 'static/images/v1.png' }
  const precision = (over = {}) => ({ source_ids: [], research: [], notes: '', ...over })

  const cases = {
    ordered: capture(() => validateDraftInputs('precision', precision({ source_ids: [13, 11] }), ctx).sources.map(s => s.id)),
    three: capture(() => validateDraftInputs('precision', precision({ source_ids: [15, 11, 13] }), ctx).sources.map(s => s.id)),
    shapeOnlyAllowed: capture(() => validateDraftInputs('precision', precision({ source_ids: [12] }), ctx).sources.map(s => s.id)),
    zeroImagesWithText: capture(() => validateDraftInputs('precision', precision({ research: [{ research_id: 101, candidate_shas: [], text_indexes: [0] }] }), ctx).texts.length),
    zeroImagesWithNotes: capture(() => validateDraftInputs('precision', precision({ notes: '画一只猞猁' }), ctx).sources.length),
    allEmpty: capture(() => validateDraftInputs('precision', precision(), ctx)),
    fourImages: capture(() => validateDraftInputs('precision', precision({ source_ids: [11, 13, 15, 16] }), ctx)),
    threePlusCandidate: capture(() => validateDraftInputs('precision', precision({ source_ids: [11, 13, 15], research: [{ research_id: 101, candidate_shas: ['csha1'], text_indexes: [] }] }), ctx)),
    dedupSamePath: capture(() => validateDraftInputs('precision', precision({ source_ids: [11, 19], research: [{ research_id: 101, candidate_shas: ['csha2'], text_indexes: [] }] }), ctx).sources.length + validateDraftInputs('precision', precision({ source_ids: [11, 19], research: [{ research_id: 101, candidate_shas: ['csha2'], text_indexes: [] }] }), ctx).candidates.length),
    rejected: capture(() => validateDraftInputs('precision', precision({ source_ids: [14] }), ctx)),
    crossAsset: capture(() => validateDraftInputs('precision', precision({ source_ids: [18] }), ctx)),
    missingSource: capture(() => validateDraftInputs('precision', precision({ source_ids: [999] }), ctx)),
    duplicated: capture(() => validateDraftInputs('precision', precision({ source_ids: [11, 11] }), ctx)),
    noFile: capture(() => validateDraftInputs('precision', precision({ source_ids: [17] }), ctx)),
    researchMissing: capture(() => validateDraftInputs('precision', precision({ research: [{ research_id: 999, candidate_shas: [], text_indexes: [] }] }), ctx)),
    researchRunning: capture(() => validateDraftInputs('precision', precision({ research: [{ research_id: 102, candidate_shas: [], text_indexes: [] }] }), ctx)),
    researchBadSha: capture(() => validateDraftInputs('precision', precision({ research: [{ research_id: 101, candidate_shas: ['nope'], text_indexes: [] }] }), ctx)),
    researchBadIndex: capture(() => validateDraftInputs('precision', precision({ research: [{ research_id: 101, candidate_shas: [], text_indexes: [9] }] }), ctx)),
    candidateOrder: capture(() => validateDraftInputs('precision', precision({ source_ids: [13], research: [{ research_id: 101, candidate_shas: ['csha1'], text_indexes: [1] }] }), ctx).candidates.map(c => c.sha256)),
    beautifyVersion: capture(() => validateDraftInputs('beautify', { version_task_id: 502, notes: '' }, ctx).beautify),
    beautifyCurrent: capture(() => validateDraftInputs('beautify', { version_task_id: null, notes: '' }, ctx).beautify),
    beautifyLegacy: capture(() => validateDraftInputs('beautify', { version_task_id: null, notes: '' }, { ...ctx, versions: [{ id: null, url: 'static/images/legacy.png', is_current: true }], currentImageUrl: 'static/images/legacy.png' }).beautify),
    beautifyNoImage: capture(() => validateDraftInputs('beautify', { version_task_id: null, notes: '' }, { ...ctx, versions: [], currentImageUrl: null })),
    beautifyForeignVersion: capture(() => validateDraftInputs('beautify', { version_task_id: 999, notes: '' }, ctx)),
  }
  process.stdout.write(JSON.stringify({ cases, max: MAX_PIPELINE_REFERENCES }))
`

const { cases, max } = JSON.parse(
  execFileSync('npx', ['tsx', '--eval', script], { cwd: backendRoot, encoding: 'utf8' }),
)

test('精确草稿参考图按人选顺序取，最多 3 张（含检索候选，按路径去重）', () => {
  assert.equal(max, 3)
  assert.deepEqual(cases.ordered, { ok: true, value: [13, 11] })
  assert.deepEqual(cases.three, { ok: true, value: [15, 11, 13] })
  assert.deepEqual(cases.shapeOnlyAllowed, { ok: true, value: [12] })
  assert.deepEqual(cases.candidateOrder, { ok: true, value: ['csha1'] })
  // 同路径素材+候选去重：11 与 19 同图、csha2 同图 → 只算 1 张
  assert.deepEqual(cases.dedupSamePath, { ok: true, value: 2 })
})

test('0 图 + 有文本/notes 合法；全空 / 4 图 / 3 图+候选 → 拒绝', () => {
  assert.deepEqual(cases.zeroImagesWithText, { ok: true, value: 1 })
  assert.deepEqual(cases.zeroImagesWithNotes, { ok: true, value: 0 })
  assert.equal(cases.allEmpty.ok, false)
  assert.equal(cases.allEmpty.name, 'DraftInputError')
  assert.equal(cases.fourImages.ok, false)
  assert.equal(cases.fourImages.name, 'ReferenceSelectionError')
  assert.equal(cases.threePlusCandidate.ok, false)
  assert.equal(cases.threePlusCandidate.name, 'ReferenceSelectionError')
})

test('跨资产 / 已排除 / 不存在 / 重复 / 无文件 → ReferenceSelectionError', () => {
  for (const key of ['rejected', 'crossAsset', 'missingSource', 'duplicated', 'noFile']) {
    assert.equal(cases[key].ok, false, key)
    assert.equal(cases[key].name, 'ReferenceSelectionError', key)
  }
})

test('检索记录必须存在且 completed，sha/下标必须在结果内', () => {
  for (const key of ['researchMissing', 'researchRunning', 'researchBadSha', 'researchBadIndex']) {
    assert.equal(cases[key].ok, false, key)
    assert.equal(cases[key].name, 'DraftInputError', key)
  }
})

test('美化：版本解析 / 当前图回退 / legacy 当前图 / 无图拒绝 / 跨资产版本拒绝', () => {
  assert.deepEqual(cases.beautifyVersion, { ok: true, value: { version_task_id: 502, path: 'static/images/v2.png' } })
  assert.deepEqual(cases.beautifyCurrent, { ok: true, value: { version_task_id: 501, path: 'static/images/v1.png' } })
  assert.deepEqual(cases.beautifyLegacy, { ok: true, value: { version_task_id: null, path: 'static/images/legacy.png' } })
  assert.equal(cases.beautifyNoImage.ok, false)
  assert.equal(cases.beautifyNoImage.name, 'DraftInputError')
  assert.match(cases.beautifyNoImage.message, /美化需要已有资产图/)
  assert.equal(cases.beautifyForeignVersion.ok, false)
  assert.equal(cases.beautifyForeignVersion.name, 'DraftInputError')
})