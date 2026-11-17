# Tier 1 Plan: Backend

Status: **draft for review** (Prompt 6, 2026-11-17 15:44 IST). Nothing here gets built until it's approved.

Tier 1 scope (from the brief): Org → Team hierarchy, Admin/Editor/Viewer roles, dashboards with metrics, persistent data, isolation enforced in the database.
Already built and tested: the schema, row-level security (RLS) policies, the connection pool with `withContext`, the seed, and 12 isolation tests.

---

## 1. Who uses it and how

| Actor | Signs in as | Can do |
|---|---|---|
| **Super Admin** | "Acme Corp: Organization" | See every team. Create, rename and delete teams. Manage every membership. Full dashboard access in all teams. |
| **Team Admin** | "Finance: Admin" | Full access inside their team: create, edit and **delete** dashboards; add, remove and re-role team members (never to super_admin). |
| **Editor** | "Finance: Editor" | Create and edit dashboards and widgets (add, move, resize, remove). Can't delete dashboards or manage members. |
| **Viewer** | "Marketing: Viewer" | Read dashboards and metrics only. |

A user can hold several memberships (for example, Alice is a Finance Admin and a Marketing Viewer). Each session works inside **one** membership at a time and can switch without re-entering the password.

### Login flow (identifier first, Gmail-style, decided in Prompts 3–4)
```
[email] → [password] → POST /auth/login
     ├─ wrong email or password → same 401 "Invalid email or password" (same timing either way)
     └─ ok → session created (no team selected yet) → response lists the user's memberships
              ├─ exactly 1 membership → selected automatically
              └─ several → picker: "Acme Corp (Super Admin)", "Finance (Admin)", "Marketing (Viewer)"
                         → POST /auth/context {membershipId} → session ID rotated, context set
```
Roles appear **only after** the password is verified, so an unauthenticated person learns nothing about an email ([Auth0 on identifier-first enumeration](https://support.auth0.com/center/s/article/immediate-feedback-on-the-identifier-screen-for-non-existent-emails)).

### Daily flow
1. Pick a context, then land on that team's dashboard list (the Super Admin sees all teams, grouped).
2. Open a dashboard: its widgets load, and each widget asks for its metric series over the selected time range.
3. Editors and above add a widget (type + metric), drag and resize it (one bulk layout save), and rename the dashboard.
4. Admins delete dashboards and manage members.
5. Switch context from the header without logging out. Log out from anywhere.

---

## 2. Architecture

Classic **layered monolith**, the traditional starting point: one deployable, clear layers, and nothing distributed until load demands it.

```
HTTP ─► Express app
        ├─ security middleware   helmet · CORS allowlist · body-size limit · rate limit · request id
        ├─ routes /api/v1/...
        │    └─ per route: authenticate → requireRole → validate(schema) → controller
        ├─ controllers           asyncHandler(...) · return ApiResponse · throw ApiError
        ├─ queries (data layer)  plain SQL via pg, always inside withContext()
        └─ error middleware      ApiError / PG error → JSON, no stack traces in production
PostgreSQL ─ RLS policies (second, independent enforcement layer)
```

**Rules:**
- Every controller is wrapped in `asyncHandler`, responds with `ApiResponse`, and fails with `ApiError` (Prompt 6).
- Every tenant query runs inside `withContext()`. `org_id` and `team_id` **always come from the session, never from the request body.**
- Authorization is checked twice: `requireRole` in Express (fast, clear 403s), then RLS in Postgres (can't be bypassed even if a route has a bug).
- Planned layout:
  - `src/routes/`, `src/controllers/`, `src/queries/`
  - `src/middlewares/`: `auth`, `requireRole`, `validate`, `errorHandler`
  - `src/validators/`

---

## 3. Security design (required, not optional)

Mapped to the **OWASP API Security Top 10 (2023)** ([OWASP project](https://owasp.org/projects/api-security-project), [list summary](https://www.isaca.org/resources/news-and-trends/industry-news/2023/reviewing-the-2023-owasp-api-top-10)):

| OWASP risk | Our control |
|---|---|
| API1 Broken Object Level Authorization | RLS on every tenant table. IDs from another team return **404** (we don't confirm they exist). A cross-team test for every endpoint. |
| API2 Broken Authentication | Server-side sessions (below), scrypt password hashes, uniform login failures, throttling and lockout, session rotation |
| API3 Broken Object Property Level Authorization | Strict validation schemas whitelist fields. Unknown fields are rejected. Responses never include `password_hash` or internal columns. |
| API4 Unrestricted Resource Consumption | `express.json({ limit: "100kb" })`, pagination caps, a maximum metric time range and a minimum bucket size, rate limits |
| API5 Broken Function Level Authorization | `requireRole` on every write route, plus RLS role checks in the database |
| API8 Security Misconfiguration | `helmet`, `x-powered-by` off, exact CORS origin with credentials, `trust proxy = 1` (one Nginx in front, never `true`) ([Express security guide](https://expressjs.com/en/advanced/best-practice-security.html)) |
| API6 Unrestricted Access to Sensitive Business Flows | The login rate limit and lockout below |

### Sessions: server-side, not JWT
Following the [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html):
- **Token:** 256-bit random value (CSPRNG). Only its **SHA-256 is stored** in `sessions`, so a database leak doesn't give anyone a live session.
- **Cookie:** `__Host-session` in production (`Secure`, no `Domain`, `Path=/`), plus `HttpOnly` and `SameSite=Strict`.
- **Timeouts, enforced on the server:** 30 minutes idle and 8 hours absolute (OWASP gives 15–30 minutes idle for low-risk apps and 4–8 hours absolute for a working day).
- **Rotation:** the session ID is regenerated on login and on every context switch, since a role switch is a privilege change.
- **Logout** deletes the session row. Clearing the cookie alone wouldn't invalidate a stolen copy.
- **Why not JWT:** a signed token can't be revoked before it expires. Here roles change, contexts switch and admins remove members, and every one of those must take effect immediately. A server-side session gives that with one indexed primary-key lookup. In Tier 2 the same cookie authenticates the WebSocket handshake.

### CSRF
- `SameSite=Strict` cookie, and state-changing routes accept only `application/json`.
- Every write also requires a custom header (`X-Requested-With: fetch`). This is the OWASP option for API-driven sites, and it only works because CORS is locked to one origin ([OWASP CSRF Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)).
- No state change ever happens on `GET`.

### Brute force and credential stuffing
- **Per-IP limit:** about 10 login attempts per 15 minutes, with `express-rate-limit`.
- **Per-account lockout:** after 10 failures, the account is locked for 15 minutes, stored in the database. OWASP says 5–10 attempts is typical, and too low a threshold lets attackers lock out real users ([OWASP WSTG-ATHN-03](https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/04-Authentication_Testing/03-Testing_for_Weak_Lock_Out_Mechanism), [Credential Stuffing Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Credential_Stuffing_Prevention_Cheat_Sheet.html)).
- **Unknown emails** still run a dummy scrypt check, so response time doesn't reveal whether an account exists.

### Database
- The app connects as `aafm_app` (no superuser, no BYPASSRLS). Already built.
- The `sessions` and login lookups happen before any team context exists. The app role gets **no direct table access** to them, only narrow `SECURITY DEFINER` functions (`app.login_lookup`, `app.session_*`, `app.user_memberships`).
- Postgres errors are mapped and never shown raw:
  - `42501` → 403
  - `23505` → 409
  - `23503` / `23514` / `22P02` → 400

---

## 4. Data changes (new migration `002_auth_and_concurrency.sql`)

| Change | Why |
|---|---|
| `sessions(token_hash PK, user_id, membership_id NULL, created_at, last_seen_at, expires_at)` plus an index on `user_id` | Server-side sessions; "log out everywhere" later |
| `users.failed_login_count`, `users.locked_until` | Per-account lockout |
| `version integer` on `dashboards` and `widgets` | Optimistic concurrency. Two editors saving the same widget: the second gets **409 Conflict** instead of silently overwriting. This also prepares Tier 2 real-time editing. |
| `updated_at` maintained by a trigger | Correct in one place |

---

## 5. API (v1)

Every endpoint returns `ApiResponse`, every error is `ApiError`, and every write needs `X-Requested-With`.

**Auth**
| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/api/v1/auth/signup` | public | `{orgName, name, email, password}` creates the org and its Super Admin (§9) |
| POST | `/api/v1/auth/login` | public | `{email, password}`, rate-limited, returns memberships |
| POST | `/api/v1/auth/password` | signed in | `{currentPassword, newPassword}`. Required first when `must_change_password` is set. Revokes the user's other sessions. |
| POST | `/api/v1/users/:id/reset-password` | super_admin, admin | Issues a new one-time password, with the escalation guard (§8) |
| POST | `/api/v1/auth/context` | signed in | `{membershipId}`, rotates the session |
| GET | `/api/v1/auth/me` | signed in | user, active context, all memberships |
| POST | `/api/v1/auth/logout` | signed in | deletes the session |

**Organization and teams**
| Method | Path | Who |
|---|---|---|
| GET | `/api/v1/org` | any role |
| GET | `/api/v1/teams` | any role (RLS: own team, or all teams for the Super Admin) |
| POST / PATCH / DELETE | `/api/v1/teams[/:id]` | super_admin |

**Members**
| Method | Path | Who |
|---|---|---|
| GET | `/api/v1/teams/:teamId/members` | any role in scope |
| POST | `/api/v1/teams/:teamId/members` | super_admin, admin (see question 2) |
| PATCH / DELETE | `/api/v1/memberships/:id` | super_admin, admin. **Guard: a team can't lose its last admin.** |

**Dashboards and widgets**
| Method | Path | Who |
|---|---|---|
| GET | `/api/v1/dashboards` | any role (paginated) |
| POST | `/api/v1/dashboards` | editor+ (the Super Admin passes `teamId`) |
| GET | `/api/v1/dashboards/:id` | any role (includes widgets) |
| PATCH | `/api/v1/dashboards/:id` | editor+ (`version` required) |
| DELETE | `/api/v1/dashboards/:id` | admin+ |
| POST | `/api/v1/dashboards/:id/widgets` | editor+ |
| PATCH / DELETE | `/api/v1/widgets/:id` | editor+ (`version` on PATCH) |
| PUT | `/api/v1/dashboards/:id/layout` | editor+: bulk `{x,y,w,h}` after drag and drop, applied in one transaction |

**Metrics**
| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/metrics/series?metric=&from=&to=&bucket=` | Aggregated with Postgres `date_bin`. Range ≤ 31 days. At most 500 buckets. |
| GET | `/api/v1/metrics/summary?range=24h` | Totals and change vs the previous period for all 4 metrics (stat widgets) |

**Operations**
| Method | Path | Notes |
|---|---|---|
| GET | `/health` | liveness |
| GET | `/ready` | database ping |

---

## 6. Build order (depth first)
1. App shell: `app.js`, `index.js`, security middleware, error handler, health and readiness endpoints, graceful shutdown.
2. Migration 002, then auth (login, context, me, logout, lockout, rate limit), with tests.
3. Dashboards and widgets: CRUD, layout endpoint, optimistic concurrency, with tests.
4. Metrics: series and summary, with tests.
5. Teams and members management, with tests.
6. Security test pass: a cross-team request against every endpoint, viewer writes, CSRF header, uniform login failures, session rotation, and that logout really invalidates the session.

**Tests:** built-in `node:test`, driving the real app over HTTP (`app.listen(0)` + `fetch`), against a real Postgres. No mocks for security paths.
**New dependencies:**
- `express`, `helmet`, `cors`, `express-rate-limit`, `cookie-parser` (all standard Express middleware).
- `zod` for request validation: one schema per route that rejects unknown keys.

---

## 7. Out of Tier 1 (later tiers)
Real-time sync and WebSockets, live metric simulation, KPI formulas, anomaly alerts (Tier 2). Projects, webhooks, audit logs, custom metrics (Tier 3).
The schema and the session cookie are already shaped so these can be added without redesign.

## 8. Decisions (Prompt 7, 15:51 IST)
1. **Organizations:** the Super Admin creates the organization. *How the first Super Admin is created is still open (§9).*
2. **Members join the AWS IAM way:** a Super Admin or Admin creates the user and shares the credentials with them.
3. **Super Admin:** full edit and delete rights in every team, plus oversight of all teams and members. The current RLS already does this.

### Account creation, modelled on AWS IAM
AWS IAM lets the admin choose an **autogenerated password** and tick **"Require password reset at next sign-in"**. It's the same `--password-reset-required` flag in the CLI ([AWS IAM: managing passwords](https://docs.aws.amazon.com/IAM/latest/UserGuide/Using_ManagingLogins.html), [`create-login-profile`](https://docs.aws.amazon.com/cli/latest/reference/iam/create-login-profile.html)). Our version:
- `POST /api/v1/teams/:teamId/members` `{email, name, role}`. The server generates a random 20-character password (CSPRNG). Only the scrypt hash is stored.
- The plaintext password is returned **once** in that response, for the admin to copy, and is never retrievable again.
- `users.must_change_password = true`. Until the user changes it, their session can only call `POST /api/v1/auth/password`. Every other route returns 403 `PASSWORD_CHANGE_REQUIRED`.
- **Admin password reset:** `POST /api/v1/users/:id/reset-password` creates a new one-time password the same way, sets `must_change_password`, and **revokes all of that user's sessions**.
- **Escalation guard (security):** a team admin may reset only users whose memberships are *all* inside their own team. A Super Admin may reset only users whose memberships are all inside their org. Otherwise, the Finance admin could reset Alice's password and sign in as Alice, *Marketing admin*. That's a privilege escalation, so we block it.
- **Migration 002** adds `users.must_change_password boolean NOT NULL DEFAULT false`.

## 9. Bootstrap and existing accounts (Prompt 8)
- **A. Sign-up creates the org (like AWS root sign-up).**
  - `POST /api/v1/auth/signup` `{orgName, name, email, password}` creates the organization, the user, and their `super_admin` membership in one transaction, then signs them in.
  - Rate-limited like login. The password policy is a minimum of 12 characters, maximum 128, with no composition rules, per [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).
  - ~~If the email already has an account, sign-up requires its password~~. Superseded by §10 option A (Prompt 10): a new org always gets a new org-scoped account, so this branch, and the leak it guarded against, no longer exist.
  - The request also takes an org `slug` (lowercase letters, digits and hyphens, 3–40 characters). A taken slug returns 409. That's fine: slugs are public identifiers, like an AWS account alias.
- **B. Existing email when an admin adds a member:** we add the membership only. No new password is issued and nothing about the user's other teams or orgs is revealed.
  - ~~Accepted risk~~ Re-assessed in §10 (Prompt 9): this risk is **not acceptable** as designed.

## 10. Risk assessment: account-existence oracle via "add member" (Prompt 9)

**The flaw.** With global accounts (one user per email across all orgs), "add member" behaves differently depending on whether the email already exists:

| Email | What happens |
|---|---|
| New | Account created, one-time password returned |
| Existing | Membership added, no password returned |

**Why "only authenticated admins can see it" is wrong.** Sign-up is public (§9-A). Anyone can create a throwaway org in seconds, become its Super Admin, and then use "add member" as an **unlimited oracle for any email on the platform**. That makes the oracle effectively unauthenticated. It also defeats the enumeration protection we built into login and sign-up.

**A second problem: no consent.** The attacker's org gets added to the victim's account. The victim then sees "Evil Corp" in their login picker, which is a ready-made phishing lure.

**This has happened before:**
- [Capgo CVE-2026-56327](https://www.vulncheck.com/advisories/capgo-unauthenticated-organization-existence-oracle-via-public-invite-user-to-org-rpc): an invite endpoint returned different responses for different cases (CWE-203, CVSS 5.3). The fix was an identical response.
- [Grafana CVE-2022-39306](https://linux.oracle.com/cve/CVE-2022-39306.html): existing users were added directly to an org while new users got an invite. That's exactly our design.

| | Rating | Reason |
|---|---|---|
| Likelihood | **High** | No skill needed. Fully scriptable after a free sign-up. |
| Impact | **Medium** | Confirms which emails are valid targets for credential stuffing and phishing, plus unwanted org attachment |
| Overall | **High: must fix before building** | |

### Options
| Option | Removes the oracle? | Removes the consent issue? | Cost |
|---|---|---|---|
| **A. Org-scoped accounts (the real AWS IAM model)**: an account belongs to one org, emails are unique *within* an org, and sign-in is org + email + password | **Yes.** An admin can only see their own org's directory. | **Yes.** Nobody can attach another org's user. | A person in two orgs has two accounts, and sign-in gains an org field |
| B. Global accounts + consent invitations: the add-member response never includes a password; everyone gets an invite link to accept | Yes, if responses are identical | Yes | Drops the IAM "share credentials" flow you chose (Prompt 7) |
| C. Keep the design, add rate limits and an audit log | **No.** It only slows the oracle down. | **No** | Lowest effort; the risk stays open |

**Evidence for A.** AWS IAM itself works this way. IAM users belong to one account, and to sign in you *must* give the account ID or alias plus user name and password ([AWS: how IAM users sign in](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_users_sign-in.html), [sign-in URLs](https://docs.aws.amazon.com/signin/latest/userguide/sign-in-urls-defined.html)). Slack's workspace-first sign-in is the same pattern.

**Decision (Prompt 10): A, adopted.**
- Within one org, Prompt 8 ("add the membership only") still holds. An org's admins own that org's user directory, so revealing existence *inside* the org leaks nothing.
- Sign-up also no longer needs the "existing account's password" branch from §9-A. A new org always gets a new account, so sign-up stops leaking too.
- Sign-in becomes **org → email → password → team picker**.
  - The org slug is remembered in the browser after the first sign-in, and later there can be a `/<org-slug>/login` URL, like AWS's alias URL.
  - An unknown org returns the same generic 401 as a wrong password.

**Schema impact (A):**
- `users.org_id NOT NULL` with `UNIQUE (org_id, email)` replaces `UNIQUE (email)`.
- `organizations.slug UNIQUE`.
- The `users` RLS policy simplifies to `org_id = current org`.
