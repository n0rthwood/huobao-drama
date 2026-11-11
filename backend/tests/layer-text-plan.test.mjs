/**
 * 模板文本框进设计卡（Issue #96）：
 * - 计划图层 `type:'text'` 的规范化（role 白名单、字段按 layer-doc 口径清洗）与 `text_layout` 白名单；
 * - 设计卡校验把引擎结论映射成 `text_plan_invalid`（阻断）/ `text_plan_warning`（警告），画幅换家族即换容量；
 * - AI 写入路径的硬规则：card、无锚点 label、缺成套位置、溢出（拒信带引擎算出的逐字段容量）；
 * - 草稿：text 计划 → text 图层 + 文档 `text_layout` + 按 at_s 显现的关键帧；旧卡保持原转换；
 * - 衔接帧去字：text 图层整层隐藏；
 * - 成片闸门：阻断级文本问题在任何像素工作之前失败，不落任何产物；
 * - 段一致性检查把文本问题挂成 `text_layer_invalid`；
 * - `text_spec` 上下文的数字全部来自引擎（不允许另抄一份）。
 * 纯函数与渲染用仓库自带 tsx 子进程跑，并以 JSON 回传；需要落库的用例用临时 SQLITE_PATH。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
const dataRoot = mkdtempSync(path.join(tmpdir(), 'layer-text-plan-'))

function run(body) {
  const script = `
    import fs from 'fs'
    import path from 'path'
    import { normalizeDesignCard, validateDesignCard, aiTextPlanRejections, textPlanRejectionMessage, textPlanDoc, textPlanBeats, textPlanProblems } from './src/services/design-card.ts'
    import { layerTextSpecPayload, loadDesignCardContext } from './src/services/design-card-context.ts'
    import { draftSegment } from './src/services/layer-segment-draft.ts'
    import { segmentIssuesOf } from './src/services/segment-issues.ts'
    import { withoutText, renderLayerSegment } from './src/services/layer-segment-render.ts'
    import { TextLayerError, textCapacity } from './src/services/layer-text.ts'
    import { normalizeLayerDoc } from './src/services/layer-doc.ts'
    import { db, schema } from './src/db/index.ts'
    const out = (value) => console.log('@@' + JSON.stringify(value))
    ${body}
  `
  const text = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      SQLITE_PATH: path.join(dataRoot, 'db.sqlite3'),
      HUOBAO_DATA_DIR: dataRoot,
      STORAGE_PATH: path.join(dataRoot, 'static'),
    },
  })
  return JSON.parse(text.slice(text.lastIndexOf('@@') + 2))
}

/** 卡片骨架：只关心图层段，其余字段填最小值（JSON 是合法的 JS 表达式，直接嵌进子进程脚本） */
function cardBody(layerPlan) {
  return JSON.stringify({
    version: 2,
    info_points: [],
    budget: { layer_s: 8, gen_s: null },
    rationale: '测试用',
    suggested_combo: 'A',
    layer_plan: layerPlan,
  })
}

