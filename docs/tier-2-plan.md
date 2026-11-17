# Tier 2 Plan: Collaboration

Status: **draft for review** (Prompt 37, 2026-11-17 18:27 IST). Tier 1 is complete and verified by the user.

Brief, page 2, Tier 2:
1. Multiple users edit the same dashboard simultaneously
2. Changes sync in real time
3. KPI calculations (e.g. ARPU = Revenue / Users)
4. Anomaly detection (alert if a metric deviates from normal)
5. Real-time metrics updates

---

## Where each item stands

| # | Brief item | Status | What's left |
|---|---|---|---|
| 1 | Simultaneous editing | **Done** (Prompts 32–33) | Per-widget version checks → 409 on conflicting content edits; positions are last-write-wins; drag-safe deferral |
| 2 | Real-time sync | **Mostly done** | Dashboard edits + presence are live. **Gap #25:** new dashboards and team changes aren't pushed (they need a per-team room). |
| 3 | KPI calculations | **Not started** | No "users" metric exists yet, so ARPU can't be computed (see question Q1) |
| 4 | Anomaly detection | **Not started** | Detection job, alerts table, live alert UI |
| 5 | Real-time metrics | **Not started** | Only 7 days of seeded history; nothing generates new points |

---

## Work list (depth first: one item finished before the next)

### A. Foundation: per-team live channel (fixes #25, needed by C, D and E)
- [ ] The socket joins a `team:<id>` room on connect (org room for the Super Admin), next to the dashboard room.
- [ ] Broadcast dashboard created / renamed / deleted and team renamed / deleted to the team room; the switcher updates live.
- [ ] Tests: a team-room event reaches only that team; the Super Admin gets every team in the org.

### B. Live metrics simulator (brief item 5)
- [ ] Simulator: every 5 s (configurable) insert one point per team per metric, continuing the seeded daily curve with noise.
  - It runs as the owner role, since the app role can't write metrics (Tier 1 rule).
- [ ] Publish `metrics:tick` to each team room: team, metric, ts, value.
- [ ] Charts and stat tiles append points in place: no refetch, no layout jump; the time window slides.
- [ ] Inject a rare spike (for example 1 in 400 points) so anomaly detection has something real to find.
- [ ] Data retention: keep N days and prune older points (documented ceiling).
- [ ] Tests: a tick reaches only its own team; points are written and visible under RLS.

### C. KPI calculations (brief item 3)
- [ ] Add the base metric **`users`** (active users per bucket) to the enum, seed and simulator. ARPU needs it (Q1).
- [ ] Built-in KPIs, each a ratio of two base metrics computed per time bucket on the server:
  - **ARPU** = revenue / users
  - **CTR** = clicks / page_views
  - **Error rate** = errors / page_views
- [ ] Division by zero returns `null` for that bucket, never `Infinity`, and the chart shows a gap.
- [ ] API: `GET /metrics/kpi?kpi=arpu&from&to&bucket`, with the same RLS, range and bucket caps as `/metrics/series`.
- [ ] A new widget type `kpi` (number + sparkline) in Add widget, using the same dark chart style.
- [ ] Tests: exact values on a fixed dataset, divide-by-zero, and cross-team isolation.
- Out of scope: arbitrary user-written formulas. That's Tier 3, "Custom metric definitions" (Q2).

### D. Anomaly detection (brief item 4)
- [ ] Rule (the brief's "alert if metric > 2σ"):
  - Compare each new point to the mean and standard deviation of a trailing window; flag it when |value − mean| > k·σ.
  - Defaults: k = 2, window = 24 h.
- [ ] Noise controls, the reason real monitors don't fire on single blips:
  - a minimum history before alerting;
  - alert only after N consecutive anomalous points;
  - recover only after N normal points.
  - Datadog's anomaly monitors use bounds measured in "deviations" plus trigger and recovery windows, and recommend that the recovery window equal the trigger window ([Datadog anomaly monitors](https://docs.datadoghq.com/monitors/types/anomaly/)). Seasonality-aware detection is a documented ceiling (Datadog needs at least 3 days of history for daily seasonality).
- [ ] `alerts` table, team-scoped and under RLS: metric, value, mean, σ, z-score, status (open / resolved), opened and resolved times.
- [ ] Rules per team, editable by Admins: metric, k, window, enabled (Q3).
- [ ] Detection runs in the simulator tick, so it's checked once per new point and is cheap.
- [ ] Push `alert:opened` / `alert:resolved` to the team room.
  - UI: a bell with a count in the sidebar, an alerts panel, a red band on the affected chart, and a toast.
- [ ] Tests:
  - a synthetic spike opens exactly one alert, and recovery resolves it;
  - no alert fires before the minimum history;
  - another team never sees it.

### E. Hardening and wrap-up
- [ ] Real-time security pass: OWASP WebSocket Security Cheat Sheet citations (research was blocked on Prompt 32) and per-socket event rate limiting.
- [ ] Postman collection: KPI and alert endpoints.
- [ ] Tier 2 test checklist (like Tier 1's), then the user's review.

Suggested order: **A → B → D → C → E**. B produces the live data that D detects on; C is independent and can slot anywhere after A.

---

## Questions for the user

- **Q1. Users metric.** ARPU needs a "users" count, which doesn't exist yet. Should I add `users` (active users) as a fifth simulated base metric?
- **Q2. KPI scope.** Built-in KPIs only (ARPU, CTR, error rate) for Tier 2, leaving custom formulas to Tier 3, or a small formula builder now?
- **Q3. Anomaly rules.**
  - Should Admins set k, window and metric per team?
  - Or one sensible default rule per metric (2σ over 24 h) to start?
- **Q4. Alert delivery.** In-app only (bell + toast + chart band) for Tier 2? Webhooks for external systems are Tier 3.
