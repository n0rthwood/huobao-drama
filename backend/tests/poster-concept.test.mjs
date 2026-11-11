/**
 * Poster AI 构想（Issue #72 / #96）：剧本出处块剔除、方案资产/引用校验、模板文本框规划与转换、
 * 参考图重排与 @名字解析，以及 provenance 保护下的方案应用（临时 SQLite）。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

/** `dataDir` 为 true 时给子进程一份独立数据根（`static/` 下有底图文件，版本渲染才会走到排版闸门）。 */
function run(script, options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'poster-concept-'))
  try {
    const env = { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3') }
    if (options.dataDir) {
      mkdirSync(path.join(dir, 'static'), { recursive: true })
      // 只是路径占位：有阻断的文档在解码底图之前就被排版闸门拒绝
      writeFileSync(path.join(dir, 'static', 'base.png'), Buffer.alloc(16))
      env.HUOBAO_DATA_DIR = dir
      delete env.STORAGE_PATH
    }
    const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot,
      encoding: 'utf8',
      env,
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

test('构想 → 文字层：三类模板文本框、id 固定 ai: 前缀、project 绑变量、集号行由服务端写死', () => {
  const result = run(`
    import { compositionToLayers } from './src/services/poster-concept.ts'
    const composition = {
      id: 'c1', approach: 'x', rationale: '', recommended: true, assets: [],
      image_prompt: '', text_description: '',
      copy: { title: '', subtitle: '', era: '', place: '', notes: [] },
      layer_plan: {
        text_layout: 'p-landscape-top',
        items: [
          { role: 'poster_project', fields: { main: '模型写的项目名', sub: '第9集' } },
          { role: 'poster_title', fields: { main: '漕运兴衰' } },
          { role: 'poster_details', fields: { subtitle: '一条河的国运', era: '清康熙年间', place: '山东临清', items: ['条石为基', '青砖包砌', '顶宽五马并行'] } },
          { role: 'heading', fields: { main: '不属于 Poster 的类型' } },
        ],
      },
    }
    const layers = compositionToLayers(composition, { width: 1344, height: 768 }, {
      variables: { project_title: '大运河', episode_title: '漕运兴衰', episode_no: 'EP01' },
      episodeLabel: '第1集 · 漕运兴衰',
    })
    console.log('@@' + JSON.stringify(layers.map(l => ({ id: l.id, type: l.type, role: l.role, fields: l.fields, field_vars: l.field_vars, z: l.z }))))
  `)
  assert.deepEqual(result.map(layer => layer.id), ['ai:poster_project', 'ai:poster_title', 'ai:poster_details'])
  assert.ok(result.every(layer => layer.type === 'text'))
  assert.deepEqual(result[0].field_vars, { main: 'project_title' })
  assert.deepEqual(result[0].fields, { main: '大运河', sub: '第1集 · 漕运兴衰' }, '项目名绑变量、集号行由服务端写死')
  assert.equal(result[1].fields.main, '漕运兴衰')
  assert.deepEqual(result[2].fields.items, ['条石为基', '青砖包砌', '顶宽五马并行'])
})

test('provenance 保护：手动字段默认 409，overwrite 才替换；图层规划只替换 ai: 层并写 text_layout', () => {
  const result = run(`
    import { db, schema } from './src/db/index.ts'
    import { now } from './src/utils/response.ts'
    import { applyPosterConcept, applyPosterLayerPlan, PosterConflictError } from './src/services/posters.ts'
    import { normalizeLayerDoc } from './src/services/layer-doc.ts'

    const ts = now()
    const drama = await db.insert(schema.dramas).values({ title: '漕运', aspectRatio: '16:9', createdAt: ts, updatedAt: ts }).returning()
    const episode = await db.insert(schema.episodes).values({ dramaId: drama[0].id, episodeNumber: 1, title: '漕运兴衰', createdAt: ts, updatedAt: ts }).returning()
    const composition = {
      id: 'c1', approach: '蒙太奇', rationale: '节点', recommended: true,
      assets: [{ kind: 'scene', id: 1, name: '漕运码头', role_in_poster: '背景', reason: '节点', path: 'static/a.png', version_task_id: 11 }],
      image_prompt: 'AI 画面', text_description: 'AI 文字描述',
      copy: { title: 'AI 标题', subtitle: '', era: '', place: '', notes: [] },
      layer_plan: {
        text_layout: 'p-landscape-top',
        items: [
          { role: 'poster_project', fields: { main: '漕运', sub: '第1集' } },
          { role: 'poster_title', fields: { main: 'AI 标题' } },
          { role: 'poster_details', fields: { subtitle: '一条河的国运', era: '清康熙年间', place: '山东临清', items: ['条石为基', '青砖包砌', '顶宽五马并行'] } },
        ],
      },
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
    out.layers = applied.layer_doc.layers.map(l => ({ id: l.id, type: l.type, role: l.role, text: l.text, fields: l.fields, field_vars: l.field_vars }))
    out.textLayout = applied.layer_doc.text_layout
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
  assert.ok(result.layers.some(layer => layer.id === 'manual-1' && layer.text === '人工'), '人工层保留')
  assert.equal(result.textLayout, 'p-landscape-top')
  const project = result.layers.find(layer => layer.id === 'ai:poster_project')
  assert.deepEqual(project.field_vars, { main: 'project_title' })
  assert.deepEqual(project.fields, { main: '漕运', sub: '第1集 · 漕运兴衰' }, '项目名绑变量、集号行由服务端写死')
  assert.deepEqual(
    result.layers.filter(layer => layer.id.startsWith('ai:')).map(layer => layer.id),
    ['ai:poster_project', 'ai:poster_title', 'ai:poster_details'],
    '旧 ai: 层被替换为三类模板文本框',
  )
  assert.equal(result.repeatCount, 3, '重复应用不重复文字')
  assert.equal(result.layerSources['ai:old'], undefined)
  assert.equal(result.layerSources['manual-1'], 'manual')
  assert.equal(result.layerSources['ai:poster_title'], 'ai')
})

test('构想文字图层校验：溢出/缺类型/换套错误连同槽位容量回给模型，合格规划覆盖项目名与集号行', () => {
  const result = run(`
    import { normalizePosterLayerPlan, posterFrameOf, posterTextPrompt } from './src/services/poster-concept.ts'
    const frame = posterFrameOf('16:9')
    const ctx = {
      family: frame.family,
      size: { width: frame.width, height: frame.height },
      variables: { project_title: '大运河', episode_title: '漕运兴衰', episode_no: 'EP01' },
      episodeLabel: '第1集 · 漕运兴衰',
    }
    const project = { role: 'poster_project', fields: { main: '模型写的项目名', sub: '第9集' } }
    const title = { role: 'poster_title', fields: { main: '漕运兴衰' } }
    const details = { role: 'poster_details', fields: { subtitle: '一条河的国运', era: '清康熙年间', place: '山东临清', items: ['条石为基', '青砖包砌', '顶宽五马并行'] } }
    const good = { text_layout: 'p-landscape-top', items: [project, title, details] }
    const ok = normalizePosterLayerPlan(good, ctx)
    const narrowCtx = { ...ctx, family: '9:16', size: posterFrameOf('9:16') }
    const overflow = normalizePosterLayerPlan(
      { text_layout: 'p-vertical-left', items: [project, { role: 'poster_title', fields: { main: '漕运兴衰与京师的粮仓政治' } }, details] },
      narrowCtx,
    )
    const missing = normalizePosterLayerPlan({ text_layout: 'p-landscape-top', items: [project, title] }, ctx)
    const extra = normalizePosterLayerPlan({ text_layout: 'p-landscape-top', items: [...good.items, { role: 'heading', fields: { main: '视频标题' } }] }, ctx)
    const wrongAspect = normalizePosterLayerPlan(good, narrowCtx)
    const videoLayout = normalizePosterLayerPlan({ text_layout: 'v-left-column', items: good.items }, ctx)
    const legacy = normalizePosterLayerPlan([{ type: 'label', name: '标题', box: { x: 0.1, y: 0.1, w: 0.8, h: 0.1 }, text: '旧' }], ctx)
    // 集名很长：集号行由服务端写死，模型改不了，必须自己退到「第N集」而不是把整次构想判死
    const longLabelCtx = { ...narrowCtx, episodeLabel: '第1集 · 漕运兴衰与京师的粮仓政治', episodeLabelShort: '第1集' }
    const longLabel = normalizePosterLayerPlan({ text_layout: 'p-vertical-left', items: [project, title, details] }, longLabelCtx)
    console.log('@@' + JSON.stringify({
      ok: ok.plan,
      okErrors: ok.errors,
      overflow: overflow.errors,
      missing: missing.errors,
      extra: extra.errors,
      wrongAspect: wrongAspect.errors,
      videoLayout: videoLayout.errors,
      legacy: legacy.errors,
      longLabel: { errors: longLabel.errors, project: longLabel.plan && longLabel.plan.items[0].fields },
      prompt: posterTextPrompt(posterFrameOf('9:16')).join('\\n'),
    }))
  `)
  assert.deepEqual(result.okErrors, [])
  assert.deepEqual(result.ok.items[0].fields, { main: '大运河', sub: '第1集 · 漕运兴衰' })
  assert.equal(result.ok.text_layout, 'p-landscape-top')
  assert.match(result.overflow.join('；'), /「海报主标题」的「主标题」放不下/)
  assert.match(result.overflow.join('；'), /poster_title\.main「主标题」基准容量：3 字×2 行/, '纠正提示必须给出该槽位的具体字数')
  assert.match(result.missing.join('；'), /缺少 role「poster_details」/)
  assert.match(result.extra.join('；'), /只允许 poster_project \/ poster_title \/ poster_details/)
  assert.match(result.wrongAspect.join('；'), /属于 16:9 规范，当前项目画幅是 9:16/)
  assert.match(result.videoLayout.join('；'), /图层段（视频）套/)
  assert.match(result.legacy.join('；'), /旧版坐标\/样式格式不再接受/)
  assert.deepEqual(result.longLabel.errors, [], '集号行放不下不是模型的问题，不能判死整次构想')
  assert.deepEqual(result.longLabel.project, { main: '大运河', sub: '第1集' }, '集号行退到规范的「第N集」')
  assert.match(result.prompt, /p-vertical-top/, '提示词列出本画幅的 Poster 套')
  assert.match(result.prompt, /poster_title：main「主标题」6 字×2 行/, '容量来自引擎，不是写死的表')
})

test('旧构想仍可读取；应用旧形状 layer_plan 返回 400 layer_plan_legacy，不迁移', () => {
  const result = run(`
    import app from './src/routes/posters.ts'
    import { db, schema } from './src/db/index.ts'
    import { now } from './src/utils/response.ts'

    const ts = now()
    const drama = await db.insert(schema.dramas).values({ title: '漕运', aspectRatio: '16:9', createdAt: ts, updatedAt: ts }).returning()
    const episode = await db.insert(schema.episodes).values({ dramaId: drama[0].id, episodeNumber: 2, title: '漕运兴衰', createdAt: ts, updatedAt: ts }).returning()
    const legacyComposition = {
      id: 'c1', approach: '蒙太奇', rationale: '', recommended: true, assets: [],
      image_prompt: 'AI 画面', text_description: '',
      copy: { title: 'AI 标题', subtitle: '', era: '', place: '', notes: [] },
      layer_plan: [
        { type: 'label', name: '标题', box: { x: 0.1, y: 0.1, w: 0.8, h: 0.1 }, text: 'AI 标题', template: 'name', fields: { title: '', sub: '', meta: '', years: '' }, style: {} },
        { type: 'card', name: '年代', box: { x: 0.6, y: 0.7, w: 0.3, h: 0.15 }, template: 'year', fields: { title: '1720', sub: '', meta: '', years: '康熙五十九年' } },
      ],
    }
    const concept = { version: 1, theme: '漕运', theme_reason: '', compositions: [legacyComposition], selected_composition_id: 'c1', model: 'm', config_id: 1, generated_at: ts, script_segments_used: 1 }
    await db.insert(schema.episodePosters).values({ dramaId: drama[0].id, episodeId: episode[0].id, concept: JSON.stringify(concept), createdAt: ts, updatedAt: ts })

    const bundleRes = await app.request('/' + episode[0].id + '/poster')
    const bundle = await bundleRes.json()
    const applyRes = await app.request('/' + episode[0].id + '/poster/concept/apply-layer-plan', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ composition_id: 'c1', overwrite: true }),
    })
    console.log('@@' + JSON.stringify({
      bundleStatus: bundleRes.status,
      plan: bundle.data.concept.compositions[0].layer_plan,
      applyStatus: applyRes.status,
      applied: await applyRes.json(),
    }))
  `)
  assert.equal(result.bundleStatus, 200)
  assert.equal(result.plan.length, 2, '旧 layer_plan 原样保留以便继续显示')
  assert.equal(result.plan[0].type, 'label')
  assert.equal(result.plan[1].type, 'card')
  assert.equal(result.applyStatus, 400)
  assert.equal(result.applied.error, 'layer_plan_legacy')
  assert.match(result.applied.message, /请重新生成 Poster 构想/)
})

test('合成版本渲染：模板文本框溢出返回 400 text_layer_invalid 与逐条问题', () => {
  const result = run(`
    import app from './src/routes/posters.ts'
    import { db, schema } from './src/db/index.ts'
    import { now } from './src/utils/response.ts'
    import { normalizeLayerDoc } from './src/services/layer-doc.ts'

    const ts = now()
    const drama = await db.insert(schema.dramas).values({ title: '漕运', aspectRatio: '16:9', createdAt: ts, updatedAt: ts }).returning()
    const episode = await db.insert(schema.episodes).values({ dramaId: drama[0].id, episodeNumber: 3, title: '漕运兴衰', createdAt: ts, updatedAt: ts }).returning()
    const doc = normalizeLayerDoc({
      base: { path: 'static/base.png', width: 1344, height: 768 },
      theme: 'archival',
      text_layout: 'p-landscape-top',
      layers: [
        { id: 'ai:poster_project', type: 'text', role: 'poster_project', fields: { main: '漕运', sub: '第3集 · 漕运兴衰' }, field_vars: { main: 'project_title' } },
        { id: 'ai:poster_title', type: 'text', role: 'poster_title', fields: { main: '漕运兴衰与京师的粮仓政治'.repeat(2) } },
        { id: 'ai:poster_details', type: 'text', role: 'poster_details', fields: { subtitle: '一条河的国运', era: '清康熙年间', place: '山东临清', items: ['条石为基', '青砖包砌', '顶宽五马并行'] } },
      ],
    })
    await db.insert(schema.episodePosters).values({ dramaId: drama[0].id, episodeId: episode[0].id, layerDoc: JSON.stringify(doc), createdAt: ts, updatedAt: ts })
    const res = await app.request('/' + episode[0].id + '/poster/versions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    console.log('@@' + JSON.stringify({ status: res.status, body: await res.json() }))
  `, { dataDir: true })
  assert.equal(result.status, 400)
  assert.equal(result.body.code, 400)
  assert.equal(result.body.error, 'text_layer_invalid')
  assert.match(result.body.message, /不能出成品/)
  assert.ok(Array.isArray(result.body.problems) && result.body.problems.length > 0)
  assert.equal(result.body.problems[0].code, 'text_overflow')
  assert.equal(result.body.problems[0].layer_id, 'ai:poster_title')
  assert.equal(result.body.problems[0].level, 'error')
})

test('再生成的文字说明：模板文本框字段按变量解析，文案重复不再列两次', () => {
  const result = run(`
    import { buildPosterTextInstruction } from './src/services/posters.ts'
    import { normalizeLayerDoc } from './src/services/layer-doc.ts'
    const doc = normalizeLayerDoc({
      base: { path: '', width: 1344, height: 768 },
      theme: 'archival',
      text_layout: 'p-landscape-top',
      layers: [
        { id: 'ai:poster_project', type: 'text', role: 'poster_project', fields: { main: '占位项目名' }, field_vars: { main: 'project_title' } },
        { id: 'ai:poster_title', type: 'text', role: 'poster_title', fields: { main: '漕运兴衰' } },
        { id: 'ai:poster_details', type: 'text', role: 'poster_details', fields: { subtitle: '一条河的国运', era: '清康熙年间', place: '山东临清', items: ['条石为基', '青砖包砌', '顶宽五马并行'] } },
        { id: 'manual-label', type: 'label', box: { x: 0.1, y: 0.1, w: 0.3, h: 0.1 }, text: '', variable: 'episode_no' },
      ],
    })
    console.log('@@' + JSON.stringify({
      instruction: buildPosterTextInstruction(doc, { project_title: '大运河', episode_title: '漕运兴衰', episode_no: 'EP03' }, {
        title: '漕运兴衰', subtitle: '', era: '', place: '', notes: ['顶宽五马并行'],
      }),
    }))
  `)
  const lines = result.instruction.split('\n')
  assert.ok(lines.some(line => line.includes('"大运河"')), '变量绑定的项目名按变量值出说明')
  assert.ok(lines.some(line => line.includes('"EP03"')), '整段文档级变量也解析')
  assert.ok(lines.some(line => line.includes('"条石为基"')))
  assert.equal(lines.filter(line => line.includes('"漕运兴衰"')).length, 1, '文案与图层重复的文字只列一次')
  assert.equal(lines.filter(line => line.includes('"顶宽五马并行"')).length, 1)
})
