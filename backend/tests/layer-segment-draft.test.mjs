/**
 * 图层段草稿（Issue #58，原 clip-draft.test.mjs）：
 * - `design_card.layer_plan → LayerDoc + timeline(keyframes)` 转换（语义原图像素 → 归一化、at_s → 精确关键帧、推近、末帧落在段尾）；
 * - 转换结果必须经得起 #48 `normalizeLayerDoc` 的白名单（样式键写错会被静默丢弃）；
 * - 卡片字段契约 `{title, sub, meta, years}`、默认 box `y=0.56`、底图只认 `layer_plan.base`（无回退）；
 * - 渲染签名纯函数 `seg-v1`：图层/时间线/时长/画幅/底图字节任一变化即换签名，与位置无关；
 * - compose 快照 v3：无段的镜头保持 v2 摘要（存量项目不被整集判已变化）。
 * 纯函数，用仓库自带 tsx 子进程跑并以 JSON 回传。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(body, env = {}) {
  const script = `
    import { draftSegment, LAYER_SEGMENT_PRE_POST_DEFAULT_SECONDS, CARD_DEFAULT_BOX } from './src/services/layer-segment-draft.ts'
    import { segmentIssuesOf } from './src/services/segment-issues.ts'
    import { normalizeLayerDoc } from './src/services/layer-doc.ts'
    import { layerSegmentSignatureOf } from './src/services/layer-segment.ts'
    import { composeSignatureOf, composeSignatureVersionOf, describeComposeDiff, COMPOSE_SIGNATURE_VERSION } from './src/services/compose-state.ts'
    const out = (value) => console.log('@@' + JSON.stringify(value))
    ${body}
  `
  const text = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return JSON.parse(text.slice(text.lastIndexOf('@@') + 2))
}

/** 一张 2000×1000 的地图道具：区域 / 河线 / 地名点 / 标签各一，坐标是原图像素 */
const MAP_ASSET = `
  const mapAsset = {
    kind: 'prop', id: 39, name: '三方局势图',
    image_path: 'static/uploads/map.png',
    image_width: 2000, image_height: 1000,
    semantics: {
      image: { width: 2000, height: 1000, source_task_id: 501 },
      regions: [{ id: 'rg-1', name: '准噶尔汗国', points: [[400, 300], [900, 280], [1000, 500], [500, 550]], source: 'cv', confidence: 0.8 }],
      lines: [{ id: 'ln-1', name: '额尔齐斯河', kind: 'river', color: '#2b6cb0', points: [[600, 700], [800, 600], [1040, 500]], source: 'cv', confidence: 0.9 }],
      points: [{ id: 'pt-1', name: '斋桑湖', at: [1100, 480], source: 'vlm', confidence: 0.7 }],
      labels: [{ id: 'lb-1', text: '拉萨', bbox: [120, 640, 260, 700], source: 'vlm', confidence: 0.8 }],
    },
  }
  const character = { kind: 'character', id: 25, name: '利哈列夫', image_path: 'static/images/portrait.png', semantics: null }
  const baseRefOf = asset => ({ kind: 'asset', asset_kind: asset.kind, asset_id: asset.id, version_task_id: null })
  const ctx = {
    assets: [mapAsset, character], base: mapAsset, base_path: mapAsset.image_path,
    base_ref: baseRefOf(mapAsset), duration: 15, width: 960, height: 544,
  }
`

const MAP_CARD = `
  const card = {
    version: 2,
    info_points: [{ id: 'ip1', text: '清军两路进藏', via: 'layer' }],
    budget: { layer_s: 15, gen_s: null },
    layer_plan: {
      base: { kind: 'asset', asset_kind: 'prop', asset_id: 39, version_task_id: null },
      must_mark: [{ asset_id: 39, semantic_id: 'rg-1', name: '准噶尔汗国' }],
      planned_layers: [
        { type: 'polygon', anchor: { asset_id: 39, semantic_id: 'rg-1', name: '准噶尔汗国' }, at_s: 3 },
        { type: 'polyline', anchor: { asset_id: 39, semantic_id: 'ln-1', name: '额尔齐斯河' }, at_s: 6 },
        { type: 'marker', anchor: { asset_id: 39, semantic_id: 'pt-1', name: '斋桑湖' }, at_s: 9 },
        { type: 'label', anchor: { asset_id: 39, semantic_id: 'lb-1', name: '拉萨' }, at_s: 11 },
      ],
    },
    rationale: '', suggested_combo: 'A', issues: [],
  }
`