test('计划 text 图层规范化：role 白名单、字段按 layer-doc 口径清洗', () => {
  const raw = cardBody({
    base: { kind: 'inherit_prev' },
    planned_layers: [
      { type: 'text', role: 'heading', at_s: 1.234, fields: { main: '  轮船招商局创办  ', sub: ' 同治十一年 ', bogus: 'x' } },
      { type: 'marker', at_s: 2 },
      { type: 'text', role: 'no-such-role', at_s: 3, fields: { main: 'x' } },
      { type: 'text', role: 'poster_title', at_s: 4, fields: { main: '片名' } },
      { type: 'text', role: 'bullets', at_s: 5, fields: { items: ['条石为基', '  ', '青砖包砌'] } },
      { type: 'label', at_s: 6, text: '拉萨', anchor: { asset_id: 39, semantic_id: 'lb-1' } },
    ],
  })
  const result = run(`
    const card = normalizeDesignCard(${raw})
    out({ layers: card.layer_plan.planned_layers })
  `)
  const layers = result.layers
  // 按 at_s 排序；未知 role 的 text 层整层丢弃；Poster 专用 role 保留（由引擎报「只能用于 Poster」）
  assert.deepEqual(layers.map(layer => layer.type), ['text', 'marker', 'text', 'text', 'label'])
  assert.equal(layers[0].role, 'heading')
  assert.deepEqual(layers[0].fields, { main: '轮船招商局创办', sub: '同治十一年' })
  assert.equal(layers[0].at_s, 1.23)
  assert.equal(layers[2].role, 'poster_title')
  assert.deepEqual(layers[3].fields, { items: ['条石为基', '青砖包砌'] })
  // 非 text 类型仍走原来的 text/anchor 规范化
  assert.equal(layers[4].text, '拉萨')
  assert.equal(layers[4].anchor.semantic_id, 'lb-1')
})

test('text_layout 只认规范里的视频版式', () => {
  const cards = ['h-left-stack', 'v-right-ledger', 'p-landscape-bottom', 'nope']
    .map(layout => cardBody({ base: { kind: 'inherit_prev' }, planned_layers: [], text_layout: layout }))
  const result = run(`
    const layouts = [${cards.join(', ')}].map(raw => normalizeDesignCard(raw).layer_plan.text_layout ?? null)
    out({ layouts })
  `)
  assert.deepEqual(result.layouts, ['h-left-stack', 'v-right-ledger', null, null])
})

test('设计卡校验把引擎结论映射成阻断 / 警告，画幅决定容量', () => {
  const card = (role, main, layout = 'h-left-stack') => cardBody({
    base: { kind: 'inherit_prev' },
    text_layout: layout,
    planned_layers: [{ type: 'text', role, at_s: 1, fields: { main } }],
  })
  const payload = [
    card('heading', '轮'.repeat(26)),
    card('heading', '轮'.repeat(27)),
    card('heading', '轮'.repeat(40)),
    card('keyword', '轮船招商局'),
    card('heading', '漕运'),
    card('keyword', '轮船招商局创办', 'v-left-column'),
    card('heading', '轮船招商局创办', 'v-left-column'),
  ]
  const result = run(`
    const codes = (raw, aspect) => validateDesignCard({
      card: normalizeDesignCard(raw), combo: 'A', narrationText: '旁白', aspect,
    }).filter(issue => issue.code.startsWith('text_')).map(issue => ({ code: issue.code, severity: issue.severity }))
    const cards = [${payload.join(', ')}]
    const docOf = (raw) => textPlanDoc(normalizeDesignCard(raw))
    out({
      fits: codes(cards[0], '16:9'),
      scaled: codes(cards[1], '16:9'),
      overflow: codes(cards[2], '16:9'),
      // keyword 横版每行 10 字、竖版每行 4 字（缩到下限 5 字）：同一段文字换画幅就从放得下变成溢出
      keywordLandscape: codes(cards[3], '16:9'),
      keywordPortrait: codes(cards[5], '9:16'),
      // 同一张竖版卡换成横版画幅校验：套位与画幅不符 → 阻断。所以门禁必须传项目的真实画幅，
      // 猜一个横版会把竖屏镜判成不可制作（#96 的 workflow-gates 修复）
      portraitCardAsLandscape: codes(cards[6], '16:9'),
      portraitCardAsPortrait: codes(cards[6], '9:16'),
      beats: textPlanBeats(normalizeDesignCard(cards[4])),
      doc: docOf(cards[4]).layers.map(layer => ({ id: layer.id, role: layer.role })),
    })
  `)
  assert.deepEqual(result.fits, [])
  assert.deepEqual(result.scaled, [{ code: 'text_plan_warning', severity: 'warn' }])
  assert.deepEqual(result.overflow, [{ code: 'text_plan_invalid', severity: 'block' }])
  assert.deepEqual(result.keywordLandscape, [])
  assert.deepEqual(result.keywordPortrait, [{ code: 'text_plan_invalid', severity: 'block' }])
  assert.deepEqual(result.portraitCardAsLandscape, [{ code: 'text_plan_invalid', severity: 'block' }])
  assert.deepEqual(result.portraitCardAsPortrait, [])
  assert.deepEqual(result.beats, [[], ['text-1']])
  assert.deepEqual(result.doc, [{ id: 'text-1', role: 'heading' }])
})

