# GR-PLAN-010 Gremlin Works Rebrand (full, with data migration)

Status: **Planned 2026-10-15, scheduled for later — not part of the current 008/009 build.** Decision by James: the fork has diverged far enough from upstream Printventory to carry its own Gremlin Relics identity. Name: **Gremlin Works**. Scope: **full rebrand including internal identifiers, with data migration handled by the installer** (and by the app itself as a fallback), because a second machine downstairs will also be installed. Supersedes GR-PLAN-004's "fork naming" open item.

## Do now (independent of the rebrand)

- **Usage reporting:** untick *Enable Usage Reporting* in the About dialog (Help → About) — the setting already exists (`CollectUsage`) and stops the GoatCounter pings to the upstream author. Code change (any time): default it to **off** for new installs.
- **Version check:** `checkForUpdates()` fetches `https://printventory.com/public.version` (upstream, currently 2.2.2) and compares it with this fork's version. Disable by default; replace with this fork's own GitHub Releases in the rebrand (below).

## What changes

### Visible
- Product name **Gremlin Works** everywhere the user sees it: window title, About dialog, menus, dialogs, toasts, OS notifications, installer pages, Start Menu / desktop shortcuts (desktop and server-mode variants), uninstaller entry, tray/taskbar.
- Icons and installer artwork (`logo.ico/.icns/.png`, `installer-sidebar.bmp`, favicons/PWA icons, `sidebar-bg.jpg` if branded) — new Gremlin Relics artwork.
- Docs: README, GUIDE, in-app guide, CHANGELOG header.
- About: "Gremlin Works — based on Printventory by TechJeeper Designs (MIT)". `LICENSE.txt` keeps the original copyright notice (MIT requirement) with a Gremlin Relics line added.

### Internal identifiers
| Item | Today | New |
|---|---|---|
| `package.json` name | `printventory` | `gremlin-works` |
| `build.appId` / AppUserModelId (main.js) | `com.printventory.app` | `com.gremlinrelics.gremlinworks` |
| `build.productName` | (unset) | `Gremlin Works` |
| User data folder | `%APPDATA%\printventory` | `%APPDATA%\Gremlin Works` (from productName) |
| Database file | `printventory.db` | `gremlinworks.db` (renamed during migration) |
| URL protocol | `printventory://` | `gremlinworks://` (keep old one registered for one release, forwarding) |
| Docker image / container / volumes / env vars | `printventory*` | `gremlin-works*` (keep old env var names as aliases for one release) |
| Chrome extension name/ID | Printventory | Gremlin Works (new ID → re-pair once) |
| Update check | printventory.com | this fork's GitHub Releases |
| Settings keys, table names | unchanged | unchanged (internal, no user value in renaming) |

Before building, inventory every `printventory` reference (≈99 files at 2026-10-15) and classify each as *visible*, *identifier*, *credit/licence* (keep) or *historical doc* (keep).

## Data migration

Goal: installing Gremlin Works on a machine that had Printventory keeps the library, Shopify links, orders, print history, filament data, settings, certificates and caches — with no manual steps and nothing deleted.

### In the installer (NSIS, primary path)
1. Detect an existing Printventory install (uninstall registry key / install dir) and whether Printventory is running — ask to close it.
2. If `%APPDATA%\Gremlin Works` has no database and `%APPDATA%\printventory` has one: **copy** (not move) the whole folder, rename the DB to `gremlinworks.db`.
3. Leave the old folder in place as a backup (named in the finish page), and offer to uninstall the old Printventory app (shortcuts, Startup entry, protocol handler).
4. Replace the Startup-folder auto-start shortcut and server-mode shortcuts with Gremlin Works ones.
5. Log what was migrated to the support log.

### In the app (fallback)
On first start, if the new data folder has no DB and the old one exists, perform the same copy + rename, then show a one-time "Imported your Printventory data" notice. Covers dev runs (`npm start` uses a repo-root DB), portable/zip builds, Linux/macOS, and anyone who skips the installer step.

### Docker
Document the volume rename; the entrypoint accepts the old volume path / env vars for one release and logs a deprecation warning.

### Safety
- Copy-then-verify (open the copied DB, `PRAGMA integrity_check`, row counts on models / shopify_* / print_events) before switching to it; on failure keep using nothing new and show the error rather than starting empty.
- Never auto-delete the old folder.
- Test matrix: fresh install (no old data), upgrade over Printventory 2.2.x, re-run installer (idempotent — doesn't overwrite newer Gremlin Works data), server-mode shortcut, Docker volume.

## The downstairs machine

A second install is planned downstairs (near the printers). Two separate desktop installs would mean **two separate databases** — orders, print jobs and the Print Plan would not be shared. Decide before installing (ties to GR-PLAN-009 open question 2):

- **Recommended:** run Gremlin Works in **server mode** on one always-on machine (e.g. downstairs, next to the printers) and use it from the other PC/phone in a browser — one database, one plan, both people see the same thing.
- Alternative: desktop app downstairs only, nothing upstairs.

Either way, install downstairs **after** the rebrand ships, so that machine never needs migrating.

## Build steps (when scheduled)

1. Inventory and classify all `printventory` references.
2. Visible rename + artwork + About credit.
3. Identifier changes (package name, appId, productName, protocol, Docker, extension) and own update channel.
4. App-side migration with verification + tests (`core/` module, fixed temp folders).
5. NSIS installer migration + old-app removal + shortcuts.
6. Test matrix on a spare Windows user profile / VM; then release as **Gremlin Works 3.0.0** (major bump marks the identity change).

## Open questions

1. Artwork: who produces the icon/installer art — existing Gremlin Relics brand assets?
2. Where should releases live (GitHub repo name / private releases) for the update check?
3. Server mode downstairs, or desktop only? (see above)
4. Keep the `printventory://` protocol forwarding for one release or drop it immediately?
