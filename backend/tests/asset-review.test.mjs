/**
 * 资产审核清单（Issue #55）：
 * - 纯函数：分段、信息点归一、指纹稳定性（段号漂移不换身份）、状态机、五态重算、门禁文案；
 * - 落库：处置保留（含中间插段）、忽略必填理由、绑定硬退化、剧情项目短路。
 * 纯函数在 TS 里，用仓库自带的 tsx 子进程跑；落库用一次性 SQLITE_PATH 临时库。
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
  const dir = mkdtempSync(path.join(tmpdir(), 'asset-review-'))
  try {
    const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot,
      encoding: 'utf8',
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3') },
    })
    return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const PURE = `import {
  splitNarrationSegments, infoPointKey, fingerprintOf, canTransitionStatus,
  computeReviewStatus, assetReviewGateReason, assetKindForNeed,
} from './src/services/asset-review.ts'`

test('分段：空行 / ## 标题切段；整块长文自动按句聚合', () => {
  const result = run(`
    ${PURE}
    const blocks = splitNarrationSegments('第一段。\\n还是第一段。\\n\\n第二段。\\n\\n## 小节\\n第三段。')
    const long = splitNarrationSegments('句子。'.repeat(120))
    const empty = splitNarrationSegments('   ')
    console.log('@@' + JSON.stringify({
      count: blocks.texts.length, auto: blocks.auto, first: blocks.texts[0], third: blocks.texts[2],
      longCount: long.texts.length, longAuto: long.auto, longMax: Math.max(...long.texts.map(t => t.length)),
      emptyCount: empty.texts.length,
    }))
  `)
  assert.equal(result.count, 3)
  assert.equal(result.auto, false)
  assert.equal(result.first, '第一段。\n还是第一段。')
  assert.ok(result.third.includes('第三段。'))
  assert.ok(result.longCount > 1)
  assert.equal(result.longAuto, true)
  assert.ok(result.longMax <= 220)
  assert.equal(result.emptyCount, 0)
})

test('指纹 = sha256(归一化信息点 + need_kind)：不含段号，容忍空白/标点/大小写漂移', () => {
  const result = run(`
    ${PURE}
    const base = fingerprintOf('出发地·托博尔斯克', 'prop_faithful')
    console.log('@@' + JSON.stringify({
      len: base.length,
      spaced: fingerprintOf(' 出发地 托博尔斯克 ', 'prop_faithful') === base,
      punct: fingerprintOf('「出发地，托博尔斯克」', 'prop_faithful') === base,
      caseInsensitive: fingerprintOf('Tobolsk', 'prop') === fingerprintOf('tobolsk', 'prop'),
      kindMatters: fingerprintOf('出发地·托博尔斯克', 'scene') !== base,
      textMatters: fingerprintOf('抵达地·雅库茨克', 'prop_faithful') !== base,
      key: infoPointKey('出发地 · 托博尔斯克'),
    }))
  `)
  assert.equal(result.len, 64)
  assert.equal(result.spaced, true)
  assert.equal(result.punct, true)
  assert.equal(result.caseInsensitive, true)
  assert.equal(result.kindMatters, true)
  assert.equal(result.textMatters, true)
  assert.equal(result.key, '出发地托博尔斯克')
})

test('状态机 / 五态重算 / 门禁文案 / need_kind 映射', () => {
  const result = run(`
    ${PURE}
    console.log('@@' + JSON.stringify({
      fromMissing: ['have', 'added', 'ignored', 'not_needed'].map(to => canTransitionStatus('missing', to)),
      undo: ['have', 'added', 'not_needed'].map(from => canTransitionStatus(from, 'missing')),
      noShortcut: canTransitionStatus('have', 'ignored'),
      ignoredFree: canTransitionStatus('ignored', 'have'),
      none: computeReviewStatus({ running: false, total: 0, missing: 0 }),
      runningBeatsAll: computeReviewStatus({ running: true, total: 0, missing: 3 }),
      pending: computeReviewStatus({ running: false, total: 5, missing: 1 }),
      passed: computeReviewStatus({ running: false, total: 5, missing: 0 }),
      reasonPending: assetReviewGateReason('pending', 3),
      reasonPassed: assetReviewGateReason('passed', 0),
      kinds: ['character', 'scene', 'prop', 'prop_faithful', 'exposition', 'none'].map(assetKindForNeed),
    }))
  `)
  assert.deepEqual(result.fromMissing, [true, true, true, true])
  assert.deepEqual(result.undo, [true, true, true])
  assert.equal(result.noShortcut, false, '已处置项必须先撤销再改判')
  assert.equal(result.ignoredFree, true)
  assert.equal(result.none, 'none')
  assert.equal(result.runningBeatsAll, 'running')
  assert.equal(result.pending, 'pending')
  assert.equal(result.passed, 'passed')
  assert.match(result.reasonPending, /3 项缺失/)
  assert.equal(result.reasonPassed, '')
  assert.deepEqual(result.kinds, ['character', 'scene', 'prop', 'prop', null, null])
})

const FIXTURE = `
  import { initDb, db, schema } from './src/db/index.ts'
  import { eq } from 'drizzle-orm'
  import {
    fingerprintOf, getAssetReview, updateAssetReviewItem, recomputeAssetReviewStatus,
    markAssetReviewStale, onAssetRemoved, startAssetReview, AssetReviewError,
  } from './src/services/asset-review.ts'
  initDb()
  const at = '2026-01-01T00:00:00.000Z'
  await db.insert(schema.dramas).values([
    { id: 1, title: 'doc', projectType: 'documentary', createdAt: at, updatedAt: at },
    { id: 2, title: 'drama', projectType: 'drama', createdAt: at, updatedAt: at },
  ])
  await db.insert(schema.episodes).values([
    { id: 1, dramaId: 1, episodeNumber: 1, title: 'E1', scriptContent: '第一段。\\n\\n第二段。', createdAt: at, updatedAt: at },
    { id: 9, dramaId: 2, episodeNumber: 1, title: 'D1', createdAt: at, updatedAt: at },
  ])
  await db.insert(schema.props).values({ id: 7, dramaId: 1, name: '安阳区位图', faithful: 1, createdAt: at, updatedAt: at })
  await db.insert(schema.episodeProps).values({ episodeId: 1, propId: 7, createdAt: at })
  const seed = (infoPoint, needKind, extra = {}) => db.insert(schema.assetReviewItems).values({
    episodeId: 1, runId: 1, segmentNo: extra.segmentNo ?? 1,
    narrationExcerpt: '第一段。', infoPoint, needKind, needDesc: infoPoint + '的素材',
    status: extra.status ?? 'missing', assetKind: extra.assetKind ?? null, assetId: extra.assetId ?? null,
    reason: extra.reason ?? null, decidedAt: extra.decidedAt ?? null,
    fingerprint: fingerprintOf(infoPoint, needKind), createdAt: at, updatedAt: at,
  })
`

test('处置写库：忽略必填理由、绑定校验、状态重算', () => {
  const result = run(`
    ${FIXTURE}
    await seed('殷墟在哪里', 'prop_faithful')
    await seed('年份', 'none', { status: 'not_needed', reason: '由图层卡片表达', decidedAt: at })
    const [item] = await db.select().from(schema.assetReviewItems).where(eq(schema.assetReviewItems.needKind, 'prop_faithful'))

    const pendingStatus = await recomputeAssetReviewStatus(1)
    let shortReason = null
    try { await updateAssetReviewItem(item.id, { status: 'ignored', reason: '太短' }) }
    catch (err) { shortReason = { code: err.code, status: err.status } }
    let noAsset = null
    try { await updateAssetReviewItem(item.id, { status: 'have' }) }
    catch (err) { noAsset = err.code }

    const bound = await updateAssetReviewItem(item.id, { status: 'have', asset_kind: 'prop', asset_id: 7 })
    const passedStatus = await recomputeAssetReviewStatus(1)
    const view = await getAssetReview(1)

    // 忠实标记被关掉 → 绑定硬退化回 missing，门禁重新上锁
    await db.update(schema.props).set({ faithful: 0 }).where(eq(schema.props.id, 7))
    await onAssetRemoved('prop', 7)
    const [afterDegrade] = await db.select().from(schema.assetReviewItems).where(eq(schema.assetReviewItems.id, item.id))
    const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, 1))

    console.log('@@' + JSON.stringify({
      pendingStatus, shortReason, noAsset,
      boundStatus: bound.status, boundAsset: bound.asset_id, boundName: bound.asset_name,
      passedStatus, counts: view.counts, segments: view.segments.length,
      degradedStatus: afterDegrade.status, degradedAsset: afterDegrade.assetId,
      episodeStatus: episode.assetReviewStatus,
    }))
  `)
  assert.equal(result.pendingStatus, 'pending')
  assert.deepEqual(result.shortReason, { code: 'reason_required', status: 400 })
  assert.equal(result.noAsset, 'asset_required')
  assert.equal(result.boundStatus, 'have')
  assert.equal(result.boundAsset, 7)
  assert.equal(result.boundName, '安阳区位图')
  assert.equal(result.passedStatus, 'passed')
  assert.equal(result.counts.total, 2)
  assert.equal(result.counts.missing, 0)
  assert.equal(result.segments, 1)
  assert.equal(result.degradedStatus, 'missing')
  assert.equal(result.degradedAsset, null)
  assert.equal(result.episodeStatus, 'pending')
})

test('重新对照：指纹命中保留处置；中间插段不影响既有条目；措辞漂移按文本包含兜底', () => {
  const result = run(`
    ${FIXTURE}
    const { mergeDraftItems } = await import('./src/services/asset-review.ts')
    const draft = (infoPoint, needKind, segmentNo) => ({
      segmentNo, narrationExcerpt: '第 ' + segmentNo + ' 段',
      infoPoint, needKind, needDesc: infoPoint + '的素材',
      status: 'missing', assetKind: null, assetId: null, semanticId: null, reason: null,
      fingerprint: fingerprintOf(infoPoint, needKind),
    })

    // 首轮：两段三条
    mergeDraftItems(1, 10, [draft('殷墟在哪里', 'prop_faithful', 1), draft('商王盘庚', 'exposition', 1), draft('车马坑', 'prop', 2)])
    const [first] = await db.select().from(schema.assetReviewItems).where(eq(schema.assetReviewItems.needKind, 'prop_faithful'))
    await updateAssetReviewItem(first.id, { status: 'have', asset_kind: 'prop', asset_id: 7 })
    const [ignored] = await db.select().from(schema.assetReviewItems).where(eq(schema.assetReviewItems.needKind, 'exposition'))
    await updateAssetReviewItem(ignored.id, { status: 'ignored', reason: '改用旁白加黑场表达' })
    const [cart] = await db.select().from(schema.assetReviewItems).where(eq(schema.assetReviewItems.needKind, 'prop'))
    await updateAssetReviewItem(cart.id, { status: 'not_needed', reason: '由图层卡片表达' })
    const beforeRows = await db.select().from(schema.assetReviewItems)
    const decidedBefore = beforeRows.map(r => [r.infoPoint, r.status, r.decidedAt])

    // 二轮：剧本中间插了一段（原第 2 段变成第 3 段），且「车马坑」措辞漂移成「车马坑遗迹」
    const diff = mergeDraftItems(1, 11, [
      draft('殷墟在哪里', 'prop_faithful', 1),
      draft('商王盘庚', 'exposition', 1),
      draft('新插入的信息点', 'scene', 2),
      draft('车马坑遗迹', 'prop', 3),
      // 跨段重复的同一信息点：只能留一条，否则撞 UNIQUE(episode_id, fingerprint)
      draft('殷墟在哪里', 'prop_faithful', 3),
    ])
    const afterRows = await db.select().from(schema.assetReviewItems)
    console.log('@@' + JSON.stringify({
      decidedBefore,
      diff,
      after: afterRows.map(r => [r.infoPoint, r.needKind, r.segmentNo, r.status, r.decidedAt, r.assetId]),
    }))
  `)
  assert.equal(result.diff.kept, 3, '指纹命中 2 条 + 文本包含兜底 1 条')
  assert.equal(result.diff.added, 1)
  assert.equal(result.diff.removed, 0, '中间插段不得删除任何既有条目')
  assert.equal(result.diff.changed_item_ids.length, 1)

  const after = new Map(result.after.map(([info, kind, seg, status, decided, assetId]) => [info, { kind, seg, status, decided, assetId }]))
  assert.equal(after.get('殷墟在哪里').status, 'have')
  assert.equal(after.get('殷墟在哪里').assetId, 7)
  assert.equal(after.get('殷墟在哪里').seg, 1)
  assert.equal(after.get('商王盘庚').status, 'ignored')
  // 原第 2 段的条目迁到第 3 段，处置结果与处置时间原样保留
  const migrated = after.get('车马坑遗迹')
  assert.equal(migrated.seg, 3)
  assert.equal(migrated.status, 'not_needed', '措辞漂移的已处置行按文本包含迁移，处置保留')
  assert.equal(after.get('新插入的信息点').status, 'missing')
  // 处置时间不得被重跑改写（迁移行按原信息点比对）
  const decidedBefore = new Map(result.decidedBefore.map(([info, status, decidedAt]) => [info, { status, decidedAt }]))
  for (const info of ['殷墟在哪里', '商王盘庚']) {
    assert.equal(after.get(info).decided, decidedBefore.get(info).decidedAt, `${info} 的 decided_at 不得被重跑改写`)
  }
  assert.equal(migrated.decided, decidedBefore.get('车马坑').decidedAt)
})

test('重新对照：整句改写的已处置条目按相似度迁移，不被当成新条目', () => {
  const result = run(`
    ${FIXTURE}
    const { mergeDraftItems, infoPointSimilarity } = await import('./src/services/asset-review.ts')
    const draft = (infoPoint, needKind, segmentNo) => ({
      segmentNo, narrationExcerpt: '第 ' + segmentNo + ' 段',
      infoPoint, needKind, needDesc: infoPoint + '的素材',
      status: 'missing', assetKind: null, assetId: null, semanticId: null, reason: null,
      fingerprint: fingerprintOf(infoPoint, needKind),
    })

    mergeDraftItems(1, 10, [draft('河南安阳·地理区位', 'prop_faithful', 1), draft('洹河自西向东穿流', 'prop_faithful', 1)])
    const rows = await db.select().from(schema.assetReviewItems)
    for (const row of rows) await updateAssetReviewItem(row.id, { status: 'ignored', reason: '本轮先用旁白交代' })
    const before = (await db.select().from(schema.assetReviewItems)).map(r => [r.infoPoint, r.status, r.decidedAt])

    // 二轮：模型整句改写了两条信息点（实测 GLM 重跑就是这样漂移的），包含匹配认不出来
    const diff = mergeDraftItems(1, 11, [
      draft('河南安阳的地理位置', 'prop_faithful', 1),
      draft('洹河自西向东穿过安阳', 'prop_faithful', 1),
    ])
    const after = (await db.select().from(schema.assetReviewItems)).map(r => [r.infoPoint, r.status, r.decidedAt, r.reason])
    console.log('@@' + JSON.stringify({
      before, diff, after,
      sim: infoPointSimilarity('河南安阳·地理区位', '河南安阳的地理位置'),
      unrelated: infoPointSimilarity('河南安阳·地理区位', '加速器质谱数出碳十四'),
    }))
  `)
  assert.equal(result.diff.kept, 2, '两条改写行都应迁移，不得新建')
  assert.equal(result.diff.added, 0)
  assert.equal(result.diff.removed, 0)
  assert.ok(result.sim >= 0.5, `同一信息点的改写相似度应过阈值，实际 ${result.sim}`)
  assert.ok(result.unrelated < 0.5, `不相干信息点不得误配，实际 ${result.unrelated}`)
  const decidedBefore = new Map(result.before.map(([info, status, decidedAt]) => [info, decidedAt]))
  const after = new Map(result.after.map(([info, status, decidedAt, reason]) => [info, { status, decidedAt, reason }]))
  assert.equal(after.size, 2)
  assert.equal(after.get('河南安阳的地理位置').status, 'ignored')
  assert.equal(after.get('河南安阳的地理位置').reason, '本轮先用旁白交代')
  assert.equal(after.get('河南安阳的地理位置').decidedAt, decidedBefore.get('河南安阳·地理区位'))
  assert.equal(after.get('洹河自西向东穿过安阳').status, 'ignored')
  assert.equal(after.get('洹河自西向东穿过安阳').decidedAt, decidedBefore.get('洹河自西向东穿流'))
})

test('对照有段落失败时：不删旧条目（强门禁不被残缺结果解锁）', () => {
  const result = run(`
    ${FIXTURE}
    const { mergeDraftItems } = await import('./src/services/asset-review.ts')
    const draft = (infoPoint, needKind, segmentNo) => ({
      segmentNo, narrationExcerpt: '第 ' + segmentNo + ' 段',
      infoPoint, needKind, needDesc: infoPoint + '的素材',
      status: 'missing', assetKind: null, assetId: null, semanticId: null, reason: null,
      fingerprint: fingerprintOf(infoPoint, needKind),
    })
    mergeDraftItems(1, 10, [draft('殷墟在哪里', 'prop_faithful', 1), draft('车马坑', 'prop', 2)])
    // 第 2 段失败：drafts 只有第 1 段
    const diff = mergeDraftItems(1, 11, [draft('殷墟在哪里', 'prop_faithful', 1)], { keepUnmatched: true })
    const rows = await db.select().from(schema.assetReviewItems)
    // 失败段落留痕在任务 progress 上：recompute 据此拒绝 passed
    const { createTextTask, finishTextTask } = await import('./src/services/text-task.ts')
    const taskId = await createTextTask({ kind: 'asset_review', episodeId: 1, dramaId: 1, progress: { completed: 4, failed: 1, total: 5 } })
    await finishTextTask(taskId, 'failed', { progress: { completed: 4, failed: 1, total: 5 } })
    // 即使把剩下的条目全部处置掉，门禁也不解锁
    for (const row of rows) await updateAssetReviewItem(row.id, { status: 'not_needed', reason: '由图层卡片表达' })
    const status = await recomputeAssetReviewStatus(1)
    // 旁白稿已确认：此时 design 唯一的上锁理由只能是审核清单
    await db.update(schema.episodes).set({ scriptConfirmedAt: at }).where(eq(schema.episodes.id, 1))
    const gates = await (await import('./src/services/workflow-gates.ts')).episodeGates(1)
    console.log('@@' + JSON.stringify({ diff, infos: rows.map(r => r.infoPoint).sort(), status, design: gates.unlocked.design, reason: gates.reasons.design }))
  `)
  assert.equal(result.diff.removed, 0)
  assert.deepEqual(result.infos, ['殷墟在哪里', '车马坑'].sort())
  assert.equal(result.status, 'pending', '有失败段时即便没有 missing 也不得 passed')
  assert.equal(result.design, false, '清单不完整时分镜设计必须保持上锁')
  assert.ok(result.reason)
})

test('失效理由只记横幅，不回退 passed', () => {
  const result = run(`
    ${FIXTURE}
    await seed('殷墟在哪里', 'prop_faithful', { status: 'have', assetKind: 'prop', assetId: 7, decidedAt: at })
    const passed = await recomputeAssetReviewStatus(1)
    await markAssetReviewStale(1, 'asset_linked')
    await markAssetReviewStale(1, 'asset_linked')
    await markAssetReviewStale(1, 'semantics_changed')
    const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, 1))
    console.log('@@' + JSON.stringify({
      passed, status: episode.assetReviewStatus, reasons: JSON.parse(episode.assetReviewStaleReasons || '[]'),
    }))
  `)
  assert.equal(result.passed, 'passed')
  assert.equal(result.status, 'passed', 'stale 只做横幅，绝不回退 passed')
  assert.deepEqual(result.reasons, ['asset_linked', 'semantics_changed'])
})

test('剧情项目短路：run 不启动、读接口 400 not_documentary、不写状态列', () => {
  const result = run(`
    ${FIXTURE}
    const started = await startAssetReview(9, {})
    let readCode = null
    try { await getAssetReview(9) } catch (err) { readCode = err.code }
    const recomputed = await recomputeAssetReviewStatus(9)
    const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, 9))
    console.log('@@' + JSON.stringify({ started, readCode, recomputed, status: episode.assetReviewStatus }))
  `)
  assert.deepEqual(result.started, { started: false, reason: 'not_documentary' })
  assert.equal(result.readCode, 'not_documentary')
  assert.equal(result.recomputed, 'none')
  assert.equal(result.status, 'none')
})
