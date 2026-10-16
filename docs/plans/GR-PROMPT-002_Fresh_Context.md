# GR-PROMPT-002 Fresh Context — Printventory production-planning build

Paste or point a new Claude Code session at this file: *"Read docs/plans/GR-PROMPT-002_Fresh_Context.md and start the next step."* Written 2026-10-15; update the **Current state** section at the end of each session.

## What Printventory is

An Electron app (fork of TechJeeper Designs' Printventory, MIT) that links Gremlin Relics' Shopify listings to 3D-print model files and runs order → print → ship. One codebase, three run modes: desktop (`npm start`), server mode (`npm run start:server`, Express + WebSocket bridge, browser UI) and Docker (server mode + headless Chromium). Read `CLAUDE.md` for architecture and commands.

Owner: James. Two people run the print shop; two Bambu Lab P1S printers (one single-colour on an external spool, one with two AMS units — the only colour printer).

## Read first

1. `docs/plans/GR-PLAN-009_Print_Queue_Scheduling.md` — scheduling design **and the combined 008 + 009 build order**. This is the roadmap.
2. `docs/plans/GR-PLAN-008_Plates_Print_Lists_Stock_and_Filament_Costing.md` — plates, print lists, print jobs, stock, filament (deliveries, average cost, reconcile).
3. `docs/plans/GR-PLAN-006_Order_Fulfillment_Workflow_Plan.md` — how the Orders pane, sync, matching and Ship work today (long; skim "Decisions" and the 2026-10-15 decision log).
4. `docs/plans/GR-PLAN-007_...` — why desktop/server drift happens and the guardrails below.

## Current state (2026-10-16)

- `main` at **v2.2.16** (commit `678333f`, tagged), installer built. Work continues on branch **`feature/production-planning`**.
- Built and released in 2.2.16: edge-tab gutter for all panes (`--pane-gutter`), lazy-loaded product-editor photos, desktop notification for new orders, drag-to-reorder order queue (`shopify_orders.queue_position`), background order sync now reaches the window on desktop (`sendToMainWindow` fallback in `global.sendEvent`), order-line combobox alignment.
- Ship / Shopify fulfillment push confirmed working on a real order.
- **A1 — ship-by date: done and committed on `feature/production-planning`** (see GR-PLAN-009 A1 status). Shopify's `fulfillBy` is null on all of James's orders (all are Etsy via QuickSync, which passes no ship date anywhere), so cards show an estimate = order date + N business days (setting `orderProcessingBusinessDays`, default 3, in the Orders pane), flagged via `shopify_orders.ship_by_source`. Also has a manual override (click the Ship-by line; precedence manual > Shopify > estimate; `ship_by_auto*` columns hold the automatic value so Clear override works offline). Not yet checked by James in-app (`npm start` / `start:server`). **Next step: A2** (Production menu + Printers window).
- **Maintenance batch done before A2 (each its own commit on `feature/production-planning`):**
  - `3a7988c` Open File in server mode: new `core/open-file.js`; checks the file exists and reports `shell.openPath`'s returned error (`{success:false,error,path}`); opens on the server PC only for loopback clients (127.0.0.1 / ::1, from the socket address), otherwise the browser offers "Open on server PC" or "Download a copy"; every attempt logged `[OpenFile]`; executable/script types never opened on the host. Desktop `open-path` IPC is unchanged (still returns true regardless).
  - `ddbaca9` Logging: Shopify tokens and `access_token`/`client_secret` redacted (at write time and again on export); `shopify.js` no longer logs token request/response bodies; Help → Open Log Folder (desktop), Download Logs (server mode, `GET /api/support-logs.zip`), Save Logs… replaces the Discord Send Logs. Older raw log files on disk may still hold tokens; exports are re-redacted, "Open Log Folder" shows raw files.
  - `7e3de93` Privacy defaults: `CollectUsage` defaults to 0 for new installs; startup printventory.com version check gated by new setting `checkForUpdatesOnStartup` (default 0); both toggles plus "Check for updates now" in the About dialog (`check-for-updates` IPC takes a `manual` flag). Existing installs keep their stored `CollectUsage`; `checkForUpdatesOnStartup` is absent there until defaults insert it as 0.
  - `67a36d2` `npm run test:printers` / `test:print-events` now run through `scripts/run-electron-node.js` (ELECTRON_RUN_AS_NODE) and pass (8/8 and all print-events). `shopify.test.js` also fails under plain Node (sqlite ABI) and still needs `node scripts/run-electron-node.js shopify.test.js`; it has no npm script.
  - `1353e8b` Committed GR-PLAN-010 (Gremlin Works rebrand plan).
  - New unit tests: `test:open-file`, `test:shopify-token-logging`, `test:privacy-defaults`; `test:support-logs` rewritten.
  - Not yet checked in-app in both `npm start` and `npm run start:server`.

## Build order (summary — details in GR-PLAN-009)

- **A1** Ship-by date: read Shopify fulfillment order `fulfillBy` (and whatever Etsy/QuickSync orders carry) on sync, store on `shopify_orders`, show "Ship by" + due-soon/overdue badge on order cards. Check real orders to see which fields are actually populated before building UI around them.
- **A2** Production menu (desktop menu + server-mode in-page menu) and Printers window: move Orders / Printers / Filament / Parts / Shopify settings out of Tools; add is_active, multicolor_capable, ams_units, optional build plate size to `printers`.
- **B1** Spike: inspect real 3MFs for plates, previews, slice data (time, grams per filament).
- **B2** Plates + variant print lists (replaces one-file-per-variant).
- **B3** Print jobs (queued → started → printed / failed) + order-card plate checklist; brings Mark Printed back.
- **C1/C2** Scheduler core + Print Plan window.
- **D1** Finished-print stock (yield, pull from stock, restock jobs, Stock window, reconcile).
- **E1** Filament window (Record delivery with receipt, weighted average cost/kg, deductions, Reconcile stocktake, reorder list).

## Guardrails (learned the hard way — follow them)

- **Shopify handlers in `main.js` are thin delegates.** Anything between `// Shopify Integration Handlers` and `// End Shopify Integration Handlers` must be `return shopifyX.fn(db, ...)` into `core/shopify-*.js`. Enforced by `tests/server-mode-shopify-core-extraction.spec.js`. Put new logic in `core/`.
- **Every new `preload.js` method needs a `methodToChannel` entry in `server-bridge.js`** (parity test: `tests/server-mode-ipc-surface-parity.spec.js`). New `ipcRenderer.on` channels go in preload's `validChannels`.
- **New logic goes in Electron-free `core/*.js` modules** with tests (GR-PLAN-007 Phase 2). No `require('electron')` in `core/`.
- **Anything user-facing must work in server mode too.** No separate native windows for new UI — use large dialogs (Filament Manager's full-screen toggle pattern). Desktop-only extras (OS notifications) are fine as additions, never as the only path.
- **Line endings: `main.js` and `core/schema.js` are CRLF; most other files are LF.** Preserve whatever a file already uses. Check `git diff --stat` after edits — a whole-file diff means endings were flipped.
- **Schema changes** go in `core/schema.js` using the existing `PRAGMA table_info` + `ALTER TABLE ... ADD COLUMN` migration pattern.
- **Never write Shopify product, variant or inventory data.** Orders are read; only fulfillment is pushed. Shopify inventory stays print-on-demand; Printventory stock is local only.
- **Background work has no IPC event.** Use `global.sendEvent(null, channel, ...)` — it now falls back to the main window on desktop and broadcasts in server mode.
- New files must be covered by `package.json` `build.files` (`npm run test:build-files`).

## Tests to run before committing

```powershell
npx playwright test tests/server-mode-ipc-surface-parity.spec.js tests/server-mode-shopify-core-extraction.spec.js tests/server-mode-schema-completeness.spec.js
npm run test:build-files
npm run test:print-events
npm run test:printers
```

Plus a manual check in both `npm start` and `npm run start:server` for any UI change.

## Working agreements with James

- He tests in-app and reports with screenshots; fix what's reported, don't widen scope silently.
- Keep plan docs current: update the relevant GR-PLAN in `docs/plans/` (status, decisions, what landed) as part of each step, and the **Current state** section of this file at session end.
- Add user-facing changes to `CHANGELOG.md` under `[Unreleased]`.
- Commit per step on `feature/production-planning` with clear messages; James decides when to merge and release (bump version in `package.json` and `package-lock.json`, CHANGELOG section, tag, `npm run build:win`).
