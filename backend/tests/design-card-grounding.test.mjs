/**
 * 设计卡的「现有资产依据」机检（Issue #87）—— 调用纯函数 `checkDesignCardGrounding`，
 * 用仓库自带 tsx 子进程执行消费者可见的允许/拒绝行为并以 JSON 回传。
 *
 * 覆盖 Fabel 母版的正反例：
 * - 正例：无语义素材作整体背景、纯章节标题无锚定、真实 line 锚 polyline、肖像 image 层；
 * - 反例：资产名冒充语义、几何层留空锚点、语义真实但几何为空、跨资产同名借用、
 *   版本不相容、组别不相容、must_mark 留空、image 层没有图、参考资产不存在。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(body) {
  const script = `
    import { normalizeDesignCard } from './src/services/design-card.ts'
    import {
      checkDesignCardGrounding,
    } from './src/services/design-card-grounding.ts'
    const out = (value) => console.log('@@' + JSON.stringify(value))
    ${body}
  `
  const text = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot, encoding: 'utf8',
  })
  return JSON.parse(text.slice(text.lastIndexOf('@@') + 2))
}

/**
 * 本集资产：
 * - 道具 103「邗沟走向示意图」：一张**没有任何语义条目**的地图（现场即此情形）；
 * - 道具 39「西伯利亚舆图」：有真实语义（点 / 线 / 残缺的面），语义针对版本 7001；
 * - 道具 41「另一张舆图」：有一条**同名**的线，用来验证跨资产借用；
 * - 角色 25：有图，可作 image 层来源；角色 26：没有图。
 */
const CTX = `
  const ctx = { assets: [
    { kind: 'prop', id: 103, name: '邗沟走向示意图', faithful: true, image: 'static/uploads/map103.png', semantics: [] },
    {
      kind: 'prop', id: 39, name: '西伯利亚舆图', faithful: true, image: 'static/uploads/map39.png',
      semantics_source_task_id: 7001,
      semantics: [
        { id: 'pt-1', name: '托博尔斯克', group: 'point', geometry_points: 1 },
        { id: 'ln-1', name: '额尔齐斯河', group: 'line', geometry_points: 42 },
        { id: 'rg-3', name: '准噶尔辖境', group: 'region', geometry_points: 1 },
        { id: 'lbl-2', name: '雅克萨', group: 'label', geometry_points: 1 },
      ],
    },
    {
      kind: 'prop', id: 41, name: '另一张舆图', image: 'static/uploads/map41.png',
      semantics_source_task_id: 8002,
      semantics: [{ id: 'ln-1', name: '额尔齐斯河', group: 'line', geometry_points: 30 }],
    },
    {
      kind: 'prop', id: 42, name: '手工标注图', image: 'static/uploads/map42.png',
      semantics: [{ id: 'ln-9', name: '运河故道', group: 'line', geometry_points: 20 }],
    },
    { kind: 'prop', id: 55, name: '尚未出图的舆图', faithful: true, semantics: [] },
    { kind: 'character', id: 25, name: '利哈列夫', image: 'static/uploads/p25.png' },
    { kind: 'character', id: 26, name: '无图人物' },
  ] }
  const check = (raw, combo = 'A') => checkDesignCardGrounding(normalizeDesignCard(raw, ctx), ctx, combo)
  const codes = (raw, combo = 'A') => check(raw, combo).map(item => item.code)
  const base39 = { kind: 'asset', asset_kind: 'prop', asset_id: 39, version_task_id: null }
`

/** 真实、类型相容、几何完整的引用 —— 不该有任何缺口 */
test('真实语义 + 相容类型 + 完整几何：通过', () => {
  const result = run(`${CTX}
    out(check({
      version: 2,
      info_points: [{ id: 'p1', text: '溯额尔齐斯河北上', via: 'layer' }],
      budget: { layer_s: 8, gen_s: null },
      layer_plan: {
        base: base39,
        must_mark: [{ asset_id: 39, semantic_id: 'ln-1', name: '额尔齐斯河' }],
        planned_layers: [
          { type: 'polyline', at_s: 0, anchor: { asset_id: 39, semantic_id: 'ln-1', name: '额尔齐斯河' } },
          { type: 'marker', at_s: 2, anchor: { asset_id: 39, semantic_id: 'pt-1', name: '托博尔斯克' } },
          { type: 'label', at_s: 3, text: '雅克萨', anchor: { asset_id: 39, semantic_id: 'lbl-2', name: '雅克萨' } },
        ],
      },
      rationale: '按旁白顺序出图层',
    }))
  `)
  assert.deepEqual(result, [])
})

