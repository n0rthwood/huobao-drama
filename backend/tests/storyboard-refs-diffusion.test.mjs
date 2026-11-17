/**
 * Issue #110：参考素材一致性问题（纯函数）。
 * - 忠实素材 / 地图绑到生成目标 → 阻断 `faithful_in_diffusion`，进 blockingIssuesFor；
 * - 装配参考图时不发这类图（targetAssetRefs）；
 * - 纪录片中帧时刻落在生成段外 → 阻断 `mid_time_out_of_range`（按生成段长度判）。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(body) {
  const script = `
    import { computeRefIssues, targetAssetRefs, blockingIssuesFor } from './src/services/storyboard-assets.ts'
    const out = (value) => console.log('@@' + JSON.stringify(value))
    const assets = [
      { kind: 'character', id: 25, name: '利哈列夫', defaultImage: 'static/char.png' },
      { kind: 'prop', id: 258, name: '蒙古汗国地图', defaultImage: 'static/map.png', diffusionBlocked: true },
      { kind: 'prop', id: 269, name: '船队版画', defaultImage: 'static/print.png', diffusionBlocked: true },
      { kind: 'prop', id: 272, name: '普通道具', defaultImage: 'static/prop.png' },
    ]
    const prompts = (text) => ({
      first_frame_prompt: text, mid_frame_prompt: text, last_frame_prompt: text,
      video_prompt: '镜头里 @利哈列夫 站着', transition_prompt: '',
    })
    const bindings = { first: [], mid: [], last: [], video: [
      { kind: 'prop', assetId: 258, selectedImage: null },
      { kind: 'prop', assetId: 272, selectedImage: null },
    ] }
    ${body}
  `
  const text = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot, encoding: 'utf8',
  })
  return JSON.parse(text.slice(text.lastIndexOf('@@') + 2))
}

test('绑定到地图/忠实素材的生成目标被阻断，装配参考图时不发这类图', () => {
  const got = run(`
    const issues = computeRefIssues({ prompts: prompts('@利哈列夫 在船头'), assets, bindings, combo: 'B' })
    const blocked = issues.filter(issue => issue.code === 'faithful_in_diffusion')
    out({
      codes: blocked.map(issue => issue.code),
      messages: blocked.map(issue => issue.message),
      fields: blocked.map(issue => issue.fields),
      videoBlocking: blockingIssuesFor(issues, 'video_prompt').map(issue => issue.code),
      refs: targetAssetRefs(assets, bindings.video).map(ref => ref.name),
    })
  `)
  assert.equal(got.codes.length, 1, '地图绑定报一条（普通道具不报）')
  assert.match(got.messages[0], /忠实素材\/地图/)
  assert.ok(got.fields[0].includes('video_prompt'))
  assert.ok(got.videoBlocking.includes('faithful_in_diffusion'), 'blockingIssuesFor 收录新阻断码')
  assert.deepEqual(got.refs, ['普通道具'], '地图不出现在实际发送的参考图里')
})

test('中帧时刻落在生成段之外是阻断；在生成段内不算', () => {
  const got = run(`
    const base = { prompts: prompts('@利哈列夫 站着'), assets, bindings, combo: 'B' }
    const outside = computeRefIssues({ ...base, generatedSegmentSeconds: 5, midFrameTime: 8 })
    const inside = computeRefIssues({ ...base, generatedSegmentSeconds: 5, midFrameTime: 3 })
    const noSegment = computeRefIssues({ ...base, generatedSegmentSeconds: null, midFrameTime: 8 })
    out({
      outside: outside.filter(issue => issue.code === 'mid_time_out_of_range').map(issue => issue.message),
      outsideBlocking: blockingIssuesFor(outside, 'mid_frame_prompt').map(issue => issue.code),
      inside: inside.filter(issue => issue.code === 'mid_time_out_of_range').length,
      noSegment: noSegment.filter(issue => issue.code === 'mid_time_out_of_range').length,
    })
  `)
  assert.equal(got.outside.length, 1)
  assert.match(got.outside[0], /生成段（5s）/)
  assert.ok(got.outsideBlocking.includes('mid_time_out_of_range'), '中帧槽位按提示词字段过滤也命中')
  assert.equal(got.inside, 0)
  assert.equal(got.noSegment, 0, '不是纪录片（没有生成段长度）就不判')
})

test('纪录片视频提示词的时间轴必须覆盖生成段：终点不符或不从 0 起是阻断，A 组合与剧情镜不判', () => {
  const got = run(`
    const withVideo = (text) => ({ ...prompts('@利哈列夫 站着'), video_prompt: text })
    const base = { assets, bindings: { first: [], mid: [], last: [], video: [] }, combo: 'C' }
    const tenOnFive = computeRefIssues({ ...base, prompts: withVideo('0-1秒：空镜\\n1-4秒：推进\\n4-10秒：远航'), generatedSegmentSeconds: 5 })
    const fits = computeRefIssues({ ...base, prompts: withVideo('0-1秒：空镜\\n1-3秒：推进\\n3-5秒：远航'), generatedSegmentSeconds: 5 })
    const lateStart = computeRefIssues({ ...base, prompts: withVideo('1-3秒：推进\\n3-5秒：远航'), generatedSegmentSeconds: 5 })
    const comboA = computeRefIssues({ ...base, combo: 'A', prompts: withVideo('0-10秒：远航'), generatedSegmentSeconds: 5 })
    const drama = computeRefIssues({ ...base, combo: null, prompts: withVideo('0-10秒：远航'), generatedSegmentSeconds: null })
    const pick = (issues) => issues.filter(issue => issue.code === 'video_timeline_mismatch')
    out({
      tenOnFive: pick(tenOnFive).map(issue => issue.message),
      blocking: blockingIssuesFor(tenOnFive, 'video_prompt').map(issue => issue.code),
      fits: pick(fits).length, lateStart: pick(lateStart).length, comboA: pick(comboA).length, drama: pick(drama).length,
    })
  `)
  assert.equal(got.tenOnFive.length, 1)
  assert.match(got.tenOnFive[0], /0–5 秒/)
  assert.match(got.tenOnFive[0], /结束在 10 秒/)
  assert.ok(got.blocking.includes('video_timeline_mismatch'))
  assert.equal(got.fits, 0, '终点等于生成段放行')
  assert.equal(got.lateStart, 1, '不从 0 秒开始也是阻断')
  assert.equal(got.comboA, 0, 'A 组合没有生成段，不判')
  assert.equal(got.drama, 0, '剧情镜没有生成段长度，不判')
})
