# Next features plan (Prompt 68)

Status: **decided** (Prompt 69). Build order: F3+F4 → F6 → F5 → F7 (+ F2, F1), each finished and tested before the next. Time check: 22:2x IST on 18 Nov, deadline **14:22 IST on 19 Nov (~16 h)**, with UI polish still to do.

## 1. Done in Prompt 68

- **Alerts in plain words, with a symbol instead of σ:**
  - the text reads ⚠ *"Errors unusually high · 3.1× usual"* (or *"… unusually low · 40% of usual"*);
  - it's shared by the sidebar panel, the pop-up notification ("New alert"), the widget badge ("⚠ Alert") and the charts;
  - the rule itself is unchanged (2σ against the last hour).
- **Chart alert bands explain themselves:**
  - a **⚠ Alert** flag at the top of each band;
  - hovering the band shows *"Alert: Errors unusually high · 3.1× usual, 13:05–13:20 (resolved)"*;
  - the chart tooltip names the alert for any point inside it.
- **README:** professional root `README.md` with the banner.

## 2. The requested features: how I read them, and the design

| # | Request | Proposed design | Effort |
|---|---|---|---|
| F1 | **"project completion feature forever"** | Unclear; see question Q1 | ? |
| F2 | **Reuse existing metrics when creating a new one** | The custom-metric editor shows the five base metrics, the three KPIs and the team's existing custom metrics as clickable chips. A chip inserts the name or, for a KPI or custom metric, its formula in parentheses (e.g. `(revenue / users)`), so earlier definitions are reused without nested references that could form cycles. | ~1 h |
| F3 | **Notify people when their role, password or team changes** | An in-app **notification centre**: a bell in the sidebar, a per-user `notifications` table under RLS, pushed live through the existing per-user socket room. Triggers: role changed, removed from a team, password reset by an admin. Read / unread state. | ~3 h (F3 + F4) |
| F4 | **"You've been added to a new team"** | The same centre, plus a team-switch link in the notification | (in F3) |
| F5 | **Webhooks for non-IT people** | **Destination presets**: Slack, Discord, Microsoft Teams or "Other (developer)". For Slack, Discord and Teams the message is sent in their own format (Slack `{text}`, Discord `{content}`, Teams Adaptive Card), with a plain sentence like *"⚠ Finance · Web App: Errors unusually high (3.1× usual)"*. The form uses plain wording ("When should we notify you?"), picks events by everyday names, and has a "Send a test message" button. Developer endpoints keep the signed Standard Webhooks format. Sources: [Slack/Discord/Teams formats](https://webhookrelay.com/webhook-message-formatter/), [Discord webhooks](https://docs.discord.com/developers/resources/webhook). | ~3 h |
| F6 | **Audit log search, pagination and more filters** | Free-text **search** (actor, action, details); filters for **issues only** (denied + failed), person, team, date range and category; **sort** by newest, oldest or issues first; page numbers with a page size, and a total count. Works over live and archived entries. | ~3 h |
| F7 | **Request permission to see data / a ticket system** (e.g. "I want to see ARPU of Finance only") | Modelled on Google Drive's **request access** ([Google](https://workspaceupdates.googleblog.com/2023/06/respond-to-access-requests-for-google-workspace-files-efficiently.html), [Drive API access proposals](https://developers.google.com/workspace/drive/api/guides/pending-access)):<br>• a user asks for one **metric or KPI of another team** with a reason;<br>• that team's Admins get a notification and a **Requests** inbox;<br>• Approve (with an expiry) or Decline, and the requester is notified.<br>An approved grant shows **only that metric's figures** in a read-only "Shared with me" view. RLS gets a narrow policy for granted (team, metric) pairs; nothing else from the team becomes visible. See question Q2. | ~5–6 h |

**Total:** about 15 h plus F1, which doesn't fit before the deadline together with the UI polish. Question Q3 sets the priority.

## 3. Questions

- **Q1. What does "project completion feature forever" mean?**
- **Q2. How much should an approved data request show?**
- **Q3. Which features first, given ~16 h?**

## 4. Decisions (Prompt 69)

1. **F1:** **mark a project Completed.** It's frozen and read-only: live data stops, and its history and dashboards are kept forever under "Completed". An Admin can reopen it.
2. **F7:** an approved request shows **only that metric or KPI, read-only**, until the grant expires.
3. **Order:** F3+F4 notifications → F6 audit search & filters → F5 simple webhooks → F7 data access requests (then F2 metric reuse, F1 completion).

## 5. As built (2026-11-18)

| Feature | Backend | Frontend | Tests |
|---|---|---|---|
| **F3+F4 notifications** | Migration 014 (`notifications`, own rows only via RLS, `app.notify`); sent on: added to a team, removed, role changed, team deleted, password reset/changed, access requested/approved/declined; live `notifications:new` to the user's room | Bell with unread badge in the shell, list, mark read | `features.test.js` (6) |
| **F6 audit search** | Migration 015 `app.audit_search`: live + archive, text search, actor/action/team/result filters (incl. "issues only"), date range, sort newest/oldest/issues, `page`/`size`, and an `as_of` snapshot so paging doesn't drift while new entries arrive | Search box, filters, Clear, total, numbered pages, page size | `features.test.js` (3), `hardening.test.js` |
| **F5 simple webhooks** | Migration 016 `webhooks.format` (`standard`/`slack`/`discord`/`teams`); chat apps get one readable sentence in their own format (Slack `text`, Discord `content`, Teams Workflows Adaptive Card) with a link back; a wrong host for the chosen app is refused with a plain reason; audit keeps only the host (a chat link is a credential) | "Where should we send updates?" (Slack, Microsoft Teams, Discord, Developer endpoint), per-app steps and help link, everyday event names; the signing secret is shown only for developer endpoints | `unit.test.js` (3), `features.test.js` (2, incl. a Teams card received by a local receiver) |
| **F7 shared data** | Migration 017 `access_requests`; request → only that team's Admins see it and are notified (Prompt 78; a team with no Admin can't take requests) → approve for 1/7/30/90 days (or decline, with a note) → read **only that figure** through `app.shared_series`/`app.shared_summary`, which check the grant on every call. Not an RLS grant: a KPI's raw inputs stay hidden. Revoke any time; expiry is checked on read | "Shared data" page: requests to review, shared with me (value + 24 h chart), my requests | `features.test.js` (5) |
| **F2 metric reuse** | — (formulas already accept base metrics) | Chips in the custom-metric editor insert at the cursor: base metrics, KPIs as their expression, the team's saved metrics as `(formula)` | Parser accepts the chip-built formulas |
| **F1 completed projects** | Migration 018: `completed_at`; a DB trigger makes its dashboards/widgets read-only (cascade deletes still allowed); open alerts close; the simulator skips it; retention spares its history; rename/delete refused until reopened; `POST /projects/:id/complete` and `/reopen` (Admins) | Complete/Reopen on Projects, "Completed" badge, read-only board with a banner | `features.test.js` (4) |

**Known ceilings**
- F2 inlines a saved metric's formula, so a later edit to it doesn't flow into metrics built from it. Add references between metrics if that matters.
- F1 keeps history from the moment of completion; points already older than 30 days were deleted by retention before.
- F1 closes open alerts without an `alert.resolved` webhook (it isn't "back to normal"); a chat channel sees the opening only.
- F7 grants are per figure and per team; no org-wide "share everything" grant, by design.
