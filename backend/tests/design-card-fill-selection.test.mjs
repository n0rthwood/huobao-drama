/**
 * POST /episodes/:id/design-cards/fill 的模型选择口径（Issue #87 B）：
 * auto = 本次没有显式指定（顶栏 localStorage 残留不算用户主动选择）→ 忽略 config_id / model；
 * pinned = 用户此次明确指定 → 必须带正整数 config_id，模型名原样交给调度器校验；
 * 非法 model_mode 直接报错，不悄悄降级成 auto。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(body) {
  const script = `
    import { parseFillModelSelection } from './src/routes/design-cards.ts'
    const out = (value) => console.log('@@' + JSON.stringify(value))
    ${body}
  `
  const text = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, SQLITE_PATH: path.join(mkdtempSync(path.join(tmpdir(), 'fill-selection-')), 'test.sqlite3') },
  })
  return JSON.parse(text.slice(text.lastIndexOf('@@') + 2))
}

test('auto 模式忽略顶栏残留的 config_id / model', () => {
  const result = run(`out({
    bare: parseFillModelSelection({}),
    stale: parseFillModelSelection({ model_mode: 'auto', config_id: 10, model: 'deepseek-chat' }),
  })`)
  assert.deepEqual(result.bare, { mode: 'auto' })
  assert.deepEqual(result.stale, { mode: 'auto' })
})

test('pinned 模式带 config_id 才成立，模型名透传', () => {
  const result = run(`out({
    ok: parseFillModelSelection({ model_mode: 'pinned', config_id: 14, model: 'glm-5.3' }),
    noModel: parseFillModelSelection({ model_mode: 'pinned', config_id: 14 }),
    blankModel: parseFillModelSelection({ model_mode: 'pinned', config_id: 14, model: '  ' }),
    noConfig: parseFillModelSelection({ model_mode: 'pinned' }),
    badConfig: parseFillModelSelection({ model_mode: 'pinned', config_id: 0 }),
  })`)
  assert.deepEqual(result.ok, { mode: 'pinned', configId: 14, model: 'glm-5.3' })
  assert.deepEqual(result.noModel, { mode: 'pinned', configId: 14 })
  assert.deepEqual(result.blankModel, { mode: 'pinned', configId: 14 })
  assert.ok(result.noConfig.error.includes('config_id'))
  assert.ok(result.badConfig.error.includes('config_id'))
})

test('不传 model_mode 的老客户端：带 config_id 视为显式指定', () => {
  const result = run(`out(parseFillModelSelection({ config_id: 14, model: 'glm-5.3' }))`)
  assert.deepEqual(result, { mode: 'pinned', configId: 14, model: 'glm-5.3' })
})

test('非法 model_mode 直接报错，不降级成 auto', () => {
  const result = run(`out(parseFillModelSelection({ model_mode: 'bogus', config_id: 14 }))`)
  assert.ok(result.error.includes('model_mode'))
  assert.ok(result.error.includes('bogus'))
})
