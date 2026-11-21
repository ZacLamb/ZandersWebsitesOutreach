# zw-prospector

Finds New England trade businesses with weak or no websites, excludes existing clients, scores them,
and stages them in the RGS GHL "50$ Sites" pipeline at **New Lead**. It never sends a text.

## Setup
1. `cp .env.example .env` and fill in `GOOGLE_PLACES_KEY` and `GHL_TOKEN` (Private Integration: contacts + opportunities scopes).
2. Put the current client sheet at `data/clients.csv` (kept out of git).
3. `npm test`

## Use
```
node src/run.js exclusions                      # sanity-check the client sheet
node src/run.js find --dry-run --max-queries 20 # see which searches would run
node src/run.js find --states MA --max-queries 40   # small first run
node src/run.js push --min-score 35 --max 1        # DRY RUN of one prospect
node src/run.js push --min-score 35 --max 1 --yes  # push ONE, then check it in GHL
node src/run.js push --min-score 35 --max 50 --yes
```
Outputs: `out/prospects.csv` (ranked A/B/C), `out/excluded.csv` (matched existing clients, with reason),
`out/pushed.json` (so nothing is pushed twice).

## Scoring
No site / Facebook-only / builder subdomain score highest, then own-domain sites with signals like
no mobile viewport, stale copyright year, thin content, no service-area pages. Reviewed, established
businesses get a small bonus. Tier A >= 60, B >= 35.

## Exclusion rules
Matches on phone (last 10 digits), business email domain (ignoring gmail/yahoo/etc.), and business
name (legal suffixes and spacing ignored). Re-run whenever the client sheet changes.

## Dashboard (Railway)
`npm start` runs a password-protected dashboard (Basic auth; username anything, password = `ADMIN_PASSWORD`).
Upload the client sheet, run searches, review ranked leads, preview/push to GHL. It never sends texts.

Env vars: `ADMIN_PASSWORD` (required, 8+ chars), `GOOGLE_PLACES_KEY`, `GHL_TOKEN`, `GHL_LOCATION_ID`,
`GHL_PIPELINE_ID`, `GHL_STAGE_NEW_LEAD`, `DATA_DIR` (point at a mounted volume, e.g. `/data`, so the
client sheet and results survive redeploys).
