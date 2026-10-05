# ESEM Reference Trace Analysis

Static dashboard for testing a regional reference PPA (as proposed for the ESEM) against NEM wind and solar farms.
Each farm's 5-min output is shown against a regional reference trace, and contract settlement is calculated three ways
against two versions of the trace, alongside the farm's merchant revenue. A nightly GitHub Actions run fetches AEMO
data, builds compact binary files in R and deploys the page to GitHub Pages. There is no server.

```
run.R                     nightly entry point: register -> months -> first generation -> changed years -> site/data
R/fetch_nem.R             NEMWeb: MMSDM monthly archive, plus daily reports for months MMSDM hasn't published yet
R/registry.R              wind and solar unit register from the MMSDM registration tables
R/build.R                 reference traces, settlement components, merchant, file writers
R/synthetic.R             synthetic NEM data in the same shape as the fetchers (demo build and tests)
R/wdb.R                   WDB1 binary container (writer + reader)
config/units_override.csv optional corrections to the register (duid, tech, cap_mw, name, exclude)
site/                     index.html, app.js, vendor/uPlot; site/data is generated
tests/check_reference.R   independent recomputation of baskets, traces, settlement components and merchant
.github/workflows/pages.yml
```

## Setup

1. Create a **public** repository and push this folder to `main`.
2. Settings > Pages > Build and deployment > Source: **GitHub Actions**.
3. The push triggers the workflow. With no `DATA_SOURCE` variable it deploys the **synthetic** demo
   (about 30 minutes on the first run, mostly generating six years of 5-min data for ~150 units).
4. Set the repository variable `DATA_SOURCE = aemo` (Settings > Secrets and variables > Actions > Variables) and run the
   workflow from the Actions tab. The first AEMO run downloads six years of MMSDM months (DISPATCHLOAD is about
   100 MB a month), so allow a couple of hours; nightly runs after that fetch new days and rebuild the current year.

Optional repository variables: `START_YEAR` (first reporting year; default 2018 for `aemo`) and `YEARS_BACK` (used when `START_YEAR` is unset; default 5, which is what the synthetic demo uses). History is fetched from the year before the first reporting year. "Run workflow" has a **force** tick box.

Each run stops starting new month downloads after `FETCH_MINUTES` (default 210) so a long backfill finishes inside the
job limit and saves its progress; the next run carries on. The log ends with a fetch report (`fetch report: cached …,
mmsdm …, FAILED …`) listing any month that could not be fetched and why, and the same table is saved to the data
release as `fetch_report.md`.

## Data

| Item | Source |
| --- | --- |
| Units in scope | `GENUNITS.CO2E_ENERGY_SOURCE` (wind or solar) via the latest `DUALLOC`, semi-scheduled generators per `DUDETAILSUMMARY` |
| Sent-out generation | `DISPATCH_UNIT_SCADA.SCADAVALUE` |
| Dispatch | `DISPATCHLOAD` (intervention 0): `INITIALMW`, `TOTALCLEARED`, `AVAILABILITY`, `UIGF` (UIGF is missing from older files; `AVAILABILITY` stands in) |
| Price | `DISPATCHPRICE.RRP` from 5MS (intervals ending 1 Oct 2021 04:05 on); `TRADINGPRICE.RRP` before, spread over its six 5-min intervals |
| Capacity | `DUDETAIL.REGISTEREDCAPACITY` by effective date (`MAXCAPACITY` if blank) |
| Registration date | earliest `DUDETAILSUMMARY.START_DATE` / `DUDETAIL.EFFECTIVEDATE` |
| First generation | first interval with SCADA of at least 1 MW in the fetched history (history starts a year before the first reporting year). Units already generating when the history starts use their registration date |

`INITIALMW` is fetched and cached but not published to the page.

## Calculations

**Reference basket**, set on 1 January for each region and technology: units registered by that date, not deregistered,
and first generating on or before 1 July of the prior year (at least 6 months operational). Capacity is fixed at
the 1 January value.

**Reference traces** (capacity factor per 5-min interval):

- *Sent-out*: sum of basket SCADA (clamped to 0 – capacity) ÷ sum of basket capacity.
- *UIGF on negative*: the same, but each unit's UIGF replaces SCADA in intervals where the regional price is negative.

A basket unit with missing data in an interval is dropped from numerator and denominator for that interval only.

**Settlement** per interval = trace CF × Q × (K − floating) × 5/60, summed by billing week (Sunday–Saturday, market time).
Weekly statistics (SD, downside SD, P10, worst week) use complete weeks only: at least 90% of intervals with a price and farm SCADA. P10 is the 10th percentile of weekly net revenue (the low tail). Downside SD = √mean(min(x − mean, 0)²).
Positive is paid to the generator.

| Approach | Floating price | Quantity |
| --- | --- | --- |
| A · Exposed | spot | Q |
| B · Cap + floor | spot clamped to [floor, cap], default [$0, $600] | Q |
| C · Cap + knockout | min(spot, cap) | 0 when spot < 0 |

The UIGF trace differs from the sent-out trace only in negative-price intervals, so it cannot change approach C.

**Merchant** = farm SCADA (≥ 0) × max(spot, 0) × 5/60, i.e. floored at zero when the price is negative.
**Net revenue** = merchant + settlement.

The farm tabs compute settlement in the browser from the 5-min data, so the fixed price, quantity, cap and floor are
all editable. The fleet tab uses weekly components precomputed at the $600 cap and $0 floor (any fixed price works,
since settlement is linear in K).

## Local use

```sh
Rscript -e 'install.packages(c("data.table", "jsonlite"))'
DATA_SOURCE=synthetic Rscript run.R          # or DATA_SOURCE=aemo
python3 -m http.server -d site 8000          # open http://localhost:8000
Rscript tests/check_reference.R 2024 SA1     # independent check of one region-year (synthetic cache)
```

## Known gaps

- Live NEMWeb downloads from GitHub's runners have not been tested. If NEMWeb throttles GitHub's IP ranges, run the
  job on a self-hosted runner (`runs-on`).
- The register relies on `CO2E_ENERGY_SOURCE`; check the unit list on the first AEMO build and use
  `config/units_override.csv` for anything misclassified (hybrids, co-located batteries).
- The ESEM contract design is still being finalised; the basket and settlement rules here are the ones specified for
  this analysis, not a published term sheet.
- Data is AEMO's; keep the source attribution shown in the page footer.
