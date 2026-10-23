/**
 * pm2 开发进程（热加载）：pm2 start ecosystem.config.cjs
 *
 * 注意：pm2 daemon 与子进程会继承启动它的 shell 环境。务必用 scripts/pm2.sh 启动
 * （env -i 清空环境），否则 omp web 的 PORT/OMP_* 等变量会泄漏进服务。
 * 密钥不放这里：AI 配置在 SQLite，本机私有配置见 ~/.config/huobao-drama-local/。
 */
module.exports = {
  apps: [
    {
      name: 'huobao-backend',
      cwd: './backend',
      script: 'npm',
      args: 'run dev',
      env: { PORT: '5679' },
      autorestart: true,
    },
    {
      name: 'huobao-frontend',
      cwd: './frontend',
      script: 'npm',
      args: 'run dev',
      autorestart: true,
    },
  ],
}
