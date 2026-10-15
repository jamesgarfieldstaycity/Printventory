# GR-PLAN-009 Print Queue Scheduling (+ combined 008/009 build order)

Status: **Planned 2026-10-15, revised the same day after a joint review with GR-PLAN-008. Not yet built.** This doc holds the scheduling design and the **combined build order for 008 + 009** — start here when picking up the work. Supersedes GR-PLAN-005's parked sequencing idea and GR-PLAN-006's "Phase C".

## Summary

Printventory suggests what to print next, on which printer, and when, so that:

- daytime prints finish while someone is around (before bedtime),
- the longest jobs run overnight, started early enough to check bed adhesion before bed,
- multi-colour plates go to the AMS printer; single-colour plates prefer the single-colour printer,
- orders closest to their Shopify/Etsy ship-by date go first.

It is a **suggestion**, not automation: Printventory doesn't control the printers. Whoever is home starts the print and taps **Started**; the plan recalculates.

## Revisions from the joint review (2026-10-15)

1. **The scheduler plans `print_jobs` (GR-PLAN-008).** No separate busy flag on printers: a printer is busy while it has a started job; expected end = started_at + estimated minutes.
2. **Ship-by date moves to the very start.** Reading and showing it on order cards is small, independent and useful before any scheduling exists ("Ship by Fri" + a simple overdue/soon badge).
3. **Printer capability fields move early** (with ship-by), since both plans need them and Printer Management already has the table.
4. **Restock jobs are just low-priority jobs** — no separate restock logic in the scheduler.
5. **Two people → plan must be shared.** If both of you use Printventory, it should run in server mode so you see one plan. In-app reminders must work in the browser too, not only as Windows notifications.
6. **Actual vs estimated time** comes from job timestamps (008), so the scheduler can later correct estimates (e.g. "this plate usually runs 8% over").

## Scheduling inputs

| Input | Source |
|---|---|
| Jobs | Queued `print_jobs` (order jobs + restock jobs) |
| Print time | Plate estimate (008) — jobs without one are listed as "needs time" and not placed on the timeline |
| Multi-colour | Plate flag (derived from >1 filament, editable) |
| Ship-by | Shopify fulfillment order `fulfillBy`; Etsy orders via QuickSync — whatever ship-by the synced order carries (verify on real orders). Fallback: order date + default processing time |
| Printers | `printers` + is_active, multicolor_capable, ams_units |
| Attended hours | Setting, default 08:00–23:00 every day (two people), optional per-weekday override |
| Adhesion check | Setting, default 30 min |

Fleet today: two Bambu Lab P1S — one single-colour (external spool), one with two AMS units.

## Scheduling rules

1. **Eligibility.** Multi-colour → colour-capable printers only. Single-colour → any printer, preferring the single-colour one.
2. **Priority.** Earliest ship-by first; ties → manual queue order (drag, built 2026-10-15) → oldest order. Restock jobs last.
3. **Starts only when attended**, with ≥ 30 min of the window left for the adhesion check.
4. **Day jobs finish before bedtime** (end of window, default 23:00).
5. **Overnight slot.** Each printer's last start of the evening (by 22:30) gets the longest eligible job that won't finish before bedtime, ideally ending near the next morning. Long jobs wait for this slot rather than starting mid-afternoon.
6. **Morning overrun** is allowed but flagged.
7. **At risk.** Projected finish + dispatch buffer after ship-by → order flagged **At risk**.

Algorithm: greedy simulation over the next few days per printer. Each time a printer frees up inside attended hours, pick the highest-priority eligible job that fits rules 3–5. Recalculated on order sync, Started / Printed / Failed, and settings changes. Tens of jobs, so cheap.

## What you see

**Print Plan** view — one timeline per printer:

```
P1S Colour (AMS)            P1S Single
Now   → Nightwings plate 1    Now   → Quiet Corvid
        ends 14:20 (#1059)            ends 16:05 (#1058)
14:20 → Nightwings plate 2    16:05 → Duck coaster plate 3 (restock)
        ends 19:45                    ends 18:10
Overnight — start by 22:30, check adhesion by 23:00
      → Large shelf plate 1 (9h 10m, ends 07:40)
                              → Ghost set: Wisp (6h 40m, ends 05:10)
```

- Rows show plate thumbnail, order(s) served, ship-by, duration, colour/single badge.
- **Started** on the next row starts that job on that printer; Mark Printed / Failed come from the order card or here.
- Order cards show projected finish and **At risk** where relevant.
- Evening reminder ("Start overnight prints by 22:30") as an in-app banner, plus a Windows notification on desktop.

## Menus and windows (added 2026-10-15)

