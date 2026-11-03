/**
 * 叠加图层渲染接口（Issue #48），挂载在 /api/v1/layer-docs。
 * 预览 PNG、渲染落盘、字体自检状态，以及给编辑器 @font-face 用的打包字体。
 */
import fs from 'fs'
import path from 'path'
import { Hono } from 'hono'
import { success, badRequest, notFound } from '../utils/response.js'
import { normalizeLayerDoc } from '../services/layer-doc.js'
import { renderLayerDoc, renderLayerDocToFile } from '../services/layer-render.js'
import { LAYER_FONT_FILES, ensureLayerFonts } from '../services/layer-fonts.js'
import { logTaskError } from '../utils/task-logger.js'

const app = new Hono()

async function readRenderRequest(c: Parameters<typeof badRequest>[0]) {
  let body: Record<string, unknown> = {}
  try {
    const parsed = await c.req.json()
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>
  } catch {
    body = {}
  }
  const doc = normalizeLayerDoc(body.doc ?? body)
  const width = Number(body.width) > 0 ? Number(body.width) : undefined
  const height = Number(body.height) > 0 ? Number(body.height) : undefined
  const ids = body.visible_ids
  const visibleIds = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : undefined
  return { doc, options: { width, height, visibleIds } }
}

// POST /layer-docs/render — 预览渲染，直接返回 PNG 字节
app.post('/render', async (c) => {
  try {
    const { doc, options } = await readRenderRequest(c)
    const result = await renderLayerDoc(doc, options)
    c.header('Content-Type', 'image/png')
    c.header('Cache-Control', 'no-store')
    c.header('X-Render-Ms', String(result.ms))
    return c.body(new Uint8Array(result.buffer))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logTaskError('LayerDocAPI', 'render', { error: message })
    return badRequest(c, message)
  }
})

// POST /layer-docs/render-to-file — 渲染并落盘 static/overlays/<uuid>.png
app.post('/render-to-file', async (c) => {
  try {
    const { doc, options } = await readRenderRequest(c)
    return success(c, await renderLayerDocToFile(doc, options))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logTaskError('LayerDocAPI', 'render-to-file', { error: message })
    return badRequest(c, message)
  }
})

// GET /layer-docs/fonts — 字体自检状态（失败时 400 + 中文原因）
app.get('/fonts', async (c) => {
  try {
    const status = await ensureLayerFonts()
    return success(c, { ...status, families: ['Noto Sans SC', 'Noto Serif SC'] })
  } catch (err) {
    return badRequest(c, err instanceof Error ? err.message : String(err))
  }
})

// GET /layer-docs/fonts/:file — 打包字体，供编辑器 @font-face 做到真正的所见即所得
app.get('/fonts/:file', async (c) => {
  const file = c.req.param('file')
  if (!(LAYER_FONT_FILES as readonly string[]).includes(file)) return notFound(c, '字体不存在')
  const status = await ensureLayerFonts()
  const bytes = fs.readFileSync(path.join(status.font_dir, file))
  c.header('Content-Type', 'font/otf')
  c.header('Cache-Control', 'public, max-age=31536000, immutable')
  return c.body(new Uint8Array(bytes))
})

export default app