test('组合 A 草稿：底图由调用方解析（设计卡 base），语义像素按原图尺寸归一化，at_s 变成精确关键帧', () => {
  const got = run(`${MAP_ASSET}${MAP_CARD}
    const draft = draftSegment(card, 'A', ctx)
    out({
      duration: draft.duration,
      base: draft.layer_doc.base,
      types: draft.layer_doc.layers.map(l => l.type),
      polygon: draft.layer_doc.layers[0].points,
      marker: draft.layer_doc.layers[2].at,
      labelText: draft.layer_doc.layers[3].text,
      times: draft.timeline.keyframes.map(k => k.t),
      visible: draft.timeline.keyframes.map(k => k.visible.length),
      lastViewport: draft.timeline.keyframes[draft.timeline.keyframes.length - 1].viewport,
      warnings: draft.warnings,
      legacyStates: 'states' in draft.timeline,
    })
  `)
  assert.equal(got.duration, 15, '组合 A 没有预算时至少覆盖本镜时长')
  assert.equal(got.base.path, 'static/uploads/map.png', '底图是设计卡 base 解析出来的图')
  assert.deepEqual([got.base.width, got.base.height], [960, 544], 'base 尺寸 = 成片画幅')
  assert.deepEqual(got.types, ['polygon', 'polyline', 'marker', 'label'])
  // 2000×1000 原图像素 → 归一化：[400,300] → [0.2,0.3]
  assert.deepEqual(got.polygon[0], [0.2, 0.3])
  assert.deepEqual(got.marker, [0.55, 0.48])
  assert.equal(got.labelText, '拉萨', 'label 文字取自语义条目的 text')
  assert.deepEqual(got.times, [0, 3, 6, 9, 11, 12, 15], '0 s 干净底图 + 四个 reveal + 推近 + 末帧落在段尾 15 s')
  assert.deepEqual(got.visible, [0, 1, 2, 3, 4, 4, 4], '每个精确关键帧累积一层')
  assert.equal(got.lastViewport.w, got.lastViewport.h)
  assert.deepEqual(got.warnings, [])
  assert.equal(got.legacyStates, false, '输出只有 keyframes')
})

test('末帧必须正好落在段尾（C 的衔接帧取 t=duration 才有「末尾停留的最终画面」）', () => {
  const got = run(`${MAP_ASSET}${MAP_CARD}
    const draft = draftSegment(card, 'C', { ...ctx, duration: 6 })
    const times = draft.timeline.keyframes.map(k => k.t)
    out({ duration: draft.duration, times, last: times[times.length - 1] })
  `)
  assert.equal(got.duration, 15, '设计卡预算 15s 优先于本镜时长')
  assert.equal(got.last, 15, '末个精确关键帧 t === duration')
})

test('草稿必须经得起 #48 白名单：polyline 箭头与河线颜色不能被静默丢弃', () => {
  const got = run(`${MAP_ASSET}${MAP_CARD}
    const draft = draftSegment(card, 'A', ctx)
    const normalized = normalizeLayerDoc(draft.layer_doc)
    out({
      polylineStyle: normalized.layers.find(l => l.type === 'polyline').style,
      ids: normalized.layers.map(l => l.id),
      anchors: normalized.layers.map(l => l.anchor || null),
    })
  `)
  assert.equal(got.polylineStyle.arrow_end, true, '键名必须是 arrow_end（写成 arrow 会被丢弃）')
  assert.equal(got.polylineStyle.stroke, '#2b6cb0', '河线颜色键名必须是 stroke')
  assert.deepEqual(got.ids, ['L1', 'L2', 'L3', 'L4'])
  assert.equal(got.anchors[0].asset_id, 39)
  assert.equal(got.anchors[0].semantic_id, 'rg-1', '锚点保留语义 id，便于语义改动后重算')
})

