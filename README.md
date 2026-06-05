# My Path Backend

This is the small backend server your iPhone app should talk to instead of storing an OpenAI API key in the app.

## What it does

- keeps your real `OPENAI_API_KEY` on the server only
- receives requests from the app at `POST /v1/chat/completions`
- forwards them to OpenAI
- sends the response back to the app
- exposes `GET /v1/health/openai` so the app can verify the backend is working

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

4. Open `.env` and paste your NEW OpenAI API key.

Example:

```env
OPENAI_API_KEY=sk-...
PORT=3000
```

## Run the backend locally

From the backend folder, run:

```bash
npm run dev
```

If it works, you should see something like:

```text
My Path backend listening on http://0.0.0.0:3000
```

## Test the backend locally

In another Terminal window:

```bash
curl http://127.0.0.1:3000/v1/health/openai
```

If your key is set correctly, you should get JSON saying the backend can reach OpenAI.

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

- never put the OpenAI key back into the iPhone app
- always keep it only in `.env` on the backend
- `.env` should never be committed or shared

## What this backend does NOT do yet

This is the safe minimum.

Later, you should add:
- player authentication
- rate limits
- ad verification
- purchase verification
- server-side token balance checks
- logging and spending caps