test('同 zone 后出现的框替换先出现的：不同时出现就不冲突，同 at_s 才是冲突', () => {
  const card = (layers) => cardBody({
    base: { kind: 'inherit_prev' },
    text_layout: 'h-left-stack',
    planned_layers: layers,
  })
  const sequential = card([
    { type: 'text', role: 'date', at_s: 0.5, fields: { main: '1872年' } },
    { type: 'text', role: 'heading', at_s: 2, fields: { main: '轮船招商局创办' } },
    { type: 'text', role: 'statement', at_s: 4, fields: { main: '这是中国第一家现代航运企业' } },
  ])
  const simultaneous = card([
    { type: 'text', role: 'heading', at_s: 2, fields: { main: '轮船招商局创办' } },
    { type: 'text', role: 'statement', at_s: 2, fields: { main: '这是中国第一家现代航运企业' } },
  ])
  const result = run(`
    ${DRAFT_CTX}
    const codesOf = (raw) => validateDesignCard({
      card: normalizeDesignCard(raw), combo: 'A', narrationText: '旁白', aspect: '16:9',
    }).filter(issue => issue.code.startsWith('text_')).map(issue => ({ code: issue.code, message: issue.message }))
    const sequential = normalizeDesignCard(${sequential})
    const simultaneous = normalizeDesignCard(${simultaneous})
    const draft = draftSegment(sequential, 'A', ctx)
    out({
      // 主叙事线：同一拍只有一个 primary 框，所以 heading@2 + statement@4 不冲突
      sequential: codesOf(${sequential}),
      sequentialBeats: textPlanBeats(sequential),
      sequentialFrames: draft.timeline.keyframes.map(frame => ({ t: frame.t, visible: frame.visible })),
      // 同 at_s 是同一次出现：同区两个框同时可见 → 阻断
      simultaneous: codesOf(${simultaneous}),
      simultaneousAi: aiTextPlanRejections(simultaneous, '16:9').map(item => item.code),
      simultaneousBeats: textPlanBeats(simultaneous),
    })
  `)
  assert.deepEqual(result.sequential, [])
  // date 在 context 区，跨拍持续；heading 被 statement 替换
  assert.deepEqual(result.sequentialBeats, [[], ['text-1'], ['text-1', 'text-2'], ['text-1', 'text-3']])
  // 草稿关键帧与校验逐拍一致：L2(heading) 在 4s 被同区 L3(statement) 顶掉
  assert.deepEqual(result.sequentialFrames, [
    { t: 0, visible: [] },
    { t: 0.5, visible: ['L1'] },
    { t: 2, visible: ['L1', 'L2'] },
    { t: 4, visible: ['L1', 'L3'] },
    { t: 8, visible: ['L1', 'L3'] },
  ])
  // 同 at_s 同 zone：引擎报冲突，AI 路径直接拒绝（不许靠「后到的赢」掩盖）
  assert.deepEqual(result.simultaneous.map(item => item.code), ['text_plan_invalid'])
  assert.match(result.simultaneous[0].message, /同一位置区/)
  assert.deepEqual(result.simultaneousAi, ['text_plan_invalid'])
  assert.deepEqual(result.simultaneousBeats, [[], ['text-1'], ['text-1', 'text-2']])
})

