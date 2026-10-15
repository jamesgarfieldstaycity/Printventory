# GR-PLAN-007 Printventory Codebase Review: Desktop/Server Drift, Optimisation, and Installation-as-a-Service Plan

Status: Review completed 2026-10-06 against the live repo at `C:\Users\JamesGarfield\source\repos\Printventory` (HEAD `bd27057`, v2.2.15). Not yet actioned at time of writing — this is the findings + plan document; treat it as the opening brief for the next build session, same role GR-PROMPT-001 played for GR-PLAN-004.

**Update note (carried over, not in the original doc): Phase 1 and Phase 2 below are now both DONE** (Phase 1: broadcastEvent fix, IPC parity test, build-files completeness check — all landed; Phase 2: the Shopify IPC-handler layer fully extracted into core/shopify-catalog.js, core/shopify-orders.js, core/shopify-reconciliation.js, independently code-reviewed). A follow-on library-folder cascade-delete fix has also landed since. This doc's own body below was never updated to reflect that — it still reads as the original, pre-work findings/plan. Treat the body as historical context for *why* the work was done, not as a live status report.

## What this covers

James asked for two things in the same conversation: (1) a review of the codebase for optimisations, specifically called out against recurring desktop/server "drift" issues, and (2) a later plan for installing Printventory as an application and/or a service. This doc addresses both, because they turn out to share the same root cause and the same fix.

## How Printventory is built today

Printventory is one Electron codebase with three run modes selected by how it's launched, not three separate programs:

- **Desktop app** — `npm start` / the installed `.exe`/`.dmg`/AppImage. Electron `BrowserWindow`, native dialogs, IPC via `preload.js`'s context bridge.
- **Server mode** — `npm start:server` / `--server` flag. Electron still runs (see "Server mode is still full Electron" below), but headless: an Express HTTP server + a WebSocket bridge stand in for the renderer↔main IPC channel, so a browser on the LAN talks to the same `renderer.js` UI over WebSocket instead of over Electron's context bridge.
- **Docker** — packages server mode into a container, running Electron headless under Xvfb (virtual framebuffer) so Chromium-based WebGL thumbnail rendering still works without a real display.

All three run the *same* `main.js` (17,183 lines) and `renderer.js` (29,281 lines), branching internally on an `isServerMode` flag (70+ `if (isServerMode)` branches in `main.js` alone) rather than being separate entry points over a shared core. `core/schema.js` (481 lines) is the one piece extracted so far into an Electron-free module, explicitly framed in its own header comment as "first increment" of a longer extraction effort.

## Root causes of desktop/server drift (ranked by how often they've actually caused a shipped bug)

This isn't a guess — it's read off the git history (`git log --oneline`, last ~60 commits) and the code's own comments, which are unusually candid about what broke and why.

### 1. Manually-maintained parity lists that have no test enforcing them

Three separate places must each be updated whenever a new feature is added, and nothing fails the build if one is missed:

- **`ipcHandlerRegistry`** (main.js, Map of channel→handler) — fixed well: `ipcMain.handle` is monkey-patched at module load (main.js:494) so every `ipcMain.handle()` call auto-registers. The comment at main.js:491 says exactly why: *"Without this, Docker/server-mode falls back to executeJavaScript on the hidden window for unregistered channels (e.g. getThumbnail) — which hangs/times out."* This was clearly a real, painful bug before the monkey-patch fix, and the fix is a good one — it closes an entire class of "works on desktop, hangs on server" bugs for good, automatically, with no per-feature step.
- **`methodToChannel`** (server-bridge.js:491, ~194 entries) — **not fixed the same way.** This is a hand-written map from `window.electron.<methodName>` (as renderer.js calls it) to the IPC channel string, used only by the server-mode WebSocket bridge. The code's own comment at server-bridge.js:525 admits it: *"Shopify settings, catalogue, orders & variant mapping methods added to preload.js after the original methodToChannel list was written. Without these entries here, window.electron.<method> is simply undefined in server mode even though it exists in preload.js."* Commit `fcde05d` ("Fix server-mode Shopify bridge: add missing methodToChannel entries") is this exact bug landing in production. This is the single biggest structural source of "works on desktop, missing on server" — every new `window.electron.xxx` method needs a second, separate, unenforced registration.
- **`package.json`'s `build.files` array** (~90 hand-listed filenames) — the same pattern applied to packaging instead of runtime. Commit `6e09a2c` ("Fix packaged build missing shopify.js, pane-controller.js, filters-pane.js, orders-pane.js, toolbar-sync.js") is five files missed from this list in one go. This bug class is worse than the others because it only shows up in a *packaged* build, which is the one environment you're least likely to be actively testing while developing a feature.

### 2. Cross-cutting globals with inconsistent lifecycle

