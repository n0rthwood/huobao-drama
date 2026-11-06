import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { unsupportedChars, resolvedText } from '~/utils/layerSvg'

export interface LayerVariablesLike {
  [key: string]: string
}

/** Uses the same bundled-font coverage as the renderer; no browser font probing. */
export function missingGlyphsOf(
  layer: { text?: string; fields?: Record<string, string>; type?: string; variable?: string } | null | undefined,
  variables?: LayerVariablesLike,
): string[] {
  if (!layer) return []
  const variableText = layer.variable ? resolvedText(layer as never, variables) : ''
  const texts = [variableText || layer.text || '', ...Object.values(layer.fields || {})]
  return [...new Set<string>(texts.flatMap(value => unsupportedChars(value)))]
}

export function useMissingGlyphs(
  source: MaybeRefOrGetter<{ layers: Array<{ id: string; text?: string; fields?: Record<string, string>; type?: string; variable?: string }> }>,
  variables?: MaybeRefOrGetter<LayerVariablesLike | undefined>,
) {
  const missingGlyphsByLayer = computed<Record<string, string[]>>(() => Object.fromEntries(
    toValue(source).layers
      .map(layer => [layer.id, missingGlyphsOf(layer, variables ? toValue(variables) : undefined)] as const)
      .filter(([, chars]) => chars.length),
  ))
  const missingGlyphs = computed(() => [...new Set(Object.values(missingGlyphsByLayer.value).flat())])
  return { missingGlyphs, missingGlyphsByLayer }
}
