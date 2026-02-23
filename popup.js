document.addEventListener('DOMContentLoaded', () => {
  const planCard = document.getElementById('planCard');

  refreshPlanCard();

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
