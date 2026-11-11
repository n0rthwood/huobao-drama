/**
 * 衔接帧（Issue #58，契约 §3.3）—— 派生查询：不落自己的表，一切从图层段行现算。
 *
 * - C 组合：生成段首帧 = 图层段**末帧**（`t=duration`，即末尾停留的最终画面）；
 * - D 组合：生成段尾帧 = 图层段**首帧**（`t=0`）。
 *
 * `stale` 的口径：段没有渲染过（或没有衔接帧）、渲染签名对不上当前输入、
 * 或者衔接帧文件已经不在了。锁定槽位据此判断「能不能就绪」。
 */
import fs from 'fs'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getAbsolutePath } from '../utils/storage.js'
import {
  getLayerSegment,
  layerSegmentIsFresh,
  resolveEpisodeSegmentSpec,
  segmentsByStoryboard,
} from './layer-segment.js'
import { toCombo, lockedGenSlot, type Combo } from './design-card.js'
import { baseCheckBlockReason } from './layer-base-check.js'

export interface JunctionFrame {
  /** `layer_last` = 图层段末帧（C），`layer_first` = 图层段首帧（D）；没有图层段时为 null */
  source: 'layer_last' | 'layer_first' | null
  /** 衔接帧对应的图层段内时刻（秒） */
  t: number
  path: string | null
  hash: string | null
  stale: boolean
  /** 底图视觉验证未通过/待验证的原因（Issue #94）；通过或不需要验证时为 null */
  base_check_reason: string | null
  /** 段本身的新鲜度（与 `stale` 区分：段可能新鲜但衔接帧文件被清掉了） */
  segment_fresh: boolean
  combo: Combo | null
}

const EMPTY_JUNCTION: Omit<JunctionFrame, 'combo'> = {
  source: null,
  t: 0,
  path: null,
  hash: null,
  stale: true,
  base_check_reason: null,
  segment_fresh: false,
}

/** 单镜衔接帧。剧情镜头（combo 为 null）与 A/B 组合一律返回空 + `stale`。 */
export async function junctionFrameOf(storyboardId: number): Promise<JunctionFrame> {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb) return { ...EMPTY_JUNCTION, combo: null }
  const combo = toCombo(sb.combo)
  const slot = lockedGenSlot(combo)
  if (!slot) return { ...EMPTY_JUNCTION, combo }
  const segment = await getLayerSegment(storyboardId)
  if (!segment) return { ...EMPTY_JUNCTION, combo }
  const spec = await resolveEpisodeSegmentSpec(sb.episodeId)
  const fresh = layerSegmentIsFresh(segment, spec, combo)
  const path = segment.junction_path
  const fileExists = Boolean(path && fs.existsSync(getAbsolutePath(path)))
  // 底图视觉验证没过的衔接帧不能当引导帧用（Issue #94）：它正是被裁切/留白的那一张
  const baseCheckReason = baseCheckBlockReason(segment, spec)
  return {
    source: slot === 'first' ? 'layer_last' : 'layer_first',
    t: slot === 'first' ? segment.duration : 0,
    path,
    hash: segment.junction_hash,
    stale: !fresh || !fileExists || !segment.junction_hash || !!baseCheckReason,
    base_check_reason: baseCheckReason,
    segment_fresh: fresh,
    combo,
  }
}

/**
 * 整集一次算完（关键帧状态批量构建用）：只有 C/D 且已有段的镜头才有衔接帧，
 * 其余镜头不会出现在结果里。每集只探一次规格，避免逐镜重复 probe 视频。
 */
export async function junctionFramesOfEpisode(episodeId: number): Promise<Map<number, JunctionFrame>> {
  const rows = await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId))
  const locked = rows.filter(row => !row.deletedAt && lockedGenSlot(toCombo(row.combo)))
  const out = new Map<number, JunctionFrame>()
  if (!locked.length) return out
  const [spec, segments] = await Promise.all([
    resolveEpisodeSegmentSpec(episodeId),
    segmentsByStoryboard(locked.map(row => row.id)),
  ])
  for (const row of locked) {
    const combo = toCombo(row.combo)
    const slot = lockedGenSlot(combo)
    const segment = segments.get(row.id)
    if (!segment || !slot) {
      out.set(row.id, { ...EMPTY_JUNCTION, combo })
      continue
    }
    const fresh = layerSegmentIsFresh(segment, spec, combo)
    const fileExists = Boolean(segment.junction_path && fs.existsSync(getAbsolutePath(segment.junction_path)))
    const baseCheckReason = baseCheckBlockReason(segment, spec)
    out.set(row.id, {
      source: slot === 'first' ? 'layer_last' : 'layer_first',
      t: slot === 'first' ? segment.duration : 0,
      path: segment.junction_path,
      hash: segment.junction_hash,
      stale: !fresh || !fileExists || !segment.junction_hash || !!baseCheckReason,
      base_check_reason: baseCheckReason,
      segment_fresh: fresh,
      combo,
    })
  }
  return out
}
