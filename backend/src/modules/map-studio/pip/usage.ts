import type { MapPipOutput } from './frames.js'

/** 写进资产 meta 的用法说明（宿主会再补上各资产的名字/id）。分镜设计据此决定引用哪张图。 */
export function pipUsageText(plan: Pick<MapPipOutput, 'frames' | 'layout'>): string {
  const lines = [
    '这是一组「全览 + 细节」独立地图资产，分镜应同时引用：全览图负责建立位置、范围与趋势；细节图负责让观众看清事件发生处的山川河流。',
    '细节图自带角标定位图（缩略全览 + 同色取景框 + 编号），单独使用也能看出它在全览中的位置。',
    ...plan.frames.map(f => `细节${f.no}「${f.label}」（${f.role === 'primary' ? '重点' : '辅助'}）：${f.reason}${f.storyboard_numbers.length ? `；对应分镜 #${f.storyboard_numbers.join('、#')}` : ''}`),
    `预置版式 ${plan.layout.id}（${plan.layout.family === 'A' ? '全览为主：建立镜头' : '细节为主：叙事停留'}）：需要同屏对比时用组合图；否则相邻镜头先全览（高亮取景框）再细节。`,
    '聚焦某个细节的镜头以该细节图为底图；讲整体趋势的镜头以全览图为底图。',
  ]
  return lines.join('\n')
}
