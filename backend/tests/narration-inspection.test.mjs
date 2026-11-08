import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const cwd = fileURLToPath(new URL('..', import.meta.url))
function run(code) {
  const script = `import { parseNarrationInspection } from './src/services/script-rewrite/narration-inspection.ts'; import { parseFidelityOutput, evaluateFidelity } from './src/services/script-rewrite/stages.ts'; const out = value => console.log('@@' + JSON.stringify(value)); ${code}`
  const output = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], { cwd, encoding: 'utf8' })
  return JSON.parse(output.slice(output.lastIndexOf('@@') + 2))
}

test('inspection locates only exact fragments from the current draft', () => {
  const result = run(`out(parseNarrationInspection(JSON.stringify({findings:[{text:'参考：ISBN 123',reason:'书目'}, {text:'不存在',reason:'出处'}]}), '据《异域录》记载。\\n参考：ISBN 123'))`)
  assert.deepEqual(result.map(item => item.locatable), [true, false])
  assert.equal(result[0].text, '参考：ISBN 123')
})

test('malformed inspection output fails instead of reporting a clean draft', () => {
  const result = run(`try { parseNarrationInspection('{"findings":[{}]}', '稿'); out(false) } catch { out(true) }`)
  assert.equal(result, true)
})

test('fidelity accepts explained removal and rejects unexplained loss or invalid evidence', () => {
  const result = run(`
    const story = '据《异域录》记载，' + '甲'.repeat(50) + '。'
    const note = '参考：' + '乙'.repeat(40)
    const source = story + '\\n' + note
    const parse = (content, exclusions) => parseFidelityOutput(JSON.stringify({content, exclusions}), source)
    const explained = parse(story, [{text:note, category:'bibliography', reason:'书目尾注'}])
    const report = evaluateFidelity(source, explained.content, [], explained.exclusions)
    let unexplained = false, invalid = false
    try { evaluateFidelity(source, story, [], []) } catch { unexplained = true }
    try { parse(story, [{text:'不存在', category:'bibliography', reason:'书目'}]) } catch { invalid = true }
    out({report, unexplained, invalid})
  `)
  assert.equal(result.report.within_tolerance, true)
  assert.equal(result.report.ai_exclusions[0].category, 'bibliography')
  assert.equal(result.unexplained, true)
  assert.equal(result.invalid, true)
})
