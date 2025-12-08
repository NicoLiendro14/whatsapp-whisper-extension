(function() {
  'use strict';

  if (window.__whatsappTranscriberInjected) return;
  window.__whatsappTranscriberInjected = true;

  console.log('[WhatsApp Transcriber] Content script loaded');

  const PROCESSED_ATTR = 'data-wt-processed';
  const BUTTON_CLASS = 'wt-transcribe-btn';
  const RESULT_CLASS = 'wt-transcription-result';
  const SCAN_INTERVAL = 2500;
  const BATCH_SIZE = 5;

  let injectedScriptReady = false;
  let pendingRequests = new Map();
  let requestIdCounter = 0;
  let scanningStarted = false;
  let isScanning = false;

  function injectScript() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('injected.js');
    script.onload = function() {
      this.remove();
      console.log('[WhatsApp Transcriber] Script injected into page');
    };
    (document.head || document.documentElement).appendChild(script);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    
    const message = event.data;
    if (!message || message.source !== 'wt-injected-script') return;

    if (message.action === 'ready') {
      injectedScriptReady = true;
      console.log('[WhatsApp Transcriber] Injected script is ready');
    }

    if (message.action === 'audioDownloaded' && message.requestId) {
      const resolver = pendingRequests.get(message.requestId);
      if (resolver) {
        pendingRequests.delete(message.requestId);
        resolver(message);
      }
    }

    if (message.action === 'storeStatus' && message.requestId) {
      const resolver = pendingRequests.get(message.requestId);
      if (resolver) {
        pendingRequests.delete(message.requestId);
        resolver(message);
      }
    }
  });

  function sendToInjectedScript(action, data = {}) {
    return new Promise((resolve, reject) => {
      const requestId = ++requestIdCounter;
      
      const timeout = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error('Timeout waiting for injected script response'));
      }, 30000);

      pendingRequests.set(requestId, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });

      window.postMessage({
        source: 'wt-content-script',
        action,
        requestId,
        ...data
      }, '*');
    });
  }

  function scanForVoiceMessages() {
    if (isScanning) return;
    isScanning = true;

    const scheduleWork = window.requestIdleCallback || ((cb) => setTimeout(cb, 50));
    
    scheduleWork(() => {
      try {
        const playButtons = document.querySelectorAll(
          `button[aria-label="Play voice message"]:not([${PROCESSED_ATTR}])`
        );
        
        if (playButtons.length === 0) {
          isScanning = false;
          return;
        }

        const buttons = Array.from(playButtons);
        processBatch(buttons, 0);
        
      } catch (e) {
        console.error('[WhatsApp Transcriber] Scan error:', e);
        isScanning = false;
      }
    });
  }

  function processBatch(buttons, startIndex) {
    const endIndex = Math.min(startIndex + BATCH_SIZE, buttons.length);
    let processed = 0;
    
    for (let i = startIndex; i < endIndex; i++) {
      const button = buttons[i];
      if (!button.hasAttribute(PROCESSED_ATTR)) {
        button.setAttribute(PROCESSED_ATTR, 'true');
        addTranscribeButton(button);
        processed++;
      }
    }

    if (processed > 0) {
      console.log(`[WhatsApp Transcriber] Processed ${processed} voice messages`);
    }

    if (endIndex < buttons.length) {
      requestAnimationFrame(() => processBatch(buttons, endIndex));
    } else {
      isScanning = false;
    }
  }

  function getMessageId(playButton) {
    const msgElement = playButton.closest('[data-id]');
    if (msgElement) {
      return msgElement.dataset.id;
    }

    const messageRow = playButton.closest('[role="row"]');
    if (messageRow) {
      const dataIdElement = messageRow.querySelector('[data-id]');
      if (dataIdElement) {
        return dataIdElement.dataset.id;
      }
    }

    return null;
  }

  function addTranscribeButton(playButton) {
    const messageContainer = playButton.closest('.message-in, .message-out');
    if (!messageContainer) return;

    const msgId = getMessageId(playButton);

    const transcribeBtn = document.createElement('button');
    transcribeBtn.className = BUTTON_CLASS;
    transcribeBtn.innerHTML = '📝 Transcribe';
    transcribeBtn.title = 'Transcribe with OpenAI Whisper';
    transcribeBtn.dataset.msgId = msgId || '';

    const btnContainer = document.createElement('div');
    btnContainer.className = 'wt-btn-container';
    btnContainer.appendChild(transcribeBtn);

    const audioPlayerContainer = playButton.closest('div[tabindex="-1"]')?.parentElement?.parentElement;
    if (audioPlayerContainer?.parentElement) {
      audioPlayerContainer.parentElement.insertBefore(btnContainer, audioPlayerContainer.nextSibling);
    } else {
      messageContainer.appendChild(btnContainer);
    }

    transcribeBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await handleTranscribeClick(transcribeBtn, messageContainer, playButton);
    });
  }

  async function handleTranscribeClick(button, messageContainer, playButton) {
    if (button.disabled) return;
    
    try {
      button.disabled = true;
      button.innerHTML = '⏳ Getting audio...';
      button.classList.add('loading');

      const apiKeyCheck = await sendMessageToBackground({ action: 'checkApiKey' });
      if (!apiKeyCheck.exists) {
        throw new Error('API Key not configured. Click the extension icon.');
      }

      if (!injectedScriptReady) {
        throw new Error('Extension not initialized. Reload the page.');
      }

      const msgId = button.dataset.msgId || getMessageId(playButton);
      if (!msgId) {
        throw new Error('Could not identify the message. Reload the page.');
      }

      console.log('[WhatsApp Transcriber] Requesting audio for message:', msgId);

      button.innerHTML = '⏳ Downloading audio...';
      const audioResponse = await sendToInjectedScript('downloadAudio', { msgId });

      if (!audioResponse.success) {
        throw new Error(audioResponse.error || 'Error downloading audio');
      }

      if (!audioResponse.data || audioResponse.data.length === 0) {
        throw new Error('Downloaded audio is empty');
      }

      console.log('[WhatsApp Transcriber] Audio obtained:', audioResponse.data.length, 'bytes');

      button.innerHTML = '⏳ Transcribing...';
      const result = await sendMessageToBackground({
        action: 'transcribe',
        audioData: audioResponse.data,
        mimeType: audioResponse.mimeType || 'audio/ogg'
      });

      if (result.success) {
        displayTranscription(messageContainer, result.text);
        button.innerHTML = '✅ Transcribed';
        button.classList.remove('loading');
        button.classList.add('success');
      } else {
        throw new Error(result.error || 'Error transcribing');
      }

    } catch (error) {
      console.error('[WhatsApp Transcriber] Error:', error);
      button.innerHTML = '❌ Error';
      button.classList.remove('loading');
      button.classList.add('error');
      
      displayTranscription(messageContainer, `Error: ${error.message}`, true);
      
      setTimeout(() => {
        button.disabled = false;
        button.innerHTML = '🔄 Retry';
        button.classList.remove('error');
      }, 3000);
    }
  }

  function displayTranscription(messageContainer, text, isError = false) {
    let resultDiv = messageContainer.querySelector('.' + RESULT_CLASS);
    
    if (!resultDiv) {
      resultDiv = document.createElement('div');
      resultDiv.className = RESULT_CLASS;
      messageContainer.appendChild(resultDiv);
    }

    resultDiv.classList.toggle('error', isError);
    
    resultDiv.innerHTML = `
      <div class="wt-result-header">
        <span class="wt-result-icon">${isError ? '⚠️' : '📝'}</span>
        <span class="wt-result-title">${isError ? 'Error' : 'Transcription'}</span>
      </div>
      <div class="wt-result-text">${escapeHtml(text)}</div>
      ${!isError ? '<button class="wt-copy-btn" title="Copy to clipboard">📋 Copy</button>' : ''}
    `;

    const copyBtn = resultDiv.querySelector('.wt-copy-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(text);
          copyBtn.innerHTML = '✅ Copied';
          setTimeout(() => copyBtn.innerHTML = '📋 Copy', 2000);
        } catch (e) {
          console.error('Error copying:', e);
        }
      });
    }
  }

  function sendMessageToBackground(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function startScanning() {
    if (scanningStarted) return;
    scanningStarted = true;
    
    console.log('[WhatsApp Transcriber] Scanning started');
    
    setTimeout(scanForVoiceMessages, 500);
    setInterval(scanForVoiceMessages, SCAN_INTERVAL);
  }

  function init() {
    injectScript();

    let checkCount = 0;
    const maxChecks = 30;
    
    const checkReady = setInterval(() => {
      checkCount++;
      
      const isReady = document.querySelector('[data-icon="chat"]') 
                   || document.querySelector('.message-in, .message-out')
                   || document.querySelector('#main');
      
      if (isReady || checkCount >= maxChecks) {
        clearInterval(checkReady);
        
        if (isReady) {
          console.log('[WhatsApp Transcriber] WhatsApp Web ready');
        } else {
          console.log('[WhatsApp Transcriber] Timeout - starting anyway');
        }
        
        setTimeout(startScanning, 2000);
      }
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
