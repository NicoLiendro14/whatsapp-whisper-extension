# WhatsApp Audio Transcriber

![Platform](https://img.shields.io/badge/Platform-WhatsApp%20Web-25D366?style=flat&logo=whatsapp&logoColor=white)
![Chrome](https://img.shields.io/badge/Chrome-Extension-4285F4?style=flat&logo=googlechrome&logoColor=white)
![Cloudflare](https://img.shields.io/badge/Cloudflare-Workers%20AI-F38020?style=flat&logo=cloudflare&logoColor=white)

A Chrome extension for WhatsApp Web that does two things: transcribes voice messages you receive, and transcribes your own voice recordings before you send them. It uses Cloudflare Workers AI (Whisper large-v3-turbo) for transcription, detects the language automatically, and it's completely free — no API key needed.

## What It Does

- **Transcribe received voice messages** — Adds a "Transcribe" button next to every voice message. Click it, get the text.
- **Transcribe your own recordings** — While recording a voice message, a "Transcribe to Text" button appears. Click it to convert your recording to text so you can send it as a message instead.

Both features auto-detect the language, support copy to clipboard, and cache results locally so you don't waste transcriptions on the same audio twice.

## Getting Started

You just need Chrome. That's it. No API keys, no accounts, no setup.

**To install:**

1. Clone or download this repo
   ```bash
   git clone https://github.com/nicoliendro14/whatsapp-whisper-extension.git
   ```

2. Open `chrome://extensions/` in Chrome, flip on **Developer mode** (top right), and click **Load unpacked**. Point it at the folder you just downloaded.

3. Head to [web.whatsapp.com](https://web.whatsapp.com/). You'll see a "📝 Transcribe" button next to each voice message. While recording, you'll see a "Transcribe to Text" button.

There's a free tier of 30 transcriptions per day. No sign-up required.

## How It Actually Works

If you're just here to transcribe messages, you can stop reading. But if you're curious about the internals or want to contribute — here's what's going on under the hood.

### The Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   content.js    │────▶│   injected.js   │────▶│  background.js  │────▶│ Cloudflare Worker│
│ (Content Script)│     │  (Page Context) │     │(Service Worker) │     │  (Workers AI)   │
└─────────────────┘     └─────────────────┘     └─────────────────┘     └─────────────────┘
```

Four pieces working together. The content script handles the UI and coordinates everything. The injected script taps into WhatsApp's internal modules to grab audio. The background script forwards requests. The Cloudflare Worker runs the actual transcription using Whisper large-v3-turbo.

### Getting the Audio (received messages)

WhatsApp encrypts voice messages on their CDN using AES-CBC. But the web app obviously needs to decrypt them to play them — so it has internal modules that handle all of this. We just... use those.

```javascript
const MsgCollection = window.require('WAWebMsgCollection').MsgCollection;
const DownloadManager = window.require('WAWebDownloadManager').downloadManager;

const msg = MsgCollection.get(msgId);
const arrayBuffer = await DownloadManager.downloadAndMaybeDecrypt({
  directPath: msg.directPath,
  encFilehash: msg.encFilehash,
  filehash: msg.filehash,
  mediaKey: msg.mediaKey,
  mediaKeyTimestamp: msg.mediaKeyTimestamp,
  type: msg.type
});
```

The `mediaKey` is used to derive the actual encryption key via HKDF. The `DownloadManager` handles all of that internally.

### Getting the Audio (your own recordings)

For outgoing recordings, the extension intercepts `getUserMedia` early (via `injected-early.js` at `document_start`) and runs a parallel `MediaRecorder` alongside WhatsApp's own recorder. When you click "Transcribe to Text", it grabs the captured audio chunks and sends them through the same transcription pipeline.

### The Transcription Pipeline

Audio goes from the extension → Cloudflare Worker → Cloudflare Workers AI (Whisper large-v3-turbo). No data is stored on any server. The worker handles rate limiting via Cloudflare KV (30 transcriptions/day per anonymous client ID).

## Project Structure

```
whatsapp-whisper-extension/
├── manifest.json          # Extension config (Manifest V3)
├── popup.html/js          # Usage dashboard
├── content.js             # UI injection, orchestration
├── injected.js            # WhatsApp module access (voice messages)
├── injected-early.js      # getUserMedia interception (recordings)
├── background.js          # Cloudflare Worker API calls
├── styles.css             # Styling
├── worker/                # Cloudflare Worker source
│   └── src/index.js       # Transcription endpoint + rate limiting
└── icons/                 # Extension icons
```

## Security & Privacy

Each install gets an anonymous UUID — no accounts, no personal data. Audio goes directly to Cloudflare Workers AI for transcription and is not stored anywhere. The extension doesn't log or persist your messages. Results are cached locally in your browser for 7 days to avoid redundant API calls.

## Troubleshooting

**"Daily limit reached"** — You've hit 30 transcriptions for today. Resets at midnight UTC.

**"Could not extract audio"** — The voice message might not be fully loaded. Try playing it for a second first, then retry.

**Buttons not appearing** — Make sure you're on `https://web.whatsapp.com`. Try refreshing. Check that the extension is enabled in `chrome://extensions`.

## Contributing

PRs welcome. Some ideas:

- Firefox port
- Adjustable playback speed for voice messages
- Summary mode for long voice messages

**Fair warning:** WhatsApp updates their web app frequently. Module names change, DOM structures shift. If something breaks, that's usually why.

## Disclaimer

This isn't affiliated with WhatsApp, Meta, or Cloudflare. It relies on internal APIs that could change without notice. Use at your own risk.

## License

MIT. Do whatever you want with it.