/** 无语义素材作整体背景 + 纯章节标题 / 定义卡不锚定：合法，不能一刀切要求先标注 */
test('无语义素材整体展示 + 无锚定标题卡：通过', () => {
  const result = run(`${CTX}
    out(check({
      version: 2,
      info_points: [{ id: 'p1', text: '江淮水网的整体面貌', via: 'layer' }],
      budget: { layer_s: 6, gen_s: null },
      layer_plan: {
        base: { kind: 'asset', asset_kind: 'prop', asset_id: 103, version_task_id: null },
        must_mark: [],
        planned_layers: [
          { type: 'card', at_s: 0, text: '第二章 永徽年间' },
          { type: 'label', at_s: 1, text: '江淮水网' },
        ],
      },
      rationale: '整张图作为背景展示，不添加无依据的路线',
    }))
  `)
  assert.deepEqual(result, [])
})

/** 现场的实际错误：资产名被当成语义名 */
test('资产名冒充语义：semantic_not_found，并报出该资产现有语义', () => {
  const result = run(`${CTX}
    const issues = check({
      version: 2, info_points: [], budget: { layer_s: 7.2, gen_s: null },
      layer_plan: {
        base: { kind: 'asset', asset_kind: 'prop', asset_id: 103, version_task_id: null },
        must_mark: [{ asset_id: 103, semantic_id: '邗沟走向示意图', name: '邗沟走向示意图' }],
        planned_layers: [
          { type: 'polyline', at_s: 0, anchor: { asset_id: 103, semantic_id: '邗沟走向示意图', name: '邗沟走向示意图' } },
        ],
      },
      rationale: '',
    })
    out({ codes: issues.map(i => i.code), text: issues.map(i => i.message).join('\\n') })
  `)
  assert.deepEqual(result.codes, ['semantic_not_found', 'semantic_not_found'])
  assert.ok(result.text.includes('邗沟走向示意图'))
  assert.ok(result.text.includes('该资产当前没有任何语义条目'))
})

/** 旧豁免：几何层留空锚点等人工标注 —— 现在必须拒绝 */
test('几何层锚点留空 / 完全不写锚点：anchor_required_blank', () => {
  const result = run(`${CTX}
    out({
      blank: codes({
        version: 2, info_points: [], budget: { layer_s: 7.2, gen_s: null },
        layer_plan: {
          base: { kind: 'asset', asset_kind: 'prop', asset_id: 103, version_task_id: null },
          must_mark: [],
          planned_layers: [
            { type: 'polyline', at_s: 0, anchor: { asset_id: 103, semantic_id: '', name: '' } },
            { type: 'marker', at_s: 1, anchor: { asset_id: 103, semantic_id: '', name: '' } },
          ],
        },
        rationale: '待人工标注后补',
      }),
      missing: codes({
        version: 2, info_points: [], budget: { layer_s: 7.2, gen_s: null },
        layer_plan: {
          base: { kind: 'asset', asset_kind: 'prop', asset_id: 103, version_task_id: null },
          must_mark: [],
          planned_layers: [{ type: 'polygon', at_s: 0, text: '准噶尔辖境' }],
        },
        rationale: '',
      }),
    })
  `)
  assert.deepEqual(result.blank, ['anchor_required_blank', 'anchor_required_blank'])
  assert.deepEqual(result.missing, ['anchor_required_blank'])
})

/** must_mark 留空同样不是「待标注」的合法写法 */
test('must_mark 留空：must_mark_blank', () => {
  const result = run(`${CTX}
    out(codes({
      version: 2, info_points: [], budget: { layer_s: 5, gen_s: null },
      layer_plan: {
        base: { kind: 'asset', asset_kind: 'prop', asset_id: 103, version_task_id: null },
        must_mark: [{ asset_id: 103, semantic_id: '', name: '' }],
        planned_layers: [{ type: 'card', at_s: 0, text: '邗沟' }],
      },
      rationale: '',
    }))
  `)
  assert.deepEqual(result, ['must_mark_blank'])
})

