# Daily AI Usage Safety Limit

The backend enforces a server-side limit of **500,000 charged AI Tokens per player per UTC day**. Provider-reported token usage is authoritative. DeepSeek usage is multiplied during its configured peak-price periods before it is counted.

The iOS app creates a random safety identifier and stores it in Keychain separately from lives, settings, and future account data. The backend stores only a one-way hash of that identifier, recent daily totals, and an optional deleted-account timestamp. It does not store a player's name, story, prompts, or AI responses in this ledger.

Deleting game or account data must not clear `PlayerUsageIdentity`. A future account-deletion flow should call `APIService.recordAccountDeletionForSafety()` before removing account data; this preserves the hashed abuse-prevention tombstone and the current daily total.

## Render Production Setup

For deletion records and server totals to survive service replacements, attach a Render persistent disk mounted at `/var/data`, then set these environment variables:

```text
PLAYER_USAGE_LEDGER_PATH=/var/data/my-path-player-usage-v1.json
PLAYER_DAILY_AI_TOKEN_LIMIT=500000
PLAYER_QUOTA_SIGNING_SECRET=<a long random secret kept only in Render>
```

`PLAYER_QUOTA_SIGNING_SECRET` must remain stable. Rotating it invalidates existing signed quota receipts but does not erase records stored on the persistent disk.

Without a persistent disk, the signed Keychain receipt still prevents an ordinary player from resetting the same day's total by deleting local game data or during a backend redeploy. The disk is required for a fully server-retained deleted-account record.

The same persistent file now stores verified App Attest public keys and their latest assertion counters. A persistent disk is strongly recommended before `APP_ATTEST_ENFORCEMENT=required` is enabled. If a backend replacement loses the file, the iOS app recovers by generating and registering a new App Attest key, but repeated replacements can unnecessarily consume Apple's key-generation allowance.

App Attest rollout variables:

```text
APP_ATTEST_TEAM_ID=A8S98U9VW6
APP_ATTEST_BUNDLE_ID=com.brycebehncke.ageup
APP_ATTEST_REQUIRED_BUILD=172
APP_ATTEST_ENFORCEMENT=required
APP_ATTEST_ALLOW_DEVELOPMENT=false
```

Build 172 is available to testers, so production should use `required`. The `new-builds` option remains available only for a future staged rollout; it intentionally lets older clients through and must not be left enabled as the final security setting.
