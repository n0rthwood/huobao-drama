/**
 * 资料检索 API key（Issue #78）：用户填写值的规范化与对外提示。
 * 关注两类真实风险：粘贴时带进空白/引号的 key 被静默保存；短 key 的「末 4 位提示」泄露大半个 key。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

const script = `
  import { normalizeResearchKey, researchKeyHint } from './src/config/research-sources.ts'
  const attempt = (raw) => { try { return { value: normalizeResearchKey(raw) } } catch (e) { return { error: true } } }
  console.log(JSON.stringify({
    trimmed: attempt('  fakeKEY0123456789abcd  '),
    empty: attempt('   '),
    nil: attempt(null),
    inner: attempt('abc def'),
    quote: attempt('abc"def'),
    short: attempt('abc'),
    nonString: attempt(12345),
    hintLong: researchKeyHint('fakeKEY0123456789abcd'),
    hintShort: researchKeyHint('eightchr'),
    hintNone: researchKeyHint(null),
  }))
`

const r = JSON.parse(execFileSync('npx', ['tsx', '--eval', script], { cwd: backendRoot, encoding: 'utf8' }))

test('首尾空白被去掉，key 本身不变', () => {
  assert.deepEqual(r.trimmed, { value: 'fakeKEY0123456789abcd' })
})

test('空串与 null 表示清除', () => {
  assert.deepEqual(r.empty, { value: null })
  assert.deepEqual(r.nil, { value: null })
})

test('中间空白、引号、过短、非字符串一律拒绝，不静默修正', () => {
  for (const k of ['inner', 'quote', 'short', 'nonString']) assert.deepEqual(r[k], { error: true }, k)
})

test('提示只给末 4 位；短于 12 位的 key 不给任何字符；未配置为 null', () => {
  assert.equal(r.hintLong, 'abcd')
  assert.equal(r.hintShort, '')
  assert.equal(r.hintNone, null)
})
