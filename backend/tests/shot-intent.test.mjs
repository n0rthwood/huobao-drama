/**
 * 表达设计 shot intent（Issue #49）：
 * - 纯函数：device→默认/允许片段位置、外部 kind 映射、must_show/overlay_plan 解析与 unresolved 标记；
 * - 路由：PUT /storyboards/:id 写 intent（撤销确认）、确认闸门、非纪录片拒写；
 * - 一致性：reenact_* 的 must_show 没被 @ 到 → ref_issues.intent_unmet 阻断；整镜片段替代时不再要求视频提示词。
 * 真跑库：临时 SQLITE_PATH + 仓库自带 tsx 子进程，绝不碰开发库。
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
  const dir = mkdtempSync(path.join(tmpdir(), 'shot-intent-'))
  try {
    const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot,
      encoding: 'utf8',
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3') },
    })
    return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

/** 语义标注齐全的地图道具 + 一个角色 + 一镜，返回 id */
const SEED = `
  import { initDb, db, schema } from './src/db/index.ts'
  import { now } from './src/utils/response.ts'
  initDb()
  const ts = now()
  const drama = db.insert(schema.dramas).values({ title: '纪录片', projectType: 'documentary', aspectRatio: '16:9', createdAt: ts, updatedAt: ts }).run()
  const dramaId = Number(drama.lastInsertRowid)
  const ep = db.insert(schema.episodes).values({ dramaId, episodeNumber: 1, title: 'E01', content: '旁白正文', createdAt: ts, updatedAt: ts }).run()
  const episodeId = Number(ep.lastInsertRowid)
  // 先插一个不关联本集的填充道具，让道具 id 与角色 id 错开：
  // 跨类别回退解析会把 portrait 解析成同 id 的道具，id 相同时测不出来
  db.insert(schema.props).values({ dramaId, name: '填充道具', createdAt: ts, updatedAt: ts }).run()
  const semantics = JSON.stringify({
    image: { width: 1000, height: 800, source_task_id: null },
    labels: [{ id: 'lbl-1', text: '斋桑湖', bbox: [10, 10, 60, 30], source: 'manual', confidence: 1 }],
    points: [
      { id: 'pt-1', name: '西宁', at: [100, 200], source: 'manual', confidence: 1 },
      { id: 'pt-2', name: '拉萨', at: [120, 400], source: 'manual', confidence: 1 },
    ],
    regions: [{ id: 'rg-1', name: '准噶尔汗国', points: [[0, 0], [100, 0], [100, 100]], source: 'manual', confidence: 1 }],
    lines: [{ id: 'ln-1', name: '额尔齐斯河', points: [[0, 0], [50, 50]], kind: 'river', source: 'manual', confidence: 1 }],
  })
  const prop = db.insert(schema.props).values({ dramaId, name: '三方局势图', faithful: 1, semantics, imageUrl: '/static/x.png', createdAt: ts, updatedAt: ts }).run()
  const propId = Number(prop.lastInsertRowid)
  db.insert(schema.episodeProps).values({ episodeId, propId, createdAt: ts }).run()
  const character = db.insert(schema.characters).values({ dramaId, name: '利哈列夫', imageUrl: '/static/c.png', createdAt: ts, updatedAt: ts }).run()
  const characterId = Number(character.lastInsertRowid)
  db.insert(schema.episodeCharacters).values({ episodeId, characterId, createdAt: ts }).run()
  const sb = db.insert(schema.storyboards).values({ episodeId, storyboardNumber: 1, duration: 10, createdAt: ts, updatedAt: ts }).run()
  const storyboardId = Number(sb.lastInsertRowid)
`

