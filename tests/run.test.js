/*
 * Unit + DOM tests for LinkedIn Comment Assistant.
 *
 * Run with: npm test
 *
 * The tests simulate LinkedIn DOM structures with jsdom and exercise the exported
 * pure functions from content.js and background.js, so feed parsing, button
 * discovery, comment insertion and prompt building are verified without needing
 * a real browser or API keys.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const background = require('../background.js');
const content = require('../content.js');

/* ---------------- jsdom helpers ---------------- */

let domRef = null;

function makeDom(bodyMarkup) {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><head></head><body>' + bodyMarkup + '</body></html>',
    { url: 'https://www.linkedin.com/feed/', pretendToBeVisual: true }
  );
  domRef = dom;
  global.window = dom.window;
  global.document = dom.window.document;
  global.Event = dom.window.Event;
  global.HTMLElement = dom.window.HTMLElement;
  global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  // jsdom may not implement InputEvent; fall back to Event for the tests.
  global.InputEvent = dom.window.InputEvent || dom.window.Event;
  return dom;
}

/** Mark an element "visible" so rect-based visibility checks pass in jsdom. */
function pretendVisible(el) {
  el.getClientRects = function () {
    return [{ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }];
  };
  return el;
}

/* ---------------- shared fixtures ---------------- */

function textPostMarkup() {
  return `
  <div class="feed-shared-update-v2" data-urn="urn:li:activity:123">
    <div class="update-components-actor__meta">
      <a class="update-components-actor__name" href="/in/sarah-johnson/"><span dir="auto">Sarah Johnson</span></a>
    </div>
    <div class="feed-shared-inline-show-more-text">
      <span class="visually-hidden">After two years of brutal sprints, we finally shipped our accessibility overhaul. Screen reader support doubled and our bounce rate dropped 24 percent.</span>
      <span aria-hidden="true"><span dir="auto">After two years of brutal sprints, we finally shipped our accessibility overhaul. Screen reader support doubled and our bounce rate dropped 24 percent.</span></span>
      <span aria-hidden="true"><button class="feed-shared-inline-show-more-text__less-link">…see less</button></span>
    </div>
    <div class="feed-shared-social-actions-bar">
      <button class="react-button" aria-label="Like">Like</button>
      <button class="react-button" aria-label="Comment">Comment</button>
      <button class="react-button" aria-label="Repost">Repost</button>
      <button class="react-button" aria-label="Send">Send</button>
    </div>
  </div>`;
}

function truncatedPostMarkup() {
  return `
  <div class="feed-shared-update-v2">
    <div class="feed-shared-inline-show-more-text">
      <span aria-hidden="true"><span dir="auto">We just open sourced our internal dashboard. It handles a million events per second</span>…see more</span>
      <span aria-hidden="true"><button class="feed-shared-inline-show-more-text__more-link">…see more</button></span>
    </div>
    <div class="feed-shared-social-actions-bar">
      <div class="feed-shared-social-action-bar">
        <button aria-label="Like">Like</button>
        <button aria-label="Comment">Comment</button>
        <button aria-label="Repost">Repost</button>
        <button aria-label="Send">Send</button>
      </div>
    </div>
  </div>`;
}

function articlePostMarkup() {
  return `
  <div class="feed-shared-update-v2">
    <div class="feed-shared-inline-show-more-text"><span class="visually-hidden"></span></div>
    <div class="update-components-article__content">
      <h3 class="update-components-article__title">How we cut cloud costs by 40%</h3>
      <div class="update-components-article__description">A practical guide to rightsizing Kubernetes clusters without breaking your team's flow.</div>
      <span aria-hidden="true"><button>…see more</button></span>
    </div>
    <div class="feed-shared-social-actions-bar"><button aria-label="Like">Like</button><button aria-label="Comment">Comment</button><button aria-label="Repost">Repost</button><button aria-label="Send">Send</button></div>
  </div>`;
}

/* ============================================================ */
/*  content.js — post text extraction                            */
/* ============================================================ */

test('extractPostText: reads full text from visually-hidden span (expanded post)', () => {
  makeDom(textPostMarkup());
  const post = document.querySelector('.feed-shared-update-v2');
  const text = content.extractPostText(post);
  assert.ok(text.includes('accessibility overhaul'), 'should contain body text');
  assert.ok(text.includes('24 percent'), 'should contain the full, untruncated text');
  assert.ok(!text.includes('see less'), 'should not include see-more/less chrome');
  assert.ok(!text.includes('Like'), 'should not include action-bar labels');
  assert.ok(!text.includes('Sarah Johnson'), 'should not include the author header');
});

test('extractPostText: strips embedded "…see more" from truncated text', () => {
  makeDom(truncatedPostMarkup());
  const post = document.querySelector('.feed-shared-update-v2');
  const text = content.extractPostText(post);
  assert.ok(text.includes('open sourced our internal dashboard'), 'should contain visible text');
  assert.ok(!/see more/i.test(text), 'should remove the see-more label');
  assert.match(text, /million events per second/, 'should keep the readable text');
});

test('extractPostText: falls back to article title + description', () => {
  makeDom(articlePostMarkup());
  const post = document.querySelector('.feed-shared-update-v2');
  const text = content.extractPostText(post);
  assert.ok(text.includes('How we cut cloud costs by 40%'), 'title included');
  assert.ok(text.includes('rightsizing Kubernetes'), 'description included');
  assert.ok(!text.includes('see more'), 'no UI chrome');
});

test('extractPostText: whole-post fallback strips UI chrome', () => {
  makeDom(`
    <div class="feed-shared-update-v2">
      <div class="update-components-actor__name">John Doe</div>
      <div class="feed-shared-update-v2__commentary">We launched in three new countries last week.</div>
      <div class="comments-comment-box"><button>Comment</button><div>Reply</div></div>
      <div class="feed-shared-social-actions-bar"><button aria-label="Like">Like</button></div>
    </div>`);
  const post = document.querySelector('.feed-shared-update-v2');
  const text = content.extractPostText(post);
  assert.ok(text.includes('launched in three new countries'), 'commentary included');
  assert.ok(!text.includes('Reply'), 'comments excluded');
  assert.ok(!text.includes('Like'), 'action bar excluded');
});

test('extractPostText: returns empty string for unreadable posts without crashing', () => {
  makeDom('<div class="feed-shared-update-v2"><div class="feed-shared-social-actions-bar"><button>L</button></div></div>');
  const post = document.querySelector('.feed-shared-update-v2');
  const text = content.extractPostText(post);
  assert.equal(text, '');
});

test('extractFromShowMore: prefers sr text and ignores see-more tokens', () => {
  makeDom(`
    <div class="feed-shared-inline-show-more-text">
      <span class="visually-hidden">Full sentence that everyone should read at least once.</span>
    </div>`);
  const c = document.querySelector('.feed-shared-inline-show-more-text');
  assert.equal(content.extractFromShowMore(c), 'Full sentence that everyone should read at least once.');
});

test('extractAuthorName: finds author from actor metadata', () => {
  makeDom(textPostMarkup());
  const post = document.querySelector('.feed-shared-update-v2');
  assert.equal(content.extractAuthorName(post), 'Sarah Johnson');
});

test('extractAuthorName: empty when no actor block', () => {
  makeDom('<div class="feed-shared-update-v2"><div>x</div></div>');
  const post = document.querySelector('.feed-shared-update-v2');
  assert.equal(content.extractAuthorName(post), '');
});

test('normalizeWhitespace: collapses NBSP, zero-width and line breaks', () => {
  assert.equal(content.normalizeWhitespace('  a\u00a0b\n\n c\u200b '), 'a b c');
});

/* ============================================================ */
/*  content.js — comment button discovery                        */
/* ============================================================ */

test('findActionBar: picks the social actions bar', () => {
  makeDom(textPostMarkup());
  const post = document.querySelector('.feed-shared-update-v2');
  assert.ok(content.findActionBar(post));
});

test('findCommentButton: matches by aria-label "Comment"', () => {
  makeDom(textPostMarkup());
  const post = document.querySelector('.feed-shared-update-v2');
  const btn = content.findCommentButton(post);
  assert.ok(btn, 'button found');
  assert.equal(btn.getAttribute('aria-label'), 'Comment');
});

test('findCommentButton: falls back to second react-button (Like → Comment)', () => {
  makeDom(`
    <div class="feed-shared-update-v2">
      <div class="feed-shared-social-actions-bar">
        <button class="react-button">Like</button>
        <button class="react-button">Comment</button>
        <button class="react-button">Repost</button>
        <button class="react-button">Send</button>
      </div>
    </div>`);
  const post = document.querySelector('.feed-shared-update-v2');
  const btn = content.findCommentButton(post);
  assert.ok(btn);
  assert.equal(btn.textContent.trim(), 'Comment');
});

