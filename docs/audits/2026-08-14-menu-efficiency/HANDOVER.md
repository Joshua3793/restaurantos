# Handover: finish the menu & prep efficiency review

**For: a local Claude Code session with database access.** A cloud session (branch
`claude/menu-efficiency-analysis-tz8521`) built the first pass of this report without
DB credentials. Your job is to pull the real sales numbers, verify the assumptions,
finalize the Tier 4 recommendations, and update the published report **in place**.

## What already exists

- **Published report** (share with Joshua when done):
  `https://claude.ai/code/artifact/5ab651a5-ce83-477c-9a89-2a41b80fcc00`
  Source HTML: [`report.html`](./report.html) in this directory.
  **Republish to the SAME url** by passing that URL as the Artifact tool's `url`
  parameter — do not create a new artifact.
- **Data script**: `scripts/menu-efficiency-data.ts` (read-only). Run:
  `npx tsx scripts/menu-efficiency-data.ts 42`
  It writes `docs/audits/2026-08-14-menu-efficiency/data.md` with:
  sales mix + margin per MENU dish, PREP→dish reachability (transitive), and
  active minutes per prep item.

## What the first pass concluded (context)

58 PREP recipes support ~14 composed dishes. Tiers 1–3 (garnish cuts, base
consolidations, make-vs-buy) need no sales data and are final. **Tier 4 — the menu
cuts — was left gated on sales mix**, with this decision rule:

> A composed dish under **~4% of food-item mix** carrying **4+ unique preps** gets
> cut or rebuilt from shared components.

Tier 4 open questions, in order of labor impact:

1. **Texas Brisket** — 6 unique preps + a second 12-hr smoker program. Does its mix %
   and total margin $ justify it vs. letting the Smash Burger absorb those sales?
2. **Forager Tartine** — $19, 5 unique preps (Mushroom Ragout, Charred/nettle Pesto,
   Butternut Vegan Yolk, Vegan Parm, pickled crosnes). If low mix → replace with a
   vegan dish built from shared parts.
3. **Caesar Salad** — 4 unique preps (Caesar Dressing, Croutons, crispy capers, kelp),
   nothing shared. If low mix → cut; if it sells → buy the croutons.
4. **Suspected dead preps** (in no summer menu description): Scones, Dukkah, Roasted
   Pepper Relish, Vinegar Reduction, Tonka Snow, House Salad Dressing, Pickle
   Jalapeños. Section C of data.md settles this — 0-dish preps are dead or
   catering-only; tag or archive accordingly.

## Assumptions to verify against real recipe links

The dish→prep mapping in the report came from menu *descriptions*, not
`RecipeIngredient` rows. Section C of data.md gives the real links. Check:

- Is **Bean Purée** shared by Elaho AND Pulled Pork Ranchero, or Elaho-only?
- Which pulled pork is actually linked to the Ranchero — **Adobo** or **Smoked**?
  (Both exist as PREPD; the report assumes one is legacy.)
- Is **Pork, Fennel & Chilli Sausage** used by both Shakshuka and Elaho?
- Do the Coastal Benedict / Dubliner MENU recipes have ingredient rows at all, or
  are they name-only rows seeded for Toast matching (`scripts/seed-cafe-brunch-menu.ts`
  created them without ingredients)? If name-only, dish→prep mapping stays
  description-based — say so in the report rather than silently trusting either.

## Steps

1. Run the data script (needs `.env` / `DATABASE_URL`). If `SaleLineItem` is sparse
   (Toast per-item sync may not populate it), fall back to a Toast product-mix
   export from Joshua — flag this in the report if so.
2. Verify the mapping assumptions above; correct the Section 01 table in
   `report.html` where the real links disagree.
3. Make the Tier 4 calls with real numbers: for each of Brisket / Forager / Caesar
   fill in mix %, margin $, and a clear keep/cut/rebuild verdict. Replace the
   VERIFY chips with the verdicts. Update the Section 06 totals.
4. Resolve the dead-preps list from Section C (0-dish preps).
5. Republish `report.html` to the existing artifact URL (above). Update this
   directory's copy too, commit to `claude/menu-efficiency-analysis-tz8521`, push.
6. Tell Joshua the final verdicts in chat — lead with the Tier 4 calls and the
   revised prep-count math.

Keep the report's framing (tiers, platform assets, standing rule) — only the
VERIFY-gated content should change.
