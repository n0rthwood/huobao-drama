/**
 * 纪录片选角名单（Issue #32）的纯函数行为：
 * - 名单规范化：名字按资产名规则写死，同一个人的别名/带括号定位/空白写法合并成一条；
 * - 名单对账：名单里缺卡的人（missing_from_roster）与名单外被保存的人（not_in_roster）。
 * 只跑纯函数（仓库自带 tsx 子进程），不碰数据库与网络。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

// character-roster.ts 经 text-task.ts 间接 import db：给子进程一个空库路径，纯函数本身不读它
function run(script) {
  const sqlitePath = path.join(mkdtempSync(path.join(tmpdir(), 'roster-')), 'test.sqlite3')
  const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, SQLITE_PATH: sqlitePath },
  })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

const IMPORT = `import { normalizeRoster, diffRosterAgainstSaved, rosterKey, canonicalizeToRoster, rosterProposalDiff, scriptFingerprint } from './src/services/character-roster.ts'`

test('normalizeRoster pins names to the asset-name rules and merges aliases of the same person', () => {
  const result = run(`
    ${IMPORT}
    process.stdout.write('@@' + JSON.stringify(normalizeRoster([
      { name: ' 沃尔孔斯基 ', basis: '沃尔孔斯基奉命北上', reason: '行动：率队北上' },
      { name: '沃尔孔斯基（西伯利亚总督）', basis: '总督签发公文', reason: '决策' },
      { name: '布赫 戈尔', basis: '布赫戈尔带队测绘', reason: '行动' },
      { name: '布赫戈尔', basis: '', reason: '亲历' },
      { name: '彼得一世', basis: '沙皇下令', reason: '决策' },
    ])))
  `)
  // 同一个人只占一条，保留先出现的写法与顺序；空白按资产名规则变成 _
  assert.deepEqual(result.cast.map(e => e.name), ['沃尔孔斯基', '布赫_戈尔', '彼得一世'])
  // 先出现的 basis/reason 为准
  assert.equal(result.cast[0].reason, '行动：率队北上')
  assert.equal(result.cast[0].basis, '沃尔孔斯基奉命北上')
  // 先出现的条目缺字段时用后来的补上（第二条「布赫戈尔」只带 reason）
  assert.equal(result.cast[1].basis, '布赫戈尔带队测绘')
  assert.equal(result.cast[1].reason, '行动')
  assert.deepEqual(result.merged, ['沃尔孔斯基（西伯利亚总督） → 沃尔孔斯基', '布赫戈尔 → 布赫_戈尔'])
  assert.deepEqual(result.skipped, [])
})

test('normalizeRoster drops entries whose name normalises to nothing and reports them', () => {
  const result = run(`
    ${IMPORT}
    process.stdout.write('@@' + JSON.stringify([
      normalizeRoster([{ name: ' @ ', basis: 'x', reason: '行动' }, { name: '康熙', basis: '清帝出兵', reason: '决策' }]),
      normalizeRoster([]),
      normalizeRoster(null),
    ]))
  `)
  const [withJunk, emptyArray, nullish] = result
  assert.deepEqual(withJunk.cast.map(e => e.name), ['康熙'])
  assert.deepEqual(withJunk.skipped, ['@'])
  // 空名单是合法契约（本集谁都不建卡），不是错误
  assert.deepEqual(emptyArray.cast, [])
  assert.deepEqual(nullish.cast, [])
})

test('diffRosterAgainstSaved compares both sides by the near-name key', () => {
  const result = run(`
    ${IMPORT}
    const roster = ['彼得一世', '布赫_戈尔', '测绘员', '沃尔孔斯基']
    process.stdout.write('@@' + JSON.stringify([
      diffRosterAgainstSaved(roster, ['彼得一世（沙皇）', '布赫戈尔', '沃尔孔斯基 ']),
      diffRosterAgainstSaved(roster, ['彼得一世', '布赫_戈尔', '测绘员', '沃尔孔斯基']),
      diffRosterAgainstSaved(roster, ['戈利岑', '戈利岑 ', '雷恩']),
      diffRosterAgainstSaved([], ['彼得一世']),
    ]))
  `)
  const [partial, complete, strangers, emptyRoster] = result
  // 括号定位/空白/下划线写法都算同一个人，只有真缺的人进 missing
  assert.deepEqual(partial.missing_from_roster, ['测绘员'])
  assert.deepEqual(partial.not_in_roster, [])
  assert.deepEqual(complete.missing_from_roster, [])
  assert.deepEqual(complete.not_in_roster, [])
  // 名单外被保存的人要回报；同一个人多次出现只回报一次
  assert.deepEqual(strangers.not_in_roster, ['戈利岑', '雷恩'])
  assert.deepEqual(strangers.missing_from_roster, ['彼得一世', '布赫_戈尔', '测绘员', '沃尔孔斯基'])
  assert.deepEqual(emptyRoster.not_in_roster, ['彼得一世'])
  assert.deepEqual(emptyRoster.missing_from_roster, [])
})

test('rosterKey is the single comparison yardstick: asset-name rules then near-name folding', () => {
  const result = run(`
    ${IMPORT}
    process.stdout.write('@@' + JSON.stringify([
      rosterKey('布赫 戈尔'),
      rosterKey('布赫_戈尔'),
      rosterKey('布赫戈尔'),
      rosterKey('Peter I (Tsar)'),
      rosterKey('peter i'),
      rosterKey('  '),
    ]))
  `)
  const [spaced, underscored, plain, titled, lower, blank] = result
  assert.equal(spaced, plain)
  assert.equal(underscored, plain)
  assert.equal(titled, lower)
  assert.equal(blank, '')
})

test('canonicalizeToRoster pins a drifting spelling back onto the roster name, or rejects it', () => {
  const result = run(`
    ${IMPORT}
    const cast = [
      { name: '沃尔孔斯基', basis: '', reason: '', source: 'agent' },
      { name: '布赫_戈尔', basis: '', reason: '', source: 'human' },
    ]
    process.stdout.write('@@' + JSON.stringify([
      canonicalizeToRoster('沃尔孔斯基（总督）', cast),
      canonicalizeToRoster('布赫 戈尔', cast),
      canonicalizeToRoster('布赫戈尔', cast),
      canonicalizeToRoster('戈利岑', cast),
      canonicalizeToRoster('  ', cast),
    ]))
  `)
  const [titled, spaced, dropped, stranger, blank] = result
  // 名册上的写法是唯一写法：近名一律归位，归不了位的返回 null（= 不建卡）
  assert.equal(titled, '沃尔孔斯基')
  assert.equal(spaced, '布赫_戈尔')
  assert.equal(dropped, '布赫_戈尔')
  assert.equal(stranger, null)
  assert.equal(blank, null)
})

test('rosterProposalDiff reports what the agent would add or drop, and never mutates the roster', () => {
  const result = run(`
    ${IMPORT}
    const cast = normalizeRoster([{ name: '彼得一世' }, { name: '沃尔孔斯基' }, { name: '阿列克谢' }]).cast
    const proposal = normalizeRoster([{ name: '彼得一世（沙皇）' }, { name: '戈利岑' }]).cast
    process.stdout.write('@@' + JSON.stringify({ diff: rosterProposalDiff(cast, proposal), castAfter: cast.map(e => e.name) }))
  `)
  assert.deepEqual(result.diff.proposed_additions, ['戈利岑'])
  assert.deepEqual(result.diff.proposed_removals, ['沃尔孔斯基', '阿列克谢'])
  assert.deepEqual(result.castAfter, ['彼得一世', '沃尔孔斯基', '阿列克谢'])
})

test('normalizeRoster keeps the human source marker and defaults the rest to agent', () => {
  const result = run(`
    ${IMPORT}
    process.stdout.write('@@' + JSON.stringify([
      normalizeRoster([{ name: '康熙' }, { name: '测绘员', source: 'human' }]).cast,
      normalizeRoster([{ name: '康熙' }], 'human').cast,
    ]))
  `)
  const [mixed, humanDefault] = result
  assert.deepEqual(mixed.map(e => e.source), ['agent', 'human'])
  assert.equal(humanDefault[0].source, 'human')
})

test('scriptFingerprint ignores trailing whitespace and CRLF but changes with the text', () => {
  const result = run(`
    ${IMPORT}
    process.stdout.write('@@' + JSON.stringify([
      scriptFingerprint('S1 彼得一世下令\\n'),
      scriptFingerprint('S1 彼得一世下令\\r\\n  '),
      scriptFingerprint('S1 彼得一世下令。'),
      scriptFingerprint(''),
      scriptFingerprint(null),
    ]))
  `)
  const [base, sameCrlf, edited, empty, nullish] = result
  assert.equal(sameCrlf, base)
  assert.notEqual(edited, base)
  // 剧本为空时没有指纹：不会把「空剧本」判成名册过期
  assert.equal(empty, '')
  assert.equal(nullish, '')
})
