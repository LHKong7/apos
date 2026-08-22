# Repository Guidelines

## Project Structure & Module Organization

This pnpm monorepo separates apps from shared packages. `apps/api` contains the Fastify API and workers; `apps/web` contains the React/Vite UI and `public` assets. Under `packages/`, `contracts` owns shared Zod schemas, `domain` contains IO-free logic, `db` owns Drizzle schemas and migrations, and the remaining packages implement runtimes, integrations, and workspace providers. Tests are colocated as `*.test.ts` or `*.test.tsx`; references live in `docs/`.

## Build, Test, and Development Commands

- `pnpm install`: install all workspace dependencies (Node 22+, pnpm 10+).
- `bash scripts/dev-up.sh`: start dependencies, migrate, seed, and launch API plus Vite.
- `pnpm build`: build every workspace package and app.
- `pnpm typecheck`: run strict TypeScript checks across the monorepo.
- `pnpm lint`: run bug-focused ESLint rules; it does not enforce formatting.
- `pnpm test` / `pnpm test:watch`: run Vitest once or in watch mode.
- `pnpm db:generate` and `pnpm db:migrate`: generate and apply Drizzle migrations.

## Coding Style & Naming Conventions

Use TypeScript with two-space indentation, single quotes, and semicolons. Keep strict typing; avoid `any` unless an ESLint suppression explains why. Prefix intentionally unused values with `_`. Use `camelCase` for API fields, `snake_case` for database names, and `PascalCase` for React components. Event names follow `{subject}.{past-tense verb}`, for example `work_item.status_changed`. UI text must use `apps/web/src/lib/i18n`; English is primary, with paired `X.md` and `X.zh.md` documentation where applicable.

## Testing Guidelines

Vitest runs backend tests in Node and web component tests in jsdom. Add tests beside the changed module and cover success and failure paths. Integration tests require PostgreSQL and run serially because they truncate tables; keep `TEST_DATABASE_URL` pointed at `apos_test`, never the development database. Changes to transitions, guards, policies, or recovery logic must satisfy the focused requirements in `CONTRIBUTING.md`.

## Commit & Pull Request Guidelines

Follow the existing Conventional Commit style: `feat(scope): Add policy controls.` Use one concise, imperative English sentence with an optional scope (`fix(web)`, `docs(policy)`). PRs should explain intent and risk, link relevant issues, list verification commands, call out migrations or configuration changes, and include screenshots for visible UI changes.

## Architecture & Security Constraints

Never update work-item status outside `transition()`. Treat agents as independent actors with their own credentials, never human proxies. Every policy evaluation event must persist its `contextSnapshot`; update `buildPolicyContext()` whenever adding a policy fact. Do not commit `.env`, credentials, or generated workspace contents.
