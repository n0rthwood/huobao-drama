import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inspectDraftForSave, applyInspectionChoice } from '../app/utils/narrationInspection.js'

test('current draft findings require a choice; removal only deletes located fragments', async () => {
  const draft = '据《异域录》记载。\n参考：ISBN 123'
  const inspection = await inspectDraftForSave(draft, async input => {
    assert.equal(input, draft)
    return { findings: [
      { text: '参考：ISBN 123', reason: '书目', locatable: true },
      { text: '不存在', reason: '出处', locatable: false },
    ] }
  })
  assert.equal(inspection.failed, false)
  assert.equal(applyInspectionChoice(inspection, false), draft)
  assert.equal(applyInspectionChoice(inspection, true), '据《异域录》记载。\n')
})

test('inspection failure is explicit and preserves the draft for an informed save', async () => {
  const inspection = await inspectDraftForSave('正文', async () => { throw new Error('offline') })
  assert.equal(inspection.failed, true)
  assert.equal(applyInspectionChoice(inspection, false), '正文')
  const malformed = await inspectDraftForSave('正文', async () => ({}))
  assert.equal(malformed.failed, true)
})

test('a clean inspection returns no findings', async () => {
  const inspection = await inspectDraftForSave('正文', async () => ({ findings: [] }))
  assert.equal(inspection.failed, false)
  assert.deepEqual(inspection.findings, [])
})
