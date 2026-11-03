/**
 * 确定性片段（Issue #50）：
 * - `overlay_plan → LayerDoc + timeline` 转换（语义原图像素 → 归一化、底图选择、reveal_at → 关键状态、推近）；
 * - 转换结果必须经得起 #48 `normalizeLayerDoc` 的白名单（样式键写错会被静默丢弃）；
 * - 渲染签名纯函数：图层/时间线/时长/画幅/底图字节任一变化即换签名；
 * - compose 快照 v3：`ComposeInputParts` 的「确定性片段」分项差异。
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
    import { draftClip, CLIP_PRE_POST_DEFAULT_SECONDS } from './src/services/clip-draft.ts'
    import { normalizeLayerDoc } from './src/services/layer-doc.ts'
    import { clipSignatureOf } from './src/services/storyboard-clips.ts'
    import { composeSignatureOf, describeComposeDiff, COMPOSE_SIGNATURE_VERSION } from './src/services/compose-state.ts'
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
  const ctx = { assets: [mapAsset, character], duration: 15, width: 960, height: 544 }
`

const MAP_INTENT = `
  const intent = {
    info_point: '清军两路进藏', device: 'map_anim',
    must_show: [{ kind: 'region', asset_id: 39, semantic_id: 'rg-1' }],
    overlay_plan: [
      { layer: 'polygon', anchor: { asset_id: 39, semantic_id: 'rg-1' }, reveal_at: 3 },
      { layer: 'polyline', anchor: { asset_id: 39, semantic_id: 'ln-1' }, reveal_at: 6 },
      { layer: 'marker', anchor: { asset_id: 39, semantic_id: 'pt-1' }, reveal_at: 9 },
      { layer: 'label', anchor: { asset_id: 39, semantic_id: 'lb-1' }, reveal_at: 11 },
    ],
    deterministic: 'replace', rationale: '',
  }
`

test('map_anim 草稿：底图取忠实原图，语义像素按原图尺寸归一化，reveal_at 变成关键状态', () => {
  const got = run(`${MAP_ASSET}${MAP_INTENT}
    const draft = draftClip(intent, ctx)
    out({
      position: draft.position,
      duration: draft.duration,
      base: draft.layer_doc.base,
      types: draft.layer_doc.layers.map(l => l.type),
      polygon: draft.layer_doc.layers[0].points,
      marker: draft.layer_doc.layers[2].at,
      labelText: draft.layer_doc.layers[3].text,
      times: draft.timeline.states.map(s => s.t),
      visible: draft.timeline.states.map(s => s.visible.length),
      lastViewport: draft.timeline.states[draft.timeline.states.length - 1].viewport,
      warnings: draft.warnings,
    })
  `)
  assert.equal(got.position, 'replace')
  assert.equal(got.duration, 15, 'replace 片段默认取本镜时长')
  assert.equal(got.base.path, 'static/uploads/map.png', '底图是 faithful_source 解析出来的原件')
  assert.deepEqual([got.base.width, got.base.height], [960, 544], 'base 尺寸 = 成片画幅')
  assert.deepEqual(got.types, ['polygon', 'polyline', 'marker', 'label'])
  // 2000×1000 原图像素 → 归一化：[400,300] → [0.2,0.3]
  assert.deepEqual(got.polygon[0], [0.2, 0.3])
  assert.deepEqual(got.marker, [0.55, 0.48])
  assert.equal(got.labelText, '拉萨', 'label 文字取自语义条目的 text')
  assert.deepEqual(got.times, [0, 3, 6, 9, 11, 12], '0 s 干净底图 + 四个 reveal + 推近状态')
  assert.deepEqual(got.visible, [0, 1, 2, 3, 4, 4], '每个状态累积一层')
  assert.equal(got.lastViewport.w < 1, true, '末状态推近')
  assert.equal(got.lastViewport.w, got.lastViewport.h)
  assert.deepEqual(got.warnings, [])
})

test('草稿必须经得起 #48 白名单：polyline 箭头与河线颜色不能被静默丢弃', () => {
  const got = run(`${MAP_ASSET}${MAP_INTENT}
    const draft = draftClip(intent, ctx)
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
    const intent = {
      info_point: '', device: 'map_anim', must_show: [],
      overlay_plan: [
        { layer: 'polygon', anchor: { asset_id: 39, semantic_id: 'rg-不存在' }, reveal_at: 2 },
        { layer: 'marker', anchor: { asset_id: 39, semantic_id: 'pt-1' }, reveal_at: 4 },
      ],
      deterministic: 'replace', rationale: '',
    }
    const draft = draftClip(intent, ctx)
    out({ types: draft.layer_doc.layers.map(l => l.type), warnings: draft.warnings })
  `)
  assert.deepEqual(got.types, ['marker'], '缺几何的那层被跳过，不是画成空多边形')
  assert.equal(got.warnings.length, 1)
  assert.match(got.warnings[0], /polygon/)
})

test('card 片段：底图取肖像，pre/post 默认 2 秒', () => {
  const got = run(`${MAP_ASSET}
    const intent = {
      info_point: '利哈列夫其人', device: 'card',
      must_show: [{ kind: 'portrait', asset_id: 25, asset_kind: 'character' }],
      overlay_plan: [{ layer: 'card', template: 'name', fields: { title: '利哈列夫', sub: '俄国远征队指挥官' }, reveal_at: 1 }],
      deterministic: 'replace', rationale: '',
    }
    const replace = draftClip(intent, ctx)
    const post = draftClip({ ...intent, device: 'reenact_video', deterministic: 'post' }, ctx)
    const none = draftClip({ ...intent, deterministic: 'none' }, ctx)
    out({
      base: replace.layer_doc.base.path,
      card: replace.layer_doc.layers[0],
      postDuration: post.duration,
      defaultPrePost: CLIP_PRE_POST_DEFAULT_SECONDS,
      none,
    })
  `)
  assert.equal(got.base, 'static/images/portrait.png', 'card 底图是人物肖像')
  assert.equal(got.card.type, 'card')
  assert.equal(got.card.fields.title, '利哈列夫')
  assert.equal(got.postDuration, got.defaultPrePost, 'pre/post 默认 2 秒')
  assert.equal(got.none, null, 'deterministic=none 不产生片段')
})

test('渲染签名：图层/时间线/时长/画幅/底图字节任一变化都换签名', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'clip-sig-'))
  try {
    mkdirSync(path.join(dir, 'static', 'uploads'), { recursive: true })
    const basePath = path.join(dir, 'static', 'uploads', 'map.png')
    writeFileSync(basePath, 'PNG-A')
    const got = run(`
      const clip = {
        position: 'replace', duration: 15,
        layer_doc: normalizeLayerDoc({
          version: 1, theme: 'archival',
          base: { path: 'static/uploads/map.png', width: 960, height: 544 },
          layers: [{ id: 'L1', type: 'marker', at: [0.5, 0.5], text: '斋桑湖' }],
        }),
        timeline: { fps: 25, ease: 'inout', fade_ms: 400, states: [{ t: 0, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: ['L1'] }] },
      }
      const spec = { width: 960, height: 544, fps: 25 }
      const baseline = clipSignatureOf(clip, spec)
      const movedLayer = clipSignatureOf({ ...clip, layer_doc: { ...clip.layer_doc, layers: [{ ...clip.layer_doc.layers[0], at: [0.6, 0.5] }] } }, spec)
      const changedTimeline = clipSignatureOf({ ...clip, timeline: { ...clip.timeline, fade_ms: 800 } }, spec)
      const changedDuration = clipSignatureOf({ ...clip, duration: 12 }, spec)
      const changedSize = clipSignatureOf(clip, { width: 1280, height: 720, fps: 25 })
      const changedFps = clipSignatureOf(clip, { width: 960, height: 544, fps: 24 })
      const same = clipSignatureOf({ ...clip }, spec)
      out({ baseline, movedLayer, changedTimeline, changedDuration, changedSize, changedFps, same })
    `, { HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') })
    assert.equal(got.same, got.baseline, '同一输入签名稳定')
    for (const key of ['movedLayer', 'changedTimeline', 'changedDuration', 'changedSize', 'changedFps']) {
      assert.notEqual(got[key], got.baseline, `${key} 必须换签名`)
    }

    // 底图字节换掉（路径不变）也必须换签名
    writeFileSync(basePath, 'PNG-B-DIFFERENT')
    const after = run(`
      const clip = {
        position: 'replace', duration: 15,
        layer_doc: normalizeLayerDoc({
          version: 1, theme: 'archival',
          base: { path: 'static/uploads/map.png', width: 960, height: 544 },
          layers: [{ id: 'L1', type: 'marker', at: [0.5, 0.5], text: '斋桑湖' }],
        }),
        timeline: { fps: 25, ease: 'inout', fade_ms: 400, states: [{ t: 0, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: ['L1'] }] },
      }
      out({ sig: clipSignatureOf(clip, { width: 960, height: 544, fps: 25 }) })
    `, { HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') })
    assert.notEqual(after.sig, got.baseline, '底图文件被换掉必须换签名')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('compose 快照 v3：片段参与签名，差异分项报「确定性片段」', () => {
  const got = run(`
    const base = {
      video_src: 'static/videos/a.mp4', audio_src: 'static/narration/a.mp3',
      subtitle_src: 'static/narration/a.srt', burned: true,
      text_sha256: 'abc', fit_key: 'pad:800', transition_t: 0,
      replace_clip: null, pre_clip: null, post_clip: null,
    }
    const withReplace = { ...base, video_src: 'static/clips/r.mp4', replace_clip: { src: 'static/clips/r.mp4', signature: 'sig1' } }
    const rerendered = { ...withReplace, replace_clip: { src: 'static/clips/r2.mp4', signature: 'sig2' } }
    const withPost = { ...base, post_clip: { src: 'static/clips/p.mp4', signature: 'sigp' } }
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
  assert.equal(got.version, 3)
  assert.equal(got.legacySig, got.baseSig, 'v2 旧快照缺字段按 null 比较，不会凭空报片段变化')
  assert.notEqual(got.replaceSig, got.baseSig)
  assert.notEqual(got.rerenderedSig, got.replaceSig, '同一位置重渲染（签名变）必须换 compose 签名')
  assert.deepEqual(got.diffRerender.filter(r => r.includes('确定性片段')).length, 1)
  assert.match(got.diffRerender.find(r => r.includes('确定性片段')), /整镜替代/)
  assert.match(got.diffAddPost.find(r => r.includes('确定性片段')), /片尾/)
  assert.deepEqual(got.diffFromLegacy.filter(r => r.includes('确定性片段')).length, 1, '旧快照 → 新增片尾片段，只报片段一项')
  assert.deepEqual(got.diffNone, ['输入快照与上次合成不一致'], '完全相同时保持既有兜底文案')
})
