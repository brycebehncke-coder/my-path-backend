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

The system is intended to stop ordinary accidental or deliberate overuse. Strong resistance to a modified client would additionally require an authenticated account or Apple App Attest.
