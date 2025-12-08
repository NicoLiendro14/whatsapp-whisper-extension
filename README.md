# WhatsApp Voice Message Transcriber

![Platform](https://img.shields.io/badge/Platform-WhatsApp%20Web-25D366?style=flat&logo=whatsapp&logoColor=white)
![Chrome](https://img.shields.io/badge/Chrome-Extension-4285F4?style=flat&logo=googlechrome&logoColor=white)
![OpenAI](https://img.shields.io/badge/OpenAI-Whisper-412991?style=flat&logo=openai&logoColor=white)

It's a Chrome extension that adds a "Transcribe" button to every voice message on WhatsApp Web. One click, and you've got the text. That's it. No apps to install, no audio files to download and upload somewhere else. It uses OpenAI's Whisper model under the hood, which handles pretty much any language you throw at it.


## What It Does

- **One-click transcription** directly in WhatsApp Web
- **Automatic language detection** Whisper figures out what language is being spoken
- **Copy to clipboard** so you can paste transcriptions wherever you need them

## Getting Started

You'll need two things: Chrome and an OpenAI API key. If you don't have one yet, [grab one here](https://platform.openai.com/api-keys). You'll be billed based on usagecheck [OpenAI's pricing](https://openai.com/pricing) for the current rates.

**To install:**

1. Clone or download this repo
   ```bash
   git clone https://github.com/nicoliendro14/whatsapp-whisper-extension.git
   ```

2. Open `chrome://extensions/` in Chrome, flip on **Developer mode** (top right), and click **Load unpacked**. Point it at the folder you just downloaded.

3. Click the extension icon in your toolbar and paste in your API key.

4. Head to [web.whatsapp.com](https://web.whatsapp.com/). You'll see a "📝 Transcribe" button next to each voice message. Click it.

## How It Actually Works

If you're just here to transcribe messages, you can stop reading. But if you're curious about the internals or want to contribute here's what's going on under the hood.

### The Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   content.js    │────▶│   injected.js   │────▶│  background.js  │
│ (Content Script)│     │  (Page Context) │     │(Service Worker) │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

Three scripts, three different execution contexts. The content script handles the UI and coordinates everything. The injected script taps into WhatsApp's internal modules to grab audio. The background script talks to OpenAI. They communicate through a mix of `postMessage` and Chrome's messaging APIs.

### Getting the Audio

Here's the interesting part. WhatsApp encrypts voice messages on their CDN using AES-CBC. But the web app obviously needs to decrypt them to play themso it has internal modules that handle all of this. We just... use those.

```javascript
// WhatsApp exposes internal modules via window.require()
const MsgCollection = window.require('WAWebMsgCollection').MsgCollection;
const DownloadManager = window.require('WAWebDownloadManager').downloadManager;

// Get the message, download and decrypt it
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

The `mediaKey` is used to derive the actual encryption key via HKDF. The `DownloadManager` handles all of that internally, so we don't have to implement the crypto ourselves.

### The Data Flow

When you click "Transcribe":

1. **content.js** extracts the message ID from the DOM (it's in a `data-id` attribute)
2. It passes that ID to **injected.js** via `postMessage`
3. **injected.js** uses WhatsApp's internals to download and decrypt the audio
4. The audio bytes get passed back to **content.js**, then forwarded to **background.js**
5. **background.js** packages it up and sends it to OpenAI's Whisper API
6. The transcription comes back through the same chain and gets displayed in the UI

The reason for this relay is browser security. The injected script can access `window.require()` but can't make cross-origin requests. The background script can hit external APIs but can't access page internals. So we need both.

## Project Structure

```
whatsapp-whisper-extension/
├── manifest.json       # Extension config (Manifest V3)
├── popup.html/js       # API key configuration
├── content.js          # UI injection, orchestration
├── injected.js         # WhatsApp module access
├── background.js       # OpenAI API calls
├── styles.css          # Styling
└── icons/              # Extension icons
```

## Security Notes

Your API key stays in `chrome.storage.local`sandboxed to the extension. Audio goes directly to OpenAI, not through any server I control. The extension doesn't store or log your messages. And since it uses WhatsApp's own decryption, it can only access messages you already have access to in your browser.

## Troubleshooting

**"API Key not configured"**  Click the extension icon and add your key.

**"Could not extract audio"**  The voice message might not be fully loaded. Try playing it for a second first, then retry.

**HTTP 401**  Your API key is invalid or expired. Double-check it.

**HTTP 429**  You've hit OpenAI's rate limit. Give it a minute.

**Buttons not appearing**  Make sure you're on `https://web.whatsapp.com`, not some other URL. Try refreshing. Check that the extension is enabled in `chrome://extensions`.

## Contributing

PRs welcome. Some ideas if you're looking for something to work on:

- Language selection (force a specific language instead of auto-detect)
- Firefox port
- Better error messages

**Fair warning:** WhatsApp updates their web app frequently. Module names change, DOM structures shift. If something breaks, that's usually why.

## Disclaimer

This isn't affiliated with WhatsApp or Meta. It relies on internal APIs that could change without notice. Use at your own risk.

## License

MIT. Do whatever you want with it.

---
