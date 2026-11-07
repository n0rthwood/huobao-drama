/**
 * 中文友好的文本差异（Issue #70）——改写阶段预览唯一的 diff 实现。
 *
 * 口径：先按段落对齐（Myers），再对「改写段」做词元级差异；词元是
 * 「连续西文/数字」「连续空白」「单个汉字或标点」，所以中文插入、删除、标点与
 * 换段都能定位到具体字，而不是整段红绿。它不理解语义——语义判断属于边界报告与人工审稿。
 *
 * 规模保护：段落对或整体差异超过 MAX_D 步时，退回「整段替换」，宁可粗一点也不卡住页面。
 */

const MAX_D = 2000

/** Myers O(ND) 差异：返回 [{ type:'equal'|'delete'|'insert', items:[...] }]；超限返回 null */
function diffSequence(a, b, same) {
  const n = a.length
  const m = b.length
  const max = n + m
  if (max === 0) return []
  if (max > MAX_D * 2) return null
  const offset = max
  const v = new Int32Array(2 * max + 1)
  const trace = []
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) x = v[k + 1 + offset]
      else x = v[k - 1 + offset] + 1
      let y = x - k
      while (x < n && y < m && same(a[x], b[y])) { x++; y++ }
      v[k + offset] = x
      if (x >= n && y >= m) return backtrack(trace, a, b, offset, d)
    }
    if (d >= MAX_D) return null
  }
  return null
}

function backtrack(trace, a, b, offset, d) {
  const ops = []
  let x = a.length
  let y = b.length
  for (let depth = d; depth > 0; depth--) {
    const v = trace[depth]
    const k = x - y
    let prevK
    if (k === -depth || (k !== depth && v[k - 1 + offset] < v[k + 1 + offset])) prevK = k + 1
    else prevK = k - 1
    const prevX = v[prevK + offset]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) { ops.push({ type: 'equal', a: a[--x], b: b[--y] }); }
    if (depth > 0) {
      if (x === prevX) ops.push({ type: 'insert', b: b[--y] })
      else ops.push({ type: 'delete', a: a[--x] })
    }
  }
  while (x > 0 && y > 0) ops.push({ type: 'equal', a: a[--x], b: b[--y] })
  while (x > 0) ops.push({ type: 'delete', a: a[--x] })
  while (y > 0) ops.push({ type: 'insert', b: b[--y] })
  ops.reverse()
  return ops
}

/** 词元切分：西文/数字成词，空白成块，中文与标点逐字 */
export function tokenize(text) {
  return String(text || '').match(/[A-Za-z0-9]+|[ \t]+|[\s\S]/g) || []
}

/** 段落切分：保留空行作为显式分段信号（改写会显式重新分段，不能被吞掉） */
export function splitParagraphs(text) {
  const value = String(text ?? '')
  if (!value) return []
  return value.split('\n')
}

/**
 * 词元级差异 → [{ type:'equal'|'insert'|'delete', text }]，相邻同类合并。
 * 超限时退回整体替换（删一段、插一段）。
 */
export function diffTokens(before, after) {
  const a = tokenize(before)
  const b = tokenize(after)
  const ops = diffSequence(a, b, (x, y) => x === y)
  if (!ops) {
    const out = []
    if (before) out.push({ type: 'delete', text: before })
    if (after) out.push({ type: 'insert', text: after })
    return out
  }
  const segs = []
  for (const op of ops) {
    const text = op.type === 'insert' ? op.b : op.a
    const last = segs[segs.length - 1]
    if (last && last.type === op.type) last.text += text
    else segs.push({ type: op.type, text })
  }
  return segs
}

/** 两段相似到可以做「改写」而不是「删+增」：共同词元占比过半 */
function similar(a, b) {
  if (!a || !b) return false
  const shorter = Math.min(a.length, b.length)
  const longer = Math.max(a.length, b.length)
  if (longer > 4000) return false
  if (shorter / longer < 0.35) return false
  const segs = diffTokens(a, b)
  let equal = 0
  let changed = 0
  for (const seg of segs) {
    if (seg.type === 'equal') equal += seg.text.length
    else changed += seg.text.length
  }
  return equal > 0 && equal >= changed
}

/**
 * 段落级差异行：
 * `{ type:'equal'|'insert'|'delete'|'change', before, after, inline:{before,after}|null, beforeIndex, afterIndex }`
 * `change` 行带词元级 inline 差异；插入/删除整段时 inline 为 null。
 */
export function diffParagraphs(before, after) {
  const a = splitParagraphs(before)
  const b = splitParagraphs(after)
  const ops = diffSequence(a, b, (x, y) => x === y)
  const rows = []
  if (!ops) {
    // 段落层面都超限：只报告「整篇替换」，不再逐字计算
    if (before) rows.push({ type: 'delete', before, after: '', inline: null, beforeIndex: 0, afterIndex: -1 })
    if (after) rows.push({ type: 'insert', before: '', after, inline: null, beforeIndex: -1, afterIndex: 0 })
    return rows
  }
  let ai = 0
  let bi = 0
  let i = 0
  while (i < ops.length) {
    const op = ops[i]
    if (op.type === 'equal') {
      rows.push({ type: 'equal', before: op.a, after: op.b, inline: null, beforeIndex: ai++, afterIndex: bi++ })
      i += 1
      continue
    }
    // 连续的删除 + 插入收成一个块，再两两配对成「改写行」
    const deletes = []
    const inserts = []
    while (i < ops.length && ops[i].type === 'delete') { deletes.push(ops[i].a); i += 1 }
    while (i < ops.length && ops[i].type === 'insert') { inserts.push(ops[i].b); i += 1 }
    let di = 0
    let ii = 0
    while (di < deletes.length && ii < inserts.length) {
      const left = deletes[di]
      const right = inserts[ii]
      if (similar(left, right)) {
        const segs = diffTokens(left, right)
        rows.push({
          type: 'change',
          before: left,
          after: right,
          inline: {
            before: segs.filter(s => s.type !== 'insert'),
            after: segs.filter(s => s.type !== 'delete'),
          },
          beforeIndex: ai++,
          afterIndex: bi++,
        })
        di += 1
        ii += 1
        continue
      }
      rows.push({ type: 'delete', before: left, after: '', inline: null, beforeIndex: ai++, afterIndex: -1 })
      di += 1
    }
    while (di < deletes.length) {
      rows.push({ type: 'delete', before: deletes[di++], after: '', inline: null, beforeIndex: ai++, afterIndex: -1 })
    }
    while (ii < inserts.length) {
      rows.push({ type: 'insert', before: '', after: inserts[ii++], inline: null, beforeIndex: -1, afterIndex: bi++ })
    }
  }
  return rows
}

/** 差异统计：新增/删除段数、改写段数、以及字级增删量（跳过版应全为 0） */
export function diffStats(rows) {
  let inserted = 0
  let deleted = 0
  let changed = 0
  let addedChars = 0
  let removedChars = 0
  for (const row of rows) {
    if (row.type === 'insert') { inserted += 1; addedChars += row.after.length }
    else if (row.type === 'delete') { deleted += 1; removedChars += row.before.length }
    else if (row.type === 'change') {
      changed += 1
      for (const seg of row.inline?.after || []) if (seg.type === 'insert') addedChars += seg.text.length
      for (const seg of row.inline?.before || []) if (seg.type === 'delete') removedChars += seg.text.length
    }
  }
  return { inserted, deleted, changed, addedChars, removedChars, identical: !inserted && !deleted && !changed }
}
