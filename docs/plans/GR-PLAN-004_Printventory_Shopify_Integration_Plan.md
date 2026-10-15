# GR-PLAN-004 Printventory–Shopify Integration Plan (v1 / MVP)

Status: Agreed with James, 2026-10-03. In build (live, iterative — see Build log below). **Verified against actual source 2026-10-04** (see Verification section) — core build items confirmed implemented; two small items remain open.

## Decision summary (from iterative interview)

- Scope of v1: data model extension + Shopify push, built together.
- Shopify connection: Admin API (GraphQL), not CSV import. James already has a Shopify API app/connection set up.
- Where listing/SKU data lives: Printventory's own database (not a new parallel store).
- Where this is built: a module inside Printventory's existing UI, not a separate standalone app.
- SKU rules: apply the GR SKU pattern (`GR-[Collection]-[Type]-[Product]-[Series]-[Variant]`) to all NEW products created through this workflow from day one. Do not attempt to retrofit or override existing SKUs that don't conform — leave historical SKUs alone.
- Photos: sourced from the product folder (already Gremlin Relics' storage convention); user manually selects which photos go out and their order in the UI — no fully automatic photo selection in v1.
- Publish state: every push creates/updates products as Draft / unpublished in Shopify. A successful push/import approves nothing — matches GR-SYS-001 (new Draft products) and GR-SYS-002 (editing published listings); human approval (measurements, pricing, photography, publish) remains a separate manual gate.
- Order management: fully manual for now. No inbound order reading, no print-queue automation, no Etsy Open API work in v1.
- Etsy: deprioritized because QuickSync already bridges Shopify ↔ Etsy by SKU pairing. Flagged (not scheduled) to reconsider Etsy-direct API work only if/when QuickSync is dropped as a cost. Until then, do not build speculative Etsy plumbing into v1.
- Printer/queue management (Watchtower-style farm management): noted as a possible future interest only. Explicitly out of scope, no hooks or scaffolding needed for it in v1.
- Authentication: Shopify fully deprecated the static "reveal-once" custom-app Admin API access token. v1 uses the OAuth Client Credentials Grant (`POST /admin/oauth/access_token`, form-urlencoded, ~24h token, refreshed automatically) against app "GremlinRelics Catalogue Bridge" (Client ID `7d1946d2a4a880ac193c02b377eb180b`), store `2kempx-0i.myshopify.com`. Not the Authorization Code Grant (would require a hosted OAuth callback — rejected as unneeded complexity for a single-user internal tool).

## Reconciliation with existing Shopify catalogue (added 2026-10-03, mid-build)

~120 products already live on Shopify must be linked to their existing Printventory product folders, not duplicated by a fresh push.

- Identity is at the folder/product level, never per raw file. `.stl` files are secondary slicer exports and are never treated as their own reconcilable product (skipped by default, but shown — toggle-able — in case a non-Bambu slicer needs one). A folder containing more than one `.3mf` needs a primary-file selection plus an explicit link-or-skip choice for the others (large/cut variants etc.), persisted per file, not re-asked every session.
- Matching: auto-suggested name-based candidates shown in a dropdown populated with real Shopify product titles/SKUs; never auto-confirmed. Manual fallback dropdown for anything that doesn't match.
- Confirming a link persists immediately, per item ("submit partial links") — does not require clearing the whole backlog in one sitting.
- **Linked-product behaviour (clarifies original v1 scope above):** once a product folder is linked to an existing Shopify listing, the Printventory editor must pull and display that listing's *real* Shopify data — title, description, tags, price, and all variants with their own SKU/price — editable in place. It is not shown a blank "generate a new SKU" form. The SKU Generation UI (Collection/Type/Series dropdowns, GR SKU pattern) applies only to products that are NOT yet linked and need a brand-new SKU for a first-time push.
- The product view also gets a button to open the underlying model file directly in the configured slicer (Bambu Studio etc.), reusing Printventory's existing slicer-launch integration rather than building new — so a linked, editable listing and "open the file to check/reslice it" sit side by side in the same view.
- **Resolved, verified 2026-10-04:** the "linked product shows blank SKU/description/tags/variants" issue is fixed — but via a different mechanism than originally assumed. Rather than persisting Shopify's data into the local DB at link time, the editor does a **live fetch straight from Shopify** every time a linked product is opened (`fetchLiveShopifyData` → `shopify.js`'s `fetchProductWithVariants`), and populates title, description, vendor, tags, SEO fields, the variants table (SKU/price/compare-at/inventory), and photos directly from that live response. Confirmed working in practice (James screenshotted a linked product's Tags field populated correctly).

## Shopify field-coverage scope (added 2026-10-03, from Shopify's official bulk-import CSV template)

James asked whether the module should sync everything representable in Shopify's own CSV schema. Reviewed field-by-field against GR's actual use case; decision below — this is the authoritative v1 field list, superseding the shorter list in "v1 build scope" below.

**Add to v1:**
- Barcode
- Compare-at price
- Cost per item
- SEO title, SEO description
- Product image alt text
- Full multi-option support: Option1/Option2/Option3, each with name + value (not Option1-only) — needed for product lines with two option dimensions (e.g. size + color)
- Product category, Type (Shopify's own taxonomy fields, in addition to — not replacing — the GR licensor/collection scheme)

**Reversed decision (2026-10-03, later same day):** Inventory quantity sync was initially scoped out ("stays manual in Shopify"), then reopened after James pushed back that a sync which can't actually update a field he cares about defeats the point of having it. **Quantity sync is now in v1.** Technical note: Shopify does not treat stock quantity as a variant field — it's managed by a separate Inventory API tied to a specific fulfillment location (`inventorySetQuantities`/`inventoryAdjustQuantities` against an `InventoryItem` + `locationId`), not by `productVariantsBulkUpdate`. James confirmed Gremlin Relics currently has a single Shopify location, so the push fetches that location automatically via the locations API rather than requiring manual location configuration — revisit this assumption if a second location is ever added.

**Explicitly not synced in v1 (decided, not just deferred without reason):**
- "Continue selling when out of stock" — not synced; inventory quantity itself now is (see reversal above)
- Weight value/unit, "requires shipping" — no per-model weight capture in v1
- Fulfillment service — not applicable, self-fulfilled
- Gift card — not applicable, no gift-card products
- Google Shopping block (category, gender, age group, MPN, ad group, ads labels, condition, custom product, custom labels 0–4) — no Google Shopping ads campaign planned
- Unit price total/base measure+unit — not applicable to discrete printed products
- Color as a separate Shopify metafield — redundant with the Option value when color is already a variant option

## v1 build scope

1. Data model extension inside Printventory's existing database: title, description, price, SKU, tags, licensor/collection, the four standing workflow status flags (`needs-measurement-review`, `needs-pricing-review`, `needs-final-photography`, `not-approved-for-publishing`), plus the expanded field set agreed above (barcode, compare-at price, cost per item, SEO title/description, image alt text, Option1/2/3 name+value, product category, type, inventory quantity).
2. SKU generator following the GR pattern, invoked for new, not-yet-linked products only.
3. New UI module inside Printventory for: editing the above fields per product, selecting/ordering photos from the product folder, opening the model file in the configured slicer, and triggering a Shopify push.
4. Shopify Admin API (GraphQL) integration: create Draft products, update existing (previously-pushed or newly-linked) products, full reconciliation flow against the ~120 already-live products, plus inventory quantity sync via the Inventory API (single default location).
5. No CSV import path required for v1 (API-first, per James's preference).
6. Vitest unit tests for the Shopify module specifically (SKU generator, reconciliation query, token refresh logic, push payload builders), written in the same step as the code they cover, scoped to this module only — not retrofitted onto inherited Printventory code. Standing rule captured in `CLAUDE.md`.

## Explicitly out of scope for v1

- Etsy Open API integration (revisit trigger: QuickSync being dropped)
- Reading Shopify/Etsy orders back into Printventory
- Any print-queue, print-farm, or printer-management features
- Retrofitting/correcting SKUs on existing published products
- Automatic photo selection without user review
- Weight/shipping fields, Google Shopping metadata (see field-coverage scope above)

## Verification against actual source (2026-10-04)

James asked for the v1 claims to be checked against the real Printventory codebase (`C:\Users\JamesGarfield\source\repos\Printventory`) rather than taken from this plan doc alone. Findings:

**Confirmed implemented, matching plan:**
- `productVariantsBulkUpdate` migration — present in `shopify.js`, replacing the deprecated `productVariantUpdate` mutation.
- Inventory quantity sync — implemented via `inventorySetQuantities` against `InventoryItem` + `locationId`, with `getPrimaryLocationId()` auto-fetching the single default location as agreed.
- `push_status` / `last_push_error` columns exist on `shopify_products`, written on both success and failure (no more silent push failures), with a DB index on `push_status`.
- Linked-product data pull (title/description/tags/price/variants/photos) — confirmed working via the live-fetch pattern described above, not via local persistence.
- No orders-reading code exists anywhere in `shopify.js`/`main.js` — v1 has not quietly crept into order territory.
- Printer-related code already in the repo (`printer-manager.js`, `printer-management.js`) is printer **inventory/maintenance** tracking (logs, reminders, maintenance records) — not a job queue or print scheduler. Relevant context for GR-PLAN-005 (no existing scheduling logic to build on, though the printer-entity model could potentially be reused for a multi-printer scheduler later).

**Open item (minor, not blocking):**
- `shopify_products` has **no `tags` column**, and `linkFolderToShopifyHandler` never persists the `tags` array that `fetchProductWithVariants` fetches from Shopify. This causes no visible bug today — the editor always live-fetches tags from Shopify on open, confirmed working — but it means tags are never cached in Printventory's own DB for a linked product, so they can't be searched/filtered/reported on from within Printventory itself (only visible when the editor is open and online). On push, the tag value sent back to Shopify is derived from Printventory's own local tag system (`model_tags`), not from whatever the live-fetched Shopify tags showed — worth keeping in mind if local tags and real Shopify tags ever drift apart for a linked product. Fix, if wanted later: add the column and persist it in `linkFolderToShopifyHandler` and on each live refresh. Not scheduled — revisit only if local search/filter/report by tag becomes something James actually wants.

**Not verified (environment limitation, not a code finding):** `shopify.test.js` could not be run in this session — the repo's installed `node_modules` has Windows-only native bindings, which fail under the Linux shell available here. Run `npm test` directly on the Windows machine for a real pass/fail signal on the Vitest suite.

## Known build issues (live log)

- **Parent-model grouping (resolved 2026-10-03):** Printventory's existing 3MF-metadata-import feature mapped each file's embedded slicer "Title" field directly onto `parentModel`, which drives the library grid's auto-grouping. Many unrelated Osmoze products shared a stale "Title" value ("The Anatomist's Study") left over from copying one slicer project as a template, causing them to group together with no action by James. Fixed: cleared the stray `parentModel` data, disabled the two auto-populate settings, and requested a proper redesign (explicit grouping-display toggle, confirm-before-capture on scan, manual group/ungroup actions) — build in progress. Unrelated to the Shopify module itself.
- **`productVariantUpdate` deprecated (found 2026-10-03, resolved — see Verification above):** Shopify removed the single-variant update mutation from the Admin API; `shopify.js` was still calling it, so every variant push failed silently (no user-facing error). Fixed: migrated to `productVariantsBulkUpdate`, push failures now always write `push_status`/`last_push_error` and the UI shows a notification.
- **Linked-product blank fields (found 2026-10-03, resolved — see Verification above):** fixed via the live-fetch-on-open pattern rather than local persistence.

## Next step

Confirm the expanded field set (barcode, compare-at price, cost per item, SEO fields, image alt text, Option2/Option3 support, product category/type) end-to-end in practice. Decide whether the `tags` local-persistence gap (see Verification) is worth fixing or left as-is. Run the Vitest suite on the Windows machine directly to get a real automated-test signal (couldn't be run from this session's Linux shell — native binding mismatch).

## Backlog / future ideas (not scheduled)

- **Thumbnail lazy-loading (added 2026-10-04):** James flagged that as the catalogue grows, Printventory's library grid should only load thumbnails for items that are visible or near-visible in the viewport, rather than all at once — standard virtualized/lazy-load pattern (e.g. IntersectionObserver-based loading, or a virtualized grid component) to keep the UI responsive at scale. Not designed or scoped yet — just captured as a known future performance need, likely to become more pressing as the ~120+ product catalogue keeps growing and more photos get attached per product.

## Open item: fork naming (revisit later, not blocking)

Printventory is MIT licensed (author: TechJeeper Designs) — renaming or extensively diverging the fork is legally straightforward; MIT only requires keeping the original copyright/licence notice somewhere in the source, not in the product name.

James is planning to extend the software extensively and raised whether the fork should get its own name at some point (Linux-distribution-style: a fork earns a distinct identity once it has its own purpose/roadmap, not from day one).

Working recommendation, not yet decided: keep the repo/package name as `printventory` (or a fork-suffixed variant) for now, so git history and any future upstream merges from TechJeeper Designs stay clean. Pick a Gremlin-Relics-branded product name once the Shopify module and a few more extensions have landed. When renamed, keep a README credit back to Printventory/TechJeeper Designs as the base (good practice, not an MIT requirement).

The Shopify custom app name (in the Dev Dashboard) is a separate, low-stakes decision — just a label in the Shopify admin's Apps list/audit log, easy to rename anytime. Suggested it follow GR documentation naming style, e.g. "GR Commerce Sync," rather than referencing Printventory.

No action needed now — revisit once v1 is further along or before any public/shared release of the fork.
