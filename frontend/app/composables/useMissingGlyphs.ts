import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { unsupportedChars } from '~/utils/layerSvg'

/** Uses the same bundled-font coverage as the renderer; no browser font probing. */
export function missingGlyphsOf(layer: { text?: string; fields?: Record<string, string> } | null | undefined): string[] {
  if (!layer) return []
  return [...new Set<string>([layer.text || '', ...Object.values(layer.fields || {})].flatMap(text => unsupportedChars(text)))]
}

export function useMissingGlyphs(source: MaybeRefOrGetter<{ layers: Array<{ id: string; text?: string; fields?: Record<string, string> }> }>) {
  const missingGlyphsByLayer = computed<Record<string, string[]>>(() => Object.fromEntries(
    toValue(source).layers.map(layer => [layer.id, missingGlyphsOf(layer)]).filter(([, chars]) => chars.length),
  ))
  const missingGlyphs = computed(() => [...new Set(Object.values(missingGlyphsByLayer.value).flat())])
  return { missingGlyphs, missingGlyphsByLayer }
}