test('锚点解析不到几何：不伪造坐标，整层跳过并留下警告', () => {
  const got = run(`${MAP_ASSET}
    const card = {
      version: 2, info_points: [], budget: { layer_s: 15, gen_s: null },
      layer_plan: {
        base: { kind: 'asset', asset_kind: 'prop', asset_id: 39, version_task_id: null },
        must_mark: [],
        planned_layers: [
          { type: 'polygon', anchor: { asset_id: 39, semantic_id: 'rg-不存在', name: '' }, at_s: 2 },
          { type: 'marker', anchor: { asset_id: 39, semantic_id: 'pt-1', name: '斋桑湖' }, at_s: 4 },
        ],
      },
      rationale: '', suggested_combo: 'A', issues: [],
    }
    const draft = draftSegment(card, 'A', ctx)
    out({ types: draft.layer_doc.layers.map(l => l.type), warnings: draft.warnings })
  `)
  assert.deepEqual(got.types, ['marker'], '缺几何的那层被跳过，不是画成空多边形')
  assert.equal(got.warnings.length, 1)
  assert.match(got.warnings[0], /polygon/)
})

test('卡片字段契约 {title, sub, meta, years}：年代进 years，默认 box y=0.56（不压字幕）', () => {
  const got = run(`${MAP_ASSET}
    const card = {
      version: 2,
      info_points: [{ id: 'ip1', text: '近卫团成立', via: 'layer' }],
      budget: { layer_s: null, gen_s: 5 },
      layer_plan: {
        base: { kind: 'asset', asset_kind: 'character', asset_id: 25, version_task_id: null },
        must_mark: [],
        planned_layers: [
          { type: 'card', text: '1700–1721', at_s: 1 },
          { type: 'card', text: '近卫团 · 1702', at_s: 1.5 },
        ],
      },
      rationale: '', suggested_combo: 'D', issues: [],
    }
    const portraitCtx = { ...ctx, base: character, base_path: character.image_path, base_ref: baseRefOf(character) }
    const draft = draftSegment(card, 'D', portraitCtx)
    const normalized = normalizeLayerDoc(draft.layer_doc)
    const cards = normalized.layers.filter(l => l.type === 'card')
    out({
      base: draft.layer_doc.base.path,
      box: cards[0].box,
      defaultBox: CARD_DEFAULT_BOX,
      fields: cards.map(c => c.fields),
      templates: cards.map(c => c.template),
      hasYearsKey: cards.every(c => 'years' in c.fields),
      duration: draft.duration,
      defaultPrePost: LAYER_SEGMENT_PRE_POST_DEFAULT_SECONDS,
    })
  `)
  assert.equal(got.base, 'static/images/portrait.png', '底图只认设计卡 base（这里是指定的肖像），不走回退')
  assert.deepEqual(got.box, got.defaultBox, '默认 box 与契约常量一致')
  assert.equal(got.box.y, 0.56)
  assert.equal(got.box.y + got.box.h, 0.74, '底边 0.74，位于字幕安全区（>0.88）之上')
  assert.deepEqual(got.fields[0], { title: '', sub: '', meta: '', years: '1700–1721' }, '纯年代文案 → years，模板按 year')
  assert.deepEqual(got.fields[1], { title: '近卫团', sub: '', meta: '', years: '1702' }, '标题 + 年代分列')
  assert.deepEqual(got.templates, ['year', 'name'])
  assert.equal(got.hasYearsKey, true, '归一化后 years 字段仍在（#48 白名单不再丢弃）')
  assert.equal(got.duration, got.defaultPrePost, '没有图层段预算时 C/D 默认 2 秒过渡')
})

test('无合格底图不生成草稿：draftSegment 之外由 buildSegmentDraft 返回 missing_base（此处验证常量与不回退）', () => {
  const got = run(`
    out({
      safeBottom: CARD_DEFAULT_BOX.y + CARD_DEFAULT_BOX.h,
      hasFallbackHint: typeof draftSegment === 'function',
    })
  `)
  assert.equal(got.safeBottom, 0.74)
  assert.equal(got.hasFallbackHint, true)
})

