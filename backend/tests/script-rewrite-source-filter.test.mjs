/**
 * 公共输入准备（Issue #70 §0）的消费者可见行为：
 * - 行政材料（来源/永久链接/贡献者/许可/非朗读说明）必须被剥离，并逐条说明原因；
 * - 正文里的事实归属（据《异域录》记载…）必须保留；
 * - 纯正文输入一个字都不改；
 * - 只有行政材料的输入必须明确失败，不能伪造正文；
 * - AI 阶段产出里混回来的行政内容会被同一把尺子挡住（验收 17）。
 * 纯函数，用仓库自带 tsx 子进程跑并以 JSON 回传。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(body) {
  const script = `
    import { filterNonNarration, prepareSourceOrThrow, guardStageOutput, PreparedSourceEmptyError } from './src/services/script-rewrite/source-filter.ts'
    const out = (value) => console.log('@@' + JSON.stringify(value))
    ${body}
  `
  const text = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot, encoding: 'utf8',
  })
  return JSON.parse(text.slice(text.lastIndexOf('@@') + 2))
}

const MIXED = [
  '原始材料：殷墟考古简报',
  '永久链接：https://example.org/wiki/Yinxu?oldid=12345',
  '贡献历史：张三、李四、王五',
  '许可：CC BY-SA 4.0',
  '说明：本页脚注与许可信息不作为旁白朗读稿。',
  '',
  '据《异域录》记载，图理琛在回程途中写下了这些见闻。',
  '',
  '殷墟位于河南安阳，是商代晚期的都城遗址。',
  '',
  '考古队在这里发掘出大量甲骨。',
  '',
  '甲骨上的刻辞记录了商王的占卜。',
].join('\n')

test('行政头部被逐条剥离，事实归属与正文段落保留', () => {
  const result = run(`out(filterNonNarration(${JSON.stringify(MIXED)}))`)
  const categories = result.report.removed.map(item => item.category)
  assert.ok(categories.includes('metadata_field'), '著录字段应被剥离')
  assert.ok(categories.includes('source_link'), '永久链接应被剥离')
  assert.ok(categories.includes('contributor'), '贡献者字段应被剥离')
  assert.ok(categories.includes('license'), '许可声明应被剥离')
  assert.ok(categories.includes('non_narration_note'), '非朗读说明应被剥离')
  for (const item of result.report.removed) {
    assert.ok(item.reason.length > 6, `每条排除都要有具体理由，实际：${item.reason}`)
    assert.ok(item.end > item.start, '排除片段要带原文位置')
  }

  assert.ok(result.prepared.startsWith('据《异域录》记载'), '事实归属必须留在正文开头')
  assert.ok(result.prepared.includes('殷墟位于河南安阳'), '正文段落必须保留')
  assert.ok(result.prepared.includes('甲骨上的刻辞记录了商王的占卜。'), '最后一段必须保留')
  assert.ok(!/https?:\/\//.test(result.prepared), '正文里不得残留链接')
  assert.ok(!result.prepared.includes('CC BY-SA'), '正文里不得残留许可')
  assert.ok(!result.prepared.includes('贡献历史'), '正文里不得残留贡献者字段')
})

test('像著录字段的历史事实不被当成行政信息删掉', () => {
  const narrative = [
    '作者：司马迁。该书成书于公元前 91 年左右，记事止于汉武帝。',
    '',
    '语言：满文与汉文。这份条约的两种文本在用词上并不完全一致。',
  ].join('\n')
  const result = run(`out(filterNonNarration(${JSON.stringify(narrative)}))`)
  assert.deepEqual(result.report.removed, [], '这两行都是史料事实，不该被过滤')
  assert.equal(result.prepared, narrative, '历史事实必须逐字保留')
})

test('行政来源后面接着叙述时，只剥著录前缀，不吞掉整段事实', () => {
  const line = '来源：《异域录》卷一。额尔齐斯河是唯一一条能把军队送进腹地的水道。'
  const result = run(`out(filterNonNarration(${JSON.stringify(line)}))`)
  assert.equal(result.report.removed.length, 1)
  assert.equal(result.report.removed[0].category, 'source_link')
  assert.ok(result.prepared.startsWith('额尔齐斯河是唯一一条'), `实际：${result.prepared}`)
  assert.ok(!result.prepared.includes('来源：'), '著录前缀必须剥掉')
})

test('段落里只挂了一句非朗读说明时，其余叙述保留', () => {
  const line = '殷墟的发掘持续了近十年。以上版权与脚注说明不作为旁白朗读稿。甲骨由此大量出土。'
  const result = run(`out(filterNonNarration(${JSON.stringify(line)}))`)
  assert.equal(result.report.removed.length, 1)
  assert.equal(result.report.removed[0].category, 'non_narration_note')
  assert.ok(result.prepared.includes('殷墟的发掘持续了近十年。'), '前一句必须保留')
  assert.ok(result.prepared.includes('甲骨由此大量出土。'), '后一句必须保留')
  assert.ok(!result.prepared.includes('不作为旁白朗读稿'), '说明句必须删掉')
})

test('纯正文输入逐字节不变，过滤报告为空', () => {
  const pure = '殷墟位于河南安阳。\n\n考古队在这里发掘出大量甲骨。\n\n甲骨上的刻辞记录了商王的占卜。'
  const result = run(`out(filterNonNarration(${JSON.stringify(pure)}))`)
  assert.equal(result.prepared, pure)
  assert.deepEqual(result.report.removed, [])
})

test('正文句子里夹带的链接只删链接本身', () => {
  const line = '这条水道的资料见 https://example.org/a 与地方志互相印证。'
  const result = run(`out(filterNonNarration(${JSON.stringify(line)}))`)
  assert.ok(!result.prepared.includes('https://'), '链接必须删掉')
  assert.ok(result.prepared.includes('这条水道的资料'), '句子其余部分必须保留')
  assert.ok(result.prepared.includes('与地方志互相印证。'), '句子尾部必须保留')
})

test('只有行政材料的输入明确失败，不伪造正文', () => {
  const adminOnly = ['来源：https://example.org/x', '许可：CC BY-SA 4.0', '贡献者：张三'].join('\n')
  const result = run(`
    try { prepareSourceOrThrow(${JSON.stringify(adminOnly)}); out({ thrown: false }) }
    catch (err) { out({ thrown: err instanceof PreparedSourceEmptyError, removed: err.report?.removed?.length ?? 0 }) }
  `)
  assert.equal(result.thrown, true, '必须抛 PreparedSourceEmptyError')
  assert.ok(result.removed >= 3, '失败时仍要给出过滤明细')
})

test('AI 阶段产出里混回来的行政内容会被同一把尺子挡住', () => {
  const dirty = '殷墟位于河南安阳。\n\n许可：CC BY-SA 4.0\n\n考古队在这里发掘出大量甲骨。'
  const result = run(`out(guardStageOutput(${JSON.stringify(dirty)}))`)
  assert.ok(!result.text.includes('CC BY-SA'), '产出里的许可必须被剥离')
  assert.equal(result.removed.length, 1)
  assert.equal(result.removed[0].category, 'license')
  assert.ok(result.text.includes('殷墟位于河南安阳。'))
  assert.ok(result.text.includes('考古队在这里发掘出大量甲骨。'))
})


// 浏览器验收里真实漏到 prepared/最终稿的三条行政行（#70 QA）：
// 键名加了限定词（原作者 / 许可协议 / 编者注），泛用词表没覆盖到，整行留在了旁白里。
test('导出条目的署名、许可协议、编者旁批被整行剥离；像它们的史料叙述仍然保留', () => {
  const leaked = [
    '原作者：该条目贡献者；贡献历史：https://example.org/w/index.php?title=Yinxu&action=history',
    '许可协议：CC BY-SA 4.0',
    '编者注：本节待补充地图。',
    '',
    '作者：司马迁。该书成书于公元前 91 年左右，记事止于汉武帝。',
    '',
    '殷墟位于河南安阳，是商代晚期的都城遗址。',
  ].join('\n')
  const result = run(`out(filterNonNarration(${JSON.stringify(leaked)}))`)
  const categories = result.report.removed.map(item => item.category)
  assert.ok(categories.includes('contributor'), '「原作者」署名行应按贡献者剥离')
  assert.ok(categories.includes('license'), '「许可协议」行应按许可剥离')
  assert.ok(categories.includes('usage_note'), '「编者注」旁批应按使用说明剥离')

  assert.ok(!result.prepared.includes('原作者'), `署名行必须整行剥掉，实际：${result.prepared}`)
  assert.ok(!result.prepared.includes('贡献历史'), '同一行里的第二个著录字段也不能留下')
  assert.ok(!result.prepared.includes('CC BY-SA'), '许可协议不能留在旁白里')
  assert.ok(!result.prepared.includes('编者注'), '编者旁批不能留在旁白里')

  assert.ok(result.prepared.includes('作者：司马迁。该书成书于公元前 91 年左右，记事止于汉武帝。'),
    '「作者：司马迁……」是史料事实，必须逐字保留')
  assert.ok(result.prepared.includes('殷墟位于河南安阳，是商代晚期的都城遗址。'), '正文段落必须保留')
})

test('无字段前缀的许可声明也自动排除，同段中文和英文叙述保留', () => {
  const raw = '本页面采用知识共享署名-相同方式共享4.0协议。运河连接南北。\n\nThis text is available under the Creative Commons license. The canal connected the cities.'
  const result = run(`out(filterNonNarration(${JSON.stringify(raw)}))`)
  assert.ok(!result.prepared.includes('知识共享'))
  assert.ok(!result.prepared.includes('Creative Commons'))
  assert.ok(result.prepared.includes('运河连接南北。'))
  assert.ok(result.prepared.includes('The canal connected the cities.'))
  assert.deepEqual(result.report.removed.map(span => span.category), ['license', 'license'])
})

test('来源标签不能导致首句历史事实被删除', () => {
  const raw = '来源：这条水道开凿于战国。它的走向至今仍可辨认。'
  const result = run(`out(filterNonNarration(${JSON.stringify(raw)}))`)
  assert.equal(result.prepared, '这条水道开凿于战国。它的走向至今仍可辨认。')
  assert.deepEqual(result.report.removed.map(span => span.text), ['来源：'])
})