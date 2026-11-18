import {initSchema,stmt,getTask,type TaskRow} from './db.js'
import {setAssetStudioPlatform,getHost} from './registry.js'
import type {AssetStudioPlatform} from './contract.js'
import {settings,saveSettings} from './settings.js'
export async function initAssetStudio(platform:AssetStudioPlatform){initSchema();setAssetStudioPlatform(platform);const current=settings();const seeds=await platform.researchKeys();saveSettings(Object.fromEntries(Object.entries(seeds).filter(([key])=>!Object.hasOwn(current,key))))}
export async function openHostTask(ref:string){const asset=await getHost().readAsset(ref);const target=await getHost().describe(ref);if(!asset||!target)throw new Error('资产不存在');const ts=new Date().toISOString();stmt('INSERT OR IGNORE INTO asset_studio_task(host_ref,title,created_at,updated_at) VALUES (?,?,?,?)').run(ref,target.title,ts,ts);const task=stmt('SELECT * FROM asset_studio_task WHERE host_ref=? AND deleted_at IS NULL').get(ref) as TaskRow;return {task_id:task.id,path:`/asset-studio/${task.id}`,task,asset,target}}
