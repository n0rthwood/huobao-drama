/**
 * 补全剩余（Issue #52）的行为回归：
 * - `fitNarrationToGaps`：缺口内放行、越界少量自动裁剪、越界过多/已被覆盖则拒存并报精确边界；
 * - 补镜模式的 `save_storyboards`：拒绝 replace_existing、纯插入（绝不 upsert 既有镜）、
 *   旁白必须落在缺口内、同批不许重复领同一段；
 * - `renumberStoryboardsByScript`：中间插入、末尾追加、无变化时不写库、继承首帧的镜头
 *   在「上一镜」变化后取消关键帧确认。
 * 真跑库：临时 SQLITE_PATH + 仓库自带 tsx 子进程，绝不碰开发库。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(script) {
  const dir = mkdtempSync(path.join(tmpdir(), 'storyboard-fill-gaps-'))
  try {
    const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot,
      encoding: 'utf8',
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3') },
    })
    return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// 五句旁白稿：补镜测试删掉第 2、4 句造成中间缺口，删掉第 5 句造成末尾缺口
const S1 = '1715 年秋，沙皇彼得一世把目光投向东方。'
const S2 = '额尔齐斯河是唯一一条能把军队送进腹地的水道。'
const S3 = '这一年冬天，布赫霍尔茨奉命率领近三千人，从托博尔斯克溯流而上。'
const S4 = '斋桑湖以南的草原上，准噶尔的骑兵已经集结。'
const S5 = '塞米巴拉金斯克的木栅在第二年春天立了起来。'
const SCRIPT = ['【开场】', S1, S2, '【远征】', S3, S4, S5].join('\n\n')

const FIXTURE = (shots) => `
  import { initDb, db, schema } from './src/db/index.ts'
  import { eq } from 'drizzle-orm'
  initDb()
  const at = '2026-01-01T00:00:00.000Z'
  const script = ${JSON.stringify(SCRIPT)}
  await db.insert(schema.dramas).values({ id: 1, title: 'doc', projectType: 'documentary', createdAt: at, updatedAt: at })
  await db.insert(schema.episodes).values({ id: 1, dramaId: 1, episodeNumber: 1, title: 'E1', scriptContent: script, narrationEnabled: true, createdAt: at, updatedAt: at })
  await db.insert(schema.storyboards).values(${shots})
`

test('fitNarrationToGaps accepts text inside a gap, trims small overruns and rejects the rest', () => {
  const result = run(`
    import { fitNarrationToGaps, narrationCoverage, scriptMatchKey } from './src/services/narration-first.ts'
    const script = ${JSON.stringify(SCRIPT)}
    const key = scriptMatchKey(script)
    // 第 1/3 句已被领走，第 2/4/5 句是缺口
    const gaps = narrationCoverage(script, [${JSON.stringify(S1)}, ${JSON.stringify(S3)}]).gaps
    const inside = fitNarrationToGaps(key, gaps, ${JSON.stringify(S2)})
    const overrunHead = fitNarrationToGaps(key, gaps, ${JSON.stringify(S1.slice(-6) + S2)})
    const overrunTail = fitNarrationToGaps(key, gaps, ${JSON.stringify(S2 + S3.slice(0, 5))})
    const covered = fitNarrationToGaps(key, gaps, ${JSON.stringify(S1)})
    const rewritten = fitNarrationToGaps(key, gaps, '额尔齐斯河是军队唯一的水路。')
    const tooFar = fitNarrationToGaps(key, gaps, ${JSON.stringify(S1 + S2 + S3 + S4)})
    console.log('@@' + JSON.stringify({
      inside: { status: inside.status, text: inside.text, head: inside.trimmedHead, tail: inside.trimmedTail },
      overrunHead: { status: overrunHead.status, text: overrunHead.text, head: overrunHead.trimmedHead },
      overrunTail: { status: overrunTail.status, text: overrunTail.text, tail: overrunTail.trimmedTail },
      covered: { status: covered.status, reason: covered.reason, gap: covered.gap },
      rewritten: { status: rewritten.status, reason: rewritten.reason },
      tooFar: { status: tooFar.status, reason: tooFar.reason },
      gaps,
    }))
  `)
  assert.equal(result.gaps.length, 2)
  assert.equal(result.inside.status, 'ok')
  assert.equal(result.inside.text, S2)
  assert.equal(result.inside.head + result.inside.tail, 0)
  // 边界容差：多带了上一句的尾巴 / 下一句的开头，自动裁回缺口边界
  assert.equal(result.overrunHead.status, 'ok')
  assert.equal(result.overrunHead.text, S2)
  assert.ok(result.overrunHead.head > 0)
  assert.equal(result.overrunTail.status, 'ok')
  assert.equal(result.overrunTail.text, S2)
  assert.ok(result.overrunTail.tail > 0)
  // 已被既有分镜领走的句子：拒存并报出精确缺口边界
  assert.equal(result.covered.status, 'rejected')
  assert.match(result.covered.reason, /already covered/)
  assert.match(result.covered.reason, new RegExp(`${result.covered.gap.start} to ${result.covered.gap.end}`))
  // 改写过的文本：拒存
  assert.equal(result.rewritten.status, 'rejected')
  assert.match(result.rewritten.reason, /verbatim/)
  // 越界过多（跨过整段已覆盖的旁白）：拒存并给出边界
  assert.equal(result.tooFar.status, 'rejected')
  assert.match(result.tooFar.reason, /uncovered passage runs from character \d+ to \d+/)
})

test('fill-gap mode refuses replace_existing, only inserts and rejects narration outside the gaps', () => {
  const result = run(`
    ${FIXTURE(`[
      { id: 11, episodeId: 1, storyboardNumber: 1, title: 'S1', narrationText: ${JSON.stringify(S1)}, narrationEnabled: true, duration: 8, continuityBoundary: 'cut', createdAt: at, updatedAt: at },
      { id: 12, episodeId: 1, storyboardNumber: 2, title: 'S3', narrationText: ${JSON.stringify(S3)}, narrationEnabled: true, duration: 9, continuityBoundary: 'cut', createdAt: at, updatedAt: at },
    ]`)}
    const { documentaryStoryboardTools } = await import('./src/agents/tools/storyboard-tools.ts')
    const { buildAgentRequestContext } = await import('./src/agents/context.ts')
    const save = documentaryStoryboardTools.saveStoryboards.execute
    const fillCtx = { requestContext: buildAgentRequestContext({ episodeId: 1, dramaId: 1, storyboardFillGaps: true }) }
    const replaceAttempt = await save({
      replace_existing: true,
      storyboards: [{ shot_number: 1, title: '重拆', description: 'x', duration: 8, narration_text: ${JSON.stringify(S2)} }],
    }, fillCtx)
    const afterReplace = (await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, 1))).length
    // 模型给了与既有镜相同的 shot_number：补镜模式必须插入新行，绝不覆写 id 11/12
    const filled = await save({
      storyboards: [
        { shot_number: 1, title: '唯一水道', description: '地图展开', duration: 9, narration_text: ${JSON.stringify(S2)} },
        { shot_number: 2, title: '准噶尔骑兵', description: '草原集结', duration: 8, narration_text: ${JSON.stringify(S4)} },
        { shot_number: 3, title: '抄错的一镜', description: 'x', duration: 6, narration_text: ${JSON.stringify(S1)} },
        { shot_number: 4, title: '同批重复', description: 'x', duration: 6, narration_text: ${JSON.stringify(S2)} },
      ],
    }, fillCtx)
    const rows = (await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, 1)))
      .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
      .map(sb => ({ id: sb.id, n: sb.storyboardNumber, title: sb.title, text: sb.narrationText, continuity: sb.continuityBoundary }))
    console.log('@@' + JSON.stringify({
      replaceError: replaceAttempt.error || null,
      afterReplace,
      fillMode: filled.fill_gaps_mode,
      saved: filled.count,
      rejected: filled.narration_rejected,
      gapsLeft: filled.script_coverage.gaps.length,
      rows,
    }))
  `)
  // replace_existing 被拒：一条分镜都没动
  assert.match(result.replaceError, /replace_existing is forbidden/)
  assert.equal(result.afterReplace, 2)
  assert.equal(result.fillMode, true)
  // 两镜落库（第三镜抄了已覆盖的句子、第四镜与同批重复，都被拒）
  assert.equal(result.saved, 2)
  assert.equal(result.rejected.length, 2)
  assert.match(result.rejected[0].reason, /already covered/)
  assert.match(result.rejected[1].reason, /overlaps text another shot in this same batch/)
  // 纯插入：原有 id 与标题不变，新镜拿到 max+1 起的临时编号
  assert.deepEqual(result.rows.map(r => r.id), [11, 12, 13, 14])
  assert.deepEqual(result.rows.map(r => r.n), [1, 2, 3, 4])
  assert.deepEqual(result.rows.map(r => r.title), ['S1', 'S3', '唯一水道', '准噶尔骑兵'])
  assert.equal(result.rows[2].text, S2)
  // 新插入镜默认硬切
  assert.equal(result.rows[2].continuity, 'cut')
  // 还剩最后一句没人领
  assert.equal(result.gapsLeft, 1)
})

test('renumberStoryboardsByScript reorders by script position, keeps ids and is a no-op when already ordered', () => {
  const result = run(`
    ${FIXTURE(`[
      { id: 11, episodeId: 1, storyboardNumber: 1, title: 'S1', narrationText: ${JSON.stringify(S1)}, duration: 8, continuityBoundary: 'cut', createdAt: at, updatedAt: at },
      { id: 12, episodeId: 1, storyboardNumber: 2, title: 'S3', narrationText: ${JSON.stringify(S3)}, duration: 9, continuityBoundary: 'continue', keyframesConfirmed: true, createdAt: at, updatedAt: at },
      { id: 13, episodeId: 1, storyboardNumber: 3, title: 'S2', narrationText: ${JSON.stringify(S2)}, duration: 7, continuityBoundary: 'cut', createdAt: at, updatedAt: at },
      { id: 14, episodeId: 1, storyboardNumber: 4, title: 'S5', narrationText: ${JSON.stringify(S5)}, duration: 6, continuityBoundary: 'cut', createdAt: at, updatedAt: at },
      { id: 15, episodeId: 1, storyboardNumber: 5, title: '留白', narrationText: '', duration: 4, continuityBoundary: 'cut', createdAt: at, updatedAt: at },
    ]`)}
    const { renumberStoryboardsByScript } = await import('./src/services/storyboard-fill-gaps.ts')
    const snapshot = async () => (await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, 1)))
      .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
      .map(sb => ({ id: sb.id, n: sb.storyboardNumber, title: sb.title, confirmed: sb.keyframesConfirmed === true, updatedAt: sb.updatedAt }))
    const first = await renumberStoryboardsByScript(1)
    const afterFirst = await snapshot()
    const again = await renumberStoryboardsByScript(1)
    const afterAgain = await snapshot()
    console.log('@@' + JSON.stringify({
      firstChanged: first.changed,
      reconfirm: first.reconfirm,
      afterFirst,
      againChanged: again.changed,
      untouched: afterAgain.every((row, i) => row.updatedAt === afterFirst[i].updatedAt),
    }))
  `)
  // 按剧本位置：S1 → S2 → S3 → S5，留白镜沿用「上一镜」的位置留在 S5 之后
  assert.equal(result.firstChanged, 2)
  assert.deepEqual(result.afterFirst.map(r => r.title), ['S1', 'S2', 'S3', 'S5', '留白'])
  assert.deepEqual(result.afterFirst.map(r => r.id), [11, 13, 12, 14, 15])
  assert.deepEqual(result.afterFirst.map(r => r.n), [1, 2, 3, 4, 5])
  // id 12 继承首帧且「上一镜」从 11 变成 13：关键帧确认按既有规则重置
  assert.deepEqual(result.reconfirm, [12])
  assert.equal(result.afterFirst.find(r => r.id === 12).confirmed, false)
  // 已经有序：第二次一行都不写
  assert.equal(result.againChanged, 0)
  assert.equal(result.untouched, true)
})

test('fill-gaps entry is documentary-only, idempotent without gaps and refuses a concurrent run', () => {
  const result = run(`
    ${FIXTURE(`[
      { id: 11, episodeId: 1, storyboardNumber: 1, title: 'S1', narrationText: ${JSON.stringify(S1)}, duration: 8, continuityBoundary: 'cut', createdAt: at, updatedAt: at },
    ]`)}
    const { episodeNarrationCoverage, startFillGapsTask, isCoverageGapFailure } = await import('./src/services/storyboard-fill-gaps.ts')
    const { createTextTask, finishTextTask } = await import('./src/services/text-task.ts')
    const coverage = await episodeNarrationCoverage(1)
    // 已有拆分任务在跑：补镜直接拒绝
    const runningTask = await createTextTask({ kind: 'storyboard_breaker', episodeId: 1, dramaId: 1, prompt: 'x' })
    const whileRunning = await startFillGapsTask(1)
    const coverageRunning = await episodeNarrationCoverage(1)
    await finishTextTask(runningTask, 'failed', { errorMsg: '旁白覆盖缺口：剧本有 2 段未被任何分镜领走' })
    // 剧情项目：没有补镜
    await db.insert(schema.dramas).values({ id: 2, title: 'drama', projectType: 'drama', createdAt: at, updatedAt: at })
    await db.insert(schema.episodes).values({ id: 2, dramaId: 2, episodeNumber: 1, title: 'E', scriptContent: script, createdAt: at, updatedAt: at })
    const dramaFill = await startFillGapsTask(2)
    const dramaCoverage = await episodeNarrationCoverage(2)
    // 全部覆盖：不建任务
    await db.insert(schema.storyboards).values({ id: 12, episodeId: 1, storyboardNumber: 2, title: 'rest', narrationText: ${JSON.stringify([S2, S3, S4, S5].join(''))}, duration: 9, continuityBoundary: 'cut', createdAt: at, updatedAt: at })
    const covered = await startFillGapsTask(1)
    const tasks = await db.select().from(schema.sysTask)
    console.log('@@' + JSON.stringify({
      gapCount: coverage.gap_count,
      uncovered: coverage.uncovered_chars,
      scriptChars: coverage.script_chars,
      whileRunning,
      coverageRunning: coverageRunning.running,
      dramaFill,
      dramaProjectType: dramaCoverage.project_type,
      covered,
      coverageGapFailure: [isCoverageGapFailure('旁白覆盖缺口：剧本有 2 段'), isCoverageGapFailure('Agent 执行失败')],
      taskKinds: tasks.map(t => JSON.parse(t.params || '{}').kind),
    }))
  `)
  assert.equal(result.gapCount, 1)
  assert.ok(result.uncovered > 0 && result.uncovered < result.scriptChars)
  assert.deepEqual(result.whileRunning, { started: false, gaps: 0, reason: 'running' })
  assert.equal(result.coverageRunning, true)
  assert.deepEqual(result.dramaFill, { started: false, gaps: 0, reason: 'not_documentary' })
  assert.equal(result.dramaProjectType, 'drama')
  assert.deepEqual(result.covered, { started: false, gaps: 0, reason: 'covered' })
  assert.deepEqual(result.coverageGapFailure, [true, false])
  // 三次调用都没有建补镜任务（只有测试自己建的那条拆分任务）
  assert.deepEqual(result.taskKinds, ['storyboard_breaker'])
})
