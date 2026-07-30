# 项目结构与维护边界

本项目是一个以 Rust API 为生产入口、Python 负责采集、TypeScript 负责看板界面的多语言应用。目录按“可维护的生产路径”和“历史/运行数据”划分；修改前优先确认文件属于哪一类。

## 生产路径

| 目录 | 职责 | 修改原则 |
| --- | --- | --- |
| `apps/api-rs/` | Rust HTTP API、登录、文件服务与业务接口 | 生产看板服务入口。 |
| `apps/worker-rs/` | Rust 任务编排与数据同步 | 负责采集任务、SQLite 同步与聚合。 |
| `crates/` | 订单、库存、结算、渠道等领域库 | 新业务逻辑优先进入对应 crate。 |
| `apps/collector_py/`、`apps/scraper_py/` | Python Playwright 采集器 | 仅负责浏览器采集及采集服务。 |
| `apps/web/` | 前端唯一源码 | HTML、TypeScript 和 CSS 都在此维护。 |
| `web/static/` | 生产静态构建结果 | 由 `pnpm -C apps/web build` 生成，不直接编辑。 |
| `docker/`、`ops/` | 容器配置与生产部署 | 容器生命周期、部署和运维配置。 |
| `scripts/` | 本地开发与日常操作入口 | 通过根目录 `Makefile` 统一暴露常用命令。 |

## 历史与运行数据

| 目录 | 状态 | 处理方式 |
| --- | --- | --- |
| `legacy/` | 已归档的 HTML / Streamlit 入口 | 不作为生产路径；仅在回溯旧实现时查看。 |
| `apps/legacy_metrics_py/` | 历史 Python 看板实现 | 不新增功能；迁移或回溯时使用。 |
| `output/`、`session/`、`state/`、`logs/` | 采集结果、登录态、运行状态与日志 | 运行时数据，不提交 Git。 |
| `target/`、`.venv/`、`.uv-cache/`、`.pnpm-store/`、`.playwright-*` | 本地构建与依赖缓存 | 可再生内容，不提交 Git。 |

## 常用工作流

```bash
make check       # Rust、前端、Python 的完整检查
make build       # 从 apps/web 构建 web/static
make dashboard   # 启动 Rust 看板 API
make web         # 启动 Vite 前端开发服务器
make daily       # 执行日常采集
```

本地调试看板时，在两个终端分别运行 `make dashboard` 与 `make web`；Vite 会将 `/api` 请求代理到本地 Rust API。生产部署使用 `make deploy`，仅应在生产环境执行。
