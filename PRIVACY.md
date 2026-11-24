# Privacy Policy: WhatsApp Audio Transcriber

Effective date: 2026-11-23

This extension transcribes WhatsApp Web voice messages. To do that, the audio has to leave your browser. This page explains what is sent, where it goes, and how long it is kept.

## What leaves your browser

No audio is sent until you click a transcribe button. When you click one, the extension sends:

- **The audio of that one voice message.** This is either a message in a chat or a recording you are making. Nothing else from the chat is sent. Your messages, contacts, phone number and chat names stay on your device.
- **A random client ID.** The extension creates this ID when it is installed. It is not linked to your WhatsApp account or your identity. It is used only to count your free transcriptions.
- **Your license key, if you entered one.** The key is used to check your Pro plan.

The extension also sends your client ID and license key, but no audio, when it checks your usage. It does this when you open the popup or save a license key.

## Where it goes

All requests go to the extension's own server, which runs on Cloudflare Workers.

- **Audio** goes to Cloudflare Workers AI. It is transcribed there with the Whisper speech-recognition model (`whisper-large-v3-turbo`). The transcript comes straight back to your browser. Our server does not save the audio or the transcript.
- **License keys** go to Polar (polar.sh) to check that they are valid. Polar is the merchant of record. Polar handles checkout and payment, so we never see your card details. Purchases are covered by Polar's own privacy policy.

Cloudflare handles network traffic for the server, so it sees standard request details such as your IP address. Cloudflare's privacy policy covers that data. Our server code does not read or store your IP address.

## What is stored, and for how long

**On our server** (Cloudflare KV):

| Data | Kept for |
|---|---|
| Today's transcription count, stored with your client ID (free plan) or your license key (Pro) | Until 24 hours after your last transcription that day |
| Your license key and whether it was valid | 24 hours if it was valid, 10 minutes if it was not |

**In your browser** (`chrome.storage.local`, on your device only):

- Your client ID, your license key, your plan status and your karaoke timing setting.
- Your recent transcripts, each stored under its WhatsApp message ID, so they appear again without sending the audio a second time. A transcript is deleted after 7 days. At most 500 are kept.
- A count of today's transcriptions.

## What we never do

- We never collect your messages, contacts, phone number or other chat content.
- We never save your audio or your transcripts on our server.
- We never sell your data or share it for advertising.
- We do not use analytics or tracking.

## Your controls

- No audio is sent unless you click transcribe.
- Uninstalling the extension deletes everything it stored in your browser.
- Data on our server expires on its own within 24 hours of your last request.

## Contact

Questions or requests: open an issue at https://github.com/NicoLiendro14/whatsapp-whisper-extension/issues
