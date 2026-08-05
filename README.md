# AgeUp Backend

This is the small backend server your iPhone app should talk to instead of storing AI provider keys in the app.

## What it does

- keeps your real `OPENAI_API_KEY` and `DEEPSEEK_API_KEY` on the server only
- receives requests from the app at `POST /v1/chat/completions`
- forwards `gpt-4o-mini` to OpenAI
- forwards `deepseek-v4-pro` directly to DeepSeek
- disables DeepSeek thinking mode for lower latency and token cost
- adapts the app's strict JSON schemas to DeepSeek JSON mode
- marks DeepSeek's 01:00-04:00 and 06:00-10:00 UTC peak windows so the app charges 2x AI Tokens
- sends the response back to the app
- exposes `GET /v1/health/ai?model=...` so the app can verify the selected provider
- keeps `GET /v1/health/openai` for older builds
- verifies App Attest registrations and request assertions before protected operations
- binds each assertion to the exact HTTP method, path, request body, and a short-lived server challenge
- persists App Attest public keys and monotonic counters to reject replayed requests
- verifies Android standard Play Integrity tokens with Google's server API
- binds Android proofs to the exact method, path, and request body before accepting AI or account requests
- requires a Play-recognized app, trusted device, and licensed Google Play installation
- accepts in-app AI content reports required for Google Play generative-AI apps
- keeps only anonymous daily counts by report category and AI model; report requests contain no story text, fingerprint, language, event ID, or persistent player record

## First-time setup

1. Open Terminal.
2. Go to the backend folder:

```bash
cd '/Applications/My Path/backend'
```

3. Copy the example env file:

```bash
cp .env.example .env
```

4. Open `.env` and paste your OpenAI and DeepSeek API keys.

Example:

```env
OPENAI_API_KEY=sk-...
DEEPSEEK_API_KEY=sk-...
PORT=3000
```

Production also requires the App Attest and persistent-ledger values documented in `PLAYER_USAGE_LIMITS.md`.

### Android Play Integrity setup

After the Android app exists in Play Console:

1. Link Play Integrity to a Google Cloud project.
2. Enable the Play Integrity API in that project.
3. Create a service account with permission to decode integrity tokens.
4. Store its complete JSON credential as the secret `GOOGLE_SERVICE_ACCOUNT_JSON`.
5. Copy the Play app-signing SHA-256 digest into `PLAY_INTEGRITY_CERTIFICATE_SHA256_DIGESTS`.
6. Keep `PLAY_INTEGRITY_PACKAGE_NAME=com.brycebehncke.ageup` and `PLAY_INTEGRITY_ENFORCEMENT=required` in production.

The backend checks the request package and hash first, then requires `PLAY_RECOGNIZED`, `MEETS_DEVICE_INTEGRITY`, and `LICENSED`. Standard Play Integrity requests also receive Google's automatic replay protection. Never set the Android platform header or integrity token from a web client.

### AI content reports

The report endpoint accepts only a report category, source area, and selected AI model. It rejects story text, content fingerprints, language, and event identifiers. Per-player rate-limit keys exist only in process memory and are not written to disk; the only retained report state is an anonymous in-memory aggregate count for the current server process.

## Run the backend locally

From the backend folder, run:

```bash
npm run dev
```

If it works, you should see something like:

```text
AgeUp backend listening on http://0.0.0.0:3000
```

## Test the backend locally

In another Terminal window:

```bash
curl http://127.0.0.1:3000/v1/health/openai
curl 'http://127.0.0.1:3000/v1/health/ai?model=deepseek-v4-pro'
```

If each key is set correctly, the matching endpoint returns JSON naming its model and provider.

## Point the app at the backend

### iPhone Simulator
Use this in `/Applications/My Path/My-Path-Info.plist`:

```text
http://127.0.0.1:3000
```

### Real iPhone on your Wi-Fi
Use your Mac's local IP address instead, for example:

```text
http://192.168.1.25:3000
```

Then set `BACKEND_API_BASE_URL` in `/Applications/My Path/My-Path-Info.plist` to that URL.

## Important

- never put either provider key into the iPhone app
- never put the Google service-account JSON into either mobile app
- always keep it only in `.env` on the backend
- `.env` should never be committed or shared

## What this backend does NOT do yet

This is the safe minimum.

Later, you should add:
- player authentication
- ad verification
- purchase verification
- server-side token balance checks
- logging and spending caps
