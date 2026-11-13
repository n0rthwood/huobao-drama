/**
 * MiniMax-H3 视频分辨率：项目档位（480p/720p/1080p）+ 画幅 → 32 倍数、总像素 ≤1344×768 的宽高。
 * ComfyUI 直连与 h3-jobs 队列共用，两条链路提交同一尺寸。
 */
const MAX_PIXELS = 1344 * 768

/** 项目侧档位 → 横屏边长；竖屏互换宽高 */
const LANDSCAPE_SIZES: Record<string, Record<string, [number, number]>> = {
  '16:9': { '480p': [832, 480], '720p': [960, 544], '1080p': [1344, 768] },
  '4:3': { '480p': [640, 480], '720p': [896, 672], '1080p': [1152, 864] },
  '1:1': { '480p': [512, 512], '720p': [768, 768], '1080p': [992, 992] },
}

export function pickResolution(resolution: string | null | undefined, aspectRatio: string | null | undefined): [number, number] {
  const tier = (resolution || '').toLowerCase()
  const tierKey = tier === '480p' || tier === '1080p' ? tier : '720p'
  const ratio = (aspectRatio || '').trim()
  const portrait = ratio === '9:16' || ratio === '3:4'
  const landscapeKey = portrait ? (ratio === '9:16' ? '16:9' : '4:3') : ratio
  const [w, h] = (LANDSCAPE_SIZES[landscapeKey] ?? LANDSCAPE_SIZES['16:9'])[tierKey]
  const size: [number, number] = portrait ? [h, w] : [w, h]
  if (size[0] % 32 || size[1] % 32 || size[0] * size[1] > MAX_PIXELS) {
    throw new Error(`分辨率不合法: ${size[0]}x${size[1]}（需为 32 的倍数且不超过 1344×768 像素总量）`)
  }
  return size
}
