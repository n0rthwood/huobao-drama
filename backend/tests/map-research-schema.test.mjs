/**
 * 地图工作室资料检索交付 schema 的供应商兼容（Issue #120）行为测试：
 * 百炼 qwen4-max-preview 拒绝元组式 JSON Schema（items:[…] → 400 invalid_parameter_error，
 * 生产 observed call 7020–7022）。修复 = 定长数组 z.array(z.number()).length(N)：
 * - Mastra 实际转换口径（zod toJSONSchema target draft-07, io input）下无元组 items 残留；
 * - 校验语义与原 z.tuple 等价：恰好 N 个 number，长度/类型不合格拒收。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(script) {
  const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, SQLITE_PATH: path.join(mkdtempSync(path.join(tmpdir(), 'map-schema-')), 'test.sqlite3') },
  })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

test('featureSubmissionSchema：draft-07 无元组残留，定长坐标校验与 tuple 等价', () => {
  const r = run(`
    import { featureSubmissionSchema } from './src/modules/map-studio/research.ts'
    const json = featureSubmissionSchema.toJSONSchema({ target: 'draft-07', io: 'input' })
    const wire = JSON.stringify(json)
    const base = {
      kind: 'route', name: '测试线', category: 'route', geometry_source: 'model',
      coordinate_basis: 'approximate_schematic', basis: '示意', source_ids: [], uncertainty: 'high',
    }
    const ok = featureSubmissionSchema.safeParse({ ...base, points: [[11,55],[12,56]], dataset_ref: { ref: 'ne:x', clip_bbox: [10,50,13,57] } }).success
    const shortPoint = featureSubmissionSchema.safeParse({ ...base, points: [[11]] }).success
    const longBbox = featureSubmissionSchema.safeParse({ ...base, points: [[11,55],[12,56]], dataset_ref: { ref: 'ne:x', clip_bbox: [10,50,13,57,99] } }).success
    const typedPoint = featureSubmissionSchema.safeParse({ ...base, points: [[11,'x']] }).success
    console.log('@@' + JSON.stringify({ tupleItems: wire.includes('"items":['), additionalItems: wire.includes('additionalItems'), points: json.properties.points, ok, shortPoint, longBbox, typedPoint }))
  `)
  assert.equal(r.tupleItems, false)
  assert.equal(r.additionalItems, false)
  assert.deepEqual(r.points.items, { minItems: 2, maxItems: 2, type: 'array', items: { type: 'number' } })
  assert.equal(r.ok, true)
  assert.equal(r.shortPoint, false)
  assert.equal(r.longBbox, false)
  assert.equal(r.typedPoint, false)
})
