/*
 * LinkedIn Comment Assistant — options page logic.
 *
 * Model names are NOT hardcoded: the list of available models is fetched live
 * from the selected provider's API (via the background worker), analyzed, and
 * ranked so the newest suitable model is picked automatically.
 */
(function () {
  'use strict';

  // Only endpoint metadata lives here. `model` is just a last-resort fallback used
  // until the live model list has been fetched from the provider API.
  var PRESETS = {
    openai: {
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5-mini',
      keyUrl: 'https://platform.openai.com/api-keys',
      placeholder: 'sk-…'
    },
    anthropic: {
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-6',
      keyUrl: 'https://console.anthropic.com/settings/keys',
      placeholder: 'sk-ant-…'
    },
    gemini: {
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.5-flash',
      keyUrl: 'https://aistudio.google.com/apikey',
      placeholder: 'AIza…'
    },
    openrouter: {
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openrouter/auto',
      keyUrl: 'https://openrouter.ai/keys',
      placeholder: 'sk-or-…'
    },
    groq: {
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      keyUrl: 'https://console.groq.com/keys',
      placeholder: 'gsk_…'
    },
    deepseek: {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      keyUrl: 'https://platform.deepseek.com/api_keys',
      placeholder: 'sk-…'
    },
    ollama: {
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen3:8b',
      keyUrl: 'https://ollama.com/download',
      placeholder: '(not needed)'
    },
    custom: {
      baseUrl: '',
      model: '',
      keyUrl: '',
      placeholder: 'sk-…'
    }
  };

  var RETIRED_MODEL_MIGRATIONS = {
    'gpt-4o-mini': 'gpt-5-mini',
    'gpt-4o': 'gpt-5',
    'o3-mini': 'o4-mini',
    'openai/gpt-4o-mini': 'openai/gpt-5-mini',
    'anthropic/claude-3.5-haiku': 'anthropic/claude-sonnet-4.6',
    'google/gemini-2.0-flash-001': 'google/gemini-2.5-flash',
    'mixtral-8x7b-32768': 'meta-llama/llama-4-scout-17b-16e-instruct',
    'llama-3.1-8b-instant': 'meta-llama/llama-4-scout-17b-16e-instruct',
    'gemini-2.0-flash': 'gemini-2.5-flash',
    'gemini-2.0-flash-lite': 'gemini-2.5-flash-lite',
    'gemini-1.5-flash': 'gemini-2.5-flash',
    'gemini-1.5-pro': 'gemini-2.5-pro',
    'llama3.2': 'qwen3:8b',
    'llama3.1': 'llama3.3',
    'qwen2.5': 'qwen3:8b',
    'mistral': 'qwen3:8b'
  };

  var DEFAULT_BANNED_WORDS = [
    'delve', 'tapestry', 'testament', 'game-changer', 'unleash', 'elevate',
    'unlock', 'leverage', 'navigate', 'landscape', 'resonate', 'seamless',
    'robust', 'synergy', 'paradigm', 'let\'s dive in', 'moreover', 'furthermore',
    'in today\'s fast-paced digital landscape', 'in today\'s fast-paced world',
    'actionable insights', 'key takeaway', 'thought-provoking', 'Thoughts? Agree?'
  ].join(', ');

  var DEFAULT_SIGNATURE_PHRASES = '';

  var $ = function (id) { return document.getElementById(id); };

  var providerEl = $('provider');
  var apiKeyEl = $('apiKey');
  var modelEl = $('model');
  var baseUrlEl = $('baseUrl');
  var channelEl = $('channel');
  var toneEl = $('tone');
  var languageEl = $('language');
  var personaEnabledEl = $('personaEnabled');
  var userNameEl = $('userName');
  var userRoleEl = $('userRole');
  var signaturePhrasesEl = $('signaturePhrases');
  var bannedWordsEl = $('bannedWords');
  var resetVoiceBtn = $('resetVoice');
  var extraEl = $('extra');
  var hideWhileTypingEl = $('hideWhileTyping');
  var hideFloatingWidgetEl = $('hideFloatingWidget');
  var keyUrlEl = $('keyUrl');
  var ollamaHintEl = $('ollamaHint');
  var suggestionsEl = $('modelSuggestions');
  var modelMenuEl = $('modelMenu');
  var modelHintEl = $('modelHint');
  var refreshBtn = $('refreshModels');
  var toggleMenuBtn = $('toggleModelMenu');
  var freeFilterWrapEl = $('freeFilterWrap');
  var freeOnlyToggleEl = $('freeOnlyToggle');
  var statusEl = $('status');
  var saveBtn = $('save');
  var testBtn = $('test');

  // Track if the user hand-edited model/base URL so provider switches don't clobber them.
  var userEditedModel = false;
  var userEditedBaseUrl = false;
  // True once the user explicitly picked/typed a model (persisted so auto-detect respects it).
  var userSelectedModel = false;

  var liveModels = [];
  var freeModelsSet = Object.create(null);
  var recommendedModel = '';
  var fetchSeq = 0;
  var activeIndex = -1;

  function isFreeModel(id) {
    if (!id) return false;
    return Boolean(freeModelsSet[id]) || /:free$/i.test(id) || String(id).toLowerCase() === 'openrouter/free';
  }

  /* ---------------- model list UI ---------------- */

  function setModelHint(text, isError) {
    if (!modelHintEl) return;
    modelHintEl.textContent = text || '';
    modelHintEl.hidden = !text;
    modelHintEl.style.color = isError ? '#d93025' : '';
  }

  function renderSuggestions(models) {
    suggestionsEl.innerHTML = '';
    models.forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m;
      suggestionsEl.appendChild(opt);
    });
  }

  function hideMenu() {
    if (modelMenuEl) modelMenuEl.hidden = true;
    activeIndex = -1;
  }

  function getFilteredModels(filterText) {
    var baseList = liveModels.slice();
    if (freeOnlyToggleEl && freeOnlyToggleEl.checked) {
      baseList = baseList.filter(isFreeModel);
    }
    var q = String(filterText || '').trim().toLowerCase();
    // Show the full list when the field holds an exact model name (e.g. just focused).
    if (q && liveModels.indexOf(String(filterText || '').trim()) === -1) {
      return baseList.filter(function (m) { return m.toLowerCase().indexOf(q) !== -1; });
    }
    return baseList;
  }

  function renderMenu(filterText) {
    if (!modelMenuEl) return;
    var list = getFilteredModels(filterText);
    modelMenuEl.innerHTML = '';
    if (!list.length) { hideMenu(); return; }
    list.forEach(function (m, i) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'model-option' + (m === modelEl.value.trim() ? ' selected' : '') + (i === activeIndex ? ' active' : '');
      btn.setAttribute('role', 'option');
      btn.dataset.value = m;
      var label = document.createElement('span');
      label.textContent = m;
      btn.appendChild(label);
      if (m === recommendedModel) {
        var tag = document.createElement('span');
        tag.className = 'model-tag';
        tag.textContent = 'Latest · recommended';
        btn.appendChild(tag);
      } else if (isFreeModel(m)) {
        var freeTag = document.createElement('span');
        freeTag.className = 'model-tag free';
        freeTag.textContent = 'Free';
        btn.appendChild(freeTag);
      }
      btn.addEventListener('mousedown', function (e) {
        e.preventDefault();
        chooseModel(m);
      });
      modelMenuEl.appendChild(btn);
    });
    modelMenuEl.hidden = false;
  }

  function chooseModel(m) {
    modelEl.value = m;
    userEditedModel = true;
    userSelectedModel = true;
    hideMenu();
  }

  function sendMessage(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (response) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: 'No response.' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
  }

  /**
   * Ask the background worker to read the provider's /models API, analyze it,
   * and return a ranked list (newest suitable model first).
   */
  async function refreshModels(opts) {
    var options = opts || {};
    var seq = ++fetchSeq;
    var settings = collect();
    if (settings.provider === 'custom' && !settings.baseUrl) {
      setModelHint('Enter a base URL to load models.', false);
      return;
    }
    if (refreshBtn) refreshBtn.disabled = true;
    setModelHint('Fetching available models from the API…', false);
    var resp = await sendMessage({ type: 'listModels', settings: settings });
    if (seq !== fetchSeq) return; // a newer request superseded this one
    if (refreshBtn) refreshBtn.disabled = false;

    if (!resp || !resp.ok || !Array.isArray(resp.models) || !resp.models.length) {
      setModelHint((resp && resp.error) || 'Could not load models from the API. You can still type a model name.', true);
      return;
    }

    liveModels = resp.models;
    freeModelsSet = Object.create(null);
    if (Array.isArray(resp.freeModels)) {
      resp.freeModels.forEach(function (fm) { freeModelsSet[fm] = true; });
    }
    recommendedModel = resp.recommended || resp.models[0];
    renderSuggestions(liveModels);
    if (freeFilterWrapEl) {
      var hasFree = liveModels.some(isFreeModel);
      freeFilterWrapEl.hidden = !(settings.provider === 'openrouter' || hasFree);
    }

    var current = modelEl.value.trim();
    var preset = PRESETS[settings.provider] || PRESETS.custom;
    var hasUserChoice = Boolean(userSelectedModel || userEditedModel || (current && current !== preset.model));
    if (!hasUserChoice && options.autoSelect !== false) {
      modelEl.value = recommendedModel;
      userSelectedModel = false;
    }

    if (options.openMenuAfter && liveModels.length) {
      renderMenu('');
    }

    if (options.persistIfSaved) {
      var persistedUpdates = {
        availableModels: liveModels,
        recommendedModel: recommendedModel,
        modelDetectedForProvider: settings.provider,
        modelDetectedFromApi: resp.source === 'direct'
      };
      if (!hasUserChoice) {
        persistedUpdates.model = modelEl.value.trim();
      }
      chrome.storage.local.set(persistedUpdates);
    }

    var freeCount = liveModels.filter(isFreeModel).length;
    var freeNote = freeCount > 0 ? ' (' + freeCount + ' free)' : '';
    var sourceNote = resp.source === 'catalog'
      ? ' (live catalog — add your API key for your account\u2019s exact list)'
      : ' from API';
    setModelHint('✓ ' + liveModels.length + ' models loaded' + freeNote + sourceNote + ' · latest: ' + recommendedModel, false);
  }

  var refreshTimer = null;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () { refreshModels({ autoSelect: !userSelectedModel }); }, 500);
  }

  /* ---------------- presets & form ---------------- */

  function applyProviderPreset() {
    var preset = PRESETS[providerEl.value] || PRESETS.custom;
    keyUrlEl.href = preset.keyUrl ? preset.keyUrl : '#';
    keyUrlEl.style.display = preset.keyUrl ? '' : 'none';
    ollamaHintEl.hidden = providerEl.value !== 'ollama';
    apiKeyEl.placeholder = preset.placeholder;
    if (freeFilterWrapEl) {
      freeFilterWrapEl.hidden = providerEl.value !== 'openrouter';
    }
    if (freeOnlyToggleEl && providerEl.value !== 'openrouter') {
      freeOnlyToggleEl.checked = false;
    }

    liveModels = [];
    freeModelsSet = Object.create(null);
    recommendedModel = '';
    renderSuggestions([]);
    hideMenu();

    if (preset.baseUrl && !userEditedBaseUrl) baseUrlEl.value = preset.baseUrl;
    if (preset.model && !userEditedModel) modelEl.value = preset.model;
  }

  function collect() {
    return {
      provider: providerEl.value,
      apiKey: apiKeyEl.value.trim(),
      model: modelEl.value.trim(),
      baseUrl: baseUrlEl.value.trim().replace(/\/+$/, ''),
      channel: channelEl ? channelEl.value : 'comment',
      tone: toneEl.value,
      language: languageEl.value,
      personaEnabled: personaEnabledEl ? Boolean(personaEnabledEl.checked) : true,
      userName: userNameEl ? userNameEl.value.trim() : '',
      userRole: userRoleEl ? userRoleEl.value.trim() : '',
      signaturePhrases: signaturePhrasesEl ? signaturePhrasesEl.value.trim() : DEFAULT_SIGNATURE_PHRASES,
      bannedWords: bannedWordsEl ? bannedWordsEl.value.trim() : DEFAULT_BANNED_WORDS,
      extraInstructions: extraEl.value.trim(),
      hideWhileTyping: Boolean(hideWhileTypingEl && hideWhileTypingEl.checked),
      hideFloatingWidget: Boolean(hideFloatingWidgetEl && hideFloatingWidgetEl.checked),
      userSelectedModel: userSelectedModel
    };
  }

  function showStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.hidden = false;
    statusEl.className = 'status' + (isError ? ' error' : ' ok');
  }

  function clearStatus() {
    statusEl.hidden = true;
  }

  async function load() {
    var items = (await chrome.storage.local.get(null)) || {};
    if (items.provider) providerEl.value = items.provider;
    applyProviderPreset();
    var hasStoredModel = Boolean(items.model && String(items.model).trim());
    if (hasStoredModel) {
      modelEl.value = RETIRED_MODEL_MIGRATIONS[items.model] || items.model;
      userEditedModel = true;
    }
    userSelectedModel = Boolean(items.userSelectedModel || hasStoredModel);
    if (items.baseUrl) baseUrlEl.value = items.baseUrl;
    if (items.apiKey) apiKeyEl.value = items.apiKey;
    if (channelEl && items.channel) channelEl.value = items.channel;
    if (items.tone) toneEl.value = items.tone;
    if (items.language) languageEl.value = items.language;
    if (personaEnabledEl) {
      personaEnabledEl.checked = items.personaEnabled !== false;
    }
    if (userNameEl && items.userName) userNameEl.value = items.userName;
    if (userRoleEl && items.userRole) userRoleEl.value = items.userRole;
    if (signaturePhrasesEl) {
      signaturePhrasesEl.value = typeof items.signaturePhrases === 'string'
        ? items.signaturePhrases
        : DEFAULT_SIGNATURE_PHRASES;
    }
    if (bannedWordsEl) {
      bannedWordsEl.value = typeof items.bannedWords === 'string'
        ? items.bannedWords
        : DEFAULT_BANNED_WORDS;
    }
    if (items.extraInstructions) extraEl.value = items.extraInstructions;
    if (hideWhileTypingEl) hideWhileTypingEl.checked = Boolean(items.hideWhileTyping);
    if (hideFloatingWidgetEl) hideFloatingWidgetEl.checked = Boolean(items.hideFloatingWidget);
    refreshModels({ autoSelect: !hasStoredModel, persistIfSaved: Boolean(items.provider || items.apiKey) });
  }

  async function ensureBaseUrlPermission(baseUrl) {
    var origin;
    try {
      origin = new URL(baseUrl).origin;
    } catch (e) {
      return;
    }
    var standard = [
      'https://api.openai.com', 'https://api.anthropic.com', 'https://openrouter.ai',
      'https://api.groq.com', 'https://api.deepseek.com',
      'https://generativelanguage.googleapis.com', 'http://localhost', 'http://127.0.0.1'
    ];
    if (standard.indexOf(origin) !== -1) return;
    var pattern = origin + '/*';
    try {
      var granted = await chrome.permissions.contains({ origins: [pattern] });
      if (!granted) {
        // Called from a user gesture (Save / Test click), so the prompt is allowed.
        await chrome.permissions.request({ origins: [pattern] }).catch(function () {});
      }
    } catch (e) { /* permission API unavailable — ignore */ }
  }

  async function save(quiet) {
    var settings = collect();
    if (settings.provider !== 'ollama' && !settings.apiKey) {
      showStatus('You must enter an API key (or choose “Ollama (local)” which needs none).', true);
      return false;
    }
    if (!settings.model) {
      showStatus('Pick a model from the list (click ↻ to load models from the API).', true);
      return false;
    }
    if (!settings.baseUrl) {
      showStatus('Enter the provider base URL.', true);
      return false;
    }
    var toStore = Object.assign({}, settings, { userSelectedModel: true });
    userSelectedModel = true;
    userEditedModel = true;
    if (liveModels.length) {
      toStore.availableModels = liveModels;
      toStore.recommendedModel = recommendedModel;
      toStore.modelDetectedForProvider = settings.provider;
      toStore.modelDetectedFromApi = true;
    } else {
      // Let the background worker resolve the latest model from the API on first use.
      toStore.modelDetectedFromApi = false;
    }
    await chrome.storage.local.set(toStore);
    await ensureBaseUrlPermission(settings.baseUrl);
    if (!quiet) showStatus('Settings saved. ✅ Open LinkedIn and click the ✨ AI button on any post.');
    return true;
  }

  async function test() {
    clearStatus();
    testBtn.disabled = true;
    testBtn.textContent = 'Testing…';
    var saved = await save(true);
    if (!saved) {
      testBtn.disabled = false;
      testBtn.textContent = 'Test connection';
      return;
    }
    var settings = collect();
    var resp = await sendMessage({ type: 'testConnection', settings: settings });
    testBtn.disabled = false;
    testBtn.textContent = 'Test connection';
    if (resp && resp.ok) {
      // Only update the model input if the user had not explicitly chosen a model.
      if (!userSelectedModel && resp.model && resp.model !== modelEl.value.trim()) {
        modelEl.value = resp.model;
      }
      showStatus(resp.detail || 'Connected. ✅');
    } else {
      showStatus((resp && resp.error) || 'Connection failed.', true);
    }
  }

  /* ---------------- events ---------------- */

  providerEl.addEventListener('change', function () {
    userEditedModel = false;
    userEditedBaseUrl = false;
    userSelectedModel = false;
    applyProviderPreset();
    refreshModels({ autoSelect: true });
  });
  modelEl.addEventListener('input', function () {
    userEditedModel = true;
    userSelectedModel = true;
    activeIndex = -1;
    renderMenu(modelEl.value);
  });
  modelEl.addEventListener('focus', function () {
    if (liveModels.length) renderMenu('');
    else refreshModels({ autoSelect: false });
  });
  modelEl.addEventListener('click', function () {
    if (modelMenuEl && modelMenuEl.hidden && liveModels.length) {
      renderMenu('');
    }
  });
  modelEl.addEventListener('blur', function () { setTimeout(hideMenu, 120); });
  modelEl.addEventListener('keydown', function (e) {
    if (!modelMenuEl || modelMenuEl.hidden) return;
    var opts = modelMenuEl.querySelectorAll('.model-option');
    if (!opts.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = e.key === 'ArrowDown'
        ? (activeIndex + 1) % opts.length
        : (activeIndex - 1 + opts.length) % opts.length;
      opts.forEach(function (o, i) { o.classList.toggle('active', i === activeIndex); });
      if (opts[activeIndex].scrollIntoView) opts[activeIndex].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      chooseModel(opts[activeIndex].dataset.value);
    } else if (e.key === 'Escape') {
      hideMenu();
    }
  });
  if (toggleMenuBtn) {
    toggleMenuBtn.addEventListener('mousedown', function (e) {
      e.preventDefault(); // prevent blurring modelEl
    });
    toggleMenuBtn.addEventListener('click', function () {
      if (modelMenuEl && !modelMenuEl.hidden) {
        hideMenu();
      } else if (liveModels.length) {
        modelEl.focus();
        renderMenu('');
      } else {
        refreshModels({ autoSelect: false, openMenuAfter: true });
      }
    });
  }
  if (freeOnlyToggleEl) {
    freeOnlyToggleEl.addEventListener('change', function () {
      activeIndex = -1;
      var current = modelEl.value.trim();
      if (freeOnlyToggleEl.checked && current && !isFreeModel(current)) {
        var firstFree = liveModels.find(isFreeModel);
        if (firstFree) {
          modelEl.value = firstFree;
          userEditedModel = true;
          userSelectedModel = true;
        }
      }
      if (liveModels.length) {
        renderMenu('');
      }
    });
  }
  if (refreshBtn) {
    refreshBtn.addEventListener('click', function () {
      refreshModels({ autoSelect: !userSelectedModel, openMenuAfter: true });
    });
  }
  apiKeyEl.addEventListener('input', scheduleRefresh);
  baseUrlEl.addEventListener('input', function () {
    userEditedBaseUrl = true;
    scheduleRefresh();
  });
  if (resetVoiceBtn) {
    resetVoiceBtn.addEventListener('click', function () {
      if (personaEnabledEl) personaEnabledEl.checked = true;
      if (userNameEl) userNameEl.value = '';
      if (userRoleEl) userRoleEl.value = '';
      if (channelEl) channelEl.value = 'comment';
      if (toneEl) toneEl.value = 'Engaging';
      if (signaturePhrasesEl) signaturePhrasesEl.value = DEFAULT_SIGNATURE_PHRASES;
      if (bannedWordsEl) bannedWordsEl.value = DEFAULT_BANNED_WORDS;
      showStatus('Restored default Thinking Workflow & Context settings. Click Save settings to persist.', false);
    });
  }
  saveBtn.addEventListener('click', function () { save(false); });
  testBtn.addEventListener('click', test);
  var openHistoryBtn = $('openHistory');
  if (openHistoryBtn) {
    openHistoryBtn.addEventListener('click', function () {
      var url = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
        ? chrome.runtime.getURL('history.html')
        : 'history.html';
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
        chrome.tabs.create({ url: url });
      } else if (typeof window !== 'undefined' && window.open) {
        window.open(url, '_blank');
      }
    });
  }
  $('toggleKey').addEventListener('click', function () {
    apiKeyEl.type = apiKeyEl.type === 'password' ? 'text' : 'password';
  });

  load();
}());
