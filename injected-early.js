// =====================================================
// WhatsApp Transcriber — Early Injection (getUserMedia Intercept)
// Runs in MAIN world at document_start via manifest.json.
// Intercepts getUserMedia to create a parallel audio recording
// while leaving WhatsApp's own audio pipeline completely untouched.
// =====================================================
(function() {
  'use strict';

  if (window.__wtGetUserMediaPatched) return;
  window.__wtGetUserMediaPatched = true;

  // State for our parallel recording
  window.__wtRecorderState = {
    recorder: null,
    chunks: [],
    mimeType: 'audio/webm;codecs=opus',
    stream: null,
    isRecording: false,
    error: null
  };

  // Choose the best supported mimeType for our parallel recorder
  function chooseMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp4'
    ];
    for (const mt of candidates) {
      if (MediaRecorder.isTypeSupported(mt)) {
        return mt;
      }
    }
    return ''; // let the browser choose default
  }

  // Patch getUserMedia
  const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  navigator.mediaDevices.getUserMedia = async function(constraints) {
    console.log('[WT-Early] getUserMedia called', JSON.stringify(constraints));

    // Call the original — WhatsApp gets its stream as usual
    const stream = await originalGetUserMedia(constraints);

    // Only intercept audio-only requests (voice recording, not video calls)
    if (constraints && constraints.audio && !constraints.video) {
      console.log('[WT-Early] Audio stream detected — starting parallel recording');
      startParallelRecording(stream);
    }

    return stream; // Return the original stream to WhatsApp, untouched
  };

  function startParallelRecording(stream) {
    const state = window.__wtRecorderState;

    // Clean up any existing recorder
    stopParallelRecording();

    try {
      const mimeType = chooseMimeType();
      state.mimeType = mimeType || 'audio/webm';
      state.chunks = [];
      state.stream = stream;
      state.error = null;

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          state.chunks.push(e.data);
        }
      };

      recorder.onstart = () => {
        state.isRecording = true;
        console.log('[WT-Early] Parallel recorder started');
        window.postMessage({ source: 'wt-early-patch', action: 'recorderStarted' }, '*');
      };

      recorder.onstop = () => {
        state.isRecording = false;
        console.log('[WT-Early] Parallel recorder stopped, chunks:', state.chunks.length);
        window.postMessage({ source: 'wt-early-patch', action: 'recorderStopped' }, '*');
      };

      recorder.onerror = (e) => {
        state.error = e.error?.message || 'Unknown recorder error';
        console.error('[WT-Early] Parallel recorder error:', state.error);
      };

      // Start recording with timeslice (get data every second)
      recorder.start(1000);
      state.recorder = recorder;

      // Detect when WhatsApp releases the microphone (stream tracks end)
      stream.getAudioTracks().forEach(track => {
        track.addEventListener('ended', () => {
          console.log('[WT-Early] Audio track ended — stopping parallel recorder');
          stopParallelRecording();
        });
      });

    } catch (e) {
      console.error('[WT-Early] Failed to start parallel recording:', e);
      state.error = e.message;
    }
  }

  function stopParallelRecording() {
    const state = window.__wtRecorderState;
    if (state.recorder && state.recorder.state !== 'inactive') {
      try {
        state.recorder.stop();
      } catch (e) { /* already stopped */ }
    }
  }

  // ── Voice message playback clock (for word-level karaoke sync) ──
  // WhatsApp plays voice messages through an <audio> element created with
  // new Audio() that it never inserts into the DOM. It stays detached, so the
  // content script (isolated world) cannot reach it by any DOM query. The only
  // handle on it is intercepting play() here in the MAIN world.

  // Every message carries the audio's id: notification sounds and WhatsApp's
  // auto-advance also go through play(), so "whatever played last" is not
  // necessarily the voice note the content script is highlighting.
  // A new src gets a new id in case WhatsApp reuses one element across notes.
  const audioInfo = new WeakMap(); // el -> { id, src, pendingStart }
  // Strong refs so a click-to-seek still has something to seek after the end,
  // when WhatsApp may already have dropped the element.
  // ponytail: keeps the 20 last played, a claimed audio older than that can't be seeked
  const audiosById = new Map();
  let nextAudioId = 0;
  const ticking = new Set();
  let tickRaf = null;

  function post(action, el, extra) {
    window.postMessage({ source: 'wt-early-patch', action, id: audioInfo.get(el).id, ...extra }, '*');
  }

  function postTick(el) {
    post('audioTick', el, { t: el.currentTime, d: el.duration });
  }

  function stopTicking(el, ended) {
    if (!ticking.delete(el)) return;
    // Pause freezes the highlight where it is; only a real end clears it.
    post('audioStopped', el, { ended: !!ended });
  }

  function tick() {
    tickRaf = null;
    for (const el of ticking) {
      if (el.ended) stopTicking(el, true);
      else if (el.paused) stopTicking(el, false);
      // currentTime is media time, so playbackRate (WhatsApp's 1×/1.5×/2×
      // control) is already baked in — nothing to compensate for.
      else postTick(el);
    }
    if (ticking.size) tickRaf = requestAnimationFrame(tick);
  }

  // Duration is the content script's only way to tell which voice note this
  // is, and it's often NaN at play() time. A non-finite one (live streams)
  // never gets ticked: it would post 60 messages a second forever.
  function maybeStart(el) {
    const info = audioInfo.get(el);
    if (!info.pendingStart || !Number.isFinite(el.duration)) return;
    info.pendingStart = false;
    post('audioStarted', el, { d: el.duration });
    ticking.add(el);
    if (!tickRaf) tickRaf = requestAnimationFrame(tick);
  }

  const originalPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function() {
    if (this.tagName === 'AUDIO') {
      let info = audioInfo.get(this);
      if (!info) {
        const el = this;
        // Capture runs before WhatsApp's own listeners on the element, so the
        // end is posted before its handler can reset this playhead or play()
        // the next note (whose start must arrive after this end to match).
        el.addEventListener('ended', () => stopTicking(el, true), true);
        el.addEventListener('durationchange', () => maybeStart(el));
        // Media keys / headset resume without calling the JS play().
        el.addEventListener('play', () => {
          if (ticking.has(el)) return;
          audioInfo.get(el).pendingStart = true;
          maybeStart(el);
        });
      }
      if (!info || info.src !== this.src) {
        if (info) {
          // An auto-advance can swap src inside WhatsApp's own 'ended' handler,
          // before ours runs; close the old note out now, under its own id.
          stopTicking(this, true);
          audiosById.delete(info.id);
        }
        info = { id: ++nextAudioId, src: this.src, pendingStart: false };
        audioInfo.set(this, info);
      }
      // Re-inserted on every play(), so the cap drops the least recently played.
      audiosById.delete(info.id);
      audiosById.set(info.id, this);
      if (audiosById.size > 20) audiosById.delete(audiosById.keys().next().value);
      // Re-announced on every play() with the same id, so a resume or the
      // play() our own seek triggers reads as "same audio", not a new one.
      info.pendingStart = true;
      // WhatsApp's 'ended' handler runs before ours and may play() the next
      // note's own element; if that one already has metadata, its start would
      // reach the content script before the old note's end and never be matched.
      for (const o of ticking) if (o !== this && o.ended) stopTicking(o, true);
      maybeStart(this);
    }
    return originalPlay.apply(this, arguments);
  };

  // Listen for requests from the content script
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== 'wt-content-script') return;

    if (msg.action === 'getCapturedAudio') {
      handleGetCapturedAudio(msg.requestId);
    }

    // Click-to-seek: the content script can't touch the detached element, so
    // it asks us to move the playhead. WhatsApp's own UI listens to this
    // element's events, so driving it directly keeps its button and waveform
    // in sync — no need to fake clicks on its controls.
    // Seeks the audio the content script claimed, by id, not whatever played last.
    const el = msg.action === 'seekAudio' && audiosById.get(msg.id);
    if (el) {
      const applySeek = () => {
        try {
          el.currentTime = msg.time;
          postTick(el); // repaint the highlight even if we stay paused
          // Moving the playhead of a paused audio is silent, which reads as
          // "the click did nothing". Resume so the jump is audible.
          if (el.paused) el.play();
        } catch (e) { /* not seekable */ }
      };
      // Seeking before metadata is in throws; wait for it when just started.
      if (el.readyState >= 1) applySeek();
      else el.addEventListener('loadedmetadata', applySeek, { once: true });
    }

    if (msg.action === 'stopParallelRecording') {
      stopParallelRecording();
      window.postMessage({
        source: 'wt-early-patch',
        action: 'stopResult',
        requestId: msg.requestId,
        success: true
      }, '*');
    }
  });

  function handleGetCapturedAudio(requestId) {
    const state = window.__wtRecorderState;

    // If recorder is still running, stop it first to flush all data
    if (state.recorder && state.recorder.state === 'recording') {
      // Request data flush then stop
      try { state.recorder.requestData(); } catch (e) { /* ignore */ }

      // Wait for final dataavailable event, then assemble
      setTimeout(() => assembleAndSend(requestId), 300);
      return;
    }

    // If recorder is paused, also request data flush
    if (state.recorder && state.recorder.state === 'paused') {
      try { state.recorder.requestData(); } catch (e) { /* ignore */ }
      setTimeout(() => assembleAndSend(requestId), 300);
      return;
    }

    // Recorder already stopped — data should be ready
    assembleAndSend(requestId);
  }

  function assembleAndSend(requestId) {
    const state = window.__wtRecorderState;

    if (!state.chunks || state.chunks.length === 0) {
      window.postMessage({
        source: 'wt-early-patch',
        action: 'capturedAudioResult',
        requestId,
        success: false,
        error: 'No audio chunks captured. ' + (state.error || 'Recorder may not have started.')
      }, '*');
      return;
    }

    try {
      const blob = new Blob(state.chunks, { type: state.mimeType });
      console.log('[WT-Early] Assembling audio blob:', blob.size, 'bytes from', state.chunks.length, 'chunks');

      const reader = new FileReader();
      reader.onload = function() {
        const uint8Array = new Uint8Array(this.result);
        const dataArray = Array.from(uint8Array);

        window.postMessage({
          source: 'wt-early-patch',
          action: 'capturedAudioResult',
          requestId,
          success: true,
          data: dataArray,
          mimeType: state.mimeType,
          chunksCount: state.chunks.length,
          blobSize: blob.size
        }, '*');
      };
      reader.onerror = function() {
        window.postMessage({
          source: 'wt-early-patch',
          action: 'capturedAudioResult',
          requestId,
          success: false,
          error: 'Failed to read audio blob'
        }, '*');
      };
      reader.readAsArrayBuffer(blob);

    } catch (e) {
      window.postMessage({
        source: 'wt-early-patch',
        action: 'capturedAudioResult',
        requestId,
        success: false,
        error: 'Error assembling audio: ' + e.message
      }, '*');
    }
  }

  console.log('[WT-Early] getUserMedia interceptor installed');
})();
