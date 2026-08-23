document.addEventListener('DOMContentLoaded', () => {
  const planCard = document.getElementById('planCard');

  const versionEl = document.getElementById('version');
  if (versionEl) {
    versionEl.textContent = 'v' + chrome.runtime.getManifest().version;
  }

  refreshPlanCard();
  setupProControls();

  // ponytail: local flag only — a gate with no auth is decorative. Real
  // licensing (key + worker validation) is a separate piece of work.
  function setupProControls() {
    const proToggle = document.getElementById('proToggle');
    const offsetRow = document.getElementById('offsetRow');
    const offsetSlider = document.getElementById('offsetSlider');
    const offsetValue = document.getElementById('offsetValue');

    chrome.storage.local.get(['wt_pro', 'wt_karaoke_offset_ms'], (res) => {
      const on = !!res.wt_pro;
      const offset = Number(res.wt_karaoke_offset_ms) || 0;
      proToggle.checked = on;
      offsetRow.classList.toggle('hidden', !on);
      offsetSlider.value = offset;
      offsetValue.textContent = `${offset} ms`;
    });

    proToggle.addEventListener('change', () => {
      chrome.storage.local.set({ wt_pro: proToggle.checked });
      offsetRow.classList.toggle('hidden', !proToggle.checked);
    });

    offsetSlider.addEventListener('input', () => {
      const v = Number(offsetSlider.value);
      offsetValue.textContent = `${v} ms`;
      chrome.storage.local.set({ wt_karaoke_offset_ms: v });
    });
  }

  async function refreshPlanCard() {
    const [providerInfo, usage] = await Promise.all([
      sendMessage({ action: 'getProviderInfo' }).catch(() => ({ provider: 'none', ready: false })),
      sendMessage({ action: 'getUsage' }).catch(() => null)
    ]);

    if (providerInfo.provider !== 'cloudflare') {
      planCard.className = 'plan-card loading';
      planCard.textContent = 'Service unavailable. Try again later.';
      return;
    }

    planCard.className = 'plan-card free';

    const used = usage?.used ?? 0;
    const limit = usage?.limit ?? '?';
    const remaining = usage?.remaining ?? limit;
    const pct = limit !== '?' ? Math.round((used / limit) * 100) : 0;
    const fillClass = pct >= 100 ? 'full' : pct >= 75 ? 'warn' : 'ok';

    planCard.innerHTML = `
      <div class="plan-title">
        <span class="plan-badge">FREE</span>
        ${remaining} transcriptions left today
      </div>
      <div class="usage-bar"><div class="usage-fill ${fillClass}" style="width:${pct}%"></div></div>
      <div class="usage-text">${used} / ${limit} used today</div>
    `;
  }

  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    });
  }
});
