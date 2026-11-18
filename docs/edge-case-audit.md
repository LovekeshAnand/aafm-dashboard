# Edge-case audit (production readiness)

Prompt 51 (2026-11-18, after 15:20 IST): "audit first, then fix". Every finding below was checked in the code (file references) or against the cited documentation. Already fixed in Prompt 50: problems-log #41–43.

## Status (Prompt 53)

**All 25 fixed**: E1–E18 and E20–E25 as proposed below, and E19 as the compressed archive (user decision, Prompts 52–53). Each fix has a test in `backend/test/hardening.test.js` (17 tests, in a throwaway org) or the suites named here. Problems-log #44–#47.

| # | Fixed in | Test |
|---|---|---|
| E1 | `middlewares/limits.middleware.js` (600/min per session, 120/min writes; env `API_RATE_LIMIT`, `API_WRITE_RATE_LIMIT`) | hardening: 429 + Retry-After; another session unaffected; writes budget |
| E2–E4 | migration 011 `app.enforce_cap()` triggers (25 projects/team, 50 teams/org, 10 webhooks/team, 50 custom metrics/team), SQLSTATE `LIM01` → 409 | hardening: each cap refuses with "Limit reached: …" |
| E5 | `error.middleware.js`: one `access.denied` per user + path + status per minute, with a repeat count | hardening: 5 refusals → 1 entry |
| E6 | dashboards home fetches `limit=100`, scoped to the project on the server, with a "showing 100" note | frontend build |
| E7 | `db/pool.js` `pool.on("error")` | hardening |
| E8 | `connectionTimeoutMillis` 5 s → 503 + Retry-After | hardening: pool exhausted → 503 fast, then recovers |
| E9 | migration 011: `statement_timeout 10s`, `lock_timeout 5s`, `idle_in_transaction_session_timeout 30s` on the app role; 57014/55P03/40P01/40001 → 503 | hardening: settings checked |
| E10 | `frontend/src/lib/api.ts`: 15 s timeout, clear messages | typecheck/lint/build |
| E11 | `index.js`: `requestTimeout` 30 s, `headersTimeout` 15 s | code review |
| E12 | `team.controller.js`: `closeSockets` on member removal and team deletion | hardening: socket closed < 2 s |
| E13 | `api.ts` raises a session-expired event; `session.tsx` returns to sign-in and back | typecheck/lint/build |
| E14, E17, E20 keys | `app.housekeeping()` (migration 011) every 5 min via `src/maintenance.js`, one instance at a time | hardening |
| E15 | `webhooks.js`: one deadline per attempt (`AbortSignal.timeout`), response not read, 10 sends in flight with slots refilled each poll | hardening: a silent endpoint fails in 1.5 s |
| E16 | `index.js`: in-flight sends finish (≤ 10 s), forced exit after 15 s | code review |
| E18 | production allows ports 80/443/8080/8443 only | hardening |
| E19 | **compressed audit archive** (see section 5) | hardening: compaction, listing across both, filters, Admin scope, verify, tamper detection, append-only segments |
| E20 | `middlewares/idempotency.middleware.js` + `idempotency_keys`; the frontend sends a key on every create and retries once on a network failure | hardening: replay, 422 on reuse, 409 while running, stale claim released |
| E21 | `next.config.ts`: CSP ("Without Nonces", since nonces are incompatible with Partial Prerendering), X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy | headers checked on `next start` |
| E22 | `app.js` `X-Request-Id`, kept in error logs and audit `meta.request_id` | hardening |
| E23 | simulator overlap guard | code review |
| E24 | `utils/log-once.js` in the simulator, webhook worker and housekeeping | code review |
| E25 | `utils/validation.js` `displayName()` for every name | hardening |

**Found while fixing:**
- The idempotent response was stored *after* it was sent, so a fast retry got 409. It's now stored first.
- The Socket.IO adapter permanently holds one pool connection, so the usable pool is `DB_POOL_MAX − 1` (documented in `.env.sample`).

