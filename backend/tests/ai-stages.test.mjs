/**
 * AI 环节静态标定（Issue #51）：
 * 1. 源码扫描 —— 每一处 runAgent( / callTextChat( / expandWithTextModel( 调用所在的文件
 *    都必须在 AI_CALL_SITES 登记，且登记的环节都存在于 AI_STAGES。新增 AI 环节漏标会红。
 * 2. 每个调用点文件都必须真的经过 resolveStageModel 选模型（不能再直接 getTextConfig）。
 * 3. resolveStageModel 的选择规则：非视觉沿用默认，视觉强制换视觉配置，没有就抛 400 错误。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readdirSync, readFileSync, statSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
const srcRoot = path.join(backendRoot, 'src')

/** 调用点识别用的三个入口：Agent 通道、视觉直连、H3 直连 */
const CALL_PATTERNS = [/\brunAgent\s*\(/, /\bcallTextChat\s*\(/, /\bexpandWithTextModel\s*\(/]
/** 入口本身的定义处与登记表自己，不是调用点 */
const DEFINITION_FILES = new Set(['agents/run.ts', 'services/vision-chat.ts', 'services/ai-stages.ts'])

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

function scanCallSites() {
  const files = []
  for (const full of walk(srcRoot)) {
    const rel = path.relative(srcRoot, full).split(path.sep).join('/')
    if (DEFINITION_FILES.has(rel)) continue
    const source = readFileSync(full, 'utf8')
    // 注释（含本文件自己的说明）与定义行不算调用
    const lines = source.split('\n')
      .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .filter(line => !/\bfunction\s+\w+\s*\(/.test(line))
    if (CALL_PATTERNS.some(re => lines.some(line => re.test(line)))) files.push({ rel, source })
  }
  return files
}

function run(script) {
  const out = execFileSync('node', [
    '--experimental-test-module-mocks', '--no-warnings', '--import', 'tsx', '--input-type=module', '--eval', script,
  ], { cwd: backendRoot, encoding: 'utf8', env: { ...process.env, SQLITE_PATH: path.join(mkdtempSync(path.join(tmpdir(), 'ai-stages-')), 'test.sqlite3') } })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

const registry = run(`
  import { AI_STAGES, AI_CALL_SITES } from './src/services/ai-stages.ts'
  process.stdout.write('@@' + JSON.stringify({ stages: AI_STAGES, callSites: AI_CALL_SITES }))
`)

test('every runAgent/callTextChat/expandWithTextModel call site is registered in AI_CALL_SITES', () => {
  const scanned = scanCallSites().map(f => f.rel).sort()
  const registered = Object.keys(registry.callSites).sort()
  assert.deepEqual(scanned, registered,
    `调用点与 AI_CALL_SITES 不一致。新增 AI 环节必须在 services/ai-stages.ts 登记。\n扫描到：${scanned.join(', ')}`)
})

test('every registered stage exists in AI_STAGES with a vision flag and label', () => {
  for (const [file, stages] of Object.entries(registry.callSites)) {
    assert.ok(stages.length, `${file} 没有登记任何环节`)
    for (const stage of stages) {
      const spec = registry.stages[stage]
      assert.ok(spec, `${file} 登记了未知环节 ${stage}`)
      assert.equal(typeof spec.vision, 'boolean', `${stage} 缺少 vision 标定`)
      assert.ok(spec.label, `${stage} 缺少 label`)
    }
  }
})

test('every call site file resolves its model through resolveStageModel', () => {
  for (const { rel, source } of scanCallSites()) {
    assert.ok(source.includes('resolveStageModel('),
      `${rel} 有 AI 调用但没经过 resolveStageModel 选模型`)
    assert.ok(!/\bgetTextConfig\s*\(/.test(source),
      `${rel} 仍在直接用 getTextConfig()，应改走 resolveStageModel`)
  }
})

test('documentary storyboard_breaker and design_card are vision stages; drama breaker is not', () => {
  assert.equal(registry.stages.storyboard_breaker_documentary.vision, true)
  assert.equal(registry.stages.design_card.vision, true)
  assert.equal(registry.stages.storyboard_breaker.vision, false)
  assert.equal(registry.stages.keyframe_prompts.vision, false)
  assert.equal(registry.stages.h3_prompt.vision, false)
})

test('resolveStageModel: vision stage forces a vision config and fails loudly without one', () => {
  const r = run(`
    import { mock } from 'node:test'
    const AI = new URL('./src/services/ai.ts', 'file://${backendRoot}').href
    const CAP = new URL('./src/services/vision-capability.ts', 'file://${backendRoot}').href
    const GLM = { id: 1, name: 'GLM', provider: 'openai', baseUrl: 'http://x/v1', apiKey: 'k', model: 'glm-5.3', vision: false }
    const DS = { configId: 10, name: 'DeepSeek', provider: 'openai', baseUrl: 'http://y/v1', apiKey: 'k', model: 'deepseek-chat' }
    let visionConfig = DS
    mock.module(AI, { namedExports: {
      getActiveConfig: async () => GLM,
      getConfigById: async (id) => (id === 1 ? GLM : null),
    } })
    mock.module(CAP, { namedExports: { resolveVisionTextConfig: async () => visionConfig } })

    const { resolveStageModel, StageVisionUnavailableError } = await import('./src/services/ai-stages.ts')
    const out = {}
    const text = await resolveStageModel('keyframe_prompts', { configId: 1, model: 'glm-5.3' })
    out.text = { configId: text.configId, model: text.model, vision: text.vision }
    // 顶栏选了 GLM，视觉环节仍然换成 DeepSeek，且丢掉 GLM 的模型名
    const vision = await resolveStageModel('design_card', { configId: 1, model: 'glm-5.3' })
    out.vision = { configId: vision.configId, model: vision.model, vision: vision.vision, name: vision.name }
    visionConfig = null
    try {
      await resolveStageModel('design_card', {})
      out.error = null
    } catch (err) {
      out.error = { name: err.name, isStageError: err instanceof StageVisionUnavailableError, message: err.message }
    }
    process.stdout.write('@@' + JSON.stringify(out))
  `)
  assert.deepEqual(r.text, { configId: 1, model: 'glm-5.3', vision: false })
  assert.deepEqual(r.vision, { configId: 10, model: 'deepseek-chat', vision: true, name: 'DeepSeek' })
  assert.equal(r.error.isStageError, true)
  assert.match(r.error.message, /需要视觉模型/)
})
