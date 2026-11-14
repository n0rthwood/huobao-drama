import familiesData from './families.json'
import referenceData from './references.json'
import type { LayerFont, LayerTheme, LayerStyle } from '../../../services/layer-doc.js'

export const MAP_STYLE_FAMILY_IDS = ['atlas-tint', 'historical-schematic', 'relief-shading', 'ink-chinese', 'modern-clean'] as const
export type MapStyleFamilyId = typeof MAP_STYLE_FAMILY_IDS[number]
export const DEFAULT_MAP_STYLE: MapStyleFamilyId = 'atlas-tint'
export const MAP_LABEL_TIERS = ['title', 'region', 'city', 'river', 'note'] as const
export type MapLabelTier = typeof MAP_LABEL_TIERS[number]
export const MAP_MARKER_TIERS = ['capital', 'city', 'settlement'] as const
export type MapMarkerTier = typeof MAP_MARKER_TIERS[number]
export type MapLineTier = 'river_major' | 'river_minor' | 'coast' | 'border_confirmed' | 'border_uncertain' | 'routes' | 'defense_wall'
type Dash = 'none' | 'dash' | 'dot'

export interface MapStylePalette { background: string; land: string; water: string; ink: string; boundary: string; accent: string }
export interface MapStyleLine { stroke: string; width: number; dash: Dash; arrow_start?: boolean; arrow_end?: boolean }
export interface MapStyleRegion { fill: string; fill_opacity: number; stroke: string; stroke_width: number; dash: Dash }
export interface MapStyleMarker { dot_radius: number; color: string; stroke: string; stroke_width: number }
export interface MapStyleLabel { font: LayerFont; size: number; color: string; bold: boolean; italic: boolean }
export interface MapStyleFamily {
  id: MapStyleFamilyId
  name: string
  status: 'adopted'
  purpose: string
  theme_mapping: LayerTheme
  palette: MapStylePalette
  lines: Record<MapLineTier, MapStyleLine> & { regions: MapStyleRegion }
  markers: Record<MapMarkerTier, MapStyleMarker>
  labels: Record<Exclude<MapLabelTier, 'note'>, MapStyleLabel>
  halo: { width: number; color: string }
  layout: { safe_margins: { top: number; right: number; bottom: number; left: number }; title_reserved_height: number; legend_reserved_height: number; minimum_label_gap: number; minimum_label_marker_gap: number; unoccupied_area_target: number }
  optional: { legend: { enabled: boolean; font: LayerFont; size: number; swatch_width: number; row_gap: number }; scale_bar: { enabled: boolean; width: number; stroke_width: number; font: LayerFont; size: number; requires: string }; graticule: { enabled: boolean; stroke: string; width: number; dash: Dash; opacity: number; requires: string } }
  terrain?: { enabled: boolean; source: string; shade_color: string; opacity: number; hypsometric_colors: string[]; data_required: boolean }
  implementation_notes: string[]
  preview: string
}

