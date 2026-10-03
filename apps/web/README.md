# apps/web（待建）

前端用 Refine，**尚未开始** —— 见根目录 `AGENTS.md` §8 已知未做。

开工时注意和后端对齐这三件事（现在都已经配好了）：

- 后端接口统一前缀 `/api`
- 后端 dev server 在 `http://localhost:3000`
- 前端 dev server 端口要出现在 `apps/api/.env` 的 `CORS_ORIGINS` 里
  （默认已经放了 `http://localhost:5173`；换端口就要同步改，否则浏览器直接拦请求）