test('AI 写入路径硬规则：card / 无锚点 label / 缺成套位置 / 溢出带容量数字', () => {
  const legacy = cardBody({
    base: { kind: 'inherit_prev' },
    planned_layers: [
      { type: 'card', at_s: 1, text: '第二章 永徽年间' },
      { type: 'label', at_s: 2, text: '序章' },
      { type: 'label', at_s: 3, text: '拉萨', anchor: { asset_id: 39, semantic_id: 'lb-1' } },
    ],
  })
  const noLayout = cardBody({
    base: { kind: 'inherit_prev' },
    planned_layers: [{ type: 'text', role: 'heading', at_s: 1, fields: { main: '漕运' } }],
  })
  const overflow = cardBody({
    base: { kind: 'inherit_prev' },
    text_layout: 'h-left-stack',
    planned_layers: [{ type: 'text', role: 'heading', at_s: 1, fields: { main: '轮'.repeat(40) } }],
  })
  const blankRole = cardBody({
    base: { kind: 'inherit_prev' },
    planned_layers: [{ type: 'text', at_s: 1, fields: { main: '漕运' } }],
  })
  const unknownRole = cardBody({
    base: { kind: 'inherit_prev' },
    planned_layers: [{ type: 'text', role: 'title', at_s: 1, fields: { main: '漕运' } }],
  })
  const result = run(`
    const codesOf = (raw) => aiTextPlanRejections(normalizeDesignCard(raw), '16:9').map(item => item.code)
    // 没有 role / role 不在规范里的 text 层在规范化时会被整层丢弃：规则必须按模型原文判，不能静默丢文字
    const rawCodesOf = (raw) => aiTextPlanRejections(
      normalizeDesignCard(raw), '16:9', raw.layer_plan.planned_layers,
    ).map(item => ({ code: item.code, message: item.message }))
    const rejections = aiTextPlanRejections(normalizeDesignCard(${overflow}), '16:9')
    out({
      legacy: codesOf(${legacy}),
      noLayout: codesOf(${noLayout}),
      overflow: {
        codes: rejections.map(item => item.code),
        message: textPlanRejectionMessage(rejections),
        capacity: textCapacity('h-left-stack', 'heading'),
      },
      blankRole: rawCodesOf(${blankRole}),
      unknownRole: rawCodesOf(${unknownRole}),
    })
  `)
  // card 与无锚点 label 各自被拒；带 anchor 的 label 不触发这两条规则
  assert.deepEqual(result.legacy, ['card_layer_rejected', 'label_unanchored'])
  // 缺套只报一次：引擎的同一条错误不会挂成两个码
  assert.deepEqual(result.noLayout, ['text_layout_missing'])
  assert.deepEqual(result.overflow.codes, ['text_plan_invalid'])
  // 拒信里的数字必须与引擎容量一致，模型才知道该改多短
  const main = result.overflow.capacity.find(item => item.field === 'main')
  assert.ok(result.overflow.message.includes(`每行 ${main.chars_per_line} 字 × ${main.max_lines} 行 = 最多 ${main.max_chars} 字`))
  assert.ok(result.overflow.message.includes('改短 → 拆成多拍'))
  // 缺 role / 未知 role 都会被退回，并列出规范允许的类型
  assert.deepEqual(result.blankRole.map(item => item.code), ['text_role_invalid'])
  assert.ok(result.blankRole[0].message.includes('没有写 role'))
  assert.deepEqual(result.unknownRole.map(item => item.code), ['text_role_invalid'])
  assert.ok(result.unknownRole[0].message.includes('heading'))
})

/** 一张 2000×1000 的地图道具（与图层段草稿测试同构） */
const DRAFT_CTX = `
  const mapAsset = {
    kind: 'prop', id: 39, name: '三方局势图',
    image_path: 'static/uploads/map.png',
    image_width: 2000, image_height: 1000,
    semantics: {
      image: { width: 2000, height: 1000, source_task_id: 501 },
      regions: [], lines: [], points: [],
      labels: [{ id: 'lb-1', text: '拉萨', bbox: [120, 640, 260, 700] }],
    },
  }
  const ctx = {
    assets: [mapAsset], base: mapAsset, base_path: mapAsset.image_path,
    base_ref: { kind: 'asset', asset_kind: 'prop', asset_id: 39, version_task_id: null },
    duration: 15, width: 960, height: 544,
  }
`

