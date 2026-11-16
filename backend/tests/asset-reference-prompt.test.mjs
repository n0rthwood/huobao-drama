/**
 * 资产参考图 ↔ 最终提示词的引用约定（Issue #107 追加范围）：
 * - 纯函数：中性写法 @参考图N 的校验（逐张引用 / 漏引用 / 张数不符 / 零参考图）与按厂商渲染；
 * - 读工具与保存工具真跑（tsx 子进程 + 临时 SQLite）：reference_images 只列磁盘上还有的图，
 *   有参考图却漏引用时保存工具返回 { saved: false } 让模型改写；
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
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

// ─── 校验器（纯函数） ────────────────────────────────────────────

test('a reference counts as cited in any of the three accepted spellings', () => {
  const result = runTs(`
    import { promptCitesReferences, uncitedReferences } from './src/services/asset-reference-prompt.ts'
    const cases = [
      ['@参考图1、@参考图2', 2],
      ['<image1> 形制，<image2> 材质', 2],
      ['图片1提供形制，图片2提供材质', 2],
      ['@参考图1提供形制，图片2提供材质', 2],
    ]
    process.stdout.write('@@' + JSON.stringify(cases.map(([prompt, n]) => promptCitesReferences(prompt, n))))
  `)
  assert.deepEqual(result, [true, true, true, true])
})

test('a prompt that drops one reference is rejected and names the missing index', () => {
  const result = runTs(`
    import { promptCitesReferences, uncitedReferences, referenceCitationIssue } from './src/services/asset-reference-prompt.ts'
    const prompt = '@参考图1提供形制，@参考图3提供配色'
    process.stdout.write('@@' + JSON.stringify({
      cited: promptCitesReferences(prompt, 3),
      uncited: uncitedReferences(prompt, 3),
      issue: referenceCitationIssue(prompt, 3),
      zeroNoMarker: referenceCitationIssue('纯白单品，没有任何参考图', 0),
      zeroInvented: referenceCitationIssue('@参考图1提供形制', 0),
    }))
  `)
  assert.equal(result.cited, false)
  assert.deepEqual(result.uncited, [2])
  assert.match(result.issue, /3 张参考图/)
  assert.match(result.issue, /@参考图2/)
  // 零参考图：提示词里没有标记就放行，虚构了引用标记则拒绝
  assert.equal(result.zeroNoMarker, null)
  assert.match(result.zeroInvented, /只发送 0 张参考图/)
  assert.match(result.zeroInvented, /@参考图1/)
})

test('reference indices are matched exactly: 图片1 does not satisfy 图片10 and stale higher indices do not count', () => {
  const result = runTs(`
    import { promptCitesReferences, uncitedReferences } from './src/services/asset-reference-prompt.ts'
    process.stdout.write('@@' + JSON.stringify({
      // 只写了 图片10：1..10 里只有第 10 张被引用
      tenOnly: uncitedReferences('图片10 提供细节', 10),
      // 张数不符：提示词引用了第 3 张，但这次只发 2 张
      extraIndex: promptCitesReferences('@参考图1、@参考图2、@参考图3', 2),
      // 图片1 是 图片10 的前缀，不能互相命中
      prefixTrap: uncitedReferences('图片10 与 @参考图2', 2),
      prefixCited: uncitedReferences('图片1 与 图片2', 2),
      zeroRefs: promptCitesReferences('纯白单品，没有任何参考', 0),
    }))
  `)
  assert.deepEqual(result.tenOnly, [1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.equal(result.extraIndex, false)
  assert.deepEqual(result.prefixTrap, [1])
  assert.deepEqual(result.prefixCited, [])
  assert.equal(result.zeroRefs, true)
})

// ─── 厂商渲染 ───────────────────────────────────────────────────

test('neutral @参考图N renders to <imageN> for qwen-jobs and 图片N for every other provider', () => {
  const result = runTs(`
    import { renderReferencePrompt, referenceNameIndex, referenceToken } from './src/services/asset-reference-prompt.ts'
    const prompt = '@参考图1提供时代形制，@参考图2提供材质与磨损'
    process.stdout.write('@@' + JSON.stringify({
      tokens: [referenceToken(1), referenceToken(2)],
      index: referenceNameIndex(2),
      qwen: renderReferencePrompt(prompt, 2, 'qwen-jobs'),
      openai: renderReferencePrompt(prompt, 2, 'openai'),
      // 换厂商重试：已经渲染过的提示词要再渲染成新厂商的写法
      requeued: renderReferencePrompt('<image1>提供形制，<image2>提供材质', 2, 'gemini'),
      // 没有参考图时原样返回（资产无参考图的既有行为不变）
      untouched: renderReferencePrompt(prompt, 0, 'qwen-jobs'),
      // 第 10 张不能被第 1 张的替换切走
      tenRefs: renderReferencePrompt('图片10与图片1', 10, 'qwen-jobs'),
    }))
  `)
  assert.deepEqual(result.tokens, ['@参考图1', '@参考图2'])
  assert.deepEqual(result.index, { 参考图1: 1, 参考图2: 2 })
  assert.equal(result.qwen, '<image1>提供时代形制，<image2>提供材质与磨损')
  assert.equal(result.openai, '图片1提供时代形制，图片2提供材质与磨损')
  assert.equal(result.requeued, '图片1提供形制，图片2提供材质')
  assert.equal(result.untouched, '@参考图1提供时代形制，@参考图2提供材质与磨损')
  assert.equal(result.tenRefs, '<image10>与<image1>')
})

test('the qwen-jobs hint keeps its old generic prefix and never fights an explicit citation', () => {
  const result = runTs(`
    import { withReferenceHint } from './src/services/adapters/qwen-jobs-client.ts'
    process.stdout.write('@@' + JSON.stringify({
      // 关键帧提示词（无引用）：旧行为的泛化前缀不变
      bare: withReferenceHint('一只猫', 2),
      // 资产提示词已经逐张引用：不再补前缀
      cited: withReferenceHint('@参考图1提供形制，@参考图2提供材质', 2),
      // 其它厂商写法：渲染成 qwen-jobs 的 <imageN>，同样不补前缀
      otherVendor: withReferenceHint('图片1提供形制', 1),
      noRefs: withReferenceHint('一只猫', 0),
    }))
  `)
  assert.equal(result.bare, '以 <image1>、<image2> 为参考：一只猫')
  assert.equal(result.cited, '<image1>提供形制，<image2>提供材质')
  assert.equal(result.otherVendor, '<image1>提供形制')
  assert.equal(result.noRefs, '一只猫')
})

test('retry rendering keeps asset-name labels and drops the redundant 参考图N alias', () => {
  const result = runTs(`
    import { renderRefPrompt } from './src/services/task-label.ts'
    process.stdout.write('@@' + JSON.stringify({
      // 关键帧：@名字 → <imageN>名字 / 图片N名字（既有行为）
      qwenNamed: renderRefPrompt('@猪爸爸 站在 @客厅', { 猪爸爸: 1, 客厅: 2 }, { type: 'image', provider: 'qwen-jobs' }),
      openaiNamed: renderRefPrompt('@猪爸爸 站在 @客厅', { 猪爸爸: 1, 客厅: 2 }, { type: 'image', provider: 'openai' }),
      // 资产参考图：序号别名就是引用名，不能再追加一次名字
      qwenAsset: renderRefPrompt('@参考图1提供形制，@参考图2提供材质', { 参考图1: 1, 参考图2: 2 }, { type: 'image', provider: 'qwen-jobs' }),
      openaiAsset: renderRefPrompt('@参考图1提供形制，@参考图2提供材质', { 参考图1: 1, 参考图2: 2 }, { type: 'image', provider: 'openai' }),
    }))
  `)
  assert.equal(result.qwenNamed, '<image1>猪爸爸 站在 <image2>客厅')
  assert.equal(result.openaiNamed, '图片1猪爸爸 站在 图片2客厅')
  assert.equal(result.qwenAsset, '<image1>提供形制，<image2>提供材质')
  assert.equal(result.openaiAsset, '图片1提供形制，图片2提供材质')
})

// ─── 读工具 / 保存工具（真跑 DB） ────────────────────────────────

test('read tools list only references that still exist on disk and expose archival portrait paths', () => {
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
    await db.insert(schema.characters).values({ id: 81, dramaId: 80, name: '彼得一世', appearance: '短髭', styling: '胸甲戎装', referenceImages: refs, archivalImages: archival, createdAt: ts, updatedAt: ts })
    await db.insert(schema.scenes).values({ id: 90, dramaId: 80, location: '涅瓦河口', time: '黄昏', prompt: '沼泽', lighting: '落日', referenceImages: JSON.stringify([{ path: 'https://cdn.example/scene.png', uploaded_at: 1 }]), createdAt: ts, updatedAt: ts })
    await db.insert(schema.props).values({ id: 91, dramaId: 80, name: '佩剑', description: '弯柄佩刀', createdAt: ts, updatedAt: ts })
    const ctx = { requestContext: buildAgentRequestContext({ episodeId: 1, dramaId: 80 }) }
    const chars = await imagePromptTools.readCharacters.execute({}, ctx)
    const scenes = await imagePromptTools.readScenes.execute({}, ctx)
    const props = await imagePromptTools.readProps.execute({}, ctx)
    process.stdout.write('@@' + JSON.stringify({ chars: chars.characters[0], scenes: scenes.scenes[0], props: props.props[0] }))
  `)
  // 磁盘上缺失的 static/... 条目不进列表：编号只覆盖真正会发送的图
  assert.deepEqual(result.chars.reference_images, [
    { n: 1, path: 'https://cdn.example/era.png' },
    { n: 2, path: 'https://cdn.example/fabric.webp' },
  ])
  assert.equal(result.chars.reference_count, 2)
  assert.equal(result.chars.has_archival_reference, true)
  assert.deepEqual(result.chars.archival_images, ['static/uploads/archival_images/character/81/a.jpg'])
  assert.equal(result.scenes.reference_count, 1)
  assert.deepEqual(result.scenes.reference_images, [{ n: 1, path: 'https://cdn.example/scene.png' }])
  // 没有参考图的资产：计数 0、列表为空（行为与改动前一致）
  assert.equal(result.props.reference_count, 0)
  assert.deepEqual(result.props.reference_images, [])
})

test('save tools refuse a prompt that does not cite every reference and accept one that does', () => {
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
    await db.insert(schema.characters).values({ id: 81, dramaId: 80, name: '彼得一世', appearance: '短髭', styling: '胸甲戎装', referenceImages: refs, createdAt: ts, updatedAt: ts })
    await db.insert(schema.characters).values({ id: 82, dramaId: 80, name: '无参考角色', appearance: '短发', createdAt: ts, updatedAt: ts })
    const ctx = { requestContext: buildAgentRequestContext({ episodeId: 1, dramaId: 80 }) }
    const rejected = await imagePromptTools.saveCharacterFinalPrompt.execute({ character_id: 81, prompt: '@参考图1提供时代形制，纯白背景' }, ctx)
    const [afterReject] = await db.select().from(schema.characters).where(eq(schema.characters.id, 81))
    const accepted = await imagePromptTools.saveCharacterFinalPrompt.execute({ character_id: 81, prompt: '@参考图1提供时代形制，@参考图2提供织物质感，纯白背景' }, ctx)
    const [afterAccept] = await db.select().from(schema.characters).where(eq(schema.characters.id, 81))
    const noRefs = await imagePromptTools.saveCharacterFinalPrompt.execute({ character_id: 82, prompt: '角色设定参考图，纯白背景' }, ctx)
    process.stdout.write('@@' + JSON.stringify({
      rejected,
      afterRejectPrompt: afterReject.finalPrompt,
      acceptedSaved: accepted.saved,
      afterAcceptPrompt: afterAccept.finalPrompt,
      noRefsSaved: noRefs.saved,
    }))
  `)
  assert.equal(result.rejected.saved, false)
  assert.match(result.rejected.error, /@参考图2/)
  // 拒绝时绝不写入半成品：库里仍是空提示词
  assert.equal(result.afterRejectPrompt, null)
  assert.equal(result.acceptedSaved, true)
  assert.match(result.afterAcceptPrompt, /@参考图1提供时代形制/)
  assert.match(result.afterAcceptPrompt, /@参考图2提供织物质感/)
  // 零参考图：与改动前一样直接保存
  assert.equal(result.noRefsSaved, true)
})
