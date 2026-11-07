import test from 'node:test'
import assert from 'node:assert/strict'

import { diffParagraphs, diffStats, diffTokens, splitParagraphs } from '../app/utils/textDiff.js'


test('skip copy shows an empty diff: identical bytes produce no insert/delete/change rows', () => {
  const text = '第一段。\n第二段。'
  const rows = diffParagraphs(text, text)
  assert.deepEqual(rows.map(row => row.type), ['equal', 'equal'])
  assert.equal(diffStats(rows).identical, true)
})

test('a bridge sentence inserted at a paragraph head is reported as a change with char-level location', () => {
  const before = '汉代开凿了这条运河。\n唐代漕运量大幅增加。'
  const after = '汉代开凿了这条运河。\n沿着同一条水道，唐代漕运量大幅增加。'
  const rows = diffParagraphs(before, after)
  assert.deepEqual(rows.map(row => row.type), ['equal', 'change'])
  const inserted = rows[1].inline.after.filter(seg => seg.type === 'insert').map(seg => seg.text).join('')
  assert.equal(inserted, '沿着同一条水道，')
  // 前驱一侧不得凭空出现插入段：删除线只标真正被删掉的字
  assert.equal(rows[1].inline.before.some(seg => seg.type === 'insert'), false)
  const stats = diffStats(rows)
  assert.equal(stats.addedChars, '沿着同一条水道，'.length)
  assert.equal(stats.removedChars, 0)
  assert.equal(stats.identical, false)
})

test('a whole added paragraph is an insert row, a removed one is a delete row', () => {
  const rows = diffParagraphs('甲。\n乙。', '甲。\n丙。\n乙。')
  assert.deepEqual(rows.map(row => row.type), ['equal', 'insert', 'equal'])
  assert.equal(rows[1].after, '丙。')

  const removed = diffParagraphs('甲。\n丙。\n乙。', '甲。\n乙。')
  assert.deepEqual(removed.map(row => row.type), ['equal', 'delete', 'equal'])
  assert.equal(removed[1].before, '丙。')
})

test('Chinese punctuation and repeated sentences stay readable: only the changed characters are marked', () => {
  const segs = diffTokens('他来了，他走了。', '他来了。他走了。')
  const deleted = segs.filter(seg => seg.type === 'delete').map(seg => seg.text).join('')
  const inserted = segs.filter(seg => seg.type === 'insert').map(seg => seg.text).join('')
  assert.equal(deleted, '，')
  assert.equal(inserted, '。')
  const equal = segs.filter(seg => seg.type === 'equal').map(seg => seg.text).join('')
  assert.equal(equal, '他来了他走了。')
})

test('latin words diff by word while CJK diffs by character', () => {
  const segs = diffTokens('P&B 1910 railway', 'P&B 1911 railway')
  assert.deepEqual(
    segs.filter(seg => seg.type !== 'equal').map(seg => [seg.type, seg.text]),
    [['delete', '1910'], ['insert', '1911']],
  )
})

test('explicit re-paragraphing keeps the body text and shows the split, never a silent rewrite', () => {
  const rows = diffParagraphs('上半句。下半句。', '上半句。\n下半句。')
  const kept = rows.map(row => (row.type === 'delete' ? '' : row.after)).join('')
  assert.equal(kept.replace(/\n/g, ''), '上半句。下半句。')
  assert.equal(diffStats(rows).identical, false)
})

test('empty lines survive paragraph splitting so explicit blank separators are comparable', () => {
  assert.deepEqual(splitParagraphs('a\n\nb'), ['a', '', 'b'])
  assert.deepEqual(splitParagraphs(''), [])
})

