document.addEventListener('DOMContentLoaded', () => {
  const planCard = document.getElementById('planCard');

  const versionEl = document.getElementById('version');
  if (versionEl) {
    versionEl.textContent = 'v' + chrome.runtime.getManifest().version;
  }

  // Sandbox link. Swap for the production checkout link when going live.
  const CHECKOUT_URL =
    'https://sandbox-api.polar.sh/v1/checkout-links/polar_cl_UdRnkyeNfN9bOIwD3GkJlnqC59eoONiHqMNzD205pYf/redirect';

  refreshPlanCard();
  setupProControls();

  function setupProControls() {
    const proStatus = document.getElementById('proStatus');
    const proHint = document.getElementById('proHint');
    const licenseForm = document.getElementById('licenseForm');
    const licenseInput = document.getElementById('licenseInput');
    const activateBtn = document.getElementById('activateBtn');
    const licenseMsg = document.getElementById('licenseMsg');
    const offsetRow = document.getElementById('offsetRow');
    const offsetSlider = document.getElementById('offsetSlider');
    const offsetValue = document.getElementById('offsetValue');

    document.getElementById('getProLink').href = CHECKOUT_URL;

    // Render from the last known state first so the popup never flashes empty,
    // then let the server's verdict correct it.
    const styleSelect = document.getElementById('styleSelect');
    styleSelect.addEventListener('change', () => {
      chrome.storage.local.set({ wt_karaoke_style: styleSelect.value });
    });

    chrome.storage.local.get(['wt_pro', 'wt_license_key', 'wt_karaoke_offset_ms', 'wt_karaoke_style'], (res) => {
      styleSelect.value = res.wt_karaoke_style || 'sweep';
      const offset = Number(res.wt_karaoke_offset_ms) || 0;
      offsetSlider.value = offset;
      offsetValue.textContent = `${offset} ms`;
      if (res.wt_license_key) licenseInput.value = res.wt_license_key;
      render(!!res.wt_pro);
    });

    function render(isPro) {
      proStatus.innerHTML = isPro
        ? 'Pro <span class="pro-badge-on">ACTIVE</span>'
        : 'Free plan';
      proHint.textContent = isPro
        ? 'Karaoke sync and click-to-seek are on. Play any transcribed voice message.'
        : 'Pro adds word-by-word karaoke sync, click-to-seek and 500 transcriptions a day.';
      licenseForm.classList.toggle('hidden', isPro);
      offsetRow.classList.toggle('hidden', !isPro);
    }

    function setMsg(text, cls) {
      licenseMsg.textContent = text;
      licenseMsg.className = 'license-msg' + (cls ? ' ' + cls : '');
    }

    activateBtn.addEventListener('click', async () => {
      const key = licenseInput.value.trim();
      if (!key) return setMsg('Paste the key from your purchase email.', 'err');

      activateBtn.disabled = true;
      setMsg('Checking…');

      // The key is only stored locally; the worker is what actually validates
      // it against Polar, so a bogus key simply comes back as not pro.
      await chrome.storage.local.set({ wt_license_key: key });
      const usage = await sendMessage({ action: 'getUsage' }).catch(() => null);

      activateBtn.disabled = false;

      if (usage?.pro) {
        setMsg('License activated.', 'ok');
        render(true);
        refreshPlanCard();
      } else {
        await chrome.storage.local.remove(['wt_license_key']);
        setMsg('That key was not accepted. Check it and try again.', 'err');
      }
    });

    // 'change' rather than 'input': dragging fires continuously and every write
    // broadcasts a storage event to every open WhatsApp tab.
    offsetSlider.addEventListener('input', () => {
      offsetValue.textContent = `${Number(offsetSlider.value)} ms`;
    });
    offsetSlider.addEventListener('change', () => {
      chrome.storage.local.set({ wt_karaoke_offset_ms: Number(offsetSlider.value) });
    });

    // getUsage writes the authoritative wt_pro, so re-read once it lands.
    setTimeout(() => {
      chrome.storage.local.get(['wt_pro'], (res) => render(!!res.wt_pro));
    }, 1200);
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
        <span class="plan-badge${usage?.pro ? ' pro' : ''}">${usage?.pro ? 'PRO' : 'FREE'}</span>
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
