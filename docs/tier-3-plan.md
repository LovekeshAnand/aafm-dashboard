# Tier 3 Plan: Advanced

Status: **built, awaiting the user's review** (Prompt 49). Decisions in Prompt 48, drafted in Prompt 47. Tiers 1 and 2 are complete and verified by the user (Prompts 37 and 46).

Brief, page 2, Tier 3:
1. Three-level hierarchy (Org → Team → Project)
2. Webhook subscriptions (external systems get notified)
3. Audit logs (track who accessed what)
4. Custom metric definitions

Time left at drafting: about 36 h (due 2026-11-19 14:22 IST). The live URL (deployment) still has to fit after Tier 3.

---

## Where we start from

- **Data model today:** `organizations → teams`. Dashboards, widgets, metric points and alerts are all keyed by `team_id`, and RLS scopes every read to the active team (the Super Admin sees the whole org).
- **What Tier 3 can reuse:**
  - `withContext()` and the RLS helper `app.in_scope()`, for projects, webhooks and the audit log;
  - the team and org socket channels, for live updates;
  - the KPI engine (ratio of sums per bucket), for custom metrics;
  - the simulator (`app.simulate_tick`), for per-project data.

---

## Work list (depth first, in order)

### A. Three-level hierarchy: Org → Team → Project