test('device tables, external kind mapping and clip-position fallback follow the programme table', () => {
  const result = run(`
    import {
      DEVICE_DEFAULT_CLIP, DEVICE_ALLOWED_CLIP, deviceFromExternalKind, normalizeShotIntent,
    } from './src/services/shot-intent.ts'
    const fallback = normalizeShotIntent({ info_point: '两场远征同时开局', device: 'map_anim', deterministic: 'pre', overlay_plan: [{ layer: 'polygon' }] })
    const allowed = normalizeShotIntent({ info_point: '行军', device: 'reenact_video', deterministic: 'post' })
    console.log('@@' + JSON.stringify({
      defaults: DEVICE_DEFAULT_CLIP,
      allowed: DEVICE_ALLOWED_CLIP,
      external: {
        mapAnim: deviceFromExternalKind('map_anim'),
        revealColumn: deviceFromExternalKind('unknown', 'reveal_column'),
        revealAreas: deviceFromExternalKind('unknown', 'reveal_areas'),
        flyto: deviceFromExternalKind('unknown', 'flyto'),
        still: deviceFromExternalKind('still_kenburns'),
        i2v: deviceFromExternalKind('i2v'),
        card: deviceFromExternalKind('card'),
        archival: deviceFromExternalKind('archival'),
        nonsense: deviceFromExternalKind('talking_head'),
      },
      fallbackClip: fallback.intent.deterministic,
      fallbackIssues: fallback.issues.map(i => i.code),
      allowedClip: allowed.intent.deterministic,
      allowedIssues: allowed.issues.map(i => i.code),
    }))
  `)
  assert.deepEqual(result.defaults, {
    map_anim: 'replace', archival: 'replace', card: 'replace', reenact_still: 'replace', reenact_video: 'none',
  })
  assert.deepEqual(result.allowed.reenact_video, ['none', 'pre', 'post'])
  assert.deepEqual(result.allowed.map_anim, ['replace'])
  assert.equal(result.external.mapAnim, 'map_anim')
  assert.equal(result.external.revealColumn, 'map_anim')
  assert.equal(result.external.revealAreas, 'map_anim')
  assert.equal(result.external.flyto, 'map_anim')
  assert.equal(result.external.still, 'reenact_still')
  assert.equal(result.external.i2v, 'reenact_video')
  assert.equal(result.external.card, 'card')
  assert.equal(result.external.archival, 'archival')
  assert.equal(result.external.nonsense, null)
  // 越界建议回落默认值并留痕；允许集内的建议原样保留
  assert.equal(result.fallbackClip, 'replace')
  assert.ok(result.fallbackIssues.includes('clip_position_out_of_range'))
  assert.equal(result.allowedClip, 'post')
  assert.deepEqual(result.allowedIssues, [])
})

test('must_show / overlay anchors resolve against the asset semantics and unresolved refs are kept and flagged', () => {
  const result = run(`
    ${SEED}
    const { loadIntentContext } = await import('./src/services/shot-intent-context.ts')
    const { normalizeShotIntent } = await import('./src/services/shot-intent.ts')
    const ctx = loadIntentContext(episodeId)
    const good = normalizeShotIntent({
      info_point: '两场远征同时开局',
      device: 'map_anim',
      must_show: [
        { kind: 'region', asset_id: propId, semantic: '准噶尔汗国' },
        { kind: 'line', asset_id: propId, semantic: '额尔齐斯河' },
        { kind: 'label', asset_id: propId, semantic: '斋桑湖' },
        { kind: 'route', asset_id: propId, from: '西宁', to: '拉萨' },
        { kind: 'portrait', asset_id: characterId },
      ],
      overlay_plan: [
        { layer: 'polyline', anchor: { asset_id: propId, semantic_id: 'ln-1' }, reveal_at: 3 },
        { layer: 'polygon', anchor: { asset_id: propId, semantic_id: '准噶尔汗国' }, reveal_at: 0 },
      ],
      rationale: '区域高亮 + 两条箭头让「同时」可见',
    }, ctx)
    const bad = normalizeShotIntent({
      info_point: '不存在的要素',
      device: 'map_anim',
      must_show: [
        { kind: 'region', asset_id: propId, semantic: '叶尼塞河流域' },
        { kind: 'portrait', asset_id: 9999 },
        // 角色 id 与道具 id 不同：portrait 指向道具 id 必须解析失败，不得跨类别回退
        { kind: 'portrait', asset_id: propId },
      ],
      overlay_plan: [{ layer: 'polygon', anchor: { asset_id: propId, semantic_id: '不存在' } }],
    }, ctx)
    const emptyPlan = normalizeShotIntent({ info_point: '地图', device: 'map_anim' }, ctx)
    console.log('@@' + JSON.stringify({
      goodUnresolved: good.intent.must_show.filter(i => i.unresolved).length,
      goodIssues: good.issues.map(i => i.code),
      semanticIds: good.intent.must_show.map(i => i.semantic_id || null),
      revealOrder: good.intent.overlay_plan.map(l => l.layer),
      anchorResolved: good.intent.overlay_plan.map(l => l.anchor.semantic_id || null),
      badUnresolved: bad.intent.must_show.filter(i => i.unresolved).length,
      badKept: bad.intent.must_show.length,
      badOverlayUnresolved: bad.intent.overlay_plan.filter(l => l.unresolved).length,
      badCodes: [...new Set(bad.issues.map(i => i.code))].sort(),
      emptyPlanCodes: emptyPlan.issues.map(i => i.code),
    }))
  `)
  assert.equal(result.goodUnresolved, 0)
  assert.deepEqual(result.goodIssues, [])
  assert.deepEqual(result.semanticIds, ['rg-1', 'ln-1', 'lbl-1', null, null])
  // overlay_plan 按 reveal_at 升序（0 的在前），锚点按名称也能解析成稳定 id
  assert.deepEqual(result.revealOrder, ['polygon', 'polyline'])
  assert.deepEqual(result.anchorResolved, ['rg-1', 'ln-1'])
  assert.equal(result.badUnresolved, 3)
  assert.equal(result.badKept, 3, '解析不到的条目必须保留下来给人改，不能被悄悄删掉')
  assert.equal(result.badOverlayUnresolved, 1)
  assert.deepEqual(result.badCodes, ['unresolved_must_show', 'unresolved_overlay_anchor'])
  assert.deepEqual(result.emptyPlanCodes, ['empty_overlay_plan'])
})

