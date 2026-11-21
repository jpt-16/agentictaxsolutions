"""FICTIONAL messy spreadsheets for stress-testing the extraction agent. Run: python3 scripts/make-messy-samples.py (needs openpyxl).
Writes samples/messy/*.xlsx and samples/messy/truth.json (the correct accounts for each file, used by scripts/score-messy-samples.py)."""
from __future__ import annotations

import json
from decimal import Decimal as D
from pathlib import Path

from openpyxl import Workbook

OUT = Path(__file__).resolve().parent.parent / "samples" / "messy"
OUT.mkdir(parents=True, exist_ok=True)

# (code, name_en, debit, credit). Always balanced. Names are translated per file.
BASE = [
    ("1000", "Cash and bank", "412350.75", "0"), ("1100", "Trade receivables", "1204880.00", "0"), ("1200", "Inventory", "735420.10", "0"),
    ("1600", "Equipment", "3150000.00", "0"), ("1650", "Accumulated depreciation", "0", "412000.00"), ("2000", "Trade payables", "0", "668940.25"),
    ("2100", "Accrued liabilities", "0", "215300.00"), ("2700", "Bank loan", "0", "1500000.00"), ("3000", "Share capital", "0", "1000000.00"),
    ("4000", "Revenue", "0", "6842115.30"), ("5000", "Cost of sales", "4380220.45", "0"), ("6000", "Payroll", "1890000.00", "0"),
    ("6300", "Professional fees", "143775.30", "0"),
]
_d = sum(D(r[2]) for r in BASE); _c = sum(D(r[3]) for r in BASE)
BASE.append(("3100", "Retained earnings", str(_c - _d) if _d < _c else "0", "0" if _d < _c else str(_d - _c)))
assert sum(D(r[2]) for r in BASE) == sum(D(r[3]) for r in BASE)
NAMES = {
    "es": ["Efectivo y bancos", "Cuentas por cobrar", "Inventarios", "Equipo", "Depreciación acumulada", "Proveedores", "Acreedores diversos", "Préstamo bancario", "Capital social", "Ingresos por ventas", "Costo de ventas", "Sueldos y salarios", "Honorarios profesionales", "Utilidades acumuladas"],
    "de": ["Kasse und Bank", "Forderungen aus Lieferungen", "Vorräte", "Betriebsausstattung", "Kumulierte Abschreibung", "Verbindlichkeiten aus Lieferungen", "Sonstige Rückstellungen", "Bankdarlehen", "Gezeichnetes Kapital", "Umsatzerlöse", "Materialaufwand", "Löhne und Gehälter", "Beratungskosten", "Gewinnvortrag"],
    "fr": ["Trésorerie", "Créances clients", "Stocks", "Matériel", "Amortissements cumulés", "Fournisseurs", "Charges à payer", "Emprunt bancaire", "Capital social", "Chiffre d'affaires", "Coût des ventes", "Salaires et traitements", "Honoraires", "Report à nouveau"],
}
truth: dict[str, dict] = {}


def num(v: str, style: str):
    d = D(v)
    if style == "number":
        return float(d) if d != 0 else 0
    whole, _, frac = f"{d:.2f}".partition(".")
    if style == "eu":  # 1.234.567,89 as TEXT
        return f"{int(whole):,}".replace(",", ".") + "," + frac if d != 0 else ""
    if style == "fr":  # 1 234 567,89 with non-breaking spaces, as TEXT
        return f"{int(whole):,}".replace(",", " ") + "," + frac if d != 0 else ""
    if style == "us_text":
        return f"${int(whole):,}.{frac}" if d != 0 else "-"
    raise ValueError(style)


def save(name: str, wb: Workbook, rows=BASE, currency="", entity="") -> None:
    wb.save(OUT / name)
    truth[name] = {"currency": currency, "entity": entity, "accounts": [{"code": r[0], "debit": r[2], "credit": r[3]} for r in rows]}


def sheet(wb, title, head_rows, header, body, tail=()):
    ws = wb.create_sheet(title)
    for r in head_rows:
        ws.append(r)
    ws.append(header)
    for r in body:
        ws.append(r)
    for r in tail:
        ws.append(r)
    return ws


def totals(style):
    return (sum(D(r[2]) for r in BASE), sum(D(r[3]) for r in BASE))


