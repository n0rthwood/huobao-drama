import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { calendarMonthsBetween, mediaTimeParts } from '../../frontend/app/utils/mediaTime.js'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

// 基准时刻（本地时区）：2026-06-15 12:00:00
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime()
const at = (secondsAgo) => Math.floor(NOW / 1000) - secondsAgo

test('媒体时间四档：秒 / 分钟 / 小时+分钟 / 天', () => {
  assert.deepEqual(mediaTimeParts(at(0), NOW), { kind: 'seconds', n: 0 })
  assert.deepEqual(mediaTimeParts(at(59), NOW), { kind: 'seconds', n: 59 })
  assert.deepEqual(mediaTimeParts(at(60), NOW), { kind: 'minutes', n: 1 })
  assert.deepEqual(mediaTimeParts(at(59 * 60 + 59), NOW), { kind: 'minutes', n: 59 })
  assert.deepEqual(mediaTimeParts(at(3600), NOW), { kind: 'hours', n: 1 })
  assert.deepEqual(mediaTimeParts(at(23 * 3600 + 59 * 60), NOW), { kind: 'hoursMinutes', h: 23, m: 59 })
  assert.deepEqual(mediaTimeParts(at(86400), NOW), { kind: 'days', n: 1 })
})

test('天 → 月 的边界按日历月（29 天仍是天，满 1 个日历月才是月）', () => {
  // 2026-06-15 往前 29 天 = 05-17，不满 1 个日历月
  assert.deepEqual(mediaTimeParts(at(29 * 86400), NOW), { kind: 'days', n: 29 })
  // 2026-05-15 整整 1 个日历月
  assert.deepEqual(mediaTimeParts(Math.floor(new Date(2026, 4, 15, 12, 0, 0).getTime() / 1000), NOW), { kind: 'months', n: 1 })
  // 2026-05-16 差 1 天不满 1 个月
  assert.equal(mediaTimeParts(Math.floor(new Date(2026, 4, 16, 12, 0, 0).getTime() / 1000), NOW).kind, 'days')
})

test('月 → 绝对时间 的边界是满 12 个日历月', () => {
  assert.deepEqual(mediaTimeParts(Math.floor(new Date(2025, 6, 15, 12, 0, 0).getTime() / 1000), NOW), { kind: 'months', n: 11 })
  assert.deepEqual(
    mediaTimeParts(Math.floor(new Date(2025, 5, 15, 12, 0, 0).getTime() / 1000), NOW),
    { kind: 'absolute', text: '2025-06-15 12:00' },
  )
  assert.equal(mediaTimeParts(Math.floor(new Date(2025, 5, 15, 12, 0, 1).getTime() / 1000), NOW).kind, 'months')
})

test('无效/空时间返回 null，未来时间按 0 秒前', () => {
  assert.equal(mediaTimeParts(null, NOW), null)
  assert.equal(mediaTimeParts(0, NOW), null)
  assert.equal(mediaTimeParts('abc', NOW), null)
  assert.deepEqual(mediaTimeParts(at(-120), NOW), { kind: 'seconds', n: 0 })
})

test('日历月差：未到周年日不计入满月', () => {
  assert.equal(calendarMonthsBetween(new Date(2026, 0, 31, 0, 0, 0), new Date(2026, 1, 28, 0, 0, 0)), 0)
  assert.equal(calendarMonthsBetween(new Date(2026, 0, 1, 0, 0, 0), new Date(2026, 1, 1, 0, 0, 0)), 1)
  assert.equal(calendarMonthsBetween(new Date(2025, 5, 15, 12, 0, 0), new Date(2026, 5, 15, 12, 0, 0)), 12)
})

test('generated_at 单一写入点：完成链路统一用 completionStamp', () => {
  const mediaTime = read('src/services/media-time.ts')
  assert.match(mediaTime, /export function completionStamp/)
  assert.match(mediaTime, /export async function backfillGeneratedAt/)
  // 回填口径 completed_at || created_at
  assert.match(mediaTime, /toUnixSeconds\(row\.completedAt\) \?\? toUnixSeconds\(row\.createdAt\)/)
  // 批量 IN 反查，不逐条查询
  assert.match(mediaTime, /inArray\(schema\.sysTask\.localPath, wanted\)/)

  const generation = read('src/services/generation.ts')
  assert.doesNotMatch(generation, /completedAt: now\(\)/)
  assert.match(generation, /\.\.\.completionStamp\(\)/)
  assert.match(read('src/services/ffmpeg-merge.ts'), /\.\.\.completionStamp\(\)/)
  assert.match(read('src/routes/tasks.ts'), /\.\.\.completionStamp\(ts\)/)

  // 索引与补列
  const schema = read('src/db/sqlite-schema.ts')
  assert.match(schema, /idx_sys_task_local_path ON sys_task \(local_path\)/)
  assert.match(schema, /\{ table: 'sys_task', column: 'generated_at', type: 'INTEGER' \}/)
  assert.match(schema, /\{ table: 'video_merges', column: 'generated_at', type: 'INTEGER' \}/)
})

test('参考图迁移为 [{path, uploaded_at}]，无字符串兼容分支', () => {
  const svc = read('src/services/reference-images.ts')
  assert.match(svc, /export interface ReferenceImageEntry/)
  assert.match(svc, /export async function migrateReferenceImages/)
  // 缺文件 → null（mtime 取不到）
  assert.match(svc, /function fileMtimeSeconds/)
  assert.match(svc, /return null/)
  // 幂等：没有字符串条目的行直接跳过
  assert.match(svc, /if \(!list\.some\(item => typeof item === 'string'\)\) continue/)
  // 新上传写 uploaded_at
  assert.match(svc, /uploaded_at: uploadedAt/)
  // 启动时执行迁移
  assert.match(read('src/index.ts'), /migrateReferenceImages\(\)/)
  assert.match(read('src/index.ts'), /backfillGeneratedAt\(\)/)
})

test('成片删除：软删 + 删文件 + 回退 video_url + 进行中拒绝 + 幂等', () => {
  const route = read('src/routes/merge.ts')
  assert.match(route, /app\.delete\('\/episodes\/:id\/merges\/:mergeId'/)
  assert.match(route, /deletedAt: now\(\)/)
  assert.match(route, /posterPathFor\(mergedUrl\), thumbPathFor\(mergedUrl\)/)
  assert.match(route, /isMergeInProgress/)
  assert.match(route, /正在拼接中的成片不能删除/)
  // 幂等：已软删的记录不再重复处理，仍返回成功
  assert.match(route, /if \(!merge\.deletedAt\) \{/)
  // 回退到剩余最新已完成成片，没有则置空
  assert.match(route, /syncEpisodeVideoUrl/)
  assert.match(route, /row\.status === 'completed' && row\.mergedUrl/)
  // 所有读取点都过滤软删
  assert.match(route, /app\.get\('\/episodes\/:id\/merge'[\s\S]*?isNull\(schema\.videoMerges\.deletedAt\)/)
  assert.match(read('src/routes/episodes.ts'), /videoMerges[\s\S]{0,200}isNull\(schema\.videoMerges\.deletedAt\)/)
})
