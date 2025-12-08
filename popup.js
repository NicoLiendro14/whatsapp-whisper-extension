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
});
