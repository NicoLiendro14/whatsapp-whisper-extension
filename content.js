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

  // ========== TRANSCRIPTION CACHE ==========
  const CACHE_STORAGE_KEY = 'wt_transcription_cache';
  const MAX_CACHE_ENTRIES = 500;
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  // Mirrors the Worker limits so the local check never blocks a Pro user at
  // the free cap. The Worker stays the authority.
  const dailyLimit = () => (isPro ? 500 : 30);
  const DAILY_COUNTER_KEY = 'wt_daily_counter';

  const transcriptionCache = new Map();
  let dailyCounter = { date: '', count: 0 };

  let injectedScriptReady = false;
  let pendingRequests = new Map();
  let requestIdCounter = 0;
  let scanningStarted = false;
  let isScanning = false;

  // ========== OUTGOING AUDIO TRANSCRIPTION STATE ==========
  let recordingScanInterval = null;
  let currentTranscriptionPanel = null;
  let isTranscribing = false;

  // ========== KARAOKE (PRO) STATE ==========
  const PRO_FLAG_KEY = 'wt_pro';
  const KARAOKE_OFFSET_KEY = 'wt_karaoke_offset_ms';
  const KARAOKE_STYLE_KEY = 'wt_karaoke_style';

  // 'sweep' | 'word' | 'off'. Lives on <html> so styles.css picks the look and
  // a change from the popup restyles every transcription without a rerender.
  let karaokeStyle = 'sweep';
  function applyKaraokeStyle(value) {
    karaokeStyle = value === 'word' || value === 'off' ? value : 'sweep';
    document.documentElement.dataset.wtKaraoke = karaokeStyle;
  }
  applyKaraokeStyle();

  let isPro = false;
  // whisper-large-v3-turbo aligns words with a 4-layer decoder instead of 32,
  // so timestamps drift ~150-300ms. User-tunable rather than a magic constant.
  let karaokeOffsetMs = 0;
  // The message the highlighted audio belongs to, and that audio's id from
  // injected-early.js. An ID rather than the node, because WhatsApp drops and
  // rebuilds message nodes as the chat scrolls.
  // activeWordEls is null until resolved, then a non-empty NodeList.
  let activeMsgId = null;
  let activeAudioId = null;
  // When the active audio ended, 0 while it hasn't: only a fresh end means
  // WhatsApp is auto-advancing, a stale one would let any later sound match.
  let activeEndedAt = 0;
  // The notes after the active one, read when it started, in case its node
  // is gone (scrolled away) by the time it ends.
  let activeNextIds = [];
  let activeWordEls = null;
  let activeWordIndex = -1;
  // The last play button clicked, a hint for which message the next audio is.
  let lastPlayClickAt = 0;
  let lastPlayClickMsgId = null;
  // Seek requested for a message that wasn't loaded yet, applied once its
  // audio starts — or dropped, so a stale one can't land minutes later.
  let pendingSeek = null; // { msgId, time, expiry }

  // ========== CACHE PERSISTENCE ==========

  function getTodayKey() {
    return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  }

  async function loadCache() {
    try {
      const result = await chrome.storage.local.get([
        CACHE_STORAGE_KEY, DAILY_COUNTER_KEY, PRO_FLAG_KEY, KARAOKE_OFFSET_KEY, KARAOKE_STYLE_KEY
      ]);

      isPro = !!result[PRO_FLAG_KEY];
      karaokeOffsetMs = Number(result[KARAOKE_OFFSET_KEY]) || 0;
      applyKaraokeStyle(result[KARAOKE_STYLE_KEY]);

      if (result[CACHE_STORAGE_KEY]) {
        const entries = result[CACHE_STORAGE_KEY];
        const now = Date.now();
        let loaded = 0;
        for (const [msgId, entry] of Object.entries(entries)) {
          if (now - entry.timestamp < CACHE_TTL_MS) {
            transcriptionCache.set(msgId, entry);
            loaded++;
          }
        }
        console.log(`[WhatsApp Transcriber] Cache loaded: ${loaded} transcriptions`);
        // Write back without the expired ones, so they leave disk after 7 days
        // even if nothing new gets transcribed.
        if (loaded < Object.keys(entries).length) saveCache();
      }

      const today = getTodayKey();
      if (result[DAILY_COUNTER_KEY] && result[DAILY_COUNTER_KEY].date === today) {
        dailyCounter = result[DAILY_COUNTER_KEY];
      } else {
        dailyCounter = { date: today, count: 0 };
      }
    } catch (e) {
      console.warn('[WhatsApp Transcriber] Failed to load cache:', e.message);
    }
  }

  async function saveCache() {
    const entries = {};
    const now = Date.now();
    for (const [msgId, entry] of transcriptionCache) {
      if (now - entry.timestamp < CACHE_TTL_MS) {
        entries[msgId] = entry;
      }
    }

    // Oldest first, so every trim below drops the oldest. Dropped from memory
    // too, or the next save would hit the same full storage again.
    const keys = Object.keys(entries).sort((a, b) => entries[a].timestamp - entries[b].timestamp);
    const evict = (n) => keys.splice(0, n).forEach(k => {
      delete entries[k];
      transcriptionCache.delete(k);
    });
    evict(keys.length - MAX_CACHE_ENTRIES);

    for (;;) {
      try {
        await chrome.storage.local.set({ [CACHE_STORAGE_KEY]: entries });
        return;
      } catch (e) {
        // Full storage would otherwise fail every save from now on.
        if (!/quota/i.test(e.message) || !keys.length) {
          console.warn('[WhatsApp Transcriber] Failed to save cache:', e.message);
          return;
        }
        evict(Math.ceil(keys.length / 4));
      }
    }
  }

  // Its own write, so a cache write failing on quota can't lose the count.
  function saveDailyCounter() {
    chrome.storage.local.set({ [DAILY_COUNTER_KEY]: dailyCounter }).catch(e => {
      console.warn('[WhatsApp Transcriber] Failed to save daily counter:', e.message);
    });
  }

  function cacheGet(msgId) {
    if (!msgId) return null;
    const entry = transcriptionCache.get(msgId);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
      transcriptionCache.delete(msgId);
      return null;
    }
    return entry;
  }

  function cacheSet(msgId, text, provider, words) {
    if (!msgId) return;
    // Stored regardless of the pro flag: words[] roughly 7x's an entry (~400B
    // -> ~3KB, so ~1.5MB at MAX_CACHE_ENTRIES against a 10MB quota), and
    // keeping it means enabling pro lights up everything already transcribed
    // instead of silently requiring a re-transcribe.
    const entry = { text, provider, timestamp: Date.now() };
    if (words?.length) entry.words = words;
    transcriptionCache.set(msgId, entry);
    saveCache();
  }

  function checkDailyLimit() {
    const today = getTodayKey();
    if (dailyCounter.date !== today) {
      dailyCounter = { date: today, count: 0 };
    }
    return dailyCounter.count < dailyLimit();
  }

  function incrementDailyCounter() {
    const today = getTodayKey();
    if (dailyCounter.date !== today) {
      dailyCounter = { date: today, count: 0 };
    }
    dailyCounter.count++;
    saveDailyCounter();
  }

  function getDailyRemaining() {
    const today = getTodayKey();
    if (dailyCounter.date !== today) return dailyLimit();
    return Math.max(0, dailyLimit() - dailyCounter.count);
  }

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

    if ((message.action === 'storeStatus' || message.action === 'durations') && message.requestId) {
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

  // ========== EARLY PATCH MESSAGE LISTENER (getUserMedia interceptor) ==========
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== 'wt-early-patch') return;

    if (msg.action === 'recorderStarted') {
      diagLog('info', 'recording', 'Parallel recorder started — mic stream captured');
    }

    if (msg.action === 'recorderStopped') {
      diagLog('info', 'recording', 'Parallel recorder stopped');
      removeTranscriptionPanel();
    }

    // Same id means a resume, or the play() our own seek triggers — keep going.
    if (msg.action === 'audioStarted' && msg.id === activeAudioId) {
      activeEndedAt = 0;
      lastPlayClickAt = 0; // a resume click is consumed too, or an auto-advance could reuse it
      // The playhead may have moved while paused, unseen; repaint from clean.
      clearHighlight();
      activeWordEls = null; // re-resolve, which re-opens a text collapsed while paused
    } else if (msg.action === 'audioStarted') {
      const audioId = msg.id;
      attributeAudio(msg.d).then(msgId => {
        // No matching voice note: a notification sound or similar. Leave the
        // karaoke alone rather than sync the wrong text.
        if (!msgId) return;
        lastPlayClickAt = 0; // consumed, so an auto-advance can't reuse it
        // Reset even for the same message: a replay must re-open a text the
        // user collapsed, and highlightWordAt only does that on resolving.
        clearHighlight();
        activeMsgId = msgId;
        activeNextIds = nextVoiceIds(msgId);
        activeWordEls = null;
        activeAudioId = audioId;
        activeEndedAt = 0;
        // The audio we were waiting on is open now, so the queued jump can land.
        if (pendingSeek && Date.now() > pendingSeek.expiry) pendingSeek = null;
        if (pendingSeek?.msgId === msgId) {
          sendSeek(audioId, pendingSeek.time);
          pendingSeek = null;
        }
      });
    }

    if (msg.action === 'audioTick' && msg.id === activeAudioId) {
      highlightWordAt(msg.t);
    }

    // A pause leaves the highlight frozen in place; only a finished audio clears
    // it. Checking the id keeps an old audio's end from clearing the current one.
    if (msg.action === 'audioStopped' && msg.ended && msg.id === activeAudioId) {
      activeEndedAt = Date.now();
      clearHighlight();
    }

    // Handle responses (capturedAudioResult, stopResult)
    if (msg.requestId) {
      const resolver = pendingRequests.get(msg.requestId);
      if (resolver) {
        pendingRequests.delete(msg.requestId);
        resolver(msg);
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

  function sendToEarlyPatch(action, data = {}) {
    return new Promise((resolve, reject) => {
      const requestId = ++requestIdCounter;

      const timeout = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error('Timeout waiting for audio capture'));
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
            const msgContainers = document.querySelectorAll(MESSAGE_CONTAINER_SELECTOR);
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

  function getScrollContainer(referenceEl) {
    // Walk up from a message element to find the actual scrollable ancestor
    let el = referenceEl
      || document.querySelector('#main .message-in, #main .message-out, #main [data-testid="msg-container"], #main [role="row"]');
    while (el && el !== document.body) {
      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;
      if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  function processBatch(buttons, startIndex) {
    const endIndex = Math.min(startIndex + BATCH_SIZE, buttons.length);
    let processed = 0;
    let more = false;
    // Later batches run from rAF, outside the scan's try. A throw there would
    // leave isScanning stuck and no button would ever be added again.
    try {
      const scroller = getScrollContainer(buttons[startIndex]);
      const prevScrollTop = scroller ? scroller.scrollTop : 0;
      const prevScrollHeight = scroller ? scroller.scrollHeight : 0;

      diagLog('info', 'scroll', 'Before batch insert', {
        scrollerFound: !!scroller,
        scrollerTag: scroller?.tagName,
        scrollerClass: scroller?.className?.substring(0, 80),
        scrollerRole: scroller?.getAttribute('role'),
        prevScrollTop,
        prevScrollHeight,
        batchStart: startIndex,
        batchEnd: endIndex
      });

      for (let i = startIndex; i < endIndex; i++) {
        const button = buttons[i];
        if (!button.hasAttribute(PROCESSED_ATTR)) {
          button.setAttribute(PROCESSED_ATTR, 'true');
          addTranscribeButton(button);
          processed++;
        }
      }

      if (processed > 0 && scroller) {
        const newScrollHeight = scroller.scrollHeight;
        const heightDelta = newScrollHeight - prevScrollHeight;
        if (heightDelta > 0) {
          scroller.scrollTop = prevScrollTop + heightDelta;
          diagLog('info', 'scroll', 'Compensated scroll', {
            heightDelta,
            newScrollTop: scroller.scrollTop,
            newScrollHeight
          });
        }
      }

      if (processed > 0) {
        console.log(`[WhatsApp Transcriber] Processed ${processed} voice messages`);
      }

      if (endIndex < buttons.length) {
        requestAnimationFrame(() => processBatch(buttons, endIndex));
        more = true;
      }
    } finally {
      if (!more) isScanning = false;
    }
  }

  // WhatsApp Web periodically restructures its DOM. The old layout used
  // `.message-in` / `.message-out` classes; newer builds use obfuscated
  // class names and only expose `data-testid="msg-container"` (and a
  // `[role="row"]` wrapper). We try every known anchor so the extension keeps
  // working regardless of which DOM version a given user is on.
  const MESSAGE_CONTAINER_SELECTOR = [
    '.message-in',
    '.message-out',
    '[data-testid="msg-container"]',
    '[data-id]',
    '[role="row"]'
  ].join(', ');

  function getMessageContainer(playButton) {
    if (!playButton) return null;
    return playButton.closest(MESSAGE_CONTAINER_SELECTOR);
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

  // Anything cached before word timestamps existed has text but no words. A pro
  // user would otherwise be stuck: the button disables on first transcribe, so
  // there'd be no way to ever get karaoke on already-transcribed messages.
  function cacheNeedsWords(cached) {
    return !!(isPro && cached && !cached.words?.length);
  }

  function applyButtonState(btn, cached) {
    btn.classList.remove('success');
    btn.disabled = false;

    if (cacheNeedsWords(cached)) {
      btn.innerHTML = '✨ Sync words';
      btn.title = 'Re-transcribe to get word-by-word sync';
    } else if (cached) {
      btn.innerHTML = '✅ Transcribed';
      btn.title = 'Already transcribed';
      btn.classList.add('success');
      btn.disabled = true;
    } else {
      btn.innerHTML = '📝 Transcribe';
      btn.title = 'Transcribe voice message';
    }
  }

  function addTranscribeButton(playButton) {
    const messageContainer = getMessageContainer(playButton);
    if (!messageContainer) {
      diagLog('warn', 'button', 'Play button found but no message container matched', {
        ariaLabel: playButton.getAttribute('aria-label'),
        parentClasses: playButton.parentElement?.className?.substring(0, 100)
      });
      return;
    }

    const msgId = getMessageId(playButton);
    const cached = cacheGet(msgId);

    const transcribeBtn = document.createElement('button');
    transcribeBtn.className = BUTTON_CLASS;
    transcribeBtn.dataset.msgId = msgId || '';

    applyButtonState(transcribeBtn, cached);

    const btnContainer = document.createElement('div');
    btnContainer.className = 'wt-btn-container';
    btnContainer.appendChild(transcribeBtn);

    const audioPlayerContainer = playButton.closest('div[tabindex="-1"]')?.parentElement?.parentElement;
    if (audioPlayerContainer?.parentElement) {
      audioPlayerContainer.parentElement.insertBefore(btnContainer, audioPlayerContainer.nextSibling);
    } else {
      messageContainer.appendChild(btnContainer);
    }

    // A hint for the karaoke sync: the next audio to start is most likely this
    // message's. attributeAudio still checks the duration before trusting it.
    // Listening on WhatsApp's own button keeps this language-independent.
    playButton.addEventListener('click', () => {
      lastPlayClickAt = Date.now();
      lastPlayClickMsgId = msgId;
      // Another note's button leaves the current one, even if its start never
      // gets matched: a word click there must restart it, not seek a stale audio.
      if (msgId !== activeMsgId) {
        clearHighlight();
        activeMsgId = null;
        activeAudioId = null;
        activeWordEls = null;
      }
    });

    if (cached) {
      displayTranscription(messageContainer, cached.text, false, '', cached.words);
      diagLog('info', 'cache', 'Restored cached transcription', { msgId, textLength: cached.text.length });
    }

    // Always wired: handleTranscribeClick already bails on a disabled button,
    // so applyButtonState alone decides whether clicking does anything. This
    // matters when toggling pro re-enables a button created while cached.
    transcribeBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await handleTranscribeClick(transcribeBtn, messageContainer, playButton);
    });
  }

  async function handleTranscribeClick(button, messageContainer, playButton) {
    if (button.disabled) return;
    
    try {
      const msgId = button.dataset.msgId || getMessageId(playButton);

      // Check in-memory cache first (in case it was populated after button was created)
      // Serve from cache unless we're deliberately re-running to pick up word
      // timestamps the cached entry predates.
      const cached = cacheGet(msgId);
      if (cached && !(isPro && !cached.words?.length)) {
        displayTranscription(messageContainer, cached.text, false, '', cached.words);
        button.innerHTML = '✅ Transcribed';
        button.classList.add('success');
        button.disabled = true;
        return;
      }

      if (!checkDailyLimit()) {
        const limit = dailyLimit();
        displayTranscription(messageContainer, `Daily limit reached (${limit}/${limit}). Come back tomorrow!`, true);
        if (!isPro) addGetProButton(messageContainer);
        button.innerHTML = '🔒 Limit';
        button.classList.add('error');
        setTimeout(() => {
          button.disabled = false;
          button.innerHTML = '🔄 Retry';
          button.classList.remove('error');
        }, 5000);
        return;
      }

      button.disabled = true;
      button.innerHTML = '⏳ Getting audio...';
      button.classList.add('loading');

      const providerInfo = await sendMessageToBackground({ action: 'getProviderInfo' });
      if (!providerInfo.ready) {
        throw new Error('No transcription provider configured. Click the extension icon.');
      }

      if (!injectedScriptReady) {
        throw new Error('Extension not initialized. Reload the page.');
      }

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
        // The server decides pro, not us. Keep the local mirror fresh so an
        // expired subscription stops rendering karaoke without a popup visit.
        if (typeof result.pro === 'boolean' && result.pro !== isPro) {
          chrome.storage.local.set({ wt_pro: result.pro });
        }

        cacheSet(msgId, result.text, result.provider || 'unknown', result.words);
        incrementDailyCounter();

        // WhatsApp may have rebuilt the message node during the request.
        if (!messageContainer.isConnected) {
          const liveBtn = findTranscribeBtn(msgId);
          const live = liveBtn && getMessageContainer(liveBtn);
          if (live) { messageContainer = live; button = liveBtn; }
        }

        // The Worker counts per licence across devices; the local count is per device.
        const remaining = result.remaining ?? getDailyRemaining();
        displayTranscription(messageContainer, result.text, false, ` (${remaining} left today)`, result.words);
        button.innerHTML = '✅ Transcribed';
        button.classList.remove('loading');
        button.classList.add('success');
      } else {
        throw Object.assign(new Error(result.error || 'Error transcribing'), { code: result.code, pro: result.pro });
      }

    } catch (error) {
      console.error('[WhatsApp Transcriber] Error:', error);
      button.innerHTML = '❌ Error';
      button.classList.remove('loading');
      button.classList.add('error');

      displayTranscription(messageContainer, `Error: ${error.message}`, true);
      // The Worker's own free cap (another device, cleared storage) lands here.
      if (error.code === 'DAILY_LIMIT' && !error.pro) addGetProButton(messageContainer);
      
      setTimeout(() => {
        button.disabled = false;
        button.innerHTML = '🔄 Retry';
        button.classList.remove('error');
      }, 3000);
    }
  }

  // Opens the popup page rather than the checkout link, so the URL lives only
  // in popup.js and the user lands next to the field where the key goes.
  function addGetProButton(messageContainer) {
    const resultDiv = messageContainer.querySelector('.' + RESULT_CLASS);
    if (!resultDiv || resultDiv.querySelector('.wt-get-pro-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'wt-copy-btn wt-get-pro-btn';
    btn.textContent = '⭐ Get Pro';
    btn.addEventListener('click', () => chrome.runtime.sendMessage({ action: 'openPopup' }));
    resultDiv.appendChild(btn);
  }

  const COLLAPSE_THRESHOLD = 200;

  function displayTranscription(messageContainer, text, isError = false, extraInfo = '', words = null) {
    let resultDiv = messageContainer.querySelector('.' + RESULT_CLASS);

    if (!resultDiv) {
      resultDiv = document.createElement('div');
      resultDiv.className = RESULT_CLASS;
      messageContainer.appendChild(resultDiv);
    } else if (isError && !resultDiv.classList.contains('error')) {
      // A transcription is already on screen (a failed "Sync words" re-run,
      // say). The error goes underneath, so it can't wipe the cached text.
      let note = resultDiv.querySelector('.wt-result-error-note');
      if (!note) {
        note = document.createElement('div');
        note.className = 'wt-result-error-note';
        resultDiv.appendChild(note);
      }
      note.textContent = '⚠️ ' + text;
      return;
    }

    resultDiv.classList.toggle('error', isError);

    const titleSuffix = extraInfo ? `<span class="wt-result-meta">${escapeHtml(extraInfo)}</span>` : '';
    const isLong = !isError && text.length > COLLAPSE_THRESHOLD;
    const karaoke = isPro && !isError && Array.isArray(words) && words.length > 0;

    // Karaoke needs each word individually addressable. Without timestamps
    // (free tier, or an entry cached before this feature) fall through to the
    // plain escaped text exactly as before.
    // Whisper emits words with a leading space (" algo"). The container is
    // pre-wrap, so those would render as doubled gaps — trim and rejoin.
    // A word without a usable start borrows the previous one's: it stays in
    // the text, nothing but a number reaches the attribute, and the ascending
    // scan in highlightWordAt doesn't stall on a NaN.
    let lastStart = 0;
    const body = karaoke
      ? words
          .map(w => [String(w?.word || '').trim(), Number(w?.start), Number(w?.end)])
          .filter(([word]) => word)
          .map(([word, start, end]) => {
            if (Number.isFinite(start)) lastStart = start;
            // The end only paces the sweep; without one it runs to the next start.
            const e = Number.isFinite(end) && end > lastStart ? ` data-e="${end}"` : '';
            return `<span class="wt-w" data-s="${lastStart}"${e}>${escapeHtml(word)}</span>`;
          })
          .join(' ')
      : escapeHtml(text);

    resultDiv.innerHTML = `
      <div class="wt-result-header">
        <span class="wt-result-icon">${isError ? '⚠️' : '📝'}</span>
        <span class="wt-result-title">${isError ? 'Error' : 'Transcription'}${titleSuffix}</span>
      </div>
      <div class="wt-result-text${isLong ? ' wt-collapsed' : ''}${karaoke ? ' wt-karaoke' : ''}">${body}</div>
      ${isLong ? '<button class="wt-toggle-btn">▼ Show more</button>' : ''}
      ${!isError ? '<button class="wt-copy-btn" title="Copy to clipboard">📋 Copy</button>' : ''}
    `;

    if (karaoke) {
      // Click-to-seek. The <audio> lives detached in the MAIN world, so the
      // seek has to be relayed there.
      let clickTimer = null;
      resultDiv.querySelector('.wt-result-text').addEventListener('click', (e) => {
        // A double click selects a word to copy and must not seek. Its first
        // click also arrives with detail 1, so wait out the double-click
        // window before acting; the second click cancels it.
        clearTimeout(clickTimer);
        if (e.detail > 1) return;
        const span = e.target.closest('.wt-w');
        // 500 ms is the Windows default double-click time.
        if (span) clickTimer = setTimeout(() => seekToWord(span), 500);
      });

      const seekToWord = (span) => {
        // A drag that selected text ends in a click too.
        if (!window.getSelection().isCollapsed) return;
        const time = parseFloat(span.dataset.s);

        // Only one voice message is loaded in the player at a time. Clicking a
        // word from a different one would seek whatever played last, so start
        // this message first and queue the jump for when it opens. The play
        // button is found by our own processed-marker, not by aria-label, so
        // this stays language-independent.
        const playBtn = messageContainer.querySelector(`[${PROCESSED_ATTR}]`);
        const msgId = playBtn && getMessageId(playBtn);
        if (!msgId || msgId !== activeMsgId) {
          // WhatsApp's button toggles play/pause; a second click while the
          // first is still loading would pause it. Just move the queued jump.
          const queued = pendingSeek?.msgId === msgId && Date.now() < pendingSeek.expiry;
          pendingSeek = { msgId, time, expiry: Date.now() + 10000 };
          if (!queued) playBtn?.click();
          return;
        }
        sendSeek(activeAudioId, time);
      };
    }

    const toggleBtn = resultDiv.querySelector('.wt-toggle-btn');
    if (toggleBtn) {
      const textDiv = resultDiv.querySelector('.wt-result-text');
      toggleBtn.addEventListener('click', () => {
        const collapsed = textDiv.classList.toggle('wt-collapsed');
        toggleBtn.innerHTML = collapsed ? '▼ Show more' : '▲ Show less';
      });
    }

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

  // ========== KARAOKE HIGHLIGHT ==========
  // Driven by audioTick messages from injected-early.js, which owns the only
  // reference to WhatsApp's detached <audio> element.

  function findTranscribeBtn(msgId) {
    return document.querySelector(`.${BUTTON_CLASS}[data-msg-id="${CSS.escape(msgId)}"]`);
  }

  // Which voice note just started playing. The audio carries no message
  // identity, so match its duration against the clicked message, or — when
  // the active one just ended, i.e. WhatsApp auto-advancing — the ones after it.
  async function attributeAudio(d) {
    const sinceClick = Date.now() - lastPlayClickAt;
    const clicked = sinceClick < 10000 ? lastPlayClickMsgId : null;
    const ids = clicked ? [clicked] : [];
    // Same window as the click: the next note may still need downloading.
    // A fresh click means the user picked a note; a real auto-advance has none.
    if (!clicked && activeEndedAt && Date.now() - activeEndedAt < 10000) {
      // ponytail: if the auto-advanced note isn't rendered either, its own
      // next ids come back empty and the chain stops; ask injected.js for the
      // model's next voice notes if that matters.
      const next = nextVoiceIds(activeMsgId);
      ids.push(...(next.length ? next : activeNextIds));
    }
    if (!ids.length) return null;

    let durations = {};
    if (injectedScriptReady) {
      try {
        durations = (await sendToInjectedScript('getDurations', { msgIds: ids })).durations || {};
      } catch (e) { /* fall through to the DOM */ }
    }
    // The DOM's value is unverified, so only the model's may veto the click fallback.
    const clickedHasModelDuration = !!(clicked && durations[clicked]);
    for (const id of ids) {
      if (durations[id]) continue;
      // ponytail: unverified against a live DOM sample; units could differ
      const btn = findTranscribeBtn(id);
      const slider = btn && getMessageContainer(btn)?.querySelector('[aria-valuemax]');
      const max = Number(slider?.getAttribute('aria-valuemax'));
      if (max > 0) durations[id] = max;
    }

    // The model's duration is whole seconds, the <audio>'s is exact.
    const match = ids.find(id => Math.abs(durations[id] - d) <= 1);
    if (match) return match;
    // No duration readable for the clicked message: trust a fresh click, as
    // before duration matching, rather than lose karaoke altogether.
    // Same 10 s as the click window: the start waits for the duration to load.
    if (clicked && !clickedHasModelDuration) return clicked;
    return null;
  }

  // The voice notes WhatsApp could auto-advance to after msgId: only the next
  // one, plus a spare, so an unrelated later note can't match a stray sound.
  function nextVoiceIds(msgId) {
    const all = [...document.querySelectorAll('.' + BUTTON_CLASS)].map(b => b.dataset.msgId);
    const i = all.indexOf(msgId);
    return i >= 0 ? all.slice(i + 1, i + 3).filter(Boolean) : [];
  }

  function highlightWordAt(t) {
    // Free users never get word spans; don't query the DOM 60 times a second for none.
    if (!isPro || !activeMsgId) return;

    // Re-find the words when unresolved or when WhatsApp replaced the node
    // they lived in; the new spans start unlit.
    if (activeWordEls === null || !activeWordEls[0].isConnected) {
      const btn = findTranscribeBtn(activeMsgId);
      const textDiv = btn && getMessageContainer(btn)?.querySelector('.wt-result-text.wt-karaoke');
      activeWordEls = textDiv?.querySelectorAll('.wt-w');
      activeWordIndex = -1;
      // Never cache an empty list: the transcription may render mid-playback.
      if (!activeWordEls?.length) {
        activeWordEls = null;
        return;
      }
      // Collapsed shows 3 lines, so the highlight would run out of sight.
      if (textDiv.classList.contains('wt-collapsed')) {
        textDiv.classList.remove('wt-collapsed');
        const toggle = textDiv.parentElement.querySelector('.wt-toggle-btn');
        if (toggle) toggle.innerHTML = '▲ Show less';
      }
    }

    const ts = t + karaokeOffsetMs / 1000;

    // Starts are ascending, so the scan bails at the first word not yet reached.
    let idx = -1;
    for (let i = 0; i < activeWordEls.length; i++) {
      if (parseFloat(activeWordEls[i].dataset.s) <= ts) idx = i;
      else break;
    }

    // Classes only change when the active word does, not every frame.
    if (idx !== activeWordIndex) {
      const prev = activeWordEls[activeWordIndex];
      prev?.classList.remove('wt-now');
      prev?.style.removeProperty('--wt-p');

      // Everything already spoken stays lit, so the edge of the highlight is
      // itself the playhead. Only the words that crossed the edge get touched,
      // which keeps a seek backwards as cheap as normal playback.
      if (idx > activeWordIndex) {
        for (let i = activeWordIndex + 1; i <= idx; i++) activeWordEls[i]?.classList.add('wt-active');
      } else {
        for (let i = activeWordIndex; i > idx; i--) activeWordEls[i]?.classList.remove('wt-active');
      }
      activeWordEls[idx]?.classList.add('wt-now');
      activeWordIndex = idx;
    }

    // The sweep is the one style that moves inside a word, so only it pays the
    // per-frame write.
    const cur = activeWordEls[idx];
    if (cur && karaokeStyle === 'sweep') {
      const s = parseFloat(cur.dataset.s);
      const e = parseFloat(cur.dataset.e) || parseFloat(activeWordEls[idx + 1]?.dataset.s) || s + 0.4;
      const p = Math.min(1, Math.max(0, (ts - s) / (e - s || 0.4)));
      cur.style.setProperty('--wt-p', (p * 100).toFixed(1) + '%');
    }
  }

  function clearHighlight() {
    activeWordEls?.forEach(el => {
      el.classList.remove('wt-active', 'wt-now');
      el.style.removeProperty('--wt-p');
    });
    activeWordIndex = -1;
  }

  function sendSeek(id, time) {
    // The inverse of highlightWordAt's shift, so a clicked word lands where
    // that word lights up.
    time = Math.max(0, time - karaokeOffsetMs / 1000);
    window.postMessage({ source: 'wt-content-script', action: 'seekAudio', id, time }, '*');
  }

  // The popup can flip these while the page is open; without this the user
  // toggles pro and nothing happens until a reload.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[PRO_FLAG_KEY]) {
      isPro = !!changes[PRO_FLAG_KEY].newValue;
      diagLog('info', 'karaoke', `Pro ${isPro ? 'enabled' : 'disabled'} — rerendering transcriptions`);
      rerenderTranscriptions();
    }
    if (changes[KARAOKE_OFFSET_KEY]) {
      karaokeOffsetMs = Number(changes[KARAOKE_OFFSET_KEY].newValue) || 0;
    }
    if (changes[KARAOKE_STYLE_KEY]) {
      applyKaraokeStyle(changes[KARAOKE_STYLE_KEY].newValue);
    }
  });

  // Repaint every visible transcription so the pro toggle takes effect on the
  // spot. Each transcribe button already carries its own msgId.
  function rerenderTranscriptions() {
    clearHighlight();
    activeWordEls = null;
    document.querySelectorAll('.' + BUTTON_CLASS).forEach(btn => {
      const container = getMessageContainer(btn);
      const cached = cacheGet(btn.dataset.msgId);
      if (!container || !cached) return;
      displayTranscription(container, cached.text, false, '', cached.words);
      applyButtonState(btn, cached);
    });
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

  // ========== OUTGOING AUDIO TRANSCRIPTION ==========
  // Intercepts voice recording to offer "Send as Text" option

  const RECORDING_SCAN_INTERVAL = 500;

  // Multi-language pause/resume selectors
  const PAUSE_BTN_SELECTORS = [
    'button[aria-label="Pause recording"]',
    'button[aria-label="Pausar grabación"]',
    'button[aria-label="Pausar gravação"]',
    'button[aria-label="Mettre en pause l\'enregistrement"]',
    'button[aria-label="Aufnahme pausieren"]',
    'button[aria-label="Metti in pausa la registrazione"]',
    'button[aria-label="Приостановить запись"]',
    'button[aria-label="إيقاف التسجيل مؤقتًا"]',
    'button[aria-label="録音を一時停止"]',
    'button[aria-label="暂停录音"]',
    'button[aria-label="녹음 일시중지"]',
  ];

  const RESUME_BTN_SELECTORS = [
    'button[aria-label="Resume recording"]',
    'button[aria-label="Reanudar grabación"]',
    'button[aria-label="Retomar gravação"]',
    'button[aria-label="Reprendre l\'enregistrement"]',
    'button[aria-label="Aufnahme fortsetzen"]',
    'button[aria-label="Riprendi la registrazione"]',
    'button[aria-label="Возобновить запись"]',
    'button[aria-label="استئناف التسجيل"]',
    'button[aria-label="録音を再開"]',
    'button[aria-label="继续录音"]',
    'button[aria-label="녹음 재개"]',
  ];

  const CANCEL_BTN_LABELS = [
    'Cancel', 'Cancelar', 'Annuler', 'Abbrechen', 'Annulla', 'Отмена',
    'إلغاء', 'キャンセル', '取消', '취소',
  ];

  // Language-independent: find a button by its SVG icon title
  function findButtonBySvgTitle(svgTitleText, container) {
    const root = container || document;
    const titles = root.querySelectorAll('svg > title');
    for (const titleEl of titles) {
      if (titleEl.textContent === svgTitleText) {
        const btn = titleEl.closest('button');
        if (btn) return btn;
      }
    }
    return null;
  }

  function findPauseButton() {
    // SVG title first (language-independent)
    let btn = findButtonBySvgTitle('ic-pause-circle');
    if (btn) return btn;
    for (const sel of PAUSE_BTN_SELECTORS) {
      btn = document.querySelector(sel);
      if (btn) return btn;
    }
    return null;
  }

  function findResumeButton() {
    let btn = findButtonBySvgTitle('ic-keyboard-voice-filled');
    if (btn) return btn;
    for (const sel of RESUME_BTN_SELECTORS) {
      btn = document.querySelector(sel);
      if (btn) return btn;
    }
    return null;
  }

  function findRecordingCancelButton() {
    const container = document.querySelector('._ak1r');
    if (!container) return null;
    // Try SVG title within the recording container
    const btn = findButtonBySvgTitle('ic-delete', container);
    if (btn) return btn;
    // Fallback: aria-label
    for (const label of CANCEL_BTN_LABELS) {
      const el = container.querySelector(`button[aria-label="${label}"]`);
      if (el) return el;
    }
    return null;
  }

  function scanForRecordingBar() {
    // Don't interfere while a transcription is in progress
    if (isTranscribing) return;

    const pauseBtn = findPauseButton();
    const resumeBtn = findResumeButton();
    const isRecording = !!(pauseBtn || resumeBtn);

    if (isRecording) {
      const recordingContainer = document.querySelector('._ak1r');
      // Remove any orphan or stale (disabled) transcribe buttons
      document.querySelectorAll('.wt-recording-transcribe-btn').forEach(btn => {
        const isInsideRecording = recordingContainer?.contains(btn);
        const innerBtn = btn.querySelector('button');
        const isStale = innerBtn?.classList.contains('success') || innerBtn?.classList.contains('error');
        if (!isInsideRecording || isStale) btn.remove();
      });
      // Inject fresh button if none exists inside the recording bar
      if (!recordingContainer?.querySelector('.wt-recording-transcribe-btn')) {
        injectTranscribeInRecordingBar(pauseBtn, resumeBtn);
      }
    } else {
      // Recording bar gone — full cleanup
      if (currentTranscriptionPanel) {
        removeTranscriptionPanel();
      }
      removeTranscribeButton();
    }
  }

  function injectTranscribeInRecordingBar(pauseBtn, resumeBtn) {
    const targetBtn = pauseBtn || resumeBtn;
    if (!targetBtn) return;

    // Navigate the DOM to find the right insertion point
    // Structure: ._ak1r > div[tabindex="-1"] > div (flex row) > [child divs for each button group]
    const recordingContainer = document.querySelector('._ak1r');
    if (!recordingContainer) return;

    const tabindexContainer = recordingContainer.querySelector('[tabindex="-1"]');
    if (!tabindexContainer) return;

    const flexRow = tabindexContainer.firstElementChild;
    if (!flexRow) return;

    // Find which direct child of the flex row contains our target button
    let targetWrapper = null;
    for (const child of flexRow.children) {
      if (child.contains(targetBtn)) {
        targetWrapper = child;
        break;
      }
    }
    if (!targetWrapper) {
      diagLog('warn', 'recording', 'Could not find wrapper for pause/resume button');
      return;
    }

    // Create our transcribe button (styled to match WhatsApp's recording bar buttons)
    const btnContainer = document.createElement('div');
    btnContainer.className = 'wt-recording-transcribe-btn';
    btnContainer.innerHTML = `
      <button class="wt-rec-btn-inner" title="Transcribe to Text" aria-label="Transcribe to Text">
        <span class="wt-rec-btn-icon">📝</span>
      </button>
    `;

    // Insert right after the pause/resume wrapper
    if (targetWrapper.nextSibling) {
      flexRow.insertBefore(btnContainer, targetWrapper.nextSibling);
    } else {
      flexRow.appendChild(btnContainer);
    }

    btnContainer.querySelector('button').addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await handleRecordingTranscribe(e.currentTarget);
    });

    diagLog('info', 'recording', 'Transcribe button injected in recording bar');
  }

  async function handleRecordingTranscribe(button) {
    isTranscribing = true;
    try {
      button.disabled = true;
      button.querySelector('.wt-rec-btn-icon').textContent = '⏳';
      button.classList.add('loading');

      // 1. Pause WhatsApp's recording UI so the user can review
      const pauseBtn = findPauseButton();
      if (pauseBtn) {
        pauseBtn.click();
        await new Promise(r => setTimeout(r, 300));
      }

      // 2. Check transcription provider is available
      const providerInfo = await sendMessageToBackground({ action: 'getProviderInfo' });
      if (!providerInfo.ready) {
        throw new Error('No transcription provider configured. Click the extension icon.');
      }

      // 3. Get captured audio from our parallel recorder (getUserMedia interceptor)
      button.querySelector('.wt-rec-btn-icon').textContent = '⏳';
      diagLog('info', 'recording', 'Requesting captured audio from parallel recorder...');
      const audioResponse = await sendToEarlyPatch('getCapturedAudio');

      if (!audioResponse.success) {
        throw new Error(audioResponse.error || 'Could not capture audio');
      }

      if (!audioResponse.data || audioResponse.data.length === 0) {
        throw new Error('Captured audio is empty');
      }

      diagLog('info', 'recording', 'Audio captured from parallel recorder', {
        size: audioResponse.data.length,
        blobSize: audioResponse.blobSize,
        mimeType: audioResponse.mimeType,
        chunks: audioResponse.chunksCount
      });

      // 4. Send to Whisper for transcription
      button.querySelector('.wt-rec-btn-icon').textContent = '⏳';
      const result = await sendMessageToBackground({
        action: 'transcribe',
        audioData: audioResponse.data,
        mimeType: audioResponse.mimeType || 'audio/webm'
      });

      if (!result.success) {
        throw new Error(result.error || 'Transcription failed');
      }

      // 5. Show transcription panel with options
      showRecordingTranscriptionPanel(result.text);
      button.querySelector('.wt-rec-btn-icon').textContent = '✅';
      button.classList.remove('loading');
      button.classList.add('success');

      diagLog('info', 'recording', 'Transcription complete', {
        textLength: result.text.length,
        preview: result.text.substring(0, 80)
      });

    } catch (error) {
      console.error('[WhatsApp Transcriber] Recording transcription error:', error);
      button.querySelector('.wt-rec-btn-icon').textContent = '❌';
      button.classList.remove('loading');
      button.classList.add('error');

      showRecordingTranscriptionPanel('Error: ' + error.message, true);

      setTimeout(() => {
        button.querySelector('.wt-rec-btn-icon').textContent = '📝';
        button.disabled = false;
        button.classList.remove('error');
      }, 3000);
    } finally {
      isTranscribing = false;
    }
  }

  function showRecordingTranscriptionPanel(text, isError = false) {
    removeTranscriptionPanel();

    const panel = document.createElement('div');
    panel.className = 'wt-recording-panel' + (isError ? ' error' : '');
    panel.id = 'wt-recording-transcription-panel';

    panel.innerHTML = `
      <div class="wt-rec-panel-header">
        <span class="wt-rec-panel-icon">${isError ? '⚠️' : '📝'}</span>
        <span class="wt-rec-panel-title">${isError ? 'Error' : 'Transcription'}</span>
        <button class="wt-rec-panel-close" title="Close">✕</button>
      </div>
      <div class="wt-rec-panel-text">${escapeHtml(text)}</div>
      ${!isError ? `
      <div class="wt-rec-panel-actions">
        <button class="wt-rec-action-btn wt-send-text-btn" title="Delete audio and paste text in input">
          ✉️ Send as Text
        </button>
        <button class="wt-rec-action-btn wt-keep-audio-btn" title="Keep the audio, dismiss transcription">
          🎵 Keep Audio
        </button>
        <button class="wt-rec-action-btn wt-copy-text-btn" title="Copy transcription to clipboard">
          📋 Copy
        </button>
      </div>
      ` : ''}
    `;

    // Insert above the recording bar
    const recordingBar = document.querySelector('._ak1r');
    if (recordingBar && recordingBar.parentElement) {
      recordingBar.parentElement.insertBefore(panel, recordingBar);
    } else {
      // Fallback: try the footer
      const footer = document.querySelector('footer');
      if (footer) {
        footer.insertBefore(panel, footer.firstChild);
      }
    }

    currentTranscriptionPanel = panel;

    // Wire up event listeners
    panel.querySelector('.wt-rec-panel-close')?.addEventListener('click', removeTranscriptionPanel);

    panel.querySelector('.wt-send-text-btn')?.addEventListener('click', () => {
      handleSendAsText(text);
    });

    panel.querySelector('.wt-keep-audio-btn')?.addEventListener('click', () => {
      removeTranscriptionPanel();
    });

    panel.querySelector('.wt-copy-text-btn')?.addEventListener('click', async (e) => {
      try {
        await navigator.clipboard.writeText(text);
        e.target.textContent = '✅ Copied';
        setTimeout(() => { e.target.textContent = '📋 Copy'; }, 2000);
      } catch (err) {
        console.error('[WhatsApp Transcriber] Copy error:', err);
      }
    });
  }

  function removeTranscriptionPanel() {
    const panel = document.getElementById('wt-recording-transcription-panel');
    if (panel) {
      panel.remove();
    }
    currentTranscriptionPanel = null;
    removeTranscribeButton();
  }

  function removeTranscribeButton() {
    if (isTranscribing) return;
    document.querySelectorAll('.wt-recording-transcribe-btn').forEach(btn => btn.remove());
  }

  function handleSendAsText(text) {
    const cancelBtn = findRecordingCancelButton();

    // Remove all injected UI before React reconciles the DOM transition
    removeTranscriptionPanel();
    removeTranscribeButton();

    if (cancelBtn) {
      cancelBtn.click();
    }

    // Wait for the recording bar to disappear and the text input to become available
    setTimeout(() => {
      pasteTextInInput(text);
    }, 400);
  }

  function pasteTextInInput(text) {
    // Find WhatsApp's text input (multiple fallback selectors)
    const input = document.querySelector('#main .copyable-area [contenteditable="true"][role="textbox"]')
      || document.querySelector('[contenteditable="true"][data-tab="10"]')
      || document.querySelector('#main [contenteditable="true"]');

    if (!input) {
      diagLog('error', 'recording', 'Could not find text input to paste transcription');
      return;
    }

    // Focus the input
    input.focus();

    // Use ClipboardEvent paste (most reliable for WhatsApp Web's React-based input)
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text', text);
    const pasteEvent = new ClipboardEvent('paste', {
      clipboardData: dataTransfer,
      bubbles: true
    });
    input.dispatchEvent(pasteEvent);

    diagLog('info', 'recording', 'Transcription pasted into text input', { textLength: text.length });
  }

  function startRecordingObserver() {
    if (recordingScanInterval) return;
    recordingScanInterval = setInterval(scanForRecordingBar, RECORDING_SCAN_INTERVAL);
    diagLog('info', 'recording', 'Recording bar observer started');
  }

  // ========== SCANNING & INIT ==========

  function startScanning() {
    if (scanningStarted) return;
    scanningStarted = true;
    
    diagLog('info', 'scan', 'Scanning started');
    
    setTimeout(scanForVoiceMessages, 500);
    setInterval(scanForVoiceMessages, SCAN_INTERVAL);

    // Also start observing for recording bar (outgoing audio feature)
    startRecordingObserver();
  }

  async function init() {
    diagLog('info', 'init', 'Init started', {
      url: window.location.href,
      readyState: document.readyState,
      userAgent: navigator.userAgent,
      language: navigator.language,
      languages: navigator.languages?.join(', ')
    });

    await loadCache();
    diagLog('info', 'cache', `Cache ready: ${transcriptionCache.size} entries, ${getDailyRemaining()} transcriptions left today`);

    injectScript();

    let checkCount = 0;
    const maxChecks = 30;
    
    const checkReady = setInterval(() => {
      checkCount++;
      
      const chatIcon = document.querySelector('[data-icon="chat"]');
      const messages = document.querySelector(MESSAGE_CONTAINER_SELECTOR);
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
        msgContainerCount: document.querySelectorAll('[data-testid="msg-container"]').length,
        roleRowCount: document.querySelectorAll('#main [role="row"]').length,
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
      
      // Transcription cache state
      cache: {
        entriesInMemory: transcriptionCache.size,
        dailyUsed: dailyCounter.count,
        dailyLimit: dailyLimit(),
        dailyRemaining: getDailyRemaining(),
        dailyDate: dailyCounter.date,
        maxEntries: MAX_CACHE_ENTRIES,
        ttlDays: CACHE_TTL_MS / (24 * 60 * 60 * 1000),
      },

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
