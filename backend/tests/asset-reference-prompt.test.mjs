/**
 * 资产参考图 ↔ 最终提示词的引用约定（Issue #107 追加范围；Issue #121 改「按引用发送」）：
 * - 纯函数：五种写法识别（含裸 参考图N）、按需引用核验（越界 / 描述引用必须落地 /
 *   未引用普通参考图不是错误）、资产编号→请求编号映射与稀疏渲染；
 * - 读工具与保存工具真跑（tsx 子进程 + 临时 SQLite）：reference_images 只列磁盘上还有的图，
 *   描述引用未落地时保存工具返回 { saved: false } 让模型改写；自查工具同口径；
 * - 删除参考图后的编号重写（shiftReferenceCitations）；
 * - 换厂商重试的 @引用渲染：关键帧的 @名字 行为不变，资产参考图的序号别名不再追加名字。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function runTs(script) {
  const sqlitePath = path.join(mkdtempSync(path.join(tmpdir(), 'asset-refs-')), 'test.sqlite3')
  const storagePath = mkdtempSync(path.join(tmpdir(), 'asset-refs-static-'))
  const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, SQLITE_PATH: sqlitePath, STORAGE_PATH: storagePath },
  })
  return JSON.parse(out.slice(out.lastIndexOf('\n@@') + 3))
}

// ─── 识别与核验（纯函数） ────────────────────────────────────────

test('a reference counts as cited in any of the five accepted spellings (incl. bare 参考图N)', () => {
  const result = runTs(`
    import { citedReferenceIndices } from './src/services/asset-reference-prompt.ts'
    const cases = [
      '@参考图1、@参考图2',
      '<image1> 形制，<image2> 材质',
      '图片1提供形制，图片2提供材质',
      '<Picture 1> 形制，<Picture 2> 材质',
      '参考图1提供形制，参考图2提供材质',
      '@参考图1提供形制，图片2提供材质',
    ]
    process.stdout.write('@@' + JSON.stringify(cases.map(prompt => citedReferenceIndices(prompt))))
  `)
  for (const cited of result) assert.deepEqual(cited, [1, 2])
})

test('partial citation is legal; out-of-range and missing description citations are rejected', () => {
  const result = runTs(`
    import { referenceCitationIssue, checkReferenceCitations, sendingReferenceIndices } from './src/services/asset-reference-prompt.ts'
    process.stdout.write('@@' + JSON.stringify({
      // 3 张参考图只引第 3 张：合法（未引用的普通参考图不是错误）
      partial: referenceCitationIssue('@参考图3提供配色', 3),
      willSend: sendingReferenceIndices('@参考图3提供配色', 3),
      // 越界：只有 2 张却引第 3 张
      stray: referenceCitationIssue('@参考图1、@参考图3', 2),
      // 描述引用了第 2 张，final_prompt 漏掉 → 拒绝并点名
      descMissing: referenceCitationIssue('@参考图1提供形制', 3, [2]),
      descKept: referenceCitationIssue('@参考图1提供形制，@参考图2提供材质', 3, [2]),
      // 零参考图：无标记放行，虚构标记拒绝
      zeroNoMarker: referenceCitationIssue('纯白单品，没有任何参考图', 0),
      zeroInvented: referenceCitationIssue('@参考图1提供形制', 0),
      check: checkReferenceCitations('@参考图3提供配色，@参考图9不存在', { refCount: 3, descriptionCitations: [2] }),
    }))
  `)
  assert.equal(result.partial, null)
  assert.deepEqual(result.willSend, [3])
  assert.match(result.stray, /@参考图3/)
  assert.match(result.descMissing, /@参考图2/)
  assert.equal(result.descKept, null)
  assert.equal(result.zeroNoMarker, null)
  assert.match(result.zeroInvented, /@参考图1/)
  assert.deepEqual(result.check.willSend, [3])
  assert.deepEqual(result.check.outOfRange, [9])
  assert.deepEqual(result.check.descriptionMissing, [2])
})

test('reference indices are matched exactly: 图片1 does not satisfy 图片10', () => {
  const result = runTs(`
    import { citedReferenceIndices, outOfRangeReferences } from './src/services/asset-reference-prompt.ts'
    process.stdout.write('@@' + JSON.stringify({
      tenOnly: citedReferenceIndices('图片10 提供细节'),
      prefixTrap: citedReferenceIndices('图片10 与 @参考图2'),
      extraIndex: outOfRangeReferences('@参考图1、@参考图2、@参考图3', 2),
      bareTen: citedReferenceIndices('参考图10 与 参考图1'),
    }))
  `)
  assert.deepEqual(result.tenOnly, [10])
  assert.deepEqual(result.prefixTrap, [2, 10])
  assert.deepEqual(result.extraIndex, [3])
  assert.deepEqual(result.bareTen, [1, 10])
})

// ─── 编号映射与厂商渲染 ──────────────────────────────────────────

test('sparse citation maps asset numbers to contiguous request numbers per provider', () => {
  const result = runTs(`
    import { renderReferencePrompt, referenceNameIndex } from './src/services/asset-reference-prompt.ts'
    // 3 张参考图只引第 3 张：请求里只有 1 张，标签必须是 <image1> 而不是 <image3>
    const prompt = '以@参考图3的配色为准，纯白背景'
    process.stdout.write('@@' + JSON.stringify({
      index: referenceNameIndex(3, [3]),
      qwen: renderReferencePrompt(prompt, 3, 'qwen-jobs', false, [3]),
      openai: renderReferencePrompt(prompt, 3, 'openai', false, [3]),
      h3img: renderReferencePrompt(prompt, 3, 'qwen-jobs', true, [3]),
      // 乱序 + 重复引用：按资产编号升序映射，重复引用指向同一请求编号
      mixed: renderReferencePrompt('@参考图3与@参考图1，再看@参考图3', 3, 'qwen-jobs', false, [1, 3]),
      mixedIndex: referenceNameIndex(3, [1, 3]),
      // 裸写法同样被映射
      bare: renderReferencePrompt('参考图3提供配色', 3, 'qwen-jobs', false, [3]),
      // 全量旧口径（无 indices）不变
      full: renderReferencePrompt('@参考图1提供时代形制，@参考图2提供材质与磨损', 2, 'qwen-jobs'),
      // 换厂商重试：已渲染的提示词再渲染成新厂商写法
      requeued: renderReferencePrompt('<image1>提供形制，<image2>提供材质', 2, 'gemini'),
      untouched: renderReferencePrompt(prompt, 0, 'qwen-jobs'),
      tenRefs: renderReferencePrompt('图片10与图片1', 10, 'qwen-jobs'),
    }))
  `)
  assert.deepEqual(result.index, { 参考图3: 1 })
  assert.equal(result.qwen, '以<image1>的配色为准，纯白背景')
  assert.equal(result.openai, '以图片1的配色为准，纯白背景')
  assert.equal(result.h3img, '以<Picture 1>的配色为准，纯白背景')
  assert.equal(result.mixed, '<image2>与<image1>，再看<image2>')
  assert.deepEqual(result.mixedIndex, { 参考图1: 1, 参考图3: 2 })
  assert.equal(result.bare, '<image1>提供配色')
  assert.equal(result.full, '<image1>提供时代形制，<image2>提供材质与磨损')
  assert.equal(result.requeued, '图片1提供形制，图片2提供材质')
  assert.equal(result.untouched, '以@参考图3的配色为准，纯白背景')
  assert.equal(result.tenRefs, '<image10>与<image1>')
})

test('the qwen-jobs hint keeps its old generic prefix and never fights an explicit citation', () => {
  const result = runTs(`
    import { withReferenceHint } from './src/services/adapters/qwen-jobs-client.ts'
    process.stdout.write('@@' + JSON.stringify({
      bare: withReferenceHint('一只猫', 2),
      cited: withReferenceHint('@参考图1提供形制，@参考图2提供材质', 2),
      otherVendor: withReferenceHint('图片1提供形制', 1),
      bareForm: withReferenceHint('参考图1提供形制', 1),
      noRefs: withReferenceHint('一只猫', 0),
    }))
  `)
  assert.equal(result.bare, '以 <image1>、<image2> 为参考：一只猫')
  assert.equal(result.cited, '<image1>提供形制，<image2>提供材质')
  assert.equal(result.otherVendor, '<image1>提供形制')
  assert.equal(result.bareForm, '<image1>提供形制')
  assert.equal(result.noRefs, '一只猫')
})

test('retry rendering keeps asset-name labels and drops the redundant 参考图N alias', () => {
  const result = runTs(`
    import { renderRefPrompt } from './src/services/task-label.ts'
    process.stdout.write('@@' + JSON.stringify({
      qwenNamed: renderRefPrompt('@猪爸爸 站在 @客厅', { 猪爸爸: 1, 客厅: 2 }, { type: 'image', provider: 'qwen-jobs' }),
      openaiNamed: renderRefPrompt('@猪爸爸 站在 @客厅', { 猪爸爸: 1, 客厅: 2 }, { type: 'image', provider: 'openai' }),
      qwenAsset: renderRefPrompt('@参考图1提供形制，@参考图2提供材质', { 参考图1: 1, 参考图2: 2 }, { type: 'image', provider: 'qwen-jobs' }),
      openaiAsset: renderRefPrompt('@参考图1提供形制，@参考图2提供材质', { 参考图1: 1, 参考图2: 2 }, { type: 'image', provider: 'openai' }),
      // #121 稀疏映射：资产编号 3 → 请求编号 1
      sparseAsset: renderRefPrompt('@参考图3提供配色', { 参考图3: 1 }, { type: 'image', provider: 'qwen-jobs' }),
    }))
  `)
  assert.equal(result.qwenNamed, '<image1>猪爸爸 站在 <image2>客厅')
  assert.equal(result.openaiNamed, '图片1猪爸爸 站在 图片2客厅')
  assert.equal(result.qwenAsset, '<image1>提供形制，<image2>提供材质')
  assert.equal(result.openaiAsset, '图片1提供形制，图片2提供材质')
  assert.equal(result.sparseAsset, '<image1>提供配色')
})

// ─── 删除参考图的编号重写 ────────────────────────────────────────

test('removing reference k renumbers higher citations and marks the removed one invalid', () => {
  const result = runTs(`
    import { shiftReferenceCitations } from './src/services/reference-images.ts'
    process.stdout.write('@@' + JSON.stringify({
      text: shiftReferenceCitations('样貌见@参考图1，服装见@参考图2，配色见@参考图3', 2),
      vendor: shiftReferenceCitations('<image2>形制与图片3材质', 2),
      bare: shiftReferenceCitations('参考图2 与 参考图10', 2),
      untouched: shiftReferenceCitations('没有引用', 2),
    }))
  `)
  assert.equal(result.text, '样貌见@参考图1，服装见参考图2（已删除），配色见@参考图2')
  assert.equal(result.vendor, '参考图2（已删除）形制与图片2材质')
  assert.equal(result.bare, '参考图2（已删除） 与 参考图9')
  assert.equal(result.untouched, '没有引用')
})

// ─── 读工具 / 保存工具 / 自查工具（真跑 DB） ─────────────────────

test('read tools list only references that still exist on disk and expose description citations', () => {
  const result = runTs(`
    import { db, schema, initDb } from './src/db/index.ts'
    import { buildAgentRequestContext } from './src/agents/context.ts'
    import { imagePromptTools } from './src/agents/tools/image-prompt-tools.ts'
    initDb()
    const ts = new Date().toISOString()
    const refs = JSON.stringify([
      { path: 'https://cdn.example/era.png', uploaded_at: 1 },
      { path: 'static/uploads/reference_images/character/81/gone.png', uploaded_at: 2 },
      { path: 'https://cdn.example/fabric.webp', uploaded_at: 3 },
    ])
    const archival = JSON.stringify([{ path: 'static/uploads/archival_images/character/81/a.jpg', file_title: 'File:Peter.jpg', source_page_url: '', file_url: '', artist: 'Pieter', work_date: '1690', license: 'PD', license_url: '', retrieved_at: ts }])
    await db.insert(schema.dramas).values({ id: 80, title: 't', genre: '历史纪录片', createdAt: ts, updatedAt: ts })
    await db.insert(schema.characters).values({ id: 81, dramaId: 80, name: '彼得一世', appearance: '短髭，五官见@参考图2', styling: '胸甲戎装', referenceImages: refs, archivalImages: archival, createdAt: ts, updatedAt: ts })
    await db.insert(schema.scenes).values({ id: 90, dramaId: 80, location: '涅瓦河口', time: '黄昏', prompt: '沼泽', lighting: '落日', referenceImages: JSON.stringify([{ path: 'https://cdn.example/scene.png', uploaded_at: 1 }]), createdAt: ts, updatedAt: ts })
    await db.insert(schema.props).values({ id: 91, dramaId: 80, name: '佩剑', description: '弯柄佩刀', createdAt: ts, updatedAt: ts })
    const ctx = { requestContext: buildAgentRequestContext({ episodeId: 1, dramaId: 80 }) }
    const chars = await imagePromptTools.readCharacters.execute({}, ctx)
    const scenes = await imagePromptTools.readScenes.execute({}, ctx)
    const props = await imagePromptTools.readProps.execute({}, ctx)
    process.stdout.write('@@' + JSON.stringify({ chars: chars.characters[0], scenes: scenes.scenes[0], props: props.props[0] }))
  `)
  assert.deepEqual(result.chars.reference_images, [
    { n: 1, path: 'https://cdn.example/era.png' },
    { n: 2, path: 'https://cdn.example/fabric.webp' },
  ])
  assert.equal(result.chars.reference_count, 2)
  assert.deepEqual(result.chars.description_citations, [2])
  assert.equal(result.chars.has_archival_reference, true)
  assert.deepEqual(result.chars.archival_images, ['static/uploads/archival_images/character/81/a.jpg'])
  assert.equal(result.scenes.reference_count, 1)
  assert.deepEqual(result.scenes.description_citations, [])
  assert.equal(result.props.reference_count, 0)
  assert.deepEqual(result.props.reference_images, [])
})

test('save tools accept partial citation but reject missing description citations; self-check tool agrees', () => {
  const result = runTs(`
    import { db, schema, initDb } from './src/db/index.ts'
    import { eq } from 'drizzle-orm'
    import { buildAgentRequestContext } from './src/agents/context.ts'
    import { imagePromptTools } from './src/agents/tools/image-prompt-tools.ts'
    initDb()
    const ts = new Date().toISOString()
    const refs = JSON.stringify([
      { path: 'https://cdn.example/era.png', uploaded_at: 1 },
      { path: 'https://cdn.example/fabric.webp', uploaded_at: 2 },
    ])
    await db.insert(schema.dramas).values({ id: 80, title: 't', genre: '历史纪录片', createdAt: ts, updatedAt: ts })
    await db.insert(schema.characters).values({ id: 81, dramaId: 80, name: '彼得一世', appearance: '短髭，五官见@参考图2', styling: '胸甲戎装', referenceImages: refs, createdAt: ts, updatedAt: ts })
    await db.insert(schema.characters).values({ id: 82, dramaId: 80, name: '无参考角色', appearance: '短发', createdAt: ts, updatedAt: ts })
    const ctx = { requestContext: buildAgentRequestContext({ episodeId: 1, dramaId: 80 }) }
    // 只引第 1 张、漏掉描述引用的第 2 张 → 拒存
    const rejected = await imagePromptTools.saveCharacterFinalPrompt.execute({ character_id: 81, prompt: '@参考图1提供时代形制，纯白背景' }, ctx)
    const [afterReject] = await db.select().from(schema.characters).where(eq(schema.characters.id, 81))
    // 自查工具同口径
    const checkBad = await imagePromptTools.checkFinalPromptReferences.execute({ kind: 'character', asset_id: 81, prompt: '@参考图1提供时代形制，纯白背景' }, ctx)
    // 保留描述引用（只引第 2 张也合法——按需引用）
    const accepted = await imagePromptTools.saveCharacterFinalPrompt.execute({ character_id: 81, prompt: '@参考图2提供五官与织物质感，纯白背景' }, ctx)
    const [afterAccept] = await db.select().from(schema.characters).where(eq(schema.characters.id, 81))
    const checkGood = await imagePromptTools.checkFinalPromptReferences.execute({ kind: 'character', asset_id: 81, prompt: '@参考图2提供五官与织物质感，纯白背景' }, ctx)
    const noRefs = await imagePromptTools.saveCharacterFinalPrompt.execute({ character_id: 82, prompt: '角色设定参考图，纯白背景' }, ctx)
    process.stdout.write('@@' + JSON.stringify({
      rejected, afterRejectPrompt: afterReject.finalPrompt,
      checkBad, acceptedSaved: accepted.saved, afterAcceptPrompt: afterAccept.finalPrompt,
      checkGood, noRefsSaved: noRefs.saved,
    }))
  `)
  assert.equal(result.rejected.saved, false)
  assert.match(result.rejected.error, /@参考图2/)
  assert.equal(result.afterRejectPrompt, null)
  assert.equal(result.checkBad.ok, false)
  assert.deepEqual(result.checkBad.description_citations_missing, [2])
  assert.deepEqual(result.checkBad.will_send, [1])
  assert.equal(result.acceptedSaved, true)
  assert.match(result.afterAcceptPrompt, /@参考图2提供五官与织物质感/)
  assert.equal(result.checkGood.ok, true)
  assert.deepEqual(result.checkGood.will_send, [2])
  assert.equal(result.noRefsSaved, true)
})
// ─── 提交侧归一（请求编号 → 中性写法） ───────────────────────────

test('submit neutralization maps request numbers to neutral tokens without eating two-digit tails', () => {
  const result = runTs(`
    import { neutralizeAssetCitations } from './src/services/generation.ts'
    process.stdout.write('@@' + JSON.stringify({
      // 稀疏映射：资产编号 2 → 请求编号 1（只发 1 张）
      sparse: neutralizeAssetCitations('以@参考图2的五官为准，纯白背景', { 参考图2: 1 }),
      two: neutralizeAssetCitations('以@参考图2的五官为准，参考图1的配色', { 参考图1: 1, 参考图2: 2 }),
      vendor: neutralizeAssetCitations('<image2>形制与图片1材质', { 参考图1: 1, 参考图2: 2 }),
      // 两位数边界：映射只有 参考图1 时，参考图10 不被吃掉尾巴也不被归一
      ten: neutralizeAssetCitations('参考图10 与 图片1', { 参考图1: 1 }),
      tenFull: neutralizeAssetCitations('参考图10 与 图片1', { 参考图1: 1, 参考图10: 10 }),
      none: neutralizeAssetCitations('纯白背景', {}),
    }))
  `)
  assert.equal(result.sparse, '以@参考图1的五官为准，纯白背景')
  assert.equal(result.two, '以@参考图2的五官为准，@参考图1的配色')
  assert.equal(result.vendor, '@参考图2形制与@参考图1材质')
  assert.equal(result.ten, '参考图10 与 @参考图1')
  assert.equal(result.tenFull, '@参考图10 与 @参考图1')
  assert.equal(result.none, '纯白背景')
})
