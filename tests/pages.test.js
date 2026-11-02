/*
 * Smoke tests: load the options page and popup in jsdom with a mocked chrome API,
 * execute their scripts, and assert they render without throwing.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function mockChrome(store = {}) {
  return {
    storage: {
      local: {
        // Mirrors chrome.storage.local.get(keysOrDefaults, cb). The options page calls it
        // both ways: get(null, cb) and awaited get(null) — support both.
        get: (keysOrDefaults, cb) => {
          var fn = typeof keysOrDefaults === 'function' ? keysOrDefaults : cb;
          var out = Object.assign({}, store);
          if (keysOrDefaults && typeof keysOrDefaults === 'object') {
            out = Object.assign({}, keysOrDefaults, store);
          }
          if (typeof fn === 'function') { fn(out); return undefined; }
          return Promise.resolve(out);
        },
        set: (items, cb) => { Object.assign(store, items); if (cb) cb(); return Promise.resolve(); }
      }
    },
    runtime: {
      lastError: null,
      sendMessage: (msg, cb) => cb({ ok: true, detail: 'Connected to Test model "x".' }),
      openOptionsPage: () => {}
    },
    permissions: {
      contains: async () => true,
      request: async () => true
    }
  };
}

function loadPage(file, store) {
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'chrome-extension://abc/' + file });
  dom.window.chrome = mockChrome(store);
  const scriptSrc = (html.match(/<script src="([^"]+)"/) || [])[1];
  assert.ok(scriptSrc, 'page references a script');
  const code = fs.readFileSync(path.join(ROOT, scriptSrc), 'utf8');
  dom.window.eval(code);
  return dom;
}

test('options page: loads, applies presets and saves valid settings', async () => {
  const store = {};
  const dom = loadPage('options.html', store);
  const doc = dom.window.document;

  // Wait for the async load() to populate the form.
  await new Promise((r) => setTimeout(r, 30));

  // Default values rendered.
  assert.equal(doc.getElementById('provider').value, 'openai');
  assert.equal(doc.getElementById('baseUrl').value, 'https://api.openai.com/v1');
  assert.equal(doc.getElementById('model').value, 'gpt-5-mini');

  // Switching provider updates base URL/model presets.
  const provider = doc.getElementById('provider');
  provider.value = 'groq';
  provider.dispatchEvent(new dom.window.Event('change'));
  assert.equal(doc.getElementById('baseUrl').value, 'https://api.groq.com/openai/v1');
  assert.equal(doc.getElementById('model').value, 'meta-llama/llama-4-scout-17b-16e-instruct');

  // Saving without key shows an error and does not persist.
  doc.getElementById('save').click();
  await new Promise((r) => setTimeout(r, 30));
  assert.match(doc.getElementById('status').textContent, /API key/);
  assert.equal(store.provider, undefined, 'nothing saved without a key');

  // With a key, settings persist.
  doc.getElementById('apiKey').value = 'gsk_test';
  doc.getElementById('tone').value = 'Humor / Witty';
  doc.getElementById('save').click();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(store.provider, 'groq');
  assert.equal(store.apiKey, 'gsk_test');
  assert.equal(store.tone, 'Humor / Witty');
});

test('options page: Ollama needs no API key and saves fine', async () => {
  const store = { provider: 'ollama', model: 'qwen3:8b', baseUrl: 'http://localhost:11434/v1' };
  const dom = loadPage('options.html', store);
  const doc = dom.window.document;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(doc.getElementById('provider').value, 'ollama');
  assert.equal(doc.getElementById('ollamaHint').hidden, false);
  doc.getElementById('save').click();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(store.provider, 'ollama');
});

test('options page: preserves custom saved model on load and migrates retired models', async () => {
  const store = { provider: 'openai', model: 'gpt-5.4', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1' };
  const dom = loadPage('options.html', store);
  const doc = dom.window.document;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(doc.getElementById('model').value, 'gpt-5.4', 'custom saved model preserved');

  // Retired model is automatically migrated to the latest equivalent
  const legacyStore = { provider: 'gemini', model: 'gemini-2.0-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' };
  const dom2 = loadPage('options.html', legacyStore);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(dom2.window.document.getElementById('model').value, 'gemini-2.5-flash');
});

test('options page: test connection reports success', async () => {
  const store = { provider: 'openai', apiKey: 'sk-x', model: 'gpt-5-mini', baseUrl: 'https://api.openai.com/v1' };
  const dom = loadPage('options.html', store);
  const doc = dom.window.document;
  await new Promise((r) => setTimeout(r, 30));
  doc.getElementById('test').click();
  await new Promise((r) => setTimeout(r, 50));
  assert.match(doc.getElementById('status').textContent, /Connected/);
  assert.ok(doc.getElementById('status').className.includes('ok'));
});

test('options page: reads available models from API, selects latest, and shows full unfiltered dropdown', async () => {
  const store = { provider: 'gemini', apiKey: 'AIza-live', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' };
  const html = fs.readFileSync(path.join(ROOT, 'options.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'chrome-extension://abc/options.html' });
  const ch = mockChrome(store);
  ch.runtime.sendMessage = (msg, cb) => {
    if (msg && msg.type === 'listModels') {
      cb({
        ok: true,
        source: 'direct',
        recommended: 'gemini-3.8-flash',
        models: ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']
      });
      return;
    }
    cb({ ok: true, detail: 'Connected.' });
  };
  dom.window.chrome = ch;
  dom.window.eval(fs.readFileSync(path.join(ROOT, 'options.js'), 'utf8'));
  const doc = dom.window.document;

  await new Promise((r) => setTimeout(r, 30));
  assert.equal(doc.getElementById('model').value, 'gemini-3.8-flash', 'auto-selects latest model from API');
  assert.match(doc.getElementById('modelHint').textContent, /5 models loaded from API/);

  // Focusing the model input opens the full dropdown showing ALL 5 models (not filtered by input value)
  doc.getElementById('model').dispatchEvent(new dom.window.Event('focus'));
  const menu = doc.getElementById('modelMenu');
  assert.equal(menu.hidden, false);
  const options = menu.querySelectorAll('.model-option');
  assert.equal(options.length, 5, 'all available API models are displayed');
});

test('options page: OpenRouter shows all models (not capped at 80), supports ▾ toggle & Free-only filter, and keeps custom free model on Test Connection', async () => {
  const allOpenRouterModels = [];
  for (let i = 1; i <= 120; i++) {
    allOpenRouterModels.push(`provider-${i}/model-${i}`);
  }
  allOpenRouterModels.push('google/gemma-4-31b-it:free');
  allOpenRouterModels.push('nvidia/nemotron-3-ultra-550b-a55b:free');

  const store = {
    provider: 'openrouter',
    apiKey: 'sk-or-test',
    model: 'google/gemma-4-31b-it:free',
    userSelectedModel: true,
    baseUrl: 'https://openrouter.ai/api/v1'
  };
  const html = fs.readFileSync(path.join(ROOT, 'options.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'chrome-extension://abc/options.html' });
  const ch = mockChrome(store);
  let testedModel = null;
  ch.runtime.sendMessage = (msg, cb) => {
    if (msg && msg.type === 'listModels') {
      cb({
        ok: true,
        source: 'direct',
        recommended: 'openrouter/free',
        models: allOpenRouterModels,
        freeModels: ['google/gemma-4-31b-it:free', 'nvidia/nemotron-3-ultra-550b-a55b:free']
      });
      return;
    }
    if (msg && msg.type === 'testConnection') {
      testedModel = msg.settings && msg.settings.model;
      cb({ ok: true, model: testedModel, detail: 'Connected to OpenRouter model "' + testedModel + '".' });
      return;
    }
    cb({ ok: true });
  };
  dom.window.chrome = ch;
  dom.window.eval(fs.readFileSync(path.join(ROOT, 'options.js'), 'utf8'));
  const doc = dom.window.document;

  await new Promise((r) => setTimeout(r, 30));
  assert.equal(doc.getElementById('model').value, 'google/gemma-4-31b-it:free', 'preserves user-selected free model even before/after list loads');

  // Clicking the ▾ toggle button opens the full list of all 122 models (not truncated to 80)
  doc.getElementById('toggleModelMenu').click();
  const menu = doc.getElementById('modelMenu');
  assert.equal(menu.hidden, false, '▾ button opens the model menu');
  assert.equal(menu.querySelectorAll('.model-option').length, 122, 'every single OpenRouter model is rendered in the dropdown');

  // Toggling "Free only" filters the dropdown to the 2 free models
  const freeToggle = doc.getElementById('freeOnlyToggle');
  freeToggle.checked = true;
  freeToggle.dispatchEvent(new dom.window.Event('change'));
  assert.equal(menu.querySelectorAll('.model-option').length, 2, 'Free only toggle filters dropdown to free models');

  // Clicking Test connection tests the exact free model selected by the user
  doc.getElementById('test').click();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(testedModel, 'google/gemma-4-31b-it:free', 'Test connection uses the selected free model');
  assert.match(doc.getElementById('status').textContent, /google\/gemma-4-31b-it:free/);
});

test('popup: shows configured provider and model', async () => {
  const store = { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-x' };
  const dom = loadPage('popup.html', store);
  const doc = dom.window.document;
  await new Promise((r) => setTimeout(r, 20));
  const status = doc.getElementById('status');
  assert.match(status.textContent, /Ready/);
  assert.match(status.textContent, /DeepSeek/);
  assert.match(status.textContent, /deepseek-chat/);
});

test('popup: warns when no API key is configured', async () => {
  const dom = loadPage('popup.html', { provider: 'openai' });
  const doc = dom.window.document;
  await new Promise((r) => setTimeout(r, 20));
  assert.match(doc.getElementById('status').textContent, /Add an API key/);
});

test('options.html and popup.html reference only existing assets', () => {
  for (const file of ['options.html', 'popup.html']) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const refs = Array.from(html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css|png))"/g)).map((m) => m[1]);
    assert.ok(refs.length > 0, file + ' references assets');
    for (const ref of refs) {
      assert.ok(fs.existsSync(path.join(ROOT, ref)), `${file} → missing ${ref}`);
    }
  }
});

test('options page: renders Thinking Workflow & Context defaults and supports Reset Voice Card', async () => {
  const store = {
    provider: 'openai',
    apiKey: 'sk-test',
    personaEnabled: false,
    channel: 'x_post',
    tone: 'Humor / Witty',
    signaturePhrases: 'custom bridge',
    bannedWords: 'custom ban'
  };
  const dom = loadPage('options.html', store);
  const doc = dom.window.document;
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(doc.getElementById('personaEnabled').checked, false);
  assert.equal(doc.getElementById('channel').value, 'x_post');
  assert.equal(doc.getElementById('signaturePhrases').value, 'custom bridge');

  // Clicking Reset Voice Card restores Thinking Workflow defaults (Engaging tone, empty stock phrases)
  doc.getElementById('resetVoice').click();
  assert.equal(doc.getElementById('personaEnabled').checked, true);
  assert.equal(doc.getElementById('channel').value, 'comment');
  assert.equal(doc.getElementById('tone').value, 'Engaging');
  assert.equal(doc.getElementById('signaturePhrases').value, '');
  assert.match(doc.getElementById('bannedWords').value, /delve/);
});

test('history page (history.html): renders LLM-style day-grouped threads, post caption, AI thought process, and filters', async () => {
  const now = Date.now();
  const store = {
    commentHistory: [
      {
        threadId: 'thr_test_1',
        createdAt: now - 60000,
        updatedAt: now,
        dateKey: new Date(now).toISOString().slice(0, 10),
        platform: 'linkedin',
        channel: 'comment',
        postAuthor: 'Elena Rostova',
        postText: 'We replaced 14 microservice dashboards with a single CLI and incident resolution dropped by 40%.',
        postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:777/',
        entries: [
          {
            id: 'gen_1',
            createdAt: now - 60000,
            comment: 'Fewer tabs during an outage means faster recovery every single time.',
            finalComment: '',
            thoughtProcess: '1. Post Core: Reducing context switching during incidents.\n2. Angle: Practitioner observation on cognitive load.',
            tone: 'Engaging',
            channel: 'comment',
            seed: 'aabbccddeeff001122334455',
            provider: 'openai',
            model: 'gpt-5-mini',
            status: 'generated'
          },
          {
            id: 'gen_2',
            createdAt: now,
            comment: 'During an incident, every extra dashboard tab is just another place to misread a timestamp.',
            finalComment: 'During an incident, every extra dashboard tab is just another place to misread a timestamp.',
            thoughtProcess: '1. Post Core: CLI consolidation cut MTTR by 40%.\n2. Creative Direction: Sharp, specific imagery about timestamp drift across tabs.',
            tone: 'Practitioner Take',
            channel: 'comment',
            seed: '99887766554433221100ffaa',
            provider: 'openai',
            model: 'gpt-5-mini',
            status: 'inserted'
          }
        ]
      }
    ]
  };

  const dom = loadPage('history.html', store);
  const doc = dom.window.document;
  await new Promise((r) => setTimeout(r, 40));

  // Sidebar renders thread item
  const threadItems = doc.querySelectorAll('.thread-item');
  assert.equal(threadItems.length, 1);
  assert.match(threadItems[0].textContent, /Elena Rostova/);
  assert.match(threadItems[0].textContent, /2 drafts/);
  assert.match(threadItems[0].textContent, /Inserted/);

  // Main pane renders Original Post + 2 turns with Thought Process & Generated Comment
  assert.equal(doc.getElementById('threadDetail').hidden, false);
  assert.match(doc.getElementById('detailTitle').textContent, /Elena Rostova/);
  assert.match(doc.getElementById('detailPostText').textContent, /14 microservice dashboards/);

  const turnCards = doc.querySelectorAll('.turn-card');
  assert.equal(turnCards.length, 2, 'renders both generation turns in the thread');
  assert.match(turnCards[0].querySelector('.thought-box-body').textContent, /Reducing context switching/);
  assert.match(turnCards[1].querySelector('.thought-box-body').textContent, /CLI consolidation cut MTTR/);
  assert.match(turnCards[1].querySelector('.comment-box-body').textContent, /misread a timestamp/);

  // Search filter works
  const searchInput = doc.getElementById('searchInput');
  searchInput.value = 'nonexistent-keyword-xyz';
  searchInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(doc.querySelectorAll('.thread-item').length, 0);

  searchInput.value = 'timestamp';
  searchInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(doc.querySelectorAll('.thread-item').length, 1, 'finds thread by comment/thought text');
});
