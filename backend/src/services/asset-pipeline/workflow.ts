/**
 * 资产流水线的 Mastra Workflow 图（Issue #56）
 *
 * 图形：research → curate → spec → [轮次 0 → 审批 0] → [轮次 1 → 审批 1] → [轮次 2 → 审批 2] → finalize
 *
 * 为什么轮次是**展开的三块**而不是 `dountil` 循环：轮次上限是产品约束（美化 ≤2 轮），
 * 必须写死在图里而不是靠条件表达式；展开之后每个 `suspend()` 都落在固定的 step id
 * （`approval_0/1/2`），重启后按 id 续跑是确定的，不依赖循环计数的快照语义。
 * 已经结束的 run 流过后面的块时整块短路（`state.done`），不会再打一次模型。
 *
 * 每一轮 qc/gate 之后一律 `suspend()` 等人（主进程裁决「必须改 2」）：
 * `decideRound()` 只给建议，不自动推进。
 */
import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { decideRound, type RoundDecision } from './gate.js'
import { planNextRound, RoundPlanError, type RoundPlan } from './contract.js'
import {
  getSpec,
  latestQcByRound,
  listAssetRounds,
  listRounds,
  recordHumanVerdict,
  type RoundPurpose,
} from './store.js'
import { withStepDeadline } from './deadline.js'
import { loadAssetTarget, runCurate, runGenerate, runQc, runResearch, runSpec, writeStep } from './steps.js'
import { resolvePrecisionReferences, type ReferenceOrigin } from './references.js'

export interface PipelineInput {
  pipelineTaskId: number
  assetKind: 'character' | 'scene' | 'prop'
  assetId: number
  episodeId: number
  purpose: RoundPurpose
  /** 启动时冻结的精确轮参考图（Issue #73）；老 run 的快照里没有这一项 */
  referenceSourceIds?: number[] | null
  configId?: number | null
  model?: string | null
  textConfigId?: number | null
}

export interface PipelineState {
  input: PipelineInput
  specId: number | null
  done: boolean
  aborted: boolean
  reviseNotes: string[]
  lastRoundNo: number | null
  finalRoundNo: number | null
  rollbackTo: number | null
  warnings: string[]
  /** 人在审批时改过用途的轮次（round_no → 用途），没改过的轮次按 roundPurposes() 走 */
  purposeOverrides?: Record<number, RoundPurpose>
}

export interface ApprovalResume {
  verdict: 'approve' | 'revise' | 'rollback' | 'abort'
  round_id: number
  selected_violations?: string[]
  notes?: string | null
  opened: Array<{ path: string; sha256: string }>
  override_gate?: boolean
  /** 打回重修时下一轮的用途；不给就沿用本轮用途（默认继续精确轮） */
  next_purpose?: RoundPurpose | null
}

/** 轮次 index → 用途。精确轮打头的 run 后面挂两轮美化；美化 run 两轮封顶 */
export function roundPurposes(purpose: RoundPurpose): RoundPurpose[] {
  return purpose === 'precision'
    ? ['precision', 'beautify', 'beautify']
    : ['beautify', 'beautify']
}

export const APPROVAL_STEP_IDS = ['approval_0', 'approval_1', 'approval_2'] as const

// Mastra 的 schema 只用来传递内部状态，不做结构校验（状态是本模块自己的类型）
const stateSchema = z.custom<PipelineState>(() => true)
const inputSchema = z.custom<PipelineInput>(() => true)
const resumeSchema = z.custom<ApprovalResume>(() => true)
const suspendSchema = z.custom<{
  round_id: number
  round_no: number
  gate_pass: boolean
  suggestion: RoundDecision
}>(() => true)

const prepareStep = createStep({
  id: 'prepare',
  inputSchema,
  outputSchema: stateSchema,
  execute: async ({ inputData }) => {
    const target = await loadAssetTarget(inputData.assetKind, inputData.assetId)
    if (!target) throw new Error('资产不存在')

    await writeStep(inputData.pipelineTaskId, 'research')
    const { result } = await withStepDeadline('research', () => runResearch({
      pipelineTaskId: inputData.pipelineTaskId,
      target,
      textConfigId: inputData.textConfigId ?? undefined,
    }))

    await writeStep(inputData.pipelineTaskId, 'curate')
    const curated = await withStepDeadline('curate', () => runCurate(target))

    await writeStep(inputData.pipelineTaskId, 'spec')
    const spec = await withStepDeadline('spec', signal => runSpec({
      pipelineTaskId: inputData.pipelineTaskId,
      target,
      research: result,
      textConfigId: inputData.textConfigId ?? undefined,
      signal,
    }))

    return {
      input: inputData,
      specId: spec.id,
      done: false,
      aborted: false,
      reviseNotes: [],
      lastRoundNo: null,
      finalRoundNo: null,
      rollbackTo: null,
      warnings: curated.warnings,
    } satisfies PipelineState
  },
})

