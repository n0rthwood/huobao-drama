import type { GateResult } from './gate.js'
import type { AssetQcRecordRow, AssetSpecRow } from './store.js'

export type SerializedGate = Omit<GateResult, 'semantics_preserved'> & {
  semantics_preserved: GateResult['semantics_preserved'] | { status: 'unknown'; detail: string }
}

/** Historical verdicts lack the computed gate; never recompute it against current assets. */
export function serializeQcGate(qc: AssetQcRecordRow, spec: AssetSpecRow | null): SerializedGate {
  const saved = qc.verdicts?.gate_result
  if (saved) {
    return {
      ...saved,
      pass: qc.gate_pass === 1,
      semantics_preserved: saved.semantics_preserved ?? { status: 'unknown', detail: '历史记录未保存此项核验结果' },
    }
  }
  return {
    pass: qc.gate_pass === 1,
    coverage: qc.checklist_coverage,
    invalid: qc.gate_invalid,
    violations: (qc.verdicts?.must_have ?? [])
      .filter(item => item.verdict === 'violation')
      .map(item => ({
        id: item.id,
        element: spec?.must_have.find(need => need.id === item.id)?.element ?? item.id,
        verdict: 'violation' as const,
        evidence: item.evidence ?? '',
      })),
    forbidden_hits: (qc.verdicts?.forbidden ?? [])
      .filter(item => item.detected)
      .map(item => ({
        id: item.id,
        error: spec?.forbidden.find(ban => ban.id === item.id)?.error ?? item.id,
        evidence: item.evidence ?? '',
      })),
    text_in_image: qc.verdicts?.text_in_image ?? { present: null, evidence: '' },
    locate_checks: qc.locate_checks,
    semantics_preserved: { status: 'unknown', detail: '历史记录未保存此项核验结果' },
    model_overall: qc.verdicts?.overall ?? null,
  }
}
