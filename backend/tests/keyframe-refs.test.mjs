/**
 * 参考图 ↔ 提示词一致性与关键帧签名的行为测试（Issue #7）。
 * 纯函数在 TS 里，用仓库自带的 tsx 子进程跑并以 JSON 回传；
 * 被测模块会 import db，所以用 SQLITE_PATH 指向临时库，绝不碰开发库。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
const sqlitePath = path.join(mkdtempSync(path.join(tmpdir(), 'kf-refs-')), 'test.sqlite3')

function call(fn, args) {
  const script = `
    import { computeRefIssues, computeBindingSync, parseMentions, limbRiskIssues } from './src/services/storyboard-assets.ts'
    import { computeKeyframeSignature, signatureFromTask } from './src/services/storyboard-keyframes.ts'
    const api = { computeRefIssues, computeBindingSync, parseMentions, limbRiskIssues, computeKeyframeSignature, signatureFromTask }
    const [fn, args] = JSON.parse(process.env.REFS_INPUT)
    process.stdout.write('@@' + JSON.stringify(api[fn](...args)))
  `
  const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, SQLITE_PATH: sqlitePath, REFS_INPUT: JSON.stringify([fn, args]) },
  })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

const asset = (kind, id, name, imageUrl = `/files/${name}.png`) => ({ kind, id, name, imageUrl })
const prompts = (over = {}) => ({
  first_frame_prompt: '', mid_frame_prompt: '', last_frame_prompt: '', video_prompt: '', ...over,
})

test('mentions match the longest asset name first', () => {
  const result = call('parseMentions', ['@小明妈妈 看着 @小明，@路人甲 走开', ['小明', '小明妈妈']])
  assert.deepEqual(result.matched, ['小明妈妈', '小明'])
  assert.deepEqual(result.unknown, ['路人甲'])
})

test('all four prompts empty keeps the existing bindings', () => {
  const result = call('computeBindingSync', [{
    prompts: prompts(),
    assets: [asset('character', 1, '小明'), asset('character', 2, '小红')],
    sceneId: null,
    characterIds: [1, 2],
    propIds: [],
  }])
  assert.equal(result.changed, false)
  assert.deepEqual(result.characterIds, [1, 2])
  assert.deepEqual(result.unbound, [])
})

test('prompt mentions override explicitly supplied binding ids', () => {
  const result = call('computeBindingSync', [{
    prompts: prompts({ first_frame_prompt: '@小红 站在门口' }),
    // 同一请求显式传入的 character_ids
    assets: [asset('character', 1, '小明'), asset('character', 2, '小红'), asset('prop', 5, '钥匙')],
    sceneId: null,
    characterIds: [1],
    propIds: [5],
  }])
  assert.deepEqual(result.characterIds, [2])
  assert.deepEqual(result.propIds, [])
  assert.deepEqual(result.bound.map(item => item.name), ['小红'])
  assert.deepEqual(result.unbound.map(item => item.name), ['小明', '钥匙'])
})

test('unknown / unbound / missing image mentions block, unmentioned binding only warns', () => {
  const issues = call('computeRefIssues', [{
    prompts: prompts({
      first_frame_prompt: '@小明 与 @小红 对视，@幽灵 飘过',
      video_prompt: '@钥匙 掉在地上',
    }),
    assets: [
      asset('character', 1, '小明'),
      asset('character', 2, '小红', ''),
      asset('prop', 5, '钥匙'),
      asset('prop', 6, '雨伞'),
    ],
    sceneId: null,
    characterIds: [1, 2],
    propIds: [5, 6],
  }])
  const byCode = Object.fromEntries(issues.map(issue => [issue.code, issue]))
  assert.equal(byCode.unknown_mention.severity, 'block')
  assert.equal(byCode.unknown_mention.name, '幽灵')
  assert.equal(byCode.missing_image.severity, 'block')
  assert.equal(byCode.missing_image.name, '小红')
  assert.deepEqual(byCode.missing_image.fields, ['first_frame_prompt'])
  assert.equal(byCode.unmentioned_binding.severity, 'warn')
  assert.equal(byCode.unmentioned_binding.name, '雨伞')
  assert.equal(issues.some(issue => issue.code === 'unbound_mention'), false)
})

test('mentioning a character that is not bound blocks generation', () => {
  const issues = call('computeRefIssues', [{
    prompts: prompts({ last_frame_prompt: '@小明 回头' }),
    assets: [asset('character', 1, '小明')],
    sceneId: null,
    characterIds: [],
    propIds: [],
  }])
  // video_prompt 为空另外产生 empty_video_prompt（Issue #15），这里只看 @ 引用问题
  const mentionIssues = issues.filter(issue => issue.code !== 'empty_video_prompt')
  assert.equal(mentionIssues.length, 1)
  assert.equal(mentionIssues[0].code, 'unbound_mention')
  assert.equal(mentionIssues[0].severity, 'block')
  assert.deepEqual(mentionIssues[0].fields, ['last_frame_prompt'])
})

test('empty video_prompt blocks only the video field (Issue #15)', () => {
  const issues = call('computeRefIssues', [{
    prompts: prompts({ first_frame_prompt: '客厅全景' }),
    assets: [],
    sceneId: null,
    characterIds: [],
    propIds: [],
  }])
  const empty = issues.find(issue => issue.code === 'empty_video_prompt')
  assert.equal(empty.severity, 'block')
  assert.deepEqual(empty.fields, ['video_prompt'])
})

test('video_prompt present produces no empty_video_prompt issue (Issue #15)', () => {
  const issues = call('computeRefIssues', [{
    prompts: prompts({ video_prompt: '0-3秒：双手扶着桌沿，双腿并拢坐下。' }),
    assets: [],
    sceneId: null,
    characterIds: [],
    propIds: [],
  }])
  assert.equal(issues.some(issue => issue.code === 'empty_video_prompt'), false)
})

test('limb lint warns on negative limb wording and unspecified risky poses (Issue #15)', () => {
  const issues = call('limbRiskIssues', [prompts({
    video_prompt: '0-3秒：猴宝宝盘腿坐在垫子上，看着前方。\n3-6秒：双手合十，不要搞成3条腿。',
  })])
  assert.equal(issues.length, 2)
  assert.ok(issues.every(issue => issue.code === 'limb_risk' && issue.severity === 'warn'))
  assert.ok(issues.every(issue => issue.fields.length === 1 && issue.fields[0] === 'video_prompt'))
})

test('limb lint stays quiet when every risky segment states limb positions (Issue #15)', () => {
  const issues = call('limbRiskIssues', [prompts({
    video_prompt: '0-3秒：双腿向身前收拢盘起，双脚收于身下，双手抱膝。',
  })])
  assert.deepEqual(issues, [])
})

test('mentioning another scene is a blocking conflict and never rebinds the scene', () => {
  const issues = call('computeRefIssues', [{
    prompts: prompts({ first_frame_prompt: '@天台 的夜景' }),
    assets: [asset('scene', 7, '客厅'), asset('scene', 8, '天台')],
    sceneId: 7,
    characterIds: [],
    propIds: [],
  }])
  const conflict = issues.find(issue => issue.code === 'scene_conflict')
  assert.equal(conflict.severity, 'block')
  assert.equal(conflict.asset_id, 8)
  assert.match(conflict.message, /客厅/)

  const sync = call('computeBindingSync', [{
    prompts: prompts({ first_frame_prompt: '@天台 的夜景' }),
    assets: [asset('scene', 7, '客厅'), asset('scene', 8, '天台')],
    sceneId: 7,
    characterIds: [],
    propIds: [],
  }])
  assert.deepEqual(sync.characterIds, [])
  assert.deepEqual(sync.bound, [])
})

test('refs beyond the 9 image limit warn instead of blocking', () => {
  const characters = Array.from({ length: 10 }, (_, index) => asset('character', index + 1, `角色${index + 1}`))
  const mention = characters.map(ch => `@${ch.name}`).join(' ')
  const issues = call('computeRefIssues', [{
    prompts: prompts({ first_frame_prompt: mention, video_prompt: mention }),
    assets: [asset('scene', 7, '客厅'), ...characters],
    sceneId: 7,
    characterIds: characters.map(ch => ch.id),
    propIds: [],
  }])
  const overflow = issues.filter(issue => issue.code === 'over_capacity')
  // 场景占 1 张 → 第 9、10 个角色超出关键帧上限；视频侧首帧再占 1 张 → 第 8 个角色只在视频提示词里超限
  assert.deepEqual(overflow.map(issue => issue.name), ['角色8', '角色9', '角色10'])
  assert.deepEqual(overflow[0].fields, ['video_prompt'])
  assert.deepEqual(overflow[1].fields, ['first_frame_prompt', 'video_prompt'])
  assert.equal(overflow.every(issue => issue.severity === 'warn'), true)
})

const signatureInput = {
  prompt: '风格词，\n图片1小明 走进房间',
  referenceImages: ['/files/a.png', '/files/b.png'],
  size: '1344x768',
  provider: 'qwen-jobs',
  model: 'qwen-image-2.1',
}
const taskOf = (over = {}) => ({
  prompt: signatureInput.prompt,
  provider: signatureInput.provider,
  model: signatureInput.model,
  params: JSON.stringify({ size: signatureInput.size, referenceImages: ['http://host/files/a.png?v=2', '/other/b.png'], frameType: 'first_frame' }),
  ...over,
})

test('an old version with the same content matches the current signature', () => {
  // 参考图只比文件名，换主机/加查询串不算变化
  assert.equal(call('signatureFromTask', [taskOf()]), call('computeKeyframeSignature', [signatureInput]))
})

test('changing the model produces a different signature', () => {
  const other = call('computeKeyframeSignature', [{ ...signatureInput, model: 'qwen-image-plus' }])
  assert.notEqual(other, call('computeKeyframeSignature', [signatureInput]))
  assert.notEqual(other, call('signatureFromTask', [taskOf()]))
})

test('history tasks missing signature fields never match', () => {
  assert.equal(call('signatureFromTask', [taskOf({ params: '{"frameType":"first_frame"}' })]), null)
  assert.equal(call('signatureFromTask', [taskOf({ model: null })]), null)
  assert.equal(call('signatureFromTask', [taskOf({ prompt: null })]), null)
})
