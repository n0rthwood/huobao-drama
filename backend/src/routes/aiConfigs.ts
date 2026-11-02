import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, notFound, created, badRequest, now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { joinProviderUrl } from '../services/adapters/url.js'
import { hasVersionedPath, isOfficialProvider, parseConfigTemperature, validateConfigModels } from '../services/ai.js'
import { fetchVoices } from '../services/tts.js'
import { redactUrl, logTaskError, logTaskProgress, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

/** 归一化 temperature 入参：null=未设置；合法值 0~2；非法抛错 */
function normalizeTemperature(v: any): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 2) throw new Error('invalid temperature')
  return n
}

/** 把 settings JSON 中的可写字段透出为顶层字段，便于前端直接读写（api_key 不在此列） */
function withParsedFields(r: Record<string, unknown>) {
  let settings: Record<string, unknown> = {}
  try {
    const raw = r.settings
    settings = typeof raw === 'string' && raw ? JSON.parse(raw) : {}
  } catch {
    settings = {}
  }
  const { temperature: _temperature, ...ttsSettings } = settings
  return {
    ...toSnakeCase(r),
    model: typeof r.model === 'string' && r.model ? JSON.parse(r.model) : [],
    temperature: parseConfigTemperature(typeof r.settings === 'string' ? r.settings : null),
    // TTS 的音色与可选参数（voice 由后端在保存时固定，前端只读展示）
    tts_settings: r.serviceType === 'tts' ? ttsSettings : undefined,
  }
}

function bearerHeaders(apiKey?: string, withJson = false) {
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  if (withJson) headers['Content-Type'] = 'application/json'
  return headers
}

function geminiHeaders(apiKey?: string, withJson = false) {
  const headers: Record<string, string> = {}
  if (apiKey) {
    headers['x-goog-api-key'] = apiKey
  }
  if (withJson) headers['Content-Type'] = 'application/json'
  return headers
}

function buildProbe(serviceType: string, provider: string, baseUrl: string, model?: string, apiKey?: string) {
  const p = provider.toLowerCase()
  const m = model || ''

  if (p === 'gemini') {
    // 探针统一走 generateContent:文本运行时(AI SDK)走的就是它,官方与中转站都支持;
    // interactions 端点很多中转站未配置,探它会误报 500。
    // 用最小合法请求体而非空体——空体在部分中转站会触发上游认证失败的误报
    const modelName = m || 'gemini-3.1-pro-preview'
    const url = new URL(joinProviderUrl(baseUrl, '/v1beta', `/models/${modelName}:generateContent`))
    if (apiKey) url.searchParams.set('key', apiKey)
    return {
      method: 'POST',
      url: url.toString(),
      headers: geminiHeaders(apiKey, true),
      body: { contents: [{ parts: [{ text: 'hi' }] }] },
    }
  }

  if (p === 'openai') {
    return {
      method: 'GET',
      url: joinProviderUrl(baseUrl, hasVersionedPath(baseUrl) ? '' : '/v1', '/models'),
      headers: bearerHeaders(apiKey),
      body: undefined,
    }
  }

  if (p === 'volcengine') {
    const path = serviceType === 'video'
      ? '/contents/generations/tasks'
      : serviceType === 'text'
        ? '/chat/completions'
        : '/images/generations'
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '/api/v3', path),
      headers: bearerHeaders(apiKey, true),
      body: {},
    }
  }

  if (p === 'minimax') {
    // MiniMax 仅提供视频服务，空请求体探测鉴权/端点连通性
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '/v2', '/video_generation'),
      headers: bearerHeaders(apiKey, true),
      body: {},
    }
  }

  if (p === 'qwen-jobs') {
    // qwen-jobs 任务服务：/v1/capacity 返回卡状态即服务可达；凭据是网关 Basic 的 user:password
    return {
      method: 'GET',
      url: joinProviderUrl(baseUrl, '', '/v1/capacity'),
      headers: apiKey ? { Authorization: `Basic ${Buffer.from(apiKey, 'utf8').toString('base64')}` } : {},
      body: undefined,
    }
  }

  if (p === 'comfyui') {
    // ComfyUI 无鉴权概念，/system_stats 返回 200 即引擎可达；有 key（反代场景）才带 Authorization
    return {
      method: 'GET',
      url: joinProviderUrl(baseUrl, '', '/system_stats'),
      headers: bearerHeaders(apiKey),
      body: undefined,
    }
  }

  if (p === 'voxcpm') {
    // VoxCPM 语音合成：/api/status 返回 {"engine":{"ok":true,…}} 即引擎可达；LAN 部署无鉴权
    return {
      method: 'GET',
      url: joinProviderUrl(baseUrl, '', '/api/status'),
      headers: bearerHeaders(apiKey),
      body: undefined,
    }
  }


  return {
    method: 'GET',
    url: joinProviderUrl(baseUrl, '', m ? `/${m}` : '/'),
    headers: bearerHeaders(apiKey),
    body: undefined,
  }
}

