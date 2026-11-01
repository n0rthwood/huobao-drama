/**
 * 纪录片题材规则（Issue #32）：
 * - genre 关键字归一 + 项目开关覆盖（开关优先），孤立的「历史」不触发；
 * - 命中题材时技能装配叠加 documentary addendum，未命中时技能文本逐字不变；
 * - 最终提示词来源标记：外部直写记 external，清空时一并清掉。
 * 纯函数与技能装配都真跑（仓库自带 tsx 子进程）。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(script) {
  const sqlitePath = path.join(mkdtempSync(path.join(tmpdir(), 'documentary-')), 'test.sqlite3')
  const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, SQLITE_PATH: sqlitePath },
  })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

test('genre keywords normalise to the documentary ruleset and the project switch wins', () => {
  const result = run(`
    import { resolveGenreRuleset, resolveRulesetWithMode } from './src/services/genre-ruleset.ts'
    process.stdout.write('@@' + JSON.stringify({
      documentaryZh: resolveGenreRuleset('历史纪录片'),
      documentaryTw: resolveGenreRuleset('歷史紀錄片'),
      documentaryEn: resolveGenreRuleset('Historical Documentary'),
      historyOnly: resolveGenreRuleset('古装历史剧'),
      empty: resolveGenreRuleset(''),
      switchOn: resolveRulesetWithMode('都市甜宠', 'on'),
      switchOff: resolveRulesetWithMode('历史纪录片', 'off'),
      auto: resolveRulesetWithMode('历史纪录片', 'auto'),
      nullMode: resolveRulesetWithMode('历史纪录片', null),
    }))
  `)
  assert.equal(result.documentaryZh, 'documentary')
  assert.equal(result.documentaryTw, 'documentary')
  assert.equal(result.documentaryEn, 'documentary')
  // 孤立的「历史」不算纪录片：古装历史短剧不能吃到史实忠实规则
  assert.equal(result.historyOnly, null)
  assert.equal(result.empty, null)
  assert.equal(result.switchOn, 'documentary')
  assert.equal(result.switchOff, null)
  assert.equal(result.auto, 'documentary')
  assert.equal(result.nullMode, 'documentary')
})

test('the documentary addendum is appended only for the documentary ruleset and never rewrites the base skills', () => {
  const result = run(`
    import { loadAgentSkills } from './src/agents/skills.ts'
    const plainExtractor = await loadAgentSkills('extractor', 'zh')
    const docExtractor = await loadAgentSkills('extractor', 'zh', { genreRuleset: 'documentary' })
    const plainPrompt = await loadAgentSkills('prompt_generator', 'zh')
    const docPrompt = await loadAgentSkills('prompt_generator', 'zh', { genreRuleset: 'documentary' })
    process.stdout.write('@@' + JSON.stringify({
      plainExtractor, docExtractor, plainPrompt, docPrompt,
    }))
  `)
  // 未命中题材：技能文本里没有任何 documentary 段落
  assert.ok(!result.plainExtractor.includes('documentary-extraction'))
  assert.ok(!result.plainPrompt.includes('documentary-character-prompt'))
  // 命中题材：addendum 追加在基础技能之后，基础技能文本原样保留
  assert.ok(result.docExtractor.includes('## Skill: documentary/documentary-extraction'))
  assert.ok(result.docExtractor.startsWith(result.plainExtractor.slice(0, result.plainExtractor.length - 1)))
  for (const name of ['documentary-character-prompt', 'documentary-scene-prompt', 'documentary-prop-prompt']) {
    assert.ok(result.docPrompt.includes(`## Skill: documentary/${name}`), `missing ${name}`)
  }
  // 三视图版式仍然是角色提示词的唯一版式，addendum 明确禁止改版
  assert.ok(result.docPrompt.includes('角色设定参考图'))
  assert.ok(result.docPrompt.includes('版式不可改'))
})

test('external final_prompt writes are marked, agent saves are marked, and clearing drops the marker', () => {
  const result = run(`
    import { planFinalPromptWrite } from './src/services/asset-prompt-invalidation.ts'
    const at = '2026-01-01T00:00:00.000Z'
    process.stdout.write('@@' + JSON.stringify({
      external: planFinalPromptWrite({ currentFinalPrompt: null, finalPrompt: '外部写的提示词', sourceChanged: false, at }),
      cleared: planFinalPromptWrite({ currentFinalPrompt: '旧稿', finalPrompt: '', sourceChanged: false, at }),
      invalidated: planFinalPromptWrite({ currentFinalPrompt: '旧稿', sourceChanged: true, at }),
      untouched: planFinalPromptWrite({ currentFinalPrompt: '旧稿', finalPrompt: '旧稿', sourceChanged: false, at }),
    }))
  `)
  assert.deepEqual(result.external, { finalPrompt: '外部写的提示词', finalPromptSource: 'external', finalPromptUpdatedAt: '2026-01-01T00:00:00.000Z' })
  assert.deepEqual(result.cleared, { finalPrompt: null, finalPromptSource: null, finalPromptUpdatedAt: null })
  assert.deepEqual(result.invalidated, { finalPrompt: null, finalPromptSource: null, finalPromptUpdatedAt: null })
  assert.deepEqual(result.untouched, {})
})

test('an agent-saved character prompt is marked agent and archival images stay out of the generation inputs', () => {
  const result = run(`
    import { db, schema, initDb } from './src/db/index.ts'
    import { eq } from 'drizzle-orm'
    import { buildAgentRequestContext } from './src/agents/context.ts'
    import { imagePromptTools } from './src/agents/tools/image-prompt-tools.ts'
    import { resolveReferenceImages } from './src/services/reference-images.ts'
    import { parseArchivalImages } from './src/services/archival-images.ts'
    initDb()
    const ts = new Date().toISOString()
    const archival = JSON.stringify([{ path: 'static/uploads/archival_images/character/81/a.jpg', file_title: 'File:Peter.jpg', source_page_url: 'https://commons.wikimedia.org/wiki/File:Peter.jpg', file_url: 'https://upload.wikimedia.org/x.jpg', artist: 'Pieter', work_date: '1690', license: 'PD', license_url: '', retrieved_at: ts }])
    await db.insert(schema.dramas).values({ id: 80, title: 't', genre: '历史纪录片', createdAt: ts, updatedAt: ts })
    await db.insert(schema.characters).values({ id: 81, dramaId: 80, name: '彼得一世', appearance: '短髭', styling: '胸甲戎装、蓝绶带', archivalImages: archival, createdAt: ts, updatedAt: ts })
    const ctx = { requestContext: buildAgentRequestContext({ episodeId: 1, dramaId: 80 }) }
    const read = await imagePromptTools.readCharacters.execute({}, ctx)
    await imagePromptTools.saveCharacterFinalPrompt.execute({ character_id: 81, prompt: '角色设定参考图，左侧为正脸特写…纯白背景' }, ctx)
    const [row] = await db.select().from(schema.characters).where(eq(schema.characters.id, 81))
    process.stdout.write('@@' + JSON.stringify({
      hasArchivalFlag: read.characters[0].has_archival_reference,
      source: row.finalPromptSource,
      updatedAtSet: !!row.finalPromptUpdatedAt,
      referenceImages: resolveReferenceImages(row.referenceImages),
      archivalCount: parseArchivalImages(row.archivalImages).length,
    }))
  `)
  assert.equal(result.hasArchivalFlag, true)
  assert.equal(result.source, 'agent')
  assert.equal(result.updatedAtSet, true)
  // 画像入库后参考图列表仍然为空：生图链路不读 archival_images
  assert.deepEqual(result.referenceImages, [])
  assert.equal(result.archivalCount, 1)
})
