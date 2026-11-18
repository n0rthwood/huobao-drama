import {Hono} from 'hono'
import {success,created,badRequest,notFound} from '../../utils/response.js'
import {listObservedWork,listObservedCalls,listObservedMessages,countObservedMessages,getObservedCall} from '../../services/task-observability.js'

import {stmt,getTask,getRun,parseParams,patchParams,type RunRow,type TaskRow} from './db.js'
import {getHost,getPlatform} from './registry.js'
import {openHostTask} from './tasks.js'
import {startAssetPipeline,approveRound,cancelRun,suspendedApproval,PipelineConflictError,PipelineStateError} from './run.js'
import {getSpec,getRound,listRounds,listSources,latestQcByRound,type RoundPurpose,type AssetKind} from './store.js'
import {roundReferenceImages} from './references.js'
import {serializeQcGate} from './gate-serialization.js'
import {decideRound} from './gate.js'
import {AssetStudioDeliveryConflict,ReferenceSelectionError,ImageSelectionError,RoundPlanError} from './contract.js'
import {addAssetSource,deleteAssetSource,AssetSourceError} from './sources.js'
import {getAssetResearch,startAssetResearch,ResearchConflictError} from './research/run.js'
import {settings,saveSettings} from './settings.js'
function callPage(taskId:number,scope:string,afterId:number){
  const calls=listObservedCalls(taskId,{scope,afterId,limit:200})
  const lastId=calls[calls.length-1]?.id??afterId
  const hasMore=calls.length===200&&listObservedCalls(taskId,{scope,afterId:lastId,limit:1}).length>0
  return {calls,has_more:hasMore,next_after_id:lastId}
}
export const assetStudioRoutes=new Hono()
const app=assetStudioRoutes
app.onError((err,c)=>{if(err instanceof AssetStudioDeliveryConflict||err instanceof PipelineConflictError||err instanceof ResearchConflictError)return c.json({code:409,message:err.message},409);if(err instanceof PipelineStateError||err instanceof ReferenceSelectionError||err instanceof ImageSelectionError||err instanceof RoundPlanError||err instanceof AssetSourceError)return badRequest(c,err.message);throw err})
function requireTask(id:number){const task=getTask(id);if(!task)throw new PipelineStateError('工作室任务不存在');return task}
function requireRun(id:number){const run=getRun(id);if(!run)throw new PipelineStateError('工作室运行不存在');return run}
function split(ref:string){const [kind,id]=ref.split(':');return {kind:kind as AssetKind,id:Number(id)}}
async function runView(row:RunRow){const p=parseParams(row.params);const suspended=row.status==='suspended'&&row.mastra_run_id?await suspendedApproval(row.mastra_run_id):null;return {...row,params:p,purpose:row.purpose,reference_source_ids:p.reference_source_ids??null,image_config_id:p.image_config_id??null,image_model:p.image_model??null,step:p.progress?.step??null,asset_kind:p.asset_kind,asset_id:p.asset_id,episode_id:p.episode_id,error:row.error_msg,result:p.result??null,pipeline:{state:suspended?'waiting_approval':row.status,awaiting:suspended?.payload??null,asset_kind:p.asset_kind,asset_id:p.asset_id}}}
async function detail(task:TaskRow,runId?:number){const asset=await getHost().readAsset(task.host_ref);const target=await getHost().describe(task.host_ref);const {kind,id}=split(task.host_ref);const runs=stmt('SELECT * FROM asset_studio_run WHERE task_id=? ORDER BY id DESC').all(task.id) as RunRow[];const row=runId?runs.find(r=>r.id===runId):runs[0];if(runId&&!row)throw new PipelineStateError('运行不属于该任务');const run=row?await runView(row):null;const p=row?parseParams(row.params):{};const spec=p.asset_spec_id?await getSpec(Number(p.asset_spec_id)):null;const rounds=row?await listRounds(row.id):[];const qc=await latestQcByRound(rounds.map(r=>r.id));const history=rounds.map(r=>({round_no:r.round_no,purpose:r.purpose,gate_pass:qc.get(r.id)?qc.get(r.id)!.gate_pass===1:null,human_verdict:qc.get(r.id)?.human_verdict??null,status:r.status}));return {task,asset,target,run,spec,rounds:await Promise.all(rounds.map(async r=>({...r,reference_images:await roundReferenceImages(r),qc:qc.get(r.id)??null,gate:qc.get(r.id)?serializeQcGate(qc.get(r.id)!,spec):null,suggestion:qc.get(r.id)?decideRound(history.filter(h=>h.round_no<=r.round_no)):null}))),awaiting:run?.pipeline.awaiting??null,sources:await listSources(kind,id),deliveries:stmt('SELECT d.* FROM asset_studio_delivery d JOIN asset_studio_run r ON r.id=d.run_id WHERE r.task_id=? ORDER BY d.id DESC').all(task.id)}}
app.get('/tasks',async c=>{const tasks=stmt('SELECT * FROM asset_studio_task WHERE deleted_at IS NULL ORDER BY updated_at DESC,id DESC').all() as TaskRow[];return success(c,{tasks:await Promise.all(tasks.map(async t=>{const r=stmt('SELECT * FROM asset_studio_run WHERE task_id=? ORDER BY id DESC LIMIT 1').get(t.id) as RunRow|undefined;return {...t,status:r?.status??'idle',stage:r?parseParams(r.params).progress?.step??null:null,target:await getHost().describe(t.host_ref)}}))})})
app.post('/tasks/open',async c=>{const p=await c.req.json();if(!/^(character|scene|prop):[1-9]\d*$/.test(p.host_ref??''))return badRequest(c,'host_ref 必须是资产引用');return success(c,await openHostTask(p.host_ref))})
app.get('/tasks/:id',async c=>success(c,await detail(requireTask(Number(c.req.param('id'))),Number(c.req.query('run_id'))||undefined)))
app.get('/tasks/:id/runs',async c=>{const t=requireTask(Number(c.req.param('id')));const rows=stmt('SELECT * FROM asset_studio_run WHERE task_id=? ORDER BY id DESC').all(t.id) as RunRow[];return success(c,{runs:await Promise.all(rows.map(runView))})})
app.post('/tasks/:id/run',async c=>{const task=requireTask(Number(c.req.param('id')));const p=await c.req.json();if(p.purpose!=='precision'&&p.purpose!=='beautify')return badRequest(c,'purpose 必须是 precision / beautify');const {kind,id}=split(task.host_ref);const asset=await getHost().readAsset(task.host_ref);if(!asset)return badRequest(c,'资产不存在');const result=await startAssetPipeline({taskId:task.id,assetKind:kind,assetId:id,episodeId:asset.episodeId??0,purpose:p.purpose,sourceIds:p.source_ids,configId:p.config_id,model:p.model,textConfigId:p.text_config_id});return created(c,{run_id:result.runId,mastra_run_id:result.mastraRunId})})
app.post('/runs/:id/approve',async c=>{const p=await c.req.json();if(!['approve','revise','rollback','abort'].includes(p.verdict))return badRequest(c,'verdict 非法');await approveRound({runId:Number(c.req.param('id')),roundId:Number(p.round_id),verdict:p.verdict,selectedViolations:Array.isArray(p.selected_violations)?p.selected_violations.map(String):[],notes:p.notes?String(p.notes):null,opened:Array.isArray(p.opened)?p.opened:[],overrideGate:p.override_gate===true,nextPurpose:p.next_purpose});return success(c,{status:'ok'})})
app.post('/runs/:id/cancel',async c=>{await cancelRun(Number(c.req.param('id')));return success(c,{status:'cancelled'})})
app.get('/tasks/:id/research',async c=>{
  const {kind,id}=split(requireTask(Number(c.req.param('id'))).host_ref)
  const research=await getAssetResearch(kind,id)
  const researchId=research.task_id
  return success(c,{
    ...research,
    works:researchId?listObservedWork(researchId,'asset_studio_research'):[],
    ...(researchId?callPage(researchId,'asset_studio_research',Number(c.req.query('after_id'))||0):{calls:[],has_more:false,next_after_id:0}),
  })
})
app.post('/tasks/:id/research',async c=>{const task=requireTask(Number(c.req.param('id')));const a=await getHost().readAsset(task.host_ref);if(!a)return badRequest(c,'资产不存在');const p=await c.req.json();const id=await startAssetResearch(a,a.episodeId??0,{textConfigId:p.text_config_id});return created(c,{task_id:id})})
app.get('/tasks/:id/sources',async c=>{const {kind,id}=split(requireTask(Number(c.req.param('id'))).host_ref);return success(c,{sources:await listSources(kind,id)})})
app.post('/sources',async c=>{const multipart=c.req.header('content-type')?.includes('multipart/form-data');const p=multipart?await c.req.parseBody():await c.req.json();const task=requireTask(Number(p.task_id));if(p.host_ref&&p.host_ref!==task.host_ref)return badRequest(c,'资产引用与任务不一致');const {kind,id}=split(task.host_ref);if(!['original','generation_reference','shape_only','rejected'].includes(String(p.role)))return badRequest(c,'素材角色非法');if(!String(p.license??'').trim())return badRequest(c,'许可信息必填');const file=p.file instanceof File?{bytes:Buffer.from(await p.file.arrayBuffer()),filename:p.file.name}:null;const source=await addAssetSource({assetKind:kind,assetId:id,url:p.url||null,localPath:p.local_path||null,sourceUrl:p.source_url||null,title:p.title||null,artist:p.artist||null,license:String(p.license),role:p.role,whyExcluded:p.why_excluded||null,era:p.era||null,file});let adoption=null;if(source.role==='original'){const before=await getHost().readAsset(task.host_ref);adoption=await getHost().adoptOriginal(task.host_ref,source.local_path);if(adoption.adopted){const after=await getHost().readAsset(task.host_ref);const active=stmt("SELECT * FROM asset_studio_run WHERE task_id=? AND status IN ('running','suspended')").all(task.id) as RunRow[];for(const r of active)if(parseParams(r.params).fingerprint===before?.fingerprint)await patchParams(r.id,{fingerprint:after?.fingerprint})}}return created(c,{...source,source,adoption})})
app.delete('/sources/:id',async c=>{const deleted=await deleteAssetSource(Number(c.req.param('id')));return deleted?success(c,{deleted:true}):notFound(c,'素材不存在')})
app.post('/runs/:id/deliver',async c=>{const r=requireRun(Number(c.req.param('id')));const p=await c.req.json();const round=await getRound(Number(p.round_id));if(!round||round.pipeline_task_id!==r.id||!round.image_path||!round.image_sha256)return badRequest(c,'轮次不存在或没有生成图');if(r.status!=='completed')return badRequest(c,'运行未完成人工审批');const qc=(await latestQcByRound([round.id])).get(round.id);if(qc?.human_verdict!=='approve')return badRequest(c,'该轮次尚未人工通过');const params=parseParams(r.params);const task=requireTask(r.task_id);const spec=round.spec_id?await getSpec(round.spec_id):null;return success(c,await getHost().deliver(task.host_ref,{runId:r.id,roundId:round.id,imagePath:round.image_path,sha256:round.image_sha256,setAsCurrent:p.set_as_current===true,sources:spec?.sources??[],frozenFingerprint:params.fingerprint}))})
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
  const scope=getObservedCall(id,'asset_studio')?'asset_studio':'asset_studio_research'
  if(!getObservedCall(id,scope))return notFound(c,'调用不存在')
  return success(c,{
    messages:listObservedMessages(id,{scope,afterId:Number(c.req.query('after_id'))||0,limit:500}),
    total:countObservedMessages(id,scope),
  })
})
app.get('/settings',c=>{const all=settings();return success(c,{settings:Object.fromEntries(Object.entries(all).map(([k,v])=>[k,k.includes('key')||['europeana','smithsonian','openalex'].includes(k)?(v?'••••'+v.slice(-4):''):v]))})})
app.put('/settings',async c=>{const p=await c.req.json();const values=p.settings??p;saveSettings(Object.fromEntries(Object.entries(values).filter(([,v])=>typeof v==='string'&&!String(v).startsWith('••••'))) as Record<string,string>);return success(c,{saved:true})})
app.get('/model-options',async c=>success(c,{models:await getPlatform().modelOptions()}))
