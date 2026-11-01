/**
 * 资产批量选集判定的行为测试（Issue #33 验收 12）。
 * 纯函数在 TS 里，用仓库自带的 tsx 子进程跑一次并以 JSON 回传全部结果（不碰数据库）。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

const script = `
  import {
    classifyAsset, isFaithfulCurrentImage, shouldSubmitImage, summarizeAssetBatchPlan,
  } from './src/services/asset-batch-select.ts'
  const input = JSON.parse(process.env.SELECT_INPUT)
  process.stdout.write(JSON.stringify({
    classify: input.classify.map(([asset, opts]) => classifyAsset(asset, opts)),
    submit: input.submit.map(outcome => shouldSubmitImage(outcome)),
    summary: summarizeAssetBatchPlan(input.plan),
    faithful: input.faithful.map(([asset, versions]) => isFaithfulCurrentImage(asset, versions)),
  }))
`

/** 资产状态：有图/有提示词/忠实素材/在跑 */
const asset = (hasImage, hasPrompt, faithful = false, running = false) => ({ hasImage, hasPrompt, faithful, running })
/** 勾选：重写提示词 / 覆盖已有图片 */
const opts = (rewritePrompts, overwriteImages) => ({ rewritePrompts, overwriteImages })

const classifyCases = [
  // 有图 + 有提示词 + 未勾覆盖 → 跳过；勾了覆盖 → 直接出图
  [asset(true, true), opts(false, false), 'skip_has_image'],
  [asset(true, true), opts(false, true), 'ready'],
  // Q3：有图 + 无提示词 + 未勾覆盖 → 先补提示词（不是 skip_has_image，判定顺序写反会挂掉验收 2）
  [asset(true, false), opts(false, false), 'need_prompt'],
  // 勾「重写提示词」→ 不论有没有图都要重跑提示词
  [asset(true, true), opts(true, false), 'need_prompt'],
  [asset(false, true), opts(true, false), 'need_prompt'],
  // 无图 + 有提示词 → 复用提示词出图；无图 + 无提示词 → 先生成提示词
  [asset(false, true), opts(false, false), 'ready'],
  [asset(false, false), opts(false, false), 'need_prompt'],
  // Q5 忠实素材：勾了覆盖也不碰，优先级最高
  [asset(true, true, true), opts(true, true), 'skip_faithful'],
  [asset(true, false, true), opts(false, true), 'skip_faithful'],
  // 活跃图像任务：无论勾什么都跳过（忠实素材优先级更高）
  [asset(true, true, false, true), opts(true, true), 'skip_running'],
  [asset(false, false, false, true), opts(false, false), 'skip_running'],
]

const submitCases = [
  ['reused', true],
  ['regenerated', true],
  // Q12：重写后逐字相同视为成功，照常出图
  ['unchanged_after_rewrite', true],
  // Q4：提示词失败不出图（库里残留的旧提示词也不许用——prompt 恒为空串）
  ['failed', false],
]

const plan = [
  { kind: 'character', asset_id: 1, name: 'A', selection: 'need_prompt', has_prompt: false },
  { kind: 'character', asset_id: 2, name: 'B', selection: 'need_prompt', has_prompt: true },
  { kind: 'scene', asset_id: 3, name: 'C', selection: 'ready', has_prompt: true },
  { kind: 'scene', asset_id: 4, name: 'D', selection: 'skip_has_image', has_prompt: true },
  { kind: 'prop', asset_id: 5, name: 'E', selection: 'skip_running', has_prompt: true },
  { kind: 'prop', asset_id: 6, name: 'F', selection: 'skip_faithful', has_prompt: true },
]

const faithfulCases = [
  // 当前图就是人工上传的那一版 → 忠实素材
  [{ imageUrl: 'static/uploads/a.png', localPath: 'static/uploads/a.png' },
    [{ provider: 'upload', resultUrl: null, localPath: 'static/uploads/a.png' }], true],
  // 跨项目导入复制出的版本行同样算
  [{ imageUrl: 'static/imported/b.png', localPath: null },
    [{ provider: 'import', resultUrl: 'static/imported/b.png', localPath: null }], true],
  // 当前图是生成版本（上传版本只是历史里的某一版）→ 不保护
  [{ imageUrl: 'static/images/c.png', localPath: 'static/images/c.png' },
    [{ provider: 'qwen-jobs', resultUrl: null, localPath: 'static/images/c.png' },
      { provider: 'upload', resultUrl: null, localPath: 'static/uploads/old.png' }], false],
  // 同一张图既有生成行又有上传行（上传注册复用了同一路径）→ 仍算忠实素材（Q5 宁可多跳过）
  [{ imageUrl: 'static/images/e.png', localPath: 'static/images/e.png' },
    [{ provider: 'qwen-jobs', resultUrl: null, localPath: 'static/images/e.png' },
      { provider: 'upload', resultUrl: null, localPath: 'static/images/e.png' }], true],
  // 当前图找不到对应版本行 → 按生成图处理
  [{ imageUrl: 'static/images/d.png', localPath: null },
    [{ provider: 'upload', resultUrl: null, localPath: 'static/uploads/other.png' }], false],
  // 没有当前图 → 谈不上忠实素材
  [{ imageUrl: '', localPath: null }, [{ provider: 'upload', resultUrl: null, localPath: '' }], false],
]

const out = execFileSync('npx', ['tsx', '--eval', script], {
  cwd: backendRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    SELECT_INPUT: JSON.stringify({
      classify: classifyCases.map(([a, o]) => [a, o]),
      submit: submitCases.map(([outcome]) => outcome),
      plan,
      faithful: faithfulCases.map(([a, versions]) => [a, versions]),
    }),
  },
})
const result = JSON.parse(out)

test('选集判定：need_prompt 排在 skip_has_image 之前，忠实素材与在跑任务优先跳过', () => {
  classifyCases.forEach(([a, o, expected], i) => {
    assert.equal(result.classify[i], expected,
      `hasImage=${a.hasImage} hasPrompt=${a.hasPrompt} faithful=${a.faithful} running=${a.running} rewrite=${o.rewritePrompts} overwrite=${o.overwriteImages}`)
  })
})

test('提示词阶段结论 → 是否出图：只有 failed 不出图', () => {
  submitCases.forEach(([outcome, expected], i) => {
    assert.equal(result.submit[i], expected, outcome)
  })
})

test('分类统计：缺提示词/重写/复用三类进 will_generate，三类跳过分别计数', () => {
  assert.deepEqual(result.summary, {
    total: 6,
    will_generate: { missing_prompt: 1, reuse_prompt: 1, rewrite_prompt: 1 },
    skipped: { has_image: 1, running: 1, faithful: 1 },
  })
})

test('忠实素材：当前图对应的版本行 provider ∈ {upload, import} 才算', () => {
  faithfulCases.forEach(([, , expected], i) => {
    assert.equal(result.faithful[i], expected, `case ${i}`)
  })
})
