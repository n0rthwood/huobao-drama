# codex-image

本机 codex（已登录 ChatGPT 账号）的 OpenAI 兼容生图包装服务，监听 `127.0.0.1`。

- 配置（端口/token）只读自仓库外 `~/.config/huobao-drama-local/codex-image.json`，格式见 `server.mjs` 文件头。
- 启动：`node tools/codex-image/server.mjs`；常驻用 `systemd --user`。
- 接口：`GET /health`；`POST /v1/images/generations`（JSON）、`POST /v1/images/edits`（multipart，`image`/`image[]` 参考图）；`Authorization: Bearer <token>`。
- 主项目里配成 `image / openai` 服务，base URL 填 `http://127.0.0.1:<port>`。
