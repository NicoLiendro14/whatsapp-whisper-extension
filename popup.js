document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('apiKey');
  const saveBtn = document.getElementById('saveBtn');
  const statusDiv = document.getElementById('status');

  loadExistingApiKey();

  saveBtn.addEventListener('click', saveApiKey);

  apiKeyInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      saveApiKey();
    }
  });

  async function loadExistingApiKey() {
    try {
      const result = await chrome.storage.local.get(['openai_api_key']);
      if (result.openai_api_key) {
        const key = result.openai_api_key;
        const masked = key.substring(0, 7) + '...' + key.substring(key.length - 4);
        apiKeyInput.placeholder = masked;
        showStatus('API Key configured ✓', 'info');
      }
    } catch (error) {
      console.error('Error loading API key:', error);
    }
  }

  async function saveApiKey() {
    const apiKey = apiKeyInput.value.trim();

    if (!apiKey) {
      showStatus('Please enter an API Key', 'error');
      return;
    }

    if (!apiKey.startsWith('sk-')) {
      showStatus('API Key must start with "sk-"', 'error');
      return;
    }

    if (apiKey.length < 20) {
      showStatus('API Key seems too short', 'error');
      return;
    }

    try {
      await chrome.storage.local.set({ openai_api_key: apiKey });
      
      apiKeyInput.value = '';
      const masked = apiKey.substring(0, 7) + '...' + apiKey.substring(apiKey.length - 4);
      apiKeyInput.placeholder = masked;
      
      showStatus('API Key saved successfully! 🎉', 'success');
      
      setTimeout(() => {
        showStatus('API Key configured ✓', 'info');
      }, 3000);

    } catch (error) {
      console.error('Error saving API key:', error);
      showStatus('Error saving: ' + error.message, 'error');
    }
  }

  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = 'status ' + type;
  }

  // ========== DIAGNOSTICS ==========
  const diagBtn = document.getElementById('diagBtn');

  diagBtn.addEventListener('click', async () => {
    diagBtn.disabled = true;
    diagBtn.textContent = 'Collecting data...';
    diagBtn.className = '';

    try {
      const report = await collectFullReport();
      const text = formatReport(report);

      // Copy to clipboard
      try {
        await navigator.clipboard.writeText(text);
      } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }

      diagBtn.textContent = 'Copied to clipboard!';
      diagBtn.className = 'success';
    } catch (err) {
      // Even on error, try to copy whatever we got
      const errReport = `=== WhatsApp Transcriber Diagnostic Report ===\nGenerated: ${new Date().toISOString()}\nError: ${err.message}\n`;
      try { await navigator.clipboard.writeText(errReport); } catch (_) {}
      
      diagBtn.textContent = 'Error - copied partial report';
      diagBtn.className = 'error';
    } finally {
      setTimeout(() => {
        diagBtn.disabled = false;
        diagBtn.textContent = 'Run Diagnostics & Copy to Clipboard';
        diagBtn.className = '';
      }, 3000);
    }
  });

  function collectFullReport() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'getDiagnostics' }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  function formatReport(response) {
    const lines = [];
    const hr = '─'.repeat(50);

    lines.push('=== WhatsApp Transcriber Diagnostic Report ===');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');

    if (!response.success) {
      lines.push(`[ERROR] ${response.error}`);
      lines.push('');
      if (response.backgroundInfo) {
        lines.push('Background info:');
        lines.push(JSON.stringify(response.backgroundInfo, null, 2));
      }
      lines.push('');
      lines.push(hr);
      lines.push('RAW RESPONSE:');
      lines.push(JSON.stringify(response, null, 2));
      return lines.join('\n');
    }

    const d = response.diagnostics;

    // --- Section: Environment ---
    lines.push(hr);
    lines.push('ENVIRONMENT');
    lines.push(hr);
    lines.push(`Extension version:  ${d.extensionVersion || 'unknown'}`);
    lines.push(`User agent:         ${d.userAgent}`);
    lines.push(`Chrome version:     ${d.chromeVersion || 'unknown'}`);
    lines.push(`Browser language:   ${d.language}`);
    lines.push(`All languages:      ${d.languages}`);
    lines.push(`Page URL:           ${d.url}`);
    lines.push(`Extension loaded:   ${d.loadedAt}`);
    lines.push(`Uptime:             ${d.uptime}`);

    // --- Section: Extension State ---
    lines.push('');
    lines.push(hr);
    lines.push('EXTENSION STATE');
    lines.push(hr);
    lines.push(`Content script loaded:   ${d.contentScriptLoaded ? 'YES' : 'NO'}`);
    lines.push(`Injected script ready:   ${d.injectedScriptReady ? 'YES' : 'NO'}`);
    lines.push(`Scanning started:        ${d.scanningStarted ? 'YES' : 'NO'}`);
    lines.push(`Currently scanning:      ${d.isCurrentlyScanning ? 'YES' : 'NO'}`);
    lines.push(`Scan count:              ${d.scanCount || 0}`);
    lines.push(`Active selector:         ${d.activeSelector || 'none'}`);
    lines.push(`Selector hits:           ${d.activeSelectorHits || 0}`);
    lines.push(`Total selectors:         ${d.totalSelectorsAvailable || 'unknown'}`);

    // --- Section: DOM State ---
    lines.push('');
    lines.push(hr);
    lines.push('DOM STATE');
    lines.push(hr);
    if (d.dom) {
      lines.push(`#main exists:            ${d.dom.mainExists ? 'YES' : 'NO'}`);
      lines.push(`Chat icon exists:        ${d.dom.chatIconExists ? 'YES' : 'NO'}`);
      lines.push(`Messages in:             ${d.dom.messageInCount}`);
      lines.push(`Messages out:            ${d.dom.messageOutCount}`);
      lines.push(`Audio play icons:        ${d.dom.audioPlayIcons}`);
      lines.push(`Audio pause icons:       ${d.dom.audioPauseIcons}`);
      lines.push(`Processed buttons:       ${d.dom.processedButtons}`);
      lines.push(`Transcribe buttons:      ${d.dom.transcribeButtons}`);
    } else {
      lines.push('DOM data not available');
    }

    // --- Section: Aria Labels ---
    lines.push('');
    lines.push(hr);
    lines.push('ARIA LABELS ANALYSIS');
    lines.push(hr);
    if (d.ariaLabelAnalysis) {
      const aa = d.ariaLabelAnalysis;
      lines.push(`Total unique labels:     ${aa.totalUniqueLabels}`);
      lines.push('');
      lines.push('Audio-related labels:');
      const audioLabels = Object.entries(aa.audioRelatedLabels || {});
      if (audioLabels.length > 0) {
        audioLabels.forEach(([label, count]) => {
          lines.push(`  "${label}" (x${count})`);
        });
      } else {
        lines.push('  NONE FOUND');
      }
      lines.push('');
      lines.push('All aria-labels on page:');
      for (const [label, count] of Object.entries(aa.allLabelsPreview || {})) {
        lines.push(`  "${label}" (x${count})`);
      }
    }

    // --- Section: Injected Script / WA Modules ---
    lines.push('');
    lines.push(hr);
    lines.push('WHATSAPP INTERNAL MODULES');
    lines.push(hr);
    if (d.injectedScriptStatus) {
      const inj = d.injectedScriptStatus;
      if (inj.error) {
        lines.push(`Error: ${inj.error}`);
      } else if (inj.diagnostics) {
        const id = inj.diagnostics;
        lines.push(`Modules loaded:          ${id.modulesLoaded ? 'YES' : 'NO'}`);
        lines.push(`MsgCollection:           ${id.hasMsgCollection ? 'YES' : 'NO'}`);
        lines.push(`DownloadManager:         ${id.hasDownloadManager ? 'YES' : 'NO'}`);
        lines.push(`window.require type:     ${id.requireType}`);
        lines.push(`Load attempts:           ${id.moduleLoadAttempts}`);
        
        if (id.downloadManagerMethods?.length > 0) {
          lines.push(`DL methods:              ${id.downloadManagerMethods.join(', ')}`);
        }
        if (id.msgCollectionMethods?.length > 0) {
          lines.push(`MsgColl methods:         ${id.msgCollectionMethods.join(', ')}`);
        }
        if (id.waWebModulesFound?.length > 0) {
          lines.push(`WAWeb modules (${id.waWebModulesFound.length}):`);
          id.waWebModulesFound.forEach(m => lines.push(`  ${m}`));
        }
        if (id.moduleLoadErrors?.length > 0) {
          lines.push('');
          lines.push('Module load errors:');
          id.moduleLoadErrors.forEach(err => {
            lines.push(`  Attempt #${err.attempt}: ${err.error}`);
            if (err.moduleKeys) lines.push(`    Keys: ${err.moduleKeys.join(', ')}`);
          });
        }
      }
    } else {
      lines.push('No injected script data available');
    }

    // --- Section: Event Log ---
    lines.push('');
    lines.push(hr);
    lines.push('EVENT LOG');
    lines.push(hr);
    if (d.recentLogs && d.recentLogs.length > 0) {
      d.recentLogs.forEach(entry => {
        const time = entry.time?.substring(11, 19) || '??:??:??';
        const extra = entry.extra ? ' ' + JSON.stringify(entry.extra) : '';
        lines.push(`[${time}][${entry.level.toUpperCase().padEnd(5)}][${entry.category}] ${entry.message}${extra}`);
      });
    } else {
      lines.push('No log entries.');
    }

    // --- Section: Raw JSON (for devs) ---
    lines.push('');
    lines.push(hr);
    lines.push('RAW JSON');
    lines.push(hr);
    lines.push(JSON.stringify(d, null, 2));

    return lines.join('\n');
  }
});
