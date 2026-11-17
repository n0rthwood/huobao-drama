/**
 * 生成段时长与「中间帧时间」区间（Issue #110）。
 *
 * 纪录片镜的生成段受扩散模型 15 s 限制，但一条镜的真正长度取决于设计卡的 `gen_s`
 * （ep30 #01：生成段 5 s）。中间帧时间必须落在生成段里的 `(0.5, gen − 0.5)` 开区间，
 * 不能按整镜时长去算——整镜时长包含图层段，那一段由程序确定性渲染，没有中间帧可切。
 *
 * 取值顺序与后端一致：`storyboards.generated_segment_s` > 设计卡预算 `gen_s` > 整镜时长。
 * 后端同时给越界的存量值一个阻断 ref_issue `mid_time_out_of_range`，本函数供界面提示同口径。
 */

function positive(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** 本镜生成段时长（秒）；取不到时返回 null，由调用方决定兜底 */
export function generatedSegmentSecondsOf(storyboard) {
  const declared = positive(storyboard?.generated_segment_s ?? storyboard?.generatedSegmentS)
  if (declared !== null) return declared
  const card = storyboard?.design_card ?? storyboard?.designCard ?? null
  const budget = positive(card?.budget?.gen_s)
  if (budget !== null) return budget
  return positive(storyboard?.duration ?? storyboard?.durationS)
}

/**
 * 中间帧时间的合法区间：开区间 `(0.5, 生成段时长 − 0.5)`。
 * 生成段不足 1 s 时区间为空（没有任何合法中间帧），返回 null。
 */
export function midFrameTimeRange(storyboard, fallbackSeconds = 10) {
  const seconds = generatedSegmentSecondsOf(storyboard) ?? positive(fallbackSeconds) ?? 10
  if (!(seconds > 1)) return null
  return { min: 0.5, max: Math.round((seconds - 0.5) * 10) / 10, seconds }
}

/** 当前值是否越出区间；未设置（null/空串）不算越界——中间帧本来就是可选的 */
export function midFrameTimeOutOfRange(value, storyboard, fallbackSeconds = 10) {
  if (value === null || value === undefined || value === '') return false
  const n = Number(value)
  if (!Number.isFinite(n)) return true
  const range = midFrameTimeRange(storyboard, fallbackSeconds)
  if (!range) return true
  return n <= range.min || n >= range.max
}
