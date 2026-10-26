import { fileURLToPath } from 'node:url'

// 开发期后端地址与前端端口可用环境变量覆盖（多工作树并行开发时避免端口/后端冲突）
const DEV_BACKEND = process.env.HUOBAO_DEV_BACKEND || 'http://localhost:5679'
const DEV_PORT = Number(process.env.HUOBAO_DEV_PORT || 3013)

export default defineNuxtConfig({
  srcDir: 'app/',
  ssr: false,
  // 固定端口 + 监听所有网卡，局域网 IP 可直接访问；strictPort 防止端口被占时静默换端口
  devServer: { host: '0.0.0.0', port: DEV_PORT },
  devtools: { enabled: false },
  experimental: {
    appManifest: false,
  },
  hooks: {
    // 动态路由页面统一放在 app/views/ 手动注册，避免文件路径中出现 [id] 方括号
    // （方括号路径在 git/shell 中需转义，且部分部署环境不兼容）。URL 保持不变。
    'pages:extend'(pages) {
      pages.push(
        {
          name: 'drama-detail',
          path: '/drama/:id',
          file: fileURLToPath(new URL('./app/views/drama/detail.vue', import.meta.url)),
        },
        {
          name: 'drama-episode',
          path: '/drama/:id/episode/:episodeNumber',
          file: fileURLToPath(new URL('./app/views/drama/episode.vue', import.meta.url)),
        },
      )
    },
  },
  app: {
    head: {
      title: '火宝短剧',
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
      link: [
        // v 参数用于 favicon 缓存穿透（浏览器对 favicon 缓存独立于 HTTP 缓存，换图必须 bump）
        { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon.png?v=20261002' },
        { rel: 'shortcut icon', type: 'image/png', href: '/favicon.png?v=20261002' },
      ],
    },
  },
  vite: {
    server: {
      proxy: {
        '/api': { target: DEV_BACKEND, changeOrigin: true },
        '/static': { target: DEV_BACKEND, changeOrigin: true },
      },
      strictPort: true,
    },
  },
  compatibilityDate: '2025-05-15',
})
