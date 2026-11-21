"""Generates FICTIONAL sample files for trying the platform. Run: python3 scripts/make-sample-files.py  (needs openpyxl).

  samples/messy-trial-balance-germany.xlsx   deliberately flawed: raises validation findings (see samples/README.md)
  samples/clean-trial-balance-france.xlsx    balanced and tidy: extracts cleanly
  samples/balance-confirmation.docx/.pdf/.txt   a supporting document for the document agent
"""
from __future__ import annotations

import io
import zipfile
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font

OUT = Path(__file__).resolve().parent.parent / "samples"
OUT.mkdir(exist_ok=True)


def sheet(wb: Workbook, name: str, title_rows: list[list], header: list[str], rows: list[list], total: bool) -> None:
    ws = wb.create_sheet(name)
    for r in title_rows:
        ws.append(r)
    ws.append(header)
    hdr = ws.max_row
    for c in ws[hdr]:
        c.font = Font(bold=True)
    for r in rows:
        ws.append(r)
    first, last = hdr + 1, ws.max_row
    if total:
        ws.append(["", "Total", sum(r[2] for r in rows), sum(r[3] for r in rows)])  # plain values (a real export's cached totals)
    for col, w in zip("ABCD", (14, 46, 18, 18), strict=True):
        ws.column_dimensions[col].width = w
    for row in ws.iter_rows(min_row=first, min_col=3, max_col=4):
        for c in row:
            c.number_format = "#,##0.00"
            c.alignment = Alignment(horizontal="right")


# ---------------------------------------------------------------- messy: Northwind GmbH (fictional)
GERMANY = [
    ["1000", "Cash at bank - Deutsche Musterbank", 482_310.55, 0],
    ["1100", "Trade receivables", 1_204_880.00, 0],
    ["1150", "Allowance for doubtful receivables", 0, 38_500.00],
    ["1200", "Inventory - finished goods", 735_420.10, 0],
    ["1300", "Prepaid expenses", 64_250.00, 0],
    ["1500", "Intercompany receivable - Northwind Holdings Inc.", 910_000.00, 0],
    ["1999", "Suspense account", 12_480.00, 0],
    ["1600", "Property, plant and equipment", 3_150_000.00, 0],
    ["1650", "Accumulated depreciation", 412_000.00, 0],            # on the wrong side (should be a credit)
    ["2000", "Trade payables", 0, 668_940.25],
    ["2100", "Accrued liabilities", 0, 215_300.00],
    ["2500", "Intercompany payable - Northwind France SAS", 0, 340_000.00],
    ["2600", "VAT payable", 0, 96_210.40],
    ["2700", "Bank loan - long term", 0, 1_500_000.00],
    ["3000", "Share capital", 0, 1_000_000.00],
    ["3100", "Retained earnings", 0, 1_244_309.60],
    ["4000", "Revenue - product sales", 0, 6_842_115.30],
    ["4100", "Revenue - services", 0, 1_120_400.00],
    ["5000", "Cost of goods sold", 4_380_220.45, 0],
    ["6000", "Salaries and wages", 1_890_000.00, 0],
    ["6100", "Rent and utilities", 288_000.00, 0],
    ["6100", "Rent and utilities (Q4 reclass)", 72_000.00, 0],       # duplicate account code
    ["6200", "Depreciation expense", 310_500.00, 0],
    ["6300", "Professional fees", 143_775.30, 0],
    ["6400", "Travel and entertainment", 96_840.00, 0],
    ["7000", "Interest expense", 98_450.00, 0],
    ["8000", "Income tax expense", 361_000.00, 0],
]
# Make debits exceed credits by exactly 50.00 so the footing rule has something concrete to find.
d = sum(r[2] for r in GERMANY); c = sum(r[3] for r in GERMANY)
GERMANY.append(["6500", "Miscellaneous", 0 if d - c >= 50 else 50 - (d - c), 0]) if d - c < 50 else GERMANY.append(["2900", "Other creditors", 0, (d - c) - 50 if (d - c) > 50 else 0])

