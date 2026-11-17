/**
 * Issue #110：纪录片 storyboard_breaker 的工具收窄。
 * 拆分/补镜只产出旁白骨架：design_card 范围只给「读上下文 / 读图 / 只写 design_card」，
 * 其他范围只给「读上下文 / 保存骨架 / 读图」，**不给** update_storyboard（补镜越权写提示词的根因）。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

test('documentary storyboard_breaker 工具集：design_card 之外没有 update_storyboard', () => {
  const script = `
    import { storyboardBreakerTools } from './src/agents/index.ts'
    const out = (value) => console.log('@@' + JSON.stringify(value))
    const fakeContext = (values) => ({
      get: (key) => values[key],
      set: () => {},
    })
    const toolsOf = (values) => Object.keys(storyboardBreakerTools(fakeContext(values))).sort()
    out({
      documentarySkeleton: toolsOf({ projectType: 'documentary' }),
      documentaryDesignCard: toolsOf({ projectType: 'documentary', storyboardPromptScope: 'design_card' }),
      drama: toolsOf({ projectType: 'drama' }),
    })
  `
  const text = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot, encoding: 'utf8',
    env: { ...process.env, SQLITE_PATH: '/tmp/toolset-test.sqlite3', HUOBAO_DATA_DIR: '/tmp/toolset-test' },
    timeout: 120000,
  })
  const got = JSON.parse(text.slice(text.lastIndexOf('@@') + 2))
  assert.ok(!got.documentarySkeleton.includes('updateStoryboard'), '补镜/拆分范围不许写提示词')
  assert.ok(got.documentarySkeleton.includes('saveStoryboards'), '骨架仍可保存')
  assert.ok(got.documentarySkeleton.includes('readStoryboardContext'))
  assert.ok(got.documentaryDesignCard.includes('readStoryboardContext'), '设计卡范围：读上下文 + 读图 + 只写 design_card')
  assert.ok(got.documentaryDesignCard.includes('updateStoryboard'))
  assert.ok(!got.documentaryDesignCard.includes('saveStoryboards'), '设计卡范围不许重拆整集')
  assert.ok(got.drama.includes('updateStoryboard'), '剧情项目的拆分工具与改动前一致')
})