`main.js` defines exactly two `global.*` assignments: `global.broadcastEvent` and `global.sendEvent`, both set up in `startHttpServer()` and torn down in `stopHttpServer()`. They exist specifically to let IPC handler code notify the UI "works in both normal and server mode" (the comment's own words, main.js:1591) without every handler needing its own isServerMode branch — a reasonable idea. But the teardown path (main.js:1738 and :1757, both the graceful-close and the force-close-after-timeout branches) resets them asymmetrically:

```js
global.broadcastEvent = null;                 // <- still a bare null
global.sendEvent = function () {};             // <- safe no-op
```

`global.sendEvent` was *just* given a safe no-op default (your HEAD commit, `bd27057`, today) after the exact failure mode of calling it while `null`/not-yet-initialized turned a successful Shopify order sync into an apparent failure (`TypeError: global.sendEvent is not a function`). **`global.broadcastEvent` still has the identical bug** — any code that calls `global.broadcastEvent(...)` directly during the window between a server stop/restart (e.g. via the Tools menu's "Restart Server") and the next `startHttpServer()` completing will throw the same way `sendEvent` did until an hour ago. Most call sites guard it (`if (isServerMode && global.broadcastEvent)`), but that guard has to be remembered at every call site — the same "manually maintained, nothing enforces it" pattern as #1, just smaller in scope. This is a one-line fix (give `broadcastEvent` the same no-op default `sendEvent` just got) and is worth doing immediately, before the next thing that calls it directly gets written.

### 3. Native-only UI primitives silently behave differently rather than failing loudly

`window.electron.showMessage()` / `showMessageBox()` are real native OS dialogs on desktop, but in server mode `server-bridge.js` overrides them client-side with an in-page `<dialog>` element. Both "work," but a renderer code path that assumes a *particular* dialog behaviour (modality, z-order, who it blocks) can look fine on desktop and subtly wrong in a browser tab. The investigation behind `tests/server-mode-dialog-no-hang.spec.js` (2026-10-05) is a good example of the cost of this: what looked like "scan silently stops with no visible error" in server mode turned out to be a `renderer.js` catch block that never called `showMessage()` at all (a plain app bug, not a dialog-mechanism bug) — but diagnosing that required first ruling out the dialog shim itself, because the two code paths are different enough that either one looking broken is plausible. Any future work that touches dialogs, `shell.openPath`, native menus, or drag-and-drop should assume "looks fine on desktop" tells you nothing about server mode, and vice versa.

### 4. File size makes the above easier to introduce and harder to catch in review

`main.js` is 17,183 lines / 651KB; `renderer.js` is 29,281 lines / 1.18MB; `styles.css` is 13,987 lines; `index.html` is 3,375 lines. `CLAUDE.md` already documents this ("Large monolithic files for main processes") as a known, accepted trade-off rather than an oversight. The cost shows up concretely: commit history has **two separate** "Remove duplicate IPC handler definitions in main.js" fixes (`b80cc5c` and `a3fcbd0`) — the same channel handled twice, which is a trivial mistake to make and very easy to miss reviewing a 17K-line file by eye or even by most tooling, and a correspondingly easy one to *introduce* when adding a feature without first checking whether something similar already exists 8,000 lines away.

### 5. Server mode is still full Electron, not a lean headless service

This isn't a drift cause by itself, but it's the thing that makes drift more expensive and makes "install as a service" harder than it should be. The Docker image (`Dockerfile`) installs Chromium, Xvfb, and a full native-module toolchain (g++, make, python3 — better-sqlite3 needs compiling); `docker-entrypoint.sh` starts a virtual X server before Electron will even launch headless. `docker-compose.yml`'s own comments flag the consequence directly: *"OOM kills the whole Electron process and drops all WebSocket clients... Recommend Docker Desktop / host RAM of 4GB+"* and *"V8 heap auto-scales from the cgroup limit... Raise if logs show 'OOM error in V8: Zone Allocation'"*. A deployment whose only job is "hold a SQLite DB, scan folders, talk to the Shopify API, sync orders" is carrying the weight of a full browser engine because the *3D preview/thumbnail rendering* feature needs one, and nothing today separates "needs a browser engine" logic from "doesn't" — they're both just in `main.js`.

## Recommended plan

### Phase 1 — cheap, low-risk, do first

1. **Fix the `broadcastEvent` null-reset asymmetry** (main.js:1738, :1757) to match the `sendEvent` fix already on HEAD — a safe no-op instead of `null`. Five-minute fix, closes a bug class that already bit you once today under a different name.
2. **Add a parity test**, in the same spirit as the existing `tests/server-mode-schema-completeness.spec.js`, that asserts every method `preload.js` exposes on `window.electron` has a corresponding entry in server-bridge.js's `methodToChannel` (and vice versa — catches stale entries too). This turns the `fcde05d` bug class into something CI catches before it ships, not something a user hits first.
3. **Add a build-time check** that every `.js`/`.css` file actually `require()`d or `<script src>`'d from `index.html`/`main.js` is present in `package.json`'s `build.files` array (or, better, stop hand-listing files and compute the list from a manifest/glob with an explicit exclude-list instead — inverting the failure mode from "forget to add" to "forget to exclude," which is far less common in practice). Closes the `6e09a2c` bug class the same way.

None of this requires touching the monolith's structure — it's test/tooling-only, and it directly targets the three concrete bug classes the git history shows actually happened.

### Phase 2 — continue the core-extraction effort already started

`core/schema.js` proved the extraction pattern works (Electron-free, parameterized on `db`, verified by its own completeness test). The fix for drift at the structural level — rather than patching each symptom — is to keep pulling logic that has "zero Electron dependencies" (the exact test `core/schema.js`'s header comment uses) out of `main.js` into `core/*.js` modules: the Shopify push/reconciliation logic, order sync, SKU generation, search/query building, print-event tracking. Each module becomes something both the Electron desktop shell *and* a plain Node entry point can import and call identically — which eliminates the `isServerMode` branch at that logic's level entirely, rather than requiring a human to remember to keep two branches in sync. This is slow, incremental work (one module at a time, each with its own completeness test mirroring `schema.js`'s), not a rewrite — and it's the same work Phase 3 needs regardless, so it isn't wasted effort either way.

### Phase 3 — installation as an application and/or service (revisit once Phase 2 has moved a few modules)

**Desktop app install:** already solid. NSIS installer (`installer.nsh`) creates Start Menu shortcuts for both desktop and server mode (same install, `--server` arg difference), preserves the DB across upgrades, and a Startup-folder shortcut gives "starts automatically" today. The installer's own comment is explicit that this is *not* a Windows Service — no `services.msc` entry, no start-before-login, no auto-restart-on-crash, can't be controlled via `sc`. That's a reasonable stopgap, not a dead end.

**A real Windows Service / Linux systemd unit**, once Phase 2 has extracted enough: package the headless-capable core (DB, scanning, Shopify, orders — everything that doesn't touch `BrowserWindow` or native dialogs) as a plain Node service, run under a lightweight service wrapper (`node-windows` or NSSM on Windows; a systemd unit on Linux) — **not** full Electron + Xvfb + Chromium. This directly removes the OOM/GPU fragility the `docker-compose.yml` comments already warn about, because the service no longer needs a browser engine resident at all times — WebGL thumbnail generation becomes something the service can shell out to (or skip, falling back to a non-GPU preview path) on demand rather than a permanent dependency of just running the backend. Keep Docker as the "batteries-included, don't want to manage a service yourself" path for people who do want the 3D preview features server-side; document the lean-service and the full-Docker paths as two different answers to two different needs, rather than today's one blurred artifact that always pays the Electron+Chromium cost regardless of which features you actually use.

This phase is explicitly **not scheduled** — it depends on Phase 2 being far enough along that there's a real headless core to wrap, and should get its own design session (single machine vs. multiple, auto-start requirements, how upgrades should work for a running service vs. an installed app) the same way GR-PLAN-005's print-scheduling work got its own session rather than being folded into GR-PLAN-004.

## Other optimisation opportunities noticed (not drift-related, but flagged while reviewing)

- **Thumbnail lazy-loading** — already captured as a backlog item in GR-PLAN-004 (2026-10-04): the library grid loads all thumbnails rather than only visible/near-visible ones. Still unaddressed, and more pressing now that the catalogue keeps growing — worth prioritising given this review's broader "optimisations" ask.
- **Monolith size as its own maintenance cost, independent of drift** — `main.js` and `renderer.js`'s scale (17K / 29K lines) makes even a one-off review like this one slower and riskier than it should be (two "duplicate IPC handler" bugs shipped historically precisely because nothing short of very careful reading catches a second definition 8,000 lines away). The Phase 2 extraction work pays this down as a side effect even where it isn't chasing a server-mode bug specifically.

## Open questions for the next session

1. Does James want Phase 1's three fixes done now, as a quick, self-contained piece of work, independent of the bigger Phase 2/3 effort?
2. For Phase 2, which module should be extracted next after `core/schema.js` — Shopify push/reconciliation (`shopify.js`) is the obvious candidate given it's the most actively developed area right now (GR-PLAN-004/005/006).
3. For Phase 3, single machine or eventually multiple (relevant to GR-PLAN-005's print-scheduling work too, which already asked the same question) — worth deciding once, since it affects both.
