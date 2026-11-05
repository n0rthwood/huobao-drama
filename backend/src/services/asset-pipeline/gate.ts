/**
 * 资产流水线的**程序闸门**（Issue #56）—— 纯函数，不读库、不发网络、不算像素
 *
 * 资产实验（~/projects/huobao-asset-lab/report.md）的核心结论是：视觉模型会把自己
 * 「看」出来的结论越说越宽——军服双排扣明明数错了，它自判 `minor`；清单漏答两条，
 * 它照样给 `overall='pass'`。所以模型只负责逐条**描述它看到了什么**，通过与否由这里算。
 *
 * 规则（逐条对应实验结论，改动必须同步 tests/asset-pipeline-gate.test.mjs）：
 * ① `must_have` / `forbidden` 的 id 必须被逐条覆盖一次：缺项、重复、枚举非法、
 *    `text_in_image.present` 不是布尔 → `invalid`（结论是「清单不完整」，**不是 PASS**）。
 * ② 任一 `violation` 或 `forbidden.detected` → FAIL。
 * ③ `metric ∈ {count, arrangement, color}` 的条目给 `minor` 一律升级成 `violation`：
 *    这三类是可数/可比的硬事实，没有「轻微」可言。
 * ④ QC 引用的 tolerance 必须出自 `spec.tolerances` 白名单，自创即 `invalid`。
 * ⑤ 画面出现文字（`text_in_image.present=true`）→ FAIL：底图零文字是图层体系的前提。
 * ⑥ 位置一致性用「目标点 + 两地标」做相似变换归一化后比距离；地标缺失 →
 *    `not_comparable` 且 FAIL（绝不退化成直接比原始坐标——画幅一变就全错）。
 * ⑦ 资产已有语义标注时追加 `semantics_preserved`：由调用方按改后的可抽色判据算好传进来
 *    （`services/asset-pipeline/semantics-check.ts`），这里只做汇总，保持本文件纯净。
 */

/** 线条色域覆盖率门槛（沿用 #47 的 80%，常量搬到闸门侧统一管理） */
export const FIDELITY_LINE_COVERAGE = 0.8
/** 美化轮上限（写死在流程里，不靠提示词约束模型） */
export const MAX_BEAUTIFY_ROUNDS = 2
/** 位置一致性：归一化（两地标间距 = 1）后的最大允许偏差 */
export const LOCATE_TOLERANCE = 0.12

export type GateMetric = 'count' | 'arrangement' | 'color' | 'shape' | 'other'
/** 这三类是可数/可比的硬事实：模型给 minor 一律升级为 violation */
const STRICT_METRICS: GateMetric[] = ['count', 'arrangement', 'color']
const VERDICTS = ['ok', 'minor', 'violation'] as const
export type GateVerdict = (typeof VERDICTS)[number]

export interface SpecMustHave {
  id: string
  element: string
  why?: string
  check?: string
  metric: GateMetric
}

export interface SpecForbidden {
  id: string
  error: string
  why?: string
}

export interface GateSpec {
  must_have: SpecMustHave[]
  forbidden: SpecForbidden[]
  tolerances: string[]
  locate_targets?: Array<{ id: string; name: string }>
  locate_anchors?: Array<{ id: string; name: string }>
}

export interface QcMustHaveVerdict {
  id: string
  verdict: string
  evidence?: string
  /** 模型声明本条按哪条 tolerance 放行；必须是 spec.tolerances 里的原文 */
  tolerance?: string
}

export interface QcForbiddenVerdict {
  id: string
  detected: unknown
  evidence?: string
}

/** 模型报出的某个点在图上的位置（归一化到 [0,1] 的画幅坐标） */
export interface QcLocateReport {
  id: string
  name?: string
  at?: [number, number] | null
}

export interface QcPayload {
  must_have?: QcMustHaveVerdict[]
  forbidden?: QcForbiddenVerdict[]
  text_in_image?: { present?: unknown; evidence?: string }
  locate?: QcLocateReport[]
  fidelity_score?: number
  beauty_score?: number
  suggestions?: string[]
  /** 模型自己的总结论——**读都不读**，只在记录里保留以便事后对照 */
  overall?: string
}

export interface SemanticsPreserved {
  status: 'pass' | 'fail' | 'not_applicable'
  detail: string
}

