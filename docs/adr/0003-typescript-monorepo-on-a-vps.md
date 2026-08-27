# 单一 TypeScript 单仓库部署到 VPS

网站升级继续使用 TypeScript，并在同一仓库中拆分网站、API、后台工作进程与共享包，通过 Docker Compose 部署到一台 VPS。相比重写为 FastAPI 或拆到无服务器平台，这个选择优先复用现有事件处理与测试，并保证 Hook、SSE 和后台任务的运行语义一致；耗时 AI 工作必须由独立后台工作进程承担，不能在 API 请求进程中执行。
