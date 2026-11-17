import crypto from 'crypto'

export type RiverPoint = [number, number]
export interface RiverWay {
  id: number
  tags: Record<string, string>
  geometry: Array<{ lon: number; lat: number }>
}
export interface RegionRiver {
  id: string
  names: string[]
  way_ids: number[]
  bbox: [number, number, number, number]
  /** Historical geometry retained to keep previously published refs resolvable. */
  retired?: boolean
  lines: RiverPoint[][]
}

export function foldRiverName(name: string): string {
  return name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/^\s*река\s+/u, '').replace(/[-‐‑‒–—―_/\\.,;:!?"'’‘()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

/** Douglas–Peucker in geographic degrees; the original endpoints are always retained. */
export function simplifyRiver(points: RiverPoint[], tolerance: number): RiverPoint[] {
  if (points.length <= 2) return points.slice()
  const keep = new Uint8Array(points.length)
  keep[0] = keep[points.length - 1] = 1
  const stack: Array<[number, number]> = [[0, points.length - 1]]
  while (stack.length) {
    const [start, end] = stack.pop()!
    const a = points[start]!, b = points[end]!, dx = b[0] - a[0], dy = b[1] - a[1]
    const denom = dx * dx + dy * dy
    let best = tolerance * tolerance, selected = -1
    for (let i = start + 1; i < end; i++) {
      const p = points[i]!, t = denom ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / denom)) : 0
      const x = p[0] - a[0] - t * dx, y = p[1] - a[1] - t * dy, d = x * x + y * y
      if (d > best) { best = d; selected = i }
    }
    if (selected >= 0) { keep[selected] = 1; stack.push([start, selected], [selected, end]) }
  }
  return points.filter((_, index) => keep[index])
}

/** Connected components require a shared endpoint and at least one shared normalized name. */
export function assembleRegionRivers(input: RiverWay[], tolerance: number): RegionRiver[] {
  const ways = [...new Map(input.filter(w => w.tags?.name?.trim() && w.geometry?.length >= 2).map(w => [w.id, w])).values()]
    .sort((a, b) => a.id - b.id)
  const parent = ways.map((_, i) => i)
  const root = (n: number): number => { while (parent[n] !== n) { parent[n] = parent[parent[n]!]!; n = parent[n]! } return n }
  const byEndpoint = new Map<string, number[]>()
  const names = ways.map(w => [...new Set(['name', 'name:ru', 'name:en', 'name:zh'].map(k => w.tags[k]).filter((v): v is string => !!v?.trim()))])
  const folded = names.map(ns => new Set(ns.map(foldRiverName).filter(Boolean)))
  ways.forEach((w, i) => {
    for (const p of [w.geometry[0]!, w.geometry[w.geometry.length - 1]!]) {
      const key = `${p.lon},${p.lat}`, others = byEndpoint.get(key) ?? []
      for (const j of others) if ([...folded[i]!].some(name => folded[j]!.has(name))) parent[root(i)] = root(j)
      others.push(i); byEndpoint.set(key, others)
    }
  })
  const groups = new Map<number, number[]>()
  ways.forEach((_, i) => { const r = root(i), members = groups.get(r) ?? []; members.push(i); groups.set(r, members) })
  return [...groups.values()].map(indices => {
    const way_ids = indices.map(i => ways[i]!.id).sort((a, b) => a - b)
    const allNames = [...new Set(indices.flatMap(i => names[i]!))].sort((a, b) => a.localeCompare(b, 'en'))
    const lines = indices.map(i => simplifyRiver(ways[i]!.geometry.map(p => [p.lon, p.lat]), tolerance))
    const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
    for (const line of lines) for (const [x, y] of line) { bbox[0] = Math.min(bbox[0], x); bbox[1] = Math.min(bbox[1], y); bbox[2] = Math.max(bbox[2], x); bbox[3] = Math.max(bbox[3], y) }
    const id = crypto.createHash('sha256').update(`${allNames.map(foldRiverName).sort().join('|')}\n${way_ids.join(',')}`).digest('hex').slice(0, 24)
    return { id, names: allNames, way_ids, bbox, lines }
  }).sort((a, b) => a.id.localeCompare(b.id))
}
