/**
 * 叠加图层的打包字体与 fontconfig 自检（Issue #48）。
 *
 * 服务端渲染必须**确定性**：只用仓库内 `backend/assets/fonts/` 的打包字体
 * （Noto Sans/Serif SC + LXGW WenKai + Ma Shan Zheng，四族字体，Issue #72），
 * 不读系统字体（不同机器的回退字体会让同一份文档渲染出不同画面）。
 * 因此启动时写一份只含本目录的 fontconfig 配置并指向它，再做一次探针渲染；
 * 自检失败时 `renderLayerDoc` 直接抛错，**绝不输出豆腐块**。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'
import { DATA_ROOT } from '../utils/paths.js'
import { FONT_FAMILIES, unsupportedChars } from './layer-svg.js'

export class LayerFontError extends Error {}

/** 打包字体文件（family 名由字体内部 name 表决定，见 README）。 */
export const LAYER_FONT_FILES = [
  'NotoSansSC-Regular.otf',
  'NotoSansSC-Bold.otf',
  // Issue #96：模板文本框的 500（说明/列表正文）与 900（标题/数据大字）字重
  'NotoSansSC-Medium.otf',
  'NotoSerifSC-Regular.otf',
  'NotoSerifSC-Bold.otf',
  'NotoSerifSC-Black.otf',
  'LXGWWenKai-Regular.ttf',
  'LXGWWenKai-Medium.ttf',
  'MaShanZheng-Regular.ttf',
] as const

export interface LayerFontStatus {
  font_dir: string
  config_path: string
  files: string[]
  probe_ms: number
}

const PROBE_TEXT = '纪录片Ab1'
/** PUA 码位：任何正常字体都没有这些字形，渲染必然是豆腐块，用来识别回退失败。 */
const PROBE_TOFU = '\uE000\uE001\uE002\uE003\uE004'

let cached: LayerFontStatus | null = null
let cachedError: LayerFontError | null = null

function resolveFontDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.env.HUOBAO_FONT_DIR,
    // dev / tsx：src/services → backend/assets/fonts
    path.resolve(here, '../../assets/fonts'),
    // 桌面版 esbuild bundle：build/backend.mjs 旁边的 assets/fonts
    path.resolve(here, 'assets/fonts'),
    path.resolve(process.cwd(), 'assets/fonts'),
  ].filter((item): item is string => Boolean(item))
  for (const dir of candidates) {
    if (LAYER_FONT_FILES.every(file => fs.existsSync(path.join(dir, file)))) return dir
  }
  throw new LayerFontError(
    `叠加图层渲染字体缺失：在 ${candidates.join(' / ')} 都没找到 ${LAYER_FONT_FILES.join('、')}；`
    + '请确认 backend/assets/fonts 已随代码发布，或用 HUOBAO_FONT_DIR 指向字体目录。',
  )
}

function writeFontConfig(fontDir: string): string {
  const configDir = path.join(DATA_ROOT, 'fontconfig')
  const cacheDir = path.join(configDir, 'cache')
  fs.mkdirSync(cacheDir, { recursive: true })
  const configPath = path.join(configDir, 'layer-fonts.conf')
  const xml = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<!-- 由 backend/src/services/layer-fonts.ts 生成；只含打包字体，保证渲染确定性 -->
<fontconfig>
  <dir>${fontDir}</dir>
  <cachedir>${cacheDir}</cachedir>
  <match target="pattern"><test name="family"><string>sans-serif</string></test>
    <edit name="family" mode="prepend" binding="strong"><string>Noto Sans SC</string></edit></match>
  <match target="pattern"><test name="family"><string>serif</string></test>
    <edit name="family" mode="prepend" binding="strong"><string>Noto Serif SC</string></edit></match>
</fontconfig>
`
  if (!fs.existsSync(configPath) || fs.readFileSync(configPath, 'utf8') !== xml) {
    fs.writeFileSync(configPath, xml)
  }
  return configPath
}

async function inkMask(text: string, family: string): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="96">`
    + `<rect width="420" height="96" fill="#ffffff"/>`
    + `<text x="8" y="70" font-family="${family}" font-size="64" fill="#000000">${text}</text></svg>`
  return sharp(Buffer.from(svg)).greyscale().raw().toBuffer()
}

