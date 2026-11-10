/**
 * 地图图层文档提交前的规范化镜像（Issue #90）。
 *
 * 地图路径用严格校验：后端 `normalizeLayerDoc` 只要会改动提交的文档，整份就被拒收。
 * 几何钳制已经由 `useLayerDoc.patchLayer` 在编辑时做掉；剩下两处会被后端静默改写的
 * 是「按 z 重排」和「重复 id 加后缀」，提交前在这里先做成和后端一样的结果。
 *
 * 口径必须与 `backend/src/services/layer-doc.ts` 的 `normalizeLayerDoc` 一致：
 *   1. 按 z 升序排序，z 相同保持原有顺序（稳定）；
 *   2. 重复 id 取 `${id}-${index+1}`（index 是排序后的下标），后缀已被占用就把序号加 1 再试。
 * 这里**不补**后端不会补的默认值：补了就是另造一套规则，真正被拒的原因反而看不见。
 */

/** 后端排序用的 z：非有限值回落成下标（与 normalizeLayer 的 `num(0, 9999, index)` 同口径）。 */
function sortKey(layer, index) {
  const z = layer && typeof layer === 'object' ? Number(layer.z) : Number.NaN
  return Number.isFinite(z) ? Math.trunc(z) : index
}

/** 按 z 升序稳定排序（z 相同按原始下标），不修改入参数组。 */
export function sortLayersByZ(layers) {
  const list = Array.isArray(layers) ? layers : []
  return list
    .map((layer, index) => ({ layer, index, z: sortKey(layer, index) }))
    .sort((a, b) => (a.z - b.z) || (a.index - b.index))
    .map(entry => entry.layer)
}

/** 重复 id 加后缀；只有被改名的图层会复制一份，其余原样返回。 */
export function dedupeLayerIds(layers) {
  const list = Array.isArray(layers) ? layers : []
  const seen = new Set()
  return list.map((layer, index) => {
    const id = layer?.id
    if (!seen.has(id)) {
      seen.add(id)
      return layer
    }
    let suffix = index + 1
    let candidate = `${id}-${suffix}`
    while (seen.has(candidate)) candidate = `${id}-${++suffix}`
    seen.add(candidate)
    return { ...layer, id: candidate }
  })
}

/** 提交前的最后一步：排序 + 去重 id，其余字段原样保留。 */
export function normalizeMapLayerDoc(doc) {
  const source = doc && typeof doc === 'object' ? doc : {}
  return { ...source, layers: dedupeLayerIds(sortLayersByZ(source.layers)) }
}