/**
 * 参考图：精确轮用**启动时人选定**的已入库素材（Issue #73），美化轮用上一轮（或资产当前图）。
 * 精确轮取不到参考图会抛错，整轮不出图——绝不退化成「零参考图照样画」。
 */
export async function referencesFor(state: PipelineState, roundNo: number, purpose: RoundPurpose): Promise<{
  referenceImages: string[]
  referenceOrigins: ReferenceOrigin[]
}> {
  if (purpose === 'precision') {
    const selected = await resolvePrecisionReferences(
      state.input.assetKind,
      state.input.assetId,
      state.input.referenceSourceIds,
    )
    return {
      referenceImages: selected.map(item => item.local_path),
      referenceOrigins: selected.map(item => ({ type: 'source', source_id: item.id })),
    }
  }
  const rounds = await listRounds(state.input.pipelineTaskId)
  const previous = rounds.filter(item => item.round_no < roundNo && item.image_path).pop()
  if (previous?.image_path) return {
    referenceImages: [previous.image_path],
    referenceOrigins: [{ type: 'prev_round', round_id: previous.id }],
  }
  const target = await loadAssetTarget(state.input.assetKind, state.input.assetId)
  return {
    referenceImages: target?.imageUrl ? [target.imageUrl] : [],
    referenceOrigins: target?.imageUrl ? [{ type: 'unknown' }] : [],
  }
}

function makeRoundStep(index: number) {
  return createStep({
    id: `round_${index}`,
    inputSchema: stateSchema,
    outputSchema: stateSchema,
    execute: async ({ inputData }): Promise<PipelineState> => {
      const state = inputData
      const purposes = roundPurposes(state.input.purpose)
      if (state.done || index >= purposes.length) return state
      const purpose = state.purposeOverrides?.[index] ?? purposes[index]!
      const target = await loadAssetTarget(state.input.assetKind, state.input.assetId)
      if (!target) throw new Error('资产不存在')
      // 快照里只存 specId，事实表按 id 重新读库（整张表进 workflow snapshot 没有必要）
      const spec = state.specId ? await getSpec(state.specId) : null
      if (!spec) throw new Error('事实表缺失，无法出图')

      await writeStep(state.input.pipelineTaskId, 'prompt')
      const references = await referencesFor(state, index, purpose)

      await writeStep(state.input.pipelineTaskId, 'generate')
      const round = await withStepDeadline('generate', signal => runGenerate({
        pipelineTaskId: state.input.pipelineTaskId,
        episodeId: state.input.episodeId,
        target,
        spec,
        roundNo: index,
        purpose,
        reviseNotes: state.reviseNotes,
        ...references,
        configId: state.input.configId,
        model: state.input.model,
        signal,
      }))

      await writeStep(state.input.pipelineTaskId, 'qc')
      await withStepDeadline('qc', signal => runQc({
        target,
        spec,
        round,
        textConfigId: state.input.textConfigId ?? undefined,
        signal,
      }))
      await writeStep(state.input.pipelineTaskId, 'gate')
      return { ...state, lastRoundNo: index }
    },
  })
}

/**
 * 「回退到最后一个通过的轮次」在**同一资产的全部 run** 范围内判定（主进程裁决「疑问 1」）：
 * 允许对已有 PASS 轮的资产单独发起 beautify-only run，这种 run 自己这一条里可能一个
 * PASS 轮都没有——只看本 run 会把人退到无处可退。返回的是那一轮的 `round_no`。
 */
async function lastPassingRound(state: PipelineState, excludeRoundId: number): Promise<number | null> {
  const rounds = (await listAssetRounds(state.input.assetKind, state.input.assetId))
    .filter(item => item.id !== excludeRoundId && item.status === 'generated')
  const qcByRound = await latestQcByRound(rounds.map(item => item.id))
  const passing = rounds.filter((item) => {
    const qc = qcByRound.get(item.id)
    const human = qc?.human_verdict ?? null
    return human ? human === 'approve' : qc?.gate_pass === 1
  })
  return passing.length ? passing[passing.length - 1]!.round_no : null
}

