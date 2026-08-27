# Lab Rats Backend

Express API wrapping the 7 request/response tools across all 4 rats.
No wallet signing anywhere — every endpoint is a read-only GET, since
these tools only ever read public ledger data.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/api/twitch/entry/:issuer?wallet=r...` | Entry timing check |
| GET | `/api/twitch/exit/:issuer?wallet=r...` | Exit timing check |
| GET | `/api/whiskers/snipe/:issuer` | Bot/snipe detector |
| GET | `/api/doc/liquidity/:issuer` | Liquidity health check |
| GET | `/api/doc/holders/:issuer` | Holder concentration |
| GET | `/api/squint/growth/:issuer` | Holder growth trend |
| GET | `/api/squint/pattern/:issuer` | Pattern match |
| GET | `/health` | Basic uptime check |

`wallet` query param is optional on Twitch's routes — omit it to just see
the general leaderboard/stats without a personal comparison.

## Setup

```bash
npm install
cp .env.example .env
npm start
```

## Not included here: Dev Wallet Watcher

Whiskers' Dev Wallet Watcher is fundamentally different from the other 7
— it's a persistent live listener, not a single request/response. It
doesn't fit cleanly into a normal REST endpoint. It runs as its own
standalone script (see `dev_watch.js` from the original tools folder) and
should be deployed as a **separate Railway service** — same pattern as
Ripplets' `runCycle.js` — rather than wired into this API.

## Honest limitations carried over from the standalone scripts

- Built for **fresh launches** — pools older than 7 days may show
  incomplete results due to the ~100-transaction pagination window on
  AMM history (each response includes a `warning` field when this applies).
- Squint's Pattern Match is a heuristic based on a handful of rules, not
  a model trained on real historical launch data — see the tool's own
  README for the full honesty note.
- Squint's Holder Growth counts genuine trustline creates/deletes (not
  just any TrustSet), but high churn usually reflects bot cycling
  (open → snipe → sell → close to reclaim the reserve), not real holders
  losing interest — the `highChurn` flag calls this out explicitly.
