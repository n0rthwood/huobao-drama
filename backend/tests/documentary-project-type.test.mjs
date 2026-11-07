/**
 * 项目类型 documentary（Issue #45）：
 * - 创建/更新路由：纪录片默认值、类型不可切换、规则集强制；
 * - 技能注入：纪录片项目的 script_rewriter / storyboard_breaker 叠加纪录片技能；
 * - narration-first：拆分分镜逐字取用剧本正文，旁白写作只许注音。
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
  const dir = mkdtempSync(path.join(tmpdir(), 'documentary-project-'))
  try {
    const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot,
      encoding: 'utf8',
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3') },
    })
    return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const SCRIPT = [
  '【开场】',
  '1715 年秋，沙皇彼得一世把目光投向东方。',
  '额尔齐斯河是唯一一条能把军队送进腹地的水道。',
  '【远征】',
  '这一年冬天，布赫霍尔茨奉命率领近三千人，从托博尔斯克溯流而上。',
].join('\n\n')

test('creating a documentary project writes the type, forces the documentary switch and the archival style', () => {
  const result = run(`
    import { initDb, db, schema } from './src/db/index.ts'
    import { eq } from 'drizzle-orm'
    import app from './src/routes/dramas.ts'
    initDb()
    const post = body => app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const docRes = await post({ title: '纪录片项目', project_type: 'documentary', aspect_ratio: '16:9' })
    const doc = (await docRes.json()).data
    const dramaRes = await post({ title: '短剧项目', aspect_ratio: '9:16', style: '3d' })
    const drama = (await dramaRes.json()).data
    const badRes = await post({ title: '非法类型', project_type: 'movie', aspect_ratio: '16:9' })
    const row = async id => (await db.select().from(schema.dramas).where(eq(schema.dramas.id, id)))[0]
    const docRow = await row(doc.id)
    const dramaRow = await row(drama.id)
    // 类型不可切换：改成 drama 返回 400，同值幂等写入放行
    const put = (id, body) => app.request('/' + id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const switchRes = await put(doc.id, { project_type: 'drama' })
    const sameRes = await put(doc.id, { project_type: 'documentary', title: '纪录片项目 2' })
    const rulesOffRes = await put(doc.id, { documentary_rules: 'off' })
    const dramaRulesRes = await put(drama.id, { documentary_rules: 'off' })
    const detail = await (await app.request('/' + doc.id)).json()
    const dramaDetail = await (await app.request('/' + drama.id)).json()
    console.log('@@' + JSON.stringify({
      docStatus: docRes.status,
      docType: docRow.projectType,
      docRules: docRow.documentaryRules,
      docStyle: docRow.style,
      dramaType: dramaRow.projectType,
      dramaRules: dramaRow.documentaryRules,
      dramaStyle: dramaRow.style,
      badStatus: badRes.status,
      switchStatus: switchRes.status,
      sameStatus: sameRes.status,
      rulesOffStatus: rulesOffRes.status,
      dramaRulesStatus: dramaRulesRes.status,
      docRuleset: detail.data.genre_ruleset,
      docDetailType: detail.data.project_type,
      dramaRuleset: dramaDetail.data.genre_ruleset,
      dramaDetailType: dramaDetail.data.project_type,
    }))
  `)
  assert.equal(result.docStatus, 201)
  assert.equal(result.docType, 'documentary')
  assert.equal(result.docRules, 'on')
  assert.equal(result.docStyle, 'documentary-archival')
  // drama 项目一字不变：类型 drama、规则开关不写、风格照传
  assert.equal(result.dramaType, 'drama')
  assert.equal(result.dramaRules, null)
  assert.equal(result.dramaStyle, '3d')
  assert.equal(result.badStatus, 400)
  assert.equal(result.switchStatus, 400)
  assert.equal(result.sameStatus, 200)
  assert.equal(result.rulesOffStatus, 400)
  assert.equal(result.dramaRulesStatus, 200)
  // genre 为空也归一为 documentary（项目类型优先级最高）
  assert.equal(result.docRuleset, 'documentary')
  assert.equal(result.docDetailType, 'documentary')
  assert.equal(result.dramaRuleset, null)
  assert.equal(result.dramaDetailType, 'drama')
})

test('new episodes of a documentary project default to narration enabled', () => {
  const result = run(`
    import { initDb, db, schema } from './src/db/index.ts'
    import { eq } from 'drizzle-orm'
    import episodes from './src/routes/episodes.ts'
    initDb()
    const at = '2026-01-01T00:00:00.000Z'
    await db.insert(schema.aiServiceConfigs).values([
      { id: 1, name: 'img', serviceType: 'image', provider: 'test', baseUrl: 'http://127.0.0.1:9', apiKey: 'k', model: 'm', isActive: true, priority: 1, createdAt: at, updatedAt: at },
      { id: 2, name: 'vid', serviceType: 'video', provider: 'test', baseUrl: 'http://127.0.0.1:9', apiKey: 'k', model: 'm', isActive: true, priority: 1, createdAt: at, updatedAt: at },
    ])
    await db.insert(schema.dramas).values([
      { id: 1, title: 'doc', projectType: 'documentary', createdAt: at, updatedAt: at },
      { id: 2, title: 'drama', projectType: 'drama', createdAt: at, updatedAt: at },
    ])
    const create = dramaId => episodes.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ drama_id: dramaId, image_config_id: 1, video_config_id: 2 }) })
    const docEp = (await (await create(1)).json()).data
    const dramaEp = (await (await create(2)).json()).data
    const row = async id => (await db.select().from(schema.episodes).where(eq(schema.episodes.id, id)))[0]
    console.log('@@' + JSON.stringify({
      doc: (await row(docEp.id)).narrationEnabled,
      drama: (await row(dramaEp.id)).narrationEnabled,
    }))
  `)
  assert.equal(result.doc, true)
  assert.equal(result.drama, false)
})

test('narration-first skills follow project_type, not the documentary ruleset', () => {
  const result = run(`
    import { loadAgentSkills } from './src/agents/skills.ts'
    const plainScript = await loadAgentSkills('script_rewriter', null, {})
    const docScript = await loadAgentSkills('script_rewriter', null, { projectType: 'documentary' })
    const plainBreaker = await loadAgentSkills('storyboard_breaker', null, {})
    const docBreaker = await loadAgentSkills('storyboard_breaker', null, { projectType: 'documentary' })
    const docBreakerEn = await loadAgentSkills('storyboard_breaker', 'en', { projectType: 'documentary' })
    // drama 项目靠 documentary_rules 打开纪录片规则（如 drama 3）：题材 addendum 照旧，
    // narration-first 的两份技能不能注入（它们的工具变体只在 documentary 项目里）
    const rulesOnlyScript = await loadAgentSkills('script_rewriter', null, { genreRuleset: 'documentary' })
    const rulesOnlyBreaker = await loadAgentSkills('storyboard_breaker', null, { genreRuleset: 'documentary' })
    const rulesOnlyExtractor = await loadAgentSkills('extractor', null, { genreRuleset: 'documentary' })
    console.log('@@' + JSON.stringify({ plainScript, docScript, plainBreaker, docBreaker, docBreakerEn, rulesOnlyScript, rulesOnlyBreaker, rulesOnlyExtractor }))
  `)
  // 未命中项目类型：基础技能文本里没有纪录片段落
  assert.ok(!result.plainScript.includes('documentary-script'))
  assert.ok(!result.plainBreaker.includes('documentary-storyboard'))
  // 命中：addendum 追加在基础技能之后，基础技能文本原样保留
  assert.ok(result.docScript.includes('## Skill: documentary/documentary-script'))
  assert.ok(result.docScript.startsWith(result.plainScript.slice(0, result.plainScript.length - 1)))
  assert.ok(result.docBreaker.includes('## Skill: documentary/documentary-storyboard'))
  assert.ok(result.docBreaker.startsWith(result.plainBreaker.slice(0, result.plainBreaker.length - 1)))
  // 骨架内容：旁白优先 / 不做对白改写 / 信息点
  assert.ok(result.docScript.includes('不做「对话驱动」'))
  assert.ok(result.docBreaker.includes('逐字照抄'))
  assert.ok(result.docBreaker.includes('每镜一个信息点'))
  // 四语：英文变体走 SKILL.en.md
  assert.ok(result.docBreakerEn.includes('One information point per shot'))
  // documentary_rules='on' 的 drama 项目：技能文本与改动前逐字一致
  assert.equal(result.rulesOnlyScript, result.plainScript)
  assert.equal(result.rulesOnlyBreaker, result.plainBreaker)
  assert.ok(result.rulesOnlyExtractor.includes('## Skill: documentary/documentary-extraction'))
})

test('documentary agents get the narration-first tool variants and drama agents do not', () => {
  const result = run(`
    import { initDb, db, schema } from './src/db/index.ts'
    import { agentRegistry } from './src/agents/index.ts'
    import { buildAgentRequestContext } from './src/agents/context.ts'
    initDb()
    const at = '2026-01-01T00:00:00.000Z'
    await db.insert(schema.dramas).values([
      { id: 1, title: 'doc', projectType: 'documentary', createdAt: at, updatedAt: at },
      { id: 2, title: 'drama', projectType: 'drama', createdAt: at, updatedAt: at },
    ])
    const tools = async (type, dramaId) => {
      const requestContext = buildAgentRequestContext({ episodeId: 1, dramaId })
      const resolved = await agentRegistry[type].listTools({ requestContext })
      return Object.fromEntries(Object.entries(resolved).map(([key, tool]) => [key, tool.description]))
    }
    const docBreaker = await tools('storyboard_breaker', 1)
    const dramaBreaker = await tools('storyboard_breaker', 2)
    const docNarration = await tools('narration_writer', 1)
    const dramaNarration = await tools('narration_writer', 2)
    console.log('@@' + JSON.stringify({
      docBreaker: docBreaker.saveStoryboards,
      dramaBreaker: dramaBreaker.saveStoryboards,
      docNarration: docNarration.saveNarrations,
      dramaNarration: dramaNarration.saveNarrations,
      docBreakerKeys: Object.keys(docBreaker).sort(),
      dramaBreakerKeys: Object.keys(dramaBreaker).sort(),
    }))
  `)
  assert.ok(result.docBreaker.includes('narration_text copied verbatim'))
  assert.ok(!result.dramaBreaker.includes('narration_text copied verbatim'))
  assert.ok(result.docNarration.includes('ONLY add pronunciation markers'))
  assert.ok(!result.dramaNarration.includes('ONLY add pronunciation markers'))
  // 变体只换 save_storyboards：#46 的 read_image 等其它工具两类项目都在
  assert.deepEqual(result.docBreakerKeys, result.dramaBreakerKeys)
  assert.ok(result.docBreakerKeys.includes('readImage'))
})

test('the documentary split assigns narration verbatim and rejects rewritten or oversized passages', () => {
  const script = JSON.stringify(SCRIPT)
  const result = run(`
    import { initDb, db, schema } from './src/db/index.ts'
    import { eq } from 'drizzle-orm'
    import { documentaryStoryboardTools, storyboardTools } from './src/agents/tools/storyboard-tools.ts'
    import { buildAgentRequestContext } from './src/agents/context.ts'
    import { narrationCoverage, scriptMatchKey } from './src/services/narration-first.ts'
    initDb()
    const at = '2026-01-01T00:00:00.000Z'
    const script = ${script}
    await db.insert(schema.dramas).values({ id: 1, title: 'doc', projectType: 'documentary', createdAt: at, updatedAt: at })
    await db.insert(schema.episodes).values({ id: 1, dramaId: 1, episodeNumber: 1, title: 'E1', scriptContent: script, narrationEnabled: true, createdAt: at, updatedAt: at })
    const ctx = { requestContext: buildAgentRequestContext({ episodeId: 1, dramaId: 1 }) }
    const save = documentaryStoryboardTools.saveStoryboards.execute
    const good = await save({
      replace_existing: true,
      storyboards: [
        { shot_number: 1, title: '彼得一世东望', description: '沙皇立于窗前', duration: 8, narration_text: '1715 年秋，沙皇彼得一世把目光投向东方。' },
        { shot_number: 2, title: '唯一水道', description: '地图展开', duration: 9, narration_text: '额尔齐斯河是唯一一条能把军队送进腹地的水道。' },
      ],
    }, ctx)
    const rewritten = await save({
      storyboards: [
        { shot_number: 3, title: '远征出发', description: '队列行进', duration: 10, narration_text: '这年冬天，布赫霍尔茨带着三千人出发了。' },
      ],
    }, ctx)
    const rows = async () => (await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, 1)))
      .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
      .map(sb => ({ n: sb.storyboardNumber, text: sb.narrationText, enabled: sb.narrationEnabled, desc: sb.description }))
    const afterRewrite = await rows()
    const fixed = await save({
      storyboards: [
        { shot_number: 3, title: '远征出发', description: '队列行进', duration: 10, narration_text: '这一年冬天，布赫霍尔茨奉命率领近三千人，从托博尔斯克溯流而上。' },
      ],
    }, ctx)
    const afterFix = await rows()
    const coverage = narrationCoverage(script, afterFix.map(r => r.text))
    // 同一次运行的后续批次再传 replace_existing：忽略清空，已切好的镜头不被删
    const midRunReplace = await save({
      replace_existing: true,
      storyboards: [
        { shot_number: 4, title: '尾镜', description: '水面远景', duration: 6 },
      ],
    }, ctx)
    const afterMidRun = await rows()
    // 新的一次运行（新 requestContext）仍然可以整集重切
    const rerunCtx = { requestContext: buildAgentRequestContext({ episodeId: 1, dramaId: 1 }) }
    const rerun = await save({
      replace_existing: true,
      storyboards: [
        { shot_number: 1, title: '重切', description: '重新开始', duration: 8, narration_text: '1715 年秋，沙皇彼得一世把目光投向东方。' },
      ],
    }, rerunCtx)
    const afterRerun = await rows()
    // drama 变体的 schema 不含 narration_text（文档片段字段只出现在纪录片变体里）
    const dramaKeys = Object.keys(storyboardTools.saveStoryboards.inputSchema.shape.storyboards.element.shape)
    const docKeys = Object.keys(documentaryStoryboardTools.saveStoryboards.inputSchema.shape.storyboards.element.shape)
    console.log('@@' + JSON.stringify({
      goodRejected: good.narration_rejected,
      goodCoverage: good.script_coverage.covered_chars,
      rewrittenRejected: rewritten.narration_rejected,
      afterRewrite,
      fixedRejected: fixed.narration_rejected,
      afterFix,
      coverage,
      scriptChars: scriptMatchKey(script).length,
      midRunIgnored: midRunReplace.replace_existing_ignored,
      midRunRejected: midRunReplace.rejected,
      afterMidRun,
      rerunIgnored: rerun.replace_existing_ignored,
      afterRerun,
      dramaHasNarration: dramaKeys.includes('narration_text'),
      docHasNarration: docKeys.includes('narration_text'),
    }))
  `)
  assert.deepEqual(result.goodRejected, [])
  assert.equal(result.docHasNarration, true)
  assert.equal(result.dramaHasNarration, false)
  // 改写过的旁白被拒：画面字段照常保存，旁白字段留空
  assert.equal(result.rewrittenRejected.length, 1)
  assert.equal(result.rewrittenRejected[0].shot_number, 3)
  assert.match(result.rewrittenRejected[0].reason, /verbatim/)
  // 改写过的旁白字段留空（骨架阶段不再保存画面字段，#70：画面属于实测设计卡阶段）
  assert.equal(result.afterRewrite[2].text, null)
  // 原样重存后通过，整集旁白拼接 = 剧本正文（去空白、去节拍标记后逐字一致）
  assert.deepEqual(result.fixedRejected, [])
  assert.equal(result.coverage.covered_chars, result.scriptChars)
  assert.equal(result.coverage.in_order, true)
  assert.deepEqual(result.coverage.not_in_script, [])
  // 同一次运行里重复清空被忽略：前三镜仍在。第四镜没有旁白 —— 纪录片每镜必须承载一段旁白（#57），拒存
  assert.equal(result.midRunIgnored, true)
  assert.equal(result.midRunRejected.length, 1)
  assert.equal(result.midRunRejected[0].shot_number, 4)
  assert.match(result.midRunRejected[0].reason, /每镜必须承载一段旁白/)
  assert.deepEqual(result.afterMidRun.map(r => r.n), [1, 2, 3])
  // 新运行允许整集重切
  assert.equal(result.rerunIgnored, false)
  assert.deepEqual(result.afterRerun.map(r => r.n), [1])
})

test('documentary narration writing may only add pronunciation markers', () => {
  const result = run(`
    import { initDb, db, schema } from './src/db/index.ts'
    import { eq } from 'drizzle-orm'
    import { documentaryNarrationTools, narrationTools } from './src/agents/tools/narration-tools.ts'
    import { buildAgentRequestContext } from './src/agents/context.ts'
    initDb()
    const at = '2026-01-01T00:00:00.000Z'
    const original = '额尔齐斯河是唯一一条能把军队送进腹地的水道。'
    await db.insert(schema.dramas).values([
      { id: 1, title: 'doc', projectType: 'documentary', createdAt: at, updatedAt: at },
      { id: 2, title: 'drama', projectType: 'drama', createdAt: at, updatedAt: at },
    ])
    for (const [episodeId, dramaId] of [[1, 1], [2, 2]]) {
      await db.insert(schema.episodes).values({ id: episodeId, dramaId, episodeNumber: 1, title: 'E', narrationEnabled: true, createdAt: at, updatedAt: at })
      await db.insert(schema.storyboards).values({
        id: episodeId, episodeId, storyboardNumber: 1, title: 'shot', duration: 10,
        narrationText: original, narrationEnabled: true, createdAt: at, updatedAt: at,
      })
    }
    // 纪录片项目里刻意留白的纯画面镜头（拆镜没有分配旁白）
    await db.insert(schema.storyboards).values({
      id: 3, episodeId: 1, storyboardNumber: 2, title: 'silent', duration: 6,
      narrationText: '', narrationEnabled: false, createdAt: at, updatedAt: at,
    })
    const ctx = (episodeId, dramaId) => ({ requestContext: buildAgentRequestContext({ episodeId, dramaId }) })
    const docSave = documentaryNarrationTools.saveNarrations.execute
    const text = async id => (await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)))[0].narrationText
    // 注音：允许
    const marked = await docSave({ narrations: [{ shot_number: 1, narration: '额尔齐斯河是唯一一条能把军队送进[[腹地|fu4 di4]]的水道。' }] }, ctx(1, 1))
    const afterMarked = await text(1)
    // 改字：拒绝
    const rewrite = await docSave({ narrations: [{ shot_number: 1, narration: '额尔齐斯河是唯一的水道。' }] }, ctx(1, 1))
    const afterRewrite = await text(1)
    // 关掉旁白等于清空原文：同样拒绝
    const disable = await docSave({ narrations: [{ shot_number: 1, narration: '', narration_enabled: false }] }, ctx(1, 1))
    const afterDisable = await text(1)
    // drama 项目：改写照常保存
    // 原文为空的纯画面镜头：不许凭空写旁白
    const invented = await docSave({ narrations: [{ shot_number: 2, narration: '这里本来没有旁白。' }] }, ctx(1, 1))
    const afterInvented = await text(3)
    // 只改空白（把词粘起来）也算改字
    const spaced = await docSave({ narrations: [{ shot_number: 1, narration: '额尔齐斯河是唯一一条能把军 队送进腹地的水道。' }] }, ctx(1, 1))
    const afterSpaced = await text(1)
    const dramaWrite = await narrationTools.saveNarrations.execute({ narrations: [{ shot_number: 1, narration: '完全不同的新旁白。' }] }, ctx(2, 2))
    const afterDrama = await text(2)
    console.log('@@' + JSON.stringify({
      marked, afterMarked, rewrite, afterRewrite, disable, afterDisable, dramaWrite, afterDrama, original,
      invented, afterInvented, spaced, afterSpaced,
    }))
  `)
  assert.deepEqual(result.marked.saved_shot_numbers, [1])
  assert.ok(result.afterMarked.includes('[[腹地|fu4 di4]]'))
  assert.deepEqual(result.rewrite.saved_shot_numbers, [])
  assert.match(result.rewrite.rejected[0].reason, /narration-first/)
  assert.equal(result.afterRewrite, result.afterMarked)
  assert.deepEqual(result.disable.saved_shot_numbers, [])
  assert.equal(result.afterDisable, result.afterMarked)
  assert.deepEqual(result.invented.saved_shot_numbers, [])
  assert.match(result.invented.rejected[0].reason, /narration-first/)
  assert.equal(result.afterInvented, '')
  assert.deepEqual(result.spaced.saved_shot_numbers, [])
  assert.equal(result.afterSpaced, result.afterMarked)
  // drama 项目完全不受影响
  assert.deepEqual(result.dramaWrite.saved_shot_numbers, [1])
  assert.equal(result.afterDrama, '完全不同的新旁白。')
})