export interface GateOptions {
  /** 期望位置：目标点与地标在**同一套归一化坐标**里的真值（地图来自投影，器物来自上一轮） */
  expected?: Array<{ id: string; name: string; at: [number, number] }>
  locateTolerance?: number
  /** 调用方预先算好的保形结论（见文件头 ⑦） */
  semanticsPreserved?: SemanticsPreserved
}

export interface LocateCheck {
  id: string
  name: string
  /** ok = 在容差内；off = 偏离超限；not_comparable = 地标不足，无法归一化比较 */
  status: 'ok' | 'off' | 'not_comparable'
  /** 归一化距离（两地标间距 = 1）；not_comparable 时为 null */
  distance: number | null
  detail: string
}

export interface GateResult {
  pass: boolean
  /** 清单覆盖率 = 被合法回答的条目数 / 条目总数 */
  coverage: number
  /** 清单本身不成立的原因（缺项/重复/枚举非法/自创 tolerance…）；非空即不可能 PASS */
  invalid: string[]
  violations: Array<{ id: string; element: string; verdict: GateVerdict; evidence: string }>
  forbidden_hits: Array<{ id: string; error: string; evidence: string }>
  text_in_image: { present: boolean | null; evidence: string }
  locate_checks: LocateCheck[]
  semantics_preserved: SemanticsPreserved
  /** 模型自报的结论，仅留痕（闸门不采信） */
  model_overall: string | null
}

function asArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : []
}

/**
 * 相似变换归一化后的位置核对。
 *
 * 为什么不直接比坐标：模型看到的是缩放后的 JPEG，构图一变（裁切、留白、不同画幅）
 * 所有绝对坐标都会整体平移缩放。取两个地标把「模型坐标系」对齐到「期望坐标系」，
 * 再比目标点的残差，才是对画面内容的判断。地标缺一个就无法求相似变换——这时必须
 * 诚实地报 `not_comparable` 并判 FAIL，而不是退化成直接比原始坐标。
 */
function evaluateLocate(spec: GateSpec, qc: QcPayload, opts: GateOptions): LocateCheck[] {
  const targets = asArray(spec.locate_targets)
  if (!targets.length) return []
  const tolerance = opts.locateTolerance ?? LOCATE_TOLERANCE
  const expected = new Map((opts.expected ?? []).map(item => [item.id, item]))
  const reported = new Map(
    asArray(qc.locate)
      .filter(item => Array.isArray(item.at) && item.at.length === 2
        && Number.isFinite(item.at[0]) && Number.isFinite(item.at[1]))
      .map(item => [item.id, item.at as [number, number]]),
  )

  const anchors = asArray(spec.locate_anchors)
    .filter(anchor => expected.has(anchor.id) && reported.has(anchor.id))
  const anchorNote = anchors.length < 2
    ? `可用地标只有 ${anchors.length} 个（需要 2 个才能做相似变换归一化）`
    : ''

  return targets.map((target) => {
    const name = target.name || target.id
    if (anchors.length < 2) {
      return { id: target.id, name, status: 'not_comparable' as const, distance: null, detail: anchorNote }
    }
    const want = expected.get(target.id)
    const got = reported.get(target.id)
    if (!want) {
      return { id: target.id, name, status: 'not_comparable' as const, distance: null, detail: '缺少该目标的期望坐标' }
    }
    if (!got) {
      return { id: target.id, name, status: 'not_comparable' as const, distance: null, detail: '模型没有报出该目标的位置' }
    }
    const [a, b] = anchors
    const ea = expected.get(a!.id)!.at
    const eb = expected.get(b!.id)!.at
    const ra = reported.get(a!.id)!
    const rb = reported.get(b!.id)!
    const expectedSpan = Math.hypot(eb[0] - ea[0], eb[1] - ea[1])
    const reportedSpan = Math.hypot(rb[0] - ra[0], rb[1] - ra[1])
    if (expectedSpan < 1e-6 || reportedSpan < 1e-6) {
      return { id: target.id, name, status: 'not_comparable' as const, distance: null, detail: '两个地标重合，无法归一化' }
    }
    // 期望坐标系 → 模型坐标系的相似变换（缩放 + 旋转 + 平移），按两地标求解
    const scale = reportedSpan / expectedSpan
    const expectedAngle = Math.atan2(eb[1] - ea[1], eb[0] - ea[0])
    const reportedAngle = Math.atan2(rb[1] - ra[1], rb[0] - ra[0])
    const rotation = reportedAngle - expectedAngle
    const cos = Math.cos(rotation)
    const sin = Math.sin(rotation)
    const dx = want.at[0] - ea[0]
    const dy = want.at[1] - ea[1]
    const mappedX = ra[0] + scale * (dx * cos - dy * sin)
    const mappedY = ra[1] + scale * (dx * sin + dy * cos)
    const distance = Math.hypot(got[0] - mappedX, got[1] - mappedY) / reportedSpan
    return {
      id: target.id,
      name,
      status: distance <= tolerance ? ('ok' as const) : ('off' as const),
      distance: Number(distance.toFixed(4)),
      detail: `归一化偏差 ${distance.toFixed(3)}（阈值 ${tolerance}）`,
    }
  })
}

