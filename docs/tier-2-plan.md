# Tier 2 Plan: Collaboration

Status: **complete, verified by the user** (Prompt 46, 2026-11-18 02:05 IST: full checklist passed). Drafted in Prompt 37.

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

### A. Foundation: per-team live channel (fixes #25, needed by C, D and E) **(done 18:38, Prompt 38)**
- [x] The socket joins a `team:<id>` room on connect (org room for the Super Admin), next to the dashboard room.
- [x] Broadcast dashboard created / renamed / deleted and team renamed / deleted to the team room; the switcher updates live.
- [x] Tests: a team-room event reaches only that team; the Super Admin gets every team in the org.

### B. Live metrics simulator (brief item 5) **(done 18:38, Prompt 38)**
- [x] Simulator: every 5 s (configurable) insert one point per team per metric, continuing the seeded daily curve with noise.
  - It runs as the owner role, since the app role can't write metrics (Tier 1 rule).
- [x] Publish `metrics:tick` to each team room: team, metric, ts, value.
- [x] Charts and stat tiles stay current; the time window slides. **Built differently:** each tick triggers a refetch of the server-aggregated data, with no flicker and no layout jump, rather than appending points in place. This was simpler and exact, with a ceiling noted in the code (one request per widget every 5 s).
- [x] Rare anomalies for detection to find. **Built as** 3-minute "incidents" (×4) instead of single spikes, because a single 5-second spike disappears inside a 5-minute bucket.
- [x] Data retention (30 days, pruned hourly): keep N days and prune older points (documented ceiling).
- [x] Tests: a tick reaches only its own team; one point per metric per team; a second tick in the same interval is skipped. (RLS reads of the new points are covered by the existing series tests.)

### C. KPI calculations (brief item 3)
- [x] Add the base metric **`users`** (done with B) (active users per bucket) to the enum, seed and simulator. ARPU needs it (Q1).
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

---

## As built: C, D, E (Prompt 41, 2026-11-17 23:43 IST)

The checkboxes above are the original plan. This section records what was actually built, **including where the design changed and why**.

**C. KPIs: done.**
- `GET /metrics/kpi?kpi=arpu|ctr|error_rate&from&to&bucket[&team_id]`. Each bucket is `sum(numerator) / NULLIF(sum(denominator), 0)`, so a zero denominator gives `null` (a gap), never Infinity.
- `GET /metrics/summary` now also returns `kpis` (a ratio of the same totals). The home page has an **ARPU** card next to the five metric cards.
- **Changed from the plan:** there's no separate `kpi` widget *type*. A widget now has a **source**, a metric *or* a KPI (migration `005`, `CHECK ((metric IS NULL) <> (kpi IS NULL))`). That means any KPI can be a line, a bar or a number, and the "Shows" picker lists Metrics and KPIs together. Each seeded dashboard gets an ARPU widget.

**D. Anomaly detection: done.**
- Migration `004`, `app.detect_anomalies()`, run every 30 s by the instance that wrote the tick.
  - The rule: current 5-minute sum vs the previous hour's twelve 5-minute buckets.
  - `z = (current − mean) / max(σ, 10% of mean)`.
  - **Open** an alert at |z| > 2 (both directions, so a drop alerts too). **Resolve** it at |z| < 1.5.
- **Changed from the plan:**
  1. **Trailing 1 hour instead of 24 h.** A 24 h window puts the ±30% daily cycle inside σ, which would fire false alarms at every daily peak.
  2. **Hysteresis instead of "N consecutive points".** A stricter recovery threshold is what Datadog (recovery thresholds), Zabbix (recovery expressions) and Elastic (recovery conditions) use to stop flapping ([Datadog](https://datadoghq.com/blog/introducing-recovery-thresholds), [Zabbix](https://www.zabbix.com/documentation/devel/en/manual/config/triggers/best_practices), [NinjaOne](https://www.ninjaone.com/blog/how-to-tune-overlapping-monitoring-thresholds-in-rmm/)). The 5-minute rolling sum already smooths single blips.
  3. **No per-team rules,** per Prompt 38.
- **Guards:**
  - at least 50 minutes of baseline;
  - the current window must be ≥ 90% covered by live ticks, so there's no alert after a restart gap;
  - the σ floor.
  - At most one open alert per team and metric (unique index).
- `alerts` table under RLS. `GET /alerts?status=open|all`. `alerts:changed` goes to the team channel.
- **UI:**
  - a sidebar **Alerts** bell with the open count and a list;
  - a toast when an alert opens;
  - an **Anomaly** badge and red border on affected widgets;
  - red bands on charts over the alert period (solid while open, faint once resolved).

**E. Hardening and wrap-up: done.**
- Following the OWASP WebSocket Security Cheat Sheet ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)):
  - **sockets close immediately** on sign-out, team switch, password change (other sessions) and admin reset (all sessions);
  - **100 messages per minute** per connection, then disconnect;
  - messages limited to 10 KB;
  - the Origin allowlist, per-action authorization and the 60 s session recheck (already built).
- Postman: a new folder "07 Tier 2" (11 requests). The collection now has **64 requests**; **77/77 assertions** pass against a live server.
- Tests: **58/58** backend.
  - New `test/tier2.test.js` (9): exact ARPU values, divide-by-zero gap, KPI RLS, widget source rules, spike opens one alert and recovery resolves it, no alert without history, alert RLS, logout closes the socket, rate limit.
  - New `test/unit.test.js` (8 pure unit tests).
- Checklist: `docs/tier-2-test-checklist.md`.

**Known ceilings:**
- Charts refetch on every tick.
- Detection scans one hour of points per series every 30 s; add rollups if data grows.
- KPI widgets don't draw alert bands, because alerts are on base metrics.
- Postman can't drive Socket.IO, so real-time is covered by the Node test suites instead.

Suggested order: **A → B → D → C → E**. B produces the live data that D detects on; C is independent and can slot anywhere after A.

---

## Decisions (Prompt 38)

1. **Users metric:** add `users` (active users) as a fifth base metric, fully visible like the others (stat tile, line and bar charts), so the user count can be seen directly. ARPU = revenue / users.
2. **KPI scope:** follow the brief exactly: built-in KPI calculations with ARPU as the headline (plus the two ratios over existing metrics). No formula builder; custom metrics stay in Tier 3.
3. **Anomaly rules:** no sensitivity settings in Tier 2. One fixed default rule per metric (2σ over 24 h, with noise protection) is built in; tuning comes later.
4. **Alerts:** shown inside the dashboard only.

## Questions for the user (answered above)

- **Q1. Users metric.** ARPU needs a "users" count, which doesn't exist yet. Should I add `users` (active users) as a fifth simulated base metric?
- **Q2. KPI scope.** Built-in KPIs only (ARPU, CTR, error rate) for Tier 2, leaving custom formulas to Tier 3, or a small formula builder now?
- **Q3. Anomaly rules.**
  - Should Admins set k, window and metric per team?
  - Or one sensible default rule per metric (2σ over 24 h) to start?
- **Q4. Alert delivery.** In-app only (bell + toast + chart band) for Tier 2? Webhooks for external systems are Tier 3.