Production tools get their own top-level **Production** menu instead of sitting in Tools among Print Roulette, De-Dup and MCP settings. Each opens its own full-size window:

| Menu item | Window | Status |
|---|---|---|
| Orders | Orders pane (existing) | Built |
| Print Plan | Per-printer timeline (C2) | New |
| Printers | Printer list, capabilities, maintenance log/reminders — today's Printer Manager, extended (A2) | Move + extend |
| Filament | Filament list, on-hand, average cost, reorder list, **Deliveries** tab with receipts (E1) | Move + extend |
| Stock | Finished-print on-hand per plate, restock thresholds (D1) | New |
| Parts | Hardware stock — today's Parts Manager | Move |
| — | | |
| Shopify settings | Existing | Move |

"Own window" means a large dedicated dialog with the existing full-screen toggle (the pattern Filament Manager already uses), **not** a separate native Electron window: a separate window only exists on desktop and would recreate the desktop/server drift GR-PLAN-007 fixed — in server mode (two people sharing one plan in a browser) it would simply be missing. Each window gets a stable `open-*` channel so the same item appears in the server-mode in-page menu (as Shopify was added in commit 517b1fc). Tools keeps its non-production items; old Tools entries are removed rather than duplicated.

Adding printers: Printers → **+ Add Printer** (exists today). The scheduler reads every active printer, so a third printer needs no code change; its jobs are routed by colour capability and (optional) build plate size.

## Combined build order (008 + 009)

Each step is shippable on its own and leaves the app working.

**A. Foundations — small, independent**
- **A0 Housekeeping:** commit the pending work (pane gutter, lazy photos, notifications, reorder, background-sync fix, combobox alignment); commit plan docs to `docs/plans/`; ignore `printventory*.db`; write the fresh-context prompt.
- **A1 Ship-by date:** read `fulfillBy` (and whatever Etsy/QuickSync provides) on sync, store on `shopify_orders`, show "Ship by" + due-soon/overdue badge on order cards. Check real orders to see which fields are actually populated.
- **A2 Production menu + Printers window:** new top-level Production menu (desktop and server-mode in-page menu), move Orders / Printers / Filament / Parts / Shopify settings into it; extend Printer Manager with is_active, multicolor_capable, ams_units, optional build plate size; set up the two P1S.

**B. Plates and jobs — the core of 008**
- **B1 Spike (half a day):** inspect a few of James's real 3MFs (project files and sliced exports) for plate config, previews and slice data (time, grams per filament). Decides how much auto-fill is possible.
- **B2 Plates + print lists:** plate detection, `variant_print_items` + migration, product editor print lists and badges, inline picker on order cards.
- **B3 Print jobs:** `print_jobs` + allocations; order card per-plate checklist with Open / Started (time+grams prompt) / Mark Printed / Failed; print events written as today. *Brings Mark Printed back on every line.*

**C. Scheduling — 009**
- **C1 Scheduler core:** `core/print-scheduler.js`, Electron-free, unit-tested with fixed clocks and sample job sets (day fill, overnight slot, colour routing, at-risk).
- **C2 Print Plan view:** per-printer timeline, Started from the plan, projected finish + At risk on order cards, evening reminder.

**D. Stock — 008**
- **D1 Yield and on-hand + Stock window:** yield per plate, surplus to on-hand, Pull from stock, restock threshold → restock jobs (flow into the plan at lowest priority); Production → Stock window.

**E. Filament — 008**
- **E1 Filament window:** filament fields, **Record delivery** with receipt upload and running average cost, Deliveries tab, deduction on Printed/Failed, Set on hand, reorder list, product cost on the product editor; optional spend export. Independent of C and D — can move earlier if costing becomes urgent.

**Later (not scheduled):** Bambu LAN-mode live status (MQTT) replacing manual Started and giving real remaining time; filament-on-printer awareness in the plan; batching identical plates across orders onto one run; margin view (cost vs Shopify price); estimate correction from actual durations.

### Why this order
- A1/A2 are cheap and useful immediately, and remove dependencies from later steps.
- B1 de-risks everything after it — auto-filled times/grams decide how much typing the rest needs.
- B3 restores day-to-day order printing before any planning features.
- C needs B (jobs with times); D and E plug into B's Printed/Failed events, so they don't block scheduling.

## Open questions

1. Confirm defaults: attended 08:00–23:00 every day, latest overnight start 22:30, adhesion check 30 min.
2. Will both of you use Printventory? If so, move to server mode on the home network so you share one plan.
3. Default processing time / dispatch buffer when an order has no ship-by (e.g. 3 business days; ship the morning after printing).
4. May one order's plates be split across both printers to hit a deadline, or keep each order on one printer?
