# Tier 1: Test Checklist

Written for Prompt 26 (2026-11-17 17:09 IST). Tick each box as you verify it. Every item lists **how** to test it and the **expected** result.

Tier 1 scope (brief, page 2):
- Org → Team hierarchy
- Admin / Editor / Viewer roles
- Dashboards with metrics
- Data persists
- Database isolation enforced (RLS)

---

## 0. Setup (once, before testing)

| Step | Command / action | Expected |
|---|---|---|
| 0.1 | `cd backend && npm run seed` | `seeded 1 org, 2 teams, 5 users, 16136 metric points` |
| 0.2 | In `backend/.env` set `AUTH_RATE_LIMIT=100`, then restart the backend | Needed for section 2.6. With the default of 10, the IP limit (429) triggers before the account lock. |
| 0.3 | `cd backend && npm run dev` · `cd frontend && npm run dev` | API on :8000, app on http://localhost:3000 |
| 0.4 | Use a normal window for one user and an **incognito** window for a second user | Each window keeps its own session cookie |

**Seed accounts:** org `acme`, password `Password@123` for everyone.

| User | Memberships |
|---|---|
| `super@acme.test` | Super Admin (whole org) |
| `alice@acme.test` | Finance **Admin** + Marketing **Viewer** |
| `bob@acme.test` | Finance **Editor** |
| `carol@acme.test` | Marketing **Viewer** |
| `dave@acme.test` | Marketing **Admin** |

---

## 1. Automated checks (run first: about 1 minute)

