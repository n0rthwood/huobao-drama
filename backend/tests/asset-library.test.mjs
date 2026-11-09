import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isNameTaken, suggestUniqueName } from '../../frontend/app/utils/assetName.js'


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

