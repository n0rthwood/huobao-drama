/**
 * 整集读缓存（Issue #118 A3）行为测试：
 * - 作用域内同键复用（loader 只跑一次）、不同集互不串；
 * - 写后失效：invalidateEpisodeReadCache 后下一次读重新执行 loader；
 * - 作用域外（交互读路径 / #43 同步链）不缓存；
 * - 失败的加载不缓存；release 后清空。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(script) {
  const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, SQLITE_PATH: path.join(mkdtempSync(path.join(tmpdir(), 'ep-cache-')), 'test.sqlite3') },
  })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

test('批量作用域内复用、写后失效、作用域外不缓存', () => {
  const result = run(`
    import { cachedEpisodeRead, invalidateEpisodeReadCache, releaseEpisodeReadCache, runWithEpisodeReadCache } from './src/services/episode-read-cache.ts'
    let calls = 0
    const loader = async () => { calls++; return { value: calls } }
    const outside = await cachedEpisodeRead(1, 'x', loader)
    const report = await runWithEpisodeReadCache(async () => {
      const a = await cachedEpisodeRead(1, 'x', loader)
      const b = await cachedEpisodeRead(1, 'x', loader)
      const otherEpisode = await cachedEpisodeRead(2, 'x', loader)
      const sameRef = a === b
      invalidateEpisodeReadCache(1)
      const afterInvalidate = await cachedEpisodeRead(1, 'x', loader)
      const episode2Untouched = await cachedEpisodeRead(2, 'x', loader)
      // 失败的加载不缓存
      let failed = 0
      const badLoader = async () => { failed++; throw new Error('boom') }
      await cachedEpisodeRead(3, 'bad', badLoader).catch(() => {})
      await cachedEpisodeRead(3, 'bad', badLoader).catch(() => {})
      releaseEpisodeReadCache()
      const afterRelease = await cachedEpisodeRead(1, 'x', loader)
      return { sameRef, otherEpisodeValue: otherEpisode.value, afterInvalidateValue: afterInvalidate.value,
        episode2UntouchedValue: episode2Untouched.value, failed, afterReleaseValue: afterRelease.value }
    })
    const outsideAgain = await cachedEpisodeRead(1, 'x', loader)
    process.stdout.write('@@' + JSON.stringify({ ...report, outsideValue: outside.value, outsideAgainValue: outsideAgain.value, calls }))
  `)
  assert.equal(result.outsideAgainValue, 6, '作用域外每次直接执行')
  assert.equal(result.calls, 6)
  assert.equal(result.afterInvalidateValue, 4, '写后失效必须重新加载')
  assert.equal(result.episode2UntouchedValue, 3, '失效只影响目标集')
  assert.equal(result.failed, 2, '失败不缓存，重试重新执行')
  assert.equal(result.afterReleaseValue, 5, 'release 后重新加载')
})