- [ ] **1.1 Backend test suite.** `cd backend && npm run seed && npm test`. Expected: `tests 35`, `pass 35`, `fail 0`. This covers RLS isolation, roles, sessions, CSRF, lockout, conflicts and the IAM flows.
- [ ] **1.2 Postman collection.** Import `backend/aafm-dashboard.postman_collection.json` and run the whole collection in order with the Collection Runner. Expected: all requests green (53 requests).
- [ ] **1.3 Frontend static checks.** `cd frontend && npm run typecheck && npm run lint && npm run build`. Expected: no errors; the build lists `/login`, `/signup`, `/dashboards`, `/dashboards/[id]`, `/teams`, …
- [ ] **1.4 Dev overlay.** Open any signed-in page in `npm run dev`. Expected: the Next.js badge (bottom corner) no longer shows **"1 Insight"** (problems-log #15).

---

## 2. Sign-in and sessions

- [ ] **2.1 Identifier-first sign-in.** On `/login`, enter `acme` + `bob@acme.test` → Continue → enter the password → Sign in.
  - Expected: Continue does **not** call the server; the password step shows `acme · bob@acme.test` with a "Change" link.
  - Bob has one membership, so he lands straight on **/dashboards** ("Welcome back, Bob"; banner label `FINANCE · EDITOR`).
- [ ] **2.2 Org is remembered.** Sign out, then open `/login`. Expected: the Organization field is already `acme` and focus is on Email.
- [ ] **2.3 Every failure looks the same.** Try (a) a wrong password, (b) `nobody@acme.test`, (c) org `nope`.
  - Expected: all three show exactly **"Invalid organization, email or password"**. Nothing reveals which part was wrong.
- [ ] **2.4 Team picker after the password (never before it).** Sign in as `alice@acme.test`.
  - Expected: after the password, a picker lists **Finance · Admin** and **Marketing · Viewer**. Nothing about Alice's teams appears before the password step.
  - Pick Finance → /dashboards with the label `FINANCE · ADMIN`.
- [ ] **2.5 Switch workspace.** As Alice, click the workspace box (top of the sidebar) → pick Marketing.
  - Expected: back on /dashboards with `MARKETING · VIEWER`; the **New dashboard** button is gone, because a viewer is read-only.
- [ ] **2.6 Account lockout.** Requires step 0.2. Enter a wrong password 10 times for `carol@acme.test`, then the **correct** password.
  - Expected: it still fails with the same generic message. The account is locked for 15 minutes; `npm run seed` resets it.
- [ ] **2.7 Sign-out really ends the session.**
  - Sign out (icon at the bottom of the sidebar), then press the browser **Back** button or open `/dashboards`. Expected: you're redirected to `/login`.
  - In DevTools → Application → Cookies, the `session` cookie is gone.
- [ ] **2.8 Cookie flags.** DevTools → Application → Cookies → `session`. Expected: **HttpOnly ✓**, **SameSite = Strict**, Path `/`. In production it is named `__Host-session` and is also Secure.
- [ ] **2.9 Protected pages need a session.** In a fresh incognito window open http://localhost:3000/teams. Expected: redirect to `/login?next=%2Fteams`; after signing in you land on `/teams`.

## 3. Org → Team hierarchy (Super Admin)

- [ ] **3.1 Org-wide view.** Sign in as `super@acme.test`.
  - Expected: banner label `ALL TEAMS · SUPER ADMIN` (sidebar shows "Whole organization").
  - The dashboard switcher (pill tabs above the board) shows **both** Finance Overview and Marketing Overview, each with its team name.
  - The stat tiles are org-wide totals.
- [ ] **3.2 Create a team.** Teams & people → **New team** → "Sales". Expected: Sales appears in the left list and is selected, with an empty member table.
- [ ] **3.3 Rename and delete a team.** Select Sales → pencil → rename → Save. Then trash → confirm in the browser dialog.
  - Expected: the name updates, then the team disappears. Deleting removes its dashboards and memberships too.
- [ ] **3.4 Only the Super Admin manages teams.** Sign in as Alice (Finance Admin) → Teams & people.
  - Expected: no "New team" button; only Finance's members are shown.

## 4. Members, AWS IAM-style accounts

- [ ] **4.1 Create a user.** As Super Admin (or Alice in Finance) → Teams & people → Finance → **Add person** → email `new1@acme.test`, name, role Viewer.
  - Expected: a **"Sign-in credentials"** dialog shows a 20-character one-time password with a copy button, and the note "This password will not be shown again."
- [ ] **4.2 First sign-in forces a password change.** Incognito → sign in as `new1@acme.test` with that password.
  - Expected: you land on **"Set your password"**.
  - Entering a non-matching confirmation shows "The new passwords don't match."
  - After saving (12+ characters) → workspace picker → Finance → dashboards.
- [ ] **4.3 Nothing works before the change.** (Postman/API) While `must_change_password` is set, any `/api/v1/dashboards` call returns **403 "Password change required"**.
- [ ] **4.4 Adding an existing account.** Super Admin → Marketing → Add person → `bob@acme.test`, role Viewer.
  - Expected: **no** password dialog. The notice reads "bob@acme.test already had an account and was added to Marketing." Bob now gets a picker at sign-in.
- [ ] **4.5 Change a role.** Change a member's role in the Role dropdown. Expected: a green notice "<name> is now <Role>". After switching into that team, that user sees the new permissions.
- [ ] **4.6 Remove a member.** Trash icon on a member row. Expected: the row disappears and that person's sessions for that team end.
- [ ] **4.7 A team must keep its last admin.** As Dave (only Marketing admin) → change your own role to Viewer.
  - Expected: red notice **"A team must keep at least one admin"**; the role stays Admin.
- [ ] **4.8 Password reset.** As Alice (Finance Admin) → key icon on `new1@acme.test` (Finance only). Expected: a new one-time password dialog, and that user is signed out everywhere.
- [ ] **4.9 Reset escalation guard.** Super Admin adds `dual@acme.test` to Finance (Viewer) **and** Marketing (Admin). Then Alice (Finance Admin) → key icon on dual.
  - Expected: red notice "Dual … also belongs to teams you don't manage, so only a Super Admin can reset their password."
  - The Super Admin *can* reset it.
- [ ] **4.10 A team admin can't add to another team.** (Postman) As Dave, `POST /api/v1/teams/<financeTeamId>/members`. Expected: **403**.

## 5. Roles on dashboards

| # | As | Do | Expected |
|---|---|---|---|
| - [ ] 5.1 | Carol (Viewer) | Open Marketing Overview | Charts visible; **no** "New dashboard", **no** "Edit layout", no rename pencil |
| - [ ] 5.2 | Bob (Editor) | New dashboard (banner button) → "QA board" | Opens the new, empty dashboard; a switcher now appears with both Finance dashboards |
| - [ ] 5.3 | Bob | Edit layout → Add widget (Revenue · line) | Widget appears; green notice "Widget added" |
| - [ ] 5.4 | Bob | In edit mode | **No Delete** button (deleting a whole dashboard is admin-only) |
| - [ ] 5.5 | Alice (Finance Admin) | Open "QA board" → Edit layout | **Delete** button visible; confirming deletes it and returns home showing the remaining dashboard |
| - [ ] 5.6 | Bob (API) | `DELETE /api/v1/dashboards/<id>` | **403 "Insufficient role"** (the database would also refuse) |

## 6. Dashboards and widgets

- [ ] **6.1 Drag and resize.** Bob → a dashboard → **Edit layout** → drag a widget by its ⋮⋮ handle; resize from the bottom-right corner. Expected: the grid reflows; releasing saves (no error notice).
- [ ] **6.2 Layout persists.** Refresh the page. Expected: widgets stay exactly where you left them.
- [ ] **6.3 Edit a widget.** Pencil on a widget → change the metric to Clicks, the type to Bar, and the title. Expected: the widget re-renders as a bar chart of clicks with the new title.
- [ ] **6.4 Remove a widget.** Trash on a widget. Expected: it disappears; notice "Widget removed".
- [ ] **6.5 Rename a dashboard.** Pencil next to the title → Save. Expected: the title updates; "Dashboard renamed".
- [ ] **6.6 Conflict detection (two editors).**
  - Open the same dashboard as Bob in two windows: (Bob in A) and (Alice→Finance in B).
  - Rename it in **A**. Then rename it in **B** without refreshing.
  - Expected: B shows **"Someone else changed this first. Showing the latest version."** and displays A's name. Nothing is silently overwritten.

## 6b. Dashboard home (Prompt 27)

- [ ] **6b.1 One dashboard: shown directly.** As Carol (Marketing has one dashboard), open /dashboards. Expected: banner and team totals, then Marketing Overview's widgets right on the home page, with no extra click and no switcher.
- [ ] **6b.2 Several dashboards: switcher.** As Bob, after creating "QA board" (5.2), open /dashboards. Expected: pill tabs above the board; clicking one shows that dashboard and the URL changes to `/dashboards/<id>`, which is a shareable link.
- [ ] **6b.3 Graph cards are solid black,** not frosted.
- [ ] **6b.4 No sideways scroll.** At any window width, the dashboard page never scrolls horizontally.

## 7. Metrics (page views, clicks, errors, revenue)

- [ ] **7.1 Summary tiles.** /dashboards. Expected: four tiles (Revenue, Page views, Clicks, Errors) with a 24-hour total and a ▲/▼ % vs the previous 24 hours. For Errors, ▼ is shown as good (sage).
- [ ] **7.2 Time ranges.** On a dashboard, click **1H / 24H / 7D**. Expected:
  - 1H shows about 12 points (5-minute buckets).
  - 24H shows about 24 points (hourly).
  - 7D shows about 168 points (hourly).
  - Stat widgets update to the same range.
- [ ] **7.3 Hover tooltip.** Hover a line chart. Expected: a crosshair, a dot and a tooltip with the date/time and value. On bar charts the hovered bar highlights.
- [ ] **7.4 Refresh button.** Click ⟳ next to the range pills. Expected: the data reloads up to "now".
- [ ] **7.5 Request caps.** (Postman) `GET /api/v1/metrics/series?metric=clicks&from=2020-01-01&to=2026-01-01`. Expected: **400** (range over 31 days).

## 8. Isolation: teams never see each other's data (the core Tier 1 requirement)

- [ ] **8.1 UI: another team's dashboard by URL.**
  - Sign in as Dave and open Marketing Overview; copy its URL.
  - In incognito, sign in as **Bob (Finance)** and paste that URL.
  - Expected: **"Dashboard not found, or it belongs to another team."** It's a 404, so the dashboard's existence isn't even confirmed.
- [ ] **8.2 Switcher.** Bob's switcher and board show only Finance dashboards; Carol's only Marketing ones.
- [ ] **8.3 Metrics can't be forced.** (Postman, as Bob) `GET /api/v1/metrics/series?metric=revenue&from=<24h ago>&to=<now>&team_id=<marketingTeamId>`. Expected: 200 with **0 points**. Row-level security filters the rows; the request isn't trusted.
- [ ] **8.4 Mass assignment.** (Postman, as Bob) `POST /api/v1/dashboards` with body `{"name":"x","team_id":"<marketingTeamId>"}`. Expected: **201** but created in **Finance**. A team session always writes to its own team.
- [ ] **8.5 Database-level proof.** Run `psql` as the app role:
  ```
  psql "postgres://aafm_app:<APP_DB_PASSWORD>@localhost:5432/aafm_dashboard" -c "SELECT count(*) FROM dashboards"
  ```
  Expected: **0**. Without a tenant context the database itself returns nothing. Superusers bypass RLS, so `postgres` would see all rows; the app never connects as `postgres`.

## 9. Security checks

- [ ] **9.1 CSRF guard.** (Postman) Send `POST /api/v1/dashboards` **without** `X-Requested-With`. Expected: **403 "Missing X-Requested-With header"**.
- [ ] **9.2 Unknown fields rejected.** (Postman) `POST /api/v1/dashboards` with `{"name":"x","org_id":"..."}`. Expected: **400 "Validation failed"**.
- [ ] **9.3 IP rate limit.** Set `AUTH_RATE_LIMIT=10` again and restart; attempt 11 logins within 15 minutes. Expected: the 11th returns **429 "Too many attempts, try again later"**.
- [ ] **9.4 Security headers.** DevTools → Network → any `/api/v1/...` response.
  - Expected: `Content-Security-Policy`, `Strict-Transport-Security` and `X-Content-Type-Options: nosniff` are present.
  - There is **no** `X-Powered-By`.

## 10. Persistence

- [ ] **10.1 Restart survival.** Create a dashboard and move a widget, stop the backend (Ctrl+C), start it again and refresh. Expected: everything is still there; the data lives in Postgres.
- [ ] **10.2 Sessions are server-side.** After the backend restart you are **still signed in**, because sessions are stored in the database, not in memory.

## 11. Look and responsiveness

- [ ] **11.1 Sign-in background.** `/login` and `/signup` show the animated GhostFibers ribbons; moving the mouse shifts the focus.
- [ ] **11.2 Reduced motion.** With OS "reduce motion" on, the ribbons stop animating.
- [ ] **11.3 Narrow screen.** Below 1024 px the sidebar hides and a top pill bar (Dashboards / Teams & people) appears.

---

## 12. Edit guide and real-time sync (Prompts 32–33)

**Setup:**
- In `backend/.env`, add `CORS_ORIGIN=http://localhost:3000`, then run `npm run migrate` (applies `002_realtime.sql`) and restart the backend.
- In `frontend/.env.local`, add `NEXT_PUBLIC_SOCKET_URL=http://localhost:8000` and restart the frontend.

- [ ] **12.1 Edit guide.** Click **Edit layout**. Expected: a black panel titled "Editing layout" with five icon tips (move, resize, add, edit, remove) and "Changes save automatically · press Done to finish". It disappears on **Done**.
- [ ] **12.2 Live indicator.** Open any dashboard. Expected: a green pulsing dot labelled **Live** in the toolbar. Stop the backend and it becomes **Reconnecting…**; start it again and it returns to **Live** by itself.
- [ ] **12.3 Presence.** Open Finance Overview as Bob (normal window) and as Alice → Finance (incognito). Expected: each window shows the other person's initial next to Live. Hovering shows "Alice Admin · viewing".
- [ ] **12.4 Editing presence.** In Alice's window click **Edit layout**. Expected: in Bob's window, Alice's avatar gets a ring and the hover text reads "· editing".
- [ ] **12.5 Live edits.** In Bob's window drag or resize a widget, add one, edit one, remove one, or rename the dashboard. Expected: Alice's window updates within about a second, without a refresh.
  - A notice names who did what, e.g. "Bob Editor rearranged the layout".
  - The changed widgets glow briefly.
  - Bob's own window shows no echo of his own change.
- [ ] **12.6 Mid-drag safety.** Start dragging a widget in Alice's window and hold it; meanwhile Bob changes something. Expected: Alice's widget isn't yanked away; the update applies when she drops.
- [ ] **12.7 Deleted while viewing.** Alice (admin) deletes the dashboard while Bob is viewing it. Expected: Bob is taken back to the dashboard home.
- [ ] **12.8 Isolation.** Carol (Marketing) never sees Finance presence or changes. The automated test covers that she can't join a Finance room.
- [ ] **12.9 Automated.** `cd backend && npm test` reports 39/39. `test/realtime.test.js` covers: no session refused, foreign origin refused, cross-team join refused, presence for both users, the edit reaching the other viewer and not the author, and the editing flag.

## Known gaps: these are expected, not bugs

1. **New orgs and new teams have no metric data.** Only the seeded Acme Finance and Marketing teams have 7 days of simulated points; live simulation is Tier 2. Charts for a new team show "No data in this range".
2. **A fresh sign-up org has no teams.** The Super Admin must create a team (Teams & people) before creating a dashboard; the team dropdown in "New dashboard" is empty until then.
3. **Session timeouts (30 minutes idle, 8 hours absolute)** are enforced server-side but aren't practical to wait for. To test, edit `IDLE` in `backend/src/constants.js` to `"1 minute"`, restart, wait 61 seconds and refresh → back to `/login`.
4. **Per-IP rate limiting through the Next proxy** treats every user as the same IP in local development. This is logged as problems-log #13 and will be re-tested on EC2 behind Nginx.

Report anything that doesn't match the **Expected** column, with the item number, and I'll log and fix it.
5. **New dashboards and team deletions aren't pushed live** (problems-log #25). A teammate's dashboard switcher picks up a newly created dashboard on reload.
