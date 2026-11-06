import test from 'node:test'
import assert from 'node:assert/strict'
import { taskErrorPresentation } from '../app/utils/taskError.js'

const t = (key, values = {}) => ({
  'taskCenter.errorPresentation.outputBlocked': '输出被平台拦截',
  'taskCenter.errorPresentation.inputBlocked': '输入被平台拦截',
  'taskCenter.errorPresentation.contentBlocked': '内容被平台拦截',
  'taskCenter.errorPresentation.noPassage': '平台未提供命中片段或具体分类',
  'taskCenter.errorPresentation.serviceError': `服务失败 ${values.status || ''}`,
}[key] ?? key)
const blocked = role => '文本服务 400: ' + JSON.stringify({ contentFilter: [{ level: 1, role }], error: { code: '1301', message: '平台安全错误' } })

test('moderation explains output/input direction and does not invent the blocked passage', () => {
  const output = taskErrorPresentation(blocked('assistant'), t)
  assert.equal(output.message, '输出被平台拦截\nHTTP 400 · 1301 · assistant / level 1\n平台未提供命中片段或具体分类')
  assert.equal(output.hasDetails, true)
  assert.equal(output.diagnostic, blocked('assistant'))
  assert.match(taskErrorPresentation(blocked('user'), t).message, /^输入被平台拦截/)
  assert.match(taskErrorPresentation(blocked('unknown'), t).message, /^内容被平台拦截/)
})

test('provider errors retain their real message and status without exposing JSON as the summary', () => {
  const result = taskErrorPresentation('HTTP 429: {"error":{"code":"rate_limit","message":"Quota exhausted"}}', t)
  assert.equal(result.message, 'HTTP 429 · rate_limit · Quota exhausted')
  assert.equal(result.hasDetails, true)
  assert.equal(taskErrorPresentation('Connection refused', t).message, 'Connection refused')
})

test('diagnostic and summary redact credentials and remain bounded for copied or expanded errors', () => {
  const raw = 'HTTP 500: {"error":{"message":"failed"},"api_key":"private-value","Authorization":"Bearer abc.DEF-123","url":"https://example.test/?token=private-url&x=1"}'
  const result = taskErrorPresentation(raw, t)
  assert.equal(result.message, 'HTTP 500 · failed')
  for (const secret of ['private-value', 'abc.DEF-123', 'private-url']) assert.equal(result.diagnostic.includes(secret), false)
  assert.match(result.diagnostic, /REDACTED/)
  const long = taskErrorPresentation('x'.repeat(12000) + ' sk-secretSECRETsecretSECRET', t)
  assert.equal(long.diagnostic.length, 8192)
  assert.equal(long.message.length, 8192)
  assert.equal(long.diagnostic.endsWith('…'), true)
})

test('truncated JSON and HTML stay readable with literal bounded diagnostics', () => {
  const malformed = taskErrorPresentation('文本服务 400: {"error":', t)
  assert.equal(malformed.message, '服务失败 HTTP 400')
  const html = taskErrorPresentation('HTTP 502: <html><body>upstream failed</body></html>', t)
  assert.equal(html.message, '服务失败 HTTP 502')
  assert.equal(html.diagnostic, 'HTTP 502: <html><body>upstream failed</body></html>')
})
