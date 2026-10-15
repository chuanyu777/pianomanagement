# apps/web

琴行管理系统前端，使用 React、Refine、Ant Design、React Router 和 Vite。

当前已实现登录、首次建号、初始化、经营总览、课程、老师、学生、报名、排课、台账、
收支、工资、项目、分析、风险和账号页面。交费、赠送、退费、关账及独立机构设置页面仍待补齐。

开工时注意和后端对齐这三件事（现在都已经配好了）：

- 后端接口统一前缀 `/api`
- 后端 dev server 在 `http://localhost:3000`
- 前端 dev server 端口要出现在 `apps/api/.env` 的 `CORS_ORIGINS` 里
  （默认已经放了 `http://localhost:5173`；换端口就要同步改，否则浏览器直接拦请求）
