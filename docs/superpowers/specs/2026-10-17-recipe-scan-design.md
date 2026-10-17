# Recipe Scan — design

Date: 2026-10-17 · Owner: Joshua · Status: draft for approval
Look: the Controla OS design system (artifact "Controla OS", components group "Recipe scan") — ScanCapture, ScanReviewHead, CostSummary, IngredientMatchRow, FuzzyPicker, MethodStep.

## Why

Adding a recipe today means typing every ingredient with its quantity and unit, and — the slowest part — typing the method step by step. Joshua's two real cases: a recipe from a printed cookbook, and a PDF of ingredients + method that he wrote with Claude. Recipe Scan turns a photo or file into a costed prep recipe so the chef's job is **check and fix, not type**.

Success: a manager photographs a cookbook page (or drops a PDF) and, after a few minutes of checking flagged lines, saves a prep recipe that costs correctly, has a stepped method with hands-on and wait times, and shows up on the prep list like any hand-made recipe.

## Goals

1. Accept phone photos (one or several pages per recipe), PDF, Word (.docx) and Excel/CSV files.
2. Read the recipe name, yield, ingredient lines (quantity, unit, words) and method.
3. Match each ingredient to an inventory item or an existing prep recipe, and show how sure the match is.
4. Split the method into short numbered steps, grouped into named phases, each with hands-on minutes and an optional wait.
5. Let the chef fix anything quickly, then save a normal PREP recipe.
6. Learn from the chef's fixes so the next scan needs fewer of them.

## Non-goals (v1)

- Menu dishes. Scanning makes **prep recipes only** (Joshua's decision). Menu comes later.
- Scaling on the way in. The recipe is saved **exactly as written** (a book's 10 L stays 10 L); the chef scales it afterwards in the recipe editor (Joshua's decision).
- Web links / URLs as a source. *(My call — not asked for.)*
- Setting prep-line settings (par level, shelf life, stations). These stay blank and are set in the recipe editor's Prep section as today. *(My call.)*
- Editing an existing recipe from a scan (merge into a recipe). A scan always makes a new recipe.

## Anti-goals (a failure even if it "works")

- A silent $0: any line that can't be costed must say why.
- A price stored on the scan or recipe. Cost is always derived from the item's current pricing at read time (the app's spine rule).
- Duplicate inventory items created behind the chef's back (e.g. a second "Paprika").
- Prices shown to anyone below MANAGER in the app's screens. (Exception, Joshua's decision: the attached original file is visible to everyone who sees the recipe, whatever it contains.)
- A scanned recipe that quietly loses an allergen because a line wasn't linked.

## Who

