/*
 * LinkedIn Comment Assistant — content script
 *
 * Responsibilities:
 *  - Grammarly-style experience: when the user focuses or types in ANY LinkedIn comment
 *    editor (contenteditable, Quill, lexical, role="textbox", textarea), float a sleek
 *    Apple-inspired AI badge inside the right edge of the editor for one-click generation,
 *    with a quick-dismiss button and an option to auto-hide while typing.
 *  - Detect LinkedIn feed posts (direct SPA, infinite scrolling, SDUI/obfuscated DOMs,
 *    modals, and single-post pages) and inject a single "✨ AI" button into each post's
 *    social action bar (never duplicating inside the comment submit row).
 *  - Extract the post text and author name robustly across all LinkedIn DOM variants.
 *  - Provide an Apple-inspired frosted-glass composer panel: generate / regenerate / edit /
 *    tone pills / copy / insert.
 *  - Insert the final text into LinkedIn's real comment editor so the user retains full
 *    control before posting.
 */
(function () {
  'use strict';

  /* Global shortcuts (resolved at call time so the Node test harness can inject jsdom). */
  var PANEL_ID = 'liai-panel';
  var TOAST_ID = 'liai-toast';
  var WIDGET_ID = 'liai-grammarly-widget';

  var POST_SELECTORS = [
    'div.feed-shared-update-v2',
    'div.occludable-update',
    'article.update-components-article',
    'div[data-urn^="urn:li:activity"]',
    'div[data-urn^="urn:li:ugcPost"]',
    'div[data-urn^="urn:li:share"]',
    'div[data-urn^="urn:li:aggregate"]',
    'div[data-urn^="urn:li:Aggregate"]',
    'div[data-id^="urn:li:activity"]',
    'div[data-id^="urn:li:ugcPost"]',
    'div[data-id^="urn:li:share"]',
    'div[data-view-name="feed-full-update"]',
    'div[data-view-name="feed-update"]',
    'div[componentkey*="feed"]',
    'article[data-urn]',
    'article'
  ].join(', ');

  var ACTION_BAR_SELECTORS = [
    '.feed-shared-social-action-bar',
    '.feed-shared-social-actions-bar',
    'div[class*="feed-shared-social-action-bar"]',
    'div[class*="social-actions-bar"]',
    'div[class*="social-action-bar"]',
    'div[data-testid="social-actions-bar"]',
    'div[data-view-name="feed-action-bar"]'
  ].join(', ');

  var COMMENT_SECTION_SELECTORS = [
    '.comments-comment-box',
    '.comments-comment-box__form',
    '.comments-comment-texteditor',
    '.comments-comment-box-comment__text-editor',
    '.comments-container',
    '.feed-shared-update-v2__comments-container',
    '.comments-comment-item',
    '.comments-reply-item',
    '.comments-comments-list',
    '[class*="comments-comment-box"]',
    '[class*="comment-texteditor"]'
  ].join(', ');

  var EDITOR_SELECTORS = [
    'div.ql-editor[contenteditable="true"]',
    'div.ql-editor[contenteditable=""]',
    'div.ql-editor[contenteditable]',
    'div.comments-comment-texteditor__contenteditable[contenteditable]',
    'div.comments-comment-box-comment__text-editor div[contenteditable]',
    'div.comments-comment-box div[contenteditable="true"]',
    'div.comments-comment-texteditor div[contenteditable="true"]',
    'div[data-test-ql-editor-contenteditable="true"]',
    'div.share-creation-state__text-editor div[contenteditable="true"]',
    'div.share-creation-state__text-editor div[contenteditable]',
    'div.share-box div[contenteditable="true"]',
    'div.share-box div[contenteditable]',
    'div[class*="share-creation-state"] div[contenteditable="true"]',
    'div[class*="share-creation-state"] div[contenteditable]',
    'div[role="dialog"] div[contenteditable="true"]',
    'div[role="dialog"] div[contenteditable=""]',
    'div[role="dialog"] div[role="textbox"][contenteditable]',
    'div[role="textbox"][contenteditable="true"]',
    'div[role="textbox"][contenteditable=""]',
    'div[role="textbox"][contenteditable]',
    'div[aria-label*="Comment" i][contenteditable]',
    'div[aria-label*="comment" i][contenteditable]',
    'div[aria-label*="talk about" i][contenteditable]',
    'div[aria-label*="share your thoughts" i][contenteditable]',
    'div[aria-label*="start a post" i][contenteditable]',
    'div[aria-label*="write a post" i][contenteditable]',
    'div[aria-label*="text editor" i][contenteditable]',
    'div[data-testid^="tweetTextarea_"][contenteditable="true"]',
    'div[data-testid^="tweetTextarea_"][role="textbox"]',
    'div[data-placeholder][contenteditable="true"]',
    'textarea[placeholder*="comment" i]',
    'textarea[aria-label*="comment" i]',
    'textarea[placeholder*="talk about" i]',
    'textarea[aria-label*="talk about" i]'
  ].join(', ');

  var POST_COMPOSER_CONTAINER_SELECTORS = [
    '.share-box',
    '.share-creation-state',
    '.share-creation-state__text-editor',
    '.share-box-v2__modal',
    '.share-box-feed-entry__closed-share-box',
    '[class*="share-creation-state"]',
    '[class*="share-box"]',
    '[data-test-modal-id*="share"]',
    '[data-testid="toolBar"]'
  ].join(', ');

  var PANEL_WIDTH = 420;

  var processed = new WeakSet();
  var dismissedEditors = new WeakSet();
  var activePanel = null;
  var scanTimer = null;
  var openPanelInfo = null; // { post, editor, cleanup }
  var genCounter = 0;       // monotonic id so stale AI responses never win
  var activeGenId = null;   // requestId of currently running generation (or null)
  var activeGenUi = null;   // panel UI object for currently running generation

  // Grammarly-style floating widget state
  var activeEditor = null;
  var activeEditorPost = null;
  var floatingWidget = null;
  var widgetRaf = null;
  var isUserTyping = false;
  var typingIdleTimer = null;

  // Cached user preferences for in-page UI behavior
  var uiPrefs = {
    hideFloatingWidget: false,
    hideWhileTyping: false,
    hidePostActionButton: false
  };

  var TONES = [
    'Engaging',
    'Thoughtful',
    'Humor / Witty',
    'Out-of-the-Box / Fresh Angle',
    'Curious / Smart Question',
    'Polite Counterpoint',
    'Friendly / Supportive',
    'Practitioner Take',
    'Professional'
  ];

  var CHANNELS = [
    { value: 'comment', label: 'Comment' },
    { value: 'linkedin_post', label: 'LI Post' },
    { value: 'linkedin_long', label: 'LI Long Post (500+ words)' },
    { value: 'x_post', label: 'X Post' }
  ];

  var SPARKLE_SVG =
    '<svg class="liai-sparkle-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M8 1L9.65 5.65L14.3 7.3L9.65 8.95L8 13.6L6.35 8.95L1.7 7.3L6.35 5.65L8 1Z" fill="currentColor"/>' +
    '<path d="M13 10.5L13.6 12.2L15.3 12.8L13.6 13.4L13 15.1L12.4 13.4L10.7 12.8L12.4 12.2L13 10.5Z" fill="currentColor" opacity="0.8"/>' +
    '</svg>';

  /* ---------------- tiny utilities ---------------- */

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function normalizeWhitespace(s) {
    return String(s == null ? '' : s)
      .replace(/\u00a0/g, ' ')
      .replace(/[\u200b\u200c\ufeff]/g, '')
      .replace(/[ \t\r\n\f]+/g, ' ')
      .trim();
  }

  function hasClass(el, c) {
    return el && typeof el.classList !== 'undefined' && el.classList.contains(c);
  }

  function safeQueryAll(root, selector) {
    if (!root || !root.querySelectorAll) return [];
    try {
      return root.querySelectorAll(selector);
    } catch (e) {
      return [];
    }
  }

  function getDeepActiveElement() {
    if (typeof document === 'undefined' || !document) return null;
    var a = document.activeElement;
    var depth = 0;
    while (a && a.shadowRoot && a.shadowRoot.activeElement && depth < 10) {
      a = a.shadowRoot.activeElement;
      depth++;
    }
    return a;
  }

  function safeQueryAllDeep(root, selector) {
    if (!root) return [];
    var out = [];
    var seen = typeof Set !== 'undefined' ? new Set() : null;
    function collectFrom(node, depth) {
      if (!node || depth > 6) return;
      if (node.querySelectorAll) {
        try {
          var list = node.querySelectorAll(selector);
          for (var i = 0; i < list.length; i++) {
            var item = list[i];
            if (seen) {
              if (!seen.has(item)) { seen.add(item); out.push(item); }
            } else if (out.indexOf(item) === -1) {
              out.push(item);
            }
          }
        } catch (e) { /* ignore */ }
      }
      // Also traverse open shadow roots (e.g. #interop-outlet on LinkedIn)
      if (node.querySelectorAll) {
        try {
          var hosts = node.querySelectorAll('#interop-outlet, [data-testid*="interop"], *');
          for (var j = 0; j < hosts.length; j++) {
            if (hosts[j] && hosts[j].shadowRoot) {
              collectFrom(hosts[j].shadowRoot, depth + 1);
            }
          }
        } catch (e2) { /* ignore */ }
      }
    }
    collectFrom(root, 0);
    return out;
  }

  function safeClosest(el, selector) {
    var cur = el;
    var depth = 0;
    while (cur && depth < 10) {
      if (cur.closest) {
        try {
          var found = cur.closest(selector);
          if (found) return found;
        } catch (e) { /* ignore */ }
      }
      var root = cur.getRootNode ? cur.getRootNode() : null;
      if (root && root.host) {
        cur = root.host;
        depth++;
      } else {
        break;
      }
    }
    return null;
  }

  function isNodeInDocument(node) {
    if (!node || typeof document === 'undefined' || !document) return false;
    if (document.body && document.body.contains && document.body.contains(node)) return true;
    var cur = node;
    var depth = 0;
    while (cur && depth < 10) {
      var root = cur.getRootNode ? cur.getRootNode() : null;
      if (!root) break;
      if (root === document) return true;
      if (root.host) {
        cur = root.host;
        depth++;
      } else {
        break;
      }
    }
    return false;
  }

  function syncUiPrefsFromItems(items) {
    if (!items || typeof items !== 'object') return;
    uiPrefs.hideFloatingWidget = Boolean(items.hideFloatingWidget);
    uiPrefs.hideWhileTyping = Boolean(items.hideWhileTyping);
    uiPrefs.hidePostActionButton = Boolean(items.hidePostActionButton);
  }

  function refreshUiPrefs() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      try {
        chrome.storage.local.get(null, function (items) {
          syncUiPrefsFromItems(items || {});
          applyUiPrefsNow();
        });
      } catch (e) { /* ignore */ }
    }
  }

  function isNodeInDocument(node) {
    if (!node || typeof document === 'undefined' || !document) return false;
    if (typeof node.isConnected === 'boolean') return node.isConnected;
    if (document.body && document.body.contains(node)) return true;
    var root = node.getRootNode ? node.getRootNode() : null;
    while (root && root.host) {
      if (document.body && document.body.contains(root.host)) return true;
      root = root.host.getRootNode ? root.host.getRootNode() : null;
    }
    return false;
  }

  function applyUiPrefsNow() {
    if (typeof document === 'undefined' || !document) return;
    if (uiPrefs.hideFloatingWidget) {
      hideGrammarlyWidget();
    } else if (activeEditor && isNodeInDocument(activeEditor)) {
      updateGrammarlyWidgetPosition();
    }
    var postBtns = safeQueryAllDeep(document, 'button[data-liai-button]');
    for (var i = 0; i < postBtns.length; i++) {
      postBtns[i].style.display = uiPrefs.hidePostActionButton ? 'none' : '';
    }
  }

  function getSettings() {
    return new Promise(function (resolve) {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(null, function (items) {
          var out = items || {};
          syncUiPrefsFromItems(out);
          resolve(out);
        });
      } else {
        resolve({});
      }
    });
  }

  function sendMessage(message) {
    return new Promise(function (resolve) {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        resolve({ ok: false, error: 'Extension context unavailable. Reload the LinkedIn page.' });
        return;
      }
      try {
        chrome.runtime.sendMessage(message, function (response) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message || 'Could not reach the extension background page.' });
            return;
          }
          resolve(response && typeof response === 'object' ? response : { ok: false, error: 'No response from the extension.' });
        });
      } catch (e) {
        resolve({ ok: false, error: 'Extension context invalidated. Reload the LinkedIn page.' });
      }
    });
  }

  /* ---------------- post & action-bar discovery ---------------- */

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(function () {
      scanTimer = null;
      scanForPosts();
    }, 200);
  }

  function isInsideCommentSection(el) {
    if (!el) return false;
    if (safeClosest(el, COMMENT_SECTION_SELECTORS)) return true;
    // Structural check for SDUI / obfuscated DOMs: if a container holds a contenteditable
    // textbox AND is relatively small (just the comment box form, not the whole post),
    // treat it as a comment box so we never mistake the "Comment" submit pill for the
    // post's main social action bar.
    var p = el.parentElement;
    var steps = 0;
    while (p && p !== document.body && steps < 5) {
      if (p.tagName === 'FORM') return true;
      var hasEditor = p.querySelector && p.querySelector('[contenteditable="true"], [contenteditable=""], textarea');
      if (hasEditor) {
        var hasMainActor = p.querySelector && p.querySelector(
          '.update-components-actor, .feed-shared-actor, [data-view-name="feed-actor-name"], [data-view-name="feed-commentary"], .feed-shared-inline-show-more-text, .update-components-text'
        );
        if (!hasMainActor) return true;
      }
      p = p.parentElement;
      steps++;
    }
    return false;
  }

  function cleanupDuplicatePostButtons(postRoot) {
    if (!postRoot || !postRoot.querySelectorAll) return;
    var existing = postRoot.querySelectorAll('button[data-liai-button]');
    // Remove any button that accidentally ended up inside a comment box / submit row
    for (var i = 0; i < existing.length; i++) {
      if (isInsideCommentSection(existing[i])) {
        existing[i].remove();
      }
    }
    var remaining = postRoot.querySelectorAll('button[data-liai-button]');
    for (var j = 1; j < remaining.length; j++) {
      remaining[j].remove();
    }
  }

  function scanForPosts() {
    if (typeof document === 'undefined' || !document) return { postsFound: 0, buttonsInjected: 0, editorsFound: 0 };
    var injectedCount = 0;

    // 1) Standard post containers
    var roots = safeQueryAll(document, POST_SELECTORS);
    for (var i = 0; i < roots.length; i++) {
      var post = roots[i];
      if (isInsideCommentSection(post)) continue;
      if (processed.has(post)) {
        cleanupDuplicatePostButtons(post);
        continue;
      }
      if (isInsideProcessed(post)) continue;
      if (injectButton(post)) {
        processed.add(post);
        injectedCount++;
      }
    }

    // 2) Action-bar selectors (SDUI / obfuscated post wrappers)
    var bars = safeQueryAll(document, ACTION_BAR_SELECTORS);
    for (var j = 0; j < bars.length; j++) {
      var bar = bars[j];
      if (isInsideCommentSection(bar)) continue;
      if (bar.querySelector('[data-liai-button]')) continue;
      if (isInsideProcessed(bar)) continue;
      var enclosing = findEnclosingPost(bar);
      if (enclosing && !processed.has(enclosing) && !enclosing.querySelector('[data-liai-button]')) {
        if (injectButton(enclosing)) {
          processed.add(enclosing);
          injectedCount++;
        }
      }
    }

    // 3) Universal button heuristic: scan every native "Comment" action button on the page
    // even when LinkedIn completely obfuscates both post wrapper and action bar classes.
    var allButtons = safeQueryAll(document, 'button, [role="button"]');
    for (var k = 0; k < allButtons.length; k++) {
      var btn = allButtons[k];
      if (!isCommentTriggerButton(btn)) continue;
      var postRoot = findEnclosingPost(btn);
      if (!postRoot) continue;
      if (processed.has(postRoot) || isInsideProcessed(postRoot)) continue;
      if (postRoot.querySelector && postRoot.querySelector('[data-liai-button]')) {
        processed.add(postRoot);
        continue;
      }
      if (injectButton(postRoot)) {
        processed.add(postRoot);
        injectedCount++;
      }
    }

    // 4) Check if any comment or post editor is currently visible on screen and attach
    // the Grammarly-like floating AI widget if allowed.
    injectPostComposerTriggers();
    var openPostEditor = findPostComposerEditor();
    var visibleEditors = findVisibleCommentEditors();
    if (!uiPrefs.hideFloatingWidget) {
      if (openPostEditor && isElementVisible(openPostEditor) && activeEditor !== openPostEditor && !dismissedEditors.has(openPostEditor)) {
        attachGrammarlyWidget(openPostEditor, null);
      } else if (visibleEditors.length > 0 && (!activeEditor || !isNodeInDocument(activeEditor) || !isElementVisible(activeEditor))) {
        if (!dismissedEditors.has(visibleEditors[0])) {
          attachGrammarlyWidget(visibleEditors[0]);
        }
      } else if (activeEditor && isNodeInDocument(activeEditor)) {
        updateGrammarlyWidgetPosition();
      }
    } else {
      hideGrammarlyWidget();
    }

    var totalButtons = document.querySelectorAll('[data-liai-button]').length;
    return {
      postsFound: totalButtons,
      buttonsInjected: injectedCount,
      editorsFound: visibleEditors.length
    };
  }

  function findEnclosingPost(node) {
    if (!node) return null;
    // Walk up past any comment box / comment list first so we always resolve to the
    // outer feed post container, never an inner comment wrapper.
    var start = node;
    var commentWrap = safeClosest(node, COMMENT_SECTION_SELECTORS);
    if (commentWrap && commentWrap.parentElement) {
      start = commentWrap.parentElement;
    }

    var matched = safeClosest(start, POST_SELECTORS);
    if (matched) return matched;
    var p = start.parentElement || node.parentElement;
    var depth = 0;
    var bestCandidate = null;
    while (p && p !== document.body && p !== document.documentElement && depth < 14) {
      if (
        p.hasAttribute('data-urn') ||
        p.hasAttribute('data-id') ||
        p.hasAttribute('componentkey') ||
        p.tagName === 'ARTICLE' ||
        (p.getAttribute('role') === 'article') ||
        (p.getAttribute('role') === 'region') ||
        p.querySelector('.update-components-actor, .feed-shared-actor, .update-components-text, .feed-shared-inline-show-more-text, [data-view-name="feed-commentary"], [data-testid="expandable-text-box"]')
      ) {
        return p;
      }
      // Heuristic: a container that holds both a profile link (/in/ or /company/) and multiple paragraphs/spans of text
      if (!bestCandidate && depth >= 2 && p.querySelector && p.querySelector('a[href*="/in/"], a[href*="/company/"]')) {
        var textLen = (p.textContent || '').trim().length;
        if (textLen > 60 && textLen < 12000) {
          bestCandidate = p;
        }
      }
      p = p.parentElement;
      depth++;
    }
    return bestCandidate || start.parentElement || node.parentElement;
  }

  function isInsideProcessed(node) {
    var p = node.parentElement;
    while (p && p !== document.body) {
      if (processed.has(p)) return true;
      p = p.parentElement;
    }
    return false;
  }

  function isLikeOrRepostOrSendButton(btn) {
    if (!btn || !btn.getAttribute || btn.hasAttribute('data-liai-button')) return false;
    var testId = (btn.getAttribute('data-testid') || '').trim();
    if (/^(like|unlike|retweet|unretweet|bookmark|removeBookmark)$/i.test(testId)) return true;
    var label = (btn.getAttribute('aria-label') || '').trim();
    var text = normalizeWhitespace(btn.textContent || '');
    if (/\b(like|react|repost|retweet|share|send)\b/i.test(label)) return true;
    if (/^(like|repost|retweet|share|send)$/i.test(text)) return true;
    return false;
  }

  function hasSocialActionSiblings(btn) {
    if (!btn || !btn.parentElement) return false;
    var p = btn.parentElement;
    var steps = 0;
    while (p && p !== document.body && steps < 4) {
      var btns = p.querySelectorAll('button:not([data-liai-button]), [role="button"]:not([data-liai-button])');
      for (var i = 0; i < btns.length; i++) {
        if (btns[i] !== btn && isLikeOrRepostOrSendButton(btns[i])) {
          return true;
        }
      }
      p = p.parentElement;
      steps++;
    }
    return false;
  }

  function isCommentTriggerButton(btn) {
    if (!btn || !btn.getAttribute || btn.hasAttribute('data-liai-button')) return false;
    if (btn.closest && btn.closest('#' + PANEL_ID + ', #' + WIDGET_ID)) return false;

    // Never match the blue "Comment" submit button inside an open comment box
    if (isInsideCommentSection(btn)) {
      return false;
    }

    var rawType = (btn.getAttribute('type') || '').toLowerCase();
    var cls = String(btn.className || '');
    if (
      rawType === 'submit' ||
      hasClass(btn, 'comments-comment-box__submit-button') ||
      /submit-button|comment-box__submit|artdeco-button--primary/i.test(cls)
    ) {
      return false;
    }

    var label = (btn.getAttribute('aria-label') || '').trim();
    var controlName = (btn.getAttribute('data-control-name') || '').trim();
    var testId = (btn.getAttribute('data-testid') || '').trim();
    var text = normalizeWhitespace(btn.textContent || '');

    if (/^(tweetButton|tweetButtonInline)$/i.test(testId)) {
      return false;
    }

    var matchesLabel = (
      (/^(comment|leave a comment|add a comment|comment on\b|reply\b)/i.test(label) || /\bcomment\b/i.test(label)) &&
      !/like|repost|retweet|share|send|more|filter|sort|delete|edit|post\s+comment|submit/i.test(label)
    );
    var matchesControl = /^comment$/i.test(controlName) || hasClass(btn, 'comment-button') || /^reply$/i.test(testId);
    var matchesText = /^comment$/i.test(text);

    if (!matchesLabel && !matchesControl && !matchesText) {
      return false;
    }

    // Crucial guard against the comment box's "Comment" submit button in obfuscated/SDUI DOMs:
    // A real post-level Comment trigger button always shares a social action bar with Like / Repost / Send.
    // A comment-box submit button sits next to Emoji / GIF / Image buttons and has no Like/Repost sibling.
    if (!hasSocialActionSiblings(btn) && !safeClosest(btn, ACTION_BAR_SELECTORS)) {
      return false;
    }

    return true;
  }

  function findActionBar(post) {
    if (!post || !post.querySelector) return null;
    var bars = post.querySelectorAll(ACTION_BAR_SELECTORS);
    for (var bIdx = 0; bIdx < bars.length; bIdx++) {
      if (!isInsideCommentSection(bars[bIdx])) {
        return bars[bIdx];
      }
    }

    // Structural fallback when LinkedIn obfuscates class names: locate the native
    // Comment button alongside a Like/React/Repost button and return their shared bar.
    var buttons = post.querySelectorAll('button, [role="button"]');
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      if (!isCommentTriggerButton(b)) continue;
      var p = b.parentElement;
      var steps = 0;
      while (p && p !== post && steps < 5) {
        var siblingBtns = p.querySelectorAll('button:not([data-liai-button]), [role="button"]:not([data-liai-button])');
        var hasSocial = false;
        for (var s = 0; s < siblingBtns.length; s++) {
          if (siblingBtns[s] !== b && isLikeOrRepostOrSendButton(siblingBtns[s])) {
            hasSocial = true;
            break;
          }
        }
        if (hasSocial && siblingBtns.length >= 2 && siblingBtns.length <= 10) {
          return p;
        }
        p = p.parentElement;
        steps++;
      }
      if (b.parentElement && !isInsideCommentSection(b.parentElement)) return b.parentElement;
    }
    return null;
  }

  function injectButton(post) {
    if (!post || !post.querySelector) return false;
    // Never inject more than 1 button inside the same post container
    cleanupDuplicatePostButtons(post);
    var existingInPost = post.querySelector('button[data-liai-button]');
    if (existingInPost) {
      existingInPost.style.display = uiPrefs.hidePostActionButton ? 'none' : '';
      return true;
    }

    var bar = findActionBar(post);
    if (!bar || isInsideCommentSection(bar)) return false;
    if (bar.querySelector('[data-liai-button]')) return true;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'liai-comment-button';
    btn.dataset.liaiButton = 'true';
    btn.setAttribute('aria-label', 'Write an AI comment');
    btn.title = 'Draft personalized comment with AI';
    btn.innerHTML = SPARKLE_SVG + '<span class="liai-button-label">AI</span>';
    if (uiPrefs.hidePostActionButton) {
      btn.style.display = 'none';
    }

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openPanel({ post: post, anchor: btn });
    });
    btn.addEventListener('mousedown', function (e) { e.stopPropagation(); });

    bar.appendChild(btn);
    return true;
  }

  /* ---------------- Grammarly-like comment & post editor detection ---------------- */

  function isPostComposerEditor(el) {
    if (!el || !el.getAttribute) return false;
    var ariaLabel = (el.getAttribute('aria-label') || '');
    var placeholder = (
      el.getAttribute('data-placeholder') ||
      el.getAttribute('aria-placeholder') ||
      el.getAttribute('placeholder') ||
      ''
    );
    var postHintRe = /what do you want to talk about|share your thoughts|write a post|start a post|what['’]?s happening|post your thoughts|creating content/i;
    if (postHintRe.test(ariaLabel + ' ' + placeholder)) {
      return true;
    }
    // Explicit comment boxes are never post composers (selector-based only; the structural
    // heuristic in isInsideCommentSection misfires on the new SDUI composer).
    if (safeClosest(el, COMMENT_SECTION_SELECTORS)) return false;
    // Dedicated composer page (linkedin.com/sharing/compose) or the new SDUI share modal.
    var path = (typeof location !== 'undefined' && location.pathname) ? location.pathname : '';
    if (/^\/sharing\//i.test(path) || /\/compose/i.test(path) && /linkedin\.com$/i.test(location.hostname)) {
      return true;
    }
    // Placeholder rendered as a sibling element (Lexical/SDUI editors)
    var wrap = el.parentElement;
    for (var w = 0; wrap && w < 3; w++, wrap = wrap.parentElement) {
      var wrapText = normalizeWhitespace(wrap.textContent || '').slice(0, 200);
      if (wrapText.length < 120 && postHintRe.test(wrapText)) return true;
    }
    var shareContainer = safeClosest(
      el,
      '.share-box, .share-creation-state, .share-creation-state__text-editor, .share-box-v2__modal, [class*="share-creation-state"], [class*="share-box"], [data-test-modal-id*="share"], #interop-outlet'
    );
    if (shareContainer && !isInsideCommentSection(el)) return true;
    var dialog = safeClosest(el, 'div[role="dialog"], .artdeco-modal');
    if (dialog && !isInsideCommentSection(el)) {
      var dialogText = (dialog.getAttribute('aria-label') || '') + ' ' + (dialog.className || '');
      if (/share|post|create/i.test(dialogText)) return true;
      var hasPostSubmit = dialog.querySelector && dialog.querySelector(
        'button.share-actions__primary-action, [class*="share-actions"], button[data-testid="tweetButton"]'
      );
      if (hasPostSubmit && !dialog.querySelector('[data-testid="tweet"]')) return true;
      // Any contenteditable inside a LinkedIn modal dialog that is not a messaging overlay or comment box
      if (!safeClosest(el, '.msg-Overlay, .msg-convo-wrapper, .msg-form')) return true;
    }
    return false;
  }

  function isStartPostTriggerButton(btn) {
    if (!btn || !btn.getAttribute || btn.hasAttribute('data-liai-button')) return false;
    if (safeClosest(btn, '#' + PANEL_ID + ', #' + WIDGET_ID)) return false;
    if (isInsideCommentSection(btn)) return false;
    var cls = String(btn.className || '');
    var aria = normalizeWhitespace(btn.getAttribute('aria-label') || '');
    var text = normalizeWhitespace(btn.textContent || '');
    var placeholder = normalizeWhitespace(btn.getAttribute('placeholder') || btn.getAttribute('data-placeholder') || '');
    if (
      /share-box-feed-entry__trigger|share-box__open/i.test(cls) ||
      /\b(start a post|write a post|create a post)\b/i.test(text) ||
      /\b(start a post|write a post|create a post)\b/i.test(aria) ||
      /what do you want to talk about/i.test(text + ' ' + aria + ' ' + placeholder)
    ) {
      return true;
    }
    if (safeClosest(btn, '.share-box-feed-entry__closed-share-box, .share-box-feed-entry, .share-box') && /start a post/i.test(text + ' ' + aria)) {
      return true;
    }
    return false;
  }

  function findPostComposerEditor() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return null;
    // Check deep activeElement first (handles focus inside #interop-outlet shadowRoot)
    var deepActive = getDeepActiveElement();
    if (deepActive && isPostComposerEditor(deepActive) && isElementVisible(deepActive)) {
      return deepActive;
    }
    var candidates = safeQueryAllDeep(document, EDITOR_SELECTORS);
    for (var i = 0; i < candidates.length; i++) {
      var ed = candidates[i];
      if (ed.getAttribute('contenteditable') === 'false') continue;
      if (isPostComposerEditor(ed) && isElementVisible(ed)) return ed;
    }
    // Broad fallback inside any open dialog/modal on LinkedIn (including inside open shadow DOMs)
    var dialogs = safeQueryAllDeep(document, 'div[role="dialog"], .artdeco-modal, .share-box, .share-creation-state');
    for (var d = 0; d < dialogs.length; d++) {
      var dlg = dialogs[d];
      if (!isElementVisible(dlg)) continue;
      var editables = safeQueryAllDeep(dlg, '[contenteditable="true"], [contenteditable=""], div[role="textbox"][contenteditable], .ql-editor, textarea');
      for (var eIdx = 0; eIdx < editables.length; eIdx++) {
        var el = editables[eIdx];
        if (safeClosest(el, '#' + PANEL_ID + ', #' + WIDGET_ID)) continue;
        if (isElementVisible(el)) return el;
      }
    }
    return null;
  }

  function waitForPostComposerEditor(timeoutMs) {
    var t0 = Date.now();
    return new Promise(function (resolve) {
      (function tick() {
        if (Date.now() - t0 >= (timeoutMs || 4000)) { resolve(null); return; }
        var ed = findPostComposerEditor();
        if (ed) { resolve(ed); return; }
        setTimeout(tick, 100);
      })();
    });
  }

  var INLINE_BUTTON_STYLE =
    'display:inline-flex;align-items:center;justify-content:center;gap:5px;flex-shrink:0;' +
    'margin:0 4px;padding:0 11px;height:32px;min-height:32px;border:1px solid rgba(0,113,227,0.28);' +
    'border-radius:999px;background:linear-gradient(180deg,#ffffff 0%,#f0f6ff 100%);color:#0071e3;' +
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:12.5px;' +
    'font-weight:600;line-height:1;cursor:pointer;user-select:none;box-shadow:0 1px 2px rgba(0,0,0,0.05);';

  function injectPostComposerTriggers() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    // 1) Inject an ✨ AI Post button into the open LinkedIn share modal action bar (next to Post / media icons)
    var modalBars = safeQueryAllDeep(
      document,
      '.share-creation-state__footer, .share-box_actions, .share-actions, [class*="share-creation-state__footer"], [class*="share-creation-state__bottom"], [class*="share-creation-state__schedule-and-post"]'
    );
    for (var i = 0; i < modalBars.length; i++) {
      var bar = modalBars[i];
      if (bar.querySelector('[data-liai-post-composer-btn]')) continue;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'liai-comment-button liai-post-composer-button';
      btn.style.cssText = INLINE_BUTTON_STYLE;
      btn.dataset.liaiButton = 'true';
      btn.dataset.liaiPostComposerBtn = 'true';
      btn.setAttribute('aria-label', 'Write a LinkedIn post with AI');
      btn.title = 'Draft a LinkedIn post with AI';
      btn.innerHTML = SPARKLE_SVG + '<span class="liai-button-label">AI Post</span>';
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var ed = findPostComposerEditor();
        openPanel({
          post: null,
          editor: ed,
          anchor: e.currentTarget || ed || document.body,
          channel: 'linkedin_post'
        });
      });
      btn.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      bar.insertBefore(btn, bar.firstChild);
    }

    // 2) Also inject an ✨ AI Post button into the top-of-feed "Start a post" box action bar (next to Media / Event / Write article)
    var feedEntryBars = safeQueryAllDeep(
      document,
      '.share-box-feed-entry__bottom-bar, .share-box-feed-entry__closed-share-box, .share-box-feed-entry'
    );
    for (var f = 0; f < feedEntryBars.length; f++) {
      var entry = feedEntryBars[f];
      if (entry.querySelector('[data-liai-feed-post-btn]')) continue;
      var trigger = entry.querySelector('.share-box-feed-entry__trigger, button[aria-label*="Start a post" i]') ||
        (isStartPostTriggerButton(entry) ? entry : null);
      var targetRow = entry.querySelector('.share-box-feed-entry__bottom-bar, .share-box-feed-entry__top-bar') ||
        (trigger && trigger.parentElement);
      if (!targetRow || targetRow.querySelector('[data-liai-feed-post-btn]')) continue;
      var feedBtn = document.createElement('button');
      feedBtn.type = 'button';
      feedBtn.className = 'liai-comment-button liai-feed-post-button';
      feedBtn.style.cssText = INLINE_BUTTON_STYLE;
      feedBtn.dataset.liaiButton = 'true';
      feedBtn.dataset.liaiFeedPostBtn = 'true';
      feedBtn.setAttribute('aria-label', 'Write a LinkedIn post with AI');
      feedBtn.title = 'Open LinkedIn post box & draft a post with AI';
      feedBtn.innerHTML = SPARKLE_SVG + '<span class="liai-button-label">AI Post</span>';
      (function (capturedTrigger, capturedBtn) {
        feedBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          var existingEd = findPostComposerEditor();
          if (existingEd) {
            openPanel({
              post: null,
              editor: existingEd,
              anchor: existingEd,
              channel: 'linkedin_post'
            });
            return;
          }
          if (capturedTrigger && capturedTrigger.click) {
            try { capturedTrigger.click(); } catch (err) { /* ignore */ }
          }
          waitForPostComposerEditor(3500).then(function (openedEd) {
            injectPostComposerTriggers();
            if (openedEd) attachGrammarlyWidget(openedEd, null);
            openPanel({
              post: null,
              editor: openedEd,
              anchor: openedEd || capturedBtn,
              channel: 'linkedin_post'
            });
          });
        });
      })(trigger, feedBtn);
      feedBtn.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      targetRow.appendChild(feedBtn);
    }
  }

  function isLinkedInCommentEditor(el) {
    if (!el || !el.getAttribute) return false;
    if (el.closest && el.closest('#' + PANEL_ID + ', #' + WIDGET_ID)) return false;

    // Exclude top navigation search bar & messaging chat boxes unless they are post comments
    var role = (el.getAttribute('role') || '').toLowerCase();
    var ariaLabel = (el.getAttribute('aria-label') || '');
    var placeholder = (
      el.getAttribute('data-placeholder') ||
      el.getAttribute('aria-placeholder') ||
      el.getAttribute('placeholder') ||
      ''
    );

    if (/search/i.test(ariaLabel) || /search/i.test(placeholder) || role === 'combobox') {
      return false;
    }
    if (el.closest && el.closest('.msg-Overlay, .msg-convo-wrapper, .msg-form, .global-nav')) {
      return false;
    }

    var isEditable =
      el.isContentEditable ||
      el.getAttribute('contenteditable') === 'true' ||
      el.getAttribute('contenteditable') === '' ||
      el.tagName === 'TEXTAREA';
    if (!isEditable || el.getAttribute('contenteditable') === 'false') return false;

    // Direct match on LinkedIn Post creation composer ("Start a post" / "What do you want to talk about?")
    if (isPostComposerEditor(el)) {
      return true;
    }

    // Direct match on known comment editor traits
    var testId = (el.getAttribute('data-testid') || '');
    if (
      hasClass(el, 'ql-editor') ||
      hasClass(el, 'comments-comment-texteditor__contenteditable') ||
      /^tweetTextarea_/i.test(testId) ||
      /comment|reply|thoughts|talk about|write a post|start a post|text editor/i.test(ariaLabel) ||
      /comment|reply|thoughts|talk about|write a post|start a post/i.test(placeholder) ||
      (el.closest && el.closest('.comments-comment-box, .comments-comment-texteditor, .comments-comment-box-comment__text-editor, [class*="comment-box"], [class*="comment-texteditor"]'))
    ) {
      return true;
    }

    // Also accept any contenteditable textbox located inside a post container or modal dialog
    if (findEnclosingPost(el)) {
      return true;
    }
    if (el.closest && safeClosest(el, 'div[role="dialog"], .artdeco-modal')) {
      return true;
    }

    return false;
  }

  function resolveEditableRoot(target) {
    if (!target || target === document || target === document.body) return null;
    if (isLinkedInCommentEditor(target)) return target;
    var found = safeClosest(target, EDITOR_SELECTORS);
    if (found && isLinkedInCommentEditor(found)) return found;
    var ce = safeClosest(target, '[contenteditable="true"], [contenteditable=""], textarea');
    if (ce && isLinkedInCommentEditor(ce)) return ce;
    return null;
  }

  function isElementVisible(el) {
    if (!el) return false;
    if (el.getAttribute && el.getAttribute(' style') && /display:\s*none/i.test(el.getAttribute('style'))) return false;
    if (el.style && (el.style.display === 'none' || el.style.visibility === 'hidden')) return false;
    var rects = el.getClientRects ? el.getClientRects() : null;
    var hasRects = rects && rects.length > 0 && (rects[0].width > 0 || rects[0].height > 0);
    var hasOffset = el.offsetParent !== null;
    return Boolean(hasRects || hasOffset);
  }

  function findVisibleCommentEditors() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return [];
    var candidates = safeQueryAllDeep(document, EDITOR_SELECTORS);
    var result = [];
    for (var i = 0; i < candidates.length; i++) {
      var ed = candidates[i];
      if (!isLinkedInCommentEditor(ed)) continue;
      if (isElementVisible(ed)) result.push(ed);
    }
    return result;
  }

  function ensureFloatingWidget() {
    if (floatingWidget && document.body && document.body.contains(floatingWidget)) {
      return floatingWidget;
    }
    var old = document.getElementById(WIDGET_ID);
    if (old) old.remove();

    var w = document.createElement('div');
    w.id = WIDGET_ID;
    w.className = 'liai-grammarly-trigger';
    w.setAttribute('role', 'group');
    w.setAttribute('aria-label', 'AI Comment Assistant');
    w.innerHTML =
      '<button type="button" class="liai-grammarly-main" aria-label="Draft comment with AI" title="Spark AI — Draft a personalized comment for this post">' +
      '  <span class="liai-grammarly-dot">' + SPARKLE_SVG + '</span>' +
      '  <span class="liai-grammarly-label">AI Draft</span>' +
      '</button>' +
      '<button type="button" class="liai-grammarly-hide" aria-label="Hide AI Draft button" title="Hide AI Draft button while writing (Shift+Click to always hide in comment boxes)">✕</button>';

    w.addEventListener('mousedown', function (e) {
      // Prevent stealing focus from the comment editor
      e.preventDefault();
      e.stopPropagation();
    });

    var mainBtn = w.querySelector('.liai-grammarly-main');
    var hideBtn = w.querySelector('.liai-grammarly-hide');

    mainBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var ed = activeEditor;
      var isPostEditor = ed && isPostComposerEditor(ed);
      var post = isPostEditor
        ? null
        : ((ed && findEnclosingPost(ed)) || activeEditorPost || findBestPostOnPage());
      var isX = typeof location !== 'undefined' && /(^|\.)(x\.com|twitter\.com)$/i.test(location.hostname || '');
      openPanel({
        post: post,
        editor: ed,
        anchor: w,
        channel: isPostEditor ? (isX ? 'x_post' : 'linkedin_post') : undefined
      });
    });

    hideBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        uiPrefs.hideFloatingWidget = true;
        chrome.storage.local.set({ hideFloatingWidget: true });
        hideGrammarlyWidget();
        showToast('Floating AI Draft badge hidden. You can re-enable it anytime in Settings.');
        return;
      }
      if (activeEditor) {
        dismissedEditors.add(activeEditor);
      }
      hideGrammarlyWidget();
      showToast('AI Draft hidden for this comment box. You can still use the ✨ AI button on the post.');
    });

    if (document.body) {
      document.body.appendChild(w);
    }
    floatingWidget = w;
    return w;
  }

  function attachGrammarlyWidget(editor, explicitPost) {
    if (!editor || !document || !document.body) return null;
    activeEditor = editor;
    var isPostEd = isPostComposerEditor(editor);
    activeEditorPost = isPostEd ? null : (explicitPost || findEnclosingPost(editor) || activeEditorPost);
    // Also ensure the enclosing post gets its single action bar button if possible
    if (activeEditorPost && !processed.has(activeEditorPost)) {
      if (injectButton(activeEditorPost)) {
        processed.add(activeEditorPost);
      }
    }
    if (uiPrefs.hideFloatingWidget || dismissedEditors.has(editor)) {
      hideGrammarlyWidget();
      return floatingWidget;
    }
    var w = ensureFloatingWidget();
    var lbl = w.querySelector('.liai-grammarly-label');
    if (lbl) {
      lbl.textContent = isPostEd ? 'AI Post' : 'AI Draft';
    }
    updateGrammarlyWidgetPosition();
    return w;
  }

  function hideGrammarlyWidget() {
    if (floatingWidget) {
      floatingWidget.classList.remove('liai-visible');
      floatingWidget.classList.remove('liai-typing-hidden');
      floatingWidget.style.display = 'none';
    }
  }

  function updateGrammarlyWidgetPosition() {
    if (uiPrefs.hideFloatingWidget) {
      hideGrammarlyWidget();
      return;
    }
    if (!activeEditor || !isNodeInDocument(activeEditor)) {
      hideGrammarlyWidget();
      return;
    }
    if (dismissedEditors.has(activeEditor)) {
      hideGrammarlyWidget();
      return;
    }
    if (!isElementVisible(activeEditor)) {
      hideGrammarlyWidget();
      return;
    }
    if (uiPrefs.hideWhileTyping && isUserTyping) {
      if (floatingWidget) {
        floatingWidget.classList.add('liai-typing-hidden');
        floatingWidget.style.display = 'none';
      }
      return;
    }
    var w = ensureFloatingWidget();
    w.classList.remove('liai-typing-hidden');

    // Measure the editable text area itself (not the entire form with the submit row below)
    // so the pill never overlaps the text the user is typing on the last line or collides
    // with buttons below.
    var container = safeClosest(activeEditor, '.comments-comment-texteditor, .comments-comment-box-comment__text-editor, .share-creation-state__text-editor, .editor-content') || activeEditor;
    var rect = container.getBoundingClientRect ? container.getBoundingClientRect() : activeEditor.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      rect = { top: 200, left: 200, right: 500, bottom: 244, width: 300, height: 44 };
    }

    // Hide if scrolled completely off-screen
    if (typeof window !== 'undefined' && (rect.bottom < 48 || rect.top > window.innerHeight - 20)) {
      hideGrammarlyWidget();
      return;
    }

    w.style.display = 'inline-flex';
    var wWidth = w.offsetWidth || 98;
    var wHeight = w.offsetHeight || 26;

    // Position neatly in the bottom-right corner of the text area
    var top = Math.max(8, rect.bottom - wHeight - 6);
    var left = Math.max(8, rect.right - wWidth - 8);

    w.style.top = Math.round(top) + 'px';
    w.style.left = Math.round(left) + 'px';
    w.classList.add('liai-visible');
  }

  function scheduleWidgetPositionUpdate() {
    if (widgetRaf) return;
    var raf = (typeof window !== 'undefined' && window.requestAnimationFrame) || function (fn) { return setTimeout(fn, 16); };
    widgetRaf = raf(function () {
      widgetRaf = null;
      updateGrammarlyWidgetPosition();
    });
  }

  function findBestPostOnPage() {
    if (!document) return null;
    if (activeEditor) {
      var fromEd = findEnclosingPost(activeEditor);
      if (fromEd) return fromEd;
    }
    var posts = document.querySelectorAll(POST_SELECTORS);
    if (!posts.length) return document.querySelector('main, article') || document.body;
    // Pick the post closest to the vertical center of the viewport
    var midY = (typeof window !== 'undefined' ? window.innerHeight : 800) / 2;
    var best = posts[0];
    var bestDist = Infinity;
    for (var i = 0; i < posts.length; i++) {
      var r = posts[i].getBoundingClientRect ? posts[i].getBoundingClientRect() : null;
      if (!r || (r.width === 0 && r.height === 0)) continue;
      var center = (r.top + r.bottom) / 2;
      var dist = Math.abs(center - midY);
      if (dist < bestDist) {
        bestDist = dist;
        best = posts[i];
      }
    }
    return best;
  }

  /* ---------------- post text / author extraction ---------------- */

  function stripSeeMoreText(str) {
    return String(str || '')
      .replace(/\s*(?:…|\.\.\.)\s*(?:see\s+)?(?:more|less)\b/gi, ' ')
      .replace(/(?:^|\s+)(?:…|\.\.\.)\s*(?:more|less)\s*$/gi, '')
      .trim();
  }

  function normalizeCaptionWhitespace(s) {
    var raw = String(s == null ? '' : s)
      .replace(/\u00a0/g, ' ')
      .replace(/[\u200b\u200c\ufeff]/g, '')
      .replace(/\r\n?/g, '\n');
    var lines = raw.split('\n').map(function (line) {
      return line.replace(/[ \t\f]+/g, ' ').trim();
    });
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function isExpandMoreButton(btn) {
    if (!btn || !btn.getAttribute) return false;
    if (btn.hasAttribute('data-liai-button')) return false;
    if (isInsideCommentSection(btn)) return false;
    var cls = String(btn.className || '');
    var testId = String(btn.getAttribute('data-testid') || '');
    var aria = normalizeWhitespace(btn.getAttribute('aria-label') || '');
    var txt = normalizeWhitespace(btn.textContent || '');
    // Never click "see less" / "less" buttons that would collapse an already-expanded caption
    if (/\bless\b/i.test(txt) || /\bless\b/i.test(aria) || /less-link/i.test(cls)) {
      return false;
    }
    // Never click post header 3-dot control menus ("More actions", "Open control menu")
    if (/action|menu|control|option|share|send|profile/i.test(aria)) {
      return false;
    }
    if (
      /see-more-less-toggle|more-link/i.test(cls) ||
      testId === 'expandable-text-button'
    ) {
      return true;
    }
    if (/^(?:…|\.\.\.)?\s*(?:see\s+)?more$/i.test(txt)) {
      return true;
    }
    return false;
  }

  function expandCollapsedPostText(post) {
    if (!post || !post.querySelectorAll) return false;
    var clicked = false;
    var candidates = post.querySelectorAll(
      '.feed-shared-inline-show-more-text__see-more-less-toggle, ' +
      '.feed-shared-inline-show-more-text__more-link, ' +
      '[data-testid="expandable-text-button"], ' +
      'button, [role="button"]'
    );
    for (var i = 0; i < candidates.length; i++) {
      var btn = candidates[i];
      if (!isExpandMoreButton(btn)) continue;
      try {
        btn.click();
        clicked = true;
      } catch (e) { /* ignore click errors in synthetic DOMs */ }
    }
    return clicked;
  }

  function removeInvisible(root) {
    root.querySelectorAll(
      'button, script, style, svg, [role="button"], ' +
      '.feed-shared-inline-show-more-text__see-more-less-toggle, ' +
      '.feed-shared-inline-show-more-text__more-link, ' +
      '.feed-shared-inline-show-more-text__less-link, ' +
      '.feed-shared-social-action-bar, .feed-shared-social-actions-bar, ' +
      '[class*="feed-shared-social-action-bar"], [data-view-name="feed-action-bar"], ' +
      '.update-components-actor, .feed-shared-actor, .comments-comment-box, ' +
      '.comments-comment-texteditor, .feed-shared-control-menu, ' +
      '.comments-container, .feed-shared-update-v2__comments-container, ' +
      '.social-details-social-counts, .feed-shared-social-counts, ' +
      '[data-liai-button], #' + WIDGET_ID + ', #' + PANEL_ID
    ).forEach(function (n) { n.remove(); });

    // Remove .visually-hidden screen-reader duplicates first.
    root.querySelectorAll('.visually-hidden').forEach(function (n) { n.remove(); });

    // Only remove [aria-hidden="true"] nodes that were pure UI chrome (or empty);
    // do NOT remove visible post text spans that LinkedIn marks aria-hidden="true"
    // alongside a removed .visually-hidden sibling.
    root.querySelectorAll('[aria-hidden="true"]').forEach(function (n) {
      var t = normalizeWhitespace(n.textContent || '');
      if (!t || /^(…|\.\.\.)\s*(see\s+)?(more|less)$/i.test(t)) {
        n.remove();
      }
    });
  }

  function extractFormattedText(el) {
    if (!el) return '';
    var clone = el.cloneNode(true);
    // Convert <br> and block elements to newlines before reading textContent so paragraph structure survives
    clone.querySelectorAll('br').forEach(function (br) {
      br.replaceWith('\n');
    });
    clone.querySelectorAll('p, div, li').forEach(function (blk) {
      blk.appendChild(document.createTextNode('\n'));
    });
    removeInvisible(clone);
    return normalizeCaptionWhitespace(stripSeeMoreText(clone.textContent || ''));
  }

  function substantiveLength(str) {
    return String(str || '').replace(/\s+/g, ' ').trim().length;
  }

  function extractFromShowMore(container) {
    if (!container) return '';
    var best = '';

    // 1) Check ALL .visually-hidden spans inside the container (not just the first one,
    // which might be a tiny "hashtag" or "View profile" label).
    var srSpans = container.querySelectorAll('span.visually-hidden, .visually-hidden');
    for (var sIdx = 0; sIdx < srSpans.length; sIdx++) {
      var srClone = srSpans[sIdx].cloneNode(true);
      srClone.querySelectorAll('br').forEach(function (br) { br.replaceWith('\n'); });
      var srText = normalizeCaptionWhitespace(stripSeeMoreText(srClone.textContent || ''));
      if (substantiveLength(srText) > substantiveLength(best)) {
        best = srText;
      }
    }

    // 2) Collect visible aria-hidden="true" text spans, dropping see-more labels.
    var visible = [];
    var spans = container.querySelectorAll('span[aria-hidden="true"]');
    for (var i = 0; i < spans.length; i++) {
      if (spans[i].parentElement && spans[i].parentElement.closest && spans[i].parentElement.closest('span[aria-hidden="true"]')) {
        continue;
      }
      var spClone = spans[i].cloneNode(true);
      spClone.querySelectorAll('br').forEach(function (br) { br.replaceWith('\n'); });
      spClone.querySelectorAll('button, [role="button"], .feed-shared-inline-show-more-text__see-more-less-toggle, .feed-shared-inline-show-more-text__more-link, .feed-shared-inline-show-more-text__less-link').forEach(function (b) { b.remove(); });
      var t = normalizeCaptionWhitespace(stripSeeMoreText(spClone.textContent || ''));
      if (!t) continue;
      visible.push(t);
    }
    var joinedVisible = visible.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (substantiveLength(joinedVisible) > substantiveLength(best)) {
      best = joinedVisible;
    }

    // 3) Whole container text with UI chrome and screen-reader duplicates stripped.
    var cleanedWhole = extractFormattedText(container);
    if (substantiveLength(cleanedWhole) > substantiveLength(best)) {
      best = cleanedWhole;
    }

    return best;
  }

  function cleanTextNode(el) {
    if (!el) return '';
    return extractFormattedText(el);
  }

  function extractPostText(post) {
    if (!post || !post.querySelectorAll) return '';
    var parts = [];

    // 1) Narrative text containers (commentary + reshared posts + SDUI blocks + X/Twitter tweetText).
    var containers = post.querySelectorAll(
      '.feed-shared-inline-show-more-text, .update-components-text, ' +
      '.feed-shared-update-v2__description, .feed-shared-update-v2__commentary, .feed-shared-text, ' +
      '.attributed-text-segment-list__content, ' +
      '[data-testid="expandable-text-box"], [data-view-name="feed-commentary"], ' +
      '[data-testid="tweetText"]'
    );
    var seenContainers = [];
    for (var i = 0; i < containers.length; i++) {
      var c = containers[i];
      // Skip if this container is inside a comment item rather than the main post
      if (c.closest && c.closest('.comments-comment-item, .comments-comments-list, .comments-container, .feed-shared-update-v2__comments-container')) {
        continue;
      }
      var isNested = false;
      for (var k = 0; k < seenContainers.length; k++) {
        if (seenContainers[k].contains(c)) {
          // If an inner container somehow has more text than what we extracted from the outer one, allow it;
          // otherwise skip nested duplicates.
          isNested = true;
          break;
        }
      }
      if (isNested) continue;
      seenContainers.push(c);
      var t = extractFromShowMore(c);
      if (!t) continue;
      // Avoid adding duplicate substrings already captured by an outer/sibling block
      var alreadyCovered = parts.some(function (existing) {
        return existing === t || existing.indexOf(t) !== -1;
      });
      if (!alreadyCovered) {
        parts = parts.filter(function (existing) { return t.indexOf(existing) === -1; });
        parts.push(t);
      }
    }

    // 2) Article / document / video cards: title + description (included when no commentary exists
    // OR appended as context when a post shares an article/document card alongside commentary).
    var card = post.querySelector(
      '.update-components-article__content, .update-components-document, .update-components-video, .update-components-article'
    );
    if (card) {
      var title = card.querySelector(
        '.update-components-article__title, .update-components-document__title, .update-components-headline'
      );
      var desc = card.querySelector(
        '.update-components-article__description, .update-components-document__description, .update-components-article__subtitle'
      );
      var bits = [];
      var titleT = cleanTextNode(title);
      var descT = cleanTextNode(desc);
      if (titleT) bits.push(titleT);
      if (descT) bits.push(descT);
      var cardSummary = '';
      if (bits.length) {
        cardSummary = bits.join(' — ');
      } else if (!parts.length) {
        cardSummary = cleanTextNode(card);
      }
      if (cardSummary) {
        var cardCovered = parts.some(function (existing) {
          return existing.indexOf(cardSummary) !== -1;
        });
        if (!cardCovered) {
          parts.push(cardSummary);
        }
      }
    }

    // 3) Fallback: the whole post with UI chrome removed.
    if (!parts.length) {
      var whole = extractFormattedText(post);
      if (whole) parts.push(whole);
    }

    var joined = parts.join('\n\n').trim();
    return joined.length > 6000 ? joined.slice(0, 6000) : joined;
  }

  function cleanAuthorNameString(raw) {
    var name = normalizeWhitespace(raw || '');
    name = name
      .replace(/^View\s+/i, '')
      .replace(/[\u2019']s\s+profile.*$/i, '')
      .replace(/\s*[•·]\s*(1st|2nd|3rd\+?|Following|Follow).*$/i, '')
      .replace(/\s+\b(1st|2nd|3rd\+?)\b.*$/i, '')
      .trim();
    if (!name || /^follow(ing)?$/i.test(name)) return '';
    return name;
  }

  function extractAuthorName(post) {
    if (!post || !post.querySelector) return '';
    var el = post.querySelector(
      '.update-components-actor__name, .update-components-actor__title, ' +
      '.feed-shared-actor__name, .update-components-actor__meta-link, ' +
      '[data-view-name="feed-actor-name"], [data-testid="User-Name"], a[href*="/in/"], a[href*="/company/"]'
    );
    if (el) {
      var hiddenSpan = el.querySelector('span[aria-hidden="true"]');
      if (hiddenSpan) {
        var fromHidden = cleanAuthorNameString(hiddenSpan.textContent);
        if (fromHidden) return fromHidden;
      }
      var target = el.querySelector('a, span[dir="auto"], span[dir="ltr"]') || el;
      var clone = target.cloneNode(true);
      clone.querySelectorAll('.visually-hidden, .update-components-actor__supplementary-actor-info, svg, button').forEach(function (n) { n.remove(); });
      var name = cleanAuthorNameString(clone.textContent);
      if (name) return name;
    }
    return '';
  }

  function extractPostUrl(post) {
    var baseHref = (typeof location !== 'undefined' && location.href) ? String(location.href) : '';
    var origin = (typeof location !== 'undefined' && location.origin) ? String(location.origin) : 'https://www.linkedin.com';
    if (!post) return baseHref;
    var urnEl = (post.getAttribute && (post.getAttribute('data-urn') || post.getAttribute('data-id')))
      ? post
      : (post.querySelector && post.querySelector('[data-urn*="urn:li:"], [data-id*="urn:li:"]'));
    if (urnEl && urnEl.getAttribute) {
      var urn = urnEl.getAttribute('data-urn') || urnEl.getAttribute('data-id') || '';
      if (/^urn:li:(activity|ugcPost|share):/i.test(urn)) {
        return 'https://www.linkedin.com/feed/update/' + urn + '/';
      }
    }
    if (post.querySelector) {
      var link = post.querySelector(
        'a[href*="/feed/update/"], a[href*="/posts/"], a[href*="/status/"]'
      );
      if (link && link.getAttribute) {
        var href = String(link.getAttribute('href') || '').trim();
        if (href) {
          if (/^https?:\/\//i.test(href)) return href.replace(/[?#].*$/, '');
          if (href.charAt(0) === '/') return origin + href.replace(/[?#].*$/, '');
        }
      }
    }
    return baseHref;
  }

  /* ---------------- comment editor integration ---------------- */

  function findCommentButton(post) {
    if (!post || !post.querySelector) return null;
    var bar = findActionBar(post);
    if (bar) {
      var buttons = Array.prototype.slice.call(bar.querySelectorAll('button, [role="button"]')).filter(function (b) {
        return !b.hasAttribute('data-liai-button');
      });
      for (var i = 0; i < buttons.length; i++) {
        if (isCommentTriggerButton(buttons[i])) return buttons[i];
      }
      // Native order is Like / Comment / Repost / Send — pick react/social buttons' second entry.
      var react = buttons.filter(function (b) {
        return hasClass(b, 'react-button') || hasClass(b, 'social-actions-button') || hasClass(b, 'artdeco-button');
      });
      return react[1] || buttons[1] || null;
    }
    var candidates = post.querySelectorAll(
      'button[aria-label*="Comment" i], button[aria-label*="comment" i], button[data-control-name="comment"], button.comment-button'
    );
    for (var j = 0; j < candidates.length; j++) {
      if (!candidates[j].hasAttribute('data-liai-button') && !isInsideCommentSection(candidates[j])) {
        return candidates[j];
      }
    }
    return null;
  }

  function findCommentEditor(post) {
    if (!post || !post.querySelectorAll) return null;
    var scope = post;
    var box = post.querySelector('.comments-comment-box, .comments-comment-texteditor, .comments-comment-box-comment__text-editor');
    if (box) scope = box;

    var editors = scope.querySelectorAll(EDITOR_SELECTORS);
    for (var i = 0; i < editors.length; i++) {
      if (editors[i].getAttribute('contenteditable') === 'false') continue;
      if (isElementVisible(editors[i])) return editors[i];
    }
    // Also check if activeEditor belongs to this post
    if (activeEditor && post.contains && post.contains(activeEditor) && isElementVisible(activeEditor)) {
      return activeEditor;
    }
    // Fallback for X (Twitter) reply modals where the reply editor is mounted at the dialog root
    if (typeof document !== 'undefined' && document.querySelectorAll) {
      var xEditors = document.querySelectorAll('div[data-testid^="tweetTextarea_"][contenteditable="true"], div[data-testid^="tweetTextarea_"][role="textbox"]');
      for (var j = 0; j < xEditors.length; j++) {
        if (isElementVisible(xEditors[j])) return xEditors[j];
      }
    }
    return null;
  }

  function waitForEditor(post, timeoutMs) {
    var t0 = Date.now();
    return new Promise(function (resolve) {
      (function tick() {
        if (Date.now() - t0 >= (timeoutMs || 4000)) { resolve(null); return; }
        var ed = findCommentEditor(post);
        if (ed) { resolve(ed); return; }
        setTimeout(tick, 110);
      })();
    });
  }

  function selectEditorContents(editor) {
    try {
      if (typeof window !== 'undefined' && window.getSelection && typeof document !== 'undefined' && document.createRange) {
        var sel = window.getSelection();
        if (sel) {
          var range = document.createRange();
          range.selectNodeContents(editor);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    } catch (e) { /* ignore selection errors in minimal DOMs */ }
  }

  function isXDraftEditor(editor) {
    if (!editor || !editor.getAttribute) return false;
    var testId = (editor.getAttribute('data-testid') || '');
    if (/^tweetTextarea_/i.test(testId)) return true;
    if (editor.classList && (editor.classList.contains('public-DraftEditor-content') || editor.classList.contains('DraftEditor-editorContainer'))) {
      return true;
    }
    if (editor.querySelector && editor.querySelector('[data-contents="true"], .public-DraftStyleDefault-block')) {
      return true;
    }
    if (editor.closest && editor.closest('[data-testid^="tweetTextarea_"], .DraftEditor-root')) {
      return true;
    }
    return false;
  }

  function insertIntoXDraftEditor(editor, text) {
    var editable = editor;
    if (!editable.isContentEditable && editable.getAttribute('contenteditable') !== 'true') {
      var inner = editable.querySelector && editable.querySelector('[contenteditable="true"], .public-DraftEditor-content');
      if (inner) editable = inner;
    }
    editable.focus();

    // Select any existing contents inside Draft.js using collapse/selectAll so Draft's internal SelectionState updates
    try {
      var existingText = normalizeWhitespace(editable.textContent || '');
      if (existingText && typeof document !== 'undefined' && document.execCommand) {
        document.execCommand('selectAll', false, null);
      } else if (typeof window !== 'undefined' && window.getSelection && typeof document !== 'undefined' && document.createRange) {
        var sel = window.getSelection();
        var targetNode = editable.querySelector('[data-text="true"], [data-contents="true"]') || editable;
        if (sel && targetNode) {
          var range = document.createRange();
          range.selectNodeContents(targetNode);
          if (!existingText) range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    } catch (e) { /* ignore selection errors */ }

    // 1) Primary path for Draft.js (X/Twitter): dispatch a synthetic ClipboardEvent('paste')
    // Draft.js intercepts 'paste' on the editor, reads clipboardData.getData('text/plain'),
    // calls event.preventDefault() so the browser does NOT also modify the DOM, and updates
    // its React state cleanly once without duplicating text or corrupting cursor selection.
    try {
      if (typeof DataTransfer !== 'undefined' && typeof ClipboardEvent !== 'undefined') {
        var dt = new DataTransfer();
        dt.setData('text/plain', text);
        var pasteEv = new ClipboardEvent('paste', {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
          composed: true
        });
        editable.dispatchEvent(pasteEv);
        // If Draft.js handled the paste (preventDefault called or text now present), we are done!
        if (pasteEv.defaultPrevented || normalizeWhitespace(editable.textContent || '').indexOf(normalizeWhitespace(text)) !== -1) {
          return true;
        }
      }
    } catch (e) { /* fall through */ }

    // 2) Secondary path for Draft.js: beforeinput with insertFromPaste / insertText
    try {
      if (typeof InputEvent !== 'undefined') {
        var dt2 = (typeof DataTransfer !== 'undefined') ? new DataTransfer() : null;
        if (dt2) dt2.setData('text/plain', text);
        var beforeEv = new InputEvent('beforeinput', {
          inputType: 'insertFromPaste',
          data: text,
          dataTransfer: dt2 || undefined,
          bubbles: true,
          cancelable: true,
          composed: true
        });
        editable.dispatchEvent(beforeEv);
        if (beforeEv.defaultPrevented || normalizeWhitespace(editable.textContent || '').indexOf(normalizeWhitespace(text)) !== -1) {
          return true;
        }
      }
    } catch (e2) { /* fall through */ }

    return false;
  }

  function insertTextInto(editor, text) {
    editor.focus();
    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
      editor.value = text;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    // Special handling for X (Twitter) Draft.js editors to prevent double-insertion & frozen DOM state
    if (isXDraftEditor(editor)) {
      if (insertIntoXDraftEditor(editor, text)) {
        return;
      }
    }

    selectEditorContents(editor);
    var inserted = false;
    try {
      if (typeof document !== 'undefined' && document.execCommand) {
        inserted = document.execCommand('insertText', false, text) === true;
      }
    } catch (e) {
      inserted = false;
    }
    if (inserted) return;

    // Fallback for environments / engines without working execCommand.
    if (editor.classList && editor.classList.contains('ql-blank')) {
      editor.classList.remove('ql-blank');
    }
    editor.innerHTML = '';
    if (editor.classList && editor.classList.contains('ql-editor')) {
      var p = document.createElement('p');
      p.textContent = text;
      editor.appendChild(p);
    } else {
      editor.appendChild(document.createTextNode(text));
    }
    var EventInputCtor = (typeof window !== 'undefined' && window.InputEvent) || Event;
    var evCatcher = editor;
    try {
      evCatcher.dispatchEvent(new EventInputCtor('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
      evCatcher.dispatchEvent(new EventInputCtor('input', { bubbles: true, composed: true }));
      evCatcher.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    } catch (e2) {
      evCatcher.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  async function insertIntoComposer(post, text, explicitEditor) {
    var editor = (explicitEditor && isElementVisible(explicitEditor)) ? explicitEditor : null;
    if (!editor && post) {
      editor = findCommentEditor(post);
    }
    if (!editor && !post) {
      editor = findPostComposerEditor();
    }
    if (!editor && post) {
      var btn = findCommentButton(post);
      if (btn) btn.click();
      editor = await waitForEditor(post, 4000);
    }
    if (!editor && activeEditor && isElementVisible(activeEditor)) {
      editor = activeEditor;
    }
    if (!editor) return { ok: false };
    insertTextInto(editor, text);
    editor.focus();
    attachGrammarlyWidget(editor, post);
    try { editor.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* no-op */ }
    return { ok: true };
  }

  /* ---------------- Apple-inspired composer panel ---------------- */

  function toneOptionsHtml(selected) {
    return TONES.map(function (t) {
      return '<option value="' + escapeAttr(t) + '"' + (t === selected ? ' selected' : '') + '>' + escapeAttr(t) + '</option>';
    }).join('');
  }

  function channelOptionsHtml(selected) {
    var sel = selected || 'comment';
    return CHANNELS.map(function (c) {
      return '<option value="' + c.value + '"' + (c.value === sel ? ' selected' : '') + '>' + c.label + '</option>';
    }).join('');
  }

  function countWords(str) {
    var s = String(str || '').trim();
    if (!s) return 0;
    return s.split(/\s+/).filter(Boolean).length;
  }

  function updateWordCountBadge(ui) {
    if (!ui || !ui.wordCount || !ui.textarea) return;
    var ch = (ui.channel && ui.channel.value) || 'comment';
    var val = String(ui.textarea.value || '').trim();
    if (!val) {
      if (ch === 'x_post') {
        ui.wordCount.textContent = 'X Post (1–4 lines, <280c)';
      } else if (ch === 'linkedin_long') {
        ui.wordCount.textContent = 'LinkedIn Long-Form Post (500+ words)';
      } else if (ch === 'linkedin_post') {
        ui.wordCount.textContent = 'LinkedIn Post';
      } else {
        ui.wordCount.textContent = 'Full caption read · Ready';
      }
      return;
    }
    var words = countWords(val);
    var chars = val.length;
    if (ch === 'x_post') {
      ui.wordCount.textContent = words + 'w · ' + chars + '/280 chars';
    } else {
      ui.wordCount.textContent = words + (words === 1 ? ' word' : ' words') + ' · ' + chars + ' chars';
    }
  }

  function buildPanel(contextText) {
    var panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'liai-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'AI comment composer');

    var inner = document.createElement('div');
    inner.className = 'liai-panel-inner';
    inner.innerHTML =
      '<div class="liai-panel-head">' +
      '  <div class="liai-panel-title">' +
      '    <span class="liai-title-badge">' + SPARKLE_SVG + '</span>' +
      '    <span>AI Comment Assistant</span>' +
      '  </div>' +
      '  <div class="liai-panel-tools">' +
      '    <label class="liai-tone-label" title="Output format: Comment, LinkedIn Post, or X Post">' +
      '      <select class="liai-channel" aria-label="Channel format">' + channelOptionsHtml('comment') + '</select>' +
      '    </label>' +
      '    <label class="liai-tone-label">Tone' +
      '      <select class="liai-tone">' + toneOptionsHtml('Engaging') + '</select>' +
      '    </label>' +
      '    <button type="button" class="liai-icon-btn liai-history-btn" title="Open Comment &amp; Thought-Process History" aria-label="Open Comment History">🕘</button>' +
      '    <button type="button" class="liai-icon-btn liai-close" title="Close (Esc)" aria-label="Close">✕</button>' +
      '  </div>' +
      '</div>' +
      '<div class="liai-context" title="' + escapeAttr(contextText) + '"></div>' +
      '<div class="liai-angle-wrap">' +
      '  <input type="text" class="liai-angle" aria-label="Optional custom angle" placeholder="Optional direction: e.g. make a witty analogy, ask about their pricing… (Enter to apply)">' +
      '</div>' +
      '<div class="liai-editor-wrap">' +
      '  <textarea class="liai-text" rows="3" aria-label="Generated comment" placeholder="Reading full caption & thinking of a reply…"></textarea>' +
      '</div>' +
      '<div class="liai-thought-wrap" hidden>' +
      '  <div class="liai-thought-bar">' +
      '    <button type="button" class="liai-thought-toggle" aria-expanded="false">💭 Why this comment? <span class="liai-thought-chevron">▸</span></button>' +
      '    <button type="button" class="liai-thought-open-history" title="View full thread in History page">View in History ↗</button>' +
      '  </div>' +
      '  <div class="liai-thought-body" hidden></div>' +
      '</div>' +
      '<div class="liai-status" role="status" hidden></div>' +
      '<div class="liai-error" hidden></div>' +
      '<div class="liai-footer">' +
      '  <div class="liai-footer-left">' +
      '    <button type="button" class="liai-btn liai-regenerate" title="Generate a fresh angle with a new creative seed">↻ Regenerate</button>' +
      '    <button type="button" class="liai-btn liai-stop" title="Stop generating comment or post (Esc)" aria-label="Stop generating" hidden>■ Stop</button>' +
      '    <span class="liai-word-count" aria-live="polite">Full caption read · Ready</span>' +
      '  </div>' +
      '  <div class="liai-footer-right">' +
      '    <button type="button" class="liai-btn liai-copy">Copy</button>' +
      '    <button type="button" class="liai-btn liai-btn-primary liai-primary liai-insert">Insert</button>' +
      '  </div>' +
      '</div>';

    panel.appendChild(inner);

    var channel = panel.querySelector('.liai-channel');
    var tone = panel.querySelector('.liai-tone');
    var angle = panel.querySelector('.liai-angle');
    var textarea = panel.querySelector('.liai-text');
    var thoughtWrap = panel.querySelector('.liai-thought-wrap');
    var thoughtToggle = panel.querySelector('.liai-thought-toggle');
    var thoughtBody = panel.querySelector('.liai-thought-body');
    var thoughtHistoryBtn = panel.querySelector('.liai-thought-open-history');
    var historyBtn = panel.querySelector('.liai-history-btn');
    var wordCountEl = panel.querySelector('.liai-word-count');
    var statusEl = panel.querySelector('.liai-status');
    var errorEl = panel.querySelector('.liai-error');
    var contextEl = panel.querySelector('.liai-context');
    var regenBtn = panel.querySelector('.liai-regenerate');
    var stopBtn = panel.querySelector('.liai-stop');
    var copyBtn = panel.querySelector('.liai-copy');
    var insertBtn = panel.querySelector('.liai-insert');
    var closeBtn = panel.querySelector('.liai-close');

    contextEl.textContent = contextText;

    return {
      el: panel, channel: channel, tone: tone, angle: angle, textarea: textarea,
      thoughtWrap: thoughtWrap, thoughtToggle: thoughtToggle, thoughtBody: thoughtBody,
      thoughtHistoryBtn: thoughtHistoryBtn, historyBtn: historyBtn,
      wordCount: wordCountEl, status: statusEl, error: errorEl,
      regen: regenBtn, stop: stopBtn, copy: copyBtn, insert: insertBtn, close: closeBtn,
      lastHistoryId: null, lastThreadId: null
    };
  }

  function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function positionPanel(panel, anchor) {
    var rect = (anchor && anchor.getBoundingClientRect)
      ? anchor.getBoundingClientRect()
      : { top: 120, bottom: 150, left: 120, right: 200, width: 80, height: 30 };
    if (rect.width === 0 && rect.height === 0) {
      var vw = (typeof window !== 'undefined' && window.innerWidth) || 1024;
      var vh = (typeof window !== 'undefined' && window.innerHeight) || 768;
      rect = { top: Math.round(vh * 0.25), bottom: Math.round(vh * 0.25) + 32, left: Math.round((vw - PANEL_WIDTH) / 2), right: Math.round((vw + PANEL_WIDTH) / 2), width: PANEL_WIDTH, height: 32 };
    }
    panel.style.visibility = 'hidden';
    panel.style.display = 'block';
    var pw = panel.offsetWidth || PANEL_WIDTH;
    var ph = panel.offsetHeight || 270;
    var winW = (typeof window !== 'undefined' && window.innerWidth) || 1024;
    var winH = (typeof window !== 'undefined' && window.innerHeight) || 768;
    var left = Math.max(12, Math.min(rect.left, winW - pw - 16));
    var top = rect.bottom + 10;
    if (top + ph > winH - 12) {
      top = Math.max(12, rect.top - ph - 10);
      if (top < 12) top = Math.max(12, winH - ph - 12);
    }
    panel.style.top = Math.round(top) + 'px';
    panel.style.left = Math.round(left) + 'px';
    panel.style.visibility = 'visible';
  }

  function setStatus(ui, text) {
    if (text) {
      ui.status.textContent = text;
      ui.status.hidden = false;
    } else {
      ui.status.textContent = '';
      ui.status.hidden = true;
    }
  }

  function setError(ui, text) {
    if (text) {
      ui.error.textContent = text;
      ui.error.hidden = false;
    } else {
      ui.error.textContent = '';
      ui.error.hidden = true;
    }
  }

  function setBusy(ui, busy, isGenerating) {
    var gen = Boolean(busy && isGenerating !== false);
    ui.regen.disabled = busy;
    ui.regen.hidden = gen;
    if (ui.stop) {
      ui.stop.hidden = !gen;
      ui.stop.disabled = !gen;
    }
    ui.insert.disabled = busy;
    if (busy) {
      ui.status.setAttribute('data-busy', 'true');
    } else {
      ui.status.removeAttribute('data-busy');
    }
  }

  function stopGeneration(ui) {
    var targetUi = ui || activeGenUi;
    var reqId = activeGenId;
    activeGenId = null;
    activeGenUi = null;
    ++genCounter;
    if (reqId !== null) {
      sendMessage({ type: 'cancelGeneration', requestId: reqId });
    } else {
      sendMessage({ type: 'cancelGeneration' });
    }
    if (targetUi) {
      var ch = (targetUi.channel && targetUi.channel.value) || 'comment';
      var kind = (ch === 'linkedin_post' || ch === 'linkedin_long' || ch === 'x_post') ? 'post' : 'comment';
      setBusy(targetUi, false);
      setError(targetUi, '');
      setStatus(targetUi, 'Stopped generating ' + kind + '.');
    }
  }

  function showToast(message, isError) {
    var old = document.getElementById(TOAST_ID);
    if (old) old.remove();
    var toast = document.createElement('div');
    toast.id = TOAST_ID;
    toast.className = 'liai-toast' + (isError ? ' liai-toast-error' : '');
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(function () {
      var el = document.getElementById(TOAST_ID);
      if (el) el.remove();
    }, 3200);
  }

  var REASONING_TAGS_RE = 'thought_process|inner_monologue|scratchpad|reflection|reasoning|analysis|thinking|thoughts|thought|reason|think';
  var FINAL_TAGS_RE = 'final_comment|final_answer|final_post|final_reply|final|answer|response|output|comment|reply|post';

  /**
   * Client-side safeguard: ensures that even if raw or partially-tagged model output ever reaches
   * the UI (or is pasted into the draft box), any <think> / reasoning blocks are stripped before
   * displaying or inserting into LinkedIn / X.
   */
  function sanitizeFinalOutputText(raw) {
    var s = String(raw == null ? '' : raw)
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n?/g, '\n');
    if (!s.trim()) return '';
    s = s.replace(new RegExp('&lt;(\\/?\\s*(?:' + REASONING_TAGS_RE + '|' + FINAL_TAGS_RE + ')\\b[^&<>]*?)&gt;', 'gi'), '<$1>');
    if (s.indexOf('<|') !== -1 && /<\|channel\|>/i.test(s)) {
      var finalChannelRe = /<\|channel\|>\s*final\s*(?:<\|constrain\|>[^<]*)?<\|message\|>/gi;
      var lastFinalIdx = -1;
      var fm;
      while ((fm = finalChannelRe.exec(s)) !== null) lastFinalIdx = fm.index + fm[0].length;
      if (lastFinalIdx !== -1) {
        s = s.slice(lastFinalIdx).split(/<\|(?:end|return|start|channel)\|>/i)[0];
      } else {
        s = s.replace(/<\|channel\|>\s*(?:analysis|commentary)\s*(?:<\|constrain\|>[^<]*)?<\|message\|>[\s\S]*?(?=<\|end\|>|<\|start\|>|<\|channel\|>|<\|return\|>|$)/gi, '');
      }
      s = s.replace(/<\|start\|>\s*assistant/gi, '').replace(/<\|[a-z_]+\|>/gi, '');
    }
    var blockRe = new RegExp('<(' + REASONING_TAGS_RE + ')\\b[^>]*>[\\s\\S]*?<\\/\\s*\\1\\s*>', 'gi');
    var finalRe = new RegExp('<(' + FINAL_TAGS_RE + ')\\b[^>]*>([\\s\\S]*?)<\\/\\s*\\1\\s*>', 'gi');
    var finalMatch;
    var extractedFinal = null;
    while ((finalMatch = finalRe.exec(s)) !== null) {
      var candidate = finalMatch[2].replace(blockRe, '').trim();
      if (candidate) extractedFinal = candidate;
    }
    if (extractedFinal !== null) {
      s = extractedFinal;
    } else {
      s = s.replace(blockRe, '\n');
      var closeRe = new RegExp('<\\/\\s*(?:' + REASONING_TAGS_RE + ')\\s*>', 'gi');
      var cm;
      var lastClose = -1;
      while ((cm = closeRe.exec(s)) !== null) lastClose = cm.index + cm[0].length;
      if (lastClose !== -1) s = s.slice(lastClose);
      s = s.replace(new RegExp('<(?:' + REASONING_TAGS_RE + ')\\b[^>]*>[\\s\\S]*$', 'i'), '');
    }
    s = s.replace(new RegExp('<\\/?\\s*(?:' + REASONING_TAGS_RE + '|' + FINAL_TAGS_RE + ')\\b[^>]*>', 'gi'), '');
    return s.trim();
  }

  async function generateComment(ui, payload) {
    if (activeGenId !== null) {
      sendMessage({ type: 'cancelGeneration', requestId: activeGenId });
    }
    var myId = ++genCounter;
    activeGenId = myId;
    activeGenUi = ui;
    var ch = (payload && payload.channel) || (ui && ui.channel && ui.channel.value) || 'comment';
    setBusy(ui, true, true);
    setError(ui, '');
    setStatus(
      ui,
      ch === 'linkedin_long'
        ? 'Drafting long-form LinkedIn post (500+ words)…'
        : ch === 'linkedin_post'
        ? 'Drafting LinkedIn post…'
        : (ch === 'x_post' ? 'Drafting X post…' : 'Crafting a personalized reply…')
    );

    try {
      var settings = await getSettings();
      if (myId !== genCounter || activePanel !== ui.el) return;

      var provider = String(settings.provider || 'openai').toLowerCase();
      var needsKey = provider !== 'ollama';
      if (needsKey && !(settings.apiKey || '').trim()) {
        if (activeGenId === myId) { activeGenId = null; activeGenUi = null; }
        setStatus(ui, '');
        setBusy(ui, false);
        setError(ui, 'Add your API key first — click the extension icon in your browser toolbar and open Settings.');
        return;
      }

      var enrichedPayload = Object.assign({}, payload || {});
      if (ui && ui.lastThreadId && !enrichedPayload.threadId) {
        enrichedPayload.threadId = ui.lastThreadId;
      }
      var resp = await sendMessage({ type: 'generateComment', requestId: myId, payload: enrichedPayload });
      if (myId !== genCounter || activePanel !== ui.el) return;
      if (activeGenId === myId) { activeGenId = null; activeGenUi = null; }

      if (resp && resp.cancelled) {
        var kind = (ch === 'linkedin_post' || ch === 'linkedin_long' || ch === 'x_post') ? 'post' : 'comment';
        setBusy(ui, false);
        setError(ui, '');
        setStatus(ui, 'Stopped generating ' + kind + '.');
        return;
      }

      if (resp && resp.ok) {
        ui.textarea.value = sanitizeFinalOutputText(resp.comment);
        if (resp.historyId) ui.lastHistoryId = resp.historyId;
        if (resp.threadId) ui.lastThreadId = resp.threadId;
        if (ui.thoughtWrap && ui.thoughtBody) {
          var tp = String(resp.thoughtProcess || '').trim();
          if (tp) {
            ui.thoughtBody.textContent = tp;
            ui.thoughtWrap.hidden = false;
          } else {
            ui.thoughtWrap.hidden = true;
          }
        }
        updateWordCountBadge(ui);
        setStatus(ui, '');
        setBusy(ui, false);
        ui.insert.focus();
      } else {
        setStatus(ui, '');
        setBusy(ui, false);
        setError(ui, (resp && resp.error) || 'Generation failed. Check your API key and settings.');
      }
    } catch (err) {
      if (myId !== genCounter || activePanel !== ui.el) return;
      if (activeGenId === myId) { activeGenId = null; activeGenUi = null; }
      setStatus(ui, '');
      setBusy(ui, false);
      setError(ui, (err && err.message) || 'Unexpected error. Please try again.');
    }
  }

  async function openPanel(state) {
    var hasExplicitNullPost = Boolean(state && state.post === null);
    var editor = (state && state.editor) || null;
    if (!editor && !hasExplicitNullPost) {
      var candidatePost = (state && state.post) || findBestPostOnPage();
      editor = (candidatePost && findCommentEditor(candidatePost)) || activeEditor || null;
    } else if (!editor) {
      editor = findPostComposerEditor() || activeEditor || null;
    }
    var isPostCreation = Boolean(
      (state && (state.channel === 'linkedin_post' || state.channel === 'linkedin_long' || state.channel === 'x_post')) ||
      (editor && isPostComposerEditor(editor)) ||
      hasExplicitNullPost
    );
    var post = isPostCreation ? null : ((state && state.post) || findBestPostOnPage());
    var anchor = (state && state.anchor) || editor || post || document.body;
    closePanel();

    if (post) {
      expandCollapsedPostText(post);
    }
    var text = '';
    var author = '';
    var postUrl = extractPostUrl(post);
    var isXHost = typeof location !== 'undefined' && /(^|\.)(x\.com|twitter\.com)$/i.test(location.hostname || '');
    var platform = isXHost ? 'x' : 'linkedin';
    if (isPostCreation) {
      var existingDraft = editor ? normalizeCaptionWhitespace(editor.textContent || editor.value || '') : '';
      text = existingDraft;
    } else {
      text = post ? extractPostText(post) : '';
      author = post ? extractAuthorName(post) : '';
    }
    var captionWords = countWords(text);
    var contextHeader;
    if (isPostCreation) {
      contextHeader = text
        ? 'Writing a post from your draft notes (' + captionWords + 'w)'
        : 'Writing a new post · Type your topic below or generate a fresh idea';
    } else {
      contextHeader = (author ? 'Replying to ' + author : 'Replying to post') +
        (captionWords > 0 ? ' (' + captionWords + 'w caption read)' : '');
    }
    var contextText = contextHeader + (text ? ' · “' + text + '”' : '');

    var ui = buildPanel(contextText);
    ui.el.style.visibility = 'hidden';
    document.body.appendChild(ui.el);

    activePanel = ui.el;
    var cleanup = bindPanelEvents(ui, {
      post: post,
      editor: editor,
      anchor: anchor,
      text: text,
      author: author,
      postUrl: postUrl,
      platform: platform
    });
    openPanelInfo = { post: post, editor: editor, cleanup: cleanup };

    var settings = await getSettings();
    if (activePanel !== ui.el) return;

    var defTone = settings.tone || 'Engaging';
    if (TONES.indexOf(defTone) === -1) defTone = 'Engaging';
    ui.tone.value = defTone;
    if (ui.channel) {
      if (state && state.channel) {
        ui.channel.value = state.channel;
      } else if (isPostCreation) {
        ui.channel.value = isXHost ? 'x_post' : 'linkedin_post';
      } else if (settings.channel) {
        ui.channel.value = settings.channel;
      }
      ui.textarea.rows = ui.channel.value === 'linkedin_long' ? 14 : (ui.channel.value === 'linkedin_post' ? 6 : 3);
      if (isPostCreation && ui.angle) {
        ui.angle.placeholder = 'Post topic or hook idea: e.g. 3 UX lessons from shipping an AI workflow… (Enter to generate)';
      }
    }
    positionPanel(ui.el, anchor);

    generateComment(ui, {
      text: text,
      author: author,
      postUrl: postUrl,
      platform: platform,
      tone: ui.tone.value,
      channel: ui.channel ? ui.channel.value : 'comment',
      angle: ui.angle ? ui.angle.value.trim() : ''
    });
  }

  function bindPanelEvents(ui, payload) {
    var onDocMousedown = function (e) {
      if (!ui.el) return;
      if (ui.el.contains(e.target)) return;
      if (floatingWidget && floatingWidget.contains(e.target)) return;
      closePanel();
    };
    var onKeydown = function (e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (activeGenId !== null && activeGenUi === ui) {
          stopGeneration(ui);
        } else {
          closePanel();
        }
      }
    };

    document.addEventListener('mousedown', onDocMousedown, true);
    document.addEventListener('keydown', onKeydown, true);

    function currentGenPayload() {
      return {
        text: payload.text,
        author: payload.author,
        postUrl: payload.postUrl,
        platform: payload.platform,
        threadId: ui.lastThreadId || undefined,
        tone: ui.tone.value,
        channel: ui.channel ? ui.channel.value : 'comment',
        angle: ui.angle ? ui.angle.value.trim() : ''
      };
    }

    ui.close.addEventListener('click', function () { closePanel(); });
    if (ui.historyBtn) {
      ui.historyBtn.addEventListener('click', function () {
        sendMessage({ type: 'openHistory', threadId: ui.lastThreadId || '' });
      });
    }
    if (ui.thoughtHistoryBtn) {
      ui.thoughtHistoryBtn.addEventListener('click', function () {
        sendMessage({ type: 'openHistory', threadId: ui.lastThreadId || '' });
      });
    }
    if (ui.thoughtToggle && ui.thoughtBody) {
      ui.thoughtToggle.addEventListener('click', function () {
        var isHidden = ui.thoughtBody.hidden;
        ui.thoughtBody.hidden = !isHidden;
        ui.thoughtToggle.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
        var chev = ui.thoughtToggle.querySelector('.liai-thought-chevron');
        if (chev) chev.textContent = isHidden ? '▾' : '▸';
      });
    }
    if (ui.stop) {
      ui.stop.addEventListener('click', function () {
        stopGeneration(ui);
      });
    }
    ui.regen.addEventListener('click', function () {
      generateComment(ui, currentGenPayload());
    });
    ui.tone.addEventListener('change', function () {
      generateComment(ui, currentGenPayload());
    });
    if (ui.channel) {
      ui.channel.addEventListener('change', function () {
        ui.textarea.rows = ui.channel.value === 'linkedin_long' ? 14 : (ui.channel.value === 'linkedin_post' ? 6 : 3);
        generateComment(ui, currentGenPayload());
      });
    }
    if (ui.angle) {
      ui.angle.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          generateComment(ui, currentGenPayload());
        }
      });
    }
    ui.copy.addEventListener('click', function () {
      var val = sanitizeFinalOutputText(ui.textarea.value);
      if (val && ui.textarea.value.trim() !== val) ui.textarea.value = val;
      copyToClipboard(val);
      if (val && (ui.lastHistoryId || ui.lastThreadId)) {
        sendMessage({
          type: 'markHistoryAction',
          historyId: ui.lastHistoryId,
          threadId: ui.lastThreadId,
          action: 'copied',
          finalComment: val
        });
      }
    });
    ui.insert.addEventListener('click', async function () {
      var val = sanitizeFinalOutputText(ui.textarea.value);
      if (!val) { setError(ui, 'There is nothing to insert yet.'); return; }
      if (ui.textarea.value.trim() !== val) ui.textarea.value = val;
      setBusy(ui, true, false);
      var result = await insertIntoComposer(payload.post, val, payload.editor);
      if (ui.lastHistoryId || ui.lastThreadId) {
        sendMessage({
          type: 'markHistoryAction',
          historyId: ui.lastHistoryId,
          threadId: ui.lastThreadId,
          action: result.ok ? 'inserted' : 'copied',
          finalComment: val
        });
      }
      if (!result.ok) {
        setBusy(ui, false);
        copyToClipboard(val);
        setError(ui, 'Copied to clipboard! Click inside the comment box and press Ctrl+V / ⌘V.');
        return;
      }
      closePanel();
      showToast('Inserted into comment box — review and press Post.');
    });
    ui.textarea.addEventListener('input', function () {
      setError(ui, '');
      if (activeGenId === null) setStatus(ui, '');
      updateWordCountBadge(ui);
    });

    return function cleanup() {
      document.removeEventListener('mousedown', onDocMousedown, true);
      document.removeEventListener('keydown', onKeydown, true);
    };
  }

  function closePanel() {
    if (activeGenId !== null) {
      stopGeneration();
    }
    if (activePanel) {
      var cleanup = openPanelInfo && openPanelInfo.cleanup;
      if (cleanup) cleanup();
      activePanel.remove();
      activePanel = null;
      openPanelInfo = null;
    }
  }

  function copyToClipboard(text) {
    if (!text) return;
    var done = function () {
      showToast('Comment copied to clipboard.');
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text); done(); });
    } else {
      fallbackCopy(text);
      done();
    }
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } catch (e) { /* ignore */ }
  }

  /* ---------------- global Grammarly-style event listeners ---------------- */

  var boundGlobalListeners = false;

  function markEditorTyping(ed) {
    if (!ed) return;
    if (uiPrefs.hideWhileTyping) {
      isUserTyping = true;
      updateGrammarlyWidgetPosition();
      clearTimeout(typingIdleTimer);
      typingIdleTimer = setTimeout(function () {
        isUserTyping = false;
        updateGrammarlyWidgetPosition();
      }, 1500);
    } else {
      attachGrammarlyWidget(ed);
    }
  }

  function getEventTarget(e) {
    if (!e) return null;
    if (typeof e.composedPath === 'function') {
      try {
        var path = e.composedPath();
        if (path && path.length > 0 && path[0] && path[0].nodeType === 1) {
          return path[0];
        }
      } catch (err) { /* ignore */ }
    }
    return e.target || getDeepActiveElement();
  }

  function setupGrammarlyListeners() {
    if (boundGlobalListeners || typeof document === 'undefined') return;
    boundGlobalListeners = true;

    // 1) When the user focuses or clicks into any comment or post editor on LinkedIn,
    // immediately surface the Grammarly-like floating AI widget inside that editor.
    var handleEditorActivate = function (e) {
      var target = getEventTarget(e);
      var ed = resolveEditableRoot(target) || resolveEditableRoot(getDeepActiveElement());
      if (ed) {
        isUserTyping = false;
        attachGrammarlyWidget(ed);
        injectPostComposerTriggers();
        return;
      }
      var btn = target ? safeClosest(target, 'button, [role="button"], .share-box-feed-entry__trigger, .share-box-feed-entry__closed-share-box, .share-box-feed-entry') : null;
      // If the user clicked LinkedIn's "Start a post" trigger at the top of the feed,
      // wait for LinkedIn to mount the post creation modal and attach the floating AI widget + AI Post button.
      if (btn && isStartPostTriggerButton(btn)) {
        waitForPostComposerEditor(4000).then(function (postEd) {
          injectPostComposerTriggers();
          if (postEd) {
            attachGrammarlyWidget(postEd, null);
          }
        });
        return;
      }
      // If the user clicked LinkedIn's native "Comment" trigger button, wait for LinkedIn
      // to mount the comment box and automatically attach the floating AI widget.
      if (btn && isCommentTriggerButton(btn)) {
        var post = findEnclosingPost(btn);
        if (post) {
          waitForEditor(post, 2500).then(function (openedEd) {
            if (openedEd) attachGrammarlyWidget(openedEd, post);
          });
        }
      }
    };

    document.addEventListener('focusin', handleEditorActivate, true);
    document.addEventListener('click', handleEditorActivate, true);
    document.addEventListener('input', function (e) {
      var ed = resolveEditableRoot(getEventTarget(e)) || resolveEditableRoot(getDeepActiveElement());
      if (ed) markEditorTyping(ed);
    }, true);
    document.addEventListener('keyup', function (e) {
      var ed = resolveEditableRoot(getEventTarget(e)) || resolveEditableRoot(getDeepActiveElement());
      if (ed) markEditorTyping(ed);
    }, true);

    if (typeof window !== 'undefined') {
      window.addEventListener('scroll', scheduleWidgetPositionUpdate, true);
      window.addEventListener('resize', scheduleWidgetPositionUpdate, true);
    }

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      try {
        chrome.storage.onChanged.addListener(function (changes) {
          if (!changes) return;
          if (changes.hideFloatingWidget) uiPrefs.hideFloatingWidget = Boolean(changes.hideFloatingWidget.newValue);
          if (changes.hideWhileTyping) uiPrefs.hideWhileTyping = Boolean(changes.hideWhileTyping.newValue);
          if (changes.hidePostActionButton) uiPrefs.hidePostActionButton = Boolean(changes.hidePostActionButton.newValue);
          applyUiPrefsNow();
        });
      } catch (e) { /* ignore */ }
    }
  }

  /* ---------------- boot ---------------- */

  function init() {
    if (!document || !document.body) return;

    refreshUiPrefs();
    setupGrammarlyListeners();
    scanForPosts();

    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var nodes = mutations[i].addedNodes;
        for (var j = 0; j < nodes.length; j++) {
          var node = nodes[j];
          if (!node || node.nodeType !== 1) continue;
          scheduleScan();
          return;
        }
      }
    });
    obs_start(observer);

    // Re-scan when LinkedIn swaps the view via SPA navigation, opens a shadow-root modal, or lazy hydrates.
    var lastUrl = typeof location !== 'undefined' ? location.href : '';
    setInterval(function () {
      if (typeof location !== 'undefined' && location.href !== lastUrl) {
        lastUrl = location.href;
        closePanel();
        hideGrammarlyWidget();
        scheduleScan();
        return;
      }
      injectPostComposerTriggers();
      var openPostEd = findPostComposerEditor();
      if (openPostEd && isElementVisible(openPostEd)) {
        if (activeEditor !== openPostEd && !dismissedEditors.has(openPostEd)) {
          attachGrammarlyWidget(openPostEd, null);
        } else {
          updateGrammarlyWidgetPosition();
        }
      } else if (activeEditor && isNodeInDocument(activeEditor)) {
        updateGrammarlyWidgetPosition();
      }
    }, 650);
  }

  function obs_start(observer) {
    try {
      observer.observe(document.body, { childList: true, subtree: true });
    } catch (e) { /* body may be replaced; retry shortly */ }
  }

  // Message from the popup: rescan the feed or open the composer immediately.
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || !msg.type) return;
      if (msg.type === 'rescan') {
        refreshUiPrefs();
        var stats = scanForPosts();
        var openPost = Boolean(msg.openComposer);
        if (openPost || stats.postsFound === 0) {
          var postComposerEd = findPostComposerEditor();
          if (postComposerEd && isElementVisible(postComposerEd)) {
            openPanel({
              post: null,
              editor: postComposerEd,
              anchor: floatingWidget || postComposerEd,
              channel: 'linkedin_post'
            });
          } else {
            var targetPost = (activeEditor && findEnclosingPost(activeEditor)) || findBestPostOnPage();
            if (targetPost) {
              openPanel({
                post: targetPost,
                editor: activeEditor || findCommentEditor(targetPost),
                anchor: floatingWidget || activeEditor || targetPost
              });
            }
          }
        } else {
          showToast('✨ AI Assistant ready on ' + stats.postsFound + ' post' + (stats.postsFound === 1 ? '' : 's') + '. Click any comment box or AI button.');
        }
        sendResponse({
          ok: true,
          postsFound: stats.postsFound,
          buttonsInjected: stats.buttonsInjected,
          editorsFound: stats.editorsFound
        });
        return true;
      }
      if (msg.type === 'updateUiPrefs') {
        syncUiPrefsFromItems(msg.prefs || {});
        if (!uiPrefs.hideFloatingWidget) {
          dismissedEditors = new WeakSet();
        }
        applyUiPrefsNow();
        sendResponse({ ok: true });
        return true;
      }
    });
  }

  function isExtensionContext() {
    return typeof chrome !== 'undefined' && chrome.runtime && !!chrome.runtime.id;
  }

  if (isExtensionContext()) {
    if (document && document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  /* ---------------- export for unit tests ---------------- */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      extractPostText: extractPostText,
      extractFromShowMore: extractFromShowMore,
      expandCollapsedPostText: expandCollapsedPostText,
      extractAuthorName: extractAuthorName,
      extractPostUrl: extractPostUrl,
      removeInvisible: removeInvisible,
      normalizeWhitespace: normalizeWhitespace,
      findActionBar: findActionBar,
      findCommentButton: findCommentButton,
      findCommentEditor: findCommentEditor,
      findEnclosingPost: findEnclosingPost,
      isCommentTriggerButton: isCommentTriggerButton,
      isInsideCommentSection: isInsideCommentSection,
      injectButton: injectButton,
      insertTextInto: insertTextInto,
      insertIntoComposer: insertIntoComposer,
      isXDraftEditor: isXDraftEditor,
      insertIntoXDraftEditor: insertIntoXDraftEditor,
      isPostComposerEditor: isPostComposerEditor,
      isStartPostTriggerButton: isStartPostTriggerButton,
      findPostComposerEditor: findPostComposerEditor,
      injectPostComposerTriggers: injectPostComposerTriggers,
      isLinkedInCommentEditor: isLinkedInCommentEditor,
      resolveEditableRoot: resolveEditableRoot,
      attachGrammarlyWidget: attachGrammarlyWidget,
      hideGrammarlyWidget: hideGrammarlyWidget,
      syncUiPrefsFromItems: syncUiPrefsFromItems,
      markEditorTyping: markEditorTyping,
      setupGrammarlyListeners: setupGrammarlyListeners,
      scanForPosts: scanForPosts,
      openPanel: openPanel,
      closePanel: closePanel,
      generateComment: generateComment,
      sanitizeFinalOutputText: sanitizeFinalOutputText,
      stopGeneration: stopGeneration,
      delay: delay,
      TONES: TONES,
      CHANNELS: CHANNELS,
      countWords: countWords
    };
  }
}());
