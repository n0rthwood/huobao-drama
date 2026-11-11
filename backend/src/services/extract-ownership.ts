/**
 * 纪录片整集提取的道具归属（Issue #93）：地图由场景提取保存，器物与组织载体由道具提取保存。
 * 「这个地点单独建场景还是画进地图」必须由同一次运行判断，所以地图跟着场景走；
 * 道具提取在场景之后运行，只读取已保存的地图，不再新建或改写。
 * 纯函数：只给拒收原因，不读库；单资产重提取与剧情项目不调用它。
 */
export type PropAssetType = 'prop' | 'map'

export function documentaryPropRejection(
  target: 'characters' | 'scenes' | 'props',
  incoming: PropAssetType,
  existing: PropAssetType | null,
): string | null {
  if (target === 'scenes') {
    if (incoming !== 'map') return '场景提取只保存地图（asset_type: "map"）；器物与组织载体由道具提取保存'
    if (existing === 'prop') return '同名普通道具已存在，场景提取不能把它改成地图；请给地图另起名字'
    return null
  }
  if (target === 'props' && (incoming === 'map' || existing === 'map')) {
    return '地图由场景提取保存；道具提取只保存器物与组织载体，不新建或改写地图'
  }
  return null
}