**Industry model.** Sentry runs Organization → Team → Project. Projects belong to teams, a user reaches a project **through team membership**, and org-level roles apply across all teams and projects ([Sentry membership](https://docs.sentry.io/accounts/membership/), [Sentry team roles](https://docs.sentry.io/product/teams/roles/)). We already have the same org- and team-level roles, so this maps directly.

- [ ] Migration `006_projects.sql`:
  - a `projects` table (`id, org_id, team_id, name, created_at`), with the name unique within its team;
  - RLS: read when the project's team is in scope; write for Admins of that team and the Super Admin.
- [ ] Projects own the data: `metric_points`, `dashboards` and `alerts` gain `project_id`.
  - Each existing team gets a **default project**, and existing rows move into it, so nothing is lost.
  - Team totals stay as the sum over the team's projects. The Tier 2 KPI and summary queries then work at both levels.
- [ ] Simulator and anomaly detection run per project. Alerts name the project.
- [ ] API: `GET/POST/PATCH/DELETE /projects`, plus a `project_id` filter on dashboards, metrics, KPIs and alerts.
- [ ] UI:
  - a project picker under the team (sidebar);
  - dashboards listed per project;
  - home cards for the selected project, or "All projects" for team totals;
  - project management on the Teams page (Admins).
- [ ] Tests: project isolation across teams; team totals equal the sum of projects; an Editor can't create projects.

### B. Audit logs ("who accessed what")

**Research.** The OWASP Logging Cheat Sheet ([OWASP Logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)):
- **Events to record:** authentication successes and failures, authorization failures, access to sensitive data, data changes and admin actions.
- **What each record carries:** when, where, who and what.
- **Never log:** passwords, tokens or session ids. Log a hash instead.
- **Integrity:** "build in tamper detection", and use a separate writer account with very limited permissions.

AWS CloudTrail detects tampering by chaining hashes, where each digest includes the previous one ([CloudTrail validation](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-log-file-validation-intro.html)).

- [ ] Migration `007_audit.sql`: an `audit_log` table holding:
  - `id, org_id, team_id, project_id`;
  - `actor_user_id, actor_name` (the name as it was then);
  - `action` (e.g. `dashboard.view`, `widget.update`, `auth.login_failed`);
  - `target_type, target_id`, `result` (allowed / denied);
  - `ip, user_agent, at`, a `meta jsonb` diff summary;
  - `prev_hash, hash`.
- [ ] **Append-only in the database.** The app role gets INSERT only, through a SECURITY DEFINER `app.audit()` function. Nobody gets UPDATE or DELETE, and a trigger rejects both, even for the owner. Super Admin reads the whole org; Admins read their team. This is the OWASP "restricted writer".
- [ ] **Tamper evidence:** `hash = sha256(prev_hash || row)`, chained per org (a per-org advisory lock keeps the chain ordered). `GET /audit/verify` recomputes the chain and reports the first broken row.
- [ ] **What is logged:**
  - sign-in success and failure, sign-out, team switch, password change and reset;
  - every write (dashboards, widgets, teams, members, projects, webhooks, custom metrics);
  - **reads of named resources:** opening a dashboard and listing members;
  - every 403 and 404 on a tenant resource (authorization failures).
- [ ] UI: an **Audit log** page (Admins and Super Admin) with filters (actor, action, date) and paging, plus a "Verify integrity" button.
- [ ] Tests:
  - an Editor's change is logged with the right actor;
  - a Viewer can't read the log;
  - Finance's Admin can't see Marketing's entries;
  - UPDATE and DELETE are refused;
  - a hand-edited row makes verify fail.

### C. Webhook subscriptions

**Research.**
- **Standard Webhooks spec** ([spec](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)):
  - headers `webhook-id`, `webhook-timestamp` and `webhook-signature`;
  - HMAC-SHA256 over `id.timestamp.body`, with a secret per endpoint (`whsec_…`, 24–64 random bytes);
  - retries with exponential backoff and jitter;
  - don't follow 3xx; `410` disables the endpoint;
  - a 15–30 s timeout; payloads under 20 KB.
- **OWASP SSRF Cheat Sheet** for user-supplied URLs ([OWASP SSRF](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)):
  - allow only http(s);
  - resolve DNS and block private, loopback, link-local and cloud-metadata addresses;
  - **connect to the checked IP** (to defeat DNS rebinding);
  - disable redirects.
- **Delivery:** a Postgres outbox drained with `FOR UPDATE SKIP LOCKED`, which gives at-least-once delivery, so receivers dedupe on `webhook-id` ([Convoy: outbox for webhooks](https://www.getconvoy.io/blog/webhooks-with-transactional-outbox), [SKIP LOCKED queue](https://www.dbpro.app/blog/postgresql-skip-locked)).

- [ ] Migration `008_webhooks.sql`:
  - `webhooks`: `id, org_id, team_id, project_id?, url, events text[], secret, enabled, failure_count`;
  - `webhook_deliveries` (the outbox): `id, webhook_id, event, payload, attempt, next_attempt_at, status, response_code, last_error`.
  - RLS: Admins of the team and the Super Admin.
- [ ] **Events** (Q3): `alert.opened`, `alert.resolved`, `dashboard.created`, `dashboard.updated`, `dashboard.deleted`, `member.added`, `member.removed`.
  - Each delivery is written **in the same transaction** as the change (outbox), so an event is never lost and never sent for a rolled-back change.
- [ ] **Worker** (in the API process, like the simulator):
  - claims due rows with `SKIP LOCKED`, which is safe with several instances;
  - signs the payload;
  - POSTs with a 10 s timeout and no redirects;
  - retry schedule 5 s, 5 m, 30 m, 2 h, 5 h, then marks the delivery failed;
  - auto-disables an endpoint after 10 consecutive failures.
- [ ] SSRF guard as above. Private addresses are blocked unless `WEBHOOK_ALLOW_PRIVATE=1`, which is dev-only so a local receiver can be tested. Every attempt is audit-logged.
- [ ] Secrets: shown **once** at creation, like the one-time passwords. Admins can rotate them. A delivery is signed with both the old and new secret for 24 h, since the spec allows several signatures.
- [ ] API and UI: a **Webhooks** page per team:
  - add an endpoint (URL plus event checkboxes);
  - send a test event;
  - a deliveries list with status, code and attempts;
  - redeliver;
  - enable or disable.
- [ ] Tests:
  - the signature verifies against the spec algorithm;
  - private IPs and redirects are refused;
  - retries are scheduled and back off;
  - a delivery is created only on commit;
  - another team can't see or change the hooks.
  - A tiny local receiver in the test suite checks the end-to-end path.

### D. Custom metric definitions

**Research.** Datadog derives custom metrics from a **formula over named queries**, e.g. `a + b` ([Datadog derived metric API](https://docs.datadoghq.com/api/latest/metrics/), [Datadog arithmetic](https://docs.datadoghq.com/dashboards/functions/arithmetic/)). Grafana's math expressions support `+ - * / ( )` over other queries.

- [ ] Migration `009_custom_metrics.sql`: `custom_metrics` (`id, org_id, team_id, key, name, formula, unit (number | currency | percent), created_by`). RLS: read in the team's scope; write for Editors and up.
- [ ] Formula language: base metric names, numbers, `+ - * /` and parentheses. For example:
  - `revenue / users` (ARPU, same as the built-in);
  - `(clicks - errors) / page_views * 100`;
  - `revenue / (users + 1)`.
- [ ] Parsing:
  - **parsed on the server** by a small recursive-descent parser (about 60 lines, no `eval`, no new dependency);
  - limits of 200 characters and 30 tokens;
  - turned into SQL **only from the parsed tree**, with metric names checked against the enum, numbers bound as parameters, and no user text concatenated.
- [ ] Evaluation:
  - per bucket on the **sums** of each metric, the same rule as the KPIs (a ratio of sums, not a sum of ratios);
  - division by zero gives `null`, a gap.
- [ ] A widget source becomes metric **or** KPI **or** custom metric, extending the migration `005` check. Custom metrics appear in the "Shows" picker under **Custom**.
- [ ] UI: a **Custom metrics** page per team:
  - a formula field with live validation (the parse error with its position);
  - a preview chart;
  - a list with edit and delete. Delete is blocked while widgets use the metric, and the page says which ones.
- [ ] Tests:
  - the parser accepts valid formulas and rejects injection attempts (`revenue; DROP…`, unknown names, unbalanced parentheses);
  - exact values on a fixed dataset;
  - divide-by-zero gives a gap;
  - team isolation.

### E. Wrap-up
- [ ] Postman folder "08 Tier 3". Security checks: SSRF, a forged signature, audit tampering.
- [ ] `docs/tier-3-test-checklist.md`, the same format as Tier 2.
- [ ] All suites green, Prettier clean, then the user's review.

**Suggested order: A → B → D → C → E.**
- A changes the data model that everything else hangs off.
- B (audit) should exist before C and D, so their writes are logged from the start.
- D is small and reuses the KPI engine.
- C is the largest (worker, SSRF, retries), so it comes last but before wrap-up.

**Time budget (rough):** A 5 h · B 4 h · D 3 h · C 6 h · E 2 h ≈ 20 h. That leaves time to deploy before the deadline.

---

## As built (Prompt 49, finished 2026-11-18 ~14:30 IST)

The checklists above are the plan. This section records what was built, **including where it changed and why**.

**A. Projects: done.** Migration `006_projects.sql`.
- `projects` table under RLS: everyone in the team reads; Admins and the Super Admin write.
- Dashboards, metric points and alerts carry `project_id`, with a composite FK `(project_id, team_id, org_id)` so a row can never point at another team's project.
- A trigger gives every new team a **General** project. Existing rows moved into it.
- The simulator and anomaly detection run per project.
- API:
  - `GET/POST/PATCH/DELETE /projects`, refusing to delete a team's last project (409);
  - a `project_id` filter on dashboards, series, KPIs, summary and alerts;
  - `POST /dashboards` takes a `project_id`.
- Seed: Finance has **Web App** and **Mobile App**; Marketing has **Campaigns** and **Website**. There's one "<project> Overview" dashboard each.
- UI:
  - a **Projects** page (manage, with dashboard counts);
  - a project picker on the dashboards home (`?project=`, which scopes the cards and the switcher);
  - a project choice in New dashboard;
  - widgets read their own dashboard's project;
  - alerts name their project.

**B. Audit log: done.** Migration `007_audit.sql`.
- Recorded:
  - sign-in success and failure, sign-out, team switch, password change and reset, org creation;
  - every write;
  - named reads: `dashboard.view`, `members.view`, `audit.view`;
  - every 403/404 on a signed-in request, as `access.denied`.
- The hash chain is built **before** the INSERT, so no UPDATE ever touches the table.
- **Changed from the plan:**
  1. `org_id` is not a foreign key either. A cascading delete would collide with the append-only rule, and the trail should outlive deletions anyway (#37).
  2. Two writes don't make the request wait:
     - **failed sign-ins**, so a real account isn't measurably slower to refuse than an unknown one (account enumeration);
     - **denials**, which run after the request's transaction rolled back.
- UI: an **Audit log** page (Admins and the Super Admin) with action, result and team filters, "Load older" paging, and **Verify integrity**.

**D. Custom metrics: done.** Migration `008_custom_metrics.sql`; parser in `src/utils/formula.js`.
- About 150 lines: a recursive-descent parser, SQL built only from the tree (names and numbers bound as parameters), and a JS evaluator for totals.
- The built-in KPIs now run through the same engine, since a KPI is just the formula `a / b`.
- A widget's source is exactly one of metric, KPI or custom metric (`num_nonnulls(...) = 1`). A composite FK keeps it on its own team's metric, and a metric still used by widgets can't be deleted (409 names the widgets).
- **Added:** `GET /metrics/formula`, a live validation and preview of an unsaved formula. The editor shows the exact error and character position, or the last 24 h curve.
- UI:
  - a **Custom metrics** page (Editors and up create; everyone reads);
  - a "Custom metrics" group in Add widget → Shows;
  - number widgets via `summary.custom`.

**C. Webhooks: done.** Migration `009_webhooks.sql`; worker in `src/webhooks.js`.
- **Signing:** Standard Webhooks, verified in a unit test against the spec's published test vector. Rotation keeps the old secret signing for 24 h, so a message carries two signatures.
- **Outbox:**
  - dashboard and member events are queued in the same transaction as the change;
  - alert events are queued by a database trigger on `alerts`;
  - the worker claims due rows with `FOR UPDATE SKIP LOCKED` every 2 s.
- **SSRF guard** (OWASP):
  - http(s) only, no credentials in the URL;
  - every resolved address is checked;
  - the socket connects to the checked address (custom `lookup`);
  - redirects are never followed.
  - `WEBHOOK_ALLOW_PRIVATE=1` lifts the address check for local development only.
- **Secrets:** the app role has no SELECT on the secret columns, only the worker's claim function returns them.
  - **Prompt 50:** they are also encrypted at rest. AES-256-GCM, bound to the webhook's id, with keys in a keyring file kept outside the database and the repo (`npm run keyring -- init | rotate | prune`). The server refuses to start without it. OWASP Cryptographic Storage Cheat Sheet; a KMS is the managed upgrade.
- **Delivery outcomes in the audit log (Prompt 50, reversing the first build):** recorded with the actor "Webhook worker", the host only (never the path or query, which can hold tokens), and pushed live to the Webhooks page (`webhooks:changed`):
  - every failed attempt, with the code, the error and the next attempt time;
  - the final give-up;
  - an automatic disable;
  - a success after earlier failures.
  - A first-try success isn't audited; the deliveries list shows it.
- **Added:** `backend/scripts/webhook-receiver.js`, a local endpoint that prints deliveries and checks their signatures.
- UI: a **Webhooks** page with:
  - add an endpoint (URL, events, optional project), with the secret shown once;
  - send test, enable/disable, rotate, delete;
  - a deliveries list with the body, status, attempt and error, and Redeliver (same `webhook-id`).

**Also fixed on the way:** the socket cookie parser bug (problems-log #35).

**Verification:**
- Backend **96/96** after Prompt 50 (was 90/90): new `test/tier3.test.js` (22) and Tier 3 unit tests (10 more in `test/unit.test.js`).
- Frontend typecheck, lint and build are clean.
- Postman: new folder **08 Tier 3** (37 requests). The collection now has **101 requests** and **131/131** assertions pass against a live server.
- Checklist: `docs/tier-3-test-checklist.md`.

## Known ceilings (to be logged as they're built)

- Audit hash chain: one advisory lock per org serializes audit writes within an org. Measured at about 3,200 writes/s for one org (Prompt 50), so it's fine at this scale. Growth is handled by the compressed archive (Prompt 53).
- The webhook worker runs inside the API process. Split it into its own process when delivery volume grows.
- The SSRF guard relies on our own DNS check plus connecting to the checked IP. Production should also put egress behind a filtering proxy (the Standard Webhooks spec suggests smokescreen).
- No anomaly detection on custom metrics (only base metrics, as in Tier 2).
- Charts assume values at or above zero; a custom formula that goes negative (e.g. `clicks - errors * 1000`) draws below the axis.
- Webhook secrets are encrypted with a keyring file (Prompt 50); envelope encryption with a cloud KMS is the managed upgrade.

---

## Decisions (Prompt 48)

1. **Projects:** access goes **through the team** (Sentry's model). Every team member sees the team's projects with their team role. Admins and the Super Admin manage projects. No per-project roles.
2. **Audit:** **named reads**: opening a dashboard and viewing members, plus all writes, auth events and permission denials. Metric polling is not logged. The log is append-only and hash-chained.
3. **Webhooks:** alert, dashboard and member events, configured **per team** by Admins (optional project filter). Standard Webhooks signing, retries and the SSRF guard.
4. **Custom metrics:** **formulas per team** over the five base metrics (`+ - * / ( )`), usable as a widget source. No alerting on them.

## Questions for the user (answered above)

- **Q1. Project access.** Should users reach projects **through their team** (Sentry's model: every member of Finance sees all of Finance's projects, with their team role), or should there be **per-project membership and roles** as well?
- **Q2. Audit "access" depth.** Should the log record reads of named resources (opening a dashboard, viewing members) plus all writes, auth events and denials, or **every** API read, including the metric polling every 5 s, which would be thousands of rows per hour per viewer?
- **Q3. Webhook events.** Alerts plus dashboard and member changes, as listed in C? Should they be configured per team, or optionally per project?
- **Q4. Custom metric scope.** Formulas over the five base metrics with `+ - * /`, defined per team, usable as a widget source, as in D? Or do you also want aggregation functions (e.g. avg, max) or alerting on custom metrics?
