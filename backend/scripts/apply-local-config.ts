/**
 * 本机私有配置应用脚本 — 把仓库外的 AI 服务配置（含密钥）幂等写入 ai_service_configs
 *
 * 用法：cd backend && npx tsx scripts/apply-local-config.ts
 *
 * 配置文件：$HUOBAO_LOCAL_CONFIG_DIR/providers.json（默认 ~/.config/huobao-drama-local/providers.json）
 * 格式见 scripts/local-config.example.json。密钥/内网地址只放该目录，绝不入库提交。
 * 以 (service_type, provider, name) 为键：存在则更新，否则插入。
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../src/db/index.js'
import { isOfficialProvider, validateConfigModels } from '../src/services/ai.js'
import { now } from '../src/utils/response.js'

const configDir = process.env.HUOBAO_LOCAL_CONFIG_DIR || path.join(os.homedir(), '.config', 'huobao-drama-local')
const file = path.join(configDir, 'providers.json')

if (!fs.existsSync(file)) {
  console.error(`未找到本机配置文件: ${file}\n格式参考 backend/scripts/local-config.example.json`)
  process.exit(1)
}


interface LocalConfigEntry {
  service_type: string
  provider: string
  name: string
  base_url?: string
  api_key?: string
  model?: string[]
  priority?: number
  concurrency?: number
  temperature?: number
  /** 文本配置是否能看图（Issue #51）：需要视觉的 AI 环节只会选 true 的配置 */
  vision?: boolean
  /** 服务级参数（TTS 的 voice/seed/instructions/cfg_value/inference_timesteps 等）；留空的键沿用库里已有值 */
  settings?: Record<string, unknown>
}

const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
const rawConfigs: unknown =
  parsed && typeof parsed === 'object' && 'configs' in parsed ? parsed.configs : undefined
const entries: LocalConfigEntry[] = Array.isArray(rawConfigs) ? (rawConfigs as LocalConfigEntry[]) : []
if (!entries.length) {
  console.error(`${file} 中 configs 为空`)
  process.exit(1)
}

for (const [i, e] of entries.entries()) {
  const label = `configs[${i}]`
  if (!e.service_type || !e.provider || !e.name) {
    console.error(`${label} 缺少 service_type/provider/name`)
    process.exit(1)
  }
  if (!isOfficialProvider(e.service_type, e.provider)) {
    console.error(`${label} 不支持的 service_type/provider: ${e.service_type}/${e.provider}`)
    process.exit(1)
  }
  const modelError = validateConfigModels(e.service_type, e.provider, e.model)
  if (modelError) {
    console.error(`${label} ${modelError}`)
    process.exit(1)
  }
  if (e.concurrency !== undefined && (!Number.isInteger(e.concurrency) || e.concurrency < 0 || e.concurrency > 20)) {
    console.error(`${label} concurrency 须为 0 到 20 之间的整数`)
    process.exit(1)
  }
  const model = Array.isArray(e.model) ? e.model : []
  const where = and(
    eq(schema.aiServiceConfigs.serviceType, e.service_type),
    eq(schema.aiServiceConfigs.provider, e.provider),
    eq(schema.aiServiceConfigs.name, e.name),
  )
  const [existing] = await db.select().from(schema.aiServiceConfigs).where(where)
  // settings 合并：temperature 来自顶层字段，其余（TTS 的 voice/seed/instructions…）来自 settings 对象，
  // 已固定的音色不会被重复 apply 冲掉——留空的键沿用库里的值
  let settings: Record<string, unknown> = {}
  try { settings = existing?.settings ? JSON.parse(existing.settings) : {} } catch { settings = {} }
  if (typeof e.temperature === 'number') settings.temperature = e.temperature
  if (e.settings && typeof e.settings === 'object') {
    for (const [key, value] of Object.entries(e.settings as Record<string, unknown>)) {
      if (value === null || value === undefined || value === '') continue
      settings[key] = value
    }
  }
  const values = {
    baseUrl: e.base_url || '',
    apiKey: e.api_key || '',
    model: JSON.stringify(model),
    priority: Number(e.priority) || 0,
    concurrency: e.concurrency ?? existing?.concurrency ?? 0,
    isActive: true,
    // 文本配置的视觉标定（#51）：没写就沿用库里已有标记（新行默认 false），避免 apply 一次把人工标定冲掉
    vision: typeof e.vision === 'boolean' ? e.vision : existing?.vision === true,
    settings: Object.keys(settings).length ? JSON.stringify(settings) : null,
    updatedAt: now(),
  }
  if (existing) {
    await db.update(schema.aiServiceConfigs).set(values).where(where)
    console.log(`updated  ${e.service_type}/${e.provider}/${e.name}`)
  } else {
    await db.insert(schema.aiServiceConfigs).values({
      serviceType: e.service_type,
      provider: e.provider,
      name: e.name,
      ...values,
      createdAt: now(),
    })
    console.log(`inserted ${e.service_type}/${e.provider}/${e.name}`)
  }
}
