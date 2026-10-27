/**
 * 分镜字段级保存时间 — storyboards.field_saved_at（JSON：字段 → unix 秒）
 *
 * 整行 updated_at 会被生图/生视频回写刷新，无法表达“这个输入框上次保存于何时”，
 * 因此关键帧页与视频页的自动保存字段单独打点；相对时间文本由前端按本地时钟计算。
 */

/** 打点的字段（关键帧页全部自动保存字段 + 视频页视频提示词） */
export const TRACKED_SAVE_FIELDS = [
  'description', 'atmosphere',
  'first_frame_prompt', 'mid_frame_prompt', 'mid_frame_time', 'last_frame_prompt',
  'video_prompt',
] as const

export type TrackedSaveField = typeof TRACKED_SAVE_FIELDS[number]

export function parseFieldSavedAt(raw: string | null | undefined): Record<string, number> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) result[key] = value
    }
    return result
  } catch {
    return {}
  }
}

/**
 * 给本次写入的受跟踪字段打上同一个时间戳，返回待存 JSON 与该时间戳。
 * 没有受跟踪字段被写入时 json 为 null（调用方不应更新该列）。
 */
export function stampFieldSavedAt(
  raw: string | null | undefined,
  fields: string[],
  savedAt: number = Math.floor(Date.now() / 1000),
): { json: string | null; savedAt: number; map: Record<string, number> } {
  const map = parseFieldSavedAt(raw)
  const tracked = fields.filter(field => (TRACKED_SAVE_FIELDS as readonly string[]).includes(field))
  if (!tracked.length) return { json: null, savedAt, map }
  for (const field of tracked) map[field] = savedAt
  return { json: JSON.stringify(map), savedAt, map }
}
