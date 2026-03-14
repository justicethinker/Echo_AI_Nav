// VoiceNav Content Script
(function () {
  if (window.__voiceNavInjected) return;
  window.__voiceNavInjected = true;

  let settings = {};
  let recognition = null;
  let isListening = false;
  let isProcessing = false;
  let optionLinks = [];
  let awaitingOptionChoice = false;
  let toastTimeout = null;
  let alwaysListeningActive = false;
  
  const navigationHistory = JSON.parse(sessionStorage.getItem('voicenavHistory') || '[]').slice(-10);
  let lastNavigationTime = 0;
  
  let domObserver = null;
  let linkRefreshTimer = null;
  let cachedLinks = null;
  let lastConfidence = 0;
  
  let audioContext = null;
  let analyser = null;
  let audioLevelCheckTimer = null;
  
  function speak(text) {
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.2;
      utterance.pitch = 1;
      speechSynthesis.cancel();
      speechSynthesis.speak(utterance);
    } catch (e) {
      console.log('[VoiceNav] TTS unavailable:', e.message);
    }
  }
  
  function categorizeLink(el) {
    const tag = el.tagName.toLowerCase();
    const parent = el.closest('nav, header, footer, aside, [role="navigation"]');
    const text = (el.innerText || el.textContent || '').toLowerCase();
    
    if (parent?.tagName.toLowerCase() === 'nav' || (parent?.hasAttribute('role') && parent.getAttribute('role') === 'navigation')) return 'nav';
    if (tag === 'button') return 'button';
    if (text.includes('social') || text.includes('facebook') || text.includes('twitter') || text.includes('instagram') || text.includes('linkedin')) return 'social';
    if (el.closest('footer')) return 'footer';
    if (el.closest('aside')) return 'sidebar';
    return 'link';
  }

  const root = document.createElement('div');
  root.id = 'voicenav-root';
  root.innerHTML = '<div id="voicenav-overlay"><div id="voicenav-available-links"></div><div id="voicenav-options-panel"></div><div id="voicenav-toast"></div><button id="voicenav-fab" title="VoiceNav"><svg class="voicenav-mic-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg></button></div>';
  document.body.appendChild(root);

  const fab = document.getElementById('voicenav-fab');
  const toast = document.getElementById('voicenav-toast');
  const optionsPanel = document.getElementById('voicenav-options-panel');
  const availableLinksPanel = document.getElementById('voicenav-available-links');

  chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (s) => {
    settings = s || {};
    initActivationMode();
  });

  chrome.storage.onChanged.addListener((changes) => {
    Object.keys(changes).forEach(k => settings[k] = changes[k].newValue);
    initActivationMode();
  });

  function initDOMObserver() {
    if (domObserver) domObserver.disconnect();
    
    domObserver = new MutationObserver(() => {
      clearTimeout(linkRefreshTimer);
      linkRefreshTimer = setTimeout(() => {
        cachedLinks = null;
        if (isListening && !awaitingOptionChoice) {
          showAvailableLinks();
        }
      }, 800);
    });

    domObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: false
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDOMObserver);
  } else {
    initDOMObserver();
  }

  function initActivationMode() {
    const mode = settings.activationMode || 'popup';
    document.removeEventListener('keydown', hotkeyHandler);
    fab.style.display = 'flex';
    stopListening();

    if (mode === 'always') {
      fab.style.display = 'none';
      startAlwaysListening();
    } else if (mode === 'hotkey') {
      fab.style.display = 'none';
      document.addEventListener('keydown', hotkeyHandler);
      showToast('Press ' + (settings.hotkey || 'Space') + ' to activate VoiceNav', 3000);
    } else if (mode === 'wakeword') {
      fab.style.display = 'none';
      startAlwaysListening(true);
      showToast('Say "' + (settings.wakeWord || 'hey nav') + '" to activate', 3000);
    } else {
      fab.style.display = 'flex';
    }
  }

  function hotkeyHandler(e) {
    const hotkey = settings.hotkey || 'Space';
    if (e.code === hotkey && !e.target.matches('input, textarea, [contenteditable]')) {
      e.preventDefault();
      toggleListening();
    }
  }

  fab.addEventListener('click', () => {
    if (awaitingOptionChoice) {
      resetOptions();
      return;
    }
    toggleListening();
  });

  function createRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return null;
    const r = new SpeechRecognition();
    r.continuous = false;
    r.interimResults = true;
    r.lang = 'en-US';
    return r;
  }

  function toggleListening() {
    if (isListening) stopListening();
    else startListening();
  }

  function startListening() {
    if (isListening || isProcessing) return;
    recognition = createRecognition();
    if (!recognition) {
      showToast('Speech recognition not supported', 3000);
      return;
    }

    isListening = true;
    fab.classList.add('listening');
    showToast('Listening...', 0);
    showAvailableLinks();
    
    clearInterval(linkRefreshTimer);
    linkRefreshTimer = setInterval(() => {
      if (isListening && !awaitingOptionChoice) {
        cachedLinks = null;
        showAvailableLinks();
      }
    }, 4000);
    
    initAudioLevelMonitoring();

    let finalTranscript = '';

    recognition.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalTranscript += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      showToast('Listening: ' + (finalTranscript || interim), 0);
    };

    recognition.onend = () => {
      isListening = false;
      fab.classList.remove('listening');
      clearInterval(linkRefreshTimer);
      clearInterval(audioLevelCheckTimer);
      cachedLinks = null;
      if (finalTranscript.trim()) handleCommand(finalTranscript.trim());
      else showToast('Nothing heard. Try again.', 2500);
    };

    recognition.onerror = (e) => {
      isListening = false;
      clearInterval(linkRefreshTimer);
      clearInterval(audioLevelCheckTimer);
      fab.classList.remove('listening');
      if (e.error !== 'no-speech') showToast('Mic error: ' + e.error, 3000);
      else showToast('Nothing heard. Try again.', 2500);
    };

    recognition.start();
  }

  function stopListening() {
    if (recognition) {
      try { recognition.stop(); } catch (e) {}
      recognition = null;
    }
    isListening = false;
    fab.classList.remove('listening');
    hideAvailableLinks();
  }

  function startAlwaysListening(wakeWordMode = false) {
    alwaysListeningActive = true;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const r = new SpeechRecognition();
    r.continuous = true;
    r.interimResults = false;
    r.lang = 'en-US';
    let activated = false;

    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (!e.results[i].isFinal) continue;
        const text = e.results[i][0].transcript.trim().toLowerCase();

        if (wakeWordMode && !activated) {
          const wakeWord = (settings.wakeWord || 'hey nav').toLowerCase();
          if (text.includes(wakeWord)) {
            activated = true;
            showToast('Listening...', 0);
            fab.style.display = 'flex';
            fab.classList.add('listening');
            showAvailableLinks();
          }
          return;
        }

        if (awaitingOptionChoice) {
          handleOptionVoiceChoice(text);
        } else {
          handleCommand(text);
        }
        activated = false;
        if (wakeWordMode) {
          fab.style.display = 'none';
          hideAvailableLinks();
        }
      }
    };

    r.onend = () => {
      if (alwaysListeningActive) setTimeout(() => { try { r.start(); } catch(e){} }, 300);
    };

    r.onerror = () => {
      if (alwaysListeningActive) setTimeout(() => { try { r.start(); } catch(e){} }, 1000);
    };

    try { r.start(); } catch(e) {}
    recognition = r;
  }

  async function handleCommand(transcript) {
    if (isProcessing) return;

    const lowerTranscript = transcript.toLowerCase();
    if (/go back|previous page|go previous/i.test(lowerTranscript)) {
      hideAvailableLinks();
      showToast('Going back...', 0);
      speak('Going back');
      if (navigationHistory.length > 0) {
        navigationHistory.pop();
        sessionStorage.setItem('voicenavHistory', JSON.stringify(navigationHistory));
      }
      setTimeout(() => window.history.back(), 700);
      return;
    }

    if (awaitingOptionChoice) {
      handleOptionVoiceChoice(transcript.toLowerCase());
      return;
    }

    isProcessing = true;
    fab.classList.add('processing');
    showToast('Processing: ' + transcript, 0);

    const links = collectLinks();

    chrome.runtime.sendMessage({
      type: 'PROCESS_VOICE_COMMAND',
      transcript,
      links
    }, (result) => {
      isProcessing = false;
      fab.classList.remove('processing');

      if (!result || result.error) {
        let errorMsg = 'Something went wrong.';
        if (result?.error?.includes('API')) {
          errorMsg = 'API Error: Check your API key';
        } else if (result?.error?.includes('timeout')) {
          errorMsg = 'Request timed out';
        } else if (result?.error?.includes('quota')) {
          errorMsg = 'API quota exceeded';
        }
        
        lastConfidence = result?.confidence || 0;
        showToast(errorMsg, 4000);
        speak(errorMsg);
        return;
      }

      if (result.noMatch || result.matches.length === 0) {
        handleNoMatch(transcript);
        return;
      }

      lastConfidence = result.confidence || 0;

      if (result.confidence >= (settings.confidence_threshold || 0.75) && result.matches.length === 1) {
        navigateToMatch(result.matches[0]);
      } else {
        showOptions(result.matches, transcript, result.confidence);
      }
    });
  }

  function collectLinks() {
    if (cachedLinks && !isListening) return cachedLinks;
    
    const anchors = new Set();
    
    document.querySelectorAll('a[href], button:not([disabled]), [role="link"], [role="button"]')
      .forEach(el => {
        if (el.offsetParent || el.offsetHeight > 0) anchors.add(el);
      });

    const allElements = document.querySelectorAll('*');
    for (let el of allElements) {
      if (el.shadowRoot) {
        el.shadowRoot.querySelectorAll('a[href], button:not([disabled]), [role="link"], [role="button"]')
          .forEach(shadowEl => {
            if (shadowEl.offsetParent || shadowEl.offsetHeight > 0) anchors.add(shadowEl);
          });
      }
    }

    const seen = new Set();
    const links = Array.from(anchors).map(el => {
      const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
      const href = el.href || el.getAttribute('data-href') || window.location.href;
      
      if (!text || seen.has(text.toLowerCase())) return null;
      seen.add(text.toLowerCase());
      
      return { text, href, el };
    }).filter(Boolean).slice(0, 100);

    cachedLinks = links;
    return links;
  }

  function navigateToMatch(match) {
    const now = new Date().toISOString();
    hideAvailableLinks();
    stopListening();
    awaitingOptionChoice = false;

    const target = collectLinks().find(l => l.text === match.text);

    if (target && target.el) {
      target.el.classList.add('voicenav-highlight');
      showToast('Going to ' + match.text, 0);
      speak('Navigating to ' + match.text);
      
      const histEntry = { url: target.el.href || match.href, title: match.text, time: now };
      navigationHistory.push(histEntry);
      sessionStorage.setItem('voicenavHistory', JSON.stringify(navigationHistory.slice(-10)));
      
      setTimeout(() => {
        target.el.classList.remove('voicenav-highlight');
        target.el.click();
        if (target.el.href) window.location.href = target.el.href;
        hideToast(1500);
      }, 700);
    } else if (match.href && match.href !== window.location.href) {
      showToast('Navigating to ' + match.text, 0);
      speak('Navigating to ' + match.text);
      
      const histEntry = { url: match.href, title: match.text, time: now };
      navigationHistory.push(histEntry);
      sessionStorage.setItem('voicenavHistory', JSON.stringify(navigationHistory.slice(-10)));
      
      setTimeout(() => { window.location.href = match.href; }, 700);
    }
  }

  function showOptions(matches, originalQuery, confidence = 0) {
    awaitingOptionChoice = true;
    optionLinks = matches;
    hideToast();
    hideAvailableLinks();

    let html = '<div class="voicenav-options-title">Found ' + matches.length + ' options</div>';
    if (confidence > 0) {
      html += '<div class="voicenav-confidence-text">Confidence: ' + Math.round(confidence * 100) + '%</div>';
    }
    
    for (let i = 0; i < matches.length; i++) {
      html += '<div class="voicenav-option-item" data-index="' + i + '" data-key="' + (i+1) + '"><div class="voicenav-option-number">' + (i+1) + '</div><div><div class="voicenav-option-text">' + matches[i].text + '</div>';
      if (matches[i].reason) html += '<div class="voicenav-option-hint">' + matches[i].reason + '</div>';
      html += '</div></div>';
    }
    html += '<div class="voicenav-say-hint">Press 1-4 or say option 1, 2... Press ESC to cancel</div>';
    
    optionsPanel.innerHTML = html;

    optionsPanel.querySelectorAll('.voicenav-option-item').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.index);
        selectOption(idx);
      });
    });

    optionsPanel.classList.add('visible');
    speak('Found ' + matches.length + ' options');
    
    const keyHandler = (e) => {
      const num = parseInt(e.key);
      if (num >= 1 && num <= matches.length) {
        e.preventDefault();
        selectOption(num - 1);
        document.removeEventListener('keydown', keyHandler);
      } else if (e.key === 'Escape') {
        resetOptions();
        document.removeEventListener('keydown', keyHandler);
      }
    };
    document.addEventListener('keydown', keyHandler);

    setTimeout(() => startListening(), 300);
  }

  function handleOptionVoiceChoice(text) {
    const cancel = /cancel|nevermind|stop|close|dismiss/i.test(text);
    if (cancel) { resetOptions(); showToast('Cancelled', 2000); speak('Cancelled'); return; }

    const numMatch = text.match(/option\s*(\d+)|number\s*(\d+)|(\d+)/);
    if (numMatch) {
      const num = parseInt(numMatch[1] || numMatch[2] || numMatch[3]) - 1;
      if (num >= 0 && num < optionLinks.length) { selectOption(num); return; }
    }

    const lower = text.toLowerCase();
    for (let i = 0; i < optionLinks.length; i++) {
      if (optionLinks[i].text.toLowerCase().includes(lower)) {
        selectOption(i);
        return;
      }
    }

    showToast('Try again', 2500);
    speak('Please try again');
    setTimeout(() => startListening(), 2600);
  }

  function selectOption(index) {
    if (index < 0 || index >= optionLinks.length) return;
    const match = optionLinks[index];
    resetOptions();
    navigateToMatch(match);
  }

  function resetOptions() {
    awaitingOptionChoice = false;
    optionLinks = [];
    optionsPanel.classList.remove('visible');
    setTimeout(() => { optionsPanel.innerHTML = ''; }, 300);
  }

  function handleNoMatch(query) {
    hideToast();
    hideAvailableLinks();
    const siteName = window.location.hostname.replace('www.', '');
    const siteSearch = findSiteSearchUrl(query);
    const canGoBack = navigationHistory.length > 0;

    let html = '<div class="voicenav-nomatch"><div class="voicenav-nomatch-title">No match</div><div class="voicenav-nomatch-desc">Could not find "' + query + '"</div>';
    if (canGoBack) html += '<button class="voicenav-search-btn" id="vnav-go-back">Go back</button>';
    if (siteSearch) html += '<button class="voicenav-search-btn" id="vnav-site-search">Search ' + siteName + '</button>';
    html += '<button class="voicenav-search-btn" id="vnav-google-search">Google search</button></div>';

    optionsPanel.innerHTML = html;
    optionsPanel.classList.add('visible');
    speak('No match found');

    if (canGoBack) {
      document.getElementById('vnav-go-back')?.addEventListener('click', () => {
        resetOptions();
        navigationHistory.pop();
        sessionStorage.setItem('voicenavHistory', JSON.stringify(navigationHistory));
        window.history.back();
      });
    }

    if (siteSearch) {
      document.getElementById('vnav-site-search')?.addEventListener('click', () => {
        resetOptions();
        window.location.href = siteSearch;
      });
    }

    document.getElementById('vnav-google-search')?.addEventListener('click', () => {
      resetOptions();
      window.open('https://www.google.com/search?q=' + encodeURIComponent(query + ' site:' + siteName), '_blank');
    });

    setTimeout(() => resetOptions(), 10000);
  }

  function findSiteSearchUrl(query) {
    const searchInput = document.querySelector('input[type="search"], input[name="q"], input[name="s"], input[name="search"]');
    if (searchInput) {
      const form = searchInput.closest('form');
      if (form && form.action) {
        const url = new URL(form.action, window.location.href);
        const paramName = searchInput.name || 'q';
        url.searchParams.set(paramName, query);
        return url.toString();
      }
    }
    return null;
  }

  function showAvailableLinks() {
    const links = collectLinks();
    if (links.length === 0) return;

    const categorized = {};
    links.slice(0, 25).forEach(link => {
      const category = categorizeLink(link.el);
      if (!categorized[category]) categorized[category] = [];
      categorized[category].push(link);
    });

    const categoryOrder = ['nav', 'button', 'link', 'social', 'sidebar', 'footer'];
    
    let html = '<div class="voicenav-links-list"><div class="voicenav-links-header">Links <button id="voicenav-refresh-links" class="voicenav-refresh-btn">Refresh</button></div>';
    
    let count = 0;
    for (let cat of categoryOrder) {
      if (!categorized[cat]) continue;
      if (count >= 25) break;
      
      html += '<div class="voicenav-category-label">' + cat.toUpperCase() + '</div>';
      for (let link of categorized[cat]) {
        if (count >= 25) break;
        html += '<div class="voicenav-link-item" title="' + link.text + '"><span>' + link.text.substring(0, 32) + '</span></div>';
        count++;
      }
    }
    
    if (links.length > 25) html += '<div class="voicenav-links-more">+' + (links.length - 25) + '</div>';
    html += '</div>';

    availableLinksPanel.innerHTML = html;
    document.getElementById('voicenav-refresh-links')?.addEventListener('click', () => {
      cachedLinks = null;
      showAvailableLinks();
    });

    availableLinksPanel.classList.add('visible');
  }

  function hideAvailableLinks() {
    availableLinksPanel.classList.remove('visible');
    setTimeout(() => { availableLinksPanel.innerHTML = ''; }, 250);
  }

  function initAudioLevelMonitoring() {
    try {
      if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }

      navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        if (!analyser) {
          analyser = audioContext.createAnalyser();
          analyser.fftSize = 256;
          const source = audioContext.createMediaStreamSource(stream);
          source.connect(analyser);
        }

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        
        audioLevelCheckTimer = setInterval(() => {
          analyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
          const average = sum / dataArray.length;

          fab.classList.remove('low-audio', 'medium-audio', 'high-audio');
          if (average < 30) fab.classList.add('low-audio');
          else if (average < 60) fab.classList.add('medium-audio');
          else fab.classList.add('high-audio');
        }, 150);
      }).catch(e => {
        console.log('[VoiceNav] Microphone: ' + e.message);
      });
    } catch (e) {
      console.log('[VoiceNav] Audio: ' + e.message);
    }
  }

  function showToast(text, duration = 3000) {
    clearTimeout(toastTimeout);
    toast.innerHTML = text;
    toast.classList.add('visible');
    if (duration > 0) {
      toastTimeout = setTimeout(() => hideToast(), duration);
    }
  }

  function hideToast(delay = 0) {
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('visible'), delay);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'START_LISTENING') startListening();
    if (message.type === 'STOP_LISTENING') stopListening();
    if (message.type === 'SETTINGS_UPDATED') {
      settings = Object.assign({}, settings, message.settings);
      initActivationMode();
    }
  });

})();
