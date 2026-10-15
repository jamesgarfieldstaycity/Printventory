# GR-PLAN-005 Printventory–Shopify Order Sync and Print Scheduling (next feature, parked 2026-10-04)

Status: Requirements captured from James, not yet designed or built at time of writing (superseded in large part by GR-PLAN-006 — see that doc). Intended as the opening brief for a new chat/build session, following on from GR-PLAN-004 (listing/SKU push module, in build).

## Relationship to GR-PLAN-004

GR-PLAN-004 v1 explicitly scoped this out:
- "Order management: fully manual for now. No inbound order reading, no print-queue automation, no Etsy Open API work in v1."
- Out-of-scope list: "Reading Shopify/Etsy orders back into Printventory" and "Any print-queue, print-farm, or printer-management features."

This document is the next feature that reverses those two exclusions. Treat it as v2, building on the SKU/listing data model and Shopify Admin API connection already established in GR-PLAN-004, not a replacement for it.

## What James asked for

1. **Sync orders from Shopify into Printventory.**
2. **Link each order (line item) to its listing/product group via SKU**, so James can jump straight from an order to the corresponding Printventory product/listing — reusing the SKU scheme and product-folder linkage already built in GR-PLAN-004.
3. **Best-practice UX requested, not yet decided.** James asked me to recommend a good UX pattern for this, flagging explicitly that orders will drive what gets sent to the printer — so the order view needs to support that workflow (not just be a read-only order list), e.g. some way to go from "orders in" to "what should I print next."
4. **Longer-term goal: smarter print scheduling, not naive FIFO.** James's own framing, which should be carried into the design conversation verbatim since it's a specific insight, not just "add a queue":
   - Printing orders strictly first-in-first-out is not always efficient.
   - Example: a long-duration print that would finish after midnight, followed by a short print, is inefficient — the long print's finish time isn't attended/actionable until morning, and the short print sits waiting behind it.
   - Better: run the short print first so it finishes (and can be picked up/handled), then start the long print — this minimizes printer downtime/dead time and gets both orders dispatched sooner, rather than the long print blocking the short one unnecessarily.
   - This is a job-sequencing/scheduling problem, not just an ordering toggle — relevant real-world factors to surface in the next session: operator-attended hours (does a print finishing at 3am sit idle until someone's awake, vs one timed to finish when James is around to swap the plate and start the next job), single vs multi-printer farm, whether a reordering should be suggested to James or fully automated, and whether this is a "sort the existing FIFO queue" feature or a true scheduling optimizer.

## Suggested shape for the next session (not decided, just a starting point)

- Phase this as its own build brief (like GR-PROMPT-001 was for GR-PLAN-004): confirm data model additions (orders table, order line items, link to existing product/SKU table), then UX for the order view, then — as a clearly separate, later phase — the print-sequencing logic. Don't conflate "sync orders in" with "optimize print order" as one deliverable; the scheduling piece needs its own design discussion given it's explicitly a longer-term goal, not immediate v1 of this feature.
- Order sync will likely reuse the same OAuth Client Credentials Grant / Admin API GraphQL connection already built for GR-PLAN-004, just reading `orders` instead of only writing `products`.
- Worth asking James early in the next session: single printer or a farm (affects whether scheduling is a simple reorder vs a real multi-resource scheduling problem), and whether he wants the system to suggest a print order (human picks) or actually drive automation (out of scope per GR-PLAN-004's explicit printer-management exclusion, unless that's now being revisited).

## Not yet decided / explicitly open

- UX pattern for the order list/dashboard — James asked for a recommendation, none given yet.
- Whether print scheduling is suggested or automated.
- Whether this touches Etsy orders at all (GR-PLAN-004 deprioritized Etsy entirely pending QuickSync status) — presumably Shopify-only for now, matching GR-PLAN-004's own Etsy stance, but not explicitly confirmed by James in this conversation.

**Note: this brief was picked up and substantially built out as GR-PLAN-006 (Order Fulfillment Workflow — Download, Print, Ship). The FIFO-with-manual-reorder decision, the Orders pane, Mark Printed, and the Shopify fulfillment push all live there. The print-sequencing optimizer this doc raises is explicitly deferred in GR-PLAN-006 as its own future Phase C.**
