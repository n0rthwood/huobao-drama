// The inspection is bound to this exact draft; an error is never a clean result.
export async function inspectDraftForSave(draft, inspect) {
  try {
    const result = await inspect(draft)
    if (!result || !Array.isArray(result.findings)) throw new Error('Invalid inspection response')
    return { draft, findings: result.findings, failed: false }
  } catch {
    return { draft, findings: [], failed: true }
  }
}

// Removal is opt-in and only acts on fragments actually present in the frozen draft.
export function applyInspectionChoice(inspection, remove) {
  let content = inspection.draft
  if (remove && !inspection.failed) {
    for (const item of inspection.findings) {
      if (item.locatable && typeof item.text === 'string' && item.text) content = content.replace(item.text, '')
    }
  }
  return content
}
