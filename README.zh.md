# projectOS

*[English version / 英文版本](README.md)*

**Autonomous Project OS (APOS)** — 面向 Human–Agent 混合团队的自主项目操作系统。

> 让项目能够自主向前流动，同时确保人类始终掌握目标、风险与最终决策权。

## 语言

仓库是中英双语的。**界面默认英文**，顶栏那个「中文」按钮切换。代码注释中英并行，
文档以中文为主、英文对照逐篇补齐 —— 有英文版的文档会在第一行链过去。

写代码时的约定见 [CLAUDE.md](CLAUDE.zh.md#语言约定双语)。

## 快速开始

```bash
pnpm install
bash scripts/dev-up.sh
```

跑完会打印一条可以直接打开的看板链接。完整步骤、环境变量与排错见
**[运行指南](docs/RUNNING.zh.md)**。

部署到一台机器上（一条命令、一个对外端口）：

```bash
docker compose up -d --build   # 然后打开 http://localhost:8080
```

见 **[单机部署](docs/DEPLOYMENT.zh.md)**。

## 文档

| 文档 | 说明 |
| --- | --- |
| [运行指南](docs/RUNNING.zh.md) | 本机怎么跑起来：环境、端口、种子数据、验证与排错 |
| [单机部署](docs/DEPLOYMENT.zh.md) | 部署到一台机器：容器编排、配置、升级备份与安全边界 |
| [接 Supabase](docs/SUPABASE.zh.md) | 把数据库换成托管 Postgres：连接串怎么选、必须关掉的匿名 REST 通道 |
| [产品功能文档](docs/product/autonomous-project-os.zh.md) | 产品定位、领域模型、信息架构、核心功能设计与 MVP 范围（V0.2） |
| [页面文档](docs/product/pages/README.zh.md) | 14 个 MVP 页面的详细设计：结构、交互、状态、权限、数据依赖 |
| [技术实现文档](docs/tech/README.zh.md) | 技术选型、系统架构、领域模型、引擎设计、协议与实施计划 |

### 页面文档

全局约定（导航、角色、通用组件、状态机）见[页面文档总览](docs/product/pages/README.zh.md)。

| # | 页面 | # | 页面 |
| --- | --- | --- | --- |
| 1 | [项目列表](docs/product/pages/01-project-list.zh.md) | 8 | [Agent Workspace](docs/product/pages/08-agent-workspace.zh.md) |
| 2 | [项目总览](docs/product/pages/02-project-overview.zh.md) | 9 | [Agent Run 详情](docs/product/pages/09-agent-run-detail.zh.md) |
| 3 | [需求录入与 AI 澄清](docs/product/pages/03-requirement-intake.zh.md) | 10 | [Decision Center](docs/product/pages/10-decision-center.zh.md) |
| 4 | [项目计划确认](docs/product/pages/04-plan-approval.zh.md) | 11 | [决策详情](docs/product/pages/11-decision-detail.zh.md) |
| 5 | [Autonomous Board](docs/product/pages/05-autonomous-board.zh.md) | 12 | [项目 Analytics](docs/product/pages/12-project-analytics.zh.md) |
| 6 | [Work Item 详情](docs/product/pages/06-work-item-detail.zh.md) | 13 | [Policy 配置](docs/product/pages/13-policy-config.zh.md) |
| 7 | [Execution Graph](docs/product/pages/07-execution-graph.zh.md) | 14 | [项目集成设置](docs/product/pages/14-integration-settings.zh.md) |

### 技术文档

| # | 文档 | # | 文档 |
| --- | --- | --- | --- |
| — | [技术选型与总览](docs/tech/README.zh.md) | 06 | [Agent Protocol](docs/tech/06-agent-protocol.zh.md) |
| 01 | [系统架构](docs/tech/01-architecture.zh.md) | 07 | [API 设计](docs/tech/07-api-design.zh.md) |
| 02 | [领域模型与数据库](docs/tech/02-domain-model.zh.md) | 08 | [前端架构](docs/tech/08-frontend-architecture.zh.md) |
| 03 | [事件模型](docs/tech/03-event-model.zh.md) | 09 | [身份、权限与安全](docs/tech/09-security.zh.md) |
| 04 | [Flow Engine](docs/tech/04-flow-engine.zh.md) | 10 | [MVP 实施计划](docs/tech/10-mvp-plan.zh.md) |
| 05 | [Policy Engine](docs/tech/05-policy-engine.zh.md) | | |

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | React 18 + TypeScript + Vite |
| 后端 | Node.js 22 + TypeScript（Fastify） |
| 数据库 | PostgreSQL 16（可换成 Supabase 等托管 Postgres，见[接 Supabase](docs/SUPABASE.zh.md)） |
| 缓存 / 队列 | Redis 7 + BullMQ |
| 部署 | 模块化单体，容器化 |

选型论证与 Python 方案的对比见[技术选型](docs/tech/README.zh.md#二技术选型)。
