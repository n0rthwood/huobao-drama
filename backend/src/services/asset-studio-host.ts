import crypto from 'node:crypto'
import {and,eq} from 'drizzle-orm'
import {db,schema,sqlite} from '../db/index.js'
import {now} from '../utils/response.js'
import {generateImage} from './generation.js'
import {adoptDirectImage} from './asset-image-usage.js'
import {getDramaStylePrompt} from './style-preset.js'
import {assetImageSizeForDrama} from './asset-image-size.js'
import {classifyPromptInvalidation,planFinalPromptWrite} from './asset-prompt-invalidation.js'
import {listConfigModelChoices} from './ai.js'
import {loadPropSemantics} from './asset-semantics.js'
import {cancelImageTask} from './qwen-jobs.js'
import {GEOMETRY_MAX_SIDE,isExtractableLineColor,lineColorCoverage,loadRaster,parseHexColor} from './semantics-geometry.js'
import {AssetStudioDeliveryConflict,ImageSelectionError,type AssetStudioHost,type AssetStudioPlatform,type AssetStudioAssetSnapshot,type AssetKind,type RoundPurpose,FIDELITY_LINE_COVERAGE,type SemanticsPreserved} from '../modules/asset-studio/contract.js'
function parseRef(ref:string){const m=/^(character|scene|prop):([1-9]\d*)$/.exec(ref);if(!m)throw new Error('资产引用非法');return {kind:m[1] as AssetKind,id:Number(m[2]),table:m[1]==='character'?'characters':m[1]==='scene'?'scenes':'props'}}
function snapshot(ref:string):AssetStudioAssetSnapshot|null{
 const {kind,id,table}=parseRef(ref);const row=sqlite.prepare(`SELECT * FROM ${table} WHERE id=? AND deleted_at IS NULL`).get(id) as Record<string,any>|undefined;if(!row)return null
 const link=kind==='character'?'episode_characters':kind==='scene'?'episode_scenes':'episode_props';const owner=kind+'_id'
 const episode=sqlite.prepare(`SELECT episode_id FROM ${link} WHERE ${owner}=? ORDER BY episode_id LIMIT 1`).get(id) as {episode_id:number}|undefined
 const refs=JSON.parse(row.reference_images||'[]') as {path:string;usage?:string}[]
 const data={kind,id,dramaId:Number(row.drama_id),episodeId:episode?.episode_id??null,name:String(row.name??row.location),description:kind==='character'?[row.appearance,row.styling,row.description].filter(Boolean).join('；'):kind==='scene'?[row.time,row.lighting,row.prompt].filter(Boolean).join('；'):[row.type,row.description].filter(Boolean).join('；'),appearance:row.appearance??null,styling:row.styling??null,prompt:row.prompt??null,lighting:row.lighting??null,imageUrl:row.local_path||row.image_url||null,faithful:row.faithful===1,isMap:row.asset_type==='map',referenceImages:refs.map(r=>({path:r.path,usage:r.usage}))}
 return {...data,fingerprint:crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex')}
}
export const huobaoAssetStudioHost:AssetStudioHost={
 id:'huobao',
 async describe(ref){const a=snapshot(ref);if(!a)return null;const ep=a.episodeId?sqlite.prepare('SELECT episode_number FROM episodes WHERE id=?').get(a.episodeId) as {episode_number:number}|undefined:null;return {title:a.name,subtitle:`项目 #${a.dramaId}`,return_path:ep?`/drama/${a.dramaId}/episode/${ep.episode_number}?panel=production&tab=assets&asset=${a.kind}-${a.id}`:`/drama/${a.dramaId}`}},
 async readAsset(ref){return snapshot(ref)},
 async adoptOriginal(ref,path){const a=snapshot(ref);if(!a)return {adopted:false,reason:'资产不存在'};return adoptDirectImage(a.kind,a.id,path,{expectedCurrent:a.imageUrl,source:'asset-studio'})},
 async deliver(ref,d){return sqlite.transaction(()=>{
  const a=snapshot(ref);if(!a)throw new Error('资产不存在');
  const prior=sqlite.prepare('SELECT version_id,set_as_current FROM asset_studio_delivery WHERE run_id=? AND image_sha256=?').get(d.runId,d.sha256) as {version_id:number|null;set_as_current:number}|undefined
  const run=sqlite.prepare('SELECT params FROM asset_studio_run WHERE id=?').get(d.runId) as {params:string}|undefined
  if(!run)throw new Error('工作室运行不存在')
  const runParams=JSON.parse(run.params) as Record<string,unknown>
  const baseline=prior?.set_as_current?runParams.fingerprint:d.frozenFingerprint
  if(d.setAsCurrent && a.fingerprint!==baseline)throw new AssetStudioDeliveryConflict('资产已在工作室外修改，请重新运行或确认后再交付')
  const {table,kind,id}=parseRef(ref)
  const round=sqlite.prepare('SELECT image_task_id FROM asset_studio_round WHERE id=? AND run_id=?').get(d.roundId,d.runId) as {image_task_id:number|null}|undefined
  const versionId=round?.image_task_id??null;if(!versionId)throw new Error('轮次没有生图版本，无法交付')
  const version=sqlite.prepare('SELECT params,status,local_path,result_url FROM sys_task WHERE id=?').get(versionId) as {params:string|null;status:string;local_path:string|null;result_url:string|null}|undefined
  if(version?.status!=='completed'||(version.local_path||version.result_url)!==d.imagePath)throw new Error('轮次版本尚未完成或产物不匹配')
  const params=JSON.parse(version.params||'{}');sqlite.prepare('UPDATE sys_task SET params=? WHERE id=?').run(JSON.stringify({...params,source:'asset-studio',studio_run_id:d.runId,studio_round_id:d.roundId,sha256:d.sha256,sources:d.sources}),versionId)
  sqlite.prepare('INSERT INTO asset_studio_delivery(run_id,round_id,image_sha256,version_id,set_as_current,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(run_id,image_sha256) DO UPDATE SET set_as_current=MAX(set_as_current,excluded.set_as_current)').run(d.runId,d.roundId,d.sha256,versionId,d.setAsCurrent?1:0,now())
  if(d.setAsCurrent){
   sqlite.prepare(`UPDATE ${table} SET image_url=?,local_path=?,updated_at=? WHERE id=?`).run(d.imagePath,d.imagePath,now(),id)
   // Own adoption advances only the comparison baseline; frozen input remains immutable.
   sqlite.prepare('UPDATE asset_studio_run SET params=?,updated_at=? WHERE id=?').run(
    JSON.stringify({...runParams,fingerprint:snapshot(ref)!.fingerprint}),now(),d.runId,
   )
  }
  for(const raw of d.sources){if(!raw||typeof raw!=='object')continue;const src=raw as {url?:string;title?:string;excerpt?:string};if(!src.url&&!src.title)continue;const exists=sqlite.prepare("SELECT 1 FROM research_citations WHERE asset_kind=? AND asset_id=? AND tool='asset-studio' AND COALESCE(source_url,'')=? AND COALESCE(title,'')=?").get(kind,id,src.url??'',src.title??'');if(!exists)sqlite.prepare("INSERT INTO research_citations(drama_id,episode_id,asset_kind,asset_id,asset_name,tool,title,source_url,snippet,status,retrieved_at) VALUES (?,?,?,?,?,'asset-studio',?,?,?,'ok',?)").run(a.dramaId,a.episodeId,kind,id,a.name,src.title??null,src.url??null,src.excerpt?.slice(0,500)??null,now())}
  return {versionId,message:d.setAsCurrent?'已采用为当前图':'已登记交付版本'}
 })()},
 async invalidateFinalPrompt(ref,version){if(version<=1)return;const a=snapshot(ref);if(!a||a.faithful)return;const decision=classifyPromptInvalidation({kind:a.kind,current:{},updates:{},specVersionChanged:true});if(!decision.changed)return;const table=a.kind==='character'?schema.characters:a.kind==='scene'?schema.scenes:schema.props;const [row]=await db.select().from(table).where(eq(table.id,a.id));const write=planFinalPromptWrite({currentFinalPrompt:row?.finalPrompt??null,sourceChanged:true,at:now()});if(Object.keys(write).length)await db.update(table).set({...write,updatedAt:now()}).where(eq(table.id,a.id))},
 async semanticsContext(ref){const a=snapshot(ref);if(!a||a.kind!=='prop')return {labels:[],expected:[]};const s=await loadPropSemantics(a.id);return {labels:s?[...s.labels.map(l=>l.text),...s.points.map(p=>p.name)].filter(Boolean):[],expected:s?s.points.map(p=>({id:p.id,name:p.name,at:p.at})):[]}},
}
export const huobaoAssetStudioPlatform:AssetStudioPlatform={
 async submitImage(i){
  const a=snapshot(i.hostRef)
  if(!a||a.faithful||a.isMap)throw new Error('该资产受保护，禁止计费生图')
  const taskId=await generateImage({
   ...(a.kind==='character'?{characterId:a.id}:a.kind==='scene'?{sceneId:a.id}:{propId:a.id}),
   episodeId:i.episodeId??undefined,dramaId:a.dramaId,prompt:i.prompt,
   model:i.model??undefined,size:i.size,aspectLocked:i.aspectLocked,
   referenceImages:i.referenceImages,
   pipelineReferenceOrigins:i.referenceOrigins as Parameters<typeof generateImage>[0]['pipelineReferenceOrigins'],
   configId:i.configId??undefined,pipelineRound:true,
  })
  return {taskId}
 },
 async pollImage(id){const r=sqlite.prepare("SELECT status,local_path,result_url,error_msg FROM sys_task WHERE id=? AND type='image'").get(id) as {status:string;local_path:string|null;result_url:string|null;error_msg:string|null}|undefined;if(!r)return {status:'missing',path:null,error:'图片任务不存在'};const status=r.status==='completed'||r.status==='failed'||r.status==='cancelled'?r.status:'pending';return {status,path:r.local_path||r.result_url,error:r.error_msg}},
 async imageInputs(id){
  const row=sqlite.prepare("SELECT params FROM sys_task WHERE id=? AND type='image'").get(id) as {params:string|null}|undefined
  return row?JSON.parse(row.params||'{}') as Record<string,unknown>:null
 },
 async cancelImage(id){const r=sqlite.prepare('SELECT provider FROM sys_task WHERE id=?').get(id) as {provider:string}|undefined;if(r?.provider==='qwen-jobs')await cancelImageTask(id);else sqlite.prepare("UPDATE sys_task SET status='cancelled',updated_at=? WHERE id=? AND status NOT IN ('completed','failed','cancelled')").run(now(),id)},
 async adoptOrphanImage(ref,prompt,since){const {kind,id}=parseRef(ref);const rows=sqlite.prepare(`SELECT id,prompt,params FROM sys_task WHERE type='image' AND ${kind}_id=? AND created_at>=? ORDER BY id`).all(id,since) as {id:number;prompt:string;params:string|null}[];return rows.find(r=>{const p=JSON.parse(r.params||'{}');return p.pipeline_round===true && (r.prompt===prompt||p.sourcePrompt===prompt)})?.id??null},
 stylePrompt:getDramaStylePrompt,
 sceneSize:(dramaId)=>assetImageSizeForDrama('scene',dramaId),
 async researchKeys(){const row=sqlite.prepare("SELECT value FROM app_settings WHERE key='research_api_keys'").get() as {value:string}|undefined;return JSON.parse(row?.value||'{}') as Record<string,string>},
 async imageSelection(input){const selected=await resolveImageSelection(input);return {...selected,generator:`${selected.provider}:${selected.model}`}},
 async modelOptions(){
  const [image,text]=await Promise.all([listConfigModelChoices('image'),listConfigModelChoices('text')])
  return [...image.map(row=>({...row,service_type:'image'})),...text.map(row=>({...row,service_type:'text'}))]
 },
 async checkSemantics(input){const a=parseRef(input.hostRef);return checkSemanticsPreserved({...input,assetKind:a.kind,assetId:a.id})},
}

/** 结构/细节优先的厂商（按 ai_service_configs.provider 匹配） */
const STRUCTURE_PROVIDER = 'openai'

async function activeImageConfigs(): Promise<Array<{ id: number; provider: string; model: string; models: string[]; priority: number }>> {
  const rows = await db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.serviceType, 'image'))
  return rows
    .filter(row => row.isActive)
    .map((row) => {
      let models: unknown
      try {
        models = row.model ? JSON.parse(row.model) : []
      } catch {
        models = []
      }
      const list = (Array.isArray(models) ? models : [models])
        .map(item => String(item ?? '').trim())
        .filter(Boolean)
      return { id: row.id, provider: (row.provider || '').toLowerCase(), model: list[0] ?? '', models: list, priority: row.priority || 0 }
    })
    .filter(row => Boolean(row.model))
    .sort((a, b) => b.priority - a.priority)
}

