/**
 * pm2 生产进程：前端走 release 产物（scripts/release.sh 生成到 ~/huobao-releases/current），
 * 由后端同源托管 UI + API，只有一个应用、一个端口（5679）。
 *
 * 启动/重启/查状态一律走 scripts/pm2.sh（env -i 清环境），否则 omp web 的 PORT/OMP_* 会泄漏进来。
 * 前端热加载开发（nuxt dev，:3013）不再是常驻服务：需要时在 frontend 里手工 `npm run dev`。
 * 密钥不放这里：AI 配置在 SQLite，本机私有配置见 ~/.config/huobao-drama-local/。
 */
module.exports = {
  apps: [
    {
      name: 'huobao-backend',
      cwd: './backend',
      script: 'npm',
      args: 'start',
      autorestart: true,
      env: {
        NODE_ENV: 'production',
        PORT: '5679',
        FRONTEND_DIST: `${process.env.HOME}/huobao-releases/current`,
      },
    },
  ],
}