---

Severity:
- **High:** can take the service down, lose data or leak across tenants.
- **Medium:** wrong behaviour or slow degradation under realistic conditions.
- **Low:** polish or defense in depth.

---

## 1. Resource exhaustion (OWASP API4:2023 Unrestricted Resource Consumption)

OWASP recommends rate limits per client, maximum sizes on every input and limits on how many records an operation can create or return ([OWASP API4:2023](https://api-security.owasp.org/editions/2023/en/0xa4-unrestricted-resource-consumption)).

| # | Severity | Case | Evidence | Proposed fix |
|---|---|---|---|---|
| E1 | **High** | **No API-wide rate limit.** Only sign-in and sign-up are limited. A signed-in user (or a stolen session) can call any endpoint without limit. | `src/routes/index.js`: only `authLimiter` | A per-session limit on all `/api` routes (e.g. 600/min, which leaves room for live charts: 4 req/s per viewer), stricter on writes (e.g. 120/min). 429 with `Retry-After`. The in-memory store is per process (same ceiling as #13). |
| E2 | **High** | **Unbounded projects multiply the simulator.** Every project gets 5 points every 5 s. An Admin creating 10,000 projects makes each tick insert 50,000 rows and each detection pass scan them all. | `006_projects.sql` `simulate_tick` iterates all projects; no cap | Caps enforced in the database (a trigger, so no code path can bypass it): **projects ≤ 25 per team**, **teams ≤ 50 per org**. |
| E3 | **High** | **Unbounded webhooks per team** fan every event out to every endpoint (and every delivery can take up to 10 s). | No cap in `009_webhooks.sql` | **≤ 10 webhooks per team** (database trigger). |
| E4 | Medium | **Unbounded custom metrics.** Each `/metrics/summary` call parses and evaluates all of the team's custom metrics. | `metric.controller.js` summary | **≤ 50 custom metrics per team** (database trigger). |
| E5 | Medium | **Denials amplify into audit writes.** Every 403/404 becomes an audit write behind the per-org lock, so a flood of bad requests is also a flood of locked writes. | `error.middleware.js` `auditDenial` | Covered by E1. Also collapse repeats: one `access.denied` per session + path + status per minute, with a `count` in the entry's details. |
| E6 | Medium | **Dashboard lists silently truncate at 50.** A team with more than 50 dashboards loses the rest from the switcher. | `dashboard.controller.js` default `limit=50`; the frontend calls `/dashboards` | The frontend asks for `limit=100` (the API maximum) and shows "showing 100 of N" with a total count; or caps dashboards per project (≤ 100). |

## 2. Timeouts and the database connection pool

node-postgres: `connectionTimeoutMillis` "default is 0 which means no timeout", so `pool.connect` can "hang indefinitely". Without an `error` listener, an idle-client error makes "node … emit an uncaught error and potentially crash your node process". `statement_timeout`, `query_timeout` and `idle_in_transaction_session_timeout` all default to no timeout ([Pool](https://node-postgres.com/apis/pool), [Client](https://node-postgres.com/apis/client)).

| # | Severity | Case | Evidence | Proposed fix |
|---|---|---|---|---|
| E7 | **High** | **A dropped idle database connection can crash the API.** | `src/db/pool.js`: no `pool.on("error")` | Add a pool `error` listener (log it; pg removes the bad client). |
| E8 | **High** | **Requests hang forever when the pool is exhausted** (slow queries, or a DB stall), and every new request queues behind them. | `pool.js`: `connectionTimeoutMillis` unset | `connectionTimeoutMillis: 5000` → **503 "Service busy, retry"** (with `Retry-After`) instead of hanging. |
| E9 | **High** | **No query or transaction time limits.** One slow or locked query holds a connection indefinitely. | No `statement_timeout` anywhere | Set on the app role in a migration: `statement_timeout = 10s`, `lock_timeout = 5s`, `idle_in_transaction_session_timeout = 30s`. A timeout maps to 503. |
| E10 | Medium | **The frontend waits forever** on a hung API, leaving the spinner on screen. | `frontend/src/lib/api.ts`: no `AbortSignal` | A 15 s `AbortSignal.timeout` and a clear "The server didn't respond, try again" message. |
| E11 | Low | Node's HTTP server timeouts are left at their defaults (5 min request timeout). | `src/index.js` | Set `requestTimeout` 30 s and `headersTimeout` 15 s (Nginx in front also limits them). |

## 3. Sessions and live connections

| # | Severity | Case | Evidence | Proposed fix |
|---|---|---|---|---|
| E12 | Medium | **Removed members keep live updates for up to 60 s**, and so do members of a deleted team. Their sessions are deleted (FK cascade), but their sockets are only closed by the 60 s recheck. | `team.controller.js` `removeMember`/`deleteTeam` don't call `closeSockets` | Call `closeSockets` for the affected users right after the change. The new client retry (#42) reconnects their other, still-valid sessions. |
| E13 | Medium | **Session expiry mid-use isn't handled.** After 30 min idle, pages show raw "Not signed in" errors instead of returning to sign-in. | `session.tsx` only checks `/auth/me` on mount | A global 401 handler in `api()`: redirect to `/login?next=<current page>`. |
| E14 | Medium | **Expired sessions are never deleted**, so the table grows forever. | No cleanup query exists | An hourly cleanup (`DELETE … WHERE expires_at < now() OR last_seen_at < now() - idle`), run by the instance that wins the existing hourly retention slot. |

## 4. Webhook worker

| # | Severity | Case | Evidence | Proposed fix |
|---|---|---|---|---|
| E15 | **High** | **One slow endpoint stalls every tenant's webhooks.** The worker waits for the whole batch before claiming the next. The 10 s `timeout` is an *idle* timeout, so an endpoint that trickles bytes can hold a slot much longer. | `src/webhooks.js`: `running` flag + `Promise.all`; `timeout: 10_000` | An **overall 10 s deadline** per attempt (`AbortSignal.timeout`, which also covers DNS). Stop reading the response once the status arrives. Keep up to 10 sends in flight and claim more as slots free up, so the loop no longer waits for the slowest. |
| E16 | Medium | **Shutdown mid-send.** `SIGTERM` stops the timer but not sends already in flight; they then try to record their result on a closed pool. The delivery is re-sent after its 2 min lock expires (at-least-once, so allowed, but avoidable). | `src/index.js` `shutdown` | Wait (up to 10 s) for in-flight sends before closing the pool. Force exit after 15 s so shutdown can't hang. |
| E17 | Medium | **The deliveries table grows forever.** | No retention in `009` | Delete delivered or failed deliveries older than 30 days (hourly, as for metrics). |
| E18 | Low | **Any port is allowed** in webhook URLs (e.g. `:6379`), so the worker can be used to probe ports on public hosts. | `checkUrl` | Production: only ports 443 and 80 (plus 8443/8080). Development keeps any port. |
| ✔ | — | Numeric IP tricks are **already blocked**: `http://0x7f.1/`, `http://2130706433/`, `http://127.1/`, `http://[::ffff:7f00:1]/`. The WHATWG URL parser normalizes them before the check. | Verified in Prompt 51 | Add them to the unit tests as regressions. |

## 5. Data growth and retention (needs a decision)

| # | Severity | Case | Evidence | Options |
|---|---|---|---|---|
| E19 | Medium | **The audit log grows forever**, and it is append-only by design, so nothing can prune it. At ~50 entries/s for a busy org that is ~4 million rows a month. | `007_audit.sql` | (a) Keep everything (simplest, fine for the demo). (b) **Monthly partitions plus a retention period** (e.g. 1 year; old partitions exported to cold storage, then detached). The hash chain carries across the cut. A compliance-driven choice for the user. |

## 6. Write retries (idempotency)

| # | Severity | Case | Evidence | Proposed fix |
|---|---|---|---|---|
| E20 | Medium | **A retried create makes a duplicate.** If a "create dashboard / widget / project / webhook" request times out and the user retries, two are created. | All `POST` creates | Support the `Idempotency-Key` header on creates ([IETF draft-ietf-httpapi-idempotency-key-header](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header), still a draft):<br>• keys stored per user for 24 h with the response;<br>• the same key and body replays the response;<br>• the same key with a different body returns 422;<br>• a repeat while the first is still running returns 409.<br>The frontend sends a key per form submit. |

## 7. Browser security and operations

| # | Severity | Case | Evidence | Proposed fix |
|---|---|---|---|---|
| E21 | Medium | **No Content-Security-Policy** on the frontend (defense in depth against XSS). | `frontend/next.config.ts`: no `headers()` | CSP with nonces as described in the Next.js 16 docs (`frontend/node_modules/next/dist/docs/`), plus `X-Frame-Options: DENY` and `Referrer-Policy`. |
| E22 | Medium | **No request id.** API logs, audit entries and error reports can't be correlated. | `app.js` | Accept or generate `X-Request-Id`; return it in the response, include it in error logs, and store it in audit `meta`. |
| E23 | Low | **The simulator can overlap itself** if a tick runs longer than 5 s (the DB claim prevents double writes, but detection can run twice). | `simulator.js`: no `running` guard | The same guard as the webhook worker. |
| E24 | Low | **Error-log floods while the DB is down** (the simulator logs every 5 s, the worker every 2 s). | `simulator.js`, `webhooks.js` | Log the first failure and the recovery, and suppress the repeats in between. |
| E25 | Low | **Names made only of invisible characters** (zero-width spaces) pass the "not blank" checks. | `length(trim(name)) > 0` | Strip `\p{Cf}`/`\p{Zs}` before the blank check (API validation). |

---

## Summary

- **High:**
  - E1 (no API-wide rate limit)
  - E2, E3 (no caps on projects and webhooks)
  - E7, E8, E9 (pool and timeouts)
  - E15 (one webhook stalls all)
  - These are about service survival; I recommend fixing all of them.
- **Medium:**
  - E4, E5, E6, E10, E12, E13, E14, E16, E17, E20, E21, E22
  - E19 needs a retention decision.
- **Low:** E11, E18, E23, E24, E25.

Suggested order: High first (one shared migration for caps and timeouts, then the code), then Medium, then Low. Each fix gets a test and a problems-log entry.


## E19 as built: compressed audit archive (Prompt 53, Loki-style inside Postgres)

- **Live:** the last `AUDIT_HOT_DAYS` (7) of entries stay as indexed rows in `audit_log`.
- **Archive:** housekeeping packs older entries per org and hour into `audit_segments`.
  - Each segment stores the original rows, hashes included, as one JSON array in an **LZ4-compressed** column.
  - Next to it sits a **label index**: GIN-indexed `team_ids`, `actor_ids`, `actions` and `results`, plus the first/last seq and time.
  - This is the Loki approach: index the labels, compress the lines ([Grafana Loki](https://grafana.com/docs/loki/latest/get-started/overview/)).
- **Every entry is kept.**
  - The newest entry of each org always stays live, because the next one chains onto it.
  - Segments are append-only (trigger).
  - Rows leave `audit_log` only inside `app.compact_audit()`.
- **Reading:**
  - `GET /audit` fills a page from live rows, then from segments (always older). It prunes segments by labels and opens them one at a time.
  - `next_before` is the cursor, also when the scan stops after 200 segments.
  - Isolation is enforced by the reading function itself: there are no grants on `audit_segments`, and an Admin sees only their team's entries.
- **Integrity:** `app.audit_verify()` walks archive and live entries in one snapshot, so a concurrent compaction can't cause a false alarm. Editing an archived entry is detected.
- **Storage figures:** `GET /audit/storage` reports live rows, archived entries, segments and JSON size vs stored size. They appear at the top of the Audit page.