export interface ImageSelection {
  configId: number
  provider: string
  model: string
}

/**
 * 启动时把这条 run 的出图配置**定下来**（Issue #73）：之后每一轮、重启续跑都用同一条
 * 配置与模型，不再受「当前启用配置」变化的影响。人没选时取默认：优先启用中的
 * GPT Image（provider=openai 且模型名含 gpt-image），否则取优先级最高的启用配置。
 */
export async function resolveImageSelection(input: {
  configId?: number | null
  model?: string | null
}): Promise<ImageSelection> {
  const model = input.model ? String(input.model).trim() : ''
  // 给了 config_id 就必须是合法编号：`"abc"`/0/负数不能悄悄退化成「没选」而落到默认配置上
  const hasConfig = input.configId !== undefined && input.configId !== null
  const configId = hasConfig ? Number(input.configId) : 0
  if (hasConfig && (!Number.isInteger(configId) || configId <= 0)) {
    throw new ImageSelectionError(`图片配置 id「${input.configId}」不是合法的配置编号`)
  }
  const configs = await activeImageConfigs()

  if (configId) {
    const chosen = configs.find(config => config.id === configId)
    if (!chosen) throw new ImageSelectionError(`图片配置 #${configId} 不存在或未启用，请到「设置」页确认后重选`)
    if (model && !chosen.models.includes(model)) {
      throw new ImageSelectionError(`图片配置 #${configId} 没有模型「${model}」，可选：${chosen.models.join(' / ')}`)
    }
    return { configId: chosen.id, provider: chosen.provider, model: model || chosen.model }
  }
  if (model) {
    const matched = configs.find(config => config.models.includes(model))
    if (!matched) throw new ImageSelectionError(`没有启用中的图片配置包含模型「${model}」，请到「设置」页确认后重选`)
    return { configId: matched.id, provider: matched.provider, model }
  }

  for (const config of configs) {
    if (config.provider !== STRUCTURE_PROVIDER) continue
    const gptImage = config.models.find(item => item.toLowerCase().includes('gpt-image'))
    if (gptImage) return { configId: config.id, provider: config.provider, model: gptImage }
  }
  const fallback = configs[0]
  if (!fallback) throw new ImageSelectionError('未配置可用的图片模型，请先到「设置」页添加并启用 AI 图片服务')
  return { configId: fallback.id, provider: fallback.provider, model: fallback.model }
}



