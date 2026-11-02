/*
 * LinkedIn Comment Assistant — toolbar popup logic.
 */
(function () {
  'use strict';

  var statusEl = document.getElementById('status');
  var scanBtn = document.getElementById('scan');
  var historyBtn = document.getElementById('history');
  var optionsBtn = document.getElementById('options');
  var hideWhileTypingEl = document.getElementById('hideWhileTyping');
  var hideFloatingWidgetEl = document.getElementById('hideFloatingWidget');

  function providerLabel(p) {
    var map = {
      openai: 'OpenAI', anthropic: 'Anthropic', openrouter: 'OpenRouter', groq: 'Groq',
      deepseek: 'DeepSeek', gemini: 'Gemini', ollama: 'Ollama', custom: 'Custom'
    };
    return map[p] || p || 'OpenAI';
  }

  function setStatus(text, ok) {
    statusEl.textContent = text;
    statusEl.className = 'status' + (ok ? ' ok' : ' warn');
  }

  function broadcastUiPrefs() {
    var prefs = {
      hideWhileTyping: Boolean(hideWhileTypingEl && hideWhileTypingEl.checked),
      hideFloatingWidget: Boolean(hideFloatingWidgetEl && hideFloatingWidgetEl.checked)
    };
    chrome.storage.local.set(prefs);
    if (chrome.tabs && chrome.tabs.query) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        var tab = tabs && tabs[0];
        if (tab && tab.id && chrome.tabs.sendMessage) {
          chrome.tabs.sendMessage(tab.id, { type: 'updateUiPrefs', prefs: prefs }, function () {
            void chrome.runtime.lastError;
          });
        }
      });
    }
  }

  if (hideWhileTypingEl) {
    hideWhileTypingEl.addEventListener('change', broadcastUiPrefs);
  }
  if (hideFloatingWidgetEl) {
    hideFloatingWidgetEl.addEventListener('change', broadcastUiPrefs);
  }

  chrome.storage.local.get(null, function (items) {
    var provider = items.provider || 'openai';
    var model = items.model || '';
    var hasKey = !!(items.apiKey);
    if (hideWhileTypingEl) hideWhileTypingEl.checked = Boolean(items.hideWhileTyping);
    if (hideFloatingWidgetEl) hideFloatingWidgetEl.checked = Boolean(items.hideFloatingWidget);
    if (provider !== 'ollama' && !hasKey) {
      setStatus('⚠ Add an API key in Settings to get started.', false);
    } else {
      setStatus('Ready · ' + providerLabel(provider) + (model ? ' · ' + model : ''), true);
    }
  });

  optionsBtn.addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
  });

  if (historyBtn) {
    historyBtn.addEventListener('click', function () {
      var url = (chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL('history.html') : 'history.html';
      if (chrome.tabs && chrome.tabs.create) {
        chrome.tabs.create({ url: url });
      } else if (typeof window !== 'undefined' && window.open) {
        window.open(url, '_blank');
      }
    });
  }

  function reportScanResult(response) {
    if (response && response.ok) {
      var n = typeof response.postsFound === 'number' ? response.postsFound : 0;
      if (n > 0) {
        setStatus('✓ Active on ' + n + ' post' + (n === 1 ? '' : 's') + '. Click any comment box!', true);
      } else {
        setStatus('✓ Assistant activated! Click inside any comment box.', true);
      }
      return true;
    }
    return false;
  }

  scanBtn.addEventListener('click', function () {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab || !/(linkedin\.com|x\.com|twitter\.com)/i.test(tab.url || '')) {
        setStatus('Open a LinkedIn or X page first.', false);
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: 'rescan', openComposer: true }, function (response) {
        if (!chrome.runtime.lastError && reportScanResult(response)) {
          return;
        }
        // If the content script wasn't injected yet (e.g. tab was opened before extension
        // install/reload), inject content.css + content.js dynamically so no reload is needed.
        if (chrome.scripting && chrome.scripting.executeScript) {
          var insertCssPromise = chrome.scripting.insertCSS
            ? chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] }).catch(function () {})
            : Promise.resolve();
          insertCssPromise.then(function () {
            return chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content.js']
            });
          }).then(function () {
            chrome.tabs.sendMessage(tab.id, { type: 'rescan', openComposer: true }, function (resp2) {
              if (!chrome.runtime.lastError && reportScanResult(resp2)) return;
              setStatus('✓ Assistant activated on this tab.', true);
            });
          }).catch(function () {
            setStatus('Reload the LinkedIn / X page to activate the extension.', false);
          });
        } else {
          setStatus('Reload the LinkedIn / X page to activate the extension.', false);
        }
      });
    });
  });
}());