test('findCommentButton: null when there is no action bar', () => {
  makeDom('<div class="feed-shared-update-v2"><span>text</span></div>');
  const post = document.querySelector('.feed-shared-update-v2');
  assert.equal(content.findCommentButton(post), null);
});

/* ============================================================ */
/*  content.js — AI button injection                             */
/* ============================================================ */

test('injectButton: appends an AI button to the action bar and dedupes', () => {
  makeDom(textPostMarkup());
  const post = document.querySelector('.feed-shared-update-v2');
  const bar = content.findActionBar(post);
  const before = bar.querySelectorAll('button').length;

  assert.equal(content.injectButton(post), true, 'first injection succeeds');
  assert.equal(content.injectButton(post), true, 'second call is a no-op but still reports ok');
  const aiButtons = bar.querySelectorAll('button[data-liai-button]');
  assert.equal(aiButtons.length, 1, 'only one AI button per post');
  assert.equal(bar.querySelectorAll('button').length, before + 1, 'exactly one button added');
});

test('injectButton: returns false when there is no action bar (retry later)', () => {
  makeDom('<div class="feed-shared-update-v2"><span>no bar here</span></div>');
  const post = document.querySelector('.feed-shared-update-v2');
  assert.equal(content.injectButton(post), false);
});

/* ============================================================ */
/*  content.js — comment editor integration                      */
/* ============================================================ */

test('findCommentEditor: returns the visible ql-editor', () => {
  makeDom(`
    <div class="feed-shared-update-v2">
      <div class="comments-comment-box">
        <div class="ql-editor" contenteditable="true"></div>
      </div>
    </div>`);
  const post = document.querySelector('.feed-shared-update-v2');
  pretendVisible(post.querySelector('.ql-editor'));
  const editor = content.findCommentEditor(post);
  assert.ok(editor);
  assert.equal(editor.className, 'ql-editor');
});

test('findCommentEditor: returns null when composer is closed (no visible editor)', () => {
  makeDom(`
    <div class="feed-shared-update-v2">
      <div class="comments-comment-box">
        <div class="ql-editor" contenteditable="true" style="display:none"></div>
      </div>
    </div>`);
  const post = document.querySelector('.feed-shared-update-v2');
  assert.equal(content.findCommentEditor(post), null);
});

test('insertTextInto: uses execCommand when available', () => {
  makeDom('<div></div>');
  const dom = domRef;
  let execCalled = false;
  dom.window.document.execCommand = function () { execCalled = true; return true; };
  const editor = document.createElement('div');
  editor.innerHTML = '<p>old</p>';
  document.body.appendChild(editor);
  content.insertTextInto(editor, 'Brand new comment');
  assert.equal(execCalled, true, 'execCommand should be attempted');
  assert.equal(editor.textContent, 'old', 'innerHTML left alone when execCommand succeeds');
});

test('insertTextInto: manual fallback writes text and fires input events', () => {
  makeDom('<div></div>');
  const dom = domRef;
  dom.window.document.execCommand = function () { return false; };
  const editor = document.createElement('div');
  editor.contentEditable = 'true';
  document.body.appendChild(editor);

  let inputEvents = 0;
  editor.addEventListener('input', function () { inputEvents += 1; });
  let changeEvents = 0;
  editor.addEventListener('change', function () { changeEvents += 1; });

  content.insertTextInto(editor, 'A warm, human-sounding comment.');

  assert.equal(editor.textContent, 'A warm, human-sounding comment.');
  assert.ok(inputEvents >= 2, 'input events fired for React to notice');
  assert.ok(changeEvents >= 1, 'change event fired');
});

test('insertIntoComposer: writes into an already-open editor', async () => {
  makeDom(`
    <div class="feed-shared-update-v2">
      <div class="feed-shared-social-actions-bar">
        <button class="react-button" aria-label="Comment">Comment</button>
      </div>
      <div class="comments-comment-box">
        <div class="ql-editor" contenteditable="true"></div>
      </div>
    </div>`);
  const post = document.querySelector('.feed-shared-update-v2');
  pretendVisible(post.querySelector('.ql-editor'));
  domRef.window.document.execCommand = function () { return false; };

  const result = await content.insertIntoComposer(post, 'Nice work on the launch!');
  assert.equal(result.ok, true);
  assert.equal(post.querySelector('.ql-editor').textContent, 'Nice work on the launch!');
});

/* ============================================================ */
/*  background.js — comment cleaning                             */
/* ============================================================ */

test('cleanComment: strips wrapping quotes', () => {
  assert.equal(background.cleanComment('"Just shipped this and could not be happier."'), 'Just shipped this and could not be happier.');
  assert.equal(background.cleanComment('\u201cHappy for the team!\u201d'), 'Happy for the team!');
});

test('cleanComment: strips label prefixes', () => {
  assert.equal(background.cleanComment('Comment: This is a real reaction.'), 'This is a real reaction.');
  assert.equal(background.cleanComment("Here's your comment: Great work everyone!"), 'Great work everyone!');
});

test('cleanComment: collapses whitespace to a single line', () => {
  const out = background.cleanComment('Line one.\n\n   Line two.\tLine three.');
  assert.equal(out, 'Line one. Line two. Line three.');
});

test('cleanComment: removes leading bullet markers', () => {
  assert.equal(background.cleanComment('- Short and honest.'), 'Short and honest.');
  assert.equal(background.cleanComment('\u2022 Short and honest.'), 'Short and honest.');
});

test('cleanComment: returns empty for empty/noisy input', () => {
  assert.equal(background.cleanComment(''), '');
  assert.equal(background.cleanComment('   '), '');
  assert.equal(background.cleanComment('"\u201d'), '');
});

test('cleanComment: truncates very long output at a sentence boundary', () => {
  const long = ('Sentence one is short. ') .repeat(40);
  const out = background.cleanComment(long);
  assert.ok(out.length <= 500, 'length capped');
  assert.ok(out.length < long.length, 'was actually shortened');
});

/* ============================================================ */
/*  background.js — prompt building                              */
/* ============================================================ */

test('buildPrompt: includes tone, author, post text and language', () => {
  const prompt = background.buildPrompt(
    { tone: 'Empathetic', language: 'english', extraInstructions: '' },
    { text: 'We lost a teammate and built a better support process because of it.', author: 'Maria Lopez' }
  );
  assert.match(prompt, /Empathetic/);
  assert.match(prompt, /Maria Lopez/);
  assert.match(prompt, /support process/);
  assert.match(prompt, /Write the comment in English/);
});

test('buildPrompt: defaults to the post language and professional tone', () => {
  const prompt = background.buildPrompt(
    { tone: 'Professional', language: 'same', extraInstructions: '' },
    { text: 'بحمد اللہ ہم نے اپنا آخری سنگِ میل مکمل کر لیا۔', author: '' }
  );
  assert.match(prompt, /same language as the post/);
  assert.match(prompt, /Professional/);
  assert.match(prompt, /سنگِ میل/);
});

test('buildPrompt: bakes in anti-AI instructions, preserves up to 6000 chars of caption, and truncates oversized posts', () => {
  const full3000CharCaption = ('Paragraph hook about leadership and shipping real products. ').repeat(50).trim();
  const fullPrompt = background.buildPrompt(
    background.DEFAULT_SETTINGS,
    { text: full3000CharCaption, author: 'A' }
  );
  assert.ok(fullPrompt.includes(full3000CharCaption), 'full 3000-char LinkedIn caption is preserved completely without 1100-char cutoff');

  const longText = 'x'.repeat(10000);
  const prompt = background.buildPrompt(
    background.DEFAULT_SETTINGS,
    { text: longText, author: 'A' }
  );
  // The prompt must never grow unbounded with a 10k-char post: capped at 6000 chars + instructions (~9950 total).
  assert.ok(prompt.length < 10500, 'prompt stays bounded');
  assert.ok(prompt.includes(' …'), 'oversized post is truncated (ellipsis present)');
  const embedded = prompt.slice(prompt.indexOf('"""') + 3, prompt.indexOf('"""', prompt.indexOf('"""') + 3));
  assert.ok(embedded.length <= 6010, 'embedded post text is capped at ~6000 chars');
  assert.match(prompt, /NEVER sound like a bot/);
  assert.match(prompt, /NEVER use these clich/);
  assert.match(prompt, /Output ONLY the finished comment/);
});

test('buildPrompt: passes through custom extra instructions', () => {
  const prompt = background.buildPrompt(
    { tone: 'Friendly', language: 'same', extraInstructions: 'Always mention Acme Co.' },
    { text: 'Hiring for a PM role.', author: 'Omar' }
  );
  assert.match(prompt, /Always mention Acme Co\./);
});

test('buildPrompt: unknown language code falls back to "same as the post"', () => {
  const prompt = background.buildPrompt(
    { tone: 'Professional', language: 'klingon', extraInstructions: '' },
    { text: 'hello', author: '' }
  );
  assert.match(prompt, /same language as the post/);
});

