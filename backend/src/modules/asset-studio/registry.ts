import type {AssetStudioHost,AssetStudioPlatform} from './contract.js'
let platform: AssetStudioPlatform
const hosts = new Map<string,AssetStudioHost>()
export function setAssetStudioPlatform(value:AssetStudioPlatform) { platform=value }
export function getPlatform() { if(!platform) throw new Error('资产工作室平台未注入'); return platform }
export function registerAssetStudioHost(host:AssetStudioHost) { hosts.set(host.id,host) }
export function getHost(id='huobao') { const host=hosts.get(id); if(!host) throw new Error('资产工作室宿主未注册'); return host }
