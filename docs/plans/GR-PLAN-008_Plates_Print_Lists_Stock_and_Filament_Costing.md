# GR-PLAN-008 Plates, Print Lists, Print Jobs, Stock and Filament Costing

Status: **Planned 2026-10-15, revised the same day after a joint review with GR-PLAN-009 (scheduling). Not yet built.** The combined build order for 008 + 009 lives in **GR-PLAN-009 → "Combined build order"**; this doc holds the design. Follows GR-PLAN-006 and resolves its open questions Q3 and Q6.

## Summary

Today an order line can only be printed if its variant maps to exactly one file. Most Gremlin Relics products don't fit that: sets need several files, Nightwings is one file with two plates, shelves are one file with many plates, and duck coasters are one plate per subtype printed four at a time. Those lines fall back to "Open Product Manager" and Mark Printed is hidden — which is why it looked removed.

This plan makes the **plate** the unit of printing, gives each variant a **print list** of plates, and turns every plate that needs printing into a **print job** with a simple lifecycle (queued → started → printed / failed). Jobs carry the print time and filament grams, feed finished units to orders or stock, deduct filament, and are what the GR-PLAN-009 scheduler plans.

## Revisions from the joint review (2026-10-15)

1. **One `print_jobs` table instead of two half-models.** The first draft tracked progress per order line (`order_line_plate_progress`) while 009 tracked `busy_until` on the printer. Both are the same thing: a job on a printer. One table now drives order progress, printer availability, stock, filament usage and actual durations.
2. **Ask for print time and grams at "Started", not at Mark Printed.** You've just sliced the plate at that moment, so the numbers are on screen — and the scheduler needs the time *before* the print finishes. Mark Printed only asks if Started was skipped.
3. **Actual duration comes free.** `started_at` → `finished_at` on each job records real duration with no extra step (the measured-duration idea dropped earlier comes back at zero cost), so estimates can be compared to reality later.
4. **Failed prints are a first-class outcome.** **Failed** re-queues the job and still deducts the filament used — covering the main source of on-hand drift without a separate step.
5. **Stock is universal, not a special mode.** Every plate has a yield (units per run, default 1). A finished job allocates units to waiting order lines; anything left over goes to that plate's on-hand count. "Stocked" now only means "has a restock threshold". Same mechanism serves duck coasters, leftover units from a cancelled order, and batching several orders onto one run.
6. **Multi-colour is derived, not entered.** A plate with grams for more than one filament is multi-colour (editable override). The scheduler uses this flag directly.
7. **Reuse what exists:** `print_events` already has `outcome`, `printer_id` and `duration_seconds` — job completion writes a print event as today, so the model's print history and counts keep working. The `printers` table (Printer Management) gets capability fields rather than a new table.

## The problem cases (ground truth from James, 2026-10-15)

| Product | File structure | Sold as | What one order needs |
|---|---|---|---|
| Typical product | 1 file, 1 plate | 1 unit | Plate 1 ×1 |
| Quiet Corvid | 1 file, 1 plate holding both bookends | Pair | Plate 1 ×1 |
| Nightwings | 1 file, 2 plates (one plaque each) | Pair | Plate 1 ×1 + Plate 2 ×1 |
| Large shelves | 1 file, several plates (parts) | 1 shelf | Every plate ×1, may span printers/days |
| Duck coasters | 1 file, 1 plate per subtype (6 subtypes); 4 per run | Single subtype | Pull 1 from stock, or print that subtype's plate (makes 4) |
| Sets (e.g. Halloween Ghosts complete set) | Several files | 1 set | Every file's plate(s) ×1 |

Printers: two Bambu Lab P1S — one single-colour on an external spool, one with two AMS units (the only colour-capable printer). Bambu Studio opens a whole 3MF, not a specific plate, so "plate N" is an on-screen instruction.

## Design

### Plates
- Read from each 3MF on link/scan: index, name, preview (`Metadata/model_settings.config`, `Metadata/plate_N.png`). Non-3MF files (STL etc.) = one plate.
- Per plate: print time, filament(s) with grams, yield (default 1), on-hand units, optional restock threshold, multi-colour (derived).
- Auto-fill time/grams from slice data when present (`Metadata/slice_info.config` in sliced exports). **Verify on real files first** (build step B1) — if James's saved project files carry it, most plates fill themselves.

### Print lists
- Each variant has a print list: entries of *file + plate(s) + count*. Replaces `UNIQUE(folder_path, shopify_variant_id)` on `shopify_variant_file_links`; existing links migrate as "file, all plates, ×1". Many variants can share one file (duck coasters).
- Product editor shows each variant's list with file/plate chips; "9 files" / "5 plates" badges make multi-file variants obvious.
- Unlinked order lines get an inline file/plate picker on the order card; the choice is saved as that variant's print list.