// GET /ai-configs?service_type=text
app.get('/', async (c) => {
  const serviceType = c.req.query('service_type')
  let rows = await db.select().from(schema.aiServiceConfigs)
  if (serviceType) rows = rows.filter(r => r.serviceType === serviceType)

  const parsed = rows.map(withParsedFields)
  return success(c, parsed)
})

/**
 * TTS 可选参数：voice / instructions / cfg_value / inference_timesteps / seed。
 * 合并进 settings JSON，省略/置空的键视为清除。
 * voice（#35）由人在设置页从服务的音色列表里选定 —— 程序绝不替用户挑「第一个」。
 */
function mergeTtsSettings(settings: Record<string, any>, raw: unknown): Record<string, any> {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  for (const key of ['voice', 'instructions', 'cfg_value', 'inference_timesteps', 'seed'] as const) {
    const value = input[key]
    if (value === undefined || value === null || value === '') {
      delete settings[key]
      continue
    }
    settings[key] = key === 'voice' || key === 'instructions' ? String(value) : Number(value)
  }
  return settings
}

/** TTS 配置必须带音色：没有音色合成出来的整集听感会漂（#35） */
function ttsVoiceError(serviceType: string, settings: Record<string, any>): string | null {
  if (serviceType !== 'tts') return null
  const voice = typeof settings.voice === 'string' ? settings.voice.trim() : ''
  return voice ? null : 'TTS 配置必须选定音色：请先点「刷新音色列表」，再从列表里选一个音色'
}

// POST /ai-configs
app.post('/', async (c) => {
  const body = await c.req.json()
  const ts = now()

  // 验证必填字段
  if (!body.service_type || !body.provider) {
    return badRequest(c, '需要 service_type 与 provider')
  }
  if (!isOfficialProvider(body.service_type, body.provider)) {
    return badRequest(c, '不支持的 service_type/provider')
  }
  const modelError = validateConfigModels(body.service_type, body.provider, body.model)
  if (modelError) return badRequest(c, modelError)


  let temperature: number | null = null
  if ('temperature' in body) {
    try {
      temperature = normalizeTemperature(body.temperature)
    } catch {
      return badRequest(c, 'temperature 须为 0 到 2 之间的数字')
    }
  }

  const settings: Record<string, any> = temperature !== null ? { temperature } : {}
  if ('tts_settings' in body) mergeTtsSettings(settings, body.tts_settings)
  const voiceError = ttsVoiceError(body.service_type, settings)
  if (voiceError) return badRequest(c, voiceError)

  const res = await db.insert(schema.aiServiceConfigs).values({
    serviceType: body.service_type,
    provider: body.provider,
    name: body.name || `${body.provider}-${body.service_type}`,
    baseUrl: body.base_url || '',
    apiKey: body.api_key || '',
    model: JSON.stringify(body.model || []),
    priority: body.priority || 0,
    isActive: true,
    settings: Object.keys(settings).length ? JSON.stringify(settings) : null,
    createdAt: ts,
    updatedAt: ts,
  })

  const configId = getInsertId(res)
  const [row] = await db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, configId))

  return created(c, withParsedFields(row))
})

// POST /ai-configs/test
app.post('/test', async (c) => {
  const body = await c.req.json()
  if (!body.service_type || !body.provider || !body.base_url) {
    return badRequest(c, '需要 service_type、provider 与 base_url')
  }
  if (!isOfficialProvider(body.service_type, body.provider)) {
    return badRequest(c, '不支持的 service_type/provider')
  }
  const modelError = validateConfigModels(body.service_type, body.provider, body.model)
  if (modelError) return badRequest(c, modelError)


  const model = Array.isArray(body.model) ? body.model[0] : body.model
  const probe = buildProbe(body.service_type, body.provider, body.base_url, model, body.api_key)
  const probeUrl = redactUrl(probe.url)

  logTaskProgress('AIConfig', 'probe-start', {
    serviceType: body.service_type,
    provider: body.provider,
    method: probe.method,
    url: probeUrl,
  })

  try {
    const resp = await fetch(probe.url, {
      method: probe.method,
      headers: probe.headers,
      body: probe.body ? JSON.stringify(probe.body) : undefined,
    })
    const text = await resp.text()
    const reachable = [200, 204, 400, 401, 403].includes(resp.status)
    const payload = {
      ok: resp.ok,
      reachable,
      status: resp.status,
      status_text: resp.statusText,
      method: probe.method,
      url: probeUrl,
      message: reachable
        ? (resp.ok ? '端点可访问，认证与路径基本正常' : '端点已响应，请根据状态码判断认证或路径是否正确')
        : '端点未按预期响应，请检查 Base URL 和代理前缀',
      response_preview: text.slice(0, 240),
    }
    if (reachable) {
      logTaskSuccess('AIConfig', 'probe-done', {
        provider: body.provider,
        status: resp.status,
        url: probeUrl,
      })
    } else {
      logTaskError('AIConfig', 'probe-unexpected', {
        provider: body.provider,
        status: resp.status,
        url: probeUrl,
      })
    }
    return success(c, payload)
  } catch (error: any) {
    logTaskError('AIConfig', 'probe-failed', {
      provider: body.provider,
      url: probeUrl,
      error: error.message,
    })
    return success(c, {
      ok: false,
      reachable: false,
      method: probe.method,
      url: probeUrl,
      message: error.message || '请求失败',
      response_preview: '',
    })
  }
})

