/**
 * 动作条的唯一主动作矩阵（Issue #126 设计 01 §9 / 02 §2）。
 *
 * 纯函数：只读 detail 与本地编辑状态，产出「下一步到底是什么」。页面据此渲染一个主色按钮，
 * 并从 `mapDockRequest` 取真实请求（默认检索/渲染都是 guided 有界运行）。
 *
 * 全局优先级（高到低）：running → 写结果未知 → CAS 冲突 → 未保存草稿（含 failed） →
 * 真实 blocking/失败 → 正常阶段。任何更低优先级的恢复、确认、运行、交付都必须等前一项解除。
 */
import type { MapRunStopAt, MapStudioDetail } from '~/map-studio/api'

export type MapDockCommand =
  | 'none'
  | 'verifyResult'
  | 'resolveConflict'
  | 'saveBrief'
  | 'saveGeometry'
  | 'completeBrief'
  | 'search'
  | 'confirm'
  | 'render'
  | 'deliver'
  | 'retryDeliver'
  | 'viewDelivery'
  | 'viewMap'
  | 'refresh'
  | 'resumeStage'
  | 'retryStage'
  | 'continueResearch'
  | 'resolveProblems'
  | 'fixModel'
  | 'reviewBase'
  | 'viewError'
  | 'chooseRun'
  | 'clearProgress'

export interface MapDockAction {
  code: MapDockCommand
  /** i18n key 的参数（reasonKey 由页面按 mapStudio.dock.<reason> 翻译） */
  reason: string
  /** 主动作按钮显示的 i18n 键后缀（mapStudio.action.<label>），none 时为空 */
  label: string
  disabled: boolean
  /** 失败分型等附加参数，用于横幅 */
  detail?: string
}

export interface MapDockInput {
  detail: MapStudioDetail | null
  briefDirty: boolean
  geometryDirty: boolean
  /** 409 修订冲突或 busy 冲突尚未处理 */
  conflict: boolean
  /** 上一次写请求结果未知（超时/断线）：先核实再动 */
  resultUnknown?: boolean
  hostMissing?: boolean
  /** 待核对要素数（geometryUnverified 口径，含 dataset_missing） */
  pendingCount: number
  /** 研究进度可续（#124） */
  researchResumable?: boolean
}

const FAILURE_LABEL: Record<string, MapDockCommand> = {
  steps_exhausted: 'retryStage',
  ended_without_delivery: 'retryStage',
  call_error: 'retryStage',
  rejected: 'resolveProblems',
  mixed: 'resolveProblems',
}

/**
 * 唯一主动作。`none` 表示当前只有观测（如运行中），主色按钮禁用并显示原因。
 */
