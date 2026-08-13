# projectOS

*[中文版本 / Chinese version](README.md)*

**Autonomous Project OS (APOS)** — an autonomous project operating system for
mixed Human–Agent teams.

> Let a project move forward on its own, while people keep hold of the goal,
> the risk, and the final call.

## Quick start

```bash
pnpm install
bash scripts/dev-up.sh
```

It prints a board link you can open directly. For the full walkthrough,
environment variables and troubleshooting see **[Running guide](docs/RUNNING.en.md)**.

Deploy onto a single machine (one command, one exposed port):

```bash
docker compose up -d --build   # then open http://localhost:8080
```

See **[Single-machine deployment](docs/DEPLOYMENT.en.md)**.

## Language

The repository is bilingual. The UI defaults to **English**; use the `中文`
button in the top bar to switch. Code comments carry both languages, and the
documents listed below are written in Chinese with English counterparts being
added file by file — a document with an English version links to it from its
first line.

Conventions for contributors are in [CLAUDE.md](CLAUDE.md#语言约定双语) and [CONTRIBUTING.en.md](CONTRIBUTING.en.md).

## Documentation

| Document | What it covers |
| --- | --- |
| [Running guide](docs/RUNNING.en.md) | Getting it up locally: environment, ports, seed data, verification, troubleshooting |
| [Single-machine deployment](docs/DEPLOYMENT.en.md) | Deploying to one host: container orchestration, configuration, upgrades, backups, security boundaries |
| [Using Supabase](docs/SUPABASE.en.md) | Swapping in managed Postgres: which connection string to pick, and the anonymous REST channel you must close |
| [Product documentation](docs/product/autonomous-project-os.md) | Positioning, domain model, information architecture, core feature design, MVP scope (V0.2) |
| [Page documentation](docs/product/pages/README.md) | The 14 MVP screens in detail: structure, interaction, state, permissions, data dependencies |
| [Technical documentation](docs/tech/README.md) | Technology choices, system architecture, domain model, engine design, protocols, delivery plan |

### Page documentation

Global conventions (navigation, roles, shared components, state machine) live in
the [page documentation overview](docs/product/pages/README.md).

| # | Page | # | Page |
| --- | --- | --- | --- |
| 1 | [Project list](docs/product/pages/01-project-list.md) | 8 | [Agent Workspace](docs/product/pages/08-agent-workspace.md) |
| 2 | [Project overview](docs/product/pages/02-project-overview.md) | 9 | [Agent Run detail](docs/product/pages/09-agent-run-detail.md) |
| 3 | [Requirement intake & AI clarification](docs/product/pages/03-requirement-intake.md) | 10 | [Decision Center](docs/product/pages/10-decision-center.md) |
| 4 | [Plan approval](docs/product/pages/04-plan-approval.md) | 11 | [Decision detail](docs/product/pages/11-decision-detail.md) |
| 5 | [Autonomous Board](docs/product/pages/05-autonomous-board.md) | 12 | [Project analytics](docs/product/pages/12-project-analytics.md) |
| 6 | [Work item detail](docs/product/pages/06-work-item-detail.md) | 13 | [Policy configuration](docs/product/pages/13-policy-config.md) |
| 7 | [Execution graph](docs/product/pages/07-execution-graph.md) | 14 | [Integration settings](docs/product/pages/14-integration-settings.md) |

### Technical documentation

| # | Document | # | Document |
| --- | --- | --- | --- |
| — | [Technology choices & overview](docs/tech/README.md) | 06 | [Agent Protocol](docs/tech/06-agent-protocol.md) |
| 01 | [System architecture](docs/tech/01-architecture.md) | 07 | [API design](docs/tech/07-api-design.md) |
| 02 | [Domain model & database](docs/tech/02-domain-model.md) | 08 | [Frontend architecture](docs/tech/08-frontend-architecture.md) |
| 03 | [Event model](docs/tech/03-event-model.md) | 09 | [Identity, permissions & security](docs/tech/09-security.md) |
| 04 | [Flow Engine](docs/tech/04-flow-engine.md) | 10 | [MVP delivery plan](docs/tech/10-mvp-plan.md) |
| 05 | [Policy Engine](docs/tech/05-policy-engine.md) | | |

## Stack

| Layer | Choice |
| --- | --- |
| Frontend | React 18 + TypeScript + Vite |
| Backend | Node.js 22 + TypeScript (Fastify) |
| Database | PostgreSQL 16 (swappable for managed Postgres such as Supabase — see [Using Supabase](docs/SUPABASE.en.md)) |
| Cache / queue | Redis 7 + BullMQ |
| Deployment | Modular monolith, containerised |

The reasoning behind these choices, including the comparison against a Python
stack, is in [technology choices](docs/tech/README.md#二技术选型).

## Three constraints that must not be broken

These are the load-bearing rules of the codebase. [CONTRIBUTING.en.md](CONTRIBUTING.en.md)
explains each in full.

1. **A status change must produce an event.** No code path may `UPDATE
   work_items SET status = ...` directly; everything goes through `transition()`
   in `apps/api/src/modules/flow/transition.ts`, which writes the status and the
   event in one transaction. That event stream is the entire source of truth for
   audit, policy simulation and analytics.
2. **An Agent is an identity of its own.** Any field naming an operator is
   `(actorType, actorId)`, never `userId`. Agents carry their own credentials and
   their own permission set, and never reuse a human token.
3. **Policy evaluation must carry a context snapshot.** The `contextSnapshot` on
   a `policy.evaluated` event cannot be reconstructed after the fact. When you
   add a policy fact, extend `buildPolicyContext()` in `modules/flow/context.ts`
   in the same change.
