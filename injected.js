(function() {
  'use strict';

  console.log('[WhatsApp Transcriber] Injected script loaded');

  let MsgCollection = null;
  let DownloadManager = null;
  let modulesLoaded = false;
  let moduleLoadErrors = [];
  let moduleLoadAttempts = 0;

  function notifyContentScript(action, data = {}) {
    window.postMessage({ source: 'wt-injected-script', action, ...data }, '*');
  }

  function logToContent(level, message, extra = null) {
    notifyContentScript(level === 'error' ? 'logError' : 'logInfo', { message, extra });
  }

  function loadModules() {
    if (modulesLoaded) return true;
    moduleLoadAttempts++;

    try {
      // Check if require exists
      if (typeof window.require !== 'function') {
        const err = 'window.require is not available (type: ' + typeof window.require + ')';
        moduleLoadErrors.push({ attempt: moduleLoadAttempts, error: err });
        logToContent('error', err);
        return false;
      }

      try {
        const msgCollectionModule = window.require('WAWebMsgCollection');
        if (msgCollectionModule?.MsgCollection) {
          MsgCollection = msgCollectionModule.MsgCollection;
          logToContent('info', 'MsgCollection loaded successfully');
        } else {
          const keys = msgCollectionModule ? Object.keys(msgCollectionModule).slice(0, 10) : [];
          moduleLoadErrors.push({ attempt: moduleLoadAttempts, error: 'MsgCollection not found in module', moduleKeys: keys });
          logToContent('error', 'MsgCollection not found in module', { keys });
        }
      } catch (e) {
        moduleLoadErrors.push({ attempt: moduleLoadAttempts, error: 'WAWebMsgCollection: ' + e.message });
        logToContent('error', 'Failed to require WAWebMsgCollection: ' + e.message);
      }

      try {
        const downloadModule = window.require('WAWebDownloadManager');
        if (downloadModule?.downloadManager) {
          DownloadManager = downloadModule.downloadManager;
          logToContent('info', 'DownloadManager loaded successfully');
        } else {
          const keys = downloadModule ? Object.keys(downloadModule).slice(0, 10) : [];
          moduleLoadErrors.push({ attempt: moduleLoadAttempts, error: 'downloadManager not found in module', moduleKeys: keys });
          logToContent('error', 'downloadManager not found in module', { keys });
        }
      } catch (e) {
        moduleLoadErrors.push({ attempt: moduleLoadAttempts, error: 'WAWebDownloadManager: ' + e.message });
        logToContent('error', 'Failed to require WAWebDownloadManager: ' + e.message);
      }

      modulesLoaded = !!(MsgCollection && DownloadManager);
      logToContent('info', 'Module load result: ' + (modulesLoaded ? 'SUCCESS' : 'PARTIAL/FAILED'), {
        hasMsgCollection: !!MsgCollection,
        hasDownloadManager: !!DownloadManager
      });
      
      return modulesLoaded;

    } catch (error) {
      moduleLoadErrors.push({ attempt: moduleLoadAttempts, error: error.message, stack: error.stack?.substring(0, 200) });
      logToContent('error', 'Exception loading modules: ' + error.message);
      return false;
    }
  }

  function getMessageModel(msgId) {
    if (!MsgCollection) {
      loadModules();
      if (!MsgCollection) return null;
    }

    if (MsgCollection.get) {
      const msg = MsgCollection.get(msgId);
      if (msg) {
        console.log('[WhatsApp Transcriber] Message found with get()');
        return msg;
      }
    }

    if (MsgCollection.getModelsArray) {
      const models = MsgCollection.getModelsArray();
      
      for (const model of models) {
        const modelId = model.id?._serialized || model.id?.toString() || '';
        if (modelId === msgId || modelId.includes(msgId) || msgId.includes(modelId)) {
          console.log('[WhatsApp Transcriber] Message found in array');
          return model;
        }
      }

      const msgHash = msgId.split('_').pop();
      if (msgHash) {
        for (const model of models) {
          const modelId = model.id?._serialized || model.id?.toString() || '';
          if (modelId.includes(msgHash)) {
            console.log('[WhatsApp Transcriber] Message found by hash');
            return model;
          }
        }
      }
    }

    if (MsgCollection._models) {
      for (const [id, model] of MsgCollection._models) {
        if (id === msgId || id.includes(msgId) || msgId.includes(id)) {
          console.log('[WhatsApp Transcriber] Message found in _models');
          return model;
        }
      }
    }

    console.warn('[WhatsApp Transcriber] Message not found:', msgId);
    return null;
  }

  async function downloadAudio(msgId) {
    try {
      if (!loadModules()) {
        throw new Error('Could not load WhatsApp modules. Reload the page.');
      }

      const msg = getMessageModel(msgId);
      if (!msg) {
        throw new Error('Message not found. ID: ' + msgId);
      }

      const msgType = msg.type;
      console.log('[WhatsApp Transcriber] Message type:', msgType);
      
      if (msgType !== 'ptt' && msgType !== 'audio') {
        throw new Error('Message is not an audio (type: ' + msgType + ')');
      }

      if (!msg.mediaKey) {
        throw new Error('Message has no mediaKey');
      }

      console.log('[WhatsApp Transcriber] Downloading audio...');
      console.log('[WhatsApp Transcriber] directPath:', msg.directPath);
      console.log('[WhatsApp Transcriber] filehash:', msg.filehash);

      const downloadParams = {
        directPath: msg.directPath,
        encFilehash: msg.encFilehash,
        filehash: msg.filehash,
        mediaKey: msg.mediaKey,
        mediaKeyTimestamp: msg.mediaKeyTimestamp,
        type: msgType
      };

      let arrayBuffer = null;

      if (DownloadManager.downloadAndMaybeDecrypt) {
        console.log('[WhatsApp Transcriber] Using downloadAndMaybeDecrypt');
        arrayBuffer = await DownloadManager.downloadAndMaybeDecrypt(downloadParams);
      }
      else if (DownloadManager.downloadAndDecrypt) {
        console.log('[WhatsApp Transcriber] Using downloadAndDecrypt');
        arrayBuffer = await DownloadManager.downloadAndDecrypt(downloadParams);
      }
      else if (DownloadManager.download) {
        console.log('[WhatsApp Transcriber] Using download');
        arrayBuffer = await DownloadManager.download(downloadParams);
      }
      else {
        const methods = Object.keys(DownloadManager).filter(k => typeof DownloadManager[k] === 'function');
        console.log('[WhatsApp Transcriber] Available methods:', methods);
        throw new Error('No download method found. Methods: ' + methods.join(', '));
      }

      if (!arrayBuffer || arrayBuffer.byteLength === 0) {
        throw new Error('Downloaded audio is empty');
      }

      console.log('[WhatsApp Transcriber] Audio downloaded:', arrayBuffer.byteLength, 'bytes');

      const uint8Array = new Uint8Array(arrayBuffer);
      const dataArray = Array.from(uint8Array);

      return {
        success: true,
        data: dataArray,
        mimeType: msg.mimetype || 'audio/ogg'
      };

    } catch (error) {
      console.error('[WhatsApp Transcriber] Error downloading audio:', error);
      
      console.log('[WhatsApp Transcriber] Trying alternative method (cache)...');
      return await downloadAudioFromCache(msgId);
    }
  }

  async function downloadAudioFromCache(msgId) {
    try {
      const msg = getMessageModel(msgId);
      if (!msg?.filehash) {
        throw new Error('Could not get filehash from message');
      }

      console.log('[WhatsApp Transcriber] Searching cache for filehash:', msg.filehash);

      const cacheKeys = [
        `https://_media_cache_v2_.whatsapp.com/${encodeURIComponent(`lru-media-array-buffer-cache_${msg.filehash}`)}`,
        `lru-media-array-buffer-cache_${msg.filehash}`,
        msg.filehash
      ];

      const cacheNames = await caches.keys();
      console.log('[WhatsApp Transcriber] Available caches:', cacheNames);

      for (const cacheName of cacheNames) {
        const cache = await caches.open(cacheName);
        
        for (const cacheKey of cacheKeys) {
          const response = await cache.match(cacheKey);
          if (response) {
            const buffer = await response.arrayBuffer();
            console.log('[WhatsApp Transcriber] Audio found in cache:', buffer.byteLength, 'bytes');
            
            const uint8Array = new Uint8Array(buffer);
            return {
              success: true,
              data: Array.from(uint8Array),
              mimeType: msg.mimetype || 'audio/ogg'
            };
          }
        }
      }

      throw new Error('Audio not found in cache. Play the audio first and try again.');

    } catch (error) {
      console.error('[WhatsApp Transcriber] Cache error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    
    const message = event.data;
    if (!message || message.source !== 'wt-content-script') return;

    if (message.action === 'downloadAudio') {
      console.log('[WhatsApp Transcriber] Download request received:', message.msgId);
      const result = await downloadAudio(message.msgId);
      
      window.postMessage({
        source: 'wt-injected-script',
        action: 'audioDownloaded',
        requestId: message.requestId,
        ...result
      }, '*');
    }

    if (message.action === 'checkStore') {
      const loaded = loadModules();
      
      window.postMessage({
        source: 'wt-injected-script',
        action: 'storeStatus',
        requestId: message.requestId,
        storeAvailable: !!MsgCollection,
        downloadManagerAvailable: !!DownloadManager
      }, '*');
    }

    if (message.action === 'getDiagnostics') {
      // Collect detailed diagnostics from the injected script context
      let requireInfo = 'unknown';
      let availableModules = [];
      try {
        requireInfo = typeof window.require;
        if (typeof window.require === 'function' && window.require.m) {
          // Try to list some module names
          const moduleKeys = Object.keys(window.require.m);
          availableModules = moduleKeys.filter(k => k.includes('WAWeb')).slice(0, 30);
        }
      } catch (e) {
        requireInfo = 'error checking: ' + e.message;
      }

      let downloadManagerMethods = [];
      if (DownloadManager) {
        try {
          downloadManagerMethods = Object.keys(DownloadManager).filter(k => typeof DownloadManager[k] === 'function');
        } catch (e) {}
      }

      let msgCollectionMethods = [];
      if (MsgCollection) {
        try {
          msgCollectionMethods = Object.keys(MsgCollection).filter(k => typeof MsgCollection[k] === 'function').slice(0, 20);
        } catch (e) {}
      }

      window.postMessage({
        source: 'wt-injected-script',
        action: 'injectedDiagnostics',
        requestId: message.requestId,
        diagnostics: {
          modulesLoaded,
          hasMsgCollection: !!MsgCollection,
          hasDownloadManager: !!DownloadManager,
          moduleLoadAttempts,
          moduleLoadErrors: moduleLoadErrors.slice(-10),
          requireType: requireInfo,
          waWebModulesFound: availableModules,
          downloadManagerMethods,
          msgCollectionMethods
        }
      }, '*');
    }
  });

  setTimeout(() => {
    loadModules();
  }, 1000);

  // Retry module loading a few times
  setTimeout(() => {
    if (!modulesLoaded) {
      logToContent('info', 'Retrying module load (3s)...');
      loadModules();
    }
  }, 3000);

  setTimeout(() => {
    if (!modulesLoaded) {
      logToContent('warn', 'Retrying module load (8s - last attempt)...');
      loadModules();
    }
  }, 8000);

  window.postMessage({
    source: 'wt-injected-script',
    action: 'ready'
  }, '*');

})();
