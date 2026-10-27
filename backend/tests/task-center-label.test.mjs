/**
 * 任务中心纯函数的行为测试：任务编号（label）与换厂商重试时的 @引用重新渲染。
 * 纯函数在 TS 里，用仓库自带的 tsx 子进程跑并以 JSON 回传结果（不碰数据库）。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(calls) {
  const script = `
    import { composeTaskLabel, composeEpisodeLabel, renderRefPrompt } from './src/services/task-label.ts'
    const fns = { composeTaskLabel, composeEpisodeLabel, renderRefPrompt }
    const calls = JSON.parse(process.env.CALL_INPUT)
    process.stdout.write(JSON.stringify(calls.map(([name, args]) => fns[name](...args))))
  `
  const out = execFileSync('npx', ['tsx', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, CALL_INPUT: JSON.stringify(calls) },
  })
  return JSON.parse(out)
}

test('task labels follow 剧-集-分镜-槽位 numbering', () => {
  const [lastFrame, midFrame, firstFrame, video, textTask, assetImage, noDrama] = run([
    ['composeTaskLabel', [{ type: 'image', targetKind: 'storyboard', dramaTitle: '鼠妈妈', episodeNumber: 2, storyboardNumber: 5, frameType: 'last_frame' }]],
    ['composeTaskLabel', [{ type: 'image', targetKind: 'storyboard', dramaTitle: '鼠妈妈', episodeNumber: 2, storyboardNumber: 5, frameType: 'mid_frame' }]],
    ['composeTaskLabel', [{ type: 'image', targetKind: 'storyboard', dramaTitle: '鼠妈妈', episodeNumber: 2, storyboardNumber: 5, frameType: 'first_frame' }]],
    ['composeTaskLabel', [{ type: 'video', targetKind: 'storyboard', dramaTitle: '鼠妈妈', episodeNumber: 2, storyboardNumber: 5 }]],
    ['composeTaskLabel', [{ type: 'text', targetKind: 'episode', dramaTitle: '鼠妈妈', episodeNumber: 2, kind: 'storyboard_breaker' }]],
    ['composeTaskLabel', [{ type: 'image', targetKind: 'character', dramaTitle: '鼠妈妈', targetName: '鼠妈妈本尊' }]],
    ['composeTaskLabel', [{ type: 'image', targetKind: 'character', dramaTitle: '', targetName: '' }]],
  ])

  assert.equal(lastFrame, '《鼠妈妈》E02-#05 · 尾帧')
  assert.equal(midFrame, '《鼠妈妈》E02-#05 · 中间帧')
  assert.equal(firstFrame, '《鼠妈妈》E02-#05 · 首帧')
  assert.equal(video, '《鼠妈妈》E02-#05 · 视频')
  assert.equal(textTask, '《鼠妈妈》E02 · 拆分分镜')
  // 资产出图属于整剧，不带集号
  assert.equal(assetImage, '《鼠妈妈》· 角色 · 鼠妈妈本尊')
  assert.equal(noDrama, '《未命名剧集》· 角色 · 未命名')
})

test('episode-level labels are shared by batches and exports', () => {
  const [keyframeBatch, noEpisode] = run([
    ['composeEpisodeLabel', ['鼠妈妈', 12, '关键帧批量']],
    ['composeEpisodeLabel', [null, null, '导出合成']],
  ])

  assert.equal(keyframeBatch, '《鼠妈妈》E12 · 关键帧批量')
  assert.equal(noEpisode, '《未命名剧集》· 导出合成')
})

test('retry re-renders @refs in the new provider reference syntax', () => {
  const refs = { 鼠妈妈: 2, 鼠妈: 1, 厨房: 3 }
  const source = '写实风格，\n@鼠妈妈 站在 @厨房 里，@鼠妈 在旁边，@路人甲 路过'
  const [qwen, other, video, noRefs] = run([
    ['renderRefPrompt', [source, refs, { type: 'image', provider: 'qwen-jobs' }]],
    ['renderRefPrompt', [source, refs, { type: 'image', provider: 'volcengine' }]],
    ['renderRefPrompt', [source, refs, { type: 'video', provider: 'comfyui' }]],
    ['renderRefPrompt', [source, {}, { type: 'image', provider: 'qwen-jobs' }]],
  ])

  // 最长名字优先：@鼠妈妈 不能被 @鼠妈 抢走；未知引用原样保留
  assert.equal(qwen, '写实风格，\n<image2>鼠妈妈 站在 <image3>厨房 里，<image1>鼠妈 在旁边，@路人甲 路过')
  assert.equal(other, '写实风格，\n图片2鼠妈妈 站在 图片3厨房 里，图片1鼠妈 在旁边，@路人甲 路过')
  assert.equal(video, '写实风格，\n@图片2鼠妈妈 站在 @图片3厨房 里，@图片1鼠妈 在旁边，@路人甲 路过')
  // 没有参考图索引时原样返回（旧任务无 refNameIndex 时退回最终提示词的降级路径）
  assert.equal(noRefs, source)
})
