# New features: test checklist (Prompts 68–69)

Setup:
- Apply migrations 014–018: `cd backend && npm run migrate`.
- Restart `npm run dev` in both `backend/` and `frontend/`.
- Seed users (org `acme`, password `Password@123`):
  - `super@`: Super Admin
  - `alice@`: Finance admin + Marketing viewer
  - `bob@`: Finance editor
  - `carol@`: Marketing viewer
  - `dave@`: Marketing admin
- Use two browsers (or one private window) to watch both sides live.

## 0. Automated

- [ ] **0.1** `npm test` in `backend/`. Expected: **140 / 140**.
- [ ] **0.2** Postman: import `backend/aafm-dashboard.postman_collection.json` (132 requests) and run it in order with `AUTH_RATE_LIMIT=100`. Expected: all green, including the new folder **10 Features**. This folder hasn't been run yet; I couldn't run newman here.

## 1. Alerts wording (Prompt 68)

- [ ] **1.1** Alert badges and toasts show a warning symbol and plain words, e.g. "Errors unusually high · 3.1× usual". No σ.
- [ ] **1.2** On a chart with an alert, the red band carries an "⚠ Alert" label, and hovering it explains it.

## 2. Notifications (F3+F4)

- [ ] **2.1** As Alice (Finance admin), add Carol to Finance. In Carol's window, the bell shows **1** live, and the item reads "You were added to Finance as …".
- [ ] **2.2** Change Carol's role, then remove her. Each change gives Carol a new notification.
- [ ] **2.3** Reset Carol's password as an admin. She gets a notification, and after she changes it, another one.
- [ ] **2.4** Open the bell: the items are marked read and the badge clears.

## 3. Audit search (F6)

- [ ] **3.1** As Alice, Audit log: type `dashboard`. The list filters as you type.
- [ ] **3.2** Result = **Issues only**: only denied or failed entries. Sort = **Issues first**.
- [ ] **3.3** From/To dates, the action and team filters, and Clear.
- [ ] **3.4** Go to page 2 while the app keeps writing entries. No row repeats from page 1.

## 4. Webhooks for non-developers (F5)

- [ ] **4.1** Webhooks → Add: pick **Slack**. The steps and the "How do I get this link?" link change per app.
- [ ] **4.2** Paste `https://example.com/x`. Expected: "This doesn't look like a Slack webhook link…".
- [ ] **4.3** With a real Slack, Teams or Discord channel link (optional), connect it and press **send** (paper plane). Expected: "✅ Test message from AAFM Analytics…" appears in the channel. For Teams it arrives as a card with an "Open AAFM" button.
- [ ] **4.4** A chat endpoint shows no signing secret. **Developer endpoint** still shows the secret once.
- [ ] **4.5** Event names are in everyday words ("Something unusual happens (an alert)").

## 5. Shared data (F7)

- [ ] **5.1** As Carol, open **Shared data** → Ask for access: Finance, ARPU, reason, 7 days. Expected: "Request sent".
- [ ] **5.2** As Alice (Finance context): the bell shows the request. Shared data → Requests to review → **Approve** (pick a duration, add a note).
- [ ] **5.3** As Carol: a notification, then under **Shared with me** the ARPU of Finance (value + 24 h chart), "Read-only · until …".
- [ ] **5.4** As Carol, nothing else of Finance is visible: no Finance dashboards, and no Finance revenue anywhere.
- [ ] **5.5** As Alice, **End access now**. Carol's card disappears and she is notified.
- [ ] **5.6** Decline a second request with a note. Carol sees the note.
- [ ] **5.7** As Bob (editor, not admin), there is no review section.

## 6. Reusing metrics (F2)

- [ ] **6.1** Custom metrics → New: click **Revenue**, type `/`, click **Active users**. The formula reads `revenue / users`, and the preview draws.
- [ ] **6.2** Click a KPI chip. It inserts `(revenue / users)` at the cursor.
- [ ] **6.3** After saving one metric, its name appears under **Saved**, and clicking it inserts `(its formula)`.

## 7. Completed projects (F1)

- [ ] **7.1** As Alice, Projects: create "Q4 launch", add a dashboard to it, then press **✓ Mark as completed** and confirm.
- [ ] **7.2** The card shows "Completed <date>". Rename and delete are hidden.
- [ ] **7.3** Open its dashboard. A banner says it's completed and read-only. There's no Edit layout or rename, and the charts stop moving (no live data).
- [ ] **7.4** **Reopen** (↺). Editing comes back, and live data resumes from now.

## 8. Light mode (Prompt 70)

- [ ] **8.1** The sidebar (bottom) has a three-way switch: Match system / Light / Dark. On a phone it sits in the top bar.
- [ ] **8.2** Light: every page is readable. Check cards, tables, badges, modals, the alerts and notifications lists, toasts, charts (grid lines, hover line, alert bands) and the dashboard grid while editing.
- [ ] **8.3** Dark looks exactly as before.
- [ ] **8.4** Reload. The choice is kept, with no dark flash before light.
- [ ] **8.5** With Match system, switch the OS theme. The app follows without a reload.
- [ ] **8.6** By design, the sign-in screens and the dashboards hero banner stay dark in light mode (their art is dark). Say if you want light versions.

## 9. UI polish (Prompt 71)

- [ ] **9.1** Expand both Alerts and Notifications in the sidebar. The middle scrolls, and the theme switch and your account stay visible at the bottom. Try a short window too.
- [ ] **9.2** Overview cards (below the banner): big figure, an arrow and % vs the previous 24 h, a coloured change line ("−$117.0K vs previous 24h"), and a 24 h sparkline in a band along the bottom that fades in from the left. It never crosses the text, and the end dot is fully visible (Prompt 72).
- [ ] **9.3** Tint: green when the change is good, red when it's bad. For **Errors**, a rise is red (as everywhere else in the app). Check in light and dark.
- [ ] **9.4** The cards refresh about every 30 s with live data, and follow the selected project.
- [ ] **9.5** Dashboards are folder tabs above the board. The selected tab merges into the board's panel with no line between them. Others are flat until hovered.
- [ ] **9.6** The **+** after the tabs creates a dashboard (editors and up). A single dashboard still shows as one tab. Switching tabs changes the URL (shareable link).
- [ ] **9.7** No sideways scrolling (Prompt 72): with several dashboards, the tabs share the row and long names truncate (full name on hover). Narrow the window: tabs that no longer fit move into a **More (n)** menu, and the selected one always stays visible as a tab.
