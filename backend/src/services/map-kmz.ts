/**
 * MapSpec → KML / KMZ（Issue #84）
 *
 * 这是 Earth 底图路线的输入件，也是可独立交付的地理文件：同一个 spec 必须产出
 * **逐字节相同**的 KMZ（zip 条目时间戳固定 1980-01-01、无随机 id、字段顺序固定），
 * 否则 Earth 截图的 sidecar 里记的 kmz_sha256 就没有任何证明力。
 *
 * 规范化口径取自 skill kmz-google-earth（`references/kmz_normalize.py` 的结论）：
 * Feature 子元素顺序 name → visibility → description → styleUrl → 几何，样式 id 为
 * `style1…N`（不是数字开头、不随进程递增），不引入外部图标文件（KMZ 内只有 doc.kml）。
 * 这里不依赖 simplekml，所以也不需要「重打包」那一步。
 *
 * 颜色：KML 用 `aabbggrr`，与仓库里 `#rrggbb` 的写法相反，务必走 kmlColor()。
 */
import crypto from 'crypto'
import zlib from 'zlib'
import { MAP_REGION_COLOR, MAP_ROUTE_COLOR, type MapSpec } from './map-base-render.js'

/** 截图/交付都要带的影像与几何出处说明 */
export const KMZ_GEOMETRY_NOTE = '叠加几何为本项目按史料整理的示意图形，非测绘成果；底图影像版权归 Google 及其数据提供方。'

export interface MapKmlOptions {
  /** Document 名称，默认取 spec 的 bbox 描述 */
  name?: string
  /** 写进 Document/description 的出处说明（研究来源、许可） */
  description?: string
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** `#rrggbb` + 不透明度 → KML 的 `aabbggrr` */
export function kmlColor(hex: string, opacity: number): string {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!match) throw new Error(`KML 颜色必须是 #rrggbb，收到：${hex}`)
  const rgb = match[1].toLowerCase()
  const alpha = Math.round(Math.min(1, Math.max(0, opacity)) * 255).toString(16).padStart(2, '0')
  return `${alpha}${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`
}

function coord(lon: number, lat: number): string {
  // 固定 6 位小数（约 0.1 m）：确定性输出不能依赖 JS 默认的最短往返表示
  return `${lon.toFixed(6)},${lat.toFixed(6)},0`
}

function placemark(parts: {
  name: string
  description?: string
  styleUrl: string
  geometry: string
}): string {
  return [
    '<Placemark>',
    `<name>${escapeXml(parts.name)}</name>`,
    '<visibility>1</visibility>',
    parts.description ? `<description>${escapeXml(parts.description)}</description>` : '',
    `<styleUrl>#${parts.styleUrl}</styleUrl>`,
    parts.geometry,
    '</Placemark>',
  ].join('')
}

/**
 * 样式（线宽按 skill map-style 的口径：路线主线 ≥ 6 px，面填充 0.28 + 实线边界）。
 * 所有 id 以 `style` 开头并带序号，满足 `xs:ID` 且与生成顺序无关。
 */
const STYLES = [
  {
    id: 'style1',
    // AbstractColorStyle 的 color 在派生 IconStyle/LabelStyle 的 scale 前。
    xml: `<Style id="style1"><IconStyle><color>${kmlColor(MAP_ROUTE_COLOR, 1)}</color><scale>1.1</scale>`
      + '<Icon><href>https://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon>'
      + '<hotSpot x="0.5" y="0.5" xunits="fraction" yunits="fraction"/></IconStyle>'
      + `<LabelStyle><color>${kmlColor('#ffffff', 1)}</color><scale>1.8</scale></LabelStyle></Style>`,
  },
  {
    id: 'style2',
    // StyleType 的固定顺序：IconStyle → LabelStyle → LineStyle → PolyStyle。
    xml: '<Style id="style2"><LabelStyle><scale>0</scale></LabelStyle>'
      + `<LineStyle><color>${kmlColor(MAP_ROUTE_COLOR, 1)}</color><width>6</width></LineStyle></Style>`,
  },
  {
    id: 'style3',
    xml: '<Style id="style3"><LabelStyle><scale>0</scale></LabelStyle>'
      + `<LineStyle><color>${kmlColor(MAP_REGION_COLOR, 1)}</color><width>4</width></LineStyle>`
      + `<PolyStyle><color>${kmlColor(MAP_REGION_COLOR, 0.28)}</color><fill>1</fill><outline>1</outline></PolyStyle></Style>`,
  },
] as const

