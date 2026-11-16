/**
 * 逻辑组（Issue #109）：自然段 = 逻辑组；镜 → 组读时现算；一镜不得跨段只在写入口拒绝。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(body) {
  const script = `
    import { narrationGroupsOf, crossGroupProblems, paragraphSpans } from './src/services/narration-groups.ts'
    const out = (value) => console.log('@@' + JSON.stringify(value))
    ${body}
  `
  const text = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], { cwd: backendRoot, encoding: 'utf8' })
  return JSON.parse(text.slice(text.lastIndexOf('@@') + 2))
}

const SCRIPT = '【开场】\n甲地在北。乙河向东流。\n\n丙城被围。丁军来援。\n\n戊年议和。'

test('镜头按旁白位置归入所在自然段，节拍标记不构成段落', () => {
  const groups = run(`out(narrationGroupsOf(${JSON.stringify(SCRIPT)}, [
    { id: 1, storyboard_number: 1, narration_text: '甲地在北。' },
    { id: 2, storyboard_number: 2, narration_text: '乙河向东流。' },
    { id: 3, storyboard_number: 3, narration_text: '丙城被围。丁军来援。' },
    { id: 4, storyboard_number: 4, narration_text: '戊年议和。' },
  ]))`)
  assert.deepEqual(groups.map(g => [g.group_no, g.shot_ids]), [[1, [1, 2]], [2, [3]], [3, [4]]])
  assert.ok(groups.every(g => g.warnings.length === 0))
})

test('存量跨段镜归起始段并给出 shot_cross_group 警告；定位不到的镜沿用上一镜的组', () => {
  const groups = run(`out(narrationGroupsOf(${JSON.stringify(SCRIPT)}, [
    { id: 1, storyboard_number: 1, narration_text: '甲地在北。乙河向东流。丙城被围。' },
    { id: 2, storyboard_number: 2, narration_text: '被人改写过的旁白' },
    { id: 3, storyboard_number: 3, narration_text: '丁军来援。' },
    { id: 4, storyboard_number: 4, narration_text: '戊年议和。' },
  ]))`)
  assert.deepEqual(groups.map(g => [g.group_no, g.shot_ids]), [[1, [1, 2]], [2, [3]], [3, [4]]])
  assert.deepEqual(groups[0].warnings.map(w => [w.code, w.storyboard_id]), [['shot_cross_group', 1], ['shot_group_unlocated', 2]])
})

test('crossGroupProblems 只报跨段的区间，段内与单段剧本不报', () => {
  const result = run(`
    const spans = paragraphSpans(${JSON.stringify(SCRIPT)})
    const inside = { index: 0, start: spans[0].start, end: spans[0].end }
    const across = { index: 1, start: spans[0].start + 2, end: spans[1].start + 3 }
    out({
      problems: crossGroupProblems(${JSON.stringify(SCRIPT)}, [inside, across]).map(p => [p.index, p.code]),
      single: crossGroupProblems('只有一段。没有第二段。', [{ index: 0, start: 0, end: 5 }]).length,
    })
  `)
  assert.deepEqual(result.problems, [[1, 'cross_group']])
  assert.equal(result.single, 0)
})
