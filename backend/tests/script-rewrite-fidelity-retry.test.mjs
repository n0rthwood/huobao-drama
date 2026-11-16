/**
 * 忠实改写的违约纠正（Issue #109）：段落不再限长后，最常见的违例是原文长句没断开。
 * 产出违反单句 80 字上限 → 把违例（超长句给全文）回给模型重写，最多两次；仍不合格才判阶段失败。
 * 本地 OpenAI 兼容桩服务 + 临时 SQLite，断言运行结果与发给模型的纠正提示。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

const S1 = '一五八一年九月初，小叶率领一千三百四十名部众从卡马河沿岸出发，沿着丰富的水道向东进发。'
const S2 = '他们翻过乌拉尔山中部海拔较低的一个山口，抵达山脉东部的塔吉尔河河岸，在那里扎营过冬。'
const RAW = `${S1}${S2}\n\n第二年春天冰雪消融，远征队顺流而下。`

function run(mode) {
  const dir = mkdtempSync(path.join(tmpdir(), 'huobao-fidelity-retry-'))
  const script = `
import http from 'node:http'
import { eq } from 'drizzle-orm'
import { db, schema, initDb } from './src/db/index.ts'
const RAW = ${JSON.stringify(RAW)}
const MODE = ${JSON.stringify(mode)}
const prompts = []
const stub = http.createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    const messages = JSON.parse(body).messages || []
    const user = String((messages[messages.length - 1] || {}).content || '')
    prompts.push(user)
    const prepared = user.split('\\n\\n# 你上一次的输出')[0].slice('【原始内容】'.length).replace(/^\\n/, '')
    const isRetry = user.includes('# 保真契约没有通过')
    // 违例：把第一段两句并成一句（只改标点，字数不变）
    const joined = prepared.replace('进发。', '进发，')
    const content = MODE === 'fix' && isRetry ? prepared : joined
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ content, exclusions: [] }) } }] }))
  })
})
await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve))
stub.unref()
initDb()
const ts = new Date().toISOString()
await db.insert(schema.aiServiceConfigs).values({ id: 1, name: 'stub', serviceType: 'text', provider: 'openai', baseUrl: 'http://127.0.0.1:' + stub.address().port, apiKey: 'k', model: JSON.stringify(['stub-model']), isActive: true, priority: 1, createdAt: ts, updatedAt: ts })
await db.insert(schema.dramas).values({ id: 1, title: 'doc', projectType: 'documentary', createdAt: ts, updatedAt: ts })
await db.insert(schema.episodes).values({ id: 1, dramaId: 1, episodeNumber: 1, title: 'E1', content: RAW, narrationEnabled: true, createdAt: ts, updatedAt: ts })
const runSvc = await import('./src/services/script-rewrite/run.ts')
const store = await import('./src/services/script-rewrite/store.ts')
const started = await runSvc.startRewriteRun(1, { skipStages: ['bridge'] })
let row = null
for (const deadline = Date.now() + 20000; Date.now() < deadline;) {
  row = await store.getRun(started.run_id)
  if (row && (row.status === 'completed' || row.status === 'failed')) break
  await new Promise(resolve => setTimeout(resolve, 25))
}
const fidelity = (await store.listVersions(1)).find(v => v.stageKey === 'fidelity' && v.source === 'agent')
console.log('@@' + JSON.stringify({ status: row.status, error: row.errorMsg ?? row.error ?? null, calls: prompts.length, retryPrompt: prompts[1] || null, content: fidelity ? fidelity.content : null }))
`
  try {
    const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot,
      encoding: 'utf8',
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3'), HUOBAO_DATA_DIR: dir },
    })
    return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('长句违例回给模型纠正一次，改对了就采用纠正后的稿件', () => {
  const result = run('fix')
  assert.equal(result.status, 'completed')
  assert.equal(result.calls, 2)
  assert.match(result.retryPrompt, /第 1 段第 1 句 \d+ 字（上限 80）/)
  assert.ok(result.retryPrompt.includes(`${S1.slice(0, -1)}，${S2}`), '纠正提示里给出超长句全文')
  assert.equal(result.content, RAW)
})

test('两次纠正后仍有长句：阶段判失败，不产出正式版本', () => {
  const result = run('stubborn')
  assert.equal(result.status, 'failed')
  assert.equal(result.calls, 3)
  assert.equal(result.content, null)
})
