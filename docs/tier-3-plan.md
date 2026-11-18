# Tier 3 Plan: Advanced

Status: **decisions made** (Prompt 48, 2026-11-18 02:20 IST). Drafted in Prompt 47. Tiers 1 and 2 are complete and verified by the user (Prompts 37 and 46).

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

## Known ceilings (to be logged as they're built)

- Audit hash chain: one advisory lock per org serializes audit writes within an org. That's fine at this scale; use per-org batching or a signed digest per hour (CloudTrail style) at volume.
- The webhook worker runs inside the API process. Split it into its own process when delivery volume grows.
- The SSRF guard relies on our own DNS check plus connecting to the checked IP. Production should also put egress behind a filtering proxy (the Standard Webhooks spec suggests smokescreen).
- No anomaly detection on custom metrics (only base metrics, as in Tier 2).

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
