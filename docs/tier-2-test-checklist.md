# Tier 2: Test Checklist

Written for Prompt 41 (2026-11-17 23:45 IST) and updated for Prompt 45 (2026-11-18 01:45 IST) with the fixes from Prompts 42–44 (problems-log #30–33). Each item says **how** to test it and what to **expect**.

Tier 2 scope (brief, page 2):
1. Several users edit the same dashboard at once
2. Changes sync in real time
3. KPI calculations (ARPU = Revenue / Users)
4. Anomaly detection
5. Real-time metric updates

---

## 0. Setup

| Step | Action | Expected |
|---|---|---|
| 0.1 | `cd backend && npm run migrate` | Applies `003_live_metrics`, `004_anomalies` and `005_kpi_widgets`, or prints nothing if they're already applied |
| 0.2 | `npm run seed` | `seeded … metric points`. Each dashboard now has **Active users** and **ARPU** widgets. |
| 0.3 | `backend/.env` has `CORS_ORIGIN=http://localhost:3000`; `frontend/.env.local` has `NEXT_PUBLIC_SOCKET_URL=http://localhost:8000` | Needed for anything live |
| 0.4 | Restart `npm run dev` in both apps | The backend logs `API listening on :8000` and starts the simulator (one tick every 5 s) |
| 0.5 | Let the backend run **5 minutes** before section 6. Corrected in Prompt 44 (it said 1 hour). | Detection compares the live last 5 minutes with the previous hour. Right after `npm run seed` that hour is already covered by seeded history. Only if the backend was **stopped** for over ~10 minutes in the last hour does it need up to an hour to refill. |

---

## 1. Automated checks (run first)

- [ ] **1.1** `cd backend && npm run seed && npm test`. Expected: **58 passed, 0 failed**. The four suites: API, isolation, real-time, Tier 2 plus unit tests.
- [ ] **1.2** Postman: import `backend/aafm-dashboard.postman_collection.json` (now **"Tiers 1 + 2"**, 64 requests) and run it in order. Set `AUTH_RATE_LIMIT=100` first. Expected: all green, including folder **07 Tier 2**.
- [ ] **1.3** `cd frontend && npm run typecheck && npm run lint && npm run build`. Expected: no errors.

## 2. Simultaneous editing (brief item 1)

- [ ] **2.1** Open the same dashboard as Bob (normal window) and as Alice → Finance (incognito). Both click **Edit layout** and move different widgets. Expected: both changes stay, and each window shows the other's move within about a second.
- [ ] **2.2** Both edit the **same** widget's title via the pencil: save in Bob's window first, then in Alice's. Expected: Alice sees *"Someone else changed this first. Showing the latest version."* Bob's title isn't silently overwritten.
- [ ] **2.3** Alice starts dragging and holds the mouse while Bob changes something. Expected: Alice's widget isn't yanked away; Bob's change appears when she drops.

## 3. Real-time sync (brief item 2)

- [ ] **3.1 Live edits and presence.**
  - Expected: the toolbar dot reads **Live**, and each window shows the other person's avatar (ringed while they edit).
  - Edits show a notice naming who did what (e.g. "Bob Editor added a widget"), and the changed widget glows.
- [ ] **3.2 List changes are live (fixes #25).**
  - Bob creates a dashboard (banner → New dashboard). Expected: Alice's window shows a new tab in the switcher **without a refresh**.
  - Rename or delete it. Expected: the tab updates or disappears live.
- [ ] **3.3 Team changes are live.** As Super Admin in one window and an Admin in another, create or rename a team. Expected: Teams & people updates in both windows without a refresh.
- [ ] **3.4 Sign-out closes the live connection immediately (OWASP).**
  - Sign out in one tab while another tab of the same session shows a dashboard.
  - Expected: the other tab's indicator leaves **Live** straight away (it shows **Offline**), not after a minute.
- [ ] **3.5 Reconnects after a session change (fix #32).**
  - Open a dashboard in two tabs of the same browser. In tab B, switch team (or switch back).
  - Expected: tab A's indicator returns to **Live** within about 1 second. It never sticks on "Reconnecting…".
- [ ] **3.6 Stale dashboard links (fix #31).**
  - Open a dashboard, copy its URL, delete that dashboard (or reseed), then open the copied URL.
  - Expected: the first available dashboard is shown, with a note: "That dashboard no longer exists. Showing … instead." There's no dead-end error.

## 4. Live metrics and Active users (brief item 5)

- [ ] **4.1** Open any dashboard on **1H**. Expected: the charts move forward about every 5 seconds with no flicker, and the number widgets update.
- [ ] **4.2** The home page has six cards: **Revenue, Page views, Clicks, Errors, Active users, ARPU**. Expected: at most 3 per row (3x2 on desktop, fix #30); nothing wraps or squeezes; the values change live; Active users shows a user count.
- [ ] **4.3** Add a widget → "Shows" → **Active users** as a line chart. Expected: a live chart of the user count.
- [ ] **4.4** Isolation: as Carol (Marketing), only Marketing's numbers move. Expected: Finance ticks never change Marketing's widgets. The automated test covers this.

## 5. KPI calculations (brief item 3)

- [ ] **5.1 ARPU widget.** The seeded **ARPU** number widget on each team dashboard shows that team's dollars per user (e.g. Finance $4.19, Marketing $4.16).
  - Expected: it equals that team's Revenue ÷ Active users for the same period.
  - The home-page ARPU card for the Super Admin is **org-wide**: total revenue ÷ total users (e.g. $4.17). It always lies between the team values, closer to the team with more users. It is *not* the average of the team ARPUs (Prompt 44).
- [ ] **5.2 KPI charts.**
  - Edit layout → Add widget → "Shows" lists **Metrics** and **KPIs**, with the formula shown under the picker.
  - Pick **ARPU** as a line chart. Expected: a chart in dollars per user.
  - Then **Click-through rate** or **Error rate** as a line chart. Expected: values in percent.
- [ ] **5.3 Switching source.** Edit a KPI widget and change "Shows" to a metric (or back). Expected: it switches cleanly; the API stores exactly one source.
- [ ] **5.4 Gaps, not wrong numbers.** In Postman, folder 07 shows KPI points; buckets without users return `null`. Expected: charts draw a gap there, and the tooltip says *"No value (nothing to divide by)"*. Automated: `tier2.test.js` checks the exact ARPU of 6 and the `null` gap.

## 6. Anomaly alerts (brief item 4)

**The rule:**
- The last 5 minutes are compared with the previous hour.
- An alert **opens** at more than 2σ, above or below.
- It **resolves** once the metric is back under 1.5σ.

The checks run every 30 s. Natural spikes happen at random (several per hour across all teams).

**To trigger one now** (after setup step 0.5, as the DB owner). Have Bob (Finance) on the **Finance Overview** dashboard first:

```
psql "<MIGRATION_DATABASE_URL from backend/.env>" -c "INSERT INTO metric_incidents (project_id, metric, until) SELECT p.id, 'errors', now() + interval '6 minutes' FROM projects p JOIN teams t ON t.id = p.team_id WHERE t.name = 'Finance' AND p.name = 'Web App' ON CONFLICT (project_id, metric) DO UPDATE SET until = excluded.until"
```

This multiplies the errors of Finance's **Web App** project by 4 for 6 minutes. (Since Tier 3, incidents and alerts are per project; open the **Web App Overview** dashboard to watch it.)

- [ ] **6.1 Opens.** Have Carol (Marketing) open in an incognito window too. Within about 1–2 minutes, Bob's window shows:
  - a **toast**: "Anomaly detected · Errors 3.xσ above normal";
  - the sidebar **Alerts** bell with **1**;
  - the **Errors** widget with a red border and an **Anomaly** badge;
  - line or bar charts of Errors with a **red band** starting at the alert time.
- [ ] **6.2 Panel.** Click **Alerts** in the sidebar. Expected: "Errors 3.xσ above normal · open · n min ago".
- [ ] **6.3 Resolves.** About 5–10 minutes after the incident ends, the alert resolves. Expected:
  - the badge and border disappear;
  - the bell count drops;
  - the panel says "resolved";
  - the band on the chart fades but stays as history.
- [ ] **6.4 Isolation.** Carol (Marketing) sees no Finance alert, while the Super Admin sees it, labelled with the team. Automated: `tier2.test.js`.
- [ ] **6.5 No false alarm after a restart.** Restart the backend. Expected: no "below normal" alerts appear while the live window refills. The coverage guard (problems-log #27) prevents them.

## 7. Security (Tier 2 additions)

- [ ] **7.1** `GET /alerts` and `GET /metrics/kpi` for another team's `team_id`. Expected: empty results (RLS). Automated.
- [ ] **7.2** A socket sending more than 100 messages a minute is disconnected (OWASP). Automated: `tier2.test.js`.
- [ ] **7.3** The app role still can't write metrics. Expected: only `app.simulate_tick()` can (Tier 1 isolation test "the app role cannot write metric data" still passes).

---

## Known limits (expected, not bugs; problems-log #29)

1. Charts refetch on every 5-second tick (one request per widget); fine at this size.
2. KPI widgets don't draw alert bands, because alerts fire on base metrics.
3. Alert sensitivity isn't configurable in Tier 2 (Prompt 38).
4. Postman can't drive Socket.IO, so the real-time paths are covered by `backend/test/realtime.test.js` and `tier2.test.js`.