def build():
    # 1. Mexico: Spanish headers, numeric cells, MXN, title block, "Totales" row
    wb = Workbook(); wb.remove(wb.active)
    d, c = totals("number")
    sheet(wb, "Balanza MXN", [["Northwind México, S.A. de C.V."], ["Balanza de comprobación al 31 de diciembre de 2025"], ["Moneda: MXN"], []],
          ["Cuenta", "Descripción", "Debe", "Haber"], [[r[0], NAMES["es"][i], num(r[2], "number"), num(r[3], "number")] for i, r in enumerate(BASE)], [["", "Totales", float(d), float(c)]])
    save("mx_balanza_mxn.xlsx", wb, currency="MXN", entity="Northwind México")

    # 2. Germany: German headers, European-format numbers stored as TEXT
    wb = Workbook(); wb.remove(wb.active)
    d, c = totals("eu")
    sheet(wb, "Saldenliste", [["Northwind GmbH – Summen- und Saldenliste 2025"], ["Währung: EUR"]],
          ["Konto", "Kontenbezeichnung", "Soll", "Haben"], [[r[0], NAMES["de"][i], num(r[2], "eu"), num(r[3], "eu")] for i, r in enumerate(BASE)],
          [["", "Summe", num(str(d), "eu"), num(str(c), "eu")]])
    save("de_saldenliste_eur.xlsx", wb, currency="EUR", entity="Northwind GmbH")

    # 3. France: French headers, thousands separated by non-breaking spaces, comma decimals, TEXT
    wb = Workbook(); wb.remove(wb.active)
    d, c = totals("fr")
    sheet(wb, "Balance", [["Northwind France SAS"], ["Balance générale au 31/12/2025 (EUR)"], []],
          ["Compte", "Libellé", "Débit", "Crédit"], [[r[0], NAMES["fr"][i], num(r[2], "fr"), num(r[3], "fr")] for i, r in enumerate(BASE)],
          [["", "Total", num(str(d), "fr"), num(str(c), "fr")]])
    save("fr_balance_eur.xlsx", wb, currency="EUR", entity="Northwind France")

    # 4. US: one signed YTD balance column, negatives in parentheses as TEXT
    wb = Workbook(); wb.remove(wb.active)
    body = []
    for r in BASE:
        net = D(r[2]) - D(r[3])
        txt = f"{abs(net):,.2f}"
        body.append([r[0], r[1], f"({txt})" if net < 0 else txt])
    sheet(wb, "TB YTD", [["Northwind Inc. – Trial Balance (YTD)"], ["Period ending 12/31/2025"]], ["GL Account", "Account Name", "YTD Balance"], body)
    save("us_signed_balance.xlsx", wb, currency="USD", entity="Northwind Inc.")

    # 5. UK: current and prior-year columns side by side (prior year must be ignored)
    wb = Workbook(); wb.remove(wb.active)
    body = [[r[0], r[1], float(r[2]), float(r[3]), float(D(r[2]) * D("0.93")), float(D(r[3]) * D("0.93"))] for r in BASE]
    sheet(wb, "TB", [["Northwind UK Ltd – Trial balance 2025 with comparatives"], []], ["Nominal code", "Nominal name", "Debit 2025", "Credit 2025", "Debit 2024", "Credit 2024"], body)
    save("uk_with_prior_year.xlsx", wb, currency="GBP", entity="Northwind UK")

    # 6. Header buried on row 9, hidden scratch sheet, notes and sign-off under the table
    wb = Workbook(); wb.remove(wb.active)
    ws = sheet(wb, "Cover", [["Year-end close package"], ["Prepared by: Finance"]], ["Sheet", "Contents"], [["TB", "Trial balance"], ["Notes", "Open items"]])
    head = [[f"Line {i}"] for i in range(1, 5)] + [["Northwind Canada Inc."], ["Trial balance 31-Dec-2025"], ["All figures in CAD"], []]
    sheet(wb, "TB", head, ["Account", "Description", "Debit", "Credit"], [[r[0], r[1], float(r[2]), float(r[3])] for r in BASE],
          [[], ["", "TOTAL", float(totals("number")[0]), float(totals("number")[1])], [], ["Prepared by A. Singh", "Reviewed by: pending"], ["Note: accrual for bonus not yet booked"]])
    hs = wb.create_sheet("Scratch"); hs.append(["old draft", 1, 2, 3]); hs.sheet_state = "hidden"
    save("ca_header_row9_notes.xlsx", wb, currency="CAD", entity="Northwind Canada")

    # 7. Currency symbols and codes inside TEXT cells, dashes for blanks
    wb = Workbook(); wb.remove(wb.active)
    sheet(wb, "Sheet1", [["Northwind Singapore Pte – TB"]], ["Acct", "Account Description", "Dr (SGD)", "Cr (SGD)"],
          [[r[0], r[1], num(r[2], "us_text").replace("$", "S$") if D(r[2]) != 0 else "-", num(r[3], "us_text").replace("$", "S$") if D(r[3]) != 0 else "-"] for r in BASE])
    save("sg_currency_text.xlsx", wb, currency="SGD", entity="Northwind Singapore")

    # 8. Two entities stacked on one sheet, each with its own header and total (the hard case)
    wb = Workbook(); wb.remove(wb.active)
    ws = wb.create_sheet("Group TB")
    half = BASE[:7]
    other = [("1000", "Cash", "50000.00", "0"), ("2000", "Payables", "0", "30000.00"), ("3000", "Capital", "0", "20000.00")]
    ws.append(["Entity A: Northwind Brasil Ltda – BRL"]); ws.append(["Conta", "Descrição", "Débito", "Crédito"])
    for r in BASE:
        ws.append([r[0], r[1], float(r[2]), float(r[3])])
    ws.append(["", "Total", float(totals("number")[0]), float(totals("number")[1])]); ws.append([]); ws.append(["Entity B: Northwind Chile SpA – CLP"])
    ws.append(["Conta", "Descripción", "Debe", "Haber"])
    for r in other:
        ws.append([r[0], r[1], float(r[2]), float(r[3])])
    ws.append(["", "Total", 50000.0, 50000.0])
    save("br_two_entities_stacked.xlsx", wb, currency="BRL", entity="Northwind Brasil (+ Chile stacked below)")
    truth["br_two_entities_stacked.xlsx"]["note"] = "Contains a second entity below; a correct reader should not merge it into the first."


if __name__ == "__main__":
    build()
    (OUT / "truth.json").write_text(json.dumps(truth, indent=2, ensure_ascii=False))
    print("wrote", *sorted(p.name for p in OUT.iterdir()), sep="\n  ")
