# Creator Codes

Creator codes are stored only in the My Path backend. The iPhone app can redeem
them, but it cannot list, inspect, or create valid codes.

## Add or change codes

1. Open the `my-path-backend` service in Render.
2. Open **Environment**.
3. Add or edit the environment variable named `CREATOR_CODES_JSON`.
4. Paste one JSON object containing every active code.
5. Choose **Save, rebuild, and deploy**.

Example:

```json
{
  "BRYCE-LAUNCH-2026": {
    "id": "launch-2026",
    "title": "Launch Gift",
    "message": "Thanks for playing My Path.",
    "repeatable": false,
    "minimum_build": 168,
    "starts_at": "2026-08-01T00:00:00Z",
    "expires_at": "2026-12-31T23:59:59Z",
    "rewards": [
      { "type": "ai_tokens", "amount": 200000 },
      { "type": "custom_life_access", "hours": 24 },
      { "type": "dlc", "id": "walker_apocalypse" },
      { "type": "cash", "amount": 10000 },
      { "type": "stat", "id": "happiness", "amount": 10 }
    ]
  }
}
```

Use a unique `id` whenever a code should only work once on a device. Set
`repeatable` to `true` only when the same player should be allowed to redeem it
again. Spaces, punctuation, hyphens, and letter case do not affect matching.

## Reward types

| Type | Required value | Effect |
| --- | --- | --- |
| `ai_tokens` | `amount` | Adds AI Tokens immediately. |
| `cash` | `amount` | Adds life money, or queues it until a life is open. |
| `custom_life_access` | `hours` | Temporarily unlocks Custom Life and Take Over a Life. |
| `dlc` | `id` | Unlocks one DLC. |
| `all_dlcs` | none | Unlocks every DLC. |
| `stat` | `id`, `amount` | Changes one life stat, or queues it until a life is open. |

Valid stat IDs are `health`, `happiness`, `intelligence`, `charm`, `fitness`,
and `reputation`.

Valid DLC IDs are `ancient_egypt`, `ancient_greece`, `ancient_rome`,
`ancient_americas`, `middle_ages`, `industrial_age`, `modern_age`,
`walker_apocalypse`, `grimdark_war_world`, and `galactic_frontier`.

The optional `starts_at` and `expires_at` values use UTC ISO 8601 dates. The
optional `minimum_build` prevents older app builds from redeeming a code.

## Safety limits

- A code must contain at least six letters or numbers.
- A code can contain up to 12 rewards.
- Invalid attempts are limited to 15 per IP address every 10 minutes.
- The backend never returns the list of valid codes.
- Redeeming a code does not spend AI Tokens.
