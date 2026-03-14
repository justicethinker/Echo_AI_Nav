// VoiceNav Background Service Worker

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.set({
    activationMode: 'popup', // 'always', 'hotkey', 'popup', 'wakeword'
    wakeWord: 'hey nav',
    hotkey: 'Space',
    apiKey: '',
    confidence_threshold: 0.75
  });
});

// Handle messages from content scripts and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PROCESS_VOICE_COMMAND') {
    processVoiceCommand(message.transcript, message.links, sender.tab)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true; // Keep channel open for async
  }

  if (message.type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
  }

  if (message.type === 'GET_SETTINGS') {
    chrome.storage.sync.get(null, (settings) => sendResponse(settings));
    return true;
  }
});

async function processVoiceCommand(transcript, links, tab) {
  const settings = await chrome.storage.sync.get(['apiKey', 'confidence_threshold']);

  // Build a prompt for Claude to match the voice command to the best link(s)
  const linksText = links.map((l, i) => `${i}: "${l.text}" -> ${l.href}`).join('\n');

  const prompt = `You are a voice navigation assistant. The user said: "${transcript}"

Available links on this page:
${linksText}

Your job:
1. Find the best matching link(s) for the user's intent.
2. Return a JSON object with:
   - "confidence": number 0-1 (how confident you are in the top match)
   - "matches": array of objects { index: number, text: string, href: string, reason: string }
     - If confidence >= ${settings.confidence_threshold || 0.75}, return only the top match
     - If confidence < ${settings.confidence_threshold || 0.75}, return top 2-4 possible matches
   - "intent": short description of what the user wants
   - "noMatch": boolean — true if no relevant link found at all

Only return valid JSON, no explanation.`;

  const apiKey = settings.apiKey;

  if (!apiKey) {
    // Fallback: simple fuzzy text matching if no API key
    return fuzzyMatch(transcript, links, settings.confidence_threshold || 0.75);
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2024-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    
    // Check for API errors
    if (!response.ok) {
      const errorType = data.error?.type || 'unknown';
      if (errorType === 'authentication_error') {
        return { error: 'API Authentication error. Invalid API key in settings.', matches: [], confidence: 0, intent: transcript };
      } else if (errorType === 'rate_limit_error') {
        return { error: 'API rate limit quota exceeded. Try again later.', matches: [], confidence: 0, intent: transcript };
      } else {
        return { error: `API Error: ${data.error?.message || 'Request failed'}`, matches: [], confidence: 0, intent: transcript };
      }
    }
    
    const text = data.content?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    // Fallback to fuzzy match on any error
    console.warn('[VoiceNav] API Error, falling back to fuzzy match:', e.message);
    return fuzzyMatch(transcript, links, settings.confidence_threshold || 0.75);
  }
}

function fuzzyMatch(transcript, links, threshold) {
  const query = transcript.toLowerCase().replace(/take me to|go to|navigate to|open|show me/gi, '').trim();
  const scored = links.map((link, index) => {
    const text = link.text.toLowerCase();
    let score = 0;
    if (text === query) score = 1.0;
    else if (text.includes(query) || query.includes(text)) score = 0.85;
    else {
      const queryWords = query.split(' ');
      const textWords = text.split(' ');
      const overlap = queryWords.filter(w => textWords.includes(w)).length;
      score = overlap / Math.max(queryWords.length, textWords.length);
    }
    return { index, text: link.text, href: link.href, score, reason: 'Text match' };
  }).filter(s => s.score > 0.1).sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { noMatch: true, matches: [], confidence: 0, intent: query };

  const top = scored[0];
  if (top.score >= threshold) {
    return { confidence: top.score, matches: [top], intent: query, noMatch: false };
  }
  return { confidence: top.score, matches: scored.slice(0, 4), intent: query, noMatch: false };
}
