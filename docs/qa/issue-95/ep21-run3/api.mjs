#!/usr/bin/env bun
// Logged read/write helper for the production huobao API (Issue #95 ep21 run3 evidence).
// usage: bun api.mjs <intent> <METHOD> <path> [bodyFileOrJson|-] [saveTo]
// appends one line per call to requests.jsonl (same directory).
import fs from 'node:fs'
import path from 'node:path'

const BASE = 'http://172.30.3.164/huobao/api/v1'
const DIR = '/home/joysort/projects/huobao-drama-issue-95/docs/qa/issue-95/ep21-run3'
const [intent, method, p, bodyArg, saveTo] = process.argv.slice(2)
if (!intent || !method || !p) { console.error('usage: api.mjs <intent> <METHOD> <path> [body|-] [saveTo]'); process.exit(2) }
let body = null
if (bodyArg && bodyArg !== '-') {
  body = bodyArg.trim().startsWith('{') || bodyArg.trim().startsWith('[') ? bodyArg : fs.readFileSync(bodyArg, 'utf8')
}
const res = await fetch(BASE + p, {
  method,
  headers: body ? { 'content-type': 'application/json' } : {},
  body: body ?? undefined,
})
const ct = res.headers.get('content-type') || ''
const text = await res.text()
if (saveTo) fs.writeFileSync(saveTo, text)
let parsed = null
try { parsed = JSON.parse(text) } catch { parsed = null }
const entry = {
  at: new Date().toISOString(),
  intent,
  method,
  path: p,
  body_keys: body ? Object.keys(JSON.parse(body)) : [],
  body: body ? body.slice(0, 2000) : undefined,
  status: res.status,
  content_type: ct,
  first_choice: text.slice(0, 900),
}
fs.appendFileSync(path.join(DIR, 'requests.jsonl'), JSON.stringify(entry) + '\n')
if (!ct.includes('json')) { console.error(`NON-JSON CONTENT-TYPE: ${ct}`); console.error(text.slice(0, 500)); process.exit(3) }
console.log(JSON.stringify({ status: res.status, ct, data: parsed }))
