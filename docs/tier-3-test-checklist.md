# Tier 3: Test Checklist

Written for Prompt 49 (2026-11-18, about 14:30 IST). Each item says **how** to test it and what to **expect**. Same format as the Tier 1 and Tier 2 checklists.

Tier 3 scope (brief, page 2):
1. Three-level hierarchy (Org → Team → Project)
2. Webhook subscriptions (external systems get notified)
3. Audit logs (track who accessed what)
4. Custom metric definitions

Seed users (org `acme`, password `Password@123`):
- `super@` — Super Admin
- `alice@` — Finance Admin, Marketing Viewer
- `bob@` — Finance Editor
- `carol@` — Marketing Viewer
- `dave@` — Marketing Admin

---

## 0. Setup

| Step | Action | Expected |
|---|---|---|
| 0.1 | `cd backend && npm run migrate` | Applies `006_projects`, `007_audit`, `008_custom_metrics` and `009_webhooks` (nothing if they're already applied) |
| 0.2 | `npm run seed` | Four projects: Finance has **Web App** and **Mobile App**; Marketing has **Campaigns** and **Website**. One "<project> Overview" dashboard each, with a **Revenue per click** custom-metric widget. Old dashboard links no longer work (new IDs). |
| 0.3 | `backend/.env` has `WEBHOOK_ALLOW_PRIVATE=1` (**dev only**, lets webhooks reach a local receiver) and `WEBHOOK_KEYRING_FILE=./secrets/webhook-keyring.json` | Both added in Prompts 49–50. The keyring exists locally; on a fresh clone run `npm run keyring -- init` |
| 0.4 | Start both apps with `npm run dev` | Backend logs `API listening on :8000`; the simulator and the webhook worker start |

---

## 1. Automated checks (run first)

- [ ] **1.1** `cd backend && npm run seed && npm test`. Expected: **117 passed, 0 failed** (96 before the hardening in Prompts 50–54) (new: `tier3.test.js` with 24 tests, plus 14 unit tests for formulas, signing, the SSRF guard and secret encryption).
- [ ] **1.2** Postman: import `backend/aafm-dashboard.postman_collection.json`, now **"Tiers 1-3"** with 101 requests. Run it in order with `AUTH_RATE_LIMIT=100`. Expected: all green, including folder **08 Tier 3**.
- [ ] **1.3** `cd frontend && npm run typecheck && npm run lint && npm run build`. Expected: no errors; the build lists `/projects`, `/metrics`, `/webhooks` and `/audit`.

## 2. Projects: Org → Team → Project (brief item 1)

- [ ] **2.1 Navigation.**
  - As Bob, the sidebar shows Dashboards, Projects, Custom metrics, Teams & people.
  - As Alice (Finance) or Sam, it also shows **Webhooks** and **Audit log**.
  - Expected: Bob does **not** see Webhooks or Audit log.
- [ ] **2.2 Project picker.** On Dashboards, the pills read **All projects · Web App · Mobile App** (for Bob).
  - Click **Mobile App**. Expected: the URL gets `?project=…`, the six cards change to Mobile App's totals, and the board shows **Mobile App Overview**.
  - Click **All projects**. Expected: the cards return to the team total (the sum of both projects).
- [ ] **2.3 Team totals = sum of projects.**
  - Note Revenue under Web App, then under Mobile App, then under All projects.
  - Expected: All projects ≈ Web App + Mobile App. Values tick live, so read them close together.
- [ ] **2.4 Access through the team.** As Carol (Marketing), Projects lists only Campaigns and Website. Expected: no Finance project anywhere.
- [ ] **2.5 Managing projects (Admins).**
  - As Alice (Finance), Projects → **New project** "Payments" → it appears. Rename it.
  - Bob (Finance) in another window sees it appear without a refresh (live).
- [ ] **2.6 New dashboard in a project.** Banner → New dashboard: there's a **Project** select. Create one in Payments. Expected: it opens with `?project=<Payments>`.
- [ ] **2.7 Deleting a project.**
  - Delete Payments. Expected: the confirm says it removes its dashboards, data and alerts; afterwards, links to its dashboard fall back with the "no longer exists" note.
  - Try to delete a team's **last** project. Expected: *"A team must keep at least one project"*.
- [ ] **2.8 Editors can't manage projects.** As Bob, no New / rename / delete controls. Expected: the API also refuses (403; Postman 08).
- [ ] **2.9 Alerts name the project.** Trigger an anomaly (Tier 2 checklist §6, now per project: the SQL there targets **Web App**). Expected:
  - the sidebar Alerts list shows "… · Web App · open";
  - only the **Web App Overview** widgets get the red border, not Mobile App's.

## 3. Custom metric definitions (brief item 4)

- [ ] **3.1 List.** Custom metrics shows **Revenue per click**, `revenue / clicks`, Currency.
- [ ] **3.2 Live formula check.** As Bob, **New metric**, then type in Formula:
  - `revenue / (users`. Expected: the preview box says *Missing ")"* with the character position.
  - `profit / users`. Expected: *Unknown metric "profit"* and the allowed names.
  - `revenue; DROP TABLE users`. Expected: *Unexpected character ";"*, never a database error.
  - Click the example `(clicks - errors) / page_views * 100`. Expected: a 24-hour preview curve appears.
- [ ] **3.3 Create and chart it.**
  - Name it "Clean click share", shown as Percent, then Create.
  - On a dashboard: Edit layout → Add widget → Shows → **Custom metrics → Clean click share** as a line chart.
  - Expected: a live chart in percent. As a Number widget, the value with a ▲/▼ change.
- [ ] **3.4 Divide by zero is a gap.** A formula like `revenue / (users - users)` previews as "No data" or gaps, never Infinity. Automated: `tier3.test.js` checks exact values `[10, null]`.
- [ ] **3.5 Can't delete while used.** Delete "Clean click share" while the widget exists. Expected: *"In use by 1 widget(s): "Clean click share" on Web App Overview"*. Remove the widget, then delete. Expected: it works.
- [ ] **3.6 Permissions.** As Carol (Viewer), Custom metrics is read-only (no New/Edit/Delete). Marketing never sees Finance's metrics.

## 4. Audit log: "track who accessed what" (brief item 3)

- [ ] **4.1 Who did what.** As Bob, open a dashboard and add a widget. Then, as Alice (Finance) or Sam, open **Audit log**. Expected rows:
  - `dashboard.view` by Bob Editor;
  - `widget.add` by Bob Editor, with the title in Details;
  - Bob's sign-in (`auth.login`), with IP and time.
- [ ] **4.2 Failed sign-ins.** Sign in as bob@ with a wrong password, then filter Action = **Sign-in and sessions**. Expected: `auth.login_failed` with result **failed** (reason: password).
- [ ] **4.3 Refusals are recorded.** As Carol, open `http://localhost:3000/audit` directly; the page shows the API's refusal. Then as Sam, filter Result = **Denied**. Expected: `access.denied` by Carol Viewer, path `/api/v1/audit`, status 403.
- [ ] **4.4 Team scope.** As Alice (Finance Admin), every row's Team is Finance. As Dave (Marketing Admin), only Marketing. As Sam, all teams, with a Team filter.
- [ ] **4.5 Viewing the log is itself logged.** Each visit adds an `audit.view` row.
- [ ] **4.6 Integrity.** Click **Verify integrity**. Expected: *"Intact: all N entries … match their hashes."*
- [ ] **4.7 Tamper test (optional; run as the DB owner, then undo).**
  ```
  psql "<MIGRATION_DATABASE_URL>" -c "UPDATE audit_log SET action = 'x.y'"
  ```
  - Expected: *ERROR: audit_log is append-only*. Even the owner can't edit or delete.
  - Automated: `tier3.test.js` also disables the trigger, edits one row, checks that Verify reports **that exact entry** as tampered, then restores it.
- [ ] **4.8 No secrets in the log.** Scan the Details column. Expected: no passwords, session tokens or webhook secrets anywhere.

## 5. Webhook subscriptions (brief item 2)

- [ ] **5.1 Start a local receiver** (new terminal, `backend/`):
  ```
  node scripts/webhook-receiver.js 9999
  ```
- [ ] **5.2 Add an endpoint.**
  - As Alice (Finance), go to Webhooks → **Add endpoint**:
    - URL `http://127.0.0.1:9999/hook`;
    - events `dashboard.created`, `alert.opened`, `alert.resolved`.
  - Expected: a **Signing secret** dialog (`whsec_…`) with Copy, shown once.
  - Restart the receiver with the secret:
    ```
    WEBHOOK_SECRET=whsec_... node scripts/webhook-receiver.js 9999
    ```
    (PowerShell: `$env:WEBHOOK_SECRET="whsec_..."; node scripts/webhook-receiver.js 9999`)
- [ ] **5.3 Test event.** Click the **send** icon. Expected:
  - within about 2 s the receiver prints `webhook.test` with **signature: VALID**;
  - Deliveries shows it as **delivered**, attempt 1, HTTP 200.
- [ ] **5.4 A real event.** As Bob, create a dashboard. Expected:
  - the receiver prints `dashboard.created` (with the dashboard, its project and the actor), signature VALID;
  - the `webhook-id` header matches the delivery in the UI.
- [ ] **5.5 Alerts reach the endpoint.** Trigger an anomaly (Tier 2 checklist §6). Expected: `alert.opened` arrives (team, project, z-score), and later `alert.resolved`.
- [ ] **5.6 Retries back off.**
  - Add an endpoint `http://127.0.0.1:9999/fail` and send a test.
  - Expected: Deliveries shows **pending**, attempt 1, HTTP 500, and "Next attempt" about 5 s later; then the next retry about 5 minutes after that.
- [ ] **5.6b Failures are in the Audit log (Prompt 50).** After 5.6, open Audit log → Action **Webhooks**. Expected:
  - `webhook.delivery_failed` by **Webhook worker**, result failed, with the host, attempt, HTTP code, error and next attempt time;
  - the URL's path is **not** shown.
  - The Webhooks page updates by itself as attempts happen.
- [ ] **5.7 410 disables.** An endpoint `http://127.0.0.1:9999/gone` → send a test. Expected: the endpoint flips to **Disabled** with *"Endpoint returned 410 Gone"*.
- [ ] **5.8 Redeliver.** Expand a delivery → **Redeliver**. Expected: the receiver gets it again with the **same webhook-id** (receivers dedupe on it).
- [ ] **5.9 Rotate.** Click the **key** icon. Expected:
  - a new secret is shown once;
  - the next message carries **two** signatures (old and new, for 24 h), and the receiver still says VALID with either secret.
- [ ] **5.10 SSRF guard.** Use the API (Postman covers the first two):
  - `ftp://…` is refused;
  - `https://user:pass@…` is refused.
  - With `WEBHOOK_ALLOW_PRIVATE` **unset**, `http://169.254.169.254/` and `http://localhost/` are refused.
  - Automated: unit tests and `tier3.test.js` check that "localhost" is refused **at connect time**, after DNS resolves it to loopback.
- [ ] **5.10b Secrets are encrypted at rest (Prompt 50).** Run (as the owner):
  ```
  psql "<MIGRATION_DATABASE_URL>" -c "SELECT left(secret, 30) FROM webhooks"
  ```
  - Expected: `v1:k…:` ciphertext, never `whsec_`.
  - Without `backend/secrets/webhook-keyring.json`, the backend refuses to start with a clear message.
  - `npm run keyring -- rotate` re-encrypts every secret, and deliveries keep verifying.
- [ ] **5.11 Scope.** As Bob (Editor), there's no Webhooks link and the API returns 403. As Dave (Marketing Admin), Finance's endpoints are invisible.

## 5b. Production hardening (Prompts 50–53, `docs/edge-case-audit.md`)

- [ ] **H1 Automated.** `npm test` → **117 passed**. `test/hardening.test.js` (19 tests) covers rate limits, caps, the pool and timeouts, socket closure on removal, Idempotency-Key, the compressed audit archive, housekeeping, webhook deadlines and request ids.
- [ ] **H2 Caps.** Create projects until a team has 25. The 26th says *"Limit reached: at most 25 projects per team"* (the same for webhooks 10/team, custom metrics 50/team, teams 50/org).
- [ ] **H3 Audit archive.** Audit log page: the line under the title shows recent rows vs archived entries and the compression.
  - To archive now (as the DB owner):
    ```
    psql "<MIGRATION_DATABASE_URL>" -c "SELECT app.compact_audit('-2 hours', 1000)"
    ```
  - Expected: the line shows archived entries in segments; **Load older entries** still pages through everything with filters; **Verify integrity** is still Intact.
- [ ] **H4 Session expiry.** Delete your session row, or wait 30 min idle, then click anything. Expected: back to sign-in, and to the same page after signing in.
- [ ] **H5 Removed member.** Remove a member who has a dashboard open. Expected: their Live badge drops at once (not after a minute).
- [ ] **H6 Security headers.** `curl -I http://localhost:3000/login`. Expected: `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`.

- [ ] **H7 Signed checkpoints (Prompt 54).**
  - Verify integrity now says *"… and N signed checkpoints (latest #…) are present and genuine"* (after the first housekeeping run, ≤ 5 min).
  - Automated: deleting the newest entries, or forging a checkpoint, is reported.
- [ ] **H8 Separate worker (optional).**
  - Start the API with `RUN_WORKERS=false npm run dev` and, in another terminal, `npm run worker`.
  - Expected: charts still tick live and webhooks still deliver. The jobs run in the worker; the browser is connected to the API.
- [ ] **H9 Paced refresh.**
  - On **1H**, charts move every ~5 s; on **24H**, every ~30 s; on **7D**, every ~60 s.
  - An alert on Revenue or Users also bands the **ARPU** chart (KPI inputs).

## 6. Regression: the Tier 1 and Tier 2 essentials still hold

- [ ] **6.1** Simultaneous editing and the **Live** badge still work (now with the cookie fix, #35).
- [ ] **6.2** KPIs and anomaly alerts work per project. The **Tier 2 checklist §6 SQL** now targets Finance → Web App.
- [ ] **6.3** Isolation: Carol never sees anything from Finance (projects, dashboards, custom metrics, alerts, audit, webhooks).

---

## Known limits (expected, not bugs; problems-log #39)

1. Audit writes are serialized per organization (fine at this scale).
2. Deleting the newest audit rows (the tail) can't be detected from the chain alone. Signed periodic digests (as in CloudTrail) are the upgrade.
3. The webhook worker runs inside the API process; secret keys live in a keyring file (a KMS is the managed upgrade).
4. Charts assume values ≥ 0; a custom formula that goes negative draws below the axis.
5. No anomaly detection on custom metrics (only on the base metrics).
6. Postman can't run Socket.IO or a webhook receiver, so those paths are covered by `tier3.test.js`.
