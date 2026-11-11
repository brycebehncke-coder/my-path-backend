# Age Up LLC Identity Compatibility

The original Age Up App Attest identity remains supported. The additional
allowed identity is exactly `4S5597VQ7U.com.behnckemobilegames.ios.ageup`.
Assertions still verify signatures, the request payload, device ownership,
and advancing counters. No caller can select an arbitrary team or bundle.

The original `APPLE_SIGN_IN_*` environment variables remain unchanged.
New LLC native sign-in uses `APPLE_SIGN_IN_LLC_KEY_ID` and
`APPLE_SIGN_IN_LLC_PRIVATE_KEY`; the team and bundle are fixed by source.
Both credential sets are server-only. `ACCOUNT_ENCRYPTION_KEY` must remain
stable to decrypt previously stored provider grants.

Apple authorization-code exchange is bound to the verified identity-token
audience. The exchanged token must have that same audience, subject, and
nonce. LLC subjects have a separate namespace; email addresses never merge
accounts across developer teams. New encrypted revocation envelopes retain
their original client ID. Legacy encrypted raw refresh tokens still use the
original client and credentials.

Run `npm test` and the unchanged `chomp-rooms.test.mjs` suite before deploying.
No Jackpot gateway, AI behavior, wallet policy, or existing game route changes.
