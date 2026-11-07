import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('extraction service runs per-target async tasks', () => {
  const svc = read('src/services/extraction.ts')

  // 三类资产目标
  assert.match(svc, /'characters' \| 'scenes' \| 'props'/)
  assert.match(svc, /EXTRACT_TARGETS.*characters.*scenes.*props/s)
  // 任务状态落在 sys_task(type='text')，按 集×类型 判重
  assert.match(svc, /EXTRACT_TASK_KINDS: Record<ExtractTarget, TextTaskKind>/)
  assert.match(svc, /status: 'running' \| 'done' \| 'error'/)
  // 整集重复点击仍去重（补提取/重试用 retryOf 绕过）；任务以 queued 入队并持久化重启参数
  assert.match(svc, /findActiveTextTask\(episodeId, kind\)\) return null/)
  assert.match(svc, /queued: true/)
  assert.match(svc, /restart: \{ kind, args:/)
  assert.match(svc, /withExtractionLock\(/)
  assert.match(svc, /runWithTextTask\(taskId/)
  // 每类资产限定只提取该类型
  assert.match(svc, /本次只提取角色/)
  assert.match(svc, /本次只提取场景/)
  assert.match(svc, /本次只提取道具/)
  // fire-and-forget 异步执行 extractor Agent
  assert.match(svc, /mastra\.getAgent\('extractor'\)/)
  assert.match(svc, /\.then\(async \(result\) => \{[\s\S]*finishTextTask\(taskId, 'completed'/)
  assert.match(svc, /\.catch\(async \(err/)
  // 逐步打印 Agent 进展（工具调用 + 文本），完成时打印汇总
  assert.match(svc, /onStepFinish/)
  assert.match(svc, /-step/)
  assert.match(svc, /toolCalls/)
})

test('extraction tools dedupe by normalized name so near-names reuse existing assets', () => {
  const tools = read('src/agents/tools/extract-tools.ts')
  const names = read('src/services/asset-name.ts')

  // 名册与保存共用归一化：括号定位/别名后缀去除 + 空白/大小写统一
  assert.match(tools, /import \{ normalizeAssetName, normalizeNearName \}/)
  assert.match(names, /normalizeNearName\(name: string\)/)
  assert.match(names, /replace\(\/\[（\(]/) // 中/英文括号字符类
  assert.match(names, /replace\(\/\[\\s/) // 空白字符类
  assert.match(names, /\.toLowerCase\(\)/)
  // 角色保存：精确匹配优先，归一化近名兜底，命中即复用不重复创建
  assert.match(tools, /normalizeNearName\(c\.name\) === normName/)
  assert.match(tools, /matchedViaNorm/)
  assert.match(tools, /save-characters-reuse/)
  // 道具同样按归一化名字复用
  assert.match(tools, /normalizeNearName\(p\.name\) === normName/)
  assert.match(tools, /save-props-reuse/)
  // 场景按 地点+时间 匹配，地点仅做空白/大小写归一化（不删括号）
  assert.match(tools, /normalizeLocation\(loc: string\)/)
  assert.match(tools, /normalizeLocation\(s\.location\) === normLocation/)
  // read_existing_* 返回归一化字段供 Agent 判断复用
  assert.match(tools, /normalized_name: normalizeNearName/)
  assert.match(tools, /normalized_location: normalizeLocation/)
})

test('episodes route exposes async extract endpoints', () => {
  const route = read('src/routes/episodes.ts')

  assert.match(route, /app\.post\('\/:id\/extract'/)
  assert.match(route, /app\.get\('\/:id\/extract-status'/)
  assert.match(route, /target 必须是 characters \/ scenes \/ props/)
  assert.match(route, /startExtraction\(ep\.id, ep\.dramaId, target, \{ model: body\.model/)
  // 顶栏文本模型覆盖经 resolveStageModel 解析后透传到提取 Agent（#51）
  assert.match(read('src/services/extraction.ts'), /resolveStageModel\('extractor', opts\)/)
  assert.match(route, /getExtractionStatus\(id\)/)
})