test('truncate: short text unchanged, long text cut at word boundary', () => {
  assert.equal(background.truncate('hello world', 100), 'hello world');
  const out = background.truncate('one two three four five six seven eight', 20);
  assert.ok(out.length <= 24);
  assert.ok(out.endsWith(' …'));
});

/* ============================================================ */
/*  background.js — provider plumbing                            */
/* ============================================================ */

test('DEFAULT_SETTINGS: complete provider defaults', () => {
  const d = background.DEFAULT_SETTINGS;
  assert.equal(d.provider, 'openai');
  assert.ok(d.apiKey === '');
  assert.ok(d.model);
  assert.match(d.baseUrl, /^https:\/\//);
  assert.ok(d.tone);
  assert.ok(d.language);
});

test('callProvider: routes Gemini to the Gemini endpoint', async () => {
  // Simulate fetch so we never hit the network.
  const calls = [];
  global.fetch = async function (url, opts) {
    calls.push({ url: String(url), method: opts.method });
    return {
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'Nice milestone!' }] } }] })
    };
  };
  const out = await background.callGemini(
    { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'AIza-test', model: 'gemini-2.5-flash' },
    'prompt'
  );
  assert.equal(out, 'Nice milestone!');
  assert.match(calls[0].url, /generateContent/);
  assert.match(calls[0].url, /key=AIza-test/);
  delete global.fetch;
});

test('callGemini: filters out internal thought parts from Gemini 2.5/3.x responses', async () => {
  global.fetch = async function () {
    return {
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [
              { thought: true, text: 'Let me think about how to respond to Sarah...' },
              { text: 'Sarah, cutting bounce rate by 24 percent is a huge win for accessibility.' }
            ]
          }
        }]
      })
    };
  };
  const out = await background.callGemini(
    { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'AIza-test', model: 'gemini-2.5-flash' },
    'prompt'
  );
  assert.equal(out, 'Sarah, cutting bounce rate by 24 percent is a huge win for accessibility.');
  delete global.fetch;
});

test('callAnthropic: sends messages payload with x-api-key and parses text blocks', async () => {
  let captured = null;
  global.fetch = async function (url, opts) {
    captured = { url: String(url), headers: opts.headers, body: JSON.parse(opts.body) };
    return {
      ok: true,
      json: async () => ({
        content: [
          { type: 'thinking', thinking: 'Internal reasoning...' },
          { type: 'text', text: 'Shipping this after two years of sprints is well worth celebrating.' }
        ]
      })
    };
  };
  const out = await background.callProvider(
    { provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'sk-ant-test', model: 'claude-sonnet-4-6' },
    'the prompt'
  );
  assert.equal(out, 'Shipping this after two years of sprints is well worth celebrating.');
  assert.equal(captured.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(captured.headers['x-api-key'], 'sk-ant-test');
  assert.equal(captured.body.model, 'claude-sonnet-4-6');
  delete global.fetch;
});

test('callOpenAICompat: sends chat/completions with bearer auth and parses response', async () => {
  let captured = null;
  global.fetch = async function (url, opts) {
    captured = { url: String(url), body: JSON.parse(opts.body), auth: opts.headers.Authorization };
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Very relatable — thanks for sharing the numbers.' } }] })
    };
  };
  const out = await background.callOpenAICompat(
    { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-5-mini' },
    'the prompt'
  );
  assert.equal(out, 'Very relatable — thanks for sharing the numbers.');
  assert.equal(captured.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(captured.auth, 'Bearer sk-test');
  assert.equal(captured.body.model, 'gpt-5-mini');
  assert.equal(captured.body.max_completion_tokens, 2000);
  assert.equal(captured.body.max_tokens, undefined);
  delete global.fetch;
});

test('callOpenAICompat: surfaces provider error messages', async () => {
  global.fetch = async function () {
    return {
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => JSON.stringify({ error: { message: 'Incorrect API key provided.' } })
    };
  };
  await assert.rejects(
    background.callOpenAICompat({ baseUrl: 'https://api.openai.com/v1', apiKey: 'bad', model: 'gpt-5-mini' }, 'p'),
    /Incorrect API key/
  );
  delete global.fetch;
});

test('callOpenAICompat: wraps network failures in a friendly message', async () => {
  global.fetch = async function () { throw new TypeError('Failed to fetch'); };
  await assert.rejects(
    background.callOpenAICompat({ baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'm' }, 'p'),
    /Network error/
  );
  delete global.fetch;
});

test('testConnection: reports model reply', async () => {
  global.fetch = async function () {
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) };
  };
  const r = await background.testConnection({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-5-mini' });
  assert.equal(r.ok, true);
  assert.match(r.detail, /Connected to OpenAI/);
  delete global.fetch;
});

test('cleanComment: strips <think> reasoning blocks', () => {
  const raw = '<think>\nThe user wants a short LinkedIn comment.\n</think>\n"Sarah, doubling screen reader support is a massive milestone."';
  assert.equal(background.cleanComment(raw), 'Sarah, doubling screen reader support is a massive milestone.');
});

test('real LinkedIn DOM: singular feed-shared-social-action-bar, update-components-text, and findCommentButton after injectButton', () => {
  makeDom(`
    <div class="feed-shared-update-v2" data-urn="urn:li:ugcPost:999">
      <div class="update-components-actor">
        <span class="update-components-actor__title">
          <span class="update-components-actor__name">
            <span dir="ltr"><span aria-hidden="true">Alex Rivera</span><span class="visually-hidden">View Alex Rivera’s profile</span></span>
          </span>
        </span>
      </div>
      <div class="feed-shared-update-v2__description">
        <div class="update-components-text">
          <span class="break-words"><span dir="ltr">We migrated 400 microservices to Rust with zero downtime.</span></span>
        </div>
        <button class="feed-shared-inline-show-more-text__see-more-less-toggle"><span>…more</span></button>
      </div>
      <div class="feed-shared-social-action-bar">
        <button class="react-button">Like</button>
        <button class="react-button">Comment</button>
        <button class="react-button">Repost</button>
        <button class="react-button">Send</button>
      </div>
    </div>`);
  const post = document.querySelector('.feed-shared-update-v2');
  assert.equal(content.extractAuthorName(post), 'Alex Rivera');
  assert.equal(content.extractPostText(post), 'We migrated 400 microservices to Rust with zero downtime.');
  assert.equal(content.injectButton(post), true, 'injects into singular .feed-shared-social-action-bar');
  const commentBtn = content.findCommentButton(post);
  assert.ok(commentBtn, 'finds native comment button');
  assert.equal(commentBtn.hasAttribute('data-liai-button'), false, 'never returns injected AI button');
  assert.equal(commentBtn.textContent.trim(), 'Comment');
});

/* ============================================================ */
/*  packaging — manifest sanity                                  */
/* ============================================================ */

test('manifest.json: valid, MV3, LinkedIn-scoped content script', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.background.service_worker);
  const cs = manifest.content_scripts[0];
  assert.ok(cs.matches.some((m) => m.includes('linkedin.com')));
  assert.ok(cs.js.includes('content.js'));
  assert.ok(cs.css.includes('content.css'));
  const perms = manifest.permissions;
  for (const p of ['storage', 'activeTab', 'scripting']) assert.ok(perms.includes(p));
  assert.ok(manifest.optional_host_permissions.length >= 2, 'custom base URLs possible');
});

test('manifest.json: every referenced file exists', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const files = [];
  files.push(manifest.background.service_worker);
  csFiles(manifest, files);
  files.push.apply(files, Object.values(manifest.icons || {}));
  files.push.apply(files, Object.values(manifest.action.default_icon || {}));
  if (manifest.options_ui) files.push(manifest.options_ui.page);
  if (manifest.action.default_popup) files.push(manifest.action.default_popup);
  for (const f of files) {
    if (!f) continue;
    assert.ok(fs.existsSync(path.join(ROOT, f)), 'missing file: ' + f);
  }
  // icons must be real PNGs
  const iconBytes = fs.readFileSync(path.join(ROOT, manifest.icons['128']));
  assert.equal(iconBytes[0], 0x89);
  assert.equal(iconBytes[1], 0x50);
});

function csFiles(manifest, out) {
  for (const cs of manifest.content_scripts || []) {
    out.push.apply(out, cs.js || []);
    out.push.apply(out, cs.css || []);
  }
}

test('content.js and background.js export their test surface', () => {
  assert.equal(typeof content.extractPostText, 'function');
  assert.equal(typeof content.insertTextInto, 'function');
  assert.equal(typeof background.buildPrompt, 'function');
  assert.equal(typeof background.cleanComment, 'function');
  assert.equal(typeof background.fetchAvailableModels, 'function');
  assert.equal(typeof background.analyzeAndRankModels, 'function');
  assert.ok(content.TONES.includes('Professional'));
});

