"""
Build the accountant's inventory valuation workbook from a count export.

  python3 scripts/build_count_workbook.py docs/audits/count-valuation-monthend.json out.xlsx

Values are FORMULAS (quantity x price), never Python-computed literals, so the
sheet recalculates if a price is corrected again. The counted quantity and the
price are kept in separate columns for exactly that reason.
"""
import json
import sys
from collections import Counter
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

SRC = sys.argv[1]
OUT = sys.argv[2]

data = json.load(open(SRC))
rows = data["rows"]

# Independent arithmetic over the source data, stated in the workbook so the
# reader can confirm Excel's own recalculation agrees with it.
_at = sum(r["qtyBase"] * r["priceAtCountPerBase"] for r in rows)
_now = sum(r["qtyBase"] * r["priceNowPerBase"] for r in rows)
_phys = sum(1 for r in rows if r["basis"].startswith("Physically counted"))
_dates = Counter(r["countedOn"] for r in rows if r["countedOn"])

FONT = "Arial"
HEAD_FILL = PatternFill("solid", fgColor="1F2937")
HEAD_FONT = Font(name=FONT, size=10, bold=True, color="FFFFFF")
TITLE_FONT = Font(name=FONT, size=14, bold=True)
BODY = Font(name=FONT, size=10)
BOLD = Font(name=FONT, size=10, bold=True)
NOTE = Font(name=FONT, size=9, italic=True, color="555555")
MONEY = '$#,##0.00;($#,##0.00);-'
MONEY5 = '$#,##0.00000;($#,##0.00000);-'
QTY = '#,##0.###'
THIN = Side(style="thin", color="D4D4D8")
BOX = Border(top=THIN, bottom=THIN, left=THIN, right=THIN)
TOPLINE = Border(top=Side(style="medium", color="1F2937"))

wb = Workbook()

# ─────────────────────────────────────────────────────────── Valuation ──
ws = wb.active
ws.title = "Valuation"

ws["A1"] = f"Inventory valuation — {data['revenueCenter']} — {data['sessionDate']}"
ws["A1"].font = TITLE_FONT
ws["A2"] = (
    f"Source counts: {data['label']}. Each item is shown at its most recent physical count. "
    f"Prices are the corrected prices in the system as at {data['exportedAt'][:10]}."
)
ws["A2"].font = NOTE

HEADERS = [
    ("Item", 38), ("Category", 10), ("Storage area", 16), ("Supplier", 16),
    ("Quantity basis", 26), ("Counted on", 12),
    ("Qty counted", 12), ("Count unit", 12), ("Qty (base)", 12), ("Base unit", 10),
    ("Price at count ($/base)", 20), ("Price now ($/base)", 18),
    ("Value at count", 15), ("Value at current prices", 21), ("Change", 12),
    ("Price now (readable)", 19), ("Per", 8), ("Pack format", 30),
]
# column letters that matter downstream
C_CAT, C_BASIS, C_QTY, C_PAT, C_PNOW = "B", "E", "I", "K", "L"
C_VAT, C_VNOW, C_CHG = "M", "N", "O"

HROW = 4
for i, (h, w) in enumerate(HEADERS, start=1):
    c = ws.cell(row=HROW, column=i, value=h)
    c.font = HEAD_FONT
    c.fill = HEAD_FILL
    c.alignment = Alignment(vertical="center", wrap_text=True)
    ws.column_dimensions[get_column_letter(i)].width = w
ws.row_dimensions[HROW].height = 30
ws.freeze_panes = f"A{HROW + 1}"

first = HROW + 1
for n, r in enumerate(rows):
    i = first + n
    vals = [
        r["item"], r["category"], r["storageArea"], r["supplier"], r["basis"], r["countedOn"],
        r["countQty"], r["countUom"], r["qtyBase"], r["baseUnit"],
        r["priceAtCountPerBase"], r["priceNowPerBase"],
        f"={C_QTY}{i}*{C_PAT}{i}", f"={C_QTY}{i}*{C_PNOW}{i}", f"={C_VNOW}{i}-{C_VAT}{i}",
        r["priceNowPerUnit"], r["perUnit"], r["packChain"],
    ]
    for col, v in enumerate(vals, start=1):
        c = ws.cell(row=i, column=col, value=v)
        c.font = BODY
        c.border = BOX
    for col in (7, 9):
        ws.cell(row=i, column=col).number_format = QTY
    for col in (11, 12):
        ws.cell(row=i, column=col).number_format = MONEY5
    for col in (13, 14, 15, 16):
        ws.cell(row=i, column=col).number_format = MONEY

