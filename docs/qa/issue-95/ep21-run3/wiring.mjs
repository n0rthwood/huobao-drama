// Read-only: for each new video task, fetch ComfyUI history and compare uploaded first-frame bytes to the junction PNG.
import { Database } from 'bun:sqlite'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
const ROOT = '/home/joysort/projects/huobao-drama'
const db = new Database(ROOT + '/data/huobao.sqlite3', { readonly: true })
const cfg = db.query('SELECT base_url, api_key FROM ai_service_configs WHERE id=8').get()
const ids = [1986, 1987, 1988, 1989, 1990, 1991, 1992]
const out = []
for (const id of ids) {
  const t = db.query('SELECT task_id, params FROM sys_task WHERE id=?').get(id)
  const params = JSON.parse(t.params)
  const url = cfg.base_url + '/history/' + t.task_id
  const hist = execFileSync('curl', ['-sS', '-u', cfg.api_key, url], { encoding: 'utf8', maxBuffer: 1 << 24 })
  const entry = Object.values(JSON.parse(hist))[0]
  const nodes = Object.values(entry.prompt[2])
  const guides = nodes.filter(n => n.class_type === 'MiniMaxH3AddGuide').map(n => ({ frame_idx: n.inputs.frame_idx, img: n.inputs.image?.[0] }))
  const loads = nodes.filter(n => n.class_type === 'LoadImage').map(n => n.inputs.image)
  const first = loads.find(f => f && f.includes('_first'))
  const dl = `/tmp/${id}-first.png`
  execFileSync('curl', ['-sS', '-u', cfg.api_key, cfg.base_url + '/view?filename=' + first + '&type=input', '-o', dl])
  const sha = execFileSync('sha256sum', [dl], { encoding: 'utf8' }).split(' ')[0]
  const localSha = execFileSync('sha256sum', [ROOT + '/data/' + params.firstFrameUrl], { encoding: 'utf8' }).split(' ')[0]
  const refCount = loads.filter(f => f && f.includes('_ref')).length
  out.push({ task: id, guide: guides.map(g => g.frame_idx), firstUpload: first, uploadSha: sha, junctionSha: localSha, bytesMatch: sha === localSha, junctionFile: params.firstFrameUrl, midFrameTime: params.midFrameTime, refCount })
}
fs.writeFileSync('wiring-run3.json', JSON.stringify(out, null, 2))
console.log(out.map(o => `${o.task}\tguide=${o.guide}\tbytesMatch=${o.bytesMatch}\tmid=${o.midFrameTime}\trefs=${o.refCount}`).join('\n'))
