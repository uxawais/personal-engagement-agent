/*
 * LinkedIn & X Comment AI — Comment & Thought-Process History Page Controller
 */
(function () {
  'use strict';

  var COMMENT_HISTORY_KEY = 'commentHistory';

  var searchInput = document.getElementById('searchInput');
  var filterBar = document.getElementById('filterBar');
  var threadListEl = document.getElementById('threadList');
  var statsTodayEl = document.getElementById('statsToday');
  var statsInsertedEl = document.getElementById('statsInserted');
  var statsTotalEl = document.getElementById('statsTotal');
  var emptyStateEl = document.getElementById('emptyState');
  var threadDetailEl = document.getElementById('threadDetail');
  var detailPlatformBadge = document.getElementById('detailPlatformBadge');
  var detailDateText = document.getElementById('detailDateText');
  var detailTitle = document.getElementById('detailTitle');
  var detailPostLink = document.getElementById('detailPostLink');
  var deleteThreadBtn = document.getElementById('deleteThreadBtn');
  var detailPostMeta = document.getElementById('detailPostMeta');
  var detailPostText = document.getElementById('detailPostText');
  var turnsCountBadge = document.getElementById('turnsCountBadge');
  var turnsContainer = document.getElementById('turnsContainer');
  var openSettingsBtn = document.getElementById('openSettingsBtn');
  var exportMdBtn = document.getElementById('exportMdBtn');
  var exportJsonBtn = document.getElementById('exportJsonBtn');
  var importJsonBtn = document.getElementById('importJsonBtn');
  var importFileInput = document.getElementById('importFileInput');
  var clearAllBtn = document.getElementById('clearAllBtn');
  var toastEl = document.getElementById('toast');

  var allThreads = [];
  var activeFilter = 'all';
  var searchQuery = '';
  var selectedThreadId = null;

  function getInitialThreadIdFromUrl() {
    try {
      if (typeof location !== 'undefined' && location.search) {
        var params = new URLSearchParams(location.search);
        return params.get('thread') || null;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function toLocalDateKey(ts) {
    var d = ts ? new Date(ts) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function formatDayHeader(dateKey) {
    var todayKey = toLocalDateKey(Date.now());
    var yesterdayKey = toLocalDateKey(Date.now() - 86400000);
    if (dateKey === todayKey) return 'Today';
    if (dateKey === yesterdayKey) return 'Yesterday';
    var parts = String(dateKey || '').split('-');
    if (parts.length === 3) {
      var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      if (!isNaN(d.getTime())) {
        return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      }
    }
    return dateKey || 'Earlier';
  }

  function formatTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function formatFullDateTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
  }

  function showToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(function () {
      toastEl.hidden = true;
    }, 2600);
  }

  function copyText(text) {
    if (!text) return;
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        showToast('Copied to clipboard.');
      }).catch(function () {
        showToast('Copied to clipboard.');
      });
    } else {
      showToast('Copied to clipboard.');
    }
  }

  function platformLabel(thread) {
    var ch = String((thread && thread.channel) || '').toLowerCase();
    var p = String((thread && thread.platform) || '').toLowerCase();
    if (ch === 'linkedin_long') return 'LinkedIn Long Post';
    if (ch === 'linkedin_post') return 'LinkedIn Post';
    if (ch === 'x_post') return 'X Post';
    if (p === 'x') return 'X Comment';
    return 'LinkedIn Comment';
  }

  function threadHasUsedEntry(thread) {
    var entries = (thread && Array.isArray(thread.entries)) ? thread.entries : [];
    return entries.some(function (e) {
      return e && (e.status === 'inserted' || e.status === 'copied');
    });
  }

  function threadMatchesFilter(thread, filter, query) {
    if (!thread) return false;
    var entries = Array.isArray(thread.entries) ? thread.entries : [];
    if (!entries.length) return false;

    if (filter === 'used' && !threadHasUsedEntry(thread)) return false;
    if (filter === 'linkedin' && String(thread.platform || 'linkedin').toLowerCase() !== 'linkedin') return false;
    if (filter === 'x' && String(thread.platform || '').toLowerCase() !== 'x') return false;
    if (filter === 'posts') {
      var isPost = thread.channel === 'linkedin_post' || thread.channel === 'linkedin_long' || thread.channel === 'x_post' ||
        entries.some(function (e) { return e && (e.channel === 'linkedin_post' || e.channel === 'linkedin_long' || e.channel === 'x_post'); });
      if (!isPost) return false;
    }

    if (query) {
      var q = query.toLowerCase();
      var hay = [
        thread.postAuthor || '',
        thread.postText || '',
        thread.postUrl || ''
      ].join(' ').toLowerCase();
      var entryMatch = entries.some(function (e) {
        if (!e) return false;
        var eText = [
          e.comment || '',
          e.finalComment || '',
          e.thoughtProcess || '',
          e.nativeReasoning || '',
          e.tone || '',
          e.angle || '',
          e.model || ''
        ].join(' ').toLowerCase();
        return eText.indexOf(q) !== -1;
      });
      if (hay.indexOf(q) === -1 && !entryMatch) return false;
    }
    return true;
  }

  function updateStats() {
    var todayKey = toLocalDateKey(Date.now());
    var todayDrafts = 0;
    var insertedCount = 0;
    var totalDrafts = 0;

    allThreads.forEach(function (t) {
      if (!t || !Array.isArray(t.entries)) return;
      t.entries.forEach(function (e) {
        if (!e) return;
        totalDrafts++;
        if (toLocalDateKey(e.createdAt || t.updatedAt) === todayKey) {
          todayDrafts++;
        }
        if (e.status === 'inserted' || e.status === 'copied') {
          insertedCount++;
        }
      });
    });

    if (statsTodayEl) statsTodayEl.textContent = todayDrafts + ' today';
    if (statsInsertedEl) statsInsertedEl.textContent = insertedCount + ' inserted/copied';
    if (statsTotalEl) statsTotalEl.textContent = totalDrafts + ' total';
  }

  function renderSidebar() {
    updateStats();
    var filtered = allThreads.filter(function (t) {
      return threadMatchesFilter(t, activeFilter, searchQuery);
    });

    threadListEl.innerHTML = '';

    if (!filtered.length) {
      var emptyMsg = document.createElement('div');
      emptyMsg.style.cssText = 'padding: 24px 12px; text-align: center; font-size: 12.5px; color: #86868b;';
      emptyMsg.textContent = allThreads.length
        ? 'No threads match your current search or filter.'
        : 'No comments generated yet. Generate a comment on LinkedIn or X to see it here!';
      threadListEl.appendChild(emptyMsg);
      return;
    }

    var groups = [];
    var groupMap = Object.create(null);
    filtered.forEach(function (t) {
      var dk = t.dateKey || toLocalDateKey(t.updatedAt || t.createdAt);
      if (!groupMap[dk]) {
        groupMap[dk] = [];
        groups.push({ dateKey: dk, items: groupMap[dk] });
      }
      groupMap[dk].push(t);
    });

    groups.forEach(function (g) {
      var header = document.createElement('div');
      header.className = 'day-group-header';
      var daySpan = document.createElement('span');
      daySpan.textContent = formatDayHeader(g.dateKey);
      var countSpan = document.createElement('span');
      countSpan.textContent = g.items.length + (g.items.length === 1 ? ' post' : ' posts');
      header.appendChild(daySpan);
      header.appendChild(countSpan);
      threadListEl.appendChild(header);

      g.items.forEach(function (t) {
        var entries = Array.isArray(t.entries) ? t.entries : [];
        var latest = entries[entries.length - 1] || {};
        var chosen = entries.slice().reverse().find(function (e) { return e && e.status === 'inserted'; }) ||
          entries.slice().reverse().find(function (e) { return e && e.status === 'copied'; }) ||
          latest;

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'thread-item' + (t.threadId === selectedThreadId ? ' active' : '');
        btn.setAttribute('data-thread-id', t.threadId);

        var topRow = document.createElement('div');
        topRow.className = 'thread-item-top';
        var authorSpan = document.createElement('span');
        authorSpan.className = 'thread-author';
        var isPost = t.channel === 'linkedin_post' || t.channel === 'linkedin_long' || t.channel === 'x_post';
        authorSpan.textContent = t.postAuthor
          ? t.postAuthor
          : (isPost ? 'Original Post Draft' : 'LinkedIn / X Post');

        var timeSpan = document.createElement('span');
        timeSpan.className = 'thread-time';
        timeSpan.textContent = formatTime(t.updatedAt || t.createdAt);

        topRow.appendChild(authorSpan);
        topRow.appendChild(timeSpan);

        var postSnip = document.createElement('div');
        postSnip.className = 'thread-post-snippet';
        postSnip.textContent = t.postText
          ? ('Post: ' + String(t.postText).replace(/\s+/g, ' ').trim())
          : 'No post caption text';

        var commentPrev = document.createElement('div');
        commentPrev.className = 'thread-comment-preview';
        commentPrev.textContent = (chosen && (chosen.finalComment || chosen.comment)) || '';

        var metaRow = document.createElement('div');
        metaRow.className = 'thread-item-meta';

        var platBadge = document.createElement('span');
        platBadge.className = 'mini-badge';
        platBadge.textContent = platformLabel(t);
        metaRow.appendChild(platBadge);

        var draftsBadge = document.createElement('span');
        draftsBadge.className = 'mini-badge';
        draftsBadge.textContent = entries.length + (entries.length === 1 ? ' draft' : ' drafts');
        metaRow.appendChild(draftsBadge);

        var hasInserted = entries.some(function (e) { return e && e.status === 'inserted'; });
        var hasCopied = entries.some(function (e) { return e && e.status === 'copied'; });
        if (hasInserted) {
          var insBadge = document.createElement('span');
          insBadge.className = 'mini-badge inserted';
          insBadge.textContent = '✓ Inserted';
          metaRow.appendChild(insBadge);
        } else if (hasCopied) {
          var copBadge = document.createElement('span');
          copBadge.className = 'mini-badge copied';
          copBadge.textContent = '📋 Copied';
          metaRow.appendChild(copBadge);
        }

        btn.appendChild(topRow);
        btn.appendChild(postSnip);
        btn.appendChild(commentPrev);
        btn.appendChild(metaRow);

        btn.addEventListener('click', function () {
          selectedThreadId = t.threadId;
          renderSidebar();
          renderThreadDetail();
        });

        threadListEl.appendChild(btn);
      });
    });
  }

  function renderThreadDetail() {
    var thread = allThreads.find(function (t) { return t && t.threadId === selectedThreadId; });
    if (!thread) {
      emptyStateEl.hidden = false;
      threadDetailEl.hidden = true;
      return;
    }

    emptyStateEl.hidden = true;
    threadDetailEl.hidden = false;

    detailPlatformBadge.textContent = platformLabel(thread);
    detailDateText.textContent = formatFullDateTime(thread.updatedAt || thread.createdAt);

    var isPost = thread.channel === 'linkedin_post' || thread.channel === 'linkedin_long' || thread.channel === 'x_post';
    detailTitle.textContent = thread.postAuthor
      ? ('Replying to ' + thread.postAuthor)
      : (isPost ? 'Original Post Draft' : 'Replying to Post');

    if (thread.postUrl && /^https?:\/\//i.test(thread.postUrl)) {
      detailPostLink.href = thread.postUrl;
      detailPostLink.hidden = false;
    } else {
      detailPostLink.hidden = true;
    }

    var postWords = String(thread.postText || '').trim()
      ? String(thread.postText || '').trim().split(/\s+/).length
      : 0;
    detailPostMeta.textContent = (thread.postAuthor ? ('Author: ' + thread.postAuthor + ' · ') : '') + postWords + ' words';
    detailPostText.textContent = thread.postText || '(No post caption was captured for this draft.)';

    var entries = Array.isArray(thread.entries) ? thread.entries : [];
    turnsCountBadge.textContent = entries.length + (entries.length === 1 ? ' generation' : ' generations');
    turnsContainer.innerHTML = '';

    entries.forEach(function (entry, idx) {
      var card = document.createElement('article');
      card.className = 'turn-card' + (entry.status === 'inserted' ? ' is-inserted' : '');

      var metaRow = document.createElement('div');
      metaRow.className = 'turn-meta-row';

      var badgesWrap = document.createElement('div');
      badgesWrap.className = 'turn-badges';

      var numPill = document.createElement('span');
      numPill.className = 'turn-pill draft-num';
      numPill.textContent = 'Draft #' + (idx + 1);
      badgesWrap.appendChild(numPill);

      if (entry.status === 'inserted') {
        var stIns = document.createElement('span');
        stIns.className = 'turn-pill status-inserted';
        stIns.textContent = '✓ Inserted into box';
        badgesWrap.appendChild(stIns);
      } else if (entry.status === 'copied') {
        var stCop = document.createElement('span');
        stCop.className = 'turn-pill status-copied';
        stCop.textContent = '📋 Copied';
        badgesWrap.appendChild(stCop);
      }

      if (entry.tone) {
        var tonePill = document.createElement('span');
        tonePill.className = 'turn-pill';
        tonePill.textContent = 'Tone: ' + entry.tone;
        badgesWrap.appendChild(tonePill);
      }

      if (entry.angle) {
        var anglePill = document.createElement('span');
        anglePill.className = 'turn-pill';
        anglePill.textContent = 'Angle: ' + entry.angle;
        badgesWrap.appendChild(anglePill);
      }

      if (entry.model) {
        var modelPill = document.createElement('span');
        modelPill.className = 'turn-pill';
        modelPill.textContent = (entry.provider ? entry.provider + ' · ' : '') + entry.model;
        badgesWrap.appendChild(modelPill);
      }

      if (entry.seed) {
        var seedPill = document.createElement('span');
        seedPill.className = 'turn-pill seed-pill';
        seedPill.title = 'Entropy Hex Seed: ' + entry.seed;
        seedPill.textContent = 'Seed: ' + String(entry.seed).slice(0, 10) + '…';
        badgesWrap.appendChild(seedPill);
      }

      var timeEl = document.createElement('span');
      timeEl.className = 'turn-time';
      timeEl.textContent = formatFullDateTime(entry.createdAt);

      metaRow.appendChild(badgesWrap);
      metaRow.appendChild(timeEl);
      card.appendChild(metaRow);

      // Thought process box
      var thoughtBox = document.createElement('div');
      thoughtBox.className = 'thought-box';
      var thoughtHead = document.createElement('div');
      thoughtHead.className = 'thought-box-head';
      var thoughtTitle = document.createElement('span');
      thoughtTitle.className = 'thought-box-title';
      thoughtTitle.textContent = '🧠 Thought Process & Why It Wrote This Comment';
      thoughtHead.appendChild(thoughtTitle);

      var thoughtBody = document.createElement('div');
      thoughtBody.className = 'thought-box-body';
      thoughtBody.textContent = entry.thoughtProcess || entry.nativeReasoning || 'Thought process recorded for this generation.';

      thoughtBox.appendChild(thoughtHead);
      thoughtBox.appendChild(thoughtBody);
      card.appendChild(thoughtBox);

      // Generated Comment box
      var commentBox = document.createElement('div');
      commentBox.className = 'comment-box';
      var commentHead = document.createElement('div');
      commentHead.className = 'comment-box-head';
      var commentTitle = document.createElement('span');
      commentTitle.className = 'comment-box-title';
      commentTitle.textContent = (entry.channel === 'linkedin_post' || entry.channel === 'linkedin_long' || entry.channel === 'x_post')
        ? '💬 Generated Post'
        : '💬 Generated Comment';

      var copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'copy-turn-btn';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', function () {
        copyText(entry.finalComment || entry.comment);
      });

      commentHead.appendChild(commentTitle);
      commentHead.appendChild(copyBtn);

      var commentBody = document.createElement('div');
      commentBody.className = 'comment-box-body';
      commentBody.textContent = entry.comment || '';

      commentBox.appendChild(commentHead);
      commentBox.appendChild(commentBody);

      if (entry.finalComment && entry.finalComment !== entry.comment) {
        var editedBox = document.createElement('div');
        editedBox.className = 'final-edited-box';
        editedBox.textContent = '✓ Final Edited Version Inserted:\n' + entry.finalComment;
        commentBox.appendChild(editedBox);
      }

      card.appendChild(commentBox);
      turnsContainer.appendChild(card);
    });
  }

  function loadHistory(preserveSelection) {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(COMMENT_HISTORY_KEY, function (raw) {
        var list = (raw && Array.isArray(raw[COMMENT_HISTORY_KEY])) ? raw[COMMENT_HISTORY_KEY] : [];
        allThreads = list;
        var urlThread = !preserveSelection ? getInitialThreadIdFromUrl() : null;
        if (urlThread && allThreads.some(function (t) { return t && t.threadId === urlThread; })) {
          selectedThreadId = urlThread;
        } else if (!selectedThreadId || !allThreads.some(function (t) { return t && t.threadId === selectedThreadId; })) {
          selectedThreadId = allThreads[0] ? allThreads[0].threadId : null;
        }
        renderSidebar();
        renderThreadDetail();
      });
    } else {
      renderSidebar();
      renderThreadDetail();
    }
  }

  function buildMarkdownExport(threads) {
    var lines = [
      '# LinkedIn & X Comment AI — Comment & Thought-Process History',
      'Exported: ' + new Date().toISOString(),
      ''
    ];
    threads.forEach(function (t) {
      if (!t) return;
      lines.push('---');
      lines.push('## ' + (t.postAuthor ? ('Replying to ' + t.postAuthor) : 'Post Thread') + ' (' + (t.dateKey || '') + ')');
      if (t.postUrl) lines.push('- **Post URL:** ' + t.postUrl);
      lines.push('- **Platform:** ' + platformLabel(t));
      lines.push('');
      lines.push('### Original Post Caption');
      lines.push('> ' + String(t.postText || '(No caption)').replace(/\n/g, '\n> '));
      lines.push('');
      (t.entries || []).forEach(function (e, i) {
        lines.push('#### Draft #' + (i + 1) + ' — ' + (e.status === 'inserted' ? '✓ Inserted' : (e.status === 'copied' ? 'Copied' : 'Draft')) + ' (' + (e.model || '') + ' · Tone: ' + (e.tone || '') + ')');
        if (e.seed) lines.push('- **Seed:** `' + e.seed + '`');
        lines.push('- **Thought Process:**\n\n' + (e.thoughtProcess || ''));
        lines.push('\n- **Generated Comment:**\n\n' + (e.comment || ''));
        if (e.finalComment && e.finalComment !== e.comment) {
          lines.push('\n- **Final Inserted Text:**\n\n' + e.finalComment);
        }
        lines.push('');
      });
    });
    return lines.join('\n');
  }

  function triggerDownload(filename, content, mimeType) {
    var blob = new Blob([content], { type: mimeType || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  if (searchInput) {
    searchInput.addEventListener('input', function () {
      searchQuery = String(searchInput.value || '').trim();
      renderSidebar();
    });
  }

  if (filterBar) {
    filterBar.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('[data-filter]') : null;
      if (!btn) return;
      activeFilter = btn.getAttribute('data-filter') || 'all';
      var pills = filterBar.querySelectorAll('.filter-pill');
      for (var i = 0; i < pills.length; i++) {
        pills[i].classList.toggle('active', pills[i] === btn);
      }
      renderSidebar();
    });
  }

  if (deleteThreadBtn) {
    deleteThreadBtn.addEventListener('click', function () {
      if (!selectedThreadId) return;
      var targetId = selectedThreadId;
      allThreads = allThreads.filter(function (t) { return t && t.threadId !== targetId; });
      selectedThreadId = allThreads[0] ? allThreads[0].threadId : null;
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        var obj = {};
        obj[COMMENT_HISTORY_KEY] = allThreads;
        chrome.storage.local.set(obj, function () {
          renderSidebar();
          renderThreadDetail();
          showToast('Thread deleted.');
        });
      }
    });
  }

  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', function () {
      if (!allThreads.length) return;
      if (typeof window !== 'undefined' && window.confirm && !window.confirm('Clear all saved comment & thought-process history?')) {
        return;
      }
      allThreads = [];
      selectedThreadId = null;
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        var obj = {};
        obj[COMMENT_HISTORY_KEY] = [];
        chrome.storage.local.set(obj, function () {
          renderSidebar();
          renderThreadDetail();
          showToast('All history cleared.');
        });
      }
    });
  }

  if (exportMdBtn) {
    exportMdBtn.addEventListener('click', function () {
      var md = buildMarkdownExport(allThreads);
      triggerDownload('comment-history-' + toLocalDateKey(Date.now()) + '.md', md, 'text/markdown;charset=utf-8');
      showToast('Exported Markdown history.');
    });
  }

  if (exportJsonBtn) {
    exportJsonBtn.addEventListener('click', function () {
      var json = JSON.stringify({ exportedAt: new Date().toISOString(), threads: allThreads }, null, 2);
      triggerDownload('comment-history-' + toLocalDateKey(Date.now()) + '.json', json, 'application/json;charset=utf-8');
      showToast('Exported JSON backup.');
    });
  }

  if (importJsonBtn && importFileInput) {
    importJsonBtn.addEventListener('click', function () {
      importFileInput.click();
    });
    importFileInput.addEventListener('change', function () {
      var file = importFileInput.files && importFileInput.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var parsed = JSON.parse(String(reader.result || '{}'));
          var incoming = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.threads) ? parsed.threads : []);
          if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ type: 'importHistory', threads: incoming }, function () {
              loadHistory(false);
              showToast('Imported ' + incoming.length + ' thread(s).');
            });
          }
        } catch (err) {
          showToast('Invalid JSON backup file.');
        }
      };
      reader.readAsText(file);
    });
  }

  if (openSettingsBtn) {
    openSettingsBtn.addEventListener('click', function () {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
      }
    });
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes) {
      if (changes && changes[COMMENT_HISTORY_KEY]) {
        loadHistory(true);
      }
    });
  }

  loadHistory(false);
}());