test('一致性检查：must_mark 未锚定 / 参考素材未 @ / 卡片压字幕 / 预算偏差都是警告', () => {
  const got = run(`${MAP_ASSET}${MAP_CARD}
    const draft = draftSegment(card, 'A', ctx)
    const segment = {
      ...draft,
      layer_doc: normalizeLayerDoc({
        ...draft.layer_doc,
        layers: [
          ...draft.layer_doc.layers,
          { id: 'CARD', type: 'card', box: { x: 0.06, y: 0.86, w: 0.46, h: 0.18 }, template: 'name', fields: { title: 'x', sub: '', meta: '', years: '' } },
        ],
      }),
      stale_reasons: [],
    }
    const issues = segmentIssuesOf({
      card: { ...card, gen_plan: { reference_assets: [{ kind: 'character', id: 25, name: '利哈列夫' }] }, budget: { layer_s: 9, gen_s: 5 } },
      combo: 'A',
      segment,
      storyboardPrompts: { first: '', mid: '', last: '', video: '' },
    })
    out({
      codes: issues.map(i => i.code),
      first: issues.find(i => i.code === 'must_mark_not_marked') || null,
      budget: issues.find(i => i.code === 'budget_mismatch') || null,
    })
  `)
  assert.deepEqual([...got.codes].sort(), ['budget_mismatch', 'card_subtitle_overlap', 'reference_not_mentioned'], '已锚定 must_mark 不再报警')
  assert.equal(got.budget.actual, 15, '实际段长 15s vs 预算 9s')
  assert.equal(got.budget.budget, 9)
})