function makeApprovalStep(index: number) {
  return createStep({
    id: APPROVAL_STEP_IDS[index]!,
    inputSchema: stateSchema,
    outputSchema: stateSchema,
    resumeSchema,
    suspendSchema,
    execute: async ({ inputData, resumeData, suspend }): Promise<PipelineState> => {
      const state = inputData
      const purposes = roundPurposes(state.input.purpose)
      if (state.done || index >= purposes.length) return state

      const rounds = await listRounds(state.input.pipelineTaskId)
      const current = rounds.find(item => item.round_no === index)
      if (!current) throw new Error(`第 ${index} 轮不存在`)
      const qcByRound = await latestQcByRound(rounds.map(item => item.id))
      const history = rounds.map(item => ({
        round_no: item.round_no,
        purpose: item.purpose,
        gate_pass: qcByRound.get(item.id) ? qcByRound.get(item.id)!.gate_pass === 1 : null,
        human_verdict: qcByRound.get(item.id)?.human_verdict ?? null,
        status: item.status,
      }))
      const suggestion = decideRound(history)
      const qc = qcByRound.get(current.id)

      if (!resumeData) {
        await writeStep(state.input.pipelineTaskId, 'approval')
        // suspend() 的返回类型是引擎内部的 InnerOutput（这一步不会真的继续往下走），
        // 对外仍须满足 outputSchema：这里是库类型与实际语义的鸿沟，只能显式断言
        return await suspend({
          round_id: current.id,
          round_no: index,
          gate_pass: qc?.gate_pass === 1,
          suggestion,
        }) as unknown as PipelineState
      }

      if (qc) {
        await recordHumanVerdict(qc.id, {
          verdict: resumeData.verdict,
          notes: resumeData.notes ?? null,
          opened: resumeData.opened,
        })
      }

      if (resumeData.verdict === 'approve') {
        return { ...state, done: true, finalRoundNo: index }
      }
      if (resumeData.verdict === 'abort') {
        return { ...state, done: true, aborted: true, finalRoundNo: null }
      }
      if (resumeData.verdict === 'rollback') {
        const target = await lastPassingRound(state, current.id)
        return { ...state, done: true, rollbackTo: target, finalRoundNo: target }
      }
      // revise：默认**继续本轮用途**（精确轮继续精确），人可以显式改成美化；
      // 块数或美化轮用满时不再开新轮，退回到此前通过的轮次（与原行为一致）
      const beautifyDone = history.filter(item => item.purpose === 'beautify').length
      let plan: RoundPlan
      try {
        plan = planNextRound({
          currentPurpose: current.purpose,
          currentRoundNo: index,
          requested: resumeData.next_purpose ?? null,
          beautifyDone,
          maxRounds: purposes.length,
        })
      } catch (err) {
        if (!(err instanceof RoundPlanError)) throw err
        const target = await lastPassingRound(state, current.id)
        return {
          ...state,
          done: true,
          rollbackTo: target,
          finalRoundNo: target,
          warnings: [...state.warnings, err.message],
        }
      }
      const violations = resumeData.selected_violations?.length
        ? [`fix these problems from the previous round: ${resumeData.selected_violations.join('; ')}`]
        : []
      const notes = resumeData.notes ? [resumeData.notes] : []
      return {
        ...state,
        reviseNotes: [...violations, ...notes],
        purposeOverrides: { ...state.purposeOverrides, [plan.index]: plan.purpose },
      }
    },
  })
}

const finalizeStep = createStep({
  id: 'finalize',
  inputSchema: stateSchema,
  outputSchema: z.custom<{
    final_round_no: number | null
    rollback_to: number | null
    aborted: boolean
    warnings: string[]
  }>(() => true),
  execute: async ({ inputData }) => {
    await writeStep(inputData.input.pipelineTaskId, 'finalize')
    return {
      final_round_no: inputData.finalRoundNo,
      rollback_to: inputData.rollbackTo,
      aborted: inputData.aborted,
      warnings: inputData.warnings,
    }
  },
})

export const assetPipelineWorkflow = createWorkflow({
  id: 'asset-pipeline',
  inputSchema,
  outputSchema: z.custom<{
    final_round_no: number | null
    rollback_to: number | null
    aborted: boolean
    warnings: string[]
  }>(() => true),
})
  .then(prepareStep)
  .then(makeRoundStep(0))
  .then(makeApprovalStep(0))
  .then(makeRoundStep(1))
  .then(makeApprovalStep(1))
  .then(makeRoundStep(2))
  .then(makeApprovalStep(2))
  .then(finalizeStep)
  .commit()
