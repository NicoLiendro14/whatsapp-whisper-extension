(function() {
  'use strict';

  console.log('[WhatsApp Transcriber] Injected script loaded');

  let MsgCollection = null;
  let DownloadManager = null;
  let modulesLoaded = false;

  function loadModules() {
    if (modulesLoaded) return true;

    try {
      const msgCollectionModule = window.require('WAWebMsgCollection');
      if (msgCollectionModule?.MsgCollection) {
        MsgCollection = msgCollectionModule.MsgCollection;
        console.log('[WhatsApp Transcriber] MsgCollection loaded');
      }

      const downloadModule = window.require('WAWebDownloadManager');
      if (downloadModule?.downloadManager) {
        DownloadManager = downloadModule.downloadManager;
        console.log('[WhatsApp Transcriber] DownloadManager loaded');
      }

      modulesLoaded = !!(MsgCollection && DownloadManager);
      console.log('[WhatsApp Transcriber] Modules loaded:', modulesLoaded);
      
      return modulesLoaded;

    } catch (error) {
      console.error('[WhatsApp Transcriber] Error loading modules:', error);
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
  });

  setTimeout(() => {
    loadModules();
  }, 1000);

  window.postMessage({
    source: 'wt-injected-script',
    action: 'ready'
  }, '*');

})();
