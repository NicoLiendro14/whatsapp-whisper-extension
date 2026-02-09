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

  // ========== DIAGNOSTIC SYSTEM ==========
  const diagnosticLog = [];
  const MAX_LOG_ENTRIES = 100;
  const loadTimestamp = new Date().toISOString();

  function diagLog(level, category, message, extra = null) {
    const entry = {
      time: new Date().toISOString(),
      level, // 'info', 'warn', 'error'
      category, // 'init', 'scan', 'inject', 'button', 'transcribe', 'comm'
      message,
      ...(extra ? { extra } : {})
    };
    diagnosticLog.push(entry);
    if (diagnosticLog.length > MAX_LOG_ENTRIES) diagnosticLog.shift();
    
    const prefix = `[WT-Diag][${category}]`;
    if (level === 'error') console.error(prefix, message, extra || '');
    else if (level === 'warn') console.warn(prefix, message, extra || '');
    else console.log(prefix, message, extra || '');
  }

  // Capture global errors on the page
  window.addEventListener('error', (e) => {
    if (e.filename && e.filename.includes('whatsapp')) return; // ignore WA's own errors
    diagLog('error', 'global', `Uncaught error: ${e.message}`, {
      file: e.filename, line: e.lineno, col: e.colno
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    diagLog('error', 'global', `Unhandled promise rejection: ${e.reason?.message || e.reason}`, {
      stack: e.reason?.stack?.substring(0, 300)
    });
  });

  diagLog('info', 'init', 'Content script loaded');

  function injectScript() {
    try {
      const scriptUrl = chrome.runtime.getURL('injected.js');
      diagLog('info', 'inject', 'Injecting script from: ' + scriptUrl);
      
      const script = document.createElement('script');
      script.src = scriptUrl;
      script.onload = function() {
        this.remove();
        diagLog('info', 'inject', 'Script injected and loaded successfully');
      };
      script.onerror = function(e) {
        diagLog('error', 'inject', 'Script failed to load!', { error: String(e) });
      };
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      diagLog('error', 'inject', 'Exception injecting script: ' + e.message, { stack: e.stack?.substring(0, 300) });
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    
    const message = event.data;
    if (!message || message.source !== 'wt-injected-script') return;

    if (message.action === 'ready') {
      injectedScriptReady = true;
      diagLog('info', 'inject', 'Injected script is ready');
    }

    if (message.action === 'audioDownloaded' && message.requestId) {
      const resolver = pendingRequests.get(message.requestId);
      if (resolver) {
        pendingRequests.delete(message.requestId);
        diagLog('info', 'comm', 'Audio downloaded response received', { 
          success: message.success, 
          dataSize: message.data?.length,
          error: message.error 
        });
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

    if (message.action === 'injectedDiagnostics' && message.requestId) {
      const resolver = pendingRequests.get(message.requestId);
      if (resolver) {
        pendingRequests.delete(message.requestId);
        resolver(message);
      }
    }

    // Capture errors from injected script
    if (message.action === 'logError') {
      diagLog('error', 'injected', message.message, message.extra);
    }
    if (message.action === 'logInfo') {
      diagLog('info', 'injected', message.message, message.extra);
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

  // ========== ROBUST MULTI-SELECTOR SYSTEM ==========
  // Ordered by reliability: data-icon selectors first (language-independent),
  // then aria-label selectors as fallback for every known language.
  const VOICE_BUTTON_SELECTORS = [
    // --- Tier 1: data-icon based (language-independent, most reliable) ---
    'button:has([data-icon="audio-play"])',
    'button:has([data-icon="audio-pause"])',
    // Also match the span directly in case button:has() is not supported (older browsers)
    '[data-icon="audio-play"]',
    '[data-icon="audio-pause"]',

    // --- Tier 2: aria-label based (language-dependent fallbacks) ---
    // English
    'button[aria-label="Play voice message"]',
    'button[aria-label="Pause voice message"]',
    // Spanish
    'button[aria-label="Reproducir mensaje de voz"]',
    'button[aria-label="Pausar mensaje de voz"]',
    // Portuguese
    'button[aria-label="Reproduzir mensagem de voz"]',
    'button[aria-label="Pausar mensagem de voz"]',
    // French
    'button[aria-label="Lire le message vocal"]',
    'button[aria-label="Mettre en pause le message vocal"]',
    // German
    'button[aria-label="Sprachnachricht abspielen"]',
    'button[aria-label="Sprachnachricht pausieren"]',
    // Italian
    'button[aria-label="Riproduci messaggio vocale"]',
    'button[aria-label="Metti in pausa messaggio vocale"]',
    // Russian
    'button[aria-label="Воспроизвести голосовое сообщение"]',
    // Arabic
    'button[aria-label="تشغيل الرسالة الصوتية"]',
    // Hindi
    'button[aria-label="वॉइस मैसेज चलाएं"]',
    // Japanese
    'button[aria-label="ボイスメッセージを再生"]',
    // Chinese (Simplified)
    'button[aria-label="播放语音消息"]',
    // Korean
    'button[aria-label="음성 메시지 재생"]',
    // Turkish
    'button[aria-label="Sesli mesajı oynat"]',
    // Dutch
    'button[aria-label="Spraakbericht afspelen"]',
    // Polish
    'button[aria-label="Odtwórz wiadomość głosową"]',
    // Indonesian
    'button[aria-label="Putar pesan suara"]',
  ];

  // Track which selector strategy is working so we try it first next time
  let activeSelector = null;
  let activeSelectorHits = 0;

  function findVoiceButtons() {
    const notProcessed = `:not([${PROCESSED_ATTR}])`;
    const found = new Set();

    // If we have a known working selector, try it first for performance
    if (activeSelector) {
      try {
        const elements = document.querySelectorAll(activeSelector + notProcessed);
        if (elements.length > 0) {
          activeSelectorHits++;
          elements.forEach(el => {
            // For data-icon spans, get the parent button
            const btn = el.tagName === 'BUTTON' ? el : el.closest('button');
            if (btn) found.add(btn);
          });
          return Array.from(found);
        }
      } catch (e) {
        // Selector not supported, clear it
        diagLog('warn', 'scan', `Active selector failed: ${activeSelector}`, { error: e.message });
        activeSelector = null;
      }
    }

    // Try all selectors in order until we find results
    for (const selector of VOICE_BUTTON_SELECTORS) {
      try {
        const elements = document.querySelectorAll(selector + notProcessed);
        if (elements.length > 0) {
          // Remember this working selector for next time
          if (activeSelector !== selector) {
            diagLog('info', 'scan', `Selector matched: "${selector}" (${elements.length} results)`);
            activeSelector = selector;
            activeSelectorHits = 1;
          }

          elements.forEach(el => {
            const btn = el.tagName === 'BUTTON' ? el : el.closest('button');
            if (btn) found.add(btn);
          });

          // Don't break - collect from all matching selectors for completeness
          // But for performance, if we got results from tier 1, skip tier 2
          if (found.size > 0 && selector.includes('data-icon')) {
            break;
          }
        }
      } catch (e) {
        // Some selectors (like :has()) may not be supported in older browsers
        // This is fine, we just skip to the next one
        diagLog('warn', 'scan', `Selector not supported: "${selector}"`, { error: e.message });
      }
    }

    return Array.from(found);
  }

  function scanForVoiceMessages() {
    if (isScanning) return;
    isScanning = true;

    const scheduleWork = window.requestIdleCallback || ((cb) => setTimeout(cb, 50));
    
    scheduleWork(() => {
      try {
        const playButtons = findVoiceButtons();
        
        if (playButtons.length === 0) {
          if (!scanForVoiceMessages._scanCount) scanForVoiceMessages._scanCount = 0;
          scanForVoiceMessages._scanCount++;
          
          if (scanForVoiceMessages._scanCount === 1 || scanForVoiceMessages._scanCount % 20 === 0) {
            // Detailed DOM inspection for diagnostics
            const allButtons = document.querySelectorAll('button[aria-label]');
            const ariaLabels = [];
            allButtons.forEach(btn => {
              const label = btn.getAttribute('aria-label');
              if (label && (label.toLowerCase().includes('play') || label.toLowerCase().includes('voice') 
                  || label.toLowerCase().includes('audio') || label.toLowerCase().includes('reproducir')
                  || label.toLowerCase().includes('voz') || label.toLowerCase().includes('vocal')
                  || label.toLowerCase().includes('sprachnachricht') || label.toLowerCase().includes('vocale')
                  || label.toLowerCase().includes('jouer') || label.toLowerCase().includes('воспроизвести')
                  || label.toLowerCase().includes('reproduzir') || label.toLowerCase().includes('riproduci')
                  || label.toLowerCase().includes('abspielen') || label.toLowerCase().includes('تشغيل')
                  || label.toLowerCase().includes('播放') || label.toLowerCase().includes('재생')
                  || label.toLowerCase().includes('再生') || label.toLowerCase().includes('odtwórz')
                  || label.toLowerCase().includes('putar') || label.toLowerCase().includes('oynat'))) {
                ariaLabels.push(label);
              }
            });
            
            const audioIcons = document.querySelectorAll('[data-icon="audio-play"], [data-icon="audio-pause"]');
            const msgContainers = document.querySelectorAll('.message-in, .message-out');
            const mainEl = document.querySelector('#main');
            const processedCount = document.querySelectorAll(`[${PROCESSED_ATTR}]`).length;
            
            diagLog('info', 'scan', `Scan #${scanForVoiceMessages._scanCount}: No unprocessed play buttons found`, {
              totalButtonsWithAria: allButtons.length,
              audioIconsInDOM: audioIcons.length,
              audioRelatedLabels: ariaLabels.length > 0 ? ariaLabels.slice(0, 10) : 'none found',
              messageContainers: msgContainers.length,
              mainElementExists: !!mainEl,
              alreadyProcessed: processedCount,
              activeSelector: activeSelector || 'none yet',
              activeSelectorHits
            });
          }
          
          isScanning = false;
          return;
        }

        diagLog('info', 'scan', `Found ${playButtons.length} new voice messages to process`, {
          selector: activeSelector
        });
        processBatch(playButtons, 0);
        
      } catch (e) {
        diagLog('error', 'scan', 'Scan error: ' + e.message, { stack: e.stack?.substring(0, 300) });
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
    if (!messageContainer) {
      diagLog('warn', 'button', 'Play button found but no .message-in/.message-out container', {
        ariaLabel: playButton.getAttribute('aria-label'),
        parentClasses: playButton.parentElement?.className?.substring(0, 100)
      });
      return;
    }

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
    
    diagLog('info', 'scan', 'Scanning started');
    
    setTimeout(scanForVoiceMessages, 500);
    setInterval(scanForVoiceMessages, SCAN_INTERVAL);
  }

  function init() {
    diagLog('info', 'init', 'Init started', {
      url: window.location.href,
      readyState: document.readyState,
      userAgent: navigator.userAgent,
      language: navigator.language,
      languages: navigator.languages?.join(', ')
    });

    injectScript();

    let checkCount = 0;
    const maxChecks = 30;
    
    const checkReady = setInterval(() => {
      checkCount++;
      
      const chatIcon = document.querySelector('[data-icon="chat"]');
      const messages = document.querySelector('.message-in, .message-out');
      const mainEl = document.querySelector('#main');
      const isReady = chatIcon || messages || mainEl;
      
      if (checkCount % 5 === 0 || isReady) {
        diagLog('info', 'init', `Ready check #${checkCount}`, {
          chatIcon: !!chatIcon,
          messages: !!messages,
          mainEl: !!mainEl
        });
      }
      
      if (isReady || checkCount >= maxChecks) {
        clearInterval(checkReady);
        
        if (isReady) {
          diagLog('info', 'init', 'WhatsApp Web ready - starting scan in 2s');
        } else {
          diagLog('warn', 'init', 'Timeout waiting for WhatsApp - starting scan anyway');
        }
        
        setTimeout(startScanning, 2000);
      }
    }, 1000);
  }

  // ========== DIAGNOSTICS REQUEST HANDLER ==========
  async function collectDiagnostics() {
    const diag = {
      timestamp: new Date().toISOString(),
      loadedAt: loadTimestamp,
      uptime: Math.round((Date.now() - new Date(loadTimestamp).getTime()) / 1000) + 's',
      url: window.location.href,
      userAgent: navigator.userAgent,
      language: navigator.language,
      languages: navigator.languages?.join(', '),
      chromeVersion: /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] || 'unknown',
      
      // Extension state
      contentScriptLoaded: true,
      injectedScriptReady: injectedScriptReady,
      scanningStarted: scanningStarted,
      isCurrentlyScanning: isScanning,
      scanCount: scanForVoiceMessages._scanCount || 0,
      activeSelector: activeSelector || 'none matched yet',
      activeSelectorHits: activeSelectorHits,
      totalSelectorsAvailable: VOICE_BUTTON_SELECTORS.length,
      
      // DOM state
      dom: {
        mainExists: !!document.querySelector('#main'),
        chatIconExists: !!document.querySelector('[data-icon="chat"]'),
        messageInCount: document.querySelectorAll('.message-in').length,
        messageOutCount: document.querySelectorAll('.message-out').length,
        processedButtons: document.querySelectorAll(`[${PROCESSED_ATTR}]`).length,
        transcribeButtons: document.querySelectorAll('.' + BUTTON_CLASS).length,
        audioPlayIcons: document.querySelectorAll('[data-icon="audio-play"]').length,
        audioPauseIcons: document.querySelectorAll('[data-icon="audio-pause"]').length,
      },
      
      // Aria label analysis (key for the bug!)
      ariaLabelAnalysis: (() => {
        const allButtons = document.querySelectorAll('button[aria-label]');
        const labels = {};
        allButtons.forEach(btn => {
          const label = btn.getAttribute('aria-label');
          labels[label] = (labels[label] || 0) + 1;
        });
        // Filter to show only potentially audio-related labels + first 20 unique labels
        const audioKeywords = ['play', 'voice', 'audio', 'reproducir', 'voz', 'vocal', 'message', 'mensaje', 'sprachnachricht', 'vocale', 'jouer', 'воспроизвести', 'ptt', 'pause'];
        const audioLabels = {};
        const allLabelsPreview = {};
        let count = 0;
        for (const [label, qty] of Object.entries(labels)) {
          if (count < 30) {
            allLabelsPreview[label] = qty;
            count++;
          }
          if (audioKeywords.some(kw => label.toLowerCase().includes(kw))) {
            audioLabels[label] = qty;
          }
        }
        return {
          totalUniqueLabels: Object.keys(labels).length,
          audioRelatedLabels: audioLabels,
          allLabelsPreview: allLabelsPreview
        };
      })(),
      
      // Injected script diagnostics (try to get)
      injectedScriptStatus: null,
      
      // Error log
      recentLogs: diagnosticLog.slice(-50)
    };

    // Try to get injected script diagnostics
    if (injectedScriptReady) {
      try {
        const injDiag = await Promise.race([
          sendToInjectedScript('getDiagnostics'),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
        ]);
        diag.injectedScriptStatus = injDiag;
      } catch (e) {
        diag.injectedScriptStatus = { error: 'Could not get injected script diagnostics: ' + e.message };
      }
    } else {
      diag.injectedScriptStatus = { error: 'Injected script not ready' };
    }

    return diag;
  }

  // Listen for diagnostic requests from background/popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'getDiagnostics') {
      collectDiagnostics()
        .then(diag => sendResponse({ success: true, diagnostics: diag }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // keep channel open for async response
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
