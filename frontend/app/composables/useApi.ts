import type { TaskRow, CenterRow } from '~/composables/useTasks'

const BASE = '/api/v1'

async function req<T = any>(method: string, path: string, body?: any): Promise<T> {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)

  const start = performance.now()
  console.log(`%c[API] %c${method} %c${path}`, 'color:#888', 'color:#4fc3f7;font-weight:bold', 'color:#ccc', body || '')

  try {
    const resp = await fetch(`${BASE}${path}`, opts)
    const json = await resp.json()
    const ms = Math.round(performance.now() - start)

    if (!resp.ok || (json.code && json.code >= 400)) {
      console.log(`%c[API] %c${method} ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold', 'color:#888', json.message || '')
      throw new Error(json.message || `${resp.status}`)
    }

    console.log(`%c[API] %c${method} ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#66bb6a', 'color:#66bb6a;font-weight:bold', 'color:#888')
    return json.data ?? json
  } catch (err: any) {
    if (!err.message?.match(/^\d{3}$/)) {
      const ms = Math.round(performance.now() - start)
      console.log(`%c[API] %c${method} ${path} %cERROR %c${ms}ms`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold', 'color:#888', err.message)
    }
    throw err
  }
}

export const api = {
  get: <T = any>(p: string) => req<T>('GET', p),
  post: <T = any>(p: string, b?: any) => req<T>('POST', p, b),
  put: <T = any>(p: string, b?: any) => req<T>('PUT', p, b),
  del: <T = any>(p: string) => req<T>('DELETE', p),
}

export const dramaAPI = {
  list: () => api.get<{ items: any[] }>('/dramas'),
  get: (id: number) => api.get(`/dramas/${id}`),
  create: (data: any) => api.post('/dramas', data),
  update: (id: number, data: any) => api.put(`/dramas/${id}`, data),
  del: (id: number) => api.del(`/dramas/${id}`),
}

export const episodeAPI = {
  create: (data: any) => api.post('/episodes', data),
  update: (id: number, data: any) => api.put(`/episodes/${id}`, data),
  del: (id: number) => api.del(`/episodes/${id}`),
  characters: (id: number) => api.get(`/episodes/${id}/characters`),
  scenes: (id: number) => api.get(`/episodes/${id}/scenes`),
  props: (id: number) => api.get(`/episodes/${id}/props`),
  storyboards: (id: number) => api.get(`/episodes/${id}/storyboards`),
  pipelineStatus: (id: number) => api.get(`/episodes/${id}/pipeline-status`),
  extract: (id: number, target: string, model?: string, configId?: number) => api.post(`/episodes/${id}/extract`, { target, model: model || undefined, config_id: configId || undefined }),
  extractStatus: (id: number) => api.get(`/episodes/${id}/extract-status`),
  generateVideoPrompts: (id: number, model?: string, configId?: number, storyboardIds?: number[]) => api.post(`/episodes/${id}/generate-video-prompts`, { model: model || undefined, config_id: configId || undefined, storyboard_ids: storyboardIds?.length ? storyboardIds : undefined }),
  videoPromptsStatus: (id: number) => api.get(`/episodes/${id}/video-prompts-status`),
  // 批量补齐关键帧提示词（首/中/尾三槽），与视频提示词批量同一套异步状态模型
  generateKeyframePrompts: (id: number, data: { storyboard_ids?: number[]; model?: string; config_id?: number } = {}) =>
    api.post(`/episodes/${id}/generate-keyframe-prompts`, {
      storyboard_ids: data.storyboard_ids?.length ? data.storyboard_ids : undefined,
      model: data.model || undefined,
      config_id: data.config_id || undefined,
    }),
  keyframePromptsStatus: (id: number) => api.get(`/episodes/${id}/keyframe-prompts-status`),
  // 批量关键帧预览：逐「分镜 × 槽位」给出 缺图/已变化/未变化(同第 N 版)/被拦截/跳过 与默认勾选
  keyframeBatchPreview: (id: number, data: { storyboard_ids?: number[]; model?: string; config_id?: number } = {}) =>
    api.post(`/episodes/${id}/keyframe-batch/preview`, {
      storyboard_ids: data.storyboard_ids?.length ? data.storyboard_ids : undefined,
      model: data.model || undefined,
      config_id: data.config_id || undefined,
    }),
  // 集级关键帧批量：按预览勾选的 items 显式提交，由服务端排队调度
  startKeyframeBatch: (id: number, data: { items: Array<{ storyboard_id: number; slot: 'first' | 'mid' | 'last' }>; model?: string; config_id?: number }) =>
    api.post(`/episodes/${id}/keyframe-batch`, {
      items: data.items,
      model: data.model || undefined,
      config_id: data.config_id || undefined,
    }),
  keyframeBatch: (id: number) => api.get(`/episodes/${id}/keyframe-batch`),
  cancelKeyframeBatch: (id: number) => api.post(`/episodes/${id}/keyframe-batch/cancel`),
  // 失败/已取消的关键帧项重新提交（每项新建 sys_task，不复用原任务）
  retryFailedKeyframeBatch: (id: number) => api.post(`/episodes/${id}/keyframe-batch/retry-failed`),
  // 批量视频预览：逐镜按输入签名列出 缺视频/已变化/未变化(同第N版)/无法判断/阻断/跳过
  previewVideoBatch: (id: number, data: { storyboard_ids?: number[]; model?: string; config_id?: number }) =>
    api.post(`/episodes/${id}/video-batch/preview`, {
      storyboard_ids: data.storyboard_ids?.length ? data.storyboard_ids : undefined,
      model: data.model || undefined,
      config_id: data.config_id || undefined,
    }),
  // 集级串行视频批量：按预览勾选的镜头，后端按分镜顺序生成
  startVideoBatch: (id: number, data: { storyboard_ids: number[]; model?: string; config_id?: number }) =>
    api.post(`/episodes/${id}/video-batch`, {
      storyboard_ids: data.storyboard_ids,
      model: data.model || undefined,
      config_id: data.config_id || undefined,
    }),
  videoBatch: (id: number) => api.get(`/episodes/${id}/video-batch`),
  cancelVideoBatch: (id: number) => api.post(`/episodes/${id}/video-batch/cancel`),
}

export const storyboardAPI = {
  create: (data: any) => api.post('/storyboards', data),
  update: (id: number, data: any) => api.put(`/storyboards/${id}`, data),
  del: (id: number) => api.del(`/storyboards/${id}`),
  // 视频生成参数（关键帧引导、参考图 / @图片N 映射 / 分辨率）全部由后端组装
  generateVideo: (id: number, data: { model?: string; config_id?: number }) =>
    api.post(`/storyboards/${id}/generate-video`, { model: data.model || undefined, config_id: data.config_id || undefined }),
  // 关键帧槽位：first | mid | last
  generateKeyframe: (id: number, slot: 'first' | 'mid' | 'last', data: { prompt?: string; model?: string; config_id?: number } = {}) =>
    api.post(`/storyboards/${id}/keyframes/${slot}/generate`, {
      prompt: data.prompt || undefined,
      model: data.model || undefined,
      config_id: data.config_id || undefined,
    }),
  keyframeVersions: (id: number, slot: 'first' | 'mid' | 'last') => api.get(`/storyboards/${id}/keyframes/${slot}/versions`),
  // { image } 选定该槽位版本；{ inherit: true } 仅首帧：清除自有首帧改用上一镜尾帧
  selectKeyframe: (id: number, slot: 'first' | 'mid' | 'last', data: { image?: string; inherit?: boolean }) =>
    api.put(`/storyboards/${id}/keyframes/${slot}`, data),
  confirmKeyframes: (id: number, confirmed: boolean) => api.post(`/storyboards/${id}/confirm-keyframes`, { confirmed }),
}

/**
 * 资产参考图（角色/场景/道具通用）：库里存 JSON 对象数组 `[{ path, uploaded_at }]`
 * （`uploaded_at` 为 unix 秒，存量数据缺文件时为 null）。
 * 参考图是「生成输入」，与成片图 image_url/local_path 互不影响。
 */
export interface ReferenceImage {
  path: string
  uploaded_at: number | null
}

export type ReferenceImagesResp = { reference_images: ReferenceImage[] }

/** 宽容读取资产行里的参考图列：对象数组 / JSON 字符串都接受，其它一律空数组 */
export function parseReferenceImages(raw: unknown): ReferenceImage[] {
  const list = Array.isArray(raw)
    ? raw
    : (() => {
      if (typeof raw !== 'string') return []
      const text = raw.trim()
      if (!text.startsWith('[')) return []
      try {
        const parsed: unknown = JSON.parse(text)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    })()
  return list
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const entry = item as Record<string, unknown>
      const path = String(entry.path ?? '').trim()
      if (!path) return null
      const uploadedAt = Number(entry.uploaded_at)
      return { path, uploaded_at: Number.isFinite(uploadedAt) && uploadedAt > 0 ? uploadedAt : null }
    })
    .filter((entry): entry is ReferenceImage => !!entry)
}

export const characterAPI = {
  create: (data: any) => api.post('/characters', data),
  update: (id: number, data: any) => api.put(`/characters/${id}`, data),
  del: (id: number) => api.del(`/characters/${id}`),
  generatePrompt: (id: number, episodeId: number, force = false, textModel?: string, textConfigId?: number) => api.post(`/characters/${id}/generate-prompt`, { episode_id: episodeId, force, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  // referenceImages 省略 → 服务端用该资产已保存的参考图；传 [] → 明确不用参考图
  generateImage: (id: number, episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number, referenceImages?: string[]) => api.post(`/characters/${id}/generate-image`, { episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined, reference_images: referenceImages }),
  batchImages: (ids: number[], episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number) => api.post('/characters/batch-generate-images', { character_ids: ids, episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  addReference: (id: number, file: File) => uploadReq<ReferenceImagesResp>(`/characters/${id}/reference-images`, file),
  delReference: (id: number, url: string) => api.del<ReferenceImagesResp>(`/characters/${id}/reference-images?url=${encodeURIComponent(url)}`),
}

export const sceneAPI = {
  create: (data: any) => api.post('/scenes', data),
  update: (id: number, data: any) => api.put(`/scenes/${id}`, data),
  del: (id: number) => api.del(`/scenes/${id}`),
  generatePrompt: (id: number, episodeId: number, force = false, textModel?: string, textConfigId?: number) => api.post(`/scenes/${id}/generate-prompt`, { episode_id: episodeId, force, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  generateImage: (id: number, episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number, referenceImages?: string[]) => api.post(`/scenes/${id}/generate-image`, { episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined, reference_images: referenceImages }),
  addReference: (id: number, file: File) => uploadReq<ReferenceImagesResp>(`/scenes/${id}/reference-images`, file),
  delReference: (id: number, url: string) => api.del<ReferenceImagesResp>(`/scenes/${id}/reference-images?url=${encodeURIComponent(url)}`),
}

export const propAPI = {
  create: (data: any) => api.post('/props', data),
  update: (id: number, data: any) => api.put(`/props/${id}`, data),
  del: (id: number) => api.del(`/props/${id}`),
  generatePrompt: (id: number, episodeId: number, force = false, textModel?: string, textConfigId?: number) => api.post(`/props/${id}/generate-prompt`, { episode_id: episodeId, force, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  generateImage: (id: number, episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number, referenceImages?: string[]) => api.post(`/props/${id}/generate-image`, { episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined, reference_images: referenceImages }),
  addReference: (id: number, file: File) => uploadReq<ReferenceImagesResp>(`/props/${id}/reference-images`, file),
  delReference: (id: number, url: string) => api.del<ReferenceImagesResp>(`/props/${id}/reference-images?url=${encodeURIComponent(url)}`),
}

// 生成任务列表/详情（图片生成走各资产 API，视频生成走 storyboardAPI.generateVideo 与集级批量）
export const taskAPI = {
  registerUpload: (assetType: 'character' | 'scene' | 'prop', assetId: number, localPath: string) =>
    api.post('/tasks/register-upload', { asset_type: assetType, asset_id: assetId, local_path: localPath }),
  get: (id: number) => api.get<TaskRow>(`/tasks/${id}`),
  del: (id: number) => api.del(`/tasks/${id}`),
  // 取消任务：qwen-jobs 调远端取消（排队中立即取消，运行中由服务端决定是否中断）
  cancel: (id: number) => api.post(`/tasks/${id}/cancel`),
  list: (params?: { type?: 'image' | 'video'; drama_id?: number; storyboard_id?: number; character_id?: number; scene_id?: number; prop_id?: number }) => {
    const query = new URLSearchParams()
    if (params?.type) query.set('type', params.type)
    if (params?.drama_id) query.set('drama_id', String(params.drama_id))
    if (params?.storyboard_id) query.set('storyboard_id', String(params.storyboard_id))
    if (params?.character_id) query.set('character_id', String(params.character_id))
    if (params?.scene_id) query.set('scene_id', String(params.scene_id))
    if (params?.prop_id) query.set('prop_id', String(params.prop_id))
    return api.get(`/tasks${query.size ? `?${query.toString()}` : ''}`)
  },
  // 任务中心列表（分页 + 筛选；批次作为可展开父行返回，子任务不在顶层重复）
  center: (params: { drama_id?: number; episode_id?: number; type?: string; status?: string; scope?: 'recent' | 'all'; page?: number; page_size?: number } = {}) => {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
    }
    return api.get<{ items: CenterRow[]; total: number; page: number; page_size: number }>(`/tasks/center${query.size ? `?${query.toString()}` : ''}`)
  },
  // 全部活跃任务（含批次子任务与文本任务）+ 顶层进行中数量，供全局 store 轮询
  active: () => api.get<{ items: TaskRow[]; active_count: number }>('/tasks/active'),
  // 换模型重试：始终新建任务，返回新任务行
  retry: (id: number, data: { config_id?: number; model?: string } = {}) =>
    api.post<TaskRow>(`/tasks/${id}/retry`, { config_id: data.config_id || undefined, model: data.model || undefined }),
}

// 图片任务队列（qwen-jobs）：提交前的耗时预估。非 qwen-jobs 供应商返回 { supported: false }
export const imageQueueAPI = {
  estimate: (params: { config_id?: number; size?: string; references?: number; count?: number } = {}) => {
    const query = new URLSearchParams()
    if (params.config_id) query.set('config_id', String(params.config_id))
    if (params.size) query.set('size', params.size)
    if (params.references !== undefined) query.set('references', String(params.references))
    if (params.count) query.set('count', String(params.count))
    return api.get(`/image-queue/estimate${query.size ? `?${query.toString()}` : ''}`)
  },
}

async function uploadReq<T = any>(path: string, file: File): Promise<T> {
  const fd = new FormData()
  fd.append('file', file)
  console.log(`%c[API] %cPOST %c${path} %c${file.name}`, 'color:#888', 'color:#4fc3f7;font-weight:bold', 'color:#ccc', 'color:#888')
  const resp = await fetch(`${BASE}${path}`, { method: 'POST', body: fd })
  const json = await resp.json()
  if (!resp.ok || (json.code && json.code >= 400)) {
    console.log(`%c[API] %cPOST ${path} %c${resp.status}`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold')
    throw new Error(json.message || `${resp.status}`)
  }
  return json.data ?? json
}

export const uploadAPI = {
  image: (f: File) => uploadReq<{ url: string; path: string }>('/upload/image', f),
  video: (f: File) => uploadReq<{ url: string; path: string }>('/upload/video', f),
  audio: (f: File) => uploadReq<{ url: string; path: string }>('/upload/audio', f),
}
export const mergeAPI = {
  merge: (epId: number, storyboardIds?: number[]) => api.post(`/merge/episodes/${epId}/merge`, storyboardIds?.length ? { storyboard_ids: storyboardIds } : {}),
  status: (epId: number) => api.get(`/merge/episodes/${epId}/merge`),
  list: (epId: number) => api.get<any[]>(`/merge/episodes/${epId}/merges`),
  // 删除成片：软删记录 + 删除磁盘文件；返回回退后的 episodes.video_url
  del: (epId: number, mergeId: number) =>
    api.del<{ id: number; deleted: boolean; episode_video_url: string | null }>(`/merge/episodes/${epId}/merges/${mergeId}`),
}
export const aiConfigAPI = {
  list: (t?: string) => api.get(`/ai-configs${t ? `?service_type=${t}` : ''}`),
  create: (d: any) => api.post('/ai-configs', d),
  update: (id: number, d: any) => api.put(`/ai-configs/${id}`, d),
  del: (id: number) => api.del(`/ai-configs/${id}`),
  test: (d: any) => api.post('/ai-configs/test', d),
}

// lang 缺省/为 zh 时读写基础版（不带 query，保持原请求形态）
const langQ = (lang?: string) => (lang && lang !== 'zh' ? `?lang=${lang}` : '')

export const promptAPI = {
  list: () => api.get('/prompts'),
  get: (type: string, lang?: string) => api.get(`/prompts/${type}${langQ(lang)}`),
  update: (type: string, d: any, lang?: string) => api.put(`/prompts/${type}${langQ(lang)}`, d),
  reset: (type: string, lang?: string) => api.post(`/prompts/${type}/reset${langQ(lang)}`),
}

export const skillsAPI = {
  list: (lang?: string) => api.get(`/skills${langQ(lang)}`),
  get: (id: string, lang?: string) => api.get(`/skills/${id}${langQ(lang)}`),
  create: (data: { id: string; name: string; description?: string }) => api.post('/skills', data),
  update: (id: string, content: string, lang?: string) => api.put(`/skills/${id}${langQ(lang)}`, { content }),
  del: (id: string) => api.del(`/skills/${id}`),
}

export const stylePresetAPI = {
  list: (all = false) => api.get(`/style-presets${all ? '?all=1' : ''}`),
  create: (d: any) => api.post('/style-presets', d),
  update: (id: number, d: any) => api.put(`/style-presets/${id}`, d),
  del: (id: number) => api.del(`/style-presets/${id}`),
}

export const storageAPI = {
  info: () => api.get('/storage'),
}

export const settingsAPI = {
  contentLanguage: () => api.get<{ language: string }>('/settings/content-language'),
  setContentLanguage: (language: string) => api.put('/settings/content-language', { language }),
}

// 服务器/Docker 部署的版本检查与更新（桌面版走 useDesktopBridge，不用此 API）
export const serverUpdateAPI = {
  state: () => api.get('/server-update/state'),
  check: () => api.post('/server-update/check'),
  apply: () => api.post('/server-update/apply'),
}