test('渲染签名 seg-v1：图层/时间线/时长/画幅/底图字节任一变化都换签名，且不含 position', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'seg-sig-'))
  try {
    mkdirSync(path.join(dir, 'static', 'uploads'), { recursive: true })
    const basePath = path.join(dir, 'static', 'uploads', 'map.png')
    writeFileSync(basePath, 'PNG-A')
    const script = `
      const segment = {
        duration: 15,
        layer_doc: normalizeLayerDoc({
          version: 1, theme: 'archival',
          base: { path: 'static/uploads/map.png', width: 960, height: 544 },
          layers: [{ id: 'L1', type: 'marker', at: [0.5, 0.5], text: '斋桑湖' }],
        }),
        timeline: normalizeTimeline({ fps: 25, ease: 'inout', fade_ms: 400,
          keyframes: [{ t: 0, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: ['L1'] }, { t: 15, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: ['L1'] }] }),
      }
      const spec = { width: 960, height: 544, fps: 25 }
      const baseline = layerSegmentSignatureOf(segment, spec)
      const movedLayer = layerSegmentSignatureOf({ ...segment, layer_doc: { ...segment.layer_doc, layers: [{ ...segment.layer_doc.layers[0], at: [0.6, 0.5] }] } }, spec)
      const changedTimeline = layerSegmentSignatureOf({ ...segment, timeline: { ...segment.timeline, fade_ms: 800 } }, spec)
      const changedDuration = layerSegmentSignatureOf({ ...segment, duration: 12 }, spec)
      const changedSize = layerSegmentSignatureOf(segment, { width: 1280, height: 720, fps: 25 })
      const changedFps = layerSegmentSignatureOf(segment, { width: 960, height: 544, fps: 24 })
      const same = layerSegmentSignatureOf({ ...segment }, spec)
      const asPost = layerSegmentSignatureOf({ ...segment, position: 'post' }, spec)
      out({ baseline, movedLayer, changedTimeline, changedDuration, changedSize, changedFps, same, asPost })
    `
    const got = run(`
      import { normalizeTimeline } from './src/services/segment-timeline.ts'
      ${script}
    `, { HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') })
    assert.equal(got.same, got.baseline, '同一输入签名稳定')
    assert.equal(got.asPost, got.baseline, '#50 的 position 已从签名里去掉（一镜只有一个图层段）')
    for (const key of ['movedLayer', 'changedTimeline', 'changedDuration', 'changedSize', 'changedFps']) {
      assert.notEqual(got[key], got.baseline, `${key} 必须换签名`)
    }

    writeFileSync(basePath, 'PNG-B-DIFFERENT')
    const after = run(`
      import { normalizeTimeline } from './src/services/segment-timeline.ts'
      ${script}
    `, { HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') })
    assert.notEqual(after.baseline, got.baseline, '底图文件被换掉必须换签名')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('compose 快照：无段的镜头保持 v2 摘要（存量项目不被整集判已变化）', () => {
  const got = run(`
    const clipless = {
      video_src: 'static/videos/a.mp4', audio_src: 'static/narration/a.mp3',
      subtitle_src: 'static/narration/a.srt', burned: true,
      text_sha256: 'abc', fit_key: 'pad:800', transition_t: 0,
    }
    const legacyV2 = { video_src: clipless.video_src, audio_src: clipless.audio_src, subtitle_src: clipless.subtitle_src, burned: true, text_sha256: 'abc', fit_key: 'pad:800', transition_t: 0 }
    const withClip = { ...clipless, combo: 'A', video_src: 'static/layer-segments/r.mp4', layer_segment: { src: 'static/layer-segments/r.mp4', signature: 'sig1' } }
    out({
      cliplessVersion: composeSignatureVersionOf(clipless),
      clipVersion: composeSignatureVersionOf(withClip),
      cliplessSig: composeSignatureOf(clipless),
      legacySig: composeSignatureOf(legacyV2),
      clipSig: composeSignatureOf(withClip),
    })
  `)
  // #50 之前的公式：sha256(['v2', video, audio, subtitle, '1', text, fit, t.toFixed(3)].join('\\u0000'))
  const V2_DIGEST = 'a77ed49e620bb74708ed1711b9f52b1072edafdcb7425d8e1e52a4690d6aa8a7'
  assert.equal(got.cliplessVersion, 2, '无段的镜头生效版本仍是 2')
  assert.equal(got.clipVersion, 4)
  assert.equal(got.cliplessSig, V2_DIGEST, '无段镜头的摘要必须与 #50 之前逐字节一致')
  assert.equal(got.legacySig, V2_DIGEST, '旧快照（根本没有段字段）同摘要')
  assert.notEqual(got.clipSig, V2_DIGEST, '显式纪录片组合使用 v4 摘要')
})

test('compose 快照 v4：图层段重渲染与组合切换分别改变签名和差异原因', () => {
  const got = run(`
    const base = {
      video_src: 'static/videos/a.mp4', audio_src: 'static/narration/a.mp3',
      subtitle_src: 'static/narration/a.srt', burned: true,
      text_sha256: 'abc', fit_key: 'pad:800', transition_t: 0,
    }
    const withReplace = { ...base, combo: 'A', video_src: 'static/layer-segments/r.mp4', layer_segment: { src: 'static/layer-segments/r.mp4', signature: 'sig1' } }
    const rerendered = { ...withReplace, layer_segment: { src: 'static/layer-segments/r2.mp4', signature: 'sig2' } }
    const withPost = { ...base, combo: 'D', layer_segment: { src: 'static/layer-segments/p.mp4', signature: 'sigp' } }
    const legacyV2 = { video_src: base.video_src, audio_src: base.audio_src, subtitle_src: base.subtitle_src, burned: true, text_sha256: 'abc', fit_key: 'pad:800', transition_t: 0 }
    out({
      version: COMPOSE_SIGNATURE_VERSION,
      baseSig: composeSignatureOf(base),
      legacySig: composeSignatureOf(legacyV2),
      replaceSig: composeSignatureOf(withReplace),
      rerenderedSig: composeSignatureOf(rerendered),
      diffRerender: describeComposeDiff(rerendered, withReplace),
      diffAddPost: describeComposeDiff(withPost, base),
      diffFromLegacy: describeComposeDiff(withPost, legacyV2),
      diffNone: describeComposeDiff(base, base),
    })
  `)
  assert.equal(got.version, 4, '显式组合升到 v4，剧情无组合仍为 v2')
  assert.equal(got.legacySig, got.baseSig, 'v2 旧快照缺字段按 null 比较，不会凭空报段变化')
  assert.notEqual(got.replaceSig, got.baseSig)
  assert.notEqual(got.rerenderedSig, got.replaceSig, '同一位置重渲染（签名变）必须换 compose 签名')
  assert.equal(got.diffRerender.filter(r => r.includes('图层段')).length, 1)
  assert.ok(got.diffAddPost.some(r => r.includes('段组合')))
  assert.ok(got.diffFromLegacy.some(r => r.includes('图层段')))
  assert.deepEqual(got.diffNone, ['输入快照与上次合成不一致'], '完全相同时保持既有兜底文案')
})

test('documentary v4 tracks junction hash and adopted generated version independently of legacy v2', () => {
  const got = run(`
    const base = { video_src: 'static/videos/a.mp4', audio_src: null, subtitle_src: null, burned: false, text_sha256: '', fit_key: '', transition_t: 0 }
    const hybrid = { ...base, combo: 'C', layer_segment: { src: 'static/layer-segments/a.mp4', signature: 'layer-v1' }, junction_hash: 'frame-v1', video_task_id: 12 }
    out({
      bVersion: composeSignatureVersionOf({ ...base, combo: 'B' }),
      base: composeSignatureOf(hybrid),
      junction: composeSignatureOf({ ...hybrid, junction_hash: 'frame-v2' }),
      video: composeSignatureOf({ ...hybrid, video_task_id: 13 }),
      order: composeSignatureOf({ ...hybrid, combo: 'D' }),
      junctionDiff: describeComposeDiff({ ...hybrid, junction_hash: 'frame-v2' }, hybrid),
    })
  `)
  assert.equal(got.bVersion, 4)
  for (const field of ['junction', 'video', 'order']) assert.notEqual(got[field], got.base)
  assert.ok(got.junctionDiff.some(reason => reason.includes('衔接帧')))
})

test('compose 快照 #91：竖屏字幕行宽进签名，横屏与不烧录镜头签名逐字节不变', () => {
  const got = run(`
    const landscape = {
      video_src: 'static/videos/a.mp4', audio_src: 'static/narration/a.mp3',
      subtitle_src: 'static/narration/a.srt', burned: true,
      text_sha256: 'abc', fit_key: 'pad:800', transition_t: 0,
    }
    const portrait = { ...landscape, subtitle_chars_per_line: 12 }
    const pureVisual = { video_src: 'static/videos/a.mp4', audio_src: null, subtitle_src: null, burned: false, text_sha256: '', fit_key: '', transition_t: 0 }
    out({
      landscapeSig: composeSignatureOf(landscape),
      portraitSig: composeSignatureOf(portrait),
      portraitV4: composeSignatureOf({ ...portrait, combo: 'A', layer_segment: { src: 's.mp4', signature: 'sig1' } }),
      landscapeV4: composeSignatureOf({ ...landscape, combo: 'A', layer_segment: { src: 's.mp4', signature: 'sig1' } }),
      pureVisualSig: composeSignatureOf(pureVisual),
      pureVisualPortraitSig: composeSignatureOf({ ...pureVisual, subtitle_chars_per_line: 12 }),
      pureVisualDiff: describeComposeDiff({ ...pureVisual, subtitle_chars_per_line: 12 }, pureVisual),
      diff: describeComposeDiff(portrait, landscape),
    })
  `)
  // #50 测试里同一份 parts 的既有摘要常量
  assert.equal(got.landscapeSig, 'a77ed49e620bb74708ed1711b9f52b1072edafdcb7425d8e1e52a4690d6aa8a7', '横屏（20 字/行，字段缺省）摘要与 #91 之前逐字节一致')
  assert.notEqual(got.portraitSig, got.landscapeSig, '竖屏行宽进摘要 → 既有竖屏成片判 changed')
  assert.notEqual(got.portraitV4, got.landscapeV4, 'v4 同样纳入行宽')
  assert.equal(got.pureVisualPortraitSig, got.pureVisualSig, '竖屏但不烧录字幕的镜头：行宽不进摘要，保持 unchanged')
  assert.deepEqual(got.pureVisualDiff, ['输入快照与上次合成不一致'], '不烧录时不报字幕排版变化')
  assert.ok(got.diff.some(r => r.includes('字幕排版')))
})
