# Project Rules (aafm-dashboard)

This project is a technical assessment built from scratch. The user and Claude are both working on it. These rules apply to every session and override default behavior.

## Rule 1: Research-backed features
Back every feature I suggest with research from the internet. Cite the sources (links) for each suggestion. Industry practice, benchmarks, docs, or real products all count. No unsupported feature suggestions.

## Rule 2: No assumptions, ask first
- Don't make assumptions. If anything is unclear, ask the user or interview them about it before any work starts.
- The user shares the assessment problem first. Read it fully and work out what I can. Then interview only about the parts I still don't understand.

## Rule 3: Depth over breadth
- Build the core feature first and make it strong: better than existing solutions in the industry.
- Only after the core is solid, move on to the features and solutions that support it.

## Rule 4: Never skip or hide problems
- When something is wrong, make it clearly visible and report it.
- Fix it before moving on to other problems. Never skip it, suppress it, or work around it quietly.

## Rule 4a: Problems log
- Log every problem in `problems-log.md`: who raised it, who solved it (the user or Claude), how it was fixed, and how the fix was verified.

## Rule 5: Record every prompt
- Record every prompt the user gives in `prompt-book.md` at the project root.
- Append each prompt verbatim, numbered and with its date and time (IST), before acting on it.
- If a prompt answers questions I asked, record those questions first, then the user's prompt.

## Rule 6: No commits or pushes without permission
- Never run `git commit` or `git push` until the user explicitly approves.
- Flow: build, then the user tests and reviews, then the user decides whether to commit or push.

## Rule 6a: The user does all UI review (Prompt 17)
- Never use Claude in Chrome (or any browser automation) on this project.
- The user reviews every UI change themselves, and every change goes through them.
- I verify with typecheck, lint, build and API tests, then hand over for review.

## Rule 7: Code hygiene
- Keep the code clean across the whole project: consistent formatting (Prettier config in `backend/`), no dead code, no stray debug logs, and clear names.
- Backend controllers use the shared utils in `backend/src/utils/`: `ApiError`, `ApiResponse`, `asyncHandler`. Reuse them instead of writing new ones.

## Project decisions (from the interview, Prompt 3)
- **Deadline:** 48 hours from 2026-11-17 14:22 IST, so due 2026-11-19 14:22 IST.
- **Stack:** the backend is Node.js + Express, in JavaScript, with PostgreSQL through `pg` (raw SQL, no ORM). The frontend is Next.js + TypeScript + Tailwind CSS. PostgreSQL replaced MongoDB because the brief's Tier 1 asks for "RLS or equivalent".
- **Database hosting:** local Postgres while developing. In production, Postgres runs in Docker on EC2 (Neon or Supabase if that fits better).
- **Database rules:**
  - The app connects as the restricted role `aafm_app` (no superuser, no BYPASSRLS). Migrations and seed connect as the owner.
  - All tenant-scoped queries go through `withContext()` in `src/db/pool.js`, which runs `set_config(..., true)` (transaction-local) on the same pooled connection.
  - Never use session-level `SET` for tenant context.
  - Index every column used by RLS policies or for filtering.
  - Migrations are append-only once anything has been deployed. Before the first deploy, `001_tenancy.sql` may still be edited in place.