/**
 * GET /ai-configs/tts-voices?base_url=&api_key=&config_id= — 列出 TTS 服务的音色（#35）。
 * 设置页据此让人选音色；程序不再自动取第一个。
 */
app.get('/tts-voices', async (c) => {
  const configId = Number(c.req.query('config_id') || 0)
  let baseUrl = c.req.query('base_url') || ''
  let apiKey = c.req.query('api_key') || ''
  if (configId) {
    const [row] = await db.select().from(schema.aiServiceConfigs)
      .where(eq(schema.aiServiceConfigs.id, configId))
    if (!row) return badRequest(c, '配置不存在')
    if (row.serviceType !== 'tts') return badRequest(c, '该配置不是 TTS 配置')
    baseUrl = baseUrl || row.baseUrl
    apiKey = apiKey || row.apiKey || ''
  }
  if (!baseUrl) return badRequest(c, '需要 base_url 或 config_id')
  try {
    return success(c, { voices: await fetchVoices(baseUrl, apiKey || undefined) })
  } catch (err) {
    const message = err instanceof Error ? err.message : '读取音色列表失败'
    logTaskError('AIConfig', 'tts-voices', { baseUrl, error: message })
    return badRequest(c, `读取音色列表失败：${message}`)
  }
})

// GET /ai-configs/:id
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id))
  if (!row) return notFound(c)
  return success(c, withParsedFields(row))
})

// PUT /ai-configs/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [existing] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id))
  if (!existing) return notFound(c)

  const serviceType = 'service_type' in body ? body.service_type : existing.serviceType
  const provider = 'provider' in body ? body.provider : existing.provider
  if (!isOfficialProvider(serviceType, provider)) {
    return badRequest(c, '不支持的 service_type/provider')
  }
  let models: unknown = body.model
  if (!('model' in body)) {
    try { models = existing.model ? JSON.parse(existing.model) : [] } catch { models = [] }
  }
  const modelError = validateConfigModels(serviceType, provider, models)
  if (modelError) return badRequest(c, modelError)


  const updates: Record<string, any> = { updatedAt: now() }

  if ('service_type' in body) updates.serviceType = body.service_type
  if ('provider' in body) updates.provider = body.provider
  if ('name' in body) updates.name = body.name
  if ('base_url' in body) updates.baseUrl = body.base_url
  if ('api_key' in body) updates.apiKey = body.api_key
  if ('model' in body) updates.model = JSON.stringify(body.model)
  if ('priority' in body) updates.priority = body.priority
  if ('is_active' in body) updates.isActive = body.is_active
  if ('temperature' in body || 'tts_settings' in body) {
    // 与已有 settings 合并：清空的 temperature 从 JSON 中移除，已固定的 voice 保留不动
    let settings: Record<string, any> = {}
    try { settings = existing.settings ? JSON.parse(existing.settings) : {} } catch { settings = {} }
    if ('temperature' in body) {
      let temperature: number | null
      try {
        temperature = normalizeTemperature(body.temperature)
      } catch {
        return badRequest(c, 'temperature 须为 0 到 2 之间的数字')
      }
      if (temperature === null) delete settings.temperature
      else settings.temperature = temperature
    }
    if ('tts_settings' in body) mergeTtsSettings(settings, body.tts_settings)
    const voiceError = ttsVoiceError(serviceType, settings)
    if (voiceError) return badRequest(c, voiceError)
    updates.settings = Object.keys(settings).length ? JSON.stringify(settings) : null
  }

  await db.update(schema.aiServiceConfigs).set(updates).where(eq(schema.aiServiceConfigs.id, id))
  return success(c)
})

// DELETE /ai-configs/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id))
  return success(c)
})

// GET /ai-providers
export const aiProviders = new Hono()
aiProviders.get('/', async (c) => {
  const rows = await db.select().from(schema.aiServiceProviders)
  const parsed = rows.map(r => ({
    ...toSnakeCase(r),
    preset_models: r.presetModels ? JSON.parse(r.presetModels) : [],
  }))
  return success(c, parsed)
})

export default app