test('草稿：text 计划落成 text 图层 + 文档 text_layout + 按 at_s 显现的关键帧', () => {
  const result = run(`
    ${DRAFT_CTX}
    const card = normalizeDesignCard(${cardBody({
    base: { kind: 'asset', asset_kind: 'prop', asset_id: 39 },
    text_layout: 'h-left-stack',
    planned_layers: [
      { type: 'text', role: 'date', at_s: 0.5, fields: { main: '1872年' } },
      { type: 'text', role: 'heading', at_s: 2, fields: { main: '轮船招商局创办' } },
      { type: 'label', at_s: 3, text: '没有锚点的旧式标签' },
      { type: 'label', at_s: 4, text: '拉萨', anchor: { asset_id: 39, semantic_id: 'lb-1' } },
    ],
  })})
    const draft = draftSegment(card, 'A', ctx)
    out({
      text_layout: draft.layer_doc.text_layout ?? null,
      layers: draft.layer_doc.layers.map(layer => ({
        id: layer.id, type: layer.type, name: layer.name,
        role: layer.role ?? null, fields: layer.fields ?? null, at: layer.type === 'text' ? 'screen' : 'image',
      })),
      beats: draft.timeline.keyframes.map(frame => frame.visible),
      warnings: draft.warnings,
    })
  `)
  assert.equal(result.text_layout, 'h-left-stack')
  // text 层的 id 稳定（L{计划序号}）、name = 类型名，且没有 box / anchor（屏幕坐标由规范决定）
  assert.deepEqual(result.layers[0], { id: 'L1', type: 'text', name: '时间锚', role: 'date', fields: { main: '1872年' }, at: 'screen' })
  assert.deepEqual(result.layers[1], { id: 'L2', type: 'text', name: '主题标题', role: 'heading', fields: { main: '轮船招商局创办' }, at: 'screen' })
  // 新版设计不再生成没有锚点的 label；带锚点的 label 照旧转换
  assert.equal(result.layers[2].id, 'L4')
  assert.equal(result.layers[2].type, 'label')
  assert.equal(result.layers.length, 3)
  assert.ok(result.warnings.some(item => item.includes('模板文本框')))
  // 可见关键帧：按 at_s 递增逐层显现（含 t=0 的空拍）
  assert.deepEqual(result.beats, [[], ['L1'], ['L1', 'L2'], ['L1', 'L2', 'L4'], ['L1', 'L2', 'L4'], ['L1', 'L2', 'L4']])
})

test('旧卡没有 text 计划时保持原来的 label / card 转换', () => {
  const result = run(`
    ${DRAFT_CTX}
    const card = normalizeDesignCard(${cardBody({
    base: { kind: 'asset', asset_kind: 'prop', asset_id: 39 },
    planned_layers: [
      { type: 'label', at_s: 0, text: '序章' },
      { type: 'card', at_s: 1, text: '第二章 永徽年间' },
    ],
  })})
    const draft = draftSegment(card, 'A', ctx)
    out({
      text_layout: draft.layer_doc.text_layout ?? null,
      layers: draft.layer_doc.layers.map(layer => ({ id: layer.id, type: layer.type })),
      warnings: draft.warnings,
    })
  `)
  assert.equal(result.text_layout, null)
  assert.deepEqual(result.layers, [{ id: 'L1', type: 'label' }, { id: 'L2', type: 'card' }])
  assert.deepEqual(result.warnings, [])
})