export function mapDockAction(input: MapDockInput): MapDockAction {
  const { detail, pendingCount } = input
  if (!detail) return { code: 'none', reason: 'loading', label: '', disabled: true }
  const running = detail.status === 'running' || detail.busy
  if (running) return { code: 'none', reason: 'running', label: '', disabled: true }
  if (input.resultUnknown) return { code: 'verifyResult', reason: 'resultUnknown', label: 'verifyResult', disabled: false }
  if (input.conflict) return { code: 'resolveConflict', reason: 'conflict', label: 'resolveConflict', disabled: false }
  if (input.briefDirty) return { code: 'saveBrief', reason: 'briefDirty', label: 'saveBrief', disabled: false }
  if (input.geometryDirty) return { code: 'saveGeometry', reason: 'geometryDirty', label: 'saveGeometry', disabled: false }
  if (input.hostMissing) return { code: 'none', reason: 'hostMissing', label: '', disabled: true }

  // 失败/阻塞：先处理真实前置，修复保存后按返回 stage 重算（这里只决定当下这一格）。
  if (detail.status === 'failed') {
    const kind = detail.error_detail?.kind
    if (!kind) return { code: 'viewError', reason: 'failureUnclassified', label: 'viewError', disabled: false }
    const base = FAILURE_LABEL[kind]
    if (!base) return { code: 'viewError', reason: 'unknownFailure', label: 'viewError', disabled: false, detail: kind }
    if (detail.stage === 'complete' && detail.outputs.final_image) {
      // 交付阶段的失败：成图还在，走完整 complete（按需重渲 pip / 补齐交付）而不是 /deliver。
      return { code: 'deliver', reason: 'deliveryFailed', label: 'retryDeliver', disabled: false }
    }
    if ((kind === 'steps_exhausted' || kind === 'ended_without_delivery') && detail.stage === 'research' && input.researchResumable) {
      return { code: 'continueResearch', reason: 'researchResumable', label: 'continueResearch', disabled: false }
    }
    if (kind === 'call_error') return { code: 'fixModel', reason: 'modelConfig', label: 'fixModel', disabled: false }
    // 续跑要保留真实执行边界：旧 run 缺边界时不猜，进 AI 活动做明确选择。
    if (detail.mode === 'guided' && !detail.stop_at) return { code: 'chooseRun', reason: 'boundaryUnknown', label: 'resumeStage', disabled: false }
    return { code: base, reason: 'failure:' + kind, label: base, disabled: false }
  }
  if (detail.status === 'blocked') {
    if (detail.issues.some(issue => issue.blocking)) return { code: 'resolveProblems', reason: 'blockedIssue', label: 'resolveProblems', disabled: false }
    return { code: 'refresh', reason: 'blockedGeneric', label: 'refresh', disabled: false }
  }

  if (detail.status === 'completed' && detail.stage === 'complete') {
    return detail.host
      ? { code: 'viewDelivery', reason: 'delivered', label: 'viewDelivery', disabled: false }
      : { code: 'viewMap', reason: 'deliveredStandalone', label: 'viewMap', disabled: false }
  }
  if (detail.stage === 'complete') {
    // 成图已出、待交付：启动 /advance 执行 complete（pip → 构建 → 交付）。
    return detail.outputs.final_image
      ? { code: 'deliver', reason: 'readyToDeliver', label: 'deliver', disabled: false }
      : { code: 'render', reason: 'missingRender', label: 'render', disabled: false }
  }

  switch (detail.stage) {
    case 'brief':
      return detail.brief?.subject
        ? { code: 'search', reason: 'startResearch', label: 'search', disabled: false }
        : { code: 'completeBrief', reason: 'missingSubject', label: 'completeBrief', disabled: false }
    case 'research':
      return { code: 'search', reason: input.researchResumable ? 'continueResearch' : 'startResearch', label: 'search', disabled: false }
    case 'base':
      return { code: 'search', reason: 'prepareBase', label: 'prepareBase', disabled: false }
    case 'style':
    case 'drawing':
      if (!detail.outputs.base_image) return { code: 'reviewBase', reason: 'baseInvalid', label: 'reviewBase', disabled: false }
      if (pendingCount > 0) return { code: 'confirm', reason: 'confirmPending', label: 'confirmGeometry', disabled: false }
      return { code: 'render', reason: 'readyToRender', label: 'render', disabled: false }
    default:
      return { code: 'refresh', reason: 'unknownState', label: 'refresh', disabled: false }
  }
}

/**
 * 主动作对应的服务端请求形态。
 * - search/render/continueResearch/resumeStage/retryStage = 有界运行 guided（默认 UI 唯一路径）
 * - confirm = 既有 spec PUT（清 proposed），不附带 run
 * - deliver = /advance（complete 执行）；retryDeliver 同 /advance，不是 /deliver
 */
export interface MapDockRequest {
  kind: 'run' | 'advance' | 'save' | 'confirm' | 'deliver' | 'refresh' | 'none'
  mode?: 'guided'
  stopAt?: MapRunStopAt
}

export function mapDockRequest(action: MapDockAction, detail: MapStudioDetail | null): MapDockRequest {
  switch (action.code) {
    case 'search':
    case 'completeBrief':
      // completeBrief 只聚焦表单，不发 run
      return action.code === 'completeBrief' ? { kind: 'none' } : { kind: 'run', mode: 'guided', stopAt: 'base' }
    case 'render':
      return { kind: 'run', mode: 'guided', stopAt: 'drawing' }
    case 'confirm':
      return { kind: 'confirm' }
    case 'saveBrief':
    case 'saveGeometry':
      return { kind: 'save' }
    case 'deliver':
    case 'retryDeliver':
      return { kind: 'advance' }
    case 'continueResearch':
    case 'retryStage':
    case 'resumeStage':
      // 续跑沿用该失败 run 的真实边界；边界缺失由 chooseRun 提前拦下，不在这里猜。
      if (detail?.mode === 'guided' && detail.stop_at) return { kind: 'run', mode: 'guided', stopAt: detail.stop_at }
      return { kind: 'run' }
    default:
      return { kind: 'none' }
  }
}

/** 运行中/失败时「更多」里可用的运行控制（取消只在运行时出现） */
export function mapDockSecondary(detail: MapStudioDetail | null): Array<'cancel' | 'refresh' | 'activity' | 'rollback'> {
  if (!detail) return ['refresh']
  const list: Array<'cancel' | 'refresh' | 'activity' | 'rollback'> = ['refresh', 'activity']
  if (detail.status === 'running') list.unshift('cancel')
  if (detail.status !== 'running' && detail.stage !== 'complete') list.push('rollback')
  return list
}