/** 语义 ID 真实存在，但那条语义几何不够画出这一层 */
test('语义真实但几何为空/不足：semantic_geometry_empty', () => {
  const result = run(`${CTX}
    const issues = check({
      version: 2, info_points: [], budget: { layer_s: 5, gen_s: null },
      layer_plan: {
        base: base39,
        must_mark: [],
        planned_layers: [{ type: 'polygon', at_s: 0, anchor: { asset_id: 39, semantic_id: 'rg-3', name: '准噶尔辖境' } }],
      },
      rationale: '',
    })
    out({ codes: issues.map(i => i.code), text: issues.map(i => i.message).join('\\n') })
  `)
  assert.deepEqual(result.codes, ['semantic_geometry_empty'])
  assert.ok(result.text.includes('准噶尔辖境'))
})

/** 同名条目在别的资产上存在，借过来用：坐标落不到本镜底图 */
test('跨资产借用同名语义：anchor_not_on_base', () => {
  const result = run(`${CTX}
    out(codes({
      version: 2, info_points: [], budget: { layer_s: 5, gen_s: null },
      layer_plan: {
        base: base39,
        must_mark: [],
        planned_layers: [{ type: 'polyline', at_s: 0, anchor: { asset_id: 41, semantic_id: 'ln-1', name: '额尔齐斯河' } }],
      },
      rationale: '',
    }))
  `)
  assert.deepEqual(result, ['anchor_not_on_base'])
})

/** 底图钉死某个版本，而语义是针对另一版图做的 */
test('版本不相容：semantic_version_mismatch', () => {
  const result = run(`${CTX}
    out(codes({
      version: 2, info_points: [], budget: { layer_s: 5, gen_s: null },
      layer_plan: {
        base: { kind: 'asset', asset_kind: 'prop', asset_id: 39, version_task_id: 6500 },
        must_mark: [],
        planned_layers: [{ type: 'polyline', at_s: 0, anchor: { asset_id: 39, semantic_id: 'ln-1', name: '额尔齐斯河' } }],
      },
      rationale: '',
    }))
  `)
  assert.deepEqual(result, ['semantic_version_mismatch'])
})

/** 语义真实，但组别与图层类型不相容（拿线当范围） */
test('组别不相容：semantic_group_mismatch', () => {
  const result = run(`${CTX}
    out(codes({
      version: 2, info_points: [], budget: { layer_s: 5, gen_s: null },
      layer_plan: {
        base: base39,
        must_mark: [],
        planned_layers: [{ type: 'marker', at_s: 0, anchor: { asset_id: 39, semantic_id: 'ln-1', name: '额尔齐斯河' } }],
      },
      rationale: '',
    }))
  `)
  assert.deepEqual(result, ['semantic_group_mismatch'])
})

/** image 层画的是资产图片本身：锚到没有图的资产要拒绝，有图的放行 */
test('image 层：没有图片的资产被拒，有图的通过', () => {
  const result = run(`${CTX}
    const card = (assetId) => ({
      version: 2, info_points: [], budget: { layer_s: 5, gen_s: null },
      layer_plan: {
        base: base39, must_mark: [],
        planned_layers: [{ type: 'image', at_s: 0, anchor: { asset_id: assetId, semantic_id: '', name: '' } }],
      },
      rationale: '',
    })
    out({ noImage: codes(card(26)), withImage: codes(card(25)) })
  `)
  assert.deepEqual(result.noImage, ['image_source_missing'])
  assert.deepEqual(result.withImage, [])
})

/** 生成段参考资产不在本集 */
test('参考资产不存在：reference_asset_unresolved', () => {
  const result = run(`${CTX}
    out(codes({
      version: 2, info_points: [], budget: { layer_s: null, gen_s: 8 },
      gen_plan: { reference_assets: [{ kind: 'prop', id: 999, name: '不存在的素材' }], first: '出发' },
      rationale: '',
    }, 'B'))
  `)
  assert.deepEqual(result, ['reference_asset_unresolved'])
})