export function buildMapKml(spec: MapSpec, options: MapKmlOptions = {}): string {
  const [west, south, east, north] = spec.bbox
  const name = options.name?.trim()
    || `地图 ${west.toFixed(2)},${south.toFixed(2)} → ${east.toFixed(2)},${north.toFixed(2)}`
  const description = [options.description?.trim(), KMZ_GEOMETRY_NOTE].filter(Boolean).join('\n')

  const folders: string[] = []
  if (spec.places.length) {
    folders.push(
      '<Folder><name>地点</name><visibility>1</visibility>'
      + spec.places.map(place => placemark({
        name: place.name || place.id,
        description: place.proposed ? '候选坐标，尚未人工确认' : undefined,
        styleUrl: 'style1',
        geometry: `<Point><coordinates>${coord(place.lon, place.lat)}</coordinates></Point>`,
      })).join('')
      + '</Folder>',
    )
  }
  if (spec.routes.length) {
    folders.push(
      '<Folder><name>路线</name><visibility>1</visibility>'
      + spec.routes.map(route => placemark({
        name: route.name || route.id,
        description: route.proposed ? '候选路线，尚未人工确认' : undefined,
        styleUrl: 'style2',
        geometry: '<LineStyle/>'.slice(0, 0) + '<LineString><tessellate>1</tessellate><coordinates>'
          + route.points.map(([lon, lat]) => coord(lon, lat)).join(' ')
          + '</coordinates></LineString>',
      })).join('')
      + '</Folder>',
    )
  }
  if (spec.regions.length) {
    folders.push(
      '<Folder><name>区域</name><visibility>1</visibility>'
      + spec.regions.map(region => placemark({
        name: region.name || region.id,
        description: region.proposed ? '候选范围，尚未人工确认' : undefined,
        styleUrl: 'style3',
        geometry: '<Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>'
          + region.points.map(([lon, lat]) => coord(lon, lat)).join(' ')
          + '</coordinates></LinearRing></outerBoundaryIs></Polygon>',
      })).join('')
      + '</Folder>',
    )
  }

  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<kml xmlns="http://www.opengis.net/kml/2.2">'
    + '<Document>'
    + `<name>${escapeXml(name)}</name>`
    + '<visibility>1</visibility>'
    + `<description>${escapeXml(description)}</description>`
    + STYLES.map(style => style.xml).join('')
    + folders.join('')
    + '</Document></kml>'
}

// ---------------------------------------------------------------- 确定性 zip

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = -1
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

/** zip 的 DOS 时间字段固定为 1980-01-01 00:00，否则同一个 spec 每次打包 sha256 都不同 */
const DOS_TIME = 0
const DOS_DATE = (1 << 5) | 1

/** 单成员 zip（KMZ 只放 doc.kml），deflate raw，字段顺序与值全部确定 */
function zipSingleFile(filename: string, content: Buffer): Buffer {
  const nameBuf = Buffer.from(filename, 'utf8')
  const deflated = zlib.deflateRawSync(content, { level: 9 })
  const crc = crc32(content)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)           // version needed
  local.writeUInt16LE(0x0800, 6)       // flags: UTF-8 names
  local.writeUInt16LE(8, 8)            // deflate
  local.writeUInt16LE(DOS_TIME, 10)
  local.writeUInt16LE(DOS_DATE, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(deflated.length, 18)
  local.writeUInt32LE(content.length, 22)
  local.writeUInt16LE(nameBuf.length, 26)
  local.writeUInt16LE(0, 28)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)         // version made by
  central.writeUInt16LE(20, 6)         // version needed
  central.writeUInt16LE(0x0800, 8)
  central.writeUInt16LE(8, 10)
  central.writeUInt16LE(DOS_TIME, 12)
  central.writeUInt16LE(DOS_DATE, 14)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(deflated.length, 20)
  central.writeUInt32LE(content.length, 24)
  central.writeUInt16LE(nameBuf.length, 28)
  central.writeUInt16LE(0, 30)         // extra
  central.writeUInt16LE(0, 32)         // comment
  central.writeUInt16LE(0, 34)         // disk
  central.writeUInt16LE(0, 36)         // internal attrs
  central.writeUInt32LE(0, 38)         // external attrs
  central.writeUInt32LE(0, 42)         // local header offset

  const centralSize = central.length + nameBuf.length
  const centralOffset = local.length + nameBuf.length + deflated.length

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([local, nameBuf, deflated, central, nameBuf, end])
}

export interface MapKmzBuild {
  buffer: Buffer
  kml: string
  sha256: string
  counts: { places: number; routes: number; regions: number; coordinates: number }
}

/** MapSpec → KMZ 字节（doc.kml 单成员）。同 spec 必定同 sha256。 */
export function buildMapKmz(spec: MapSpec, options: MapKmlOptions = {}): MapKmzBuild {
  if (!spec.places.length && !spec.routes.length && !spec.regions.length) {
    throw new Error('地图没有任何地点、路线或区域，无法生成 KMZ：Earth 底图需要至少一个几何要素来取景')
  }
  const kml = buildMapKml(spec, options)
  const buffer = zipSingleFile('doc.kml', Buffer.from(kml, 'utf8'))
  const coordinates = spec.places.length
    + spec.routes.reduce((sum, route) => sum + route.points.length, 0)
    + spec.regions.reduce((sum, region) => sum + region.points.length, 0)
  return {
    buffer,
    kml,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    counts: {
      places: spec.places.length,
      routes: spec.routes.length,
      regions: spec.regions.length,
      coordinates,
    },
  }
}

/** KMZ 取景用的全部坐标（与 Earth 脚本里 kmz_points 同一集合） */
export function specCoordinates(spec: MapSpec): Array<[number, number]> {
  return [
    ...spec.places.map(place => [place.lon, place.lat] as [number, number]),
    ...spec.routes.flatMap(route => route.points),
    ...spec.regions.flatMap(region => region.points),
  ]
}

/** 带名字的点：Earth 只给这些几何画文字，取景时要为文字留位 */
export function specLabelledPoints(spec: MapSpec): Array<{ lon: number; lat: number; name: string }> {
  return spec.places
    .filter(place => (place.name || '').trim().length > 0)
    .map(place => ({ lon: place.lon, lat: place.lat, name: place.name }))
}
