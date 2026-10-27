import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isNameTaken, suggestUniqueName } from '../../frontend/app/utils/assetName.js'

const root = new URL('..', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')

test('改名规则：名字 → 名字-2 → 名字-3，直到唯一', () => {
  assert.equal(suggestUniqueName('猪爸爸', []), '猪爸爸')
  assert.equal(suggestUniqueName('猪爸爸', ['猪爸爸']), '猪爸爸-2')
  assert.equal(suggestUniqueName('猪爸爸', ['猪爸爸', '猪爸爸-2']), '猪爸爸-3')
  // 中间空位会被填上（-2 空着就用 -2）
  assert.equal(suggestUniqueName('猪爸爸', ['猪爸爸', '猪爸爸-3']), '猪爸爸-2')
  // 同批次已选的名字一起传进来即可避免批内重名
  assert.equal(suggestUniqueName('猪爸爸', ['猪爸爸', '猪爸爸-2', '猪爸爸-3']), '猪爸爸-4')
})

test('改名规则：空白被裁剪，占用集合里的空白项忽略', () => {
  assert.equal(suggestUniqueName('  猴宝宝  ', ['猴宝宝']), '猴宝宝-2')
  assert.equal(suggestUniqueName('猴宝宝', ['', '   ', null, undefined]), '猴宝宝')
})

test('重名判定：裁剪后比较，空名不算重名', () => {
  assert.equal(isNameTaken(' 鼠妈妈 ', ['鼠妈妈']), true)
  assert.equal(isNameTaken('鼠妈妈', ['鼠妈妈-2']), false)
  assert.equal(isNameTaken('   ', ['鼠妈妈']), false)
})

test('前后端改名规则同源：后端 suggestUniqueName 与前端同一算法', () => {
  const backend = read('src/services/asset-library.ts')
  assert.match(backend, /export function suggestUniqueName\(base: string, taken: Iterable<string>\)/)
  assert.match(backend, /\$\{name\}-\$\{suffix\}/)
  const frontend = read('../frontend/app/utils/assetName.js')
  assert.match(frontend, /\$\{name\}-\$\{suffix\}/)
})

test('导入的版本行 provider=import 并记录来源，且被任务中心排除', () => {
  const service = read('src/services/asset-library.ts')
  assert.match(service, /export const IMPORTED_TASK_PROVIDER = 'import'/)
  assert.match(service, /provider: IMPORTED_TASK_PROVIDER/)
  assert.match(service, /params\.imported_from = \{/)
  // 全量复制：历史时间不变
  assert.match(service, /createdAt: source\.createdAt/)
  assert.match(service, /generatedAt: source\.generatedAt \?\? null/)
  const center = read('src/services/task-center.ts')
  assert.match(center, /if \(row\.provider === IMPORTED_TASK_PROVIDER\) continue/)
})

test('导入失败回滚：删行 + 删复制出的文件', () => {
  const service = read('src/services/asset-library.ts')
  assert.match(service, /catch \(err\) \{\n\s+await rollbackImport\(kind, newId, insertedTaskIds, copiedFiles\)\n\s+throw err/)
  const rollback = service.slice(service.indexOf('async function rollbackImport'))
  assert.match(rollback, /fs\.rmSync\(abs, \{ force: true \}\)/)
  assert.match(rollback, /db\.delete\(schema\.sysTask\)/)
  assert.match(rollback, /db\.delete\(table\)\.where\(eq\(table\.id, assetId\)\)/)
})

test('派生字段不照搬：场景 storyboard_count 置 0、status 重算，角色 sort_order 追加末尾', () => {
  const service = read('src/services/asset-library.ts')
  assert.match(service, /storyboardCount: 0/)
  assert.match(service, /status: imageUrl \? 'completed' : 'pending'/)
  assert.match(service, /sortOrder: existing\.reduce/)
})

test('参考图复制保留原 uploaded_at，缺文件只跳过不失败', () => {
  const service = read('src/services/asset-library.ts')
  assert.match(service, /refs\.push\(\{ path: target, uploaded_at: entry\.uploaded_at \}\)/)
  assert.match(service, /skippedRefs \+= 1/)
  assert.match(service, /skippedVersions \+= 1/)
})

test('关联接口：同项目校验 + 同名拒绝 + 幂等', () => {
  const service = read('src/services/asset-library.ts')
  assert.match(service, /该资产属于其他项目/)
  assert.match(service, /无法重复关联/)
  const routes = read('src/routes/episodes.ts')
  assert.match(routes, /app\.post\('\/:id\/assets\/link'/)
  assert.match(routes, /app\.delete\('\/:id\/assets\/link'/)
  const dramas = read('src/routes/dramas.ts')
  assert.match(dramas, /app\.post\('\/:id\/assets\/import'/)
})

test('前端新组件在两个入口都显式 import（Nuxt 自动导入在热重载下会失效）', () => {
  for (const path of ['../frontend/app/views/drama/episode.vue', '../frontend/app/views/drama/detail.vue']) {
    const source = read(path)
    assert.match(source, /import AssetBrowserDialog from '~\/components\/AssetBrowserDialog\.vue'/)
    assert.match(source, /<AssetBrowserDialog/)
  }
})
