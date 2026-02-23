# WA Transcribe Worker

Cloudflare Worker that proxies transcription requests to Workers AI (Whisper). Provides a free tier with rate limiting so the extension works without requiring users to bring their own API key.

## Architecture

```
Extension → Worker (rate limit + auth) → Cloudflare Workers AI (Whisper Large v3 Turbo)
                ↕
          Cloudflare KV (usage counters)
```

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free)
- Node.js 18+
- npm or pnpm

## Setup

```bash
cd worker

# Install dependencies
npm install

# Login to Cloudflare
npx wrangler login

# Create the KV namespace for rate limiting
npx wrangler kv namespace create RATE_LIMIT
```

Copy the namespace ID from the output and paste it into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "paste-your-id-here"
```

## Deploy

```bash
npx wrangler deploy
```

This gives you a URL like `https://wt-transcribe.your-username.workers.dev`.

## Connect to the extension

Open `background.js` in the extension root and update:

```javascript
const CLOUDFLARE_WORKER_URL = 'https://wt-transcribe.your-username.workers.dev';
```

## Endpoints

### `POST /transcribe`

Transcribes audio using Whisper Large v3 Turbo.

**Headers:**
- `X-Client-ID` (required): UUID identifying the extension installation

**Body:** `multipart/form-data` with a `file` field containing the audio

**Response:**
```json
{
  "success": true,
  "text": "transcribed text here",
  "language": "es",
  "used": 5,
  "limit": 20,
  "remaining": 15
}
```

### `POST /usage`

Returns current usage for a client.

**Headers:**
- `X-Client-ID` (required)

**Response:**
```json
{
  "used": 5,
  "limit": 20,
  "remaining": 15
}
```

## Rate Limits

- Free tier: 20 transcriptions per day per client UUID
- Counters reset daily (TTL-based expiration in KV)
- Max file size: 25 MB

## Costs

| Component | Free Tier |
|---|---|
| Worker requests | 100,000/day |
| KV reads | 100,000/day |
| KV writes | 1,000/day |
| Workers AI | 10,000 neurons/day (~25 min audio) |

With < 100 daily active users, everything stays within free tier.

## Local Development

```bash
npx wrangler dev
```

This starts a local server at `http://localhost:8787`. Update `CLOUDFLARE_WORKER_URL` in the extension to this URL for testing.
