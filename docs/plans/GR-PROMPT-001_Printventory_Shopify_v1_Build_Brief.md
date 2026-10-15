# GR-PROMPT-001 Claude Code Build Brief: Printventory Shopify Module (v1)

Paste this into the Claude Code session running inside the `Printventory` repo folder (where `CLAUDE.local.md` with the Gremlin Relics domain context is already in place). Run it as the opening prompt for the build.

**Authentication note (2026-10-03):** Shopify has deprecated the old static "reveal-once" Admin API access token for custom apps. The app (`GremlinRelics Catalogue Bridge`, Client ID `7d1946d2a4a880ac193c02b377eb180b`) is set up in the Dev Dashboard with `read_products,write_products` scopes, installed to the Gremlin Relics store. Because the app and the store are both in the same Shopify organization, the build should use the **OAuth Client Credentials Grant**: Printventory exchanges the Client ID + Client Secret directly for an access token via a POST to `https://{shop}.myshopify.com/admin/oauth/access_token` with `grant_type=client_credentials` — no browser, no redirect, no callback server. The returned token expires roughly every 24 hours, so Printventory needs to silently re-request a fresh one when it's near expiry (e.g. check/refresh before each Shopify call, or cache with a timestamp and refresh if older than ~20 hours). This replaces any assumption of a long-lived static token.

---

## Prompt to paste into Claude Code

I want to add a new module to Printventory that lets me manage Gremlin Relics product listing data and push products to Shopify as Drafts. Read `CLAUDE.local.md` and `CLAUDE.md` first for domain and architecture context, then plan before writing code. Work incrementally and keep the existing app working at every step — this is an addition, not a rewrite.

**Scope for this build (v1):**

1. **Data model.** Extend Printventory's existing better-sqlite3 database with a new table (or extend the models table, whichever fits the existing schema better — use your judgement and show me the migration) holding, per model/product: `title`, `description`, `price`, `sku`, `tags` (reuse existing tag system if there is one), `licensor_collection`, and four boolean/enum status flags: `needs_measurement_review`, `needs_pricing_review`, `needs_final_photography`, `not_approved_for_publishing`. Write a migration that is safe to run against my existing library without touching current data.

2. **SKU generation.** Implement a SKU generator following this pattern: `GR-[Collection]-[Type]-[Product]-[Series]-[Variant]`. The series number is allocated once per product, never per variant; the variant number is the final segment and increments per variant within that product. Only generate SKUs for products that don't already have one — never touch or regenerate an existing SKU on an existing product. Ask me for the exact collection/type abbreviation conventions if they aren't already inferable from `CLAUDE.local.md` or existing product folder names — don't invent abbreviations.

3. **UI module.** Add a new panel/tab inside the existing Printventory UI (not a separate app or window) where I can, per product: edit the fields from #1, see/select photos pulled from that product's folder, choose their order, and see current Shopify push status (not pushed / pushed as draft / last updated date).

4. **Shopify integration.** Use the Shopify Admin API, GraphQL, not CSV. Implement:
   - Authentication via **OAuth Client Credentials Grant**: on demand (or on a background timer), POST my stored Client ID and Client Secret to `https://{shop}.myshopify.com/admin/oauth/access_token` with `grant_type=client_credentials`, cache the returned access token with its expiry, and silently refresh it before it expires (tokens last ~24 hours). Never prompt me for a token manually — the app derives it itself from the Client ID/Secret.
   - Create: push a product as a Shopify **Draft** (never published) using the fields above and the selected/ordered photos.
   - Update: push changes to a product that was previously created through this module (match on SKU or a stored Shopify product ID — your call, tell me which and why).
   - Do not implement any Shopify order-reading, fulfillment, or publish/activate functionality. Draft-only, one-way (Printventory → Shopify).
   - Store the Shopify Client ID and Client Secret (not a token — the app derives tokens itself) in a local-only config file, following the same pattern as `CLAUDE.local.md` — gitignored, never committed, machine-specific. Tell me exactly what file and what format so I can populate it, and add it to `.gitignore` before writing any secret-adjacent code.

5. **Explicitly do not build:** CSV import/export, Etsy API integration of any kind, order reading or print-queue/printer management, automatic photo selection, or any change to SKUs on products that already have one.

**Process:** Plan the schema/migration and the module structure first and show me before writing code. Build in stages (migration → UI panel with local fields only, no Shopify yet → token acquisition/refresh → Shopify create → Shopify update) so I can test each stage. Use the existing IPC pattern (`ipcMain.handle` / `window.electron.invoke`) for anything crossing the main/renderer boundary, consistent with the rest of the app. Add tests consistent with the existing test setup where practical.

---

## Why these constraints (context carried over, not meant to be pasted)

- Draft-only push matches GR-SYS-001/GR-SYS-002: no import or push ever auto-approves a listing; photography, pricing and measurement review stay separate human gates.
- SKU-touch restriction protects already-issued SKUs (including the retired-but-standing GR-OS-P2/GR-OS-W1 series) from being silently regenerated.
- Local-only credential storage mirrors the `CLAUDE.local.md` precedent: machine-specific, gitignored, never synced via the repo.
- Etsy/orders/printer-queue are deliberately excluded per the agreed v1 scope in GR-PLAN-004 — revisit Etsy only if QuickSync is dropped; printer/queue management is a possible future idea with no v1 hooks required.
- Client Credentials Grant (not a static token, not Authorization Code Grant) was chosen 2026-10-03 after discovering Shopify fully deprecated static custom-app tokens: it needs no callback server (app + store share one Shopify organization, which is what makes this grant type usable), at the cost of a ~24h token lifetime that Printventory must silently refresh itself.