/** 只有生成段（组合 B）的镜不要求图层锚定，但虚构语义依然不许写进卡里 */
test('组合 B：不要求锚定，但虚构语义仍然被拒', () => {
  const result = run(`${CTX}
    const card = (planned) => ({
      version: 2, info_points: [], budget: { layer_s: null, gen_s: 8 },
      layer_plan: { base: base39, must_mark: [], planned_layers: planned },
      gen_plan: { reference_assets: [], first: '出发' },
      rationale: '',
    })
    out({
      noAnchor: codes(card([{ type: 'polyline', at_s: 0, text: '北上' }]), 'B'),
      invented: codes(card([{ type: 'polyline', at_s: 0, anchor: { asset_id: 39, semantic_id: '黑龙江', name: '黑龙江' } }]), 'B'),
    })
  `)
  assert.deepEqual(result.noAnchor, [])
  assert.deepEqual(result.invented, ['semantic_not_found'])
})

/** 底图指向不在本集的资产 */
test('底图资产不在本集：base_unresolved', () => {
  const result = run(`${CTX}
    out(codes({
      version: 2, info_points: [], budget: { layer_s: 5, gen_s: null },
      layer_plan: {
        base: { kind: 'asset', asset_kind: 'prop', asset_id: 777, version_task_id: null },
        must_mark: [], planned_layers: [{ type: 'card', at_s: 0, text: '标题' }],
      },
      rationale: '',
    }))
  `)
  assert.deepEqual(result, ['base_unresolved']) 
})


/** 空卡 / 没有 layer_plan 的卡不产生缺口（机检只看写进来的依赖） */
test('没有设计卡或没有图层计划时不报缺口', () => {
  const result = run(`${CTX}
    out({
      none: checkDesignCardGrounding(null, ctx, 'A').length,
      empty: codes({ version: 2, info_points: [], budget: { layer_s: 5, gen_s: null }, rationale: '' }),
    })
  `)
  assert.equal(result.none, 0)
  assert.deepEqual(result.empty, [])
})

/** 底图必须是现在就有图的资产：不能按「以后会出图」规划 */
test('底图资产当前没有图片：base_image_missing', () => {
  const result = run(`${CTX}
    out({
      layerShot: codes({
        version: 2, info_points: [], budget: { layer_s: 6, gen_s: null },
        layer_plan: {
          base: { kind: 'asset', asset_kind: 'prop', asset_id: 55, version_task_id: null },
          must_mark: [], planned_layers: [{ type: 'card', at_s: 0, text: '标题' }],
        },
        rationale: '',
      }),
      // 纯生成段的镜没有图层段，不拿底图说事
      genOnly: codes({
        version: 2, info_points: [], budget: { layer_s: null, gen_s: 8 },
        layer_plan: {
          base: { kind: 'asset', asset_kind: 'prop', asset_id: 55, version_task_id: null },
          must_mark: [], planned_layers: [],
        },
        gen_plan: { reference_assets: [], first: '出发' },
        rationale: '',
      }, 'B'),
    })
  `)
  assert.deepEqual(result.layerShot, ['base_image_missing'])
  assert.deepEqual(result.genOnly, [])
})

/** 生成段参考资产必须现在就有图 */
test('参考资产当前没有图片：reference_image_missing', () => {
  const result = run(`${CTX}
    const card = (assets) => ({
      version: 2, info_points: [], budget: { layer_s: null, gen_s: 8 },
      gen_plan: { reference_assets: assets, first: '出发' },
      rationale: '',
    })
    out({
      noImage: codes(card([{ kind: 'character', id: 26, name: '无图人物' }]), 'B'),
      withImage: codes(card([{ kind: 'character', id: 25, name: '利哈列夫' }]), 'B'),
    })
  `)
  assert.deepEqual(result.noImage, ['reference_image_missing'])
  assert.deepEqual(result.withImage, [])
})