test('analyzeAndRankModels: filters non-chat Gemini models and ranks newest generation first', () => {
  const rawGeminiModels = [
    { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/aqa', supportedGenerationMethods: ['generateAnswer'] }
  ];
  const res = background.analyzeAndRankModels('gemini', rawGeminiModels);
  assert.equal(res.recommended, 'gemini-3.8-flash');
  assert.deepEqual(res.models.slice(0, 4), [
    'gemini-3.8-flash',
    'gemini-3.5-flash',
    'gemini-2.5-flash',
    'gemini-2.5-pro'
  ]);
  assert.ok(!res.models.includes('text-embedding-004'));
  assert.ok(!res.models.includes('gemini-2.5-flash-preview-tts'));
  assert.ok(!res.models.includes('gemini-3.1-flash-image'));
});

test('fetchAvailableModels: queries Gemini v1beta/models and returns ranked models', async () => {
  let calledUrl = '';
  global.fetch = async function (url) {
    calledUrl = String(url);
    return {
      ok: true,
      json: async () => ({
        models: [
          { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] }
        ]
      })
    };
  };
  const res = await background.fetchAvailableModels({
    provider: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'AIza-test'
  });
  assert.equal(res.ok, true);
  assert.equal(res.source, 'direct');
  assert.equal(res.recommended, 'gemini-3.8-flash');
  assert.match(calledUrl, /\/models\?key=AIza-test/);
  delete global.fetch;
});

test('Grammarly-style widget: attaches floating AI Draft trigger when a comment editor is focused or detected', () => {
  makeDom(`
    <div class="feed-shared-update-v2" data-urn="urn:li:activity:777">
      <div class="update-components-actor__meta">
        <a class="update-components-actor__name" href="/in/elena-rostova/"><span dir="auto">Elena Rostova</span></a>
      </div>
      <div class="update-components-text">
        <span>We cut cold-start latency from 900ms down to 45ms by pre-warming V8 isolates.</span>
      </div>
      <div class="comments-comment-box">
        <div class="comments-comment-texteditor">
          <div class="ql-editor" role="textbox" aria-label="Add a comment…" contenteditable="true"></div>
        </div>
      </div>
    </div>`);
  const editor = document.querySelector('.ql-editor');
  pretendVisible(editor);
  assert.equal(content.isLinkedInCommentEditor(editor), true, 'recognizes LinkedIn comment editor');
  assert.equal(content.resolveEditableRoot(editor), editor, 'resolves editable root');

  const widget = content.attachGrammarlyWidget(editor);
  assert.ok(widget, 'creates floating Grammarly-style AI widget');
  assert.equal(widget.id, 'liai-grammarly-widget');
  assert.ok(widget.classList.contains('liai-visible'), 'widget becomes visible');
  assert.match(widget.textContent, /AI Draft/);
});

test('obfuscated SDUI DOM: discovers post via universal Comment button heuristic without class names', () => {
  makeDom(`
    <div data-id="urn:li:activity:888">
      <div><a href="/in/marcus-chen/"><span>Marcus Chen</span></a></div>
      <div data-view-name="feed-commentary"><span>Shipped our new local-first sync engine today.</span></div>
      <div>
        <button aria-label="React Like">Like</button>
        <button aria-label="Comment on Marcus Chen’s post">Comment</button>
        <button aria-label="Repost">Repost</button>
      </div>
    </div>`);
  const stats = content.scanForPosts();
  assert.ok(stats.postsFound >= 1, 'finds and injects AI button even with obfuscated class names');
  const post = document.querySelector('[data-id="urn:li:activity:888"]');
  assert.equal(content.extractAuthorName(post), 'Marcus Chen');
  assert.equal(content.extractPostText(post), 'Shipped our new local-first sync engine today.');
});

test('callProviderWithModelFallback: auto-switches to latest available API model on 404 model error', async () => {
  const calls = [];
  global.fetch = async function (url) {
    const u = String(url);
    calls.push(u);
    if (u.includes('gemini-retired:generateContent')) {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => JSON.stringify({ error: { message: 'models/gemini-retired is not found' } })
      };
    }
    if (u.includes('/models?key=')) {
      return {
        ok: true,
        json: async () => ({
          models: [
            { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }
          ]
        })
      };
    }
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'Congrats on shipping this!' }] } }]
      })
    };
  };
  const res = await background.callProviderWithModelFallback({
    provider: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'AIza-key',
    model: 'gemini-retired',
    userSelectedModel: true
  }, 'prompt');
  assert.equal(res.settings.model, 'gemini-3.8-flash');
  assert.equal(res.raw, 'Congrats on shipping this!');
  assert.equal(calls.length, 3);
  delete global.fetch;
});

test('never injects duplicate AI button next to the comment box submit button (even in obfuscated SDUI DOMs)', () => {
  makeDom(`
    <div data-id="urn:li:activity:909">
      <div><a href="/in/alex-lee/"><span>Alex Lee</span></a></div>
      <div data-view-name="feed-commentary"><span>Showing the person behind the expertise has been my biggest lesson with video.</span></div>
      <div class="social-action-bar">
        <button aria-label="React Like">Like</button>
        <button aria-label="Comment">Comment</button>
        <button aria-label="Repost">Repost</button>
        <button aria-label="Send">Send</button>
      </div>
      <div class="comment-composer-wrapper">
        <div role="textbox" contenteditable="true" aria-label="Add a comment…">Showing the person behind the expertise...</div>
        <div class="composer-footer-row">
          <button aria-label="Open Emoji Picker">😊</button>
          <button aria-label="Open GIF Picker">GIF</button>
          <button aria-label="Add photo">🖼</button>
          <button class="artdeco-button--primary">Comment</button>
        </div>
      </div>
    </div>`);
  const editor = document.querySelector('[role="textbox"]');
  pretendVisible(editor);
  const stats = content.scanForPosts();
  const aiButtons = document.querySelectorAll('button[data-liai-button]');
  assert.equal(aiButtons.length, 1, 'injects strictly 1 AI button on the post social action bar, never next to the Comment submit button');
  assert.equal(stats.postsFound, 1);
  const footerRow = document.querySelector('.composer-footer-row');
  assert.equal(footerRow.querySelector('button[data-liai-button]'), null, 'no AI button inside comment box footer row');
});

test('floating AI Draft widget: supports ✕ dismiss button and auto-hide while typing', () => {
  makeDom(`
    <div class="feed-shared-update-v2" data-urn="urn:li:activity:555">
      <div class="update-components-actor__meta">
        <a class="update-components-actor__name" href="/in/sam/"><span dir="auto">Sam</span></a>
      </div>
      <div class="update-components-text"><span>Post body text here.</span></div>
      <div class="comments-comment-box">
        <div class="comments-comment-texteditor">
          <div class="ql-editor" role="textbox" aria-label="Add a comment…" contenteditable="true"></div>
        </div>
      </div>
    </div>`);
  content.syncUiPrefsFromItems({ hideFloatingWidget: false, hideWhileTyping: true });
  const editor = document.querySelector('.ql-editor');
  pretendVisible(editor);

  const widget = content.attachGrammarlyWidget(editor);
  assert.ok(widget.classList.contains('liai-visible'), 'widget initially visible on focus');

  // Simulate user typing when hideWhileTyping is enabled
  content.markEditorTyping(editor);
  assert.equal(widget.style.display, 'none', 'widget hides while user is actively typing');

  // Re-focusing or clicking brings it back, and clicking ✕ dismisses it for this editor
  content.syncUiPrefsFromItems({ hideFloatingWidget: false, hideWhileTyping: false });
  content.attachGrammarlyWidget(editor);
  assert.notEqual(widget.style.display, 'none', 'widget visible again');

  const hideBtn = widget.querySelector('.liai-grammarly-hide');
  assert.ok(hideBtn, 'has ✕ dismiss button on the floating pill');
  hideBtn.click();
  assert.equal(widget.style.display, 'none', 'clicking ✕ hides the floating widget');

  // Even if attachGrammarlyWidget is called again on the same dismissed editor, it stays hidden
  content.attachGrammarlyWidget(editor);
  assert.equal(widget.style.display, 'none', 'stays hidden for dismissed comment box');
});

