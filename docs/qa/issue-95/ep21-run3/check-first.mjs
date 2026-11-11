import { Database } from 'bun:sqlite'
const db = new Database('/home/joysort/projects/huobao-drama/data/huobao.sqlite3', { readonly: true })
const names = db.query(`SELECT name FROM assets WHERE drama_id=15 AND deleted_at IS NULL`).all().map(r => r.name)
const ids = [575,579,580,581,584,585,591]
const rows = JSON.parse(await Bun.file('storyboards-after-prompts.json').text()).data.filter(s => ids.includes(s.id))
const CUT = /切到|切回|切换为|切换到|转到|硬切|cut to|cuts to|カット|切り替え|컷|전환/i
const TRANS = /过渡为|过渡到|转入|化为|变为|叠化|dissolve|transition to|morph into|ディゾルブ|移り変わ|디졸브|바뀌어/i
const out = []
for (const s of rows) {
  const paras = s.video_prompt.split('\n').map(x => x.trim()).filter(Boolean)
  const seg = paras.find(l => /^\d+(\.\d+)?\s*[-–—~]\s*\d+(\.\d+)?\s*(秒|s)/i.test(l))
  if (!seg) { out.push({ id: s.id, error: 'no time segment' }); continue }
  const m = seg.match(/^(\d+(?:\.\d+)?)\s*[-–—~]\s*(\d+(?:\.\d+)?)/)
  const [a, b] = [Number(m[1]), Number(m[2])]
  const charsInFirst = names.filter(n => seg.includes('@' + n))
  const cutHit = seg.match(CUT)?.[0] ?? null
  const transHit = seg.match(TRANS)?.[0] ?? null
  out.push({ id: s.id, n: s.storyboard_number, first: `${a}-${b}`, durationSec: b - a, charsInFirst, cutHit, transHit, ok: b <= 1.5 && a === 0 && charsInFirst.length === 0 && !cutHit && !transHit })
}
console.log(JSON.stringify(out, null, 2))
