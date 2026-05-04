// PandyBot Popup Script

const webhookInput = document.getElementById('webhookUrl');
const saveBtn = document.getElementById('save-btn');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const toast = document.getElementById('toast');

let toastTimeout = null;

function showToast(msg, type = 'success') {
  toast.textContent = msg;
  toast.className = `toast show ${type}`;
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.className = 'toast';
  }, 2500);
}

function updateStatus(webhookUrl) {
  if (webhookUrl && webhookUrl.includes('discord.com/api/webhooks')) {
    statusDot.className = 'status-dot active';
    statusText.textContent = 'Webhook configured';
  } else {
    statusDot.className = 'status-dot error';
    statusText.textContent = 'No webhook set';
  }
}

// Load saved config
chrome.storage.sync.get(['pandybot_config'], (result) => {
  const config = result.pandybot_config || {};
  webhookInput.value = config.webhookUrl || '';
  updateStatus(config.webhookUrl || '');
});

saveBtn.addEventListener('click', () => {
  const webhookUrl = webhookInput.value.trim();

  if (webhookUrl && !webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
    showToast('Invalid Discord webhook URL', 'error');
    return;
  }

  const config = { webhookUrl };
  chrome.storage.sync.set({ pandybot_config: config }, () => {
    updateStatus(webhookUrl);
    showToast('Saved!', 'success');
  });
});

webhookInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveBtn.click();
});