### Print jobs
- An open order line expands into jobs = print list × quantity, minus units already allocated (from earlier jobs or stock).
- Lifecycle: **queued → started (printer, time) → printed | failed**.
  - **Started**: pick printer (pre-filled from the 009 plan); if time/grams are missing, one small prompt asks for them.
  - **Mark Printed**: allocates the plate's yield to waiting lines (oldest/most urgent first), surplus to on-hand; deducts filament; writes a `print_events` row (outcome, printer_id, duration). Each click logs one run immediately (GR-PLAN-006 Q3).
  - **Failed**: deducts filament, logs a failed print event, re-queues.
- Order card: per-plate checklist with thumbnail, "Plate 2 of 2", time, Open (file in Bambu Studio), Started / Mark Printed, and progress ("Nightwings · plates 1/2").
- Stocked plates: **Pull from stock (3 left)** when enough on hand, otherwise the job is queued ("Print plate 3 — makes 4").
- Restock: when on-hand falls below threshold, a restock job is queued (lowest priority in 009).

### Filament (simple, per filament — not Spoolman, not per spool)
- Filament record: brand, product line, material, colour name + hex, diameter, spool size (net g), low-stock threshold.
- **Record delivery** when an order arrives (replaces per-filament "Add stock", added 2026-10-15): one form per supplier order — supplier, date, order number, **receipt** (PDF or photo, stored with the record), shipping cost, and one line per filament (filament, spools, price). Submitting updates on-hand and the weighted running average cost/kg for every line; shipping is shared across lines by price. Gives a delivery history linked to receipts for bookkeeping, still with no per-spool tracking.
- **How a delivery updates each filament** (confirmed with James 2026-10-15):
  - On-hand increases by spools × spool size (e.g. 3 × 1000 g).
  - Average cost/kg is re-weighted by weight, not spool count: new avg = (on-hand kg × old avg + delivered kg × delivered cost/kg) ÷ (on-hand kg + delivered kg). Delivered cost includes that line's share of shipping. Example: 2 kg on hand at €20/kg + 3 kg at €16/kg → €17.60/kg.
  - If on-hand is zero (or the filament is new), the average is simply the delivery's cost/kg.
  - Spool size is taken from the filament record and can be overridden per line (e.g. a 500 g or 3 kg spool of the same filament).
  - A delivery line can create a new filament inline, so a first-time colour doesn't need a separate setup step.
  - Editing or deleting a delivery (typo in price/quantity) recalculates on-hand and the average from the event history, rather than leaving a wrong figure baked in.
- Job printed or failed → grams deducted. **Set on hand** corrects drift (quantity only, not cost). Reorder list below threshold.
- Product cost = Σ plate grams × average cost/kg across the print list, e.g. "Nightwings: 2 plates · 7h 20m · 186 g · €3.42".
- Existing Spoolman import stays, tucked away as an optional import.

### Where it lives in the UI
See GR-PLAN-009 → "Menus and windows": Printers, Filament (with Deliveries) and Stock each get their own window under a new **Production** menu.

### Shopify boundary
Printventory still never writes Shopify inventory, products or variants. Shopify inventory stays set for print-on-demand; on-hand units are Printventory-only.

## Data model sketch

- `model_plates` — model_id, plate_index, name, preview, print_minutes, yield_units, on_hand, restock_threshold, multicolor_override.
- `model_plate_filaments` — plate_id, filament_id, grams.
- `variant_print_items` — folder_path, shopify_variant_id, model_id, plate_index (NULL = all plates), quantity. Migrated from `shopify_variant_file_links`.
- `print_jobs` — id, plate_id, source (order / restock), printer_id, status (queued / started / printed / failed), est_minutes (snapshot), started_at, finished_at, created_at.
- `print_job_allocations` — job_id or 'stock', order_line_item_id, units — what each run or stock pull went to.
- `filaments` (existing) + product_line, colour_name, spool_net_g, avg_cost_per_kg, on_hand_g, low_stock_spools.
- `filament_deliveries` — id, supplier, delivered_at, order_ref, shipping_cost, receipt_path, notes.
- `filament_stock_events` — filament_id, type (delivery / usage / failed / adjust), grams, cost_total, at, job_id, delivery_id.
- `printers` (existing) + is_active, multicolor_capable, ams_units (shared with 009).

All new logic in Electron-free `core/*.js` modules with tests (GR-PLAN-007 Phase 2); new preload methods get `methodToChannel` entries (parity test).

## Out of scope

- Writing anything to Shopify inventory, products or variants.
- Per-spool tracking, spool IDs/labels, delivery records, Bambu RFID matching.
- Opening a specific plate in Bambu Studio.

## Open questions

1. Do plates have a fixed filament, or is colour chosen per order? Fixed → deduction needs no prompt. Chosen → Started asks which filament.
2. Duck coaster yield: fixed per plate (4), or sometimes different at print time?
3. Where should reorder (filament) and restock (stock) lists live — in their own windows only, or also summarised in a "Needs attention" strip on the Print Plan?
4. Receipts for bookkeeping: is an export of filament spend by month/supplier wanted (step E)?