export async function checkSemanticsPreserved(input: {
  assetKind: AssetKind
  assetId: number
  /** 本轮产出图的绝对路径 */
  absPath: string
  /** QC 那次视觉调用顺带回答的「这些标注文字还读得到吗」 */
  labelsReadable?: Array<{ text: string; readable: boolean }>
}): Promise<SemanticsPreserved> {
  if (input.assetKind !== 'prop') {
    return { status: 'not_applicable', detail: '只有道具（证据素材）有语义标注' }
  }
  const semantics = await loadPropSemantics(input.assetId)
  if (!semantics || (!semantics.lines.length && !semantics.labels.length)) {
    return { status: 'not_applicable', detail: '该资产没有语义标注，不做保形核验' }
  }

  const problems: string[] = []
  const skipped: string[] = []

  // 标注可读性是 QC 那次视觉调用顺带回答的：模型没答 / 答漏了，不能当「全都还在」
  const answered = new Map((input.labelsReadable ?? []).map(item => [item.text, item.readable]))
  const expectedLabels = [...semantics.labels.map(item => item.text), ...semantics.points.map(item => item.name)]
    .filter(Boolean)
  const missing = expectedLabels.filter(text => answered.get(text) === false)
  const unanswered = expectedLabels.filter(text => !answered.has(text))
  if (missing.length) problems.push(`以下标注文字在新图上读不到：${missing.join('、')}`)
  if (unanswered.length) skipped.push(`模型没有回答这些标注是否仍可读：${unanswered.join('、')}`)

  const colored = semantics.lines.filter(line => line.color)
  if (colored.length) {
    // 放宽判据只用于**上传截图**路径（主进程裁决）：标注坐标所针对的那张图是
    // `provider='upload'` 的版本行时才允许；程序渲染的底图与扫描印刷图一律走严格判据
    const screenshot = await isUploadedScreenshot(semantics.image.source_task_id)
    const { raster } = await loadRaster(input.absPath, GEOMETRY_MAX_SIDE)
    // 标注坐标是**原图像素**；新图可能是另一个尺寸桶，按原图宽度换算到分析光栅
    const scale = raster.width / Math.max(semantics.image.width, 1)
    for (const line of colored) {
      const color = parseHexColor(line.color)
      if (!color || !isExtractableLineColor(color)) {
        skipped.push(`「${line.name}」的颜色 ${line.color} 无法按色域核验`)
        continue
      }
      const points = line.points.map(([x, y]): [number, number] => [x * scale, y * scale])
      const strict = lineColorCoverage(raster, points, color)
      const coverage = strict >= FIDELITY_LINE_COVERAGE || !screenshot
        ? strict
        : Math.max(strict, lineColorCoverage(raster, points, color, { hueOnly: true }))
      if (coverage < FIDELITY_LINE_COVERAGE) {
        problems.push(`线条「${line.name}」的色域覆盖率只有 ${Math.round(coverage * 100)}%（要求 ≥${Math.round(FIDELITY_LINE_COVERAGE * 100)}%）`)
      }
    }
  }

  if (problems.length) return { status: 'fail', detail: problems.join('；') }
  const note = skipped.length ? `（未能核验：${skipped.join('；')}）` : ''
  return { status: 'pass', detail: `标注文字可读、线条色域覆盖率达标${note}` }
}

/** 标注坐标所针对的那张图是不是人工上传的截图 */
async function isUploadedScreenshot(sourceTaskId: number | null): Promise<boolean> {
  if (!sourceTaskId) return false
  const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, sourceTaskId))
  return task?.provider === 'upload'
}

