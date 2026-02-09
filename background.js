const WHISPER_API_URL = 'https://api.openai.com/v1/audio/transcriptions';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'transcribe') {
    handleTranscription(message.audioData, message.mimeType)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (message.action === 'checkApiKey') {
    checkApiKeyExists()
      .then(exists => sendResponse({ exists }))
      .catch(() => sendResponse({ exists: false }));
    return true;
  }

  if (message.action === 'getDiagnostics') {
    // Forward to active WhatsApp Web tab
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
          // Enrich with background info
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

async function handleTranscription(audioData, mimeType = 'audio/ogg') {
  try {
    const apiKey = await getApiKey();
    
    const uint8Array = new Uint8Array(audioData);
    const audioBlob = new Blob([uint8Array], { type: mimeType });
    
    const extension = getFileExtension(mimeType);
    
    const formData = new FormData();
    formData.append('file', audioBlob, `audio.${extension}`);
    formData.append('model', 'whisper-1');
    
    console.log('[WhatsApp Transcriber] Sending audio to Whisper API...');
    
    const response = await fetch(WHISPER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      body: formData
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMessage = errorData.error?.message || `HTTP Error ${response.status}`;
      
      if (response.status === 401) {
        throw new Error('Invalid API Key. Check your key in settings.');
      } else if (response.status === 429) {
        throw new Error('Rate limit exceeded. Try again later.');
      } else if (response.status === 400) {
        throw new Error('Unsupported audio format: ' + errorMessage);
      }
      
      throw new Error(errorMessage);
    }
    
    const data = await response.json();
    
    console.log('[WhatsApp Transcriber] Transcription successful:', data.text?.substring(0, 50) + '...');
    
    return {
      success: true,
      text: data.text
    };
    
  } catch (error) {
    console.error('[WhatsApp Transcriber] Error:', error);
    
    return {
      success: false,
      error: error.message || 'Unknown error during transcription'
    };
  }
}

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

console.log('[WhatsApp Transcriber] Service Worker started');