test('PUT /storyboards/:id persists intent, clears the review flag and gates confirmation', () => {
  const result = run(`
    ${SEED}
    const { default: app } = await import('./src/routes/storyboards.ts')
    const put = body => app.request('/' + storyboardId, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const valid = {
      info_point: '准噶尔与清、俄三方并立',
      device: 'map_anim',
      must_show: [{ kind: 'region', asset_id: propId, semantic: '准噶尔汗国' }],
      overlay_plan: [{ layer: 'polygon', anchor: { asset_id: propId, semantic_id: 'rg-1' }, reveal_at: 0 }],
      rationale: '区域高亮',
    }
    const saveRes = await put({ intent: valid })
    const saved = (await saveRes.json()).data
    const confirmRes = await put({ intent_reviewed: true })
    const confirmed = (await confirmRes.json()).data
    // 再写一次 intent：确认位自动撤销
    const rewriteRes = await put({ intent: { ...valid, info_point: '改了信息点' } })
    const rewritten = (await rewriteRes.json()).data
    // 带悬空引用的 intent 不得确认
    await put({ intent: { ...valid, must_show: [{ kind: 'region', asset_id: propId, semantic: '不存在的范围' }] } })
    const badConfirm = await put({ intent_reviewed: true })
    const badConfirmBody = await badConfirm.json()
    // map_anim 没有叠加层 → 结构机检阻断，也不得确认
    await put({ intent: { ...valid, overlay_plan: [] } })
    const emptyPlanConfirm = await put({ intent_reviewed: true })
    // 非纪录片项目拒写
    const ts2 = now()
    const drama2 = db.insert(schema.dramas).values({ title: '短剧', projectType: 'drama', aspectRatio: '16:9', createdAt: ts2, updatedAt: ts2 }).run()
    const ep2 = db.insert(schema.episodes).values({ dramaId: Number(drama2.lastInsertRowid), episodeNumber: 1, title: 'E01', content: 'x', createdAt: ts2, updatedAt: ts2 }).run()
    const sb2 = db.insert(schema.storyboards).values({ episodeId: Number(ep2.lastInsertRowid), storyboardNumber: 1, duration: 10, createdAt: ts2, updatedAt: ts2 }).run()
    const dramaRes = await app.request('/' + Number(sb2.lastInsertRowid), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ intent: valid }) })
    console.log('@@' + JSON.stringify({
      saveStatus: saveRes.status,
      savedDevice: saved.intent.device,
      savedClip: saved.intent.deterministic,
      savedReviewed: saved.intent_reviewed,
      savedAtTracked: typeof saved.saved_at === 'number',
      confirmed: confirmed.intent_reviewed,
      rewrittenReviewed: rewritten.intent_reviewed,
      badConfirmStatus: badConfirm.status,
      badConfirmMessage: badConfirmBody.message || '',
      emptyPlanConfirmStatus: emptyPlanConfirm.status,
      dramaStatus: dramaRes.status,
    }))
  `)
  assert.equal(result.saveStatus, 200)
  assert.equal(result.savedDevice, 'map_anim')
  assert.equal(result.savedClip, 'replace')
  assert.equal(result.savedReviewed, false)
  assert.equal(result.savedAtTracked, true)
  assert.equal(result.confirmed, true)
  assert.equal(result.rewrittenReviewed, false, '改过 intent 之后必须重新人工确认')
  assert.equal(result.badConfirmStatus, 400)
  assert.match(result.badConfirmMessage, /解析不到/)
  assert.equal(result.emptyPlanConfirmStatus, 400)
  assert.equal(result.dramaStatus, 400)
})

