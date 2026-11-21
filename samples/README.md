# Sample files (fictional)

Everything here is invented for testing. Regenerate with `python3 scripts/make-sample-files.py` (needs `openpyxl`).

| File | Try it as | What should happen |
|---|---|---|
| `messy-trial-balance-germany.xlsx` | A contributor uploads it to a trial-balance item | The extraction agent finds the table (the "Cover" sheet is ignored). After a reviewer **accepts** the extraction, validation raises 5 findings (below) |
| `clean-trial-balance-france.xlsx` | Same | Extracts cleanly; validation raises nothing |
| `balance-confirmation.docx` / `.pdf` / `.txt` | A contributor uploads one to any item | The document agent reports "Balance confirmation", the amount `EUR 340,000.00`, four dates and signature wording. A reviewer checks it against the original and accepts |

## What the messy file contains on purpose

| Planted problem | Finding you should see |
|---|---|
| Debits exceed credits by exactly 50.00 | **Error:** Debits and credits differ by 50 |
| Account 6100 appears twice | Warning: Account 6100 appears 2 times |
| A balance in "Suspense account" | Warning: suspense or clearing account holds a balance |
| "Accumulated depreciation" sits on the debit side | Warning: balance on an unusual side |
| Two intercompany accounts | Info: 2 intercompany balances to confirm |

## How to run it

1. Sign in as **Marcus Hale** (manager). Create a request with a "Trial balance" item, assign it to a department or person, publish.
2. Sign in as the assigned contributor, open the request, attach a sample file, submit.
3. Process it: `pnpm worker:once` (leave the worker running with `cd services/agent-worker && python -m taxops_agents` to process automatically).
4. Sign in as **Naomi Clarke** or **Tomas Berg** (reviewers), open **AI review**, check the result against the file, accept it, then look at the findings.
5. As the manager, open **Reports** and download the status report or the request's approved data pack.

AI extraction is on for the demo tenant. Turn on the external model in **Settings** (as Priya Raman) only if you have set a key for your provider (`GEMINI_API_KEY`, or `DEEPSEEK_API_KEY` and `DEEPSEEK_MODEL` with `LLM_PROVIDER=deepseek`).

## Stress-test files: `samples/messy/`

Eight fictional trial balances in the awkward layouts different countries send, each with a known correct answer (`truth.json`).
Regenerate with `python3 scripts/make-messy-samples.py`; score the extraction agent with `python scripts/score-messy-samples.py`.

| File | What is awkward about it |
|---|---|
| `mx_balanza_mxn.xlsx` | Spanish headers (Cuenta, Descripción, Debe, Haber), title block, "Totales" row |
| `de_saldenliste_eur.xlsx` | German headers; numbers stored as text in European format (`1.234.567,89`) |
| `fr_balance_eur.xlsx` | French headers; thousands separated by non-breaking spaces, decimal commas, as text |
| `us_signed_balance.xlsx` | One signed balance column, negatives in parentheses as text |
| `uk_with_prior_year.xlsx` | Current-year and prior-year columns side by side (prior year must be ignored) |
| `ca_header_row9_notes.xlsx` | Header on row 9, a hidden scratch sheet, sign-off and note lines under the table |
| `sg_currency_text.xlsx` | `Dr (SGD)` / `Cr (SGD)` headers, `S$1,200.00` text amounts, dashes for blanks |
| `br_two_entities_stacked.xlsx` | Portuguese and Spanish headers, two entities stacked on one sheet (must become two results) |

The plain-code path (no AI model) reads all eight exactly. A model is still needed for layouts that no header list anticipates.