# ---------------------------------------------------------------- clean: Northwind France SAS (fictional)
FRANCE = [
    ["1000", "Cash and bank", 210_500.00, 0], ["1100", "Trade receivables", 530_200.00, 0], ["1200", "Inventory", 301_450.00, 0],
    ["1600", "Equipment", 900_000.00, 0], ["1650", "Accumulated depreciation - equipment", 0, 240_000.00],
    ["2000", "Trade payables", 0, 288_900.00], ["2300", "Accrued expenses", 0, 91_250.00], ["2700", "Long-term loan", 0, 400_000.00],
    ["3000", "Share capital", 0, 500_000.00], ["3100", "Retained earnings", 0, 190_000.00],
    ["4000", "Revenue", 0, 2_431_875.00], ["5000", "Cost of sales", 1_298_000.00, 0], ["6000", "Payroll", 612_400.00, 0],
    ["6100", "Rent", 96_000.00, 0], ["6300", "Professional fees", 58_625.00, 0], ["6900", "Other operating costs", 124_850.00, 0],
]
d = sum(r[2] for r in FRANCE); c = sum(r[3] for r in FRANCE)
FRANCE.append(["2900", "Other creditors", 0, d - c] if d > c else ["1900", "Other debtors", c - d, 0])


def build() -> None:
    wb = Workbook(); wb.remove(wb.active)
    cover = wb.create_sheet("Cover")
    for r in (["Northwind GmbH - FY2025 year-end package"], ["Prepared by: Accounting - Europe (fictional)"], ["All figures in EUR. FICTIONAL DATA FOR TESTING ONLY."]):
        cover.append(r)
    sheet(wb, "NWG - EUR", [["Northwind GmbH - Trial Balance"], ["As at 31 Dec 2025", "", "Currency: EUR"], []], ["GL Account", "Account Description", "Debit (EUR)", "Credit (EUR)"], GERMANY, True)
    wb.save(OUT / "messy-trial-balance-germany.xlsx")

    wb = Workbook(); wb.remove(wb.active)
    sheet(wb, "NWF - EUR", [["Northwind France SAS - Trial Balance"], ["As at 31 Dec 2025", "", "Currency: EUR"], []], ["GL Account", "Account Description", "Debit (EUR)", "Credit (EUR)"], FRANCE, True)
    wb.save(OUT / "clean-trial-balance-france.xlsx")


# ---------------------------------------------------------------- supporting document
CONFIRMATION = [
    "BALANCE CONFIRMATION",
    "Northwind France SAS (the Company) hereby confirms the balance owed to Northwind GmbH as at 31 December 2025.",
    "Intercompany payable: EUR 340,000.00 (invoice dated 2025-11-30; settlement due 15 January 2026).",
    "This confirmation relates to the intercompany account reconciliation for the FY2025 close.",
    "Signed on behalf of Northwind France SAS by the Authorised Signatory.",
    "Date: 12 January 2026",
]


def docx_bytes(lines: list[str]) -> bytes:
    body = "".join(f"<w:p><w:r><w:t>{x}</w:t></w:r></w:p>" for x in lines)
    xml = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>'
    ct = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    rels = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ct); z.writestr("_rels/.rels", rels); z.writestr("word/document.xml", xml)
    return buf.getvalue()


def pdf_bytes(lines: list[str]) -> bytes:
    esc = lambda s: s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")  # noqa: E731
    text = "BT /F1 11 Tf 56 740 Td 16 TL " + " ".join(f"({esc(x)}) Tj T*" for x in lines) + " ET"
    stream = text.encode("latin-1", "replace")
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out = b"%PDF-1.4\n"; offs = []
    for i, o in enumerate(objs, 1):
        offs.append(len(out)); out += f"{i} 0 obj\n".encode() + o + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode() + b"".join(f"{o:010d} 00000 n \n".encode() for o in offs)
    return out + f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode()


if __name__ == "__main__":
    build()
    (OUT / "balance-confirmation.docx").write_bytes(docx_bytes(CONFIRMATION))
    (OUT / "balance-confirmation.pdf").write_bytes(pdf_bytes(CONFIRMATION))
    (OUT / "balance-confirmation.txt").write_text("\n".join(CONFIRMATION) + "\n")
    print("wrote", *sorted(p.name for p in OUT.iterdir()), sep="\n  ")
