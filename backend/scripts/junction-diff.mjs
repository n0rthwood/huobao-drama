#!/usr/bin/env node
/** Compare a junction pair against internal adjacent pairs: node scripts/junction-diff.mjs before.png after.png internal1.png internal2.png ... */
import sharp from 'sharp'
import assert from 'node:assert/strict'

export async function frameDifference(first, second) {
  const a = await sharp(first).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true })
  const b = await sharp(second).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true })
  assert.equal(a.info.width, b.info.width, 'Frame widths differ')
  assert.equal(a.info.height, b.info.height, 'Frame heights differ')
  let difference = 0
  for (let i = 0; i < a.data.length; i++) difference += Math.abs(a.data[i] - b.data[i])
  return difference / a.data.length
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const files = process.argv.slice(2)
  assert.ok(files.length >= 4 && files.length % 2 === 0, 'Supply junction before/after then one or more internal adjacent frame pairs')
  const junction = await frameDifference(files[0], files[1])
  const internal = []
  for (let i = 2; i < files.length; i += 2) internal.push(await frameDifference(files[i], files[i + 1]))
  internal.sort((a, b) => a - b)
  const middle = Math.floor(internal.length / 2)
  const median = internal.length % 2 ? internal[middle] : (internal[middle - 1] + internal[middle]) / 2
  const result = { junction_mae: junction, internal_median_mae: median, absolute_limit: 12, relative_limit: median * 3, passed: junction <= 12 && junction <= median * 3 }
  console.log(JSON.stringify(result, null, 2))
  if (!result.passed) process.exitCode = 1
}