**MANAGER and above only** — the people who edit recipes and see costs today (Joshua's decision). Cooks don't see the feature.

## The flow

### 1. Capture
- Entry: a "Scan recipe" button on the Recipe Book page (prep recipes), MANAGER+ only. *(Placement is my call.)*
- **Phone:** the same native page scanner the invoice screen uses (edge detect, auto-shutter, several pages = one scan). Web fallback: the existing camera capture.
- **Desktop:** a drop zone + "Choose file" for photos, PDF, .docx, .xlsx/.csv.
- One upload = one **scan** (a saved draft record). The chef can leave; scans wait in a "Reading" list on the Recipe Book page like invoice batches, and show Reading / Ready / Couldn't read.

### 2. Reading
- Images and PDFs go to Claude the way the invoice OCR does (images compressed under the API limit; PDFs as native document blocks).
- Word and Excel are turned into text locally first, then sent to Claude as text. *(Library choice is the builder's.)*
- **One file with several recipes** (a cookbook chapter, an Excel sheet of sauces): the scan is split into one draft per recipe; the list shows "6 recipes found" and the chef reviews and saves each one separately (Joshua's decision). A draft can be discarded without touching the others.
- Claude returns, per recipe: name, yield quantity + unit, ingredient lines (raw words exactly as written, quantity, unit, and a cleaned ingredient name), method text, and for each method step: text, hands-on minutes, wait minutes + where ("in the oven"), phase name, and whether each time was **stated on the page** or **estimated**.
- Reading must not block the screen; long files run in the background like invoice processing, and a scan stuck past a time limit turns into "Couldn't read" with a retry.

### 3. Review (one draft = one screen)
Layout per the design system: page head (recipe name editable, crumbs = file name + pages, one-line summary "Read 7 ingredients and 5 steps. 2 need you."), cost strip, ingredient list, method, and the original photo/file viewable beside it (desktop) or one tap away (phone).

**Recipe fields**
- Name: from the page, editable. If a recipe with the same name already exists, a CHECK warning asks for a different name; never overwrite. *(My call.)*
- Yield: from the page. If the page gives none, the app guesses and marks it CHECK; it must be confirmed before save. *(My call.)*
- Category: the app suggests one of the existing PREP recipe categories (e.g. Sauces); editable; required. *(My call.)*
- Revenue center: the one the manager is working in; editable. *(My call.)*

**Ingredient lines** — each row shows the scanner's exact words ("read as '60 ml sherry vin'"), the match, amount, line cost, and one tag:
- **MATCHED** — an exact name, a learned wording, or a match the chef already confirmed once.
- **CHECK** — a close guess, a guessed weight, or a unit question.
- **NO MATCH** — nothing close.
- **PREP · category** — matched to one of our own prep recipes (used as a sub-recipe).
- **NO AMOUNT** — "salt to taste", "a splash".

Matching searches active inventory items **and** active prep recipes (like the recipe editor's ingredient search), not supplier-specific.

**Not in inventory** (Joshua's decision: pick, create or skip): the line opens the picker with the closest items/prep recipes (best guess first, each with how it's bought, main supplier and how many recipes use it), plus **Create item** and **Keep uncosted** (saved as a text-only line).

**Create item** (Joshua's decision: name now, price later): a short form pre-filled with the scanned name asks only for the **name and the unit it's counted/bought in**. No supplier, pack or price. The item is created unpriced; the recipe line links to it and shows **"no price yet"** (never a silent $0), and the recipe can be saved. The item gets its price on its first approved invoice, the normal way. The cost strip counts such lines as not costed. (This is a small form of its own, not the invoice new-item panel, which expects invoice pricing.)

**Allergens on unlinked lines** (Joshua's decision: tag by hand): today a recipe's allergens come only from lines linked to an item or prep recipe. So every line that is **not linked** (kept uncosted) shows allergen tick-boxes (the Health Canada list the app already uses) plus a "No allergens" option. Saving is blocked until each unlinked line has either ticks or "No allergens" — none can be skipped *(the "required" part is my call)*. These hand-tagged allergens are saved on the line and count toward the recipe's allergens (and flow to any recipe that uses this one), exactly like an item's allergens.

**NO AMOUNT lines** ("salt to taste") are still matched to an item like any other line, and saved **linked with no quantity**, so they carry the item's allergens and cost nothing; the row reads "no amount". *(My call.)* If such a line can't be matched, it's an unlinked line and gets allergen tick-boxes like the others.

**Recipes that use each other in one file** (a chapter's "1 cup Aioli, see p. 42" where Aioli is another draft from the same scan): the line starts as NO MATCH with the hint "Aioli is in this scan — save it first". When a draft from the same scan is saved, the other open drafts re-match automatically, so the line becomes PREP · Aioli. *(My call.)*

**Odd amounts** ("3 cloves", "1 bunch", "a handful") — Joshua's rule:
- Conversion happens **only once the line is matched** to an inventory item, and only **into that item's own unit** (weight, volume or each). Example: "3 cloves garlic" matched to Garlic Peeled (bought by the kg) → about 15 g, tagged CHECK.
- A line that is **not matched** (uncosted) keeps the amount **exactly as written** ("3 cloves") — no conversion.
- When the chef corrects a guessed weight, the app remembers it for that item ("1 clove of Garlic Peeled = 5 g") and uses it next time.
- Ordinary units that already fit the item (ml for a litre item, g for a kg item) convert silently as today.

**Learning**: when the chef confirms or picks a match, the app remembers that wording → item (e.g. "sherry vin" → Sherry Vinegar), so the next scan tags it MATCHED. Recipe wordings are kept separate from the invoice scanner's supplier wordings. *(Storage is the builder's.)*

**Method**
- Long paragraphs become short numbered steps, one action each, grouped under phase names drawn from the method ("Roast", "Peel & toast", "Blend & rest"). Phase names and step text are editable; steps can be reordered, split, merged, deleted.
- Each step: hands-on minutes, optional wait after it with a short note.
- **Times not stated on the page are guessed and marked GUESSED in amber** (Joshua's decision). Stated times show "from page". The GUESSED mark lives on the draft only; once saved, times are ordinary times. *(My call.)*
- Saved in the existing recipe Method format (steps with phase, minutes, wait), so start-by times and the prep run sheet work straight away. The last step can't be a wait: if the page ends on one ("chill overnight"), the app adds a finishing step ("Label and date").

**Cost strip**: lines costed (e.g. 5 / 7), batch cost "so far", cost per yield unit. Costs computed live from the items; nothing stored.

**Saving**: allowed when no line is CHECK, yield/category are set, and every unlinked line has its allergens tagged. NO MATCH lines may be saved as uncosted on purpose. The save makes, in one step, a normal PREP recipe with all ingredients and the method — with the usual side effects (linked inventory item, prep list item). A toast confirms; the draft is marked saved.

### 4. After saving
- The recipe is an ordinary prep recipe: in the Recipe Book, on the prep list (switched on like any new one), costed, allergens inherited from its ingredients.
- **The original photo/file stays attached** to the recipe with a "See original" link (Joshua's decision).
- **Everyone who can see the recipe can open the original** — cooks included (Joshua's decision, knowing that a scanned PDF or spreadsheet could contain prices). The file-serving route must allow any signed-in user who can see that recipe.

## Constraints

- Follow the app's spine: never store a price; derive from pack chain at read time.
- Only MANAGER+ can call the scan, review and save endpoints; each endpoint guards itself.
- Use the existing upload storage and file helpers where possible; file size limits like invoices (16 MB per file).
- Prisma via the shared client; any new tables via a migration.
- Phone first: review works on a phone with bottom sheets; desktop gets the side-by-side original.

## Left to the builder

- Claude model, request format (structured output recommended), prompt wording, and how to split multi-recipe files.
- How Word/Excel are converted to text.
- Data model for scans/drafts, learned wordings, learned per-item counts, and the recipe's attached original.
- The single save endpoint (today's create-recipe call takes no ingredients; lines are added one by one).
- Matching algorithm and thresholds (reuse the recipe-editor search and/or invoice matcher scoring).
- Whether to highlight on the original photo where each line was read (nice to have; the invoice viewer already does this).