last = first + len(rows) - 1
tot = last + 1
ws.cell(row=tot, column=1, value="TOTAL").font = BOLD
ws.cell(row=tot, column=1).border = TOPLINE
for L in (C_VAT, C_VNOW, C_CHG):
    c = ws[f"{L}{tot}"]
    c.value = f"=SUM({L}{first}:{L}{last})"
    c.font = BOLD
    c.number_format = MONEY
    c.border = TOPLINE

ws.auto_filter.ref = f"A{HROW}:R{last}"

# ───────────────────────────────────────────────────────────── Summary ──
s = wb.create_sheet("Summary")
s["A1"] = f"Summary — {data['revenueCenter']} — {data['sessionDate']}"
s["A1"].font = TITLE_FONT

s["A3"] = "By category"
s["A3"].font = BOLD
for i, h in enumerate(["Category", "Lines", "Value at count", "Value at current prices", "Change"], start=1):
    c = s.cell(row=4, column=i, value=h)
    c.font = HEAD_FONT
    c.fill = HEAD_FILL
cats = sorted({r["category"] for r in rows})
V = f"Valuation!${C_CAT}${first}:${C_CAT}${last}"
for n, cat in enumerate(cats):
    i = 5 + n
    s.cell(row=i, column=1, value=cat).font = BODY
    s.cell(row=i, column=2, value=f'=COUNTIF({V},$A{i})').font = BODY
    s.cell(row=i, column=3, value=f'=SUMIF({V},$A{i},Valuation!${C_VAT}${first}:${C_VAT}${last})').font = BODY
    s.cell(row=i, column=4, value=f'=SUMIF({V},$A{i},Valuation!${C_VNOW}${first}:${C_VNOW}${last})').font = BODY
    s.cell(row=i, column=5, value=f"=D{i}-C{i}").font = BODY
    for col in (3, 4, 5):
        s.cell(row=i, column=col).number_format = MONEY
crow = 5 + len(cats)
s.cell(row=crow, column=1, value="TOTAL").font = BOLD
s.cell(row=crow, column=1).border = TOPLINE
for col in (2, 3, 4, 5):
    L = get_column_letter(col)
    c = s.cell(row=crow, column=col, value=f"=SUM({L}5:{L}{crow - 1})")
    c.font = BOLD
    c.border = TOPLINE
    if col > 2:
        c.number_format = MONEY

brow = crow + 3
s.cell(row=brow, column=1, value="How each quantity was established").font = BOLD
s.cell(row=brow + 1, column=1, value=(
    "Each item takes its most recent physical count across the source sessions. A line that "
    "nobody counted in either session falls back to the quantity the system expected."
)).font = NOTE
for i, h in enumerate(["Quantity basis", "Lines", "Value at current prices", "% of total"], start=1):
    c = s.cell(row=brow + 2, column=i, value=h)
    c.font = HEAD_FONT
    c.fill = HEAD_FILL
bases = sorted({r["basis"] for r in rows})
B = f"Valuation!${C_BASIS}${first}:${C_BASIS}${last}"
trow = brow + 3 + len(bases)
for n, b in enumerate(bases):
    i = brow + 3 + n
    s.cell(row=i, column=1, value=b).font = BODY
    s.cell(row=i, column=2, value=f'=COUNTIF({B},$A{i})').font = BODY
    s.cell(row=i, column=3, value=f'=SUMIF({B},$A{i},Valuation!${C_VNOW}${first}:${C_VNOW}${last})').font = BODY
    s.cell(row=i, column=3).number_format = MONEY
    s.cell(row=i, column=4, value=f"=IF($C${trow}=0,0,C{i}/$C${trow})").font = BODY
    s.cell(row=i, column=4).number_format = "0.0%"
