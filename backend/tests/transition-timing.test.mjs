/**
 * 承接镜头开场转场的时长规则与提示词拼接（Issue #11）。
 * 纯函数在 TS 里，用仓库自带的 tsx 跑一个临时 .mts 入口并以 JSON 回传结果（不碰数据库），
 * 口径与 video-signature.test.mjs 一致。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
const entry = join(mkdtempSync(join(tmpdir(), 'huobao-transition-')), 'entry.mts')
writeFileSync(entry, `
import { composeTransitionPrompt, planTransitionTiming } from '${backendRoot}src/services/transition.ts'

const [kind, payload] = JSON.parse(process.env.TRANSITION_INPUT!)
const out = kind === 'plan'
  ? planTransitionTiming(payload[0], payload[1], payload[2])
  : composeTransitionPrompt(payload[0], payload[1], payload[2], payload[3])
process.stdout.write(JSON.stringify(out))
`)

function run(kind, payload) {
  const out = execFileSync('npx', ['tsx', entry], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, TRANSITION_INPUT: JSON.stringify([kind, payload]) },
  })
  return JSON.parse(out)
}

test('submitted duration is min(content + T, 15) and the mid guide shifts by E', () => {
  // 12 秒 + 3 秒转场 → 提交 15 秒，中间帧 3 秒后移到 6 秒
  assert.deepEqual(run('plan', [3, 12, 3]), {
    seconds: 3, extra: 3, submitDuration: 15, midGuideTime: 6, dropReason: null,
  })
  // 15 秒镜头：转场包含在原时长内（E=0），中间帧不后移
  assert.deepEqual(run('plan', [3, 15, 8]), {
    seconds: 3, extra: 0, submitDuration: 15, midGuideTime: 8, dropReason: null,
  })
  // 13 秒镜头：只能加长 2 秒，转场仍为 3 秒（1 秒与原内容开头重叠）
  assert.deepEqual(run('plan', [3, 13, 6]), {
    seconds: 3, extra: 2, submitDuration: 15, midGuideTime: 8, dropReason: null,
  })
  // 没有中间帧引导时没有约束
  assert.deepEqual(run('plan', [3, 10, null]), {
    seconds: 3, extra: 3, submitDuration: 13, midGuideTime: null, dropReason: null,
  })
})

test('transition shrinks or is dropped when the mid-frame guide is too early', () => {
  assert.equal(run('plan', [3, 12, 1]).seconds, 3)
  const shrunk = run('plan', [3, 15, 2])
  assert.equal(shrunk.seconds, 1.5)
  assert.equal(shrunk.extra, 0)
  const dropped = run('plan', [3, 15, 1])
  assert.equal(dropped.seconds, 0)
  assert.match(dropped.dropReason, /不带转场/)
})

test('final prompt puts the opening transition before the video description', () => {
  assert.equal(
    run('compose', ['放下哑铃', '站起做树式', 3, 3]),
    '开场转场（0–3 秒）：放下哑铃\n随后（自 3 秒起，下列描述的时间整体后移 3 秒）：站起做树式',
  )
})
