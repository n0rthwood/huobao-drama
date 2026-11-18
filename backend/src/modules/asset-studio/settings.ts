import {stmt} from './db.js'
import {getPlatform} from './registry.js'
export function settings():Record<string,string> {return Object.fromEntries((stmt('SELECT key,value FROM asset_studio_setting').all() as {key:string;value:string}[]).map(r=>[r.key,r.value]))}
export function saveSettings(values:Record<string,string>){for(const [k,v] of Object.entries(values))stmt('INSERT INTO asset_studio_setting(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,v)}
export async function getResearchApiKey(key:string):Promise<string>{const current=settings();if(Object.hasOwn(current,key))return current[key]??'';const seed=await getPlatform().researchKeys();saveSettings(seed);return seed[key]??''}
