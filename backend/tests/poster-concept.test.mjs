/**
 * Poster AI 构想（Issue #72）：剧本出处块剔除、方案资产/引用校验、文字层转换、
 * 参考图重排与 @名字解析，以及 provenance 保护下的方案应用（临时 SQLite）。
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
  const dir = mkdtempSync(path.join(tmpdir(), 'poster-concept-'))
  try {
    const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot,
      encoding: 'utf8',
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3') },
    })
    return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('剧本出处块只按结构剔除，不误删正文', () => {
  const result = run(`
    import { stripProvenanceBlock } from './src/services/poster-concept.ts'
    const script = [
      '原始材料：维基百科',
      '永久链接：https://example.org/x',
      '原作者：某编者',
      '许可：CC BY-SA 4.0',
      '说明：文首出处信息不作为朗读稿',
      '',
      '【开场】漕运始于秦汉。',
      '【章节一】隋唐大运河。',
    ].join('\\n')
    const noHeader = '【开场】正文\\n说明：这里的说明是正文的一部分。'
    const headerWithoutNote = '原始材料：X\\n永久链接：https://x\\n\\n【开场】正文'
    console.log('@@' + JSON.stringify({
      stripped: stripProvenanceBlock(script),
      noHeader: stripProvenanceBlock(noHeader),
      headerWithoutNote: stripProvenanceBlock(headerWithoutNote),
      empty: stripProvenanceBlock('   '),
    }))
  `)
  assert.equal(result.stripped, '【开场】漕运始于秦汉。\n【章节一】隋唐大运河。')
  assert.equal(result.noHeader, '【开场】正文\n说明：这里的说明是正文的一部分。')
  assert.equal(result.headerWithoutNote, '原始材料：X\n永久链接：https://x\n\n【开场】正文')
  assert.equal(result.empty, '')
})

test('方案资产校验：必须属于本集、有图、同名不重复、prompt 逐个 @ 选中的资产', () => {
  const result = run(`
    import { validateComposition } from './src/services/poster-concept.ts'
    const assets = [
      { kind: 'scene', id: 1, name: '漕运码头', description: '', path: 'static/a.png', version_task_id: 11, has_image: true },
      { kind: 'character', id: 2, name: '监禄', description: '', path: 'static/b.png', version_task_id: 12, has_image: true },
      { kind: 'prop', id: 3, name: '漕船', description: '', path: '', version_task_id: null, has_image: false },
      { kind: 'prop', id: 4, name: '漕船', description: '', path: 'static/c.png', version_task_id: 13, has_image: true },
    ]
    const base = { id: 'c1', approach: 'x', rationale: '', recommended: true, assets: [], image_prompt: '', text_description: '', copy: { title:'', subtitle:'', era:'', place:'', notes: [] }, layer_plan: [] }
    const missingMention = validateComposition({ ...base, assets: [{ kind: 'scene', id: 1, name: '漕运码头', role_in_poster: '', reason: '' }], image_prompt: '只有码头' }, assets)
    const unknownMention = validateComposition({ ...base, assets: [{ kind: 'scene', id: 1, name: '漕运码头', role_in_poster: '', reason: '' }], image_prompt: '@漕运码头 和 @不存在' }, assets)
    const noImage = validateComposition({ ...base, assets: [{ kind: 'prop', id: 3, name: '漕船', role_in_poster: '', reason: '' }], image_prompt: '@漕船' }, assets)
    const duplicateName = validateComposition({ ...base, assets: [
      { kind: 'prop', id: 4, name: '漕船', role_in_poster: '', reason: '' },
      { kind: 'prop', id: 4, name: '漕船', role_in_poster: '', reason: '' },
    ], image_prompt: '@漕船' }, assets)
    const valid = validateComposition({ ...base, assets: [
      { kind: 'scene', id: 1, name: '漕运码头', role_in_poster: '背景', reason: '节点' },
      { kind: 'character', id: 2, name: '监禄', role_in_poster: '人物', reason: '主角' },
    ], image_prompt: '@漕运码头 上站着 @监禄' }, assets)
    console.log('@@' + JSON.stringify({
      missingMention: missingMention.errors,
      unknownMention: unknownMention.errors,
      noImage: noImage.errors,
      duplicateName: duplicateName.errors,
      valid: valid.composition && valid.composition.assets.map(a => [a.name, a.path, a.version_task_id]),
    }))
  `)
  assert.match(result.missingMention.join('；'), /没有用 @漕运码头/)
  assert.match(result.unknownMention.join('；'), /未选中的资产「@不存在」/)
  assert.match(result.noImage.join('；'), /没有可用图片/)
  assert.match(result.duplicateName.join('；'), /同名资产/)
  assert.deepEqual(result.valid, [['漕运码头', 'static/a.png', 11], ['监禄', 'static/b.png', 12]])
})

test('参考图重排：命名资产在前、人工追加在后；删掉命名资产后 @名字 变成未解析', () => {
  const result = run(`
    import { resolvePosterReferences, unresolvedPosterMentions } from './src/services/posters.ts'
    const named = [
      { kind: 'scene', id: 1, name: '漕运码头', path: 'static/a.png' },
      { kind: 'character', id: 2, name: '监禄', path: 'static/b.png' },
    ]
    const refs = ['static/manual.png', 'static/b.png', 'static/a.png']
    const resolved = resolvePosterReferences(refs, named)
    const unresolved = unresolvedPosterMentions('@监禄 在 @漕运码头', resolved.nameIndex)
    const removed = resolvePosterReferences(['static/manual.png', 'static/a.png'], named)
    console.log('@@' + JSON.stringify({
      references: resolved.references,
      nameIndex: resolved.nameIndex,
      unresolved,
      removedIndex: removed.nameIndex,
      removedUnknown: unresolvedPosterMentions('@监禄 在 @漕运码头', removed.nameIndex),
      punctuation: unresolvedPosterMentions('@灵渠，青灰条石砌成的分水铧嘴；第三格', resolved.nameIndex),
    }))
  `)
  assert.deepEqual(result.references, ['static/a.png', 'static/b.png', 'static/manual.png'])
  assert.deepEqual(result.nameIndex, { 漕运码头: 1, 监禄: 2 })
  assert.deepEqual(result.unresolved, [])
  assert.equal(result.removedIndex['监禄'], undefined)
  assert.deepEqual(result.removedUnknown, ['监禄'])
  assert.deepEqual(result.punctuation, ['灵渠'])
})

test('构想 → 文字层：只产 label/card，固定变量保留，id 用 ai: 前缀', () => {
  const result = run(`
    import { compositionToLayers } from './src/services/poster-concept.ts'
    const composition = {
      id: 'c1', approach: 'x', rationale: '', recommended: true, assets: [],
      image_prompt: '', text_description: '',
      copy: { title: '', subtitle: '', era: '', place: '', notes: [] },
      layer_plan: [
        { type: 'label', name: '标题', box: { x: 0.1, y: 0.1, w: 0.8, h: 0.1 }, text: '漕运', variable: undefined, template: 'name', fields: { title: '', sub: '', meta: '', years: '' }, style: { font: 'kai', size: 0.08, italic: true, shadow: true } },
        { type: 'label', name: '项目名', box: { x: 0.1, y: 0.8, w: 0.8, h: 0.1 }, text: '', variable: 'project_title', template: 'name', fields: { title: '', sub: '', meta: '', years: '' }, style: { font: 'serif' } },
        { type: 'card', name: '年代', box: { x: 0.6, y: 0.7, w: 0.3, h: 0.15 }, text: '', variable: undefined, template: 'year', fields: { title: '1720', sub: '', meta: '', years: '康熙五十九年' }, style: { scale: 1.2 } },
      ],
    }
    const layers = compositionToLayers(composition, { width: 1344, height: 768 })
    console.log('@@' + JSON.stringify(layers.map(l => ({ id: l.id, type: l.type, variable: l.variable, style: l.style, fields: l.fields }))))
  `)
  assert.equal(result.length, 3)
  assert.ok(result.every(layer => layer.id.startsWith('ai:')))
  assert.equal(result[0].style.font, 'kai')
  assert.equal(result[0].style.italic, true)
  assert.equal(result[0].style.shadow, true)
  assert.equal(result[1].variable, 'project_title')
  assert.equal(result[2].type, 'card')
  assert.equal(result[2].style.scale, 1.2)
})

test('provenance 保护：手动字段默认 409，overwrite 才替换；图层规划只替换 ai: 层', () => {
  const result = run(`
    import { db, schema } from './src/db/index.ts'
    import { now } from './src/utils/response.ts'
    import { applyPosterConcept, applyPosterLayerPlan, PosterConflictError } from './src/services/posters.ts'
    import { normalizeLayerDoc } from './src/services/layer-doc.ts'

    const ts = now()
    const drama = await db.insert(schema.dramas).values({ title: '漕运', createdAt: ts, updatedAt: ts }).returning()
    const episode = await db.insert(schema.episodes).values({ dramaId: drama[0].id, episodeNumber: 1, title: '漕运兴衰', createdAt: ts, updatedAt: ts }).returning()
    const composition = {
      id: 'c1', approach: '蒙太奇', rationale: '节点', recommended: true,
      assets: [{ kind: 'scene', id: 1, name: '漕运码头', role_in_poster: '背景', reason: '节点', path: 'static/a.png', version_task_id: 11 }],
      image_prompt: 'AI 画面', text_description: 'AI 文字描述',
      copy: { title: 'AI 标题', subtitle: '', era: '', place: '', notes: [] },
      layer_plan: [
        { type: 'label', name: '标题', box: { x: 0.1, y: 0.1, w: 0.8, h: 0.1 }, text: 'AI 标题', variable: undefined, template: 'name', fields: { title: '', sub: '', meta: '', years: '' }, style: {} },
        { type: 'label', name: '项目名', box: { x: 0.1, y: 0.8, w: 0.8, h: 0.1 }, text: '', variable: 'project_title', template: 'name', fields: { title: '', sub: '', meta: '', years: '' }, style: {} },
      ],
    }
    const concept = { version: 1, theme: '漕运', theme_reason: '', compositions: [composition], selected_composition_id: 'c1', model: 'm', config_id: 1, generated_at: ts, script_segments_used: 1 }
    const manualDoc = normalizeLayerDoc({ base: { path: '', width: 1344, height: 768 }, theme: 'archival', layers: [
      { id: 'ai:old', type: 'label', box: { x: 0.5, y: 0.5, w: 0.3, h: 0.1 }, text: '旧 AI' },
      { id: 'manual-1', type: 'label', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, text: '人工' },
    ] })
    await db.insert(schema.episodePosters).values({
      dramaId: drama[0].id, episodeId: episode[0].id,
      prompt: '人工画面', textPrompt: '人工描述', copy: JSON.stringify({ title: '人工标题', subtitle: '', era: '', place: '', notes: [] }),
      layerDoc: JSON.stringify(manualDoc),
      concept: JSON.stringify(concept),
      provenance: JSON.stringify({ prompt: 'manual', text_prompt: 'manual', copy: 'manual', concept: 'ai', layer_doc: 'manual', layers: { 'ai:old': 'manual', 'manual-1': 'manual' } }),
      createdAt: ts, updatedAt: ts,
    })

    const out = {}
    try { await applyPosterConcept(episode[0].id, { composition_id: 'c1', fields: ['prompt'], overwrite: false }) }
    catch (err) { out.conflict = err instanceof PosterConflictError ? err.fields : String(err) }
    const overwritten = await applyPosterConcept(episode[0].id, { composition_id: 'c1', fields: ['prompt'], overwrite: true })
    out.prompt = overwritten.prompt
    out.promptSource = overwritten.provenance.prompt
    out.textStillManual = overwritten.provenance.text_prompt
    out.conceptPath = overwritten.concept.compositions[0].assets[0].path
    out.refs = overwritten.reference_images

    try { await applyPosterLayerPlan(episode[0].id, { composition_id: 'c1', overwrite: false }) }
    catch (err) { out.layerConflict = err instanceof PosterConflictError ? err.fields : String(err) }
    const applied = await applyPosterLayerPlan(episode[0].id, { composition_id: 'c1', overwrite: true })
    out.layers = applied.layer_doc.layers.map(l => ({ id: l.id, text: l.text, variable: l.variable }))
    out.layerSources = applied.provenance.layers
    const again = await applyPosterLayerPlan(episode[0].id, { composition_id: 'c1', overwrite: true })
    out.repeatCount = again.layer_doc.layers.filter(l => l.id.startsWith('ai:')).length
    console.log('@@' + JSON.stringify(out))
  `)
  assert.deepEqual(result.conflict, ['prompt'])
  assert.equal(result.prompt, 'AI 画面')
  assert.equal(result.promptSource, 'ai')
  assert.equal(result.textStillManual, 'manual')
  assert.equal(result.conceptPath, 'static/a.png')
  assert.deepEqual(result.refs, ['static/a.png'])
  assert.deepEqual(result.layerConflict, ['layer_doc'])
  assert.ok(result.layers.some(layer => layer.id === 'manual-1' && layer.text === '人工'))
  assert.ok(result.layers.some(layer => layer.variable === 'project_title'))
  assert.equal(result.layers.filter(layer => layer.id === 'ai:old').length, 0)
  assert.equal(result.repeatCount, 2)
  assert.equal(result.layerSources['ai:old'], undefined)
  assert.equal(result.layerSources['manual-1'], 'manual')
})