test('reenact shots block on intent_unmet and clip-replaced shots stop demanding a video prompt', () => {
  const result = run(`
    ${SEED}
    const { computeRefIssues, loadEpisodeAssets, loadTargetBindings, syncStoryboardBindingsFromPrompts, promptFieldsOf } = await import('./src/services/storyboard-assets.ts')
    const { loadIntentContext, resolveStoryboardIntent } = await import('./src/services/shot-intent-context.ts')
    const { normalizeShotIntent, serializeShotIntent } = await import('./src/services/shot-intent.ts')
    const ctx = loadIntentContext(episodeId)
    const reenact = normalizeShotIntent({
      info_point: '利哈列夫受命带队',
      device: 'reenact_still',
      must_show: [{ kind: 'portrait', asset_id: characterId }],
    }, ctx).intent
    const mapAnim = normalizeShotIntent({
      info_point: '三方并立',
      device: 'map_anim',
      overlay_plan: [{ layer: 'polygon', anchor: { asset_id: propId, semantic_id: 'rg-1' } }],
    }, ctx).intent

    const setPrompts = async (first, video) => {
      db.update(schema.storyboards).set({ firstFramePrompt: first, lastFramePrompt: first, videoPrompt: video }).where(eq(schema.storyboards.id, storyboardId)).run()
      await syncStoryboardBindingsFromPrompts(storyboardId, ['first_frame_prompt', 'last_frame_prompt', 'video_prompt'])
    }
    const { eq } = await import('drizzle-orm')
    const issuesFor = async (intent) => {
      const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
      return computeRefIssues({
        prompts: promptFieldsOf(row),
        assets: await loadEpisodeAssets(episodeId),
        bindings: await loadTargetBindings(storyboardId),
        intent,
      })
    }
    // 提示词没有 @ 到肖像 → intent_unmet 阻断
    await setPrompts('全景：空旷的操场，清晨的侧光', '')
    const unmet = await issuesFor(reenact)
    // @ 上了就不再阻断
    await setPrompts('全景：@利哈列夫 站在操场上，清晨的侧光', '')
    const met = await issuesFor(reenact)
    // 同一条提示词、没有 intent 时判定与改动前一致（只剩空视频提示词）
    const noIntent = await issuesFor(null)
    // 整镜由片段替代的地图镜头不再要求视频提示词
    const clip = await issuesFor(mapAnim)
    console.log('@@' + JSON.stringify({
      unmet: unmet.filter(i => i.code === 'intent_unmet').map(i => ({ fields: i.fields, name: i.name, severity: i.severity })),
      unmetMessage: (unmet.find(i => i.code === 'intent_unmet') || {}).message || '',
      met: met.filter(i => i.code === 'intent_unmet').length,
      noIntentCodes: noIntent.map(i => i.code).sort(),
      clipCodes: clip.map(i => i.code).sort(),
    }))
  `)
  assert.equal(result.unmet.length, 2, '首帧与尾帧两条提示词各报一次')
  assert.ok(result.unmet.every(issue => issue.severity === 'block'))
  assert.deepEqual(result.unmet.map(i => i.fields).flat().sort(), ['first_frame_prompt', 'last_frame_prompt'])
  assert.match(result.unmetMessage, /利哈列夫/)
  assert.equal(result.met, 0)
  assert.deepEqual(result.noIntentCodes, ['empty_video_prompt'])
  assert.deepEqual(result.clipCodes, [], '地图镜头整镜由确定性片段渲染，空视频提示词不是问题')
})
