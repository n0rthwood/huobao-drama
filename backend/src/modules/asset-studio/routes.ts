import {Hono} from 'hono'
import {success,created,badRequest,notFound} from '../../utils/response.js'
import {listObservedWork,listObservedCalls,listObservedMessages,countObservedMessages,getObservedCall} from '../../services/task-observability.js'

import {stmt,getTask,getRun,parseParams,patchParams,type RunRow,type TaskRow} from './db.js'
import {getHost,getPlatform} from './registry.js'
import {openHostTask} from './tasks.js'
import {cancelRun,PipelineConflictError,PipelineStateError} from './run.js'
import {getSpec,getRound,listRounds,listSources,latestQcByRound,type AssetKind} from './store.js'
import {roundReferenceImages} from './references.js'
import {serializeQcGate} from './gate-serialization.js'
import {AssetStudioDeliveryConflict,ReferenceSelectionError,ImageSelectionError,DraftInputError} from './contract.js'
import {addAssetSource,deleteAssetSource,AssetSourceError,syncUserReferences,removeUserReferenceSource} from './sources.js'
import {researchRows,startAssetResearch,ResearchConflictError,type AssetResearchResult} from './research/run.js'
import {createDraft,listDrafts,getDraft,draftView,editDraft,retryDraft,generateFromDraft} from './drafts.js'
import {settings,saveSettings} from './settings.js'
function callPage(taskId:number,scope:string,afterId:number){
  const calls=listObservedCalls(taskId,{scope,afterId,limit:200})
  const lastId=calls[calls.length-1]?.id??afterId
  const hasMore=calls.length===200&&listObservedCalls(taskId,{scope,afterId:lastId,limit:1}).length>0
  return {calls,has_more:hasMore,next_after_id:lastId}
}
export const assetStudioRoutes=new Hono()
const app=assetStudioRoutes
app.onError((err,c)=>{if(err instanceof AssetStudioDeliveryConflict||err instanceof PipelineConflictError||err instanceof ResearchConflictError)return c.json({code:409,message:err.message},409);if(err instanceof PipelineStateError||err instanceof ReferenceSelectionError||err instanceof ImageSelectionError||err instanceof DraftInputError||err instanceof AssetSourceError)return badRequest(c,err.message);throw err})
function requireTask(id:number){const task=getTask(id);if(!task)throw new PipelineStateError('工作室任务不存在');return task}
function requireRun(id:number){const run=getRun(id);if(!run)throw new PipelineStateError('工作室运行不存在');return run}
function split(ref:string){const [kind,id]=ref.split(':');return {kind:kind as AssetKind,id:Number(id)}}
async function runView(row:RunRow){const p=parseParams(row.params);return {...row,params:p,purpose:row.purpose,reference_source_ids:p.reference_source_ids??null,image_config_id:p.image_config_id??null,image_model:p.image_model??null,step:p.progress?.step??null,asset_kind:p.asset_kind,asset_id:p.asset_id,episode_id:p.episode_id,error:row.error_msg,result:p.result??null,qc_error:p.qc_error??null,pipeline:{state:row.status,asset_kind:p.asset_kind,asset_id:p.asset_id}}}
async function detail(task:TaskRow,runId?:number){
  const asset=await getHost().readAsset(task.host_ref)
  const target=await getHost().describe(task.host_ref)
  const {kind,id}=split(task.host_ref)
  const runs=stmt('SELECT * FROM asset_studio_run WHERE task_id=? ORDER BY id DESC').all(task.id) as RunRow[]
  const row=runId?runs.find(r=>r.id===runId):runs[0]
  if(runId&&!row)throw new PipelineStateError('运行不属于该任务')
  const run=row?await runView(row):null
  // spec：最新 draft.spec_id ?? 最新 round.spec_id（Issue #123）
  const drafts=listDrafts(task.id)
  const allRounds=(await Promise.all(runs.map(r=>listRounds(r.id)))).flat().sort((a,b)=>b.id-a.id)
  const specId=drafts.find(d=>d.spec_id)?.spec_id??allRounds.find(r=>r.spec_id)?.spec_id??null
  const spec=specId?await getSpec(specId):null
  const qc=await latestQcByRound(allRounds.map(r=>r.id))
  const rounds=await Promise.all(allRounds.map(async r=>{
    const roundSpec=r.spec_id?await getSpec(r.spec_id):spec
    const versionDeleted=r.image_task_id?!stmt('SELECT 1 FROM sys_task WHERE id=?').get(r.image_task_id):false
    return {...r,reference_images:await roundReferenceImages(r),qc:qc.get(r.id)??null,gate:qc.get(r.id)?serializeQcGate(qc.get(r.id)!,roundSpec):null,version_deleted:versionDeleted}
  }))
  return {task,asset,target,run,spec,rounds,drafts:drafts.map(d=>({...d,inputs:JSON.parse(d.inputs)})),sources:await listSources(kind,id),deliveries:stmt('SELECT d.* FROM asset_studio_delivery d JOIN asset_studio_run r ON r.id=d.run_id WHERE r.task_id=? ORDER BY d.id DESC').all(task.id)}
}
app.get('/tasks',async c=>{const tasks=stmt('SELECT * FROM asset_studio_task WHERE deleted_at IS NULL ORDER BY updated_at DESC,id DESC').all() as TaskRow[];return success(c,{tasks:await Promise.all(tasks.map(async t=>{const r=stmt('SELECT * FROM asset_studio_run WHERE task_id=? ORDER BY id DESC LIMIT 1').get(t.id) as RunRow|undefined;return {...t,status:r?.status??'idle',stage:r?parseParams(r.params).progress?.step??null:null,target:await getHost().describe(t.host_ref)}}))})})
app.post('/tasks/open',async c=>{const p=await c.req.json();if(!/^(character|scene|prop):[1-9]\d*$/.test(p.host_ref??''))return badRequest(c,'host_ref 必须是资产引用');return success(c,await openHostTask(p.host_ref))})
app.get('/tasks/:id',async c=>success(c,await detail(requireTask(Number(c.req.param('id'))),Number(c.req.query('run_id'))||undefined)))
// 显式同步（幂等）：直达 /asset-studio/:id 与刷新时把资产参考图导入素材池（GET 保持只读，评审 P2-7）
app.post('/tasks/:id/sync',async c=>{const task=requireTask(Number(c.req.param('id')));await syncUserReferences(task.id);const {kind,id}=split(task.host_ref);return success(c,{sources:await listSources(kind,id)})})
app.get('/tasks/:id/runs',async c=>{const t=requireTask(Number(c.req.param('id')));const rows=stmt('SELECT * FROM asset_studio_run WHERE task_id=? ORDER BY id DESC').all(t.id) as RunRow[];return success(c,{runs:await Promise.all(rows.map(runView))})})
app.get('/tasks/:id/versions',async c=>{const task=requireTask(Number(c.req.param('id')));return success(c,{versions:await getHost().listVersions(task.host_ref)})})
app.post('/runs/:id/cancel',async c=>{await cancelRun(Number(c.req.param('id')));return success(c,{status:'cancelled'})})
// ─── 参考图（Issue #123：资产 reference_images ↔ 工作室素材池）─────────────
app.post('/tasks/:id/reference-images',async c=>{
  const task=requireTask(Number(c.req.param('id')))
  const body=await c.req.parseBody()
  const file=body.file
  if(!(file instanceof File))return badRequest(c,'file 必填（multipart）')
  const referenceImages=await getHost().addReferenceImage(task.host_ref,file)
  await syncUserReferences(task.id)
  const {kind,id}=split(task.host_ref)
  return created(c,{reference_images:referenceImages,sources:await listSources(kind,id)})
})
app.delete('/tasks/:id/reference-images',async c=>{
  const task=requireTask(Number(c.req.param('id')))
  const url=String(c.req.query('url')??'')
  if(!url)return badRequest(c,'url 必填')
  const referenceImages=await getHost().removeReferenceImage(task.host_ref,url)
  const {kind,id}=split(task.host_ref)
  removeUserReferenceSource(kind,id,url)
  return success(c,{reference_images:referenceImages,sources:await listSources(kind,id)})
})
// ─── 检索记录（Issue #123：每次检索一行，全部可见，可单独/联合选用）─────────
app.get('/tasks/:id/research',async c=>{
  const {kind,id}=split(requireTask(Number(c.req.param('id'))).host_ref)
  const rows=researchRows(kind,id)
  const latestRunning=rows.find(r=>r.status==='running')
  const records=rows.map(r=>({
    id:r.id,status:r.status,step:r.step,instruction:r.instruction,keywords:r.keywords,
    error:r.error_msg,created_at:r.created_at,completed_at:r.completed_at,
    result:r.status==='completed'&&r.result?JSON.parse(r.result) as AssetResearchResult:null,
    ...(latestRunning&&r.id===latestRunning.id?{
      works:listObservedWork(r.id,'asset_studio_research'),
      ...callPage(r.id,'asset_studio_research',Number(c.req.query('after_id'))||0),
    }:{}),
  }))
  return success(c,{records})
})
app.post('/tasks/:id/research',async c=>{const task=requireTask(Number(c.req.param('id')));const a=await getHost().readAsset(task.host_ref);if(!a)return badRequest(c,'资产不存在');const p=await c.req.json();const id=await startAssetResearch(a,a.episodeId??0,{textConfigId:p.text_config_id,instruction:p.instruction?String(p.instruction):undefined,keywords:p.keywords?String(p.keywords):undefined});return created(c,{task_id:id})})
// ─── 素材 ────────────────────────────────────────────────────
app.get('/tasks/:id/sources',async c=>{const {kind,id}=split(requireTask(Number(c.req.param('id'))).host_ref);return success(c,{sources:await listSources(kind,id)})})
app.post('/sources',async c=>{const multipart=c.req.header('content-type')?.includes('multipart/form-data');const p=multipart?await c.req.parseBody():await c.req.json();const task=requireTask(Number(p.task_id));if(p.host_ref&&p.host_ref!==task.host_ref)return badRequest(c,'资产引用与任务不一致');const {kind,id}=split(task.host_ref);if(!['original','generation_reference','shape_only','rejected'].includes(String(p.role)))return badRequest(c,'素材角色非法');if(!String(p.license??'').trim())return badRequest(c,'许可信息必填');const file=p.file instanceof File?{bytes:Buffer.from(await p.file.arrayBuffer()),filename:p.file.name}:null;const origin=['user_reference','research','upload','manual'].includes(String(p.origin))?p.origin:'manual';const source=await addAssetSource({assetKind:kind,assetId:id,url:p.url||null,localPath:p.local_path||null,sourceUrl:p.source_url||null,title:p.title||null,artist:p.artist||null,license:String(p.license),role:p.role,origin,whyExcluded:p.why_excluded||null,era:p.era||null,file});let adoption=null;if(source.role==='original'){const before=await getHost().readAsset(task.host_ref);adoption=await getHost().adoptOriginal(task.host_ref,source.local_path);if(adoption.adopted){const after=await getHost().readAsset(task.host_ref);const active=stmt("SELECT * FROM asset_studio_run WHERE task_id=? AND status IN ('running','suspended')").all(task.id) as RunRow[];for(const r of active)if(parseParams(r.params).fingerprint===before?.fingerprint)await patchParams(r.id,{fingerprint:after?.fingerprint})}}return created(c,{...source,source,adoption})})
app.delete('/sources/:id',async c=>{const deleted=await deleteAssetSource(Number(c.req.param('id')));return deleted?success(c,{deleted:true}):notFound(c,'素材不存在')})
// ─── 草稿（Issue #123 核心）──────────────────────────────────
app.post('/tasks/:id/drafts',async c=>{const task=requireTask(Number(c.req.param('id')));const p=await c.req.json();const draft=await createDraft(task.id,{tab:p.tab,inputs:p.inputs??{},text_config_id:p.text_config_id?Number(p.text_config_id):null});return created(c,await draftView(draft))})
app.get('/tasks/:id/drafts',async c=>{const task=requireTask(Number(c.req.param('id')));return success(c,{drafts:listDrafts(task.id).map(d=>({...d,inputs:JSON.parse(d.inputs)}))})})
app.get('/drafts/:id',async c=>{const draft=getDraft(Number(c.req.param('id')));if(!draft)return notFound(c,'草稿不存在');return success(c,await draftView(draft))})
app.put('/drafts/:id',async c=>{const p=await c.req.json();const draft=editDraft(Number(c.req.param('id')),{prompt:String(p.prompt??''),negative_prompt:p.negative_prompt!=null?String(p.negative_prompt):undefined});return success(c,await draftView(draft))})
app.post('/drafts/:id/retry',async c=>{const draft=await retryDraft(Number(c.req.param('id')));return success(c,await draftView(draft))})
app.post('/drafts/:id/generate',async c=>{const p=await c.req.json().catch(()=>({}));const result=await generateFromDraft(Number(c.req.param('id')),{config_id:p.config_id?Number(p.config_id):null,model:p.model?String(p.model):null,expected_updated_at:p.expected_updated_at?String(p.expected_updated_at):null});return created(c,{run_id:result.runId,draft:await draftView(result.draft)})})
// ─── 交付（Issue #123 放宽：generated 即可交付，采用是显式动作）─────────────
app.post('/runs/:id/deliver',async c=>{const r=requireRun(Number(c.req.param('id')));const p=await c.req.json();const round=await getRound(Number(p.round_id));if(!round||round.pipeline_task_id!==r.id||!round.image_path||!round.image_sha256)return badRequest(c,'轮次不存在或没有生成图');if(round.status!=='generated')return badRequest(c,'该轮次尚未出图完成');if(round.image_task_id&&!stmt('SELECT 1 FROM sys_task WHERE id=?').get(round.image_task_id))return badRequest(c,'版本已删除，无法交付');const params=parseParams(r.params);const task=requireTask(r.task_id);const spec=round.spec_id?await getSpec(round.spec_id):null;return success(c,await getHost().deliver(task.host_ref,{runId:r.id,roundId:round.id,imagePath:round.image_path,sha256:round.image_sha256,setAsCurrent:p.set_as_current===true,sources:spec?.sources??[],frozenFingerprint:params.fingerprint}))})
app.get('/runs/:id/observed',c=>{
  const run=requireRun(Number(c.req.param('id')))
  return success(c,{
    works:listObservedWork(run.id,'asset_studio'),
    ...callPage(run.id,'asset_studio',Number(c.req.query('after_id'))||0),
    stage_spans:parseParams(run.params).stage_spans??[],
  })
})
app.get('/calls/:id/messages',c=>{
  const id=Number(c.req.param('id'))
  const scope=['asset_studio','asset_studio_research','asset_studio_draft'].find(s=>getObservedCall(id,s))
  if(!scope)return notFound(c,'调用不存在')
  return success(c,{
    messages:listObservedMessages(id,{scope,afterId:Number(c.req.query('after_id'))||0,limit:500}),
    total:countObservedMessages(id,scope),
  })
})
app.get('/settings',c=>{const all=settings();return success(c,{settings:Object.fromEntries(Object.entries(all).map(([k,v])=>[k,k.includes('key')||['europeana','smithsonian','openalex'].includes(k)?(v?'••••'+v.slice(-4):''):v]))})})
app.put('/settings',async c=>{const p=await c.req.json();const values=p.settings??p;saveSettings(Object.fromEntries(Object.entries(values).filter(([,v])=>typeof v==='string'&&!String(v).startsWith('••••'))) as Record<string,string>);return success(c,{saved:true})})
app.get('/model-options',async c=>success(c,{models:await getPlatform().modelOptions()}))