export function evaluateGate(spec: GateSpec, qc: QcPayload, opts: GateOptions = {}): GateResult {
  const invalid: string[] = []
  const violations: GateResult['violations'] = []
  const forbiddenHits: GateResult['forbidden_hits'] = []

  const mustHave = asArray(spec.must_have)
  const forbidden = asArray(spec.forbidden)
  const tolerances = new Set(asArray(spec.tolerances).map(item => String(item).trim()).filter(Boolean))

  // ① must_have 逐条覆盖
  const answers = new Map<string, QcMustHaveVerdict[]>()
  for (const item of asArray(qc.must_have)) {
    const id = String(item?.id ?? '').trim()
    if (!id) {
      invalid.push('QC 的 must_have 里有一条没有 id')
      continue
    }
    const list = answers.get(id) ?? []
    list.push(item)
    answers.set(id, list)
  }
  let answered = 0
  for (const need of mustHave) {
    const list = answers.get(need.id) ?? []
    if (!list.length) {
      invalid.push(`必须要素「${need.id}」没有被核验`)
      continue
    }
    if (list.length > 1) {
      invalid.push(`必须要素「${need.id}」被重复回答了 ${list.length} 次`)
      continue
    }
    const answer = list[0]!
    const raw = String(answer.verdict ?? '').trim() as GateVerdict
    if (!VERDICTS.includes(raw)) {
      invalid.push(`必须要素「${need.id}」的结论「${answer.verdict}」不是 ok/minor/violation`)
      continue
    }
    // ④ 自创 tolerance 一律视为清单不成立
    const tolerance = typeof answer.tolerance === 'string' ? answer.tolerance.trim() : ''
    if (tolerance && !tolerances.has(tolerance)) {
      invalid.push(`必须要素「${need.id}」引用了事实表之外的容差：「${tolerance}」`)
      continue
    }
    answered++
    // ③ 可数/可比事实没有「轻微」
    const effective: GateVerdict = raw === 'minor' && STRICT_METRICS.includes(need.metric) ? 'violation' : raw
    if (effective === 'violation') {
      violations.push({
        id: need.id,
        element: need.element,
        verdict: effective,
        evidence: raw === 'minor'
          ? `${answer.evidence ?? ''}（模型自判 minor，但该条 metric=${need.metric} 属可数/可比事实，升级为 violation）`.trim()
          : String(answer.evidence ?? ''),
      })
    }
  }
  for (const id of answers.keys()) {
    if (!mustHave.some(item => item.id === id)) invalid.push(`QC 回答了事实表里不存在的必须要素「${id}」`)
  }

  // ① forbidden 逐条覆盖 + ② 命中即 FAIL
  const forbiddenAnswers = new Map<string, QcForbiddenVerdict[]>()
  for (const item of asArray(qc.forbidden)) {
    const id = String(item?.id ?? '').trim()
    if (!id) {
      invalid.push('QC 的 forbidden 里有一条没有 id')
      continue
    }
    const list = forbiddenAnswers.get(id) ?? []
    list.push(item)
    forbiddenAnswers.set(id, list)
  }
  for (const ban of forbidden) {
    const list = forbiddenAnswers.get(ban.id) ?? []
    if (!list.length) {
      invalid.push(`禁止项「${ban.id}」没有被核验`)
      continue
    }
    if (list.length > 1) {
      invalid.push(`禁止项「${ban.id}」被重复回答了 ${list.length} 次`)
      continue
    }
    const answer = list[0]!
    if (typeof answer.detected !== 'boolean') {
      invalid.push(`禁止项「${ban.id}」的 detected 不是布尔值`)
      continue
    }
    answered++
    if (answer.detected) {
      forbiddenHits.push({ id: ban.id, error: ban.error, evidence: String(answer.evidence ?? '') })
    }
  }
  for (const id of forbiddenAnswers.keys()) {
    if (!forbidden.some(item => item.id === id)) invalid.push(`QC 回答了事实表里不存在的禁止项「${id}」`)
  }

  // ⑤ 画面文字
  const textRaw = qc.text_in_image?.present
  const textPresent = typeof textRaw === 'boolean' ? textRaw : null
  if (textPresent === null) invalid.push('QC 没有给出 text_in_image.present 布尔值')

  const locateChecks = evaluateLocate(spec, qc, opts)
  const semanticsPreserved: SemanticsPreserved = opts.semanticsPreserved
    ?? { status: 'not_applicable', detail: '该资产没有语义标注，不做保形核验' }

  const total = mustHave.length + forbidden.length
  const coverage = total ? Number((answered / total).toFixed(4)) : 0

  const pass = invalid.length === 0
    && violations.length === 0
    && forbiddenHits.length === 0
    && textPresent === false
    && locateChecks.every(check => check.status === 'ok')
    && semanticsPreserved.status !== 'fail'

  return {
    pass,
    coverage,
    invalid,
    violations,
    forbidden_hits: forbiddenHits,
    text_in_image: { present: textPresent, evidence: String(qc.text_in_image?.evidence ?? '') },
    locate_checks: locateChecks,
    semantics_preserved: semanticsPreserved,
    model_overall: typeof qc.overall === 'string' ? qc.overall : null,
  }
}