test('OpenRouter: includes EVERY model from the OpenRouter API (including :free models and all providers) and preserves user-selected model', async () => {
  const rawOpenRouterModels = [
    { id: 'openrouter/free', name: 'Free Models Router', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } },
    { id: 'google/gemma-4-31b-it:free', name: 'Google: Gemma 4 31B (free)', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } },
    { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'NVIDIA: Nemotron 3 Ultra (free)', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } },
    { id: 'meta-llama/llama-4-maverick', name: 'Meta: Llama 4 Maverick', pricing: { prompt: '0.0001', completion: '0.0002' }, architecture: { output_modalities: ['text'] } },
    { id: 'mistralai/mistral-large-2411', name: 'Mistral Large', pricing: { prompt: '0.0002', completion: '0.0006' }, architecture: { output_modalities: ['text'] } },
    { id: 'x-ai/grok-4.3', name: 'xAI: Grok 4.3', pricing: { prompt: '0.0003', completion: '0.0009' }, architecture: { output_modalities: ['text'] } },
    { id: 'cohere/north-mini-code:free', name: 'Cohere: North Mini Code (free)', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } },
    { id: 'anthropic/claude-sonnet-4.6', name: 'Anthropic: Claude Sonnet 4.6', pricing: { prompt: '0.0003', completion: '0.0015' }, architecture: { output_modalities: ['text'] } },
    { id: 'openai/gpt-5-mini', name: 'OpenAI: GPT-5 Mini', pricing: { prompt: '0.0001', completion: '0.0004' }, architecture: { output_modalities: ['text'] } },
    { id: 'deepseek/deepseek-chat', name: 'DeepSeek: V3', pricing: { prompt: '0.0001', completion: '0.0002' }, architecture: { output_modalities: ['text'] } }
  ];

  const analyzed = background.analyzeAndRankModels('openrouter', rawOpenRouterModels, { fromCatalog: false });
  assert.equal(analyzed.models.length, rawOpenRouterModels.length, 'every OpenRouter text model is included without dropping :free or other providers');
  assert.ok(analyzed.models.includes('google/gemma-4-31b-it:free'), 'includes :free Google Gemma model');
  assert.ok(analyzed.models.includes('nvidia/nemotron-3-ultra-550b-a55b:free'), 'includes :free NVIDIA model');
  assert.ok(analyzed.models.includes('cohere/north-mini-code:free'), 'includes :free Cohere model');
  assert.ok(analyzed.models.includes('meta-llama/llama-4-maverick'), 'includes Meta Llama model');
  assert.ok(analyzed.models.includes('mistralai/mistral-large-2411'), 'includes Mistral model');
  assert.ok(analyzed.models.includes('x-ai/grok-4.3'), 'includes xAI Grok model');
  assert.equal(analyzed.freeModels.length, 4, 'identifies all 4 free models');
});

test('OpenRouter testConnection / callOpenAICompat: handles reasoning-heavy free models and retries cleanly on parameter rejection', async () => {
  const requests = [];
  global.fetch = async function (url, opts) {
    const body = JSON.parse(opts.body);
    requests.push(body);
    if (requests.length === 1) {
      // Simulate a free reasoning model that rejects temperature or returns empty content on first try
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: '',
              reasoning: 'Thinking about how to reply...\nOK'
            }
          }]
        })
      };
    }
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'OK' } }]
      })
    };
  };

  const out = await background.callOpenAICompat({
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'sk-or-test',
    model: 'nvidia/nemotron-3-ultra-550b-a55b:free'
  }, 'Reply with exactly the single word: OK');

  assert.equal(out, 'OK');
  assert.equal(requests[0].model, 'nvidia/nemotron-3-ultra-550b-a55b:free');
  delete global.fetch;
});