- **API conventions:** snake_case JSON in both requests and responses (matches the DB, so no mapping layer). SQL lives in the controllers, always inside `req.db()`, which is `withContext`. Every handler uses `asyncHandler`, `ApiResponse` and `ApiError`.
- **Frontend (Prompt 13):** `frontend/` uses Next.js 16.4 (App Router, `src/`), TypeScript, Tailwind v4, and the same Prettier config as the backend.
  - Next 16 differs from training data, so read `frontend/node_modules/next/dist/docs/` before using an API.
  - The browser talks only to the Next origin. In development, `/api/*` is rewritten to Express (`BACKEND_URL`). In production, Nginx routes `/api/*` straight to Express (problems-log #13).
  - Design follows the user's references in `frontend/assets/inspo/`.
- **Real-time (Prompts 32–33):** Socket.IO 4.8 plus `@socket.io/postgres-adapter`, which fans out across instances with Postgres NOTIFY. Scope is dashboard edits plus presence.
  - Events carry ids only; every browser re-reads under its own RLS.
  - The socket authenticates with the session cookie and passes an Origin check (`CORS_ORIGIN`). The session is re-checked on every join and every 60 s.
  - Writes send `X-Socket-Id` so the author's tab isn't echoed.
  - The path is `/socket.io` with no trailing slash (`addTrailingSlash: false` on both ends).
  - Dev: the frontend uses `NEXT_PUBLIC_SOCKET_URL=http://localhost:8000`. Prod: Nginx routes `/socket.io` to Express.
- **Tests:** `npm run migrate && npm run seed && npm test` runs a real-DB, real-HTTP suite (`test/`). It must stay green before review.
- **Order:** Tier 1 only, backend first, then frontend. Move to the next tier only after the current one is done.
- **Data:** metrics are simulated test data. Five base metrics: revenue, page views, clicks, errors and active users (`users`, added for ARPU, Prompt 38).
- **Tier 2 (Prompts 37–41):**
  - Live simulator: `app.simulate_tick`, every `SIMULATOR_INTERVAL_SECONDS`.
  - KPIs: ARPU, CTR and error rate, computed as ratios of sums. A widget's source is a metric *or* a KPI.
  - Anomaly alerts: a fixed rule, 2σ vs the trailing hour, closing at |z| < 1.5 (hysteresis). In-dashboard only.
  - Team and org socket channels carry `dashboards:changed`, `teams:changed`, `metrics:tick` and `alerts:changed`.
  - Details: `docs/tier-2-plan.md` § As built.
- **Tier 3 (Prompts 47–49):** plan and "As built" in `docs/tier-3-plan.md`; checklist in `docs/tier-3-test-checklist.md`.
  - Projects are reached through the team (Sentry model).
  - Audit log: named reads plus writes, auth events and denials; append-only and hash-chained.
  - Webhooks: alert, dashboard and member events per team, using Standard Webhooks signing and an SSRF guard.
  - Custom metrics: formulas per team over the base metrics.
  - Every write and named read calls `audit()` (`src/utils/audit.js`) inside its own transaction. Webhook events go out via `emitWebhook()`, in the same transaction.
  - Events (Prompt 51): the audit stays in-transaction (Option A in `docs/decision-event-streaming.md`). Its triggers decide when to add an outbox or a queue.
  - Prompt 54:
    - The database owner must bypass RLS; migrations and startup check this.
    - Rate limits are shared in Postgres.
    - Audit checkpoints are signed.
    - Optional separate worker (`npm run worker`, `RUN_WORKERS=false`).
  - Production hardening (Prompts 50–53): `docs/edge-case-audit.md`, with all 25 fixed.
    - Caps and time limits live in the DB (migration 011).
    - Rate limits and Idempotency-Key are middleware.
    - Older audit entries are archived into LZ4-compressed segments (every entry kept).
    - Webhook secrets are AES-256-GCM sealed (keyring file, `npm run keyring`).
  - Dev only: `WEBHOOK_ALLOW_PRIVATE=1` lets webhooks reach a local receiver (`backend/scripts/webhook-receiver.js`). Never set it in production.
- **Roles:** there's a Super Admin over the whole organization, then an Admin for each team (department), plus Editors and Viewers. The Super Admin creates the organization and has full edit and delete rights plus oversight of every team and member (Prompt 7).
- **Accounts (AWS IAM style, Prompt 7):** a Super Admin or Admin creates users and shares the credentials. The server generates a one-time password, shows it once, and forces a password change at first sign-in. There's no self-sign-up for members. An email that already has an account just gets the new membership (Prompt 8).
- **Org bootstrap (Prompt 8):** public sign-up creates the organization and its Super Admin in one step, like AWS root sign-up.
- **Membership:** one user can belong to several teams, with a different role in each.
- **Accounts are org-scoped (Prompt 10, the AWS IAM model):** a user belongs to one org. Emails are unique within an org, not globally.
- **Login:** identifier first: org, then email, then password, then a picker of the user's teams and roles in that org. The picker appears only after the password is verified (prevents account enumeration; Prompt 4). Unknown emails behave the same as known ones.
- **Isolation:** PostgreSQL row-level security, so the database itself enforces team and role scoping. App-level checks are a second layer on top.
- **Submission:** public GitHub repo, the prompt history (`prompt-book.md`), and a live URL.

> Note: the original prompt numbered two rules as "rule 3". They are numbered 1 to 6 here in the order given.