s.cell(row=trow, column=1, value="TOTAL").font = BOLD
s.cell(row=trow, column=1).border = TOPLINE
for col in (2, 3):
    L = get_column_letter(col)
    c = s.cell(row=trow, column=col, value=f"=SUM({L}{brow + 3}:{L}{trow - 1})")
    c.font = BOLD
    c.border = TOPLINE
    if col == 3:
        c.number_format = MONEY

for col, w in zip("ABCDE", (46, 10, 22, 24, 14)):
    s.column_dimensions[col].width = w

# ─────────────────────────────────────────────────────────────── Notes ──
n = wb.create_sheet("Notes")
n["A1"] = "Basis of preparation"
n["A1"].font = TITLE_FONT
n.column_dimensions["A"].width = 118

counted_summary = ", ".join(f"{d}: {c} items" for d, c in sorted(_dates.items()))

LINES = [
    "",
    f"Scope. Revenue centre {data['revenueCenter']}, which is the default revenue centre — its stock is held on the "
    f"inventory record itself rather than as a per-centre allocation. {len(rows)} items.",
    "",
    f"Quantities. The month-end was counted across two sessions: {data['label']}. Neither session on its own holds "
    "the whole position, because the items counted in one appear in the other as carried-forward lines. Each item is "
    f"therefore shown at its MOST RECENT PHYSICAL count, and the Counted on column says which date that was "
    f"({counted_summary}). {_phys} of {len(rows)} lines rest on a physical observation.",
    "",
    "Quantities are shown both in the unit the counter worked in (Qty counted / Count unit) and in the item's base "
    "unit, which is what the system stores and what the valuation multiplies. Base quantities are the figures the "
    "count itself recorded; pack formats have been repaired since, and re-deriving a counter's entry through a "
    "corrected pack would answer a different question than the one they answered on the night.",
    "",
    "Prices. The count froze a price against each line when it was finalized. Several of those prices were "
    "subsequently found to be wrong: when a supplier changed pack size, the new case price was divided by the item's "
    "old pack size, so the cost was wrong by the ratio between them. Those items have since been corrected. This "
    "workbook values the counted quantities at the CORRECTED prices and shows the price used at count time alongside, "
    "so the restatement of each line is visible. The difference is in the Change column and is subtotalled by "
    "category on the Summary sheet.",
    "",
    "Comparatives. Counts before 30 June 2026 are not comparable with this one. Eighteen items were priced at zero in "
    "the 1 June count and eleven more at under $0.002 per base unit, and fourteen items have changed unit basis since "
    "(for example Yellow potato from each to grams), so their quantities do not line up either. The 1 June count "
    "reported $17,670; those same counted quantities at 30 June prices come to $26,942. Any trend drawn across that "
    "date reflects the repricing, not a change in stock.",
    "",
    "Items subsequently deactivated remain in this valuation, because they were on hand at the count date.",
    "",
    "Formulas. Value columns are formulas over the quantity and price columns, so correcting a price in this workbook "
    "updates the totals. Nothing is a pasted result.",
    "",
    "Check figures. The value columns are live formulas, so Excel computes them when this file opens. They should "
    f"total ${_at:,.2f} at count prices and ${_now:,.2f} at current prices, a change of ${_now - _at:,.2f}. If the "
    "totals differ from these figures, a price has been edited since this file was produced.",
    "",
    f"Source count session ids: {', '.join(data['sessionIds'])}",
    f"Position as at: {data['sessionDate']}",
    f"Prices as at: {data['exportedAt'][:19].replace('T', ' ')} UTC",
]
for i, t in enumerate(LINES, start=2):
    c = n.cell(row=i, column=1, value=t)
    c.font = NOTE if t.startswith(("Source count session", "Position as at", "Prices as at")) else BODY
    c.alignment = Alignment(wrap_text=True, vertical="top")
    if t:
        n.row_dimensions[i].height = max(14, 13 * (len(t) // 115 + 1))

wb.save(OUT)
print(f"wrote {OUT}: {len(rows)} lines, {_phys} physically counted, sheets {wb.sheetnames}")