export class MapStyleValidationError extends Error {
  constructor(message: string, readonly field = 'map_style') { super(message); this.name = 'MapStyleValidationError' }
}
const fonts = ['sans', 'serif', 'kai', 'hand']
const themes = ['archival', 'clean', 'ink']
const dashes = ['none', 'dash', 'dot']
const record = (raw: unknown, field: string): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new MapStyleValidationError(`${field} must be an object`, field)
  return raw as Record<string, unknown>
}
const text = (raw: unknown, field: string): string => {
  if (typeof raw !== 'string' || !raw.trim()) throw new MapStyleValidationError(`${field} must be a non-empty string`, field)
  return raw
}
const hex = (raw: unknown, field: string): void => { if (typeof raw !== 'string' || !/^#[0-9a-f]{6}$/i.test(raw)) throw new MapStyleValidationError(`${field} must be #rrggbb`, field) }
const fraction = (raw: unknown, field: string, max = 1, min = 0): void => { if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max) throw new MapStyleValidationError(`${field} must be an output-height fraction in [${min}, ${max}]`, field) }
const boolean = (raw: unknown, field: string): void => { if (typeof raw !== 'boolean') throw new MapStyleValidationError(`${field} must be boolean`, field) }
const choice = (raw: unknown, allowed: readonly string[], field: string): void => { if (typeof raw !== 'string' || !allowed.includes(raw)) throw new MapStyleValidationError(`${field} must be ${allowed.join('/')}`, field) }

/** Validate the checked-in recipe before any render/API use; no unvalidated palette reaches SVG. */
export function validateMapStyleFamilies(raw: unknown): MapStyleFamily[] {
  const root = record(raw, 'styles')
  if (root.version !== 1 || root.status !== 'adopted' || root.length_unit !== 'output_height_fraction') throw new MapStyleValidationError('styles must be adopted version 1 using output_height_fraction')
  const fontMap = record(root.font_family_mapping, 'styles.font_family_mapping')
  for (const font of fonts) text(fontMap[font], `styles.font_family_mapping.${font}`)
  if (!Array.isArray(root.families)) throw new MapStyleValidationError('styles.families must be an array')
  const seen = new Set<string>()
  for (const [index, rawFamily] of root.families.entries()) {
    const field = `styles.families[${index}]`, family = record(rawFamily, field)
    choice(family.id, MAP_STYLE_FAMILY_IDS, `${field}.id`)
    if (seen.has(String(family.id))) throw new MapStyleValidationError(`${field}.id is duplicated`)
    seen.add(String(family.id))
    if (family.status !== 'adopted') throw new MapStyleValidationError(`${field}.status must be adopted`)
    text(family.name, `${field}.name`); text(family.purpose, `${field}.purpose`)
    choice(family.theme_mapping, themes, `${field}.theme_mapping`)
    const palette = record(family.palette, `${field}.palette`)
    for (const key of ['background', 'land', 'water', 'ink', 'boundary', 'accent']) hex(palette[key], `${field}.palette.${key}`)
    const lines = record(family.lines, `${field}.lines`)
    for (const key of ['river_major', 'river_minor', 'coast', 'border_confirmed', 'border_uncertain', 'routes', 'defense_wall']) {
      const line = record(lines[key], `${field}.lines.${key}`)
      hex(line.stroke, `${field}.lines.${key}.stroke`); fraction(line.width, `${field}.lines.${key}.width`, .05, Number.EPSILON); choice(line.dash, dashes, `${field}.lines.${key}.dash`)
      for (const arrow of ['arrow_start', 'arrow_end']) if (arrow in line) boolean(line[arrow], `${field}.lines.${key}.${arrow}`)
    }
    const region = record(lines.regions, `${field}.lines.regions`)
    hex(region.fill, `${field}.lines.regions.fill`); hex(region.stroke, `${field}.lines.regions.stroke`)
    fraction(region.fill_opacity, `${field}.lines.regions.fill_opacity`); fraction(region.stroke_width, `${field}.lines.regions.stroke_width`, .05); choice(region.dash, dashes, `${field}.lines.regions.dash`)
    const markers = record(family.markers, `${field}.markers`)
    for (const key of MAP_MARKER_TIERS) {
      const marker = record(markers[key], `${field}.markers.${key}`)
      fraction(marker.dot_radius, `${field}.markers.${key}.dot_radius`, .1, Number.EPSILON); fraction(marker.stroke_width, `${field}.markers.${key}.stroke_width`, .05)
      hex(marker.color, `${field}.markers.${key}.color`); hex(marker.stroke, `${field}.markers.${key}.stroke`)
    }
    const labels = record(family.labels, `${field}.labels`)
    for (const key of ['title', 'region', 'city', 'river']) {
      const label = record(labels[key], `${field}.labels.${key}`)
      choice(label.font, fonts, `${field}.labels.${key}.font`); fraction(label.size, `${field}.labels.${key}.size`, .5, .005); hex(label.color, `${field}.labels.${key}.color`)
      boolean(label.bold, `${field}.labels.${key}.bold`); boolean(label.italic, `${field}.labels.${key}.italic`)
    }
    const halo = record(family.halo, `${field}.halo`); hex(halo.color, `${field}.halo.color`); fraction(halo.width, `${field}.halo.width`, .03)
    const layout = record(family.layout, `${field}.layout`), margins = record(layout.safe_margins, `${field}.layout.safe_margins`)
    for (const key of ['top', 'right', 'bottom', 'left']) fraction(margins[key], `${field}.layout.safe_margins.${key}`, .5)
    if (Number(margins.top) + Number(margins.bottom) >= 1 || Number(margins.left) + Number(margins.right) >= 1) throw new MapStyleValidationError(`${field}.layout.safe_margins consume the canvas`)
    for (const key of ['title_reserved_height', 'legend_reserved_height', 'minimum_label_gap', 'minimum_label_marker_gap', 'unoccupied_area_target']) fraction(layout[key], `${field}.layout.${key}`)
    const optional = record(family.optional, `${field}.optional`)
    for (const key of ['legend', 'scale_bar', 'graticule']) {
      const item = record(optional[key], `${field}.optional.${key}`); boolean(item.enabled, `${field}.optional.${key}.enabled`)
      for (const [name, value] of Object.entries(item)) {
        if (['enabled', 'requires'].includes(name)) continue
        if (name === 'font') choice(value, fonts, `${field}.optional.${key}.${name}`)
        else if (name === 'dash') choice(value, dashes, `${field}.optional.${key}.${name}`)
        else if (name === 'stroke') hex(value, `${field}.optional.${key}.${name}`)
        else fraction(value, `${field}.optional.${key}.${name}`)
      }
    }
    if (family.terrain !== undefined) {
      const terrain = record(family.terrain, `${field}.terrain`); boolean(terrain.enabled, `${field}.terrain.enabled`); boolean(terrain.data_required, `${field}.terrain.data_required`)
      text(terrain.source, `${field}.terrain.source`); hex(terrain.shade_color, `${field}.terrain.shade_color`); fraction(terrain.opacity, `${field}.terrain.opacity`)
      if (!Array.isArray(terrain.hypsometric_colors) || !terrain.hypsometric_colors.length) throw new MapStyleValidationError(`${field}.terrain.hypsometric_colors must be non-empty`)
      terrain.hypsometric_colors.forEach((color, i) => hex(color, `${field}.terrain.hypsometric_colors[${i}]`))
    }
    if (family.preview !== `${family.id}.jpg`) throw new MapStyleValidationError(`${field}.preview must name its bundled reference thumbnail`)
  }
  if (seen.size !== MAP_STYLE_FAMILY_IDS.length) throw new MapStyleValidationError('styles must contain all five adopted families')
  return root.families as unknown as MapStyleFamily[]
}

export const MAP_STYLE_FAMILIES = validateMapStyleFamilies(familiesData)
const byId = Object.fromEntries(MAP_STYLE_FAMILIES.map(family => [family.id, family])) as Record<MapStyleFamilyId, MapStyleFamily>
export function isMapStyleFamilyId(raw: unknown): raw is MapStyleFamilyId { return typeof raw === 'string' && Object.hasOwn(byId, raw) }
export function mapStyleFamily(id: string): MapStyleFamily {
  const family = isMapStyleFamilyId(id) ? byId[id] : undefined
  if (!family) throw new MapStyleValidationError(`Unknown map style「${id}」`)
  return family
}
export interface ResolvedMapStyle { id: MapStyleFamilyId; theme: LayerTheme; family: MapStyleFamily; source: 'brief' | 'default' }
/** Missing map_style denotes a pre-Q4 brief and keeps its archival/clean/ink behavior. Explicit null follows the module default. */
export function resolveMapStyle(brief: { map_style?: string | null } | null | undefined, settings: { default_style?: string | null } = {}): ResolvedMapStyle | null {
  if (brief && !Object.prototype.hasOwnProperty.call(brief, 'map_style')) return null
  const explicit = brief?.map_style
  if (explicit != null && !isMapStyleFamilyId(explicit)) throw new MapStyleValidationError(`Unknown map style「${String(explicit)}」`, 'brief.map_style')
  const id = explicit ?? (isMapStyleFamilyId(settings.default_style) ? settings.default_style : DEFAULT_MAP_STYLE)
  const family = mapStyleFamily(id)
  return { id, theme: family.theme_mapping, family, source: explicit ? 'brief' : 'default' }
}
export function mapStyleFamilyViews() {
  return MAP_STYLE_FAMILIES.map(({ id, name, purpose, theme_mapping, palette }) => ({ id, name, purpose, theme_mapping, palette, preview: `/map-studio/styles/${id}/preview`, reference: referenceData[id] }))
}

const rounded = (value: number) => Math.round(value * 1e6) / 1e6
export function labelStyleFor(family: MapStyleFamily, tier: MapLabelTier): LayerStyle {
  const label = tier === 'note' ? { ...family.labels.city, size: rounded(family.labels.city.size * .85), color: family.palette.ink, bold: false, italic: false } : family.labels[tier]
  return { ...label, stroke: family.halo.color, stroke_width: family.halo.width, bg: family.palette.background, bg_opacity: 0, align: tier === 'title' ? 'center' : 'left' }
}
export function markerStyleFor(family: MapStyleFamily, tier: MapMarkerTier = 'city'): LayerStyle {
  const marker = family.markers[tier], label = family.labels.city
  return { dot_radius: marker.dot_radius, color: marker.color, stroke: marker.stroke, stroke_width: marker.stroke_width, text_color: label.color, size: rounded(label.size * (tier === 'capital' ? 1.15 : tier === 'settlement' ? .85 : 1)), font: label.font, bold: tier === 'capital', label_offset: [.016, -.012] }
}
export function lineStyleFor(family: MapStyleFamily, tier: MapLineTier): LayerStyle {
  const line = family.lines[tier]
  return { stroke: line.stroke, width: line.width, dash: line.dash, arrow_start: line.arrow_start ?? false, arrow_end: line.arrow_end ?? false }
}
export function regionStyleFor(family: MapStyleFamily): LayerStyle { return { ...family.lines.regions } }
export interface FeatureStyleInput { kind: 'place' | 'route' | 'region'; category?: string; lengthRatio?: number; markerTier?: MapMarkerTier }
/** Rivers use projected length (>=45% of canvas diagonal is major); no geometry is modified. */
export function featureStyleFor(family: MapStyleFamily, feature: FeatureStyleInput): LayerStyle {
  if (feature.kind === 'place') return markerStyleFor(family, feature.markerTier ?? 'city')
  if (feature.kind === 'region') return regionStyleFor(family)
  if (feature.category === 'river') return lineStyleFor(family, (feature.lengthRatio ?? 0) >= .45 ? 'river_major' : 'river_minor')
  if (feature.category === 'coast') return lineStyleFor(family, 'coast')
  // The adopted recipe has no mountain/lake line entry: derive quiet terrain/water hints rather than invent terrain geometry.
  if (feature.category === 'mountain') return { ...lineStyleFor(family, 'coast'), width: family.lines.river_minor.width, dash: 'dot' }
  if (feature.category === 'lake') return lineStyleFor(family, 'river_minor')
  return lineStyleFor(family, 'routes')
}
export function familyPromptSummary(family: MapStyleFamily): string {
  return `当前制图主题：${family.id}「${family.name}」\n用途：${family.purpose}\n色板：${JSON.stringify(family.palette)}\n要素默认样式：${JSON.stringify({ lines: family.lines, markers: family.markers, labels: family.labels, halo: family.halo })}\n默认使用主题，不要逐层手调。add_feature_layers 不传 style 即套类别默认；标签使用 add_label 的 tier。只有明确的叙事强调才覆盖单层样式。`
}
const TEXTURE_HINTS: Record<MapStyleFamilyId, string> = {
  'atlas-tint': 'warm pale sepia archival parchment tone, delicate copperplate paper grain',
  'historical-schematic': 'neutral ivory paper tone, flat even tone and very low contrast grain',
  'relief-shading': 'pale olive and cream paper tone, subtle neutral grain, no invented topographic shapes',
  'ink-chinese': 'warm rice-paper tone with faint ink diffusion and restrained vermilion-compatible warmth',
  'modern-clean': 'light cool neutral paper tone, clean contemporary surface, almost no grain and no aged stains',
}
export function textureHintFor(family: MapStyleFamily): string { return `${TEXTURE_HINTS[family.id]}, palette background ${family.palette.background}, land ${family.palette.land}, water ${family.palette.water}` }