// ─── 轮次建议 ────────────────────────────────────────────────

export interface RoundHistoryItem {
  round_no: number
  purpose: 'precision' | 'beautify'
  /** 该轮最新一条 QC 的闸门结论；null = 还没核验 */
  gate_pass: boolean | null
  /** 人工裁决（approve/revise/rollback/abort）；非空时人工优先 */
  human_verdict: string | null
  status: string
}

export interface RoundDecision {
  action: 'pass' | 'revise' | 'rollback' | 'abort'
  target_round_no: number | null
  reason: string
}

/**
 * 只产出**建议**，不自动推进（主进程裁决：每轮 qc/gate 后一律 suspend 等人）。
 * 面板把它显示成「本轮 FAIL，建议回退 r1」，最终动作仍是人点的。
 */
export function decideRound(history: RoundHistoryItem[]): RoundDecision {
  const rounds = [...history].sort((a, b) => a.round_no - b.round_no)
  const latest = rounds[rounds.length - 1]
  if (!latest) return { action: 'abort', target_round_no: null, reason: '还没有任何轮次' }

  const lastPass = [...rounds].reverse().find(item => item.gate_pass === true)
  if (latest.gate_pass === true) {
    return { action: 'pass', target_round_no: latest.round_no, reason: `第 ${latest.round_no} 轮通过闸门，建议采用` }
  }
  if (latest.gate_pass === null) {
    return { action: 'abort', target_round_no: latest.round_no, reason: `第 ${latest.round_no} 轮还没有闸门结论` }
  }

  const beautifyDone = rounds.filter(item => item.purpose === 'beautify').length
  if (beautifyDone < MAX_BEAUTIFY_ROUNDS) {
    return {
      action: 'revise',
      target_round_no: latest.round_no + 1,
      reason: `第 ${latest.round_no} 轮未过闸门，美化轮已用 ${beautifyDone}/${MAX_BEAUTIFY_ROUNDS}，建议打回重修`,
    }
  }
  if (lastPass) {
    return {
      action: 'rollback',
      target_round_no: lastPass.round_no,
      reason: `美化轮已用满 ${MAX_BEAUTIFY_ROUNDS} 轮仍未过闸门，建议回退到最后一个通过的第 ${lastPass.round_no} 轮`,
    }
  }
  return {
    action: 'abort',
    target_round_no: null,
    reason: `美化轮已用满 ${MAX_BEAUTIFY_ROUNDS} 轮且没有任何通过的轮次，建议终止并人工处理`,
  }
}
