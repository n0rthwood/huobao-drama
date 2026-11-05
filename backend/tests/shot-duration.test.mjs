import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
import { shotMaxSeconds } from './src/services/shot-duration.ts'
import { planCompose, DEFAULT_COMPOSE_FIT } from './src/services/narration-fit.ts'
import { narrationIssues, sha256 } from './src/services/narration.ts'
const combos = ['A', 'B', 'C', 'D', null]
const text = '历史旁白'
const issues = combos.map(combo => narrationIssues({episodeNarrationEnabled:true,shotNarrationEnabled:true,narrationText:text,combo,meta:{audio:{duration_ms:20000,text_sha256:sha256(text)}}}))
const plans = combos.map(combo => planCompose({dv:24,da:20,t:0,fit:DEFAULT_COMPOSE_FIT,maxSeconds:shotMaxSeconds(combo)}))
console.log(JSON.stringify({limits:combos.map(shotMaxSeconds),issues,plans}))
`], { cwd, encoding: 'utf8' }))

test('whole shot caps distinguish layer, generated, hybrid, and legacy drama', () => {
  assert.deepEqual(result.limits, [30, 15, 45, 45, 15])
})
test('20 second A narration is valid while B and legacy drama remain capped at 15', () => {
  assert.deepEqual(result.plans.map(plan => plan.blocked), [false, true, false, false, true])
  assert.deepEqual(result.issues.map(issues => issues.some(issue => issue.code === 'narration_too_long')), [false, true, false, false, true])
})