test('Entropy-Seeded Comment-Writing Procedure & Contextual Identity: generates 48-char hex seed, embeds procedure, and keeps persona contextual-only', () => {
  // 1) 48-character random hex seed (openssl rand -hex 24 equivalent)
  const seed1 = background.generateRandomSeed(24);
  const seed2 = background.generateRandomSeed(24);
  assert.match(seed1, /^[0-9a-f]{48}$/, 'generates 48-character lowercase hex string');
  assert.notEqual(seed1, seed2, 'each seed generation is fresh and unique');

  // 2) Repeated substring detection for the bonus rhetorical structure constraint
  const repeated = background.findRepeatedSubstrings('a7b2c3a7b2ff00112233445566778899aabbccddeeff0011');
  assert.ok(repeated.includes('a7b2'), 'detects repeated 4-char hex substring in seed');

  // 3) Contextual-only profile & Entropy-Seeded Procedure in SYSTEM_PROMPT and buildPrompt
  assert.equal(background.DEFAULT_VOICE_PROFILE.name, 'Practitioner');
  assert.match(background.SYSTEM_PROMPT, /READ & COMPREHEND THE WHOLE CAPTION FIRST/);
  assert.match(background.SYSTEM_PROMPT, /CONTEXTUAL IDENTITY \(USE ONLY WHEN RELEVANT\)/);
  assert.match(background.SYSTEM_PROMPT, /ENTROPY-SEEDED COMMENT-WRITING PROCEDURE/);
  assert.match(background.SYSTEM_PROMPT, /openssl rand -hex 24/);

  const commentPrompt = background.buildPrompt(
    background.DEFAULT_SETTINGS,
    {
      text: 'We stopped doing daily standups and our team shipped twice as much in Q3. The secret was async written updates.',
      author: 'Dan',
      tone: 'Humor / Witty',
      channel: 'comment',
      angle: 'Point out the calendar irony'
    }
  );
  assert.match(commentPrompt, /Random Alphanumeric Seed \(openssl rand -hex 24\): [0-9a-f]{48}/);
  assert.match(commentPrompt, /Derive a creative direction from the string/);
  assert.match(commentPrompt, /Tone & voice/);
  assert.match(commentPrompt, /Structure & rhythm/);
  assert.match(commentPrompt, /Diction & texture/);
  assert.match(commentPrompt, /Stance toward the author/);
  assert.match(commentPrompt, /Bonus constraint \(optional\): if the string contains a repeated substring/);
  assert.match(commentPrompt, /You are a sharp, perceptive human reader and social writer/);
  assert.match(commentPrompt, /Point out the calendar irony/);

  // Custom persona test
  const customPersonaPrompt = background.buildPrompt(
    Object.assign({}, background.DEFAULT_SETTINGS, {
      userName: 'Alex',
      userRole: 'Full-Stack Developer & Open Source Builder'
    }),
    {
      text: 'Our CI build times dropped from 20 minutes to 3 minutes by caching Docker layer hashes.',
      author: 'Dan',
      tone: 'Practitioner Take',
      channel: 'comment'
    }
  );
  assert.match(customPersonaPrompt, /You are writing on behalf of Alex \(Background context: Full-Stack Developer & Open Source Builder\)/);
  assert.match(customPersonaPrompt, /ONLY bring in Alex's specific domain background when the post is genuinely relevant/);

  // 4) LinkedIn Post & X Post channels
  const liPostPrompt = background.buildPrompt(
    background.DEFAULT_SETTINGS,
    { text: 'AI workflows in software engineering.', author: 'Alex', channel: 'linkedin_post' }
  );
  assert.match(liPostPrompt, /Channel — LinkedIn Post/);
  assert.match(liPostPrompt, /Thoughts\? Agree\?/);

  const xPostPrompt = background.buildPrompt(
    background.DEFAULT_SETTINGS,
    { text: 'Testing new layout engines.', author: 'Alex', channel: 'x_post' }
  );
  assert.match(xPostPrompt, /Channel — X \(Twitter\) Post \(<280 chars\)/);
});

test('cleanComment: strips sycophantic openers, banned emojis, and echoed seeds while preserving em-dash punctuation personality and multiline posts', () => {
  const rawComment = 'Great post! Most teams don\u2019t have a meeting problem — they have a trust problem. 🚀🔥🤖';
  const cleaned = background.cleanComment(rawComment);
  assert.equal(cleaned, 'Most teams don\u2019t have a meeting problem — they have a trust problem.');

  const withEchoedSeed = 'Seed: 4f8a9c12e3b40987654321fedcba0987654321fedcba0123\n"Here is the real lesson from shipping this."';
  assert.equal(background.cleanComment(withEchoedSeed), 'Here is the real lesson from shipping this.');

  const rawPost = 'AI didn\'t take my design job.\nIt took the parts of it I never wanted.\n\nThe 40 tabs of competitor screenshots. The third round of lorem ipsum. Thoughts? Agree? 👇';
  const cleanedPost = background.cleanComment(rawPost, { multiline: true, maxLength: 1500 });
  assert.ok(cleanedPost.includes('\n\n'), 'preserves paragraph breaks in LinkedIn post mode');
  assert.ok(!cleanedPost.includes('👇'), 'strips banned emoji');
  assert.ok(!/Thoughts\?\s*Agree\?/i.test(cleanedPost), 'strips engagement-bait closing');
});

test('Bulletproof caption extraction: ignores tiny .visually-hidden noise tags and auto-expands collapsed "…more" buttons', () => {
  makeDom(`
    <div class="feed-shared-update-v2" data-urn="urn:li:activity:321">
      <div class="update-components-actor__meta">
        <a class="update-components-actor__name" href="/in/priya-patel/"><span dir="auto">Priya Patel</span></a>
      </div>
      <div class="feed-shared-inline-show-more-text">
        <a href="/feed/hashtag/product"><span class="visually-hidden">hashtag</span>#product</a>
        <span dir="ltr">First paragraph about why most onboarding flows fail in the first 30 seconds.<br><br>Second paragraph with the actual takeaway: cut the 6-step wizard and drop users straight into the workspace.</span>
        <button class="feed-shared-inline-show-more-text__see-more-less-toggle">…more</button>
      </div>
      <div class="feed-shared-social-actions-bar">
        <button class="react-button" aria-label="Like">Like</button>
        <button class="react-button" aria-label="Comment">Comment</button>
      </div>
    </div>`);
  const post = document.querySelector('.feed-shared-update-v2');
  const toggleBtn = post.querySelector('.feed-shared-inline-show-more-text__see-more-less-toggle');
  let expandedClicked = false;
  toggleBtn.addEventListener('click', () => {
    expandedClicked = true;
  });

  assert.equal(content.expandCollapsedPostText(post), true, 'clicks collapsed …more button automatically');
  assert.equal(expandedClicked, true, '…more button click handler fired');

  const extracted = content.extractPostText(post);
  assert.ok(extracted.includes('First paragraph about why most onboarding flows fail'), 'includes first paragraph');
  assert.ok(extracted.includes('Second paragraph with the actual takeaway: cut the 6-step wizard'), 'does NOT stop at tiny "hashtag" .visually-hidden span; reads whole caption');
  assert.ok(!/\bhashtag\b/i.test(extracted), 'strips screen-reader noise label');
});

test('Stop generation: clicking ■ Stop or pressing Escape stops in-flight comment and post generation anytime', async () => {
  makeDom(textPostMarkup());
  const post = document.querySelector('.feed-shared-update-v2');

  const sentMessages = [];
  let pendingGenerateCb = null;
  global.chrome = {
    storage: {
      local: {
        get: (_k, cb) => cb({ provider: 'openai', apiKey: 'sk-test', model: 'gpt-5-mini', tone: 'Professional' })
      }
    },
    runtime: {
      lastError: null,
      sendMessage: (msg, cb) => {
        sentMessages.push(msg);
        if (msg.type === 'generateComment') {
          pendingGenerateCb = cb;
          return;
        }
        if (msg.type === 'cancelGeneration') {
          if (cb) cb({ ok: true, cancelled: true });
          return;
        }
        if (cb) cb({ ok: true });
      }
    }
  };

  await content.openPanel({ post });
  await new Promise((r) => setTimeout(r, 10));

  const panel = document.getElementById('liai-panel');
  assert.ok(panel, 'composer panel is open');
  const stopBtn = panel.querySelector('.liai-stop');
  const regenBtn = panel.querySelector('.liai-regenerate');
  const statusEl = panel.querySelector('.liai-status');
  const textarea = panel.querySelector('.liai-text');

  // While comment generation is in-flight, ■ Stop is visible and ↻ Regenerate is hidden
  assert.equal(stopBtn.hidden, false, '■ Stop button is visible while generating comment');
  assert.equal(regenBtn.hidden, true, '↻ Regenerate button is hidden while generating');
  assert.equal(statusEl.getAttribute('data-busy'), 'true');
  assert.match(statusEl.textContent, /Crafting a personalized reply/);

  // Click ■ Stop to abort comment generation
  stopBtn.click();
  assert.equal(stopBtn.hidden, true, '■ Stop button hides immediately after stopping');
  assert.equal(regenBtn.hidden, false, '↻ Regenerate button is restored immediately');
  assert.equal(regenBtn.disabled, false, '↻ Regenerate button is enabled');
  assert.equal(statusEl.getAttribute('data-busy'), null, 'spinner stopped');
  assert.equal(statusEl.textContent, 'Stopped generating comment.');
  assert.ok(sentMessages.some((m) => m.type === 'cancelGeneration'), 'sends cancelGeneration to background');

  // Even if the old request callback resolves late, it must not overwrite the stopped state
  if (pendingGenerateCb) pendingGenerateCb({ ok: true, comment: 'Late stale comment that should be ignored.' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(textarea.value, '', 'stale response after Stop is ignored');

  // Switch channel to LinkedIn Post ('linkedin_post') -> starts generating post
  const channelSelect = panel.querySelector('.liai-channel');
  channelSelect.value = 'linkedin_post';
  channelSelect.dispatchEvent(new window.Event('change'));
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(stopBtn.hidden, false, '■ Stop button is visible while generating LinkedIn post');
  assert.match(statusEl.textContent, /Drafting LinkedIn post/);

  // Pressing Escape while generating stops the post generation (without closing the panel)
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok(document.getElementById('liai-panel'), 'panel stays open when Escape stops generation');
  assert.equal(stopBtn.hidden, true, '■ Stop button hidden after Escape stops post generation');
  assert.equal(statusEl.textContent, 'Stopped generating post.');

  // Pressing Escape again when idle closes the panel
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(document.getElementById('liai-panel'), null, 'second Escape closes panel when idle');

  delete global.chrome;
});

test('background cancelGeneration: aborts in-flight fetch via AbortSignal and returns cancelled response', async () => {
  let capturedSignal = null;
  global.chrome = {
    storage: {
      local: {
        get: (_d, cb) => cb({
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
          model: 'gpt-5-mini',
          userSelectedModel: true
        })
      }
    }
  };
  global.fetch = function (_url, opts) {
    capturedSignal = opts && opts.signal;
    return new Promise((_resolve, reject) => {
      if (capturedSignal) {
        capturedSignal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      }
    });
  };

  const responsePromise = new Promise((resolve) => {
    background.onMessage(
      {
        type: 'generateComment',
        requestId: 77,
        payload: { text: 'Design systems at scale.', author: 'Alex', channel: 'linkedin_post' }
      },
      {},
      resolve
    );
  });

  await new Promise((r) => setTimeout(r, 15));
  assert.ok(capturedSignal, 'fetch receives an AbortSignal');
  assert.equal(capturedSignal.aborted, false);

  const cancelRes = background.cancelGeneration(77);
  assert.equal(cancelRes.ok, true);
  assert.equal(cancelRes.cancelled, true);
  assert.equal(capturedSignal.aborted, true, 'AbortSignal is aborted immediately');

  const finalResp = await responsePromise;
  assert.equal(finalResp.ok, false);
  assert.equal(finalResp.cancelled, true);
  assert.match(finalResp.error, /Generation stopped/);

  delete global.fetch;
  delete global.chrome;
});

test('LinkedIn Post Composer ("Start a post" / share modal): attaches floating AI Post badge, injects AI Post button, and defaults channel to linkedin_post', async () => {
  makeDom(`
    <div class="share-box-feed-entry__closed-share-box">
      <button class="share-box-feed-entry__trigger">Start a post</button>
    </div>
    <div role="dialog" aria-label="Share a post" class="share-box-v2__modal">
      <div class="share-creation-state">
        <div class="share-creation-state__text-editor">
          <div class="ql-editor" role="textbox" contenteditable="true" aria-label="Text editor for creating content" data-placeholder="What do you want to talk about?"></div>
        </div>
        <div class="share-creation-state__footer">
          <button class="share-actions__primary-action">Post</button>
        </div>
      </div>
    </div>`);

  const postEditor = document.querySelector('.share-creation-state__text-editor .ql-editor');
  pretendVisible(postEditor);
  pretendVisible(document.querySelector('[role="dialog"]'));

  assert.equal(content.isPostComposerEditor(postEditor), true, 'detects LinkedIn post creation editor');
  assert.equal(content.isLinkedInCommentEditor(postEditor), true, 'isLinkedInCommentEditor accepts post creation editor');
  assert.equal(content.findPostComposerEditor(), postEditor, 'findPostComposerEditor returns visible post editor');

  const triggerBtn = document.querySelector('.share-box-feed-entry__trigger');
  assert.equal(content.isStartPostTriggerButton(triggerBtn), true, 'recognizes Start a post trigger button');

  const stats = content.scanForPosts();
  assert.ok(stats.editorsFound >= 1, 'scanForPosts finds the post creation editor');

  const modalFooterBtn = document.querySelector('[data-liai-post-composer-btn]');
  assert.ok(modalFooterBtn, 'injects ✨ AI Post button into the LinkedIn post modal footer');
  assert.match(modalFooterBtn.textContent, /AI Post/);

  const widget = content.attachGrammarlyWidget(postEditor);
  assert.ok(widget, 'attaches floating widget to post creation editor');
  assert.equal(widget.querySelector('.liai-grammarly-label').textContent, 'AI Post', 'floating badge says AI Post when inside post composer');

  global.chrome = {
    storage: {
      local: {
        get: (_k, cb) => cb({ provider: 'openai', apiKey: 'sk-test', model: 'gpt-5-mini', tone: 'Engaging', channel: 'comment' })
      }
    },
    runtime: {
      lastError: null,
      sendMessage: (msg, cb) => {
        if (msg.type === 'generateComment') {
          cb({ ok: true, comment: 'Most UX bugs are actually state management bugs in disguise.\n\nFix the state model first.' });
          return;
        }
        if (cb) cb({ ok: true });
      }
    }
  };

  await content.openPanel({ post: null, editor: postEditor, anchor: widget });
  await new Promise((r) => setTimeout(r, 15));

  const panel = document.getElementById('liai-panel');
  assert.ok(panel, 'composer panel opens for LinkedIn post creation');
  const channelSelect = panel.querySelector('.liai-channel');
  assert.equal(channelSelect.value, 'linkedin_post', 'automatically selects LI Post channel when opened from post composer');
  assert.match(panel.querySelector('.liai-context').textContent, /Writing a new post/);

  content.closePanel();
  delete global.chrome;
});

test('LinkedIn Post Composer inside #interop-outlet open Shadow DOM: detects shadow-root editor and attaches floating AI Post badge', () => {
  makeDom(`
    <div id="interop-outlet"></div>
  `);
  const host = document.getElementById('interop-outlet');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <div role="dialog" aria-label="Share a post" class="share-box-v2__modal">
      <div class="share-creation-state">
        <div class="share-creation-state__text-editor">
          <div class="ql-editor" role="textbox" contenteditable="true" aria-label="Text editor for creating content" data-placeholder="What do you want to talk about?"></div>
        </div>
        <div class="share-creation-state__footer">
          <button class="share-actions__primary-action">Post</button>
        </div>
      </div>
    </div>
  `;

  const shadowDialog = shadow.querySelector('[role="dialog"]');
  const shadowEditor = shadow.querySelector('.ql-editor');
  pretendVisible(shadowDialog);
  pretendVisible(shadowEditor);

  assert.equal(content.isPostComposerEditor(shadowEditor), true, 'detects post editor inside #interop-outlet shadowRoot');
  assert.equal(content.findPostComposerEditor(), shadowEditor, 'findPostComposerEditor pierces #interop-outlet shadowRoot');

  const stats = content.scanForPosts();
  assert.ok(stats.editorsFound >= 1, 'scanForPosts discovers editor inside shadowRoot');

  const shadowModalBtn = shadow.querySelector('[data-liai-post-composer-btn]');
  assert.ok(shadowModalBtn, 'injects AI Post button into shadowRoot modal footer with inline styles');
  assert.match(shadowModalBtn.getAttribute('style') || '', /inline-flex/, 'applies inline styles so button looks right inside shadow DOM');

  const widget = document.getElementById('liai-grammarly-widget');
  assert.ok(widget, 'floating widget is attached to document.body');
  assert.ok(widget.classList.contains('liai-visible'), 'floating widget stays visible even when activeEditor lives inside shadowRoot');
  assert.equal(widget.querySelector('.liai-grammarly-label').textContent, 'AI Post');
});

test('Model persistence: never overwrites user-saved model with stealth codenames (e.g. gpt-6-1-sol) on load or fallback', async () => {
  const stored = {};
  global.chrome = {
    storage: {
      local: {
        get: (_k, cb) => cb({
          provider: 'openai',
          apiKey: 'sk-test',
          model: 'gpt-5-mini',
          userSelectedModel: true
        }),
        set: (items) => Object.assign(stored, items)
      }
    }
  };

  // 1) Stealth codenames like gpt-6-1-sol or gpt-6.1-sol are filtered out of standard provider lists
  const ranked = background.analyzeAndRankModels('openai', [
    { id: 'gpt-6-1-astra' },
    { id: 'gpt-6.1-astra' },
    { id: 'gpt-5-mini' },
    { id: 'gpt-5' }
  ]);
  assert.ok(!ranked.models.includes('gpt-6-1-astra'), 'filters out stealth codename gpt-6-1-astra');
  assert.ok(!ranked.models.includes('gpt-6.1-astra'), 'filters out stealth codename gpt-6.1-astra');
  assert.equal(ranked.recommended, 'gpt-5-mini', 'recommends official model instead of stealth codename');

  delete global.chrome;
});

test('X (Twitter) Draft.js editor: inserts comment once via synthetic paste without double-insertion or DOM corruption', async () => {
  makeDom(`
    <article data-testid="tweet">
      <div data-testid="User-Name"><a href="/design_lead"><span>Design Lead</span></a></div>
      <div data-testid="tweetText"><span>Shipping fast is great until your UI feels like 5 different apps stitched together.</span></div>
      <div role="group">
        <button data-testid="reply" aria-label="Reply">Reply</button>
        <button data-testid="retweet" aria-label="Repost">Repost</button>
        <button data-testid="like" aria-label="Like">Like</button>
      </div>
      <div class="DraftEditor-root">
        <div data-testid="tweetTextarea_0" role="textbox" contenteditable="true" class="public-DraftEditor-content">
          <div data-contents="true"><div class="public-DraftStyleDefault-block"><span data-text="true"></span></div></div>
        </div>
      </div>
    </article>`);

  const xEditor = document.querySelector('[data-testid="tweetTextarea_0"]');
  pretendVisible(xEditor);
  assert.equal(content.isXDraftEditor(xEditor), true, 'recognizes X Draft.js editor');

  // Simulate Draft.js paste listener that handles ClipboardEvent('paste') and calls preventDefault()
  let pasteCount = 0;
  let pastedText = '';
  let execCommandCount = 0;
  domRef.window.document.execCommand = function (cmd) {
    if (cmd === 'insertText') execCommandCount++;
    return true;
  };
  global.DataTransfer = class DataTransfer {
    constructor() { this.store = {}; }
    setData(k, v) { this.store[k] = v; }
    getData(k) { return this.store[k] || ''; }
  };
  global.ClipboardEvent = class ClipboardEvent extends domRef.window.Event {
    constructor(type, opts) {
      super(type, opts);
      this.clipboardData = opts && opts.clipboardData;
    }
  };

  xEditor.addEventListener('paste', (e) => {
    pasteCount++;
    pastedText = e.clipboardData.getData('text/plain');
    e.preventDefault();
    xEditor.querySelector('[data-text="true"]').textContent = pastedText;
  });

  content.insertTextInto(xEditor, 'Cohesion is the first thing sacrificed on a tight deadline.');
  assert.equal(pasteCount, 1, 'dispatches exactly 1 paste event to Draft.js');
  assert.equal(execCommandCount, 0, 'does not run execCommand(insertText) or raw DOM mutation after Draft.js handles paste');
  assert.equal(xEditor.textContent.trim(), 'Cohesion is the first thing sacrificed on a tight deadline.');

  delete global.DataTransfer;
  delete global.ClipboardEvent;
});

test('Comment & Thought-Process History: extracts <think> reasoning, groups regenerations by post thread, and marks inserted/copied status', async () => {
  const store = {};
  global.chrome = {
    storage: {
      local: {
        get: (key, cb) => {
          if (typeof key === 'string') {
            cb({ [key]: store[key] });
          } else {
            cb(Object.assign({ provider: 'openai', apiKey: 'sk-test', model: 'gpt-5-mini' }, store));
          }
        },
        set: (items, cb) => {
          Object.assign(store, items);
          if (cb) cb();
        }
      }
    }
  };

  // 1) extractThoughtProcess pulls <think>...</think> and combines with native reasoning
  const rawWithThink = '<think>\n1. Post Core: Accessibility wins.\n2. Creative Direction: Warm practitioner cadence.\n3. Why It Works: Grounded in real metrics.\n</think>\nCutting bounce rate by 24% through keyboard nav alone is a huge UX win.';
  const extracted = background.extractThoughtProcess(rawWithThink, '', {
    text: 'We improved accessibility and bounce rate dropped 24%.',
    author: 'Sarah Chen',
    tone: 'Practitioner Take',
    seed: 'abcdef123456'
  });
  assert.match(extracted, /Post Core: Accessibility wins/);
  assert.match(extracted, /Why It Works: Grounded in real metrics/);
  assert.equal(
    background.cleanComment(rawWithThink),
    'Cutting bounce rate by 24% through keyboard nav alone is a huge UX win.'
  );

  // 2) Fallback thought process is guaranteed even if a model omits <think> tags
  const fallbackThought = background.extractThoughtProcess('Direct comment without think tags.', '', {
    text: 'Design systems fail when engineers are excluded.',
    author: 'Sarah Chen',
    tone: 'Thoughtful',
    seed: '998877665544'
  });
  assert.match(fallbackThought, /Sarah Chen/);
  assert.match(fallbackThought, /Thoughtful/);

  // 3) Multiple generations on the same post group into a single thread, and markHistoryAction marks inserted
  const firstSaved = await background.recordHistoryGeneration({
    text: 'Design systems fail when engineers are excluded.',
    author: 'Sarah Chen',
    postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:123/',
    platform: 'linkedin',
    tone: 'Engaging',
    channel: 'comment',
    seed: '111122223333',
    provider: 'openai',
    model: 'gpt-5-mini',
    comment: 'Draft 1: Co-ownership between design and engineering is everything.',
    thoughtProcess: 'Thought 1: Focus on co-ownership.'
  });
  const secondSaved = await background.recordHistoryGeneration({
    threadId: firstSaved.thread.threadId,
    text: 'Design systems fail when engineers are excluded.',
    author: 'Sarah Chen',
    postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:123/',
    platform: 'linkedin',
    tone: 'Practitioner Take',
    channel: 'comment',
    seed: '444455556666',
    provider: 'openai',
    model: 'gpt-5-mini',
    comment: 'Draft 2: If tokens in Figma do not match props in code, adoption dies in a month.',
    thoughtProcess: 'Thought 2: Contrast Figma tokens with code props.'
  });

  assert.equal(firstSaved.thread.threadId, secondSaved.thread.threadId, 'groups regenerations under same threadId');
  let threads = await background.getHistoryThreads();
  assert.equal(threads.length, 1);
  assert.equal(threads[0].entries.length, 2, 'stores both generated drafts in the post thread');

  await background.markHistoryAction({
    historyId: secondSaved.entry.id,
    threadId: secondSaved.thread.threadId,
    action: 'inserted',
    finalComment: 'Draft 2 (edited): If tokens in Figma do not match props in code, adoption dies.'
  });

  threads = await background.getHistoryThreads();
  assert.equal(threads[0].entries[1].status, 'inserted');
  assert.match(threads[0].entries[1].finalComment, /Draft 2 \(edited\)/);

  delete global.chrome;
});

test('Anti-thinking-leak protection: strips all reasoning formats (<think>, <thinking>, orphan </think>, Harmony, untagged bullets, <final>) and never inserts thinking into comment box', () => {
  // 1) Explicit <think> + <final> tags (strict prompt format)
  const strictOut = '<think>\n• Post Core: Design tokens & dev handoff.\n• Creative Direction: Practitioner take.\n• Why It Works: Concrete detail.\n</think>\n<final>\nTokens only work when the naming in Figma mirrors the props in code.\n</final>';
  assert.equal(
    background.cleanComment(strictOut),
    'Tokens only work when the naming in Figma mirrors the props in code.'
  );
  assert.match(background.extractThoughtProcess(strictOut, '', {}), /Post Core: Design tokens/);

  // 2) Orphan closing </think> without opening <think> (DeepSeek-R1 / Qwen3 chat template prefill)
  const orphanClose = '1) Post Core: AI agents in prod.\n2) Creative Direction: Skeptical peer.\n3) Why It Works: Names the real bottleneck.\n</think>\nMost agent demos look magical until they hit their first flaky API timeout in production.';
  assert.equal(
    background.cleanComment(orphanClose),
    'Most agent demos look magical until they hit their first flaky API timeout in production.'
  );
  assert.match(background.extractThoughtProcess(orphanClose, '', {}), /Post Core: AI agents in prod/);

  // 3) Alternate reasoning tags: <thinking>, <reasoning>, <thought_process>, <analysis>
  assert.equal(
    background.cleanComment('<thinking>Internal chain of thought here.</thinking>\nShipping the boring reliability work is what actually compounds.'),
    'Shipping the boring reliability work is what actually compounds.'
  );
  assert.equal(
    background.cleanComment('<reasoning>Step 1: analyze post</reasoning><final_comment>Real users care about latency, not model benchmarks.</final_comment>'),
    'Real users care about latency, not model benchmarks.'
  );

  // 4) OpenAI Harmony / GPT-OSS channel tokens
  const harmony = '<|channel|>analysis<|message|>The user wants a sharp comment about accessibility.<|end|><|start|>assistant<|channel|>final<|message|>Cutting bounce rate by 24% with keyboard navigation alone proves accessibility is core UX.';
  assert.equal(
    background.cleanComment(harmony),
    'Cutting bounce rate by 24% with keyboard navigation alone proves accessibility is core UX.'
  );
  assert.match(background.extractThoughtProcess(harmony, '', {}), /sharp comment about accessibility/);

  // 5) Untagged 3-bullet thought process followed by the actual comment (model omitted <think> tags)
  const untaggedBullets = [
    '- Post Core: Why design systems stall after launch.',
    '- Creative Direction: Direct practitioner voice with a concrete observation.',
    '- Why It Works: Adds a real operational insight without clichés.',
    '',
    'Adoption usually stalls the moment engineers have to guess which token maps to which component prop.'
  ].join('\n');
  assert.equal(
    background.cleanComment(untaggedBullets),
    'Adoption usually stalls the moment engineers have to guess which token maps to which component prop.'
  );
  assert.match(background.extractThoughtProcess(untaggedBullets, '', {}), /Post Core: Why design systems stall/);

  // 6) Untagged reasoning with "Final comment:" delimiter
  const untaggedWithFinalLabel = [
    'Thought Process:',
    '1. Post Core: Remote onboarding.',
    '2. Creative Direction: Warm and practical.',
    '3. Why It Works: Specific ritual.',
    'Final comment: Pairing new hires on a tiny day-one bug fix beats any 40-page onboarding doc.'
  ].join('\n');
  assert.equal(
    background.cleanComment(untaggedWithFinalLabel),
    'Pairing new hires on a tiny day-one bug fix beats any 40-page onboarding doc.'
  );

  // 7) Unclosed <think> with only reasoning returns empty so retry triggers (never leaks raw thinking)
  const unclosedOnlyThinking = '<think>\nOkay, let me think about how to respond to this post. First, the author is talking about microservices';
  assert.equal(background.cleanComment(unclosedOnlyThinking), '');

  // 8) looksLikeReasoningLeak catches raw internal monologue that had no tags at all
  assert.equal(
    background.looksLikeReasoningLeak('Okay, so the user wants me to write a LinkedIn comment using the entropy seed abcdef123456.'),
    true
  );
  assert.equal(
    background.looksLikeReasoningLeak('Pairing new hires on a tiny day-one bug fix beats any 40-page onboarding doc.'),
    false
  );

  // 9) Client-side content.sanitizeFinalOutputText strips any stray <think> or <final> wrapper before insertion
  assert.equal(
    content.sanitizeFinalOutputText('<think>hidden thought</think><final>Clean comment ready to insert.</final>'),
    'Clean comment ready to insert.'
  );
  assert.equal(
    content.sanitizeFinalOutputText('internal reasoning before orphan tag</think>\nClean comment after orphan tag.'),
    'Clean comment after orphan tag.'
  );
});

test('generateComment: automatically retries with strict final-only prompt when first response only contains thinking or leaked reasoning', async () => {
  const fetchCalls = [];
  global.fetch = async function (url, opts) {
    const body = JSON.parse(opts.body);
    fetchCalls.push(body);
    if (fetchCalls.length === 1) {
      // Simulate model spending its first turn outputting only an unclosed <think> block
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: '<think>\n• Post Core: Shipping velocity vs quality.\n• Creative Direction: Concise practitioner take.\n• Why It Works: Grounded in real tradeoffs.'
            }
          }]
        })
      };
    }
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: '<final>Fast shipping only compounds when the team deletes dead code at the same pace.</final>'
          }
        }]
      })
    };
  };

  const storage = {
    provider: 'openai',
    apiKey: 'sk-test',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5-mini',
    userSelectedModel: true,
    commentHistory: []
  };
  global.chrome = {
    storage: {
      sync: { get: (defaults, cb) => cb(Object.assign({}, defaults, storage)), set: (obj, cb) => { if (cb) cb(); } },
      local: { get: (key, cb) => cb({ commentHistory: storage.commentHistory }), set: (obj, cb) => { storage.commentHistory = obj.commentHistory; if (cb) cb(); } }
    },
    runtime: { getURL: (p) => 'chrome-extension://test/' + p }
  };

  const resp = await new Promise((resolve) => {
    background.onMessage({
      type: 'generateComment',
      requestId: 'retry-test-1',
      payload: {
        text: 'How do you balance shipping velocity with long-term code quality?',
        author: 'Alex Rivera',
        tone: 'Practitioner Take',
        channel: 'comment'
      }
    }, null, resolve);
  });

  assert.equal(resp.ok, true);
  assert.equal(
    resp.comment,
    'Fast shipping only compounds when the team deletes dead code at the same pace.',
    'inserts only the clean final comment from the retry'
  );
  assert.match(
    resp.thoughtProcess,
    /Post Core: Shipping velocity vs quality/,
    'preserves the thought process from the first turn for the Why-this-comment panel'
  );
  assert.equal(fetchCalls.length, 2, 'performed automatic strict retry after thinking-only response');

  delete global.fetch;
  delete global.chrome;
});