/** 钉死底图版本时，标注没有记录版本 = 未确认，不能当成相容 */
test('标注没有版本来源而底图钉了版本：semantic_version_unverifiable', () => {
  const result = run(`${CTX}
    const card = (versionTaskId) => ({
      version: 2, info_points: [], budget: { layer_s: 6, gen_s: null },
      layer_plan: {
        base: { kind: 'asset', asset_kind: 'prop', asset_id: 42, version_task_id: versionTaskId },
        must_mark: [],
        planned_layers: [{ type: 'polyline', at_s: 0, anchor: { asset_id: 42, semantic_id: 'ln-9', name: '运河故道' } }],
      },
      rationale: '',
    })
    out({ pinned: codes(card(6500)), current: codes(card(null)) })
  `)
  assert.deepEqual(result.pinned, ['semantic_version_unverifiable'])
  // 不钉版本（用当前生效图）时合法
  assert.deepEqual(result.current, [])
})

/**
 * 跨表同号：绝不默默挑第一个资产去核验。
 * 锚的就是底图那张（同号）时按底图判定；同号候选里只有一张真有这条语义时取那张；
 * 都分不清才报 anchor_asset_ambiguous。
 */
test('同号资产跨类别：能判别的放行，判别不了的报 anchor_asset_ambiguous', () => {
  const result = run(`
    const ctx = { assets: [
      { kind: 'prop', id: 7, name: '舆图七', image: 'a.png', semantics: [{ id: 'ln-1', name: '河', group: 'line', geometry_points: 9 }] },
      { kind: 'character', id: 7, name: '人物七', image: 'b.png' },
      { kind: 'prop', id: 8, name: '舆图八', image: 'c.png', semantics: [{ id: 'ln-2', name: '运河', group: 'line', geometry_points: 5 }] },
      { kind: 'scene', id: 8, name: '场景八', image: 'd.png', semantics: [{ id: 'ln-2', name: '运河', group: 'line', geometry_points: 5 }] },
    ] }
    const card = (anchor) => ({
      version: 2, info_points: [], budget: { layer_s: 6, gen_s: null },
      layer_plan: {
        base: { kind: 'asset', asset_kind: 'prop', asset_id: 7, version_task_id: null },
        must_mark: [],
        planned_layers: [{ type: 'polyline', at_s: 0, anchor }],
      },
      rationale: '',
    })
    const codesOf = (anchor) =>
      checkDesignCardGrounding(normalizeDesignCard(card(anchor), ctx), ctx, 'A').map(item => item.code)
    out({
      onBase: codesOf({ asset_kind: 'prop', asset_id: 7, semantic_id: 'ln-1', name: '河' }),
      ambiguous: codesOf({ asset_id: 8, semantic_id: 'ln-2', name: '运河' }),
    })
  `)
  // 同号但锚的就是本镜底图那张：按底图判定，照常通过
  assert.deepEqual(result.onBase, [])
  // 同号且两张都带同名语义：无法判别，拒绝（不挑第一个，也不假装跨资产可用）
  assert.deepEqual(result.ambiguous, ['anchor_asset_ambiguous'])
})

/** 兼容矩阵按下游实际取几何的路径：polygon / polyline 都能用 region 或 line */
test('polygon 锚到真实折线：按现有渲染能力放行', () => {
  const result = run(`${CTX}
    out({
      polygonOnLine: codes({
        version: 2, info_points: [], budget: { layer_s: 6, gen_s: null },
        layer_plan: {
          base: base39, must_mark: [],
          planned_layers: [{ type: 'polygon', at_s: 0, anchor: { asset_id: 39, semantic_id: 'ln-1', name: '额尔齐斯河' } }],
        },
        rationale: '',
      }),
      markerOnLine: codes({
        version: 2, info_points: [], budget: { layer_s: 6, gen_s: null },
        layer_plan: {
          base: base39, must_mark: [],
          planned_layers: [{ type: 'marker', at_s: 0, anchor: { asset_id: 39, semantic_id: 'ln-1', name: '额尔齐斯河' } }],
        },
        rationale: '',
      }),
    })
  `)
  assert.deepEqual(result.polygonOnLine, [])
  assert.deepEqual(result.markerOnLine, ['semantic_group_mismatch'])
})

