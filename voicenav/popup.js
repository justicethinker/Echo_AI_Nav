// VoiceNav Popup Script
let currentSettings = {};

chrome.storage.sync.get(null, (settings) => {
  currentSettings = settings;
  updateUI(settings);
});

// Listen for content script errors
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SCRIPT_BLOCKED') {
    const micStatus = document.getElementById('mic-status');
    if (micStatus) {
      micStatus.textContent = '⚠️ VoiceNav unavailable on this page';
      micStatus.style.color = '#fbbf24';
    }
  }
});

function updateUI(settings) {
  // Active mode
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === settings.activationMode);
  });

  // API key status
  const dot = document.getElementById('api-dot');
  const label = document.getElementById('api-label');
  if (settings.apiKey) {
    dot.classList.add('connected');
    label.textContent = 'Claude AI connected';
  } else {
    dot.classList.remove('connected');
    label.textContent = 'No API key (fuzzy match)';
  }
}

// Mode switching
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode;
    chrome.storage.sync.set({ activationMode: mode });
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentSettings.activationMode = mode;

    // Notify content script
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'SETTINGS_UPDATED',
          settings: { activationMode: mode }
        }).catch(() => {});
      }
    });
  });
});

// Mic button in popup
const micBtn = document.getElementById('mic-btn');
const micStatus = document.getElementById('mic-status');
let isListening = false;

micBtn.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    if (!isListening) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'START_LISTENING' }, () => {
        isListening = true;
        micBtn.classList.add('listening');
        micStatus.textContent = 'Listening…';
        micStatus.classList.add('active');
        // Auto-stop UI after 10s
        setTimeout(() => {
          isListening = false;
          micBtn.classList.remove('listening');
          micStatus.textContent = 'Click to speak a navigation command';
          micStatus.classList.remove('active');
        }, 10000);
      });
    } else {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'STOP_LISTENING' });
      isListening = false;
      micBtn.classList.remove('listening');
      micStatus.textContent = 'Click to speak a navigation command';
      micStatus.classList.remove('active');
    }
  });
});

// Open settings
document.getElementById('open-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById('open-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