function differentPixels(a: Buffer, b: Buffer): number {
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > 32) diff++
  }
  return diff
}

/**
 * 一次性自检：写 fontconfig、指向打包字体、探针渲染。
 * 任一家族渲染不出中文（或回退成豆腐块、两种字族不可区分）即抛 LayerFontError。
 */
export async function ensureLayerFonts(): Promise<LayerFontStatus> {
  if (cachedError) throw cachedError
  if (cached) return cached
  const started = Date.now()
  try {
    const fontDir = resolveFontDir()
    const configPath = writeFontConfig(fontDir)
    process.env.FONTCONFIG_FILE = configPath
    process.env.FONTCONFIG_PATH = path.dirname(configPath)

    const masks: Record<string, Buffer> = {}
    for (const [key, family] of Object.entries(FONT_FAMILIES)) {
      const text = await inkMask(PROBE_TEXT, family)
      const tofu = await inkMask(PROBE_TOFU, family)
      let ink = 0
      for (let i = 0; i < text.length; i++) {
        if (text[i] < 128) ink++
      }
      if (ink < 200) {
        throw new LayerFontError(`字体自检失败：${family} 渲染「${PROBE_TEXT}」几乎没有墨迹（ink=${ink}），字体目录 ${fontDir}`)
      }
      if (differentPixels(text, tofu) < text.length * 0.005) {
        throw new LayerFontError(`字体自检失败：${family} 把中文渲染成了豆腐块（与缺字占位图无差别），字体目录 ${fontDir}`)
      }
      masks[key] = text
    }
    const pairs: [string, string, string][] = [
      ['sans', 'serif', 'sans 与 serif'],
      ['serif', 'kai', 'serif 与 kai'],
      ['sans', 'hand', 'sans 与 hand'],
    ]
    for (const [a, b, label] of pairs) {
      if (differentPixels(masks[a], masks[b]) < masks[a].length * 0.002) {
        throw new LayerFontError(`字体自检失败：${label} 渲染结果相同，fontconfig 没有选中打包字体（${fontDir}）`)
      }
    }

    cached = {
      font_dir: fontDir,
      config_path: configPath,
      files: LAYER_FONT_FILES.slice(),
      probe_ms: Date.now() - started,
    }
    return cached
  } catch (err) {
    cachedError = err instanceof LayerFontError ? err : new LayerFontError(`字体自检失败：${(err as Error).message}`)
    throw cachedError
  }
}

/** 启动自检：成功记一行日志，失败只告警（渲染时才阻断，后端不因此起不来）。 */
export async function logLayerFontStatus(): Promise<void> {
  try {
    const status = await ensureLayerFonts()
    console.log(`[LayerFonts] 打包字体就绪 ${status.font_dir}（${status.files.length} 个文件，探针 ${status.probe_ms}ms）`)
  } catch (err) {
    console.warn(`[LayerFonts] ${(err as Error).message}`)
  }
}

/** 文档文字必须全部落在打包字体的码位范围内，否则渲染会出豆腐块 → 直接报错。 */
export function assertRenderableText(texts: string[]): void {
  const missing: string[] = []
  for (const text of texts) {
    for (const ch of unsupportedChars(text)) {
      if (missing.indexOf(ch) === -1) missing.push(ch)
    }
  }
  if (missing.length) {
    throw new LayerFontError(
      `图层文字含打包字体未覆盖的字符：${missing.join(' ')}（打包字体为 Noto Sans/Serif SC 子集，`
      + '覆盖常用汉字、假名、拉丁与标点；请改写文字或扩充 backend/assets/fonts 的子集范围）',
    )
  }
}
