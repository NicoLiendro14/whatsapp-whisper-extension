const OPENAI_API_URL = 'https://api.openai.com/v1/audio/transcriptions';

// TODO: Replace with your deployed Cloudflare Worker URL
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

  if (message.action === 'checkApiKey') {
    checkApiKeyExists()
      .then(exists => sendResponse({ exists }))
      .catch(() => sendResponse({ exists: false }));
    return true;
  }

  if (message.action === 'getDiagnostics') {
    chrome.tabs.query({ url: 'https://web.whatsapp.com/*' }, (tabs) => {
      if (!tabs || tabs.length === 0) {
        sendResponse({
          success: false,
          error: 'No WhatsApp Web tab found. Open web.whatsapp.com first.',
          backgroundInfo: {
            extensionId: chrome.runtime.id,
            manifestVersion: chrome.runtime.getManifest().version,
            extensionName: chrome.runtime.getManifest().name
          }
        });
        return;
      }

      const tab = tabs[0];
      chrome.tabs.sendMessage(tab.id, { action: 'getDiagnostics' }, (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({
            success: false,
            error: 'Content script not responding: ' + chrome.runtime.lastError.message,
            backgroundInfo: {
              extensionId: chrome.runtime.id,
              manifestVersion: chrome.runtime.getManifest().version,
              tabId: tab.id,
              tabUrl: tab.url,
              tabStatus: tab.status,
              hint: 'Content script may not be loaded. Try reloading WhatsApp Web.'
            }
          });
        } else {
          if (response && response.diagnostics) {
            response.diagnostics.extensionId = chrome.runtime.id;
            response.diagnostics.extensionVersion = chrome.runtime.getManifest().version;
          }
          sendResponse(response);
        }
      });
    });
    return true;
  }
});

// ── Provider detection ──

async function getProviderInfo() {
  let { openai_api_key, clientId } = await chrome.storage.local.get(['openai_api_key', 'clientId']);

  if (openai_api_key) {
    return { provider: 'openai', ready: true };
  }

  if (!clientId) {
    clientId = crypto.randomUUID();
    await chrome.storage.local.set({ clientId });
    console.log('[WT] Generated client ID on demand');
  }

  if (isCloudflareConfigured()) {
    return { provider: 'cloudflare', ready: true, clientId };
  }

  return { provider: 'none', ready: false };
}

function isCloudflareConfigured() {
  return !CLOUDFLARE_WORKER_URL.includes('YOUR_USERNAME');
}

async function checkApiKeyExists() {
  const result = await chrome.storage.local.get(['openai_api_key']);
  return !!result.openai_api_key;
}

async function getApiKey() {
  const result = await chrome.storage.local.get(['openai_api_key']);
  if (!result.openai_api_key) {
    throw new Error('API Key not configured. Click the extension icon to set it up.');
  }
  return result.openai_api_key;
}

async function getClientId() {
  const result = await chrome.storage.local.get(['clientId']);
  return result.clientId;
}

// ── Transcription routing ──

async function handleTranscription(audioData, mimeType = 'audio/ogg') {
  let { openai_api_key, clientId } = await chrome.storage.local.get(['openai_api_key', 'clientId']);

  if (openai_api_key) {
    return transcribeWithOpenAI(audioData, mimeType, openai_api_key);
  }

  if (isCloudflareConfigured()) {
    if (!clientId) {
      clientId = crypto.randomUUID();
      await chrome.storage.local.set({ clientId });
    }
    return transcribeWithCloudflare(audioData, mimeType, clientId);
  }

  return {
    success: false,
    error: 'No transcription provider available. Add an OpenAI API key in the extension popup.'
  };
}

// ── OpenAI Whisper (user's own key) ──

async function transcribeWithOpenAI(audioData, mimeType, apiKey) {
  try {
    const uint8Array = new Uint8Array(audioData);
    const audioBlob = new Blob([uint8Array], { type: mimeType });
    const extension = getFileExtension(mimeType);

    const formData = new FormData();
    formData.append('file', audioBlob, `audio.${extension}`);
    formData.append('model', 'whisper-1');

    console.log('[WT] Sending audio to OpenAI Whisper...');

    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: formData
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMessage = errorData.error?.message || `HTTP Error ${response.status}`;

      if (response.status === 401) throw new Error('Invalid API Key. Check your key in settings.');
      if (response.status === 429) throw new Error('Rate limit exceeded. Try again later.');
      if (response.status === 400) throw new Error('Unsupported audio format: ' + errorMessage);
      throw new Error(errorMessage);
    }

    const data = await response.json();
    console.log('[WT] OpenAI transcription successful');

    return {
      success: true,
      text: data.text,
      provider: 'openai'
    };

  } catch (error) {
    console.error('[WT] OpenAI error:', error);
    return { success: false, error: error.message || 'Unknown error during transcription' };
  }
}

// ── Cloudflare Worker (free proxy) ──

async function transcribeWithCloudflare(audioData, mimeType, clientId) {
  try {
    const uint8Array = new Uint8Array(audioData);
    const audioBlob = new Blob([uint8Array], { type: mimeType });
    const extension = getFileExtension(mimeType);

    const formData = new FormData();
    formData.append('file', audioBlob, `audio.${extension}`);

    console.log('[WT] Sending audio to Cloudflare Worker...');

    const response = await fetch(`${CLOUDFLARE_WORKER_URL}/transcribe`, {
      method: 'POST',
      headers: { 'X-Client-ID': clientId },
      body: formData
    });

    const data = await response.json();

    if (!response.ok) {
      if (response.status === 429 && data.code === 'DAILY_LIMIT') {
        return {
          success: false,
          error: `Daily free limit reached (${data.limit}/${data.limit}). Add your OpenAI API key for unlimited use.`,
          code: 'DAILY_LIMIT',
          used: data.used,
          limit: data.limit
        };
      }
      throw new Error(data.error || `HTTP Error ${response.status}`);
    }

    console.log('[WT] Cloudflare transcription successful');

    return {
      success: true,
      text: data.text,
      language: data.language,
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

// ── Usage check (Cloudflare only) ──

async function getCloudflareUsage() {
  if (!isCloudflareConfigured()) return null;

  const clientId = await getClientId();
  if (!clientId) return null;

  try {
    const response = await fetch(`${CLOUDFLARE_WORKER_URL}/usage`, {
      method: 'POST',
      headers: { 'X-Client-ID': clientId }
    });

    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// ── Utils ──

function getFileExtension(mimeType) {
  const mimeToExt = {
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'm4a',
    'audio/m4a': 'm4a',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
    'audio/x-m4a': 'm4a',
    'video/webm': 'webm',
    'audio/opus': 'ogg'
  };
  return mimeToExt[mimeType] || 'ogg';
}

console.log('[WT] Service Worker started');
