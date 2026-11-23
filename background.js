const CLOUDFLARE_WORKER_URL = 'https://wt-transcribe.nicolasliendro0697.workers.dev';

// ── Install: generate a persistent client ID ──

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['clientId'], (result) => {
    if (!result.clientId) {
      chrome.storage.local.set({ clientId: crypto.randomUUID() });
      console.log('[WT] Generated new client ID');
    }
  });
});

// ── Message router ──

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'transcribe') {
    handleTranscription(message.audioData, message.mimeType)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'getProviderInfo') {
    getProviderInfo()
      .then(info => sendResponse(info))
      .catch(() => sendResponse({ provider: 'none', ready: false }));
    return true;
  }

  if (message.action === 'getUsage') {
    getCloudflareUsage()
      .then(usage => sendResponse(usage))
      .catch(() => sendResponse(null));
    return true;
  }
});

// ── Provider detection ──

async function getProviderInfo() {
  let { clientId } = await chrome.storage.local.get(['clientId']);

  if (!clientId) {
    clientId = crypto.randomUUID();
    await chrome.storage.local.set({ clientId });
    console.log('[WT] Generated client ID on demand');
  }

  return { provider: 'cloudflare', ready: true, clientId };
}

async function getClientId() {
  let { clientId } = await chrome.storage.local.get(['clientId']);
  if (!clientId) {
    clientId = crypto.randomUUID();
    await chrome.storage.local.set({ clientId });
  }
  return clientId;
}

// Identifies the request to the worker. The client ID meters the free tier;
// the licence key, when present, is what the worker validates against Polar.
async function authHeaders() {
  const clientId = await getClientId();
  const { wt_license_key: licenseKey } = await chrome.storage.local.get(['wt_license_key']);
  return {
    'X-Client-ID': clientId,
    ...(licenseKey ? { 'X-License-Key': licenseKey } : {})
  };
}

// ── Transcription ──

async function handleTranscription(audioData, mimeType = 'audio/ogg') {
  return transcribeWithCloudflare(audioData, mimeType, await authHeaders());
}

async function transcribeWithCloudflare(audioData, mimeType, headers) {
  try {
    const uint8Array = new Uint8Array(audioData);
    const audioBlob = new Blob([uint8Array], { type: mimeType });
    const extension = getFileExtension(mimeType);

    const formData = new FormData();
    formData.append('file', audioBlob, `audio.${extension}`);

    const response = await fetch(`${CLOUDFLARE_WORKER_URL}/transcribe`, {
      method: 'POST',
      headers,
      body: formData
    });

    const data = await response.json();

    if (!response.ok) {
      if (response.status === 429 && data.code === 'DAILY_LIMIT') {
        return {
          success: false,
          error: data.pro
            ? `Limit reached (${data.limit}/${data.limit}).`
            : `Daily free limit reached (${data.limit}/${data.limit}). Upgrade for more.`,
          code: 'DAILY_LIMIT',
          pro: data.pro,
          used: data.used,
          limit: data.limit
        };
      }
      throw new Error(data.error || `HTTP Error ${response.status}`);
    }

    return {
      success: true,
      text: data.text,
      language: data.language,
      words: data.words,
      pro: data.pro,
      provider: 'cloudflare',
      used: data.used,
      limit: data.limit,
      remaining: data.remaining
    };

  } catch (error) {
    console.error('[WT] Cloudflare error:', error);
    return { success: false, error: error.message || 'Transcription service error' };
  }
}

// ── Usage ──

async function getCloudflareUsage() {
  try {
    const response = await fetch(`${CLOUDFLARE_WORKER_URL}/usage`, {
      method: 'POST',
      headers: await authHeaders()
    });

    if (!response.ok) return null;
    const usage = await response.json();
    // Mirror the server's verdict locally so the content script can render the
    // pro-only UI without asking again. The server stays the source of truth.
    await chrome.storage.local.set({ wt_pro: !!usage.pro });
    return usage;
  } catch {
    return null;
  }
}

// ── Utils ──

function getFileExtension(mimeType) {
  const mimeToExt = {
    'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
    'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/wav': 'wav',
    'audio/webm': 'webm', 'audio/x-m4a': 'm4a', 'video/webm': 'webm',
    'audio/opus': 'ogg'
  };
  return mimeToExt[mimeType] || 'ogg';
}

console.log('[WT] Service Worker started');
