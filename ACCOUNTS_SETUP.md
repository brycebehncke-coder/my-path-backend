# Player Accounts and Custom-Life History

Lives Discovered uses the existing Jackpot Cloudflare Worker and D1 database,
behind AgeUp's existing App Attest-protected Render routes. AgeUp records live in
separate `ageup_*` tables; Jackpot accounts, balances, saves, and login identities
are not merged or modified. Do not advertise availability solely because an iOS
build passes or reaches TestFlight. Provider sign-in requires separate activation.

## Hosting

Set `AGEUP_SHARED_STORE_ENABLED=true` on the existing Render service. It uses the
already configured `JACKPOT_WORKER_ORIGIN` and `JACKPOT_BRIDGE_SECRET`. The AgeUp
bridge has a separate signature domain and accepts a fixed operation list, never
arbitrary SQL. Only Render can call it; app requests still require App Attest or
Play Integrity. The Worker applies operation-level validation and atomic D1 batches.
Do not create another PostgreSQL database for this deployment. The older PostgreSQL
adapter remains available only for separately configured installations.

Apply only `0015_ageup_discoveries.sql` on the existing Worker database. Some older
Jackpot migrations were applied manually and still appear pending; do not run all
pending migrations blindly. The October 7 release uses
`releases/ageup-20261007/wrangler.jsonc` to wrap the verified live Jackpot runtime,
excluding unrelated pending local game changes. The source index also includes
the new AgeUp route for later coordinated deployments.

These account tables do not create wallets or grant tokens. Keep
`PLAYER_QUOTA_SIGNING_SECRET` stable. Set `ACCOUNT_ENCRYPTION_KEY` to a secret
32-byte random value encoded as base64; back it up securely. It encrypts the
provider tokens required for account revocation. Never put these values in the app.

## Apple

Sign in with Apple is enabled on `com.brycebehncke.ageup` as of September 29, 2026.
The app entitlement is added and the new `AgeUp App Store Accounts 299` distribution
profile includes it. Create a dedicated Sign in with Apple key in Apple
Developer, associated with this primary App ID. This is not the App Store Connect
upload key. Set `APPLE_SIGN_IN_KEY_ID`, `APPLE_SIGN_IN_PRIVATE_KEY`, and
`APPLE_SIGN_IN_TEAM_ID` on the server. `APPLE_SIGN_IN_CLIENT_ID` defaults to the app
bundle ID. A real device/provider sign-in and deletion must pass before enabling
the Apple button publicly.

## Google

Create a Google OAuth web client and configure its consent screen, verified
domain, support/privacy links and production audience. Register the exact redirect
`https://<backend-host>/v1/accounts/google/callback`. Set that HTTPS origin as
`ACCOUNT_PUBLIC_ORIGIN`; set `GOOGLE_SIGN_IN_CLIENT_ID` and
`GOOGLE_SIGN_IN_CLIENT_SECRET` on the server. The iOS browser sign-in returns through
`com.brycebehncke.ageup.auth://sign-in`; the app never receives the client secret.
Google and Apple identities remain separate accounts unless a future explicit
verified account-linking flow is implemented. Matching emails never merge them.

## Behavior and Limits

- Settings exposes username editing, sign-out, reauthentication and deletion.
- Sign-in is optional. Guest first-play credits are anonymous until the player
  signs in and chooses a username. Emails are not stored or displayed.
- Accounts do not yet sync saved lives, purchases or wallets between devices.
- Custom-life matching normalizes case, spacing and common request preambles.
  It does not semantically merge all paraphrases. Different details stay distinct.
- A server-signed receipt from a completed AI dossier and a successful local life
  launch are required. Retries for the same life or generation count only once.
- Failed generations do not increment the count. Pending registration does not
  block gameplay. Receipts expire after seven days; expired receipts cannot create
  retrospective credits. Earlier lives cannot truthfully establish global firsts.
- Build 300 checks server capability before sending history metadata. Older or
  unconfigured servers receive an ordinary generation request with no history
  fields. The short capability check is cached; it is not added to each story turn.
- Username moderation is server-enforced, case-insensitive and uses an English
  profanity/evasion filter plus reserved-name restrictions. It is not a guarantee
  that every offensive invention or other-language term is detected.
- The main-menu leaderboard is now Lives Discovered. The protected
  `/v1/custom-lives/discoveries` POST returns newest-first pages (30 rows by default,
  maximum 50), with an opaque `next_cursor` for subsequent requests. Every row
  includes its public title, first player's current username, verified play count,
  and actual discovery timestamp, not an in-game historical date.
- New dossiers include a short `public_title` in the same AI request. Signed
  receipts carry that title, and the database stores it without storing the full
  custom request. Titles with obvious contact details, links, or profanity are not
  published. Older receipts still work; older untitled entries appear as
  "Custom life" until a newly titled play of the same scenario supplies a label.
  Title similarity does not merge distinct custom requests or change counts.
- Re-run migrations and deploy the updated `accounts.mjs` and `server.mjs` before
  enabling the discoveries list. The iOS page reports unavailability honestly on
  an older/unconfigured server; it never presents sample rows as real discoveries.
- Account deletion revokes the provider credential, removes username and sessions,
  and anonymizes historical credit while retaining aggregate counts and safety
  limits. Require recent sign-in before deletion.

## Verification Before Activation

Run `npm test` and `node test/ageup-worker-smoke.mjs` in the Worker project.
The latter uses isolated real workerd/D1, tests concurrent registrations, duplicate
receipts, attribution, deletion, provider-flow persistence, and tied-date pagination.
It does not contact production or make actual provider sign-ins. Also test
real Apple and Google login/cancel/rename/logout/relogin/delete on device, offline
registration retry, and two installations creating the same custom life. Update
App Store privacy disclosures and the website privacy policy for account identifiers
and public usernames, discovery titles/counts/dates before activating accounts.
Review public-title moderation/report handling before a public release. Reusing the
existing service avoids another fixed database subscription; existing Cloudflare
usage limits and billing still apply. Uploading iOS does not deploy the backend.
