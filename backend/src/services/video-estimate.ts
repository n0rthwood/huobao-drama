/**
 * 视频生成时间估计（Issue #28）——纯函数，路由与测试共用。
 * 墙钟口径：elapsed = completed_at - created_at（提交→完成，含排队/上传/下载），
 * 文案必须叫「预计完成/总耗时」而不是渲染耗时。
 *
 * 选数规则（按优先级）：
 * 1. 本模型同时长桶（|d-d0| ≤ 0.5s）≥1 条 → 桶内 elapsed 中位数，basis=model-duration
 * 2. 本模型样本 ≥3 → 每条 elapsed/duration 比值的中位数 × 请求时长，basis=model-scaled
 * 3. 同 provider 其它模型（先同时长中位数，再比值缩放，同样各需 ≥1 / ≥3 条）→ basis=fallback-model + source_model
 * 4. 全无 → supported=false, basis=none
 */
export interface VideoEstimateSample {
  provider: string
  model: string
  durationSeconds: number
  elapsedSeconds: number
}

export type VideoEstimateBasis = 'model-duration' | 'model-scaled' | 'fallback-model' | 'none'

export interface VideoEstimate {
  supported: boolean
  provider: string
  requested_model: string
  source_model: string | null
  duration: number
  run_seconds: number | null
  samples: number
  basis: VideoEstimateBasis
}

/** 同时长桶边界（秒）：|d - d0| ≤ 0.5 含边界 */
export const DURATION_BUCKET_SECONDS = 0.5
/** 比值缩放所需的最小样本数 */
export const MIN_SCALED_SAMPLES = 3

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function isValidSample(s: VideoEstimateSample): boolean {
  return (
    !!s.provider && !!s.model &&
    Number.isFinite(s.durationSeconds) && s.durationSeconds > 0 &&
    Number.isFinite(s.elapsedSeconds) && s.elapsedSeconds > 0
  )
}

/** 单一模型内的估计：先同时长桶（≥1 条），再比值缩放（≥ MIN_SCALED_SAMPLES 条） */
function estimateForModel(samples: VideoEstimateSample[], duration: number): { runSeconds: number; samples: number; mode: 'duration' | 'scaled' } | null {
  const bucket = samples.filter(s => Math.abs(s.durationSeconds - duration) <= DURATION_BUCKET_SECONDS)
  if (bucket.length >= 1) {
    return { runSeconds: median(bucket.map(s => s.elapsedSeconds)), samples: bucket.length, mode: 'duration' }
  }
  if (samples.length >= MIN_SCALED_SAMPLES) {
    const ratio = median(samples.map(s => s.elapsedSeconds / s.durationSeconds))
    return { runSeconds: ratio * duration, samples: samples.length, mode: 'scaled' }
  }
  return null
}

/** 配置的模型列表：`model` 列是 JSON 数组字符串（历史单值/逗号串也兼容）。纯函数，不碰数据库 */
export function configModelList(config: { model?: string | null } | null): string[] {
  const raw = config?.model
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.filter((m): m is string => typeof m === 'string' && !!m.trim())
    if (typeof parsed === 'string' && parsed.trim()) return [parsed]
    return []
  } catch {
    return String(raw).split(',').map(m => m.trim()).filter(Boolean)
  }
}

export function selectVideoEstimate(
  rawSamples: VideoEstimateSample[],
  provider: string,
  requestedModel: string,
  duration: number,
): VideoEstimate {
  const base = {
    provider,
    requested_model: requestedModel,
    duration,
  }
  const samples = rawSamples.filter(isValidSample)

  const sameModel = samples.filter(s => s.provider === provider && s.model === requestedModel)
  const own = estimateForModel(sameModel, duration)
  if (own) {
    return {
      ...base, supported: true, source_model: null,
      run_seconds: own.runSeconds, samples: own.samples,
      basis: own.mode === 'duration' ? 'model-duration' : 'model-scaled',
    }
  }

  // fallback：同 provider 其它模型，样本数最多的模型优先（再按模型名稳定排序）
  const others = samples.filter(s => s.provider === provider && s.model !== requestedModel)
  const byModel = new Map<string, VideoEstimateSample[]>()
  for (const s of others) {
    const list = byModel.get(s.model) ?? []
    list.push(s)
    byModel.set(s.model, list)
  }
  const candidates = [...byModel.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))
  for (const [model, list] of candidates) {
    const est = estimateForModel(list, duration)
    if (est) {
      return {
        ...base, supported: true, source_model: model,
        run_seconds: est.runSeconds, samples: est.samples,
        basis: 'fallback-model',
      }
    }
  }

  return { ...base, supported: false, source_model: null, run_seconds: null, samples: 0, basis: 'none' }
}