test('衔接帧去字：text 图层整层隐藏', () => {
  const result = run(`
    const doc = normalizeLayerDoc({
      version: 1, text_layout: 'h-left-stack',
      base: { path: 'static/x.png', width: 960, height: 544 },
      layers: [
        { id: 'L1', type: 'text', role: 'heading', fields: { main: '漕运' } },
        { id: 'L2', type: 'label', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, text: '拉萨' },
        { id: 'L3', type: 'marker', at: [0.5, 0.5], text: '地点' },
        { id: 'L4', type: 'polygon', points: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]] },
      ],
    })
    out({ layers: withoutText(doc).layers.map(layer => ({ id: layer.id, text: layer.text ?? null })) })
  `)
  assert.deepEqual(result.layers, [{ id: 'L3', text: '' }, { id: 'L4', text: null }])
})

test('成片闸门：阻断级文本问题在任何像素工作之前失败，不落产物', () => {
  const result = run(`
    import sharp from 'sharp'
    const root = process.env.HUOBAO_DATA_DIR
    fs.mkdirSync(path.join(root, 'static'), { recursive: true })
    await sharp({ create: { width: 960, height: 544, channels: 3, background: '#808080' } })
      .png().toFile(path.join(root, 'static', 'base.png'))
    const doc = normalizeLayerDoc({
      version: 1, text_layout: 'h-left-stack',
      base: { path: 'static/base.png', width: 960, height: 544 },
      layers: [{ id: 'L1', type: 'text', role: 'heading', fields: { main: '轮'.repeat(40) } }],
    })
    const timeline = {
      fps: 25, ease: 'inout', fade_ms: 400,
      keyframes: [
        { t: 0, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: [] },
        { t: 1, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: ['L1'] },
        { t: 3, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: ['L1'] },
      ],
    }
    let caught = null
    try {
      await renderLayerSegment({ id: 7, layer_doc: doc, timeline, duration: 3 }, { width: 960, height: 544, fps: 25, source: 'default' }, null)
    } catch (err) {
      caught = { type: err instanceof TextLayerError, message: err.message }
    }
    out({
      caught,
      outputs: fs.existsSync(path.join(root, 'static', 'layer-segments')),
      junction: fs.existsSync(path.join(root, 'static', 'layer-frames')),
    })
  `)
  assert.equal(result.caught.type, true)
  assert.ok(result.caught.message.includes('模板文本框'))
  assert.equal(result.outputs, false)
  assert.equal(result.junction, false)
})

test('段一致性检查：文本问题挂成 text_layer_invalid（阻断级）', () => {
  const result = run(`
    const doc = normalizeLayerDoc({
      version: 1, text_layout: 'h-left-stack',
      base: { path: 'static/x.png', width: 960, height: 544 },
      layers: [
        { id: 'L1', type: 'text', role: 'heading', fields: { main: '轮'.repeat(40) } },
        { id: 'L2', type: 'label', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, text: '拉萨' },
      ],
    })
    const segment = {
      id: 1, layer_doc: doc, duration: 5,
      timeline: { fps: 25, ease: 'inout', fade_ms: 400, keyframes: [
        { t: 0, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: [] },
        { t: 1, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: ['L1', 'L2'] },
      ] },
    }
    const card = {
      version: 2, info_points: [], budget: { layer_s: 5, gen_s: null },
      layer_plan: { base: { kind: 'inherit_prev' }, must_mark: [], planned_layers: [] },
      rationale: '', suggested_combo: 'A', issues: [],
    }
    // 设计卡缺底图时也要照常报文本框问题（它只取决于已存的段文档）
    const noBaseCard = { ...card, layer_plan: { must_mark: [], planned_layers: [], base: null } }
    out({
      issues: segmentIssuesOf({ card, combo: 'A', segment, storyboardPrompts: { first: '', mid: '', last: '', video: '' } }),
      noBase: segmentIssuesOf({ card: noBaseCard, combo: 'A', segment, storyboardPrompts: { first: '', mid: '', last: '', video: '' } })
        .map(issue => issue.code),
    })
  `)
  const textIssues = result.issues.filter(issue => issue.code.startsWith('text_'))
  assert.equal(textIssues.length, 1)
  assert.equal(textIssues[0].code, 'text_layer_invalid')
  assert.equal(textIssues[0].severity, 'block')
  // 文本框在规范安全区内，不参与字幕安全区判定
  assert.equal(result.issues.some(issue => issue.code === 'card_subtitle_overlap'), false)
  assert.deepEqual(result.noBase, ['text_layer_invalid', 'missing_base'])
})

test('text_spec 上下文：版式、类型字段与逐字段容量都来自引擎；上下文带项目画幅', () => {
  const result = run(`
    await db.insert(schema.dramas).values({ title: '竖屏纪录片', aspectRatio: '9:16', createdAt: 'x', updatedAt: 'x' })
    const [drama] = await db.select().from(schema.dramas)
    await db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 1, title: 'EP1', createdAt: 'x', updatedAt: 'x' })
    const [episode] = await db.select().from(schema.episodes)
    const portrait = layerTextSpecPayload('9:16')
    const landscape = layerTextSpecPayload('16:9')
    out({
      aspect: loadDesignCardContext(episode.id).aspect,
      portraitLayouts: portrait.layouts.map(layout => layout.id),
      landscapeLayouts: landscape.layouts.map(layout => layout.id),
      slots: portrait.layouts[0].slots.map(slot => ({ role: slot.role, zone: slot.zone })),
      roles: portrait.roles.map(role => role.id),
      bullets: portrait.roles.find(role => role.id === 'bullets').fields,
      posterOnly: portrait.roles.some(role => role.id === 'poster_title'),
      headingCapacity: portrait.capacity['v-left-column'].heading,
      engine: textCapacity('v-left-column', 'heading'),
    })
  `)
  assert.equal(result.aspect, '9:16')
  assert.equal(result.portraitLayouts.length, 4)
  assert.equal(result.landscapeLayouts.length, 4)
  assert.deepEqual(result.portraitLayouts, ['v-left-column', 'v-right-ledger', 'v-center-top', 'v-left-low'])
  assert.deepEqual(result.slots, [
    { role: 'date', zone: 'context' },
    { role: 'heading', zone: 'primary' },
    { role: 'statement', zone: 'primary' },
    { role: 'quote', zone: 'primary' },
    { role: 'metric', zone: 'primary' },
    { role: 'bullets', zone: 'primary' },
    { role: 'keyword', zone: 'emphasis' },
  ])
  assert.deepEqual(result.roles, ['date', 'heading', 'statement', 'keyword', 'quote', 'metric', 'bullets'])
  assert.deepEqual(result.bullets, [{ key: 'items', label: '要点', optional: false, kind: 'list' }])
  assert.equal(result.posterOnly, false)
  // 容量逐数值等于引擎输出（技能与提示词里不许另抄一份数字）
  assert.deepEqual(result.headingCapacity, result.engine)
})

/** 规范 JSON 里没有写死的容量表：技能文本只引用 text_spec，不复制数字 */
test('技能文本不复制容量数字，只指向 text_spec', () => {
  const skill = readFileSync(path.join(backendRoot, 'workspace/skills/documentary/layer-text-design/SKILL.md'), 'utf8')
  const storyboard = readFileSync(path.join(backendRoot, 'workspace/skills/documentary/documentary-storyboard/SKILL.md'), 'utf8')
  for (const text of [skill, storyboard]) {
    assert.ok(text.includes('text_spec'))
    assert.ok(!/\d+\s*字\s*[×x]\s*\d+\s*行/.test(text), '技能里不许出现「N 字 × M 行」这种容量表式写法')
  }
  assert.ok(skill.includes('layer_plan.text_layout'))
  assert.ok(skill.includes('capacity'))
})
