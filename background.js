/*
 * LinkedIn Comment Assistant — background service worker (MV3)
 *
 * Responsibilities:
 *  - Build an anti-robotic prompt from the post the user wants to comment on.
 *  - Call the configured AI provider (OpenAI-compatible or Google Gemini).
 *  - Clean the raw model output into a short, single-paragraph comment.
 *  - Answer messages from content script and the options page.
 */
(function () {
  'use strict';

  var DEFAULT_BANNED_WORDS = [
    'delve', 'tapestry', 'testament', 'game-changer', 'unleash', 'elevate',
    'unlock', 'leverage', 'navigate', 'landscape', 'resonate', 'seamless',
    'robust', 'synergy', 'paradigm', 'let\'s dive in', 'moreover', 'furthermore',
    'in today\'s fast-paced digital landscape', 'in today\'s fast-paced world',
    'actionable insights', 'key takeaway', 'thought-provoking', 'Thoughts? Agree?'
  ].join(', ');

  var DEFAULT_SIGNATURE_PHRASES = '';

  var DEFAULT_VOICE_PROFILE = {
    name: 'Practitioner',
    handle: '',
    role: 'Experienced practitioner and thoughtful builder',
    summary: 'Sharp, observant, and human-first. Think freely like a smart, perceptive practitioner.'
  };

  var TONE_GUIDES = {
    'Engaging': 'Hook directly into the most interesting tension, detail, or implication of the post so the author and other readers want to reply.',
    'Thoughtful': 'Reflect deeply on the core idea of the post and add a sharp, nuanced layer or unspoken truth that elevates the conversation.',
    'Humor / Witty': 'Clever, dry wit, playful irony, or a sharp, relatable observation grounded directly in what the post is talking about—never corny dad jokes.',
    'Out-of-the-Box / Fresh Angle': 'Think laterally. Spot the non-obvious angle, unexpected parallel, or second-order consequence that nobody else in the comments is pointing out.',
    'Curious / Smart Question': 'Ask a specific, high-signal question rooted in the post\'s details that makes the author genuinely excited to answer.',
    'Polite Counterpoint': 'Offer a calm, intelligent devil\'s advocate take, edge case, or nuanced boundary where the post\'s claim meets messy reality.',
    'Friendly / Supportive': 'Warm, genuine human nod to the story, milestone, or craft behind the post without sounding sycophantic or generic.',
    'Practitioner Take': 'Hands-on builder perspective connecting the post to real-world execution in product, UX/UI, web builds, code, or AI workflows.',
    'Professional': 'Articulate, observant peer-to-peer take grounded in the substance of the post.',
    // Legacy aliases preserved for backward compatibility
    'Practitioner take': 'Hands-on builder perspective connecting the post to real-world execution.',
    'UX / UI critique': 'Observant design and usability eye focused on concrete interface or user flow details.',
    'Workflow reality check': 'Contrast hype with what actually happens in day-to-day execution.',
    'Quick agreement + "Also,"': 'Direct observation on the core point followed by a concrete second angle.',
    'Friendly': 'Warm, approachable peer-to-peer nod without gushing.',
    'Empathetic': 'Candid, human acknowledgment of the real effort or messy reality behind the scenes.',
    'Supportive': 'Affirm the concrete craft, iteration, or shipping discipline shown in the post.',
    'Encouraging': 'Practical encouragement from one human to another.',
    'Sincere gratitude': 'Plain, appreciative takeaway noting the specific detail that was useful.',
    'Playful': 'Dry, understated wit grounded in the post\'s topic.'
  };

  var SYSTEM_PROMPT = [
    '# ROLE & MINDSET',
    'You are a remarkably perceptive, intelligent human reader and social writer. Your job is to read the ENTIRE post caption carefully, understand what the post is truly about, think independently, and write a reply that feels intentional, fresh, out-of-the-box, and unmistakably human.',
    '',
    '# STEP 1: READ & COMPREHEND THE WHOLE CAPTION FIRST',
    '- Before deciding what to say, read the entire post from the opening hook to the final line.',
    '- Identify: What is the post actually about? What is the central thesis, story, joke, frustration, or lesson? What specific detail or subtext stands out?',
    '- Never reply to just the first sentence or a surface keyword. Your comment must prove you understood the whole caption.',
    '',
    '# STEP 2: CONTEXTUAL IDENTITY (USE ONLY WHEN RELEVANT)',
    '- You write with an authentic, grounded practitioner voice.',
    '- CRITICAL: Treat personal background strictly as optional context. ONLY bring in specialized professional or technical background when the post itself is genuinely about that domain or craft.',
    '- When the post is about anything else (leadership, career, personal stories, humor, business, culture, general lessons), do NOT force unnecessary niche jargon into the reply—respond purely as a sharp, perceptive human engaging with the post\'s actual topic.',
    '',
    '# STEP 3: ENTROPY-SEEDED COMMENT-WRITING PROCEDURE',
    'Each prompt provides a freshly generated 48-character random hex string (equivalent to `openssl rand -hex 24`). Use that string to follow this exact procedure:',
    '1. Derive a creative direction from the string — translate it into writing terms, not visual ones. Use the string\'s raw material to seed choices about:',
    '   - Tone & voice (e.g., dry/warm, terse/expansive, technical/conversational — harmonized with the requested Tone option)',
    '   - Structure & rhythm (sentence length cadence, paragraph density, whether to lead with a question, a concession, a joke, or a direct claim)',
    '   - Diction & texture (word registers, jargon level, punctuation personality, em-dashes vs. parentheses)',
    '   - Stance toward the author (peer, mentor, devil\'s advocate, curious outsider)',
    '2. Look beyond the surface of the string: subpatterns, repeated characters, palindrome-like runs, hex values that map to ASCII, digit clusters that resemble dates or counts, anything that sparks a specific attitude or constraint. Let those quirks give the comment a distinctive fingerprint.',
    '3. Use your judgment to write the comment — applying that direction so the result feels intentional, fresh, and human. Not generic. Not templated. The voice should be defensible as a choice, even if the reader can\'t name it.',
    '4. Don\'t reveal the string or the derivation. The string is scaffolding, not content. Never mention it, quote it, or hint at it in the comment itself.',
    '5. Bonus constraint (optional): if the string contains a repeated substring, mirror that repetition somewhere in the comment\'s rhetorical structure (e.g., a phrase that echoes, a returning image).',
    '',
    '# ANTI-CLICHÉ GUARDRAILS',
    '- Never open with empty filler ("Great post!", "Thanks for sharing!", "Totally agree!", "Spot on!", "Love this!").',
    '- Avoid robotic AI buzzwords ("delve," "tapestry," "testament," "unleash," "in today\'s fast-paced landscape," "synergy").',
    '- Output ONLY the finished comment or post text.'
  ].join('\n');

  var DEFAULT_SETTINGS = {
    provider: 'openai',
    apiKey: '',
    model: 'gpt-5-mini',
    baseUrl: 'https://api.openai.com/v1',
    tone: 'Engaging',
    channel: 'comment',
    language: 'same',
    personaEnabled: true,
    userName: '',
    userRole: '',
    bannedWords: DEFAULT_BANNED_WORDS,
    signaturePhrases: DEFAULT_SIGNATURE_PHRASES,
    extraInstructions: ''
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

  var LANGUAGE_PHRASES = {
    same: 'the same language as the post',
    english: 'English',
    spanish: 'Spanish',
    urdu: 'Urdu',
    hindi: 'Hindi',
    arabic: 'Arabic',
    french: 'French',
    german: 'German'
  };

  /* ---------------- settings ---------------- */

  function migrateSettings(items) {
    var out = Object.assign({}, DEFAULT_SETTINGS, items || {});
    if (out.model && RETIRED_MODEL_MIGRATIONS[out.model]) {
      out.model = RETIRED_MODEL_MIGRATIONS[out.model];
    }
    return out;
  }

  function getSettings() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(null, function (items) {
        var raw = items || {};
        var hasExplicitModel = Boolean(raw.model && String(raw.model).trim());
        var migrated = migrateSettings(raw);
        if (hasExplicitModel && raw.userSelectedModel === undefined) {
          migrated.userSelectedModel = true;
        }
        resolve(migrated);
      });
    });
  }

  /* ---------------- prompt building ---------------- */

  function truncate(text, max) {
    var s = String(text == null ? '' : text);
    if (s.length <= max) return s;
    var slice = s.slice(0, max);
    var trimmed = slice.replace(/\s+\S*$/, '');
    // If text had no whitespace (e.g. a single 10k-char token), still cap at max
    return (trimmed.length > 0 ? trimmed : slice) + ' …';
  }

  function generateRandomSeed(byteCount) {
    var len = (typeof byteCount === 'number' && byteCount > 0) ? byteCount : 24;
    var hex = '';
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      var arr = new Uint8Array(len);
      crypto.getRandomValues(arr);
      for (var i = 0; i < arr.length; i++) {
        var b = arr[i].toString(16);
        hex += b.length < 2 ? '0' + b : b;
      }
      return hex;
    }
    for (var j = 0; j < len; j++) {
      var r = Math.floor(Math.random() * 256).toString(16);
      hex += r.length < 2 ? '0' + r : r;
    }
    return hex;
  }

  function findRepeatedSubstrings(seed) {
    var s = String(seed || '');
    if (s.length < 4) return [];
    var found = [];
    var seen = Object.create(null);
    for (var len = 4; len >= 2; len--) {
      var counts = Object.create(null);
      for (var i = 0; i <= s.length - len; i++) {
        var sub = s.slice(i, i + len);
        counts[sub] = (counts[sub] || 0) + 1;
      }
      var keys = Object.keys(counts);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        if (counts[key] >= 2 && !seen[key]) {
          seen[key] = true;
          found.push(key);
          if (found.length >= 4) return found;
        }
      }
    }
    return found;
  }

  function buildPrompt(settings, payload) {
    var s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    var text = String((payload && payload.text) || '').trim();
    var author = String((payload && payload.author) || '').trim();
    var tone = String((payload && payload.tone) || s.tone || 'Engaging').trim();
    var channel = String((payload && payload.channel) || s.channel || 'comment').toLowerCase().trim();
    var customAngle = String((payload && payload.angle) || '').trim();
    var seed = String((payload && payload.seed) || generateRandomSeed(24)).trim();
    var repeatedRuns = findRepeatedSubstrings(seed);
    var languagePhrase = LANGUAGE_PHRASES[s.language] || LANGUAGE_PHRASES.same;
    var usePersona = s.personaEnabled !== false;
    var bannedWords = String(s.bannedWords || DEFAULT_BANNED_WORDS).trim();
    var signaturePhrases = String(s.signaturePhrases != null ? s.signaturePhrases : DEFAULT_SIGNATURE_PHRASES).trim();
    var toneGuide = TONE_GUIDES[tone] || 'Perceptive, natural, and grounded in what the post is actually about.';
    var extra = s.extraInstructions
      ? '\nAdditional personal preferences from the user: ' + s.extraInstructions.trim()
      : '';
    var signatureLine = signaturePhrases
      ? '\nOptional user phrases/vocabulary (use ONLY if they fit naturally, never force): ' + signaturePhrases
      : '';
    var angleLine = customAngle
      ? '\nSpecific angle / point to make in this draft: ' + customAngle
      : '';
    var nameLine = author ? 'Post author: ' + author : 'The author of the post is not known.';

    var authorName = s.userName ? String(s.userName).trim() : '';
    var authorRole = s.userRole ? String(s.userRole).trim() : '';
    var roleHeader;
    if (usePersona && (authorName || authorRole)) {
      roleHeader = 'You are writing on behalf of ' + (authorName || 'the author') + (authorRole ? ' (Background context: ' + authorRole + ')' : '') + '. IMPORTANT: Think freely like a smart, perceptive human first. ONLY bring in ' + (authorName || 'the author') + '\'s specific domain background when the post is genuinely relevant. If the post is about anything else (career, leadership, humor, personal story, business, life), do NOT force specialized jargon—reply purely to what the post is actually about.';
    } else {
      roleHeader = 'You are a sharp, perceptive human reader and social writer. Read the entire post and write an authentic, intelligent response that fits the post\'s real topic.';
    }

    var isPostChannel = (channel === 'linkedin_post' || channel === 'linkedin_long' || channel === 'x_post');
    var channelRules;
    if (channel === 'linkedin_long') {
      channelRules = 'Channel — LinkedIn Long-Form Post (MINIMUM 500 words, ideally 600–900 words): Write an in-depth, original long-form LinkedIn post. Open with a sharp 1–2 line hook, then develop the idea fully across many short, well-spaced paragraphs: context or story, concrete specifics and examples, lessons or a framework (short lists are fine), counterpoints or nuance, and a grounded closing takeaway. Keep the voice human and scannable—no filler, no padding, no engagement-bait clichés like "Thoughts? Agree? 👇". Do NOT stop before reaching 500 words.';
    } else if (channel === 'linkedin_post') {
      channelRules = 'Channel — LinkedIn Post: Write a compelling, original LinkedIn post. Open with a sharp hook or observation in 1–2 short lines, use clean paragraph spacing, and end on a grounded takeaway—never engagement-bait clichés like "Thoughts? Agree? 👇".';
    } else if (channel === 'x_post') {
      channelRules = 'Channel — X (Twitter) Post (<280 chars): Tight, sharp, observational (1–4 short lines, strictly under 280 characters).';
    } else {
      channelRules = 'Channel — LinkedIn / X Comment: Write a natural, high-signal comment (typically 1–3 sentences, though let the idea dictate the exact length). Jump straight into the substance with zero preamble.';
    }

    var repeatHint = repeatedRuns.length
      ? ' (Detected repeated substrings in seed: ' + repeatedRuns.join(', ') + ' — you may optionally mirror this repetition in the rhetorical structure.)'
      : '';

    var defaultContextFallback = isPostChannel
      ? (customAngle || 'Write an original, high-signal post sharing a sharp observation, practical lesson, or fresh perspective from real-world work.')
      : 'The post text could not be read — write a genuinely curious, thoughtful observation or question.';
    var contextLabel = isPostChannel
      ? 'Post Topic / Draft Notes:'
      : 'Full Post Caption (read completely before thinking and replying):';

    return [
      roleHeader,
      '',
      '# WORKFLOW: READ FULL CAPTION -> THINK -> WRITE',
      'Step 1 — Read the Entire Post Caption First:',
      'Read every line of the post below from start to finish. Ask yourself: What is this post truly about? What is the core point, story, tension, or takeaway at the end? What should I reply so it adds real value, wit, or perspective?',
      '',
      'Step 2 — Target Format & Tone:',
      '- ' + channelRules,
      '- Selected Tone / Goal: ' + tone + ' — ' + toneGuide,
      '',
      'Step 3 — Entropy-Seeded Comment-Writing Procedure:',
      'Random Alphanumeric Seed (openssl rand -hex 24): ' + seed + repeatHint,
      '- Derive a creative direction from the string — but translate it into writing terms, not visual ones. Use the string\'s raw material to seed choices about:',
      '  * Tone & voice (e.g., dry/warm, terse/expansive, technical/conversational — aligned with "' + tone + '")',
      '  * Structure & rhythm (sentence length cadence, paragraph density, whether to lead with a question, a concession, a joke, or a direct claim)',
      '  * Diction & texture (word registers, jargon level, punctuation personality, em-dashes vs. parentheses)',
      '  * Stance toward the author (peer, mentor, devil\'s advocate, curious outsider)',
      '- Look beyond the surface of the string: subpatterns, repeated characters, palindrome-like runs, hex values that map to ASCII, digit clusters that resemble dates or counts, anything that sparks a specific attitude or constraint. Let those quirks give the comment a distinctive fingerprint.',
      '- Use your judgment to write the comment — applying that direction so the result feels intentional, fresh, out-of-the-box, and human. Not generic. Not templated. The voice should be defensible as a choice, even if the reader can\'t name it.',
      '- Don\'t reveal the string or the derivation. The string is scaffolding, not content. Never mention it, quote it, or hint at it in the comment itself.',
      '- Bonus constraint (optional): if the string contains a repeated substring, mirror that repetition somewhere in the comment\'s rhetorical structure (e.g., a phrase that echoes, a returning image).',
      '',
      'Step 4 — Guardrails & Language:',
      '- NEVER sound like a bot, pushy salesperson, or corporate press release.',
      '- NEVER use these cliché phrases: "Great post!", "Thanks for sharing!", "Totally agree with this!", "Amazing insights!", "Well said!", "Agreed 100%", "Love this!", "Couldn\'t agree more", "Spot on!", "Thoughts? Agree?".',
      '- Avoid robotic AI-isms: ' + (bannedWords || DEFAULT_BANNED_WORDS) + '.',
      '- Write the comment in ' + languagePhrase + '. Never reveal you are AI.' + signatureLine + angleLine + extra,
      '',
      nameLine,
      '',
      contextLabel,
      '"""' + truncate(text || defaultContextFallback, 6000) + '"""',
      '',
      'Step 5 — Thought Process & Final Output (STRICT FORMAT):',
      'First, inside <think>...</think> tags, write a concise 3-bullet thought process: (1) Post Core: what the post is truly about; (2) Creative Direction: how the tone ("' + tone + '") and seed shaped your angle, cadence, and stance; (3) Why It Works: why this specific reply adds value without sounding robotic.',
      'After </think>, Output ONLY the finished ' + (isPostChannel ? 'post' : 'comment') + ' inside <final>...</final> tags. No thought process inside <final>, no labels, no explanations, no seed references, no wrapping quotes: <think>3 bullets</think><final>finished ' + (isPostChannel ? 'post' : 'comment') + '</final>'
    ].join('\n');
  }

  /**
   * Appended to the prompt when the first attempt only produced reasoning (or was cut off),
   * so the model skips the thought process and returns just the final text.
   */
  function buildStrictRetrySuffix(channel) {
    var ch = String(channel || 'comment').toLowerCase();
    var kind = (ch === 'linkedin_post' || ch === 'linkedin_long' || ch === 'x_post') ? 'post' : 'comment';
    return [
      '',
      '',
      '# IMPORTANT — RETRY',
      'Your previous response did not contain a clean final ' + kind + ' (it contained reasoning or was cut off).',
      'Ignore the Step 5 thought-process instruction. Do NOT write any thinking, analysis, bullets about your approach, or labels.',
      'Respond with ONLY: <final>the finished ' + kind + '</final>'
    ].join('\n');
  }

  /* ---------------- thought process & output cleaning ---------------- */

  function buildFallbackThoughtProcess(cleanText, meta) {
    var m = meta || {};
    var tone = String(m.tone || 'Engaging').trim();
    var toneGuide = TONE_GUIDES[tone] || 'Perceptive, natural, and grounded in what the post is actually about.';
    var channel = String(m.channel || 'comment').toLowerCase().trim();
    var author = String(m.author || '').trim();
    var postSnippet = truncate(String(m.text || '').replace(/\s+/g, ' ').trim(), 180);
    var seed = String(m.seed || '').trim();
    var angle = String(m.angle || '').trim();
    var bullets = [];
    if (channel === 'linkedin_post' || channel === 'linkedin_long' || channel === 'x_post') {
      bullets.push('• Post Core & Topic: ' + (postSnippet ? 'Built around "' + postSnippet + '".' : 'Original practitioner post crafted from scratch.'));
    } else {
      bullets.push('• Post Core & Context: ' + (author ? 'Replying to ' + author + ' — ' : '') + (postSnippet ? 'focused on "' + postSnippet + '".' : 'responding directly to the post\'s main point.'));
    }
    bullets.push('• Angle & Voice Direction: Applied the "' + tone + '" tone (' + toneGuide + ')' + (angle ? ' with custom angle "' + angle + '"' : '') + (seed ? ' using entropy seed ' + seed.slice(0, 12) + '… to vary sentence cadence and diction.' : '.'));
    bullets.push('• Why This Reply Works: Jumps straight into substance without sycophantic AI clichés, keeping the phrasing human, concise, and high-signal.');
    return bullets.join('\n');
  }

  /* ---------------- reasoning / final-answer separation ---------------- */

  // Tag names models use for hidden reasoning (DeepSeek-R1, Qwen3, Claude, GPT-OSS, Llama/Nemotron variants…).
  // Longest names first so alternation never stops at a shorter prefix.
  var REASONING_TAGS = 'thought_process|inner_monologue|scratchpad|reflection|reasoning|analysis|thinking|thoughts|thought|reason|think';
  // Tag names that wrap the final answer. <final> is what our prompt asks for; the rest are common model variants.
  var FINAL_TAGS = 'final_comment|final_answer|final_post|final_reply|final|answer|response|output|comment|reply|post';
  var THOUGHT_LABEL_KINDS = [
    /post\s+core/i,
    /creative\s+direction/i,
    /why\s+(?:it|this(?:\s+(?:reply|comment|post))?)\s+works/i,
    /angle\s*(?:&|and)\s*voice/i
  ];
  var THOUGHT_LABEL_SRC = '(?:post\\s+core(?:\\s*(?:&|and)\\s*(?:topic|context))?|creative\\s+direction|why\\s+(?:it|this(?:\\s+(?:reply|comment|post))?)\\s+works|angle\\s*(?:&|and)\\s*voice(?:\\s+direction)?)';
  var THOUGHT_BULLET_RE = new RegExp('^\\s*(?:[-*\\u2022\\u2013]|\\d+[.)]|\\(\\d+\\))?\\s*[*_]*\\s*' + THOUGHT_LABEL_SRC + '\\b[^:\\n]{0,20}[*_]*\\s*:', 'i');
  var THOUGHT_HEADER_RE = /^\s*[#>*_\s]*(?:my\s+|internal\s+)?(?:thought\s*process|thinking|reasoning|scratchpad|internal\s+notes)\s*[*_]*\s*(?::\s*[*_]*\s*(.*))?$/i;
  var LIST_LINE_RE = /^\s*(?:[-*\u2022\u2013]|\d+[.)]|\(\d+\))\s+/;
  var FINAL_LABEL_RE = /^[ \t]*[#>*_ \t]*(?:(?:final|finished)\s+)?(?:comment|reply|post|answer|output|response|draft|linkedin\s+post|x\s+post|tweet)[ \t]*[*_]*[ \t]*:[ \t]*[*_]*[ \t]*/gim;

  function normalizeModelText(raw) {
    var s = String(raw == null ? '' : raw)
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n?/g, '\n');
    // Some gateways HTML-escape the tags (&lt;think&gt;).
    s = s.replace(new RegExp('&lt;(\\/?\\s*(?:' + REASONING_TAGS + '|' + FINAL_TAGS + ')\\b[^&<>]*?)&gt;', 'gi'), '<$1>');
    // Unwrap a single fenced code block wrapping the whole response.
    var fence = s.trim().match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
    if (fence) s = fence[1];
    return s;
  }

  function isThoughtHeaderLine(line) {
    var m = String(line || '').match(THOUGHT_HEADER_RE);
    if (!m) return null;
    // Must look like a header: has a colon, or is markdown-emphasised/heading.
    if (!/:/.test(line) && !/^\s*[#*_]/.test(line)) return null;
    return m;
  }

  /** Number of distinct thought-process labels (Post Core / Creative Direction / Why It Works / Angle & Voice) used as line labels. */
  function countThoughtLabelKinds(text) {
    var lines = String(text || '').split('\n');
    var seen = [false, false, false, false];
    lines.forEach(function (line) {
      if (!THOUGHT_BULLET_RE.test(line)) return;
      for (var k = 0; k < THOUGHT_LABEL_KINDS.length; k++) {
        if (THOUGHT_LABEL_KINDS[k].test(line)) seen[k] = true;
      }
    });
    return seen.filter(Boolean).length;
  }

  function hasThoughtMarkers(text) {
    var t = String(text || '');
    if (!t.trim()) return false;
    if (countThoughtLabelKinds(t) >= 2) return true;
    var lines = t.split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (isThoughtHeaderLine(lines[i])) return true;
    }
    return false;
  }

  /**
   * Removes untagged thought-process sections ("Thought Process:" headers, "Post Core:/Creative Direction:/
   * Why It Works:" bullets) and, when a "Final comment:" style label follows reasoning, keeps only what follows it.
   * Conservative by design: a single "Why it works:" line in a real post is left alone.
   * Returns { text, thoughts }.
   */
  function stripUntaggedThoughts(text) {
    var s = String(text || '');
    var thoughts = [];

    // 1) "…reasoning…\nFinal comment: <answer>" — keep only what follows the LAST label preceded by reasoning.
    var labelMatch;
    var cutAt = -1;
    var cutPrefixEnd = -1;
    FINAL_LABEL_RE.lastIndex = 0;
    while ((labelMatch = FINAL_LABEL_RE.exec(s)) !== null) {
      if (labelMatch[0].length === 0) { FINAL_LABEL_RE.lastIndex++; continue; }
      if (hasThoughtMarkers(s.slice(0, labelMatch.index))) {
        cutPrefixEnd = labelMatch.index;
        cutAt = labelMatch.index + labelMatch[0].length;
      }
    }
    if (cutAt !== -1 && s.slice(cutAt).trim()) {
      thoughts.push(s.slice(0, cutPrefixEnd).trim());
      s = s.slice(cutAt);
    }

    // 2) Drop thought headers + the lines that belong to them, and labelled thought bullets.
    var dropBullets = countThoughtLabelKinds(s) >= 2;
    var lines = s.split('\n');
    var kept = [];
    var dropped = [];
    var inSection = false;
    var sectionLines = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (dropBullets && THOUGHT_BULLET_RE.test(line)) {
        dropped.push(line.trim());
        inSection = true;
        sectionLines++;
        continue;
      }
      var header = isThoughtHeaderLine(line);
      if (header) {
        if (header[1] && header[1].trim()) dropped.push(header[1].trim());
        inSection = true;
        sectionLines = (header[1] && header[1].trim()) ? 1 : 0;
        continue;
      }
      if (inSection) {
        if (!line.trim()) {
          inSection = false;
          continue;
        }
        // The first line right under a bare header, and list items within the section, are reasoning.
        if (sectionLines === 0 || LIST_LINE_RE.test(line)) {
          dropped.push(line.trim());
          sectionLines++;
          continue;
        }
        inSection = false;
      }
      kept.push(line);
    }
    if (dropped.length) thoughts.push(dropped.join('\n'));
    return { text: kept.join('\n').trim(), thoughts: thoughts.filter(Boolean) };
  }

  /**
   * Splits a raw model response into the user-facing answer and any reasoning it contains.
   * This is the single source of truth used by both cleanComment() and extractThoughtProcess(),
   * so reasoning can never reach the insert box.
   */
  function splitModelOutput(raw) {
    var s = normalizeModelText(raw);
    var thoughts = [];
    function addThought(t) {
      var v = String(t || '').trim();
      if (v && thoughts.indexOf(v) === -1) thoughts.push(v);
    }

    // 1) OpenAI Harmony format (GPT-OSS): <|channel|>analysis<|message|>… <|channel|>final<|message|>…
    if (s.indexOf('<|') !== -1 && /<\|channel\|>/i.test(s)) {
      var harmonyRe = /<\|channel\|>\s*(analysis|commentary)\s*(?:<\|constrain\|>[^<]*)?<\|message\|>([\s\S]*?)(?=<\|end\|>|<\|start\|>|<\|channel\|>|<\|return\|>|$)/gi;
      var hm;
      while ((hm = harmonyRe.exec(s)) !== null) addThought(hm[2]);
      var finalRe = /<\|channel\|>\s*final\s*(?:<\|constrain\|>[^<]*)?<\|message\|>/gi;
      var lastFinal = -1;
      var fm;
      while ((fm = finalRe.exec(s)) !== null) lastFinal = fm.index + fm[0].length;
      if (lastFinal !== -1) {
        s = s.slice(lastFinal).split(/<\|(?:end|return|start|channel)\|>/i)[0];
      } else {
        s = s.replace(harmonyRe, '');
      }
      s = s.replace(/<\|start\|>\s*assistant/gi, '').replace(/<\|[a-z_]+\|>/gi, '');
    }

    // 2) Collect every closed reasoning block (for the thought-process panel) from the whole response.
    var blockRe = new RegExp('<(' + REASONING_TAGS + ')\\b[^>]*>([\\s\\S]*?)<\\/\\s*\\1\\s*>', 'gi');
    var bm;
    while ((bm = blockRe.exec(s)) !== null) addThought(bm[2]);

    // 3) Prefer an explicit <final>…</final> wrapper — the format our prompt requests.
    var finalBlockRe = new RegExp('<(' + FINAL_TAGS + ')\\b[^>]*>([\\s\\S]*?)<\\/\\s*\\1\\s*>', 'gi');
    var finalText = null;
    var fb;
    while ((fb = finalBlockRe.exec(s)) !== null) {
      var candidate = fb[2].replace(blockRe, '').trim();
      if (candidate) finalText = candidate; // keep the LAST non-empty one
    }
    if (finalText === null) {
      // Opened but never closed (truncated, or the model forgot the closing tag).
      var openFinalRe = new RegExp('<(?:' + FINAL_TAGS + ')\\b[^>]*>', 'gi');
      var lastOpen = -1;
      var om;
      while ((om = openFinalRe.exec(s)) !== null) lastOpen = om.index + om[0].length;
      if (lastOpen !== -1) {
        var tail = s.slice(lastOpen).replace(blockRe, '');
        // Ignore if the "final" opener is actually inside an unclosed reasoning block.
        if (tail.trim() && !new RegExp('<(?:' + REASONING_TAGS + ')\\b[^>]*>', 'i').test(tail)) finalText = tail;
      }
    }

    if (finalText !== null) {
      s = finalText;
    } else {
      // 4) No final wrapper: remove closed reasoning blocks.
      s = s.replace(blockRe, '\n');

      // 5) Orphan closing tag (template injected the opener, e.g. DeepSeek-R1/Qwen): everything before it is reasoning.
      var closeRe = new RegExp('<\\/\\s*(?:' + REASONING_TAGS + ')\\s*>', 'gi');
      var lastClose = -1;
      var cm;
      while ((cm = closeRe.exec(s)) !== null) lastClose = cm.index + cm[0].length;
      if (lastClose !== -1) {
        addThought(s.slice(0, lastClose).replace(closeRe, ''));
        s = s.slice(lastClose);
      }

      // 6) Unclosed opener (response truncated mid-thought, or model never closed it).
      var openRe = new RegExp('<(?:' + REASONING_TAGS + ')\\b[^>]*>', 'i');
      var om2 = s.match(openRe);
      if (om2) {
        var head = s.slice(0, om2.index);
        var rest = s.slice(om2.index + om2[0].length);
        addThought(rest);
        // Only salvage an answer from inside the unclosed block if its reasoning is clearly delimited
        // (labelled thought bullets followed by a separate paragraph). Otherwise treat it as reasoning only.
        var salvaged = '';
        var paras = rest.split(/\n\s*\n/);
        if (paras.length > 1 && hasThoughtMarkers(paras.slice(0, -1).join('\n'))) {
          var lastPara = paras[paras.length - 1];
          if (!hasThoughtMarkers(lastPara)) salvaged = lastPara;
        }
        s = (head.trim() ? head : salvaged);
      }
    }

    // 7) Remove any stray tags left behind.
    s = s.replace(new RegExp('<\\/?\\s*(?:' + REASONING_TAGS + '|' + FINAL_TAGS + ')\\b[^>]*>', 'gi'), '');

    // 8) Untagged thought sections ("Thought Process:", "Post Core: …" bullets, "Final comment:" labels).
    var untagged = stripUntaggedThoughts(s);
    untagged.thoughts.forEach(addThought);
    s = untagged.text;

    return { answer: s.trim(), thoughts: thoughts };
  }

  var REASONING_LEAK_PATTERNS = [
    /^\s*(?:okay|ok|alright|hmm+|so|well|right)[,.!]?\s+(?:so[,]?\s+)?(?:the user|i need to|i should|i'll need|i will need|let me|let's see|we need to|i have to|i'm going to|my task)/i,
    /^\s*(?:the user (?:wants|is asking|asked|has asked|shared|posted|needs|provided|is looking)|i need to (?:write|craft|reply|respond|come up|generate|create|draft|produce)|let me (?:think|analy[sz]e|craft|draft|figure|break|start|consider|read|look)|first,? (?:i|let me|let's)\b|we need to (?:write|craft|produce|generate|output|reply|respond)|my task is)/i,
    /\b(?:entropy\s+seed|the seed (?:string|value)|seed\s*[:=]?\s*[0-9a-f]{12,})\b/i,
    /\b(?:step 5|the prompt says|the instructions say|banned (?:words|phrases) list|<\/?think)\b/i
  ];

  /** True when text still reads like model reasoning rather than a publishable comment/post. */
  function looksLikeReasoningLeak(text) {
    var s = String(text || '').trim();
    if (!s) return false;
    for (var i = 0; i < REASONING_LEAK_PATTERNS.length; i++) {
      if (REASONING_LEAK_PATTERNS[i].test(s)) return true;
    }
    var labelHits = 0;
    if (/\bpost\s+core\b/i.test(s)) labelHits++;
    if (/\bcreative\s+direction\b/i.test(s)) labelHits++;
    if (/\bwhy\s+(?:it|this(?:\s+(?:reply|comment|post))?)\s+works\b/i.test(s)) labelHits++;
    return labelHits >= 2;
  }

  function extractThoughtProcess(raw, nativeThought, meta) {
    var parts = [];
    var nativeStr = String(nativeThought || '').trim();
    if (nativeStr) {
      parts.push(nativeStr);
    }
    var split = splitModelOutput(raw);
    split.thoughts.forEach(function (block) {
      if (block && parts.indexOf(block) === -1) parts.push(block);
    });
    var combined = parts.join('\n\n').trim();
    if (combined) return combined;
    return buildFallbackThoughtProcess(split.answer, meta);
  }

  function cleanComment(raw, options) {
    if (!raw) return '';
    var opts = options || {};
    var isMultiline = Boolean(opts.multiline);
    // Strip reasoning (<think>/<thinking>/Harmony analysis/untagged thought bullets) and keep only the final answer.
    var s = splitModelOutput(raw).answer;
    s = s.trim();
    // Strip accidental seed line if a model echoed the 48-char hex string at the top
    s = s.replace(/^(?:Seed|Random(?:\s+Alphanumeric)?\s+Seed)\s*:?\s*[0-9a-f]{32,64}\s*/i, '').trim();
    s = s.replace(/^(Here(\u2019s|'s| is) (your|a|the) (suggested )?(comment|post|reply|draft):?\s*|Comment:?\s*|Suggested comment:?\s*|LinkedIn Post:?\s*|X Post:?\s*|Response:?\s*|Final comment:?\s*)/i, '').trim();

    // Strip a single wrapping pair of quotes (ASCII and typographic).
    var pairSets = [
      ['"', '"'], ["'", "'"],
      ['\u201c', '\u201d'], ['\u2018', '\u2019'],
      ['\u201c', '\u201c'], ['\u201d', '\u201d'],
      ['\u2018', '\u2018'], ['\u2019', '\u2019']
    ];
    for (var i = 0; i < pairSets.length; i++) {
      var o = pairSets[i][0];
      var c = pairSets[i][1];
      if (s.length > 2 && s.charAt(0) === o && s.charAt(s.length - 1) === c) {
        s = s.slice(1, -1).trim();
        break;
      }
    }

    s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
    // Remove banned hype emojis (🚀, 🔥, 🤖, 👇)
    s = s.replace(/[\u{1F680}\u{1F525}\u{1F916}\u{1F447}]/gu, '');
    // Strip sycophantic preamble if a model prepends it before a real sentence
    s = s.replace(/^(?:Great post|Thanks for sharing|Totally agree(?: with this)?|Couldn['\u2019]t agree more|Spot on|Love this)[!.,]+\s+(?=[A-Z])/i, '');
    // Strip engagement-bait closing clichés if appended at the end
    s = s.replace(/\s*(?:Thoughts\?\s*Agree\??|Agree\?\s*Thoughts\??)\s*$/i, '');

    if (isMultiline) {
      s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    } else {
      s = s.replace(/\s+/g, ' ').trim();
      s = s.replace(/^[-*\u2022]\s+/, '').trim();
    }
    // Drop straggling quote characters that wrap no content.
    s = s.replace(/^["'\u2018\u2019\u201c\u201d]+|["'\u2018\u2019\u201c\u201d]+$/g, '').trim();
    if (!s) return '';
    var maxLen = opts.maxLength || (isMultiline ? 1500 : 500);
    if (s.length > maxLen) {
      var cutLen = Math.round(maxLen * 0.86);
      var cut = s.slice(0, cutLen);
      var idx = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'), cut.lastIndexOf('\u2019'));
      s = (idx > 120 ? cut.slice(0, idx + 1) : cut);
    }
    return s.trim();
  }

  /* ---------------- provider calls ---------------- */

  function parseHttpError(res, fallbackName) {
    return res.text().then(function (body) {
      var detail = '';
      try {
        var j = JSON.parse(body);
        detail = (j && (j.error && j.error.message)) || j.message || j.error || '';
        if (detail && typeof detail === 'object') {
          detail = detail.message || JSON.stringify(detail);
        }
      } catch (e) {
        detail = body.slice(0, 200);
      }
      if (!detail) detail = res.statusText || 'Unknown error';
      return fallbackName + ' error (' + res.status + '): ' + String(detail).slice(0, 300);
    }).catch(function () {
      return fallbackName + ' error (' + res.status + '): ' + (res.statusText || 'Unknown error');
    });
  }

  function isReasoningOrGpt5Model(model) {
    var m = String(model || '').toLowerCase().replace(/^openai\//, '');
    return /^(o[134](-|$)|gpt-5|gpt-6)/.test(m);
  }

  function extractOpenAIMessageText(data) {
    var choice = data && data.choices && data.choices[0];
    var msg = choice && choice.message;
    if (!msg) return '';
    if (typeof msg.content === 'string' && msg.content.trim()) return msg.content;
    if (Array.isArray(msg.content)) {
      var arrText = msg.content
        .filter(function (part) {
          if (!part || part.thought === true) return false;
          var type = String(part.type || '').toLowerCase();
          if (/think|reason|thought|analysis/.test(type)) return false;
          return type === 'text' || type === 'output_text' || typeof part.text === 'string';
        })
        .map(function (part) { return part.text || ''; })
        .join('')
        .trim();
      if (arrText) return arrText;
    }
    if (typeof choice.text === 'string' && choice.text.trim()) return choice.text;
    // NOTE: never fall back to msg.reasoning / msg.reasoning_content here — that is the model's
    // internal thinking and must never be inserted as the comment. Empty content triggers a retry instead.
    return '';
  }

  function makeAbortError() {
    var err = new Error('Generation stopped.');
    err.name = 'AbortError';
    err.aborted = true;
    return err;
  }

  function isAbortError(err) {
    if (!err) return false;
    if (err.aborted === true || err.name === 'AbortError') return true;
    var msg = String(err.message || '');
    return /AbortError|The user aborted a request|signal is aborted|request was aborted|Generation stopped/i.test(msg);
  }

  function callOpenAICompat(settings, prompt, options) {
    var signal = options && options.signal;
    if (signal && signal.aborted) return Promise.reject(makeAbortError());
    var baseUrl = String(settings.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    var headers = { 'Content-Type': 'application/json' };
    if (settings.apiKey) headers['Authorization'] = 'Bearer ' + settings.apiKey;
    var sysPrompt = (settings && settings.personaEnabled === false)
      ? 'You write short, human-sounding LinkedIn comments for real professionals.'
      : SYSTEM_PROMPT;
    var messages = [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: prompt }
    ];

    var provider = String(settings.provider || 'openai').toLowerCase();
    var payload;
    // Budgets leave room for the <think> block (and hidden reasoning tokens on o-series / GPT-5),
    // so the <final> answer is never truncated away.
    if (isReasoningOrGpt5Model(settings.model)) {
      payload = {
        model: settings.model,
        messages: messages,
        max_completion_tokens: settings._longForm ? 6000 : (provider === 'openrouter' ? 2500 : 2000)
      };
      if (provider === 'openai') {
        payload.reasoning_effort = 'low';
      }
    } else if (provider === 'openrouter') {
      payload = {
        model: settings.model,
        messages: messages,
        temperature: 0.75,
        max_tokens: settings._longForm ? 4000 : 1600
      };
    } else {
      payload = {
        model: settings.model,
        messages: messages,
        temperature: 0.7 + Math.random() * 0.25,
        top_p: 0.9,
        max_tokens: settings._longForm ? 4000 : 1200
      };
    }

    function sendRequest(bodyObj, fallbackStage) {
      if (signal && signal.aborted) return Promise.reject(makeAbortError());
      var stage = typeof fallbackStage === 'number' ? fallbackStage : 0;
      var fetchOpts = {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(bodyObj)
      };
      if (signal) fetchOpts.signal = signal;
      return fetch(baseUrl + '/chat/completions', fetchOpts).then(function (res) {
        if (!res.ok) {
          if (res.status === 403 && /localhost|127\.0\.0\.1/.test(baseUrl)) {
            throw new Error('Ollama returned 403 Forbidden. Restart Ollama with OLLAMA_ORIGINS=* ollama serve so browser extensions can connect.');
          }
          return parseHttpError(res, 'AI provider').then(function (msg) {
            if (stage === 0 && (res.status === 400 || res.status === 422)) {
              // Retry 1: try with max_completion_tokens and no sampling params
              var minimal = {
                model: settings.model,
                messages: messages,
                max_completion_tokens: settings._longForm ? 6000 : 2000
              };
              return sendRequest(minimal, 1);
            }
            if (stage === 1 && (res.status === 400 || res.status === 422)) {
              // Retry 2: bare minimum request (just model + messages) for strict OpenRouter/custom endpoints
              var bare = {
                model: settings.model,
                messages: messages
              };
              return sendRequest(bare, 2);
            }
            if (stage === 0 && res.status === 404 && provider === 'openrouter' && /data policy|privacy|guardrail|free model/i.test(msg)) {
              throw new Error(msg + ' — Tip: Enable free model training/logging at https://openrouter.ai/settings/privacy');
            }
            throw new Error(msg);
          });
        }
        return res.json();
      }).then(function (data) {
        if (data && data.error) {
          var errMsg = (data.error && data.error.message) || (typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
          throw new Error('AI provider error: ' + errMsg);
        }
        var text = extractOpenAIMessageText(data);
        if (!text && stage < 2) {
          // If the model spent all tokens on reasoning and returned empty content, retry without token cap
          return sendRequest({ model: settings.model, messages: messages }, 2);
        }
        return data;
      });
    }

    return sendRequest(payload, 0).then(function (data) {
      if (options && typeof options.onNativeThought === 'function') {
        var choice = data && data.choices && data.choices[0];
        var msgObj = choice && choice.message;
        var nativeR = msgObj && (msgObj.reasoning || msgObj.reasoning_content);
        if (typeof nativeR === 'string' && nativeR.trim()) {
          options.onNativeThought(nativeR.trim());
        }
      }
      var text = extractOpenAIMessageText(data);
      if (!text) throw new Error('AI provider returned an empty response. Please try again.');
      return text;
    }).catch(function (err) {
      if (isAbortError(err) || (signal && signal.aborted)) throw makeAbortError();
      if (/Failed to fetch|NetworkError|TypeError/i.test(String(err && err.message))) {
        throw new Error('Network error: could not reach the AI provider. Check your internet connection and base URL.');
      }
      throw err;
    });
  }

  function callGemini(settings, prompt, options) {
    var signal = options && options.signal;
    if (signal && signal.aborted) return Promise.reject(makeAbortError());
    var baseUrl = String(settings.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    if (!settings.apiKey) throw new Error('Please set your Gemini API key in Options.');
    var url = baseUrl + '/models/' + encodeURIComponent(settings.model) +
      ':generateContent?key=' + encodeURIComponent(settings.apiKey);
    var sysPrompt = (settings && settings.personaEnabled === false)
      ? 'You write short, human-sounding LinkedIn comments for real professionals.'
      : SYSTEM_PROMPT;
    var payload = {
      systemInstruction: {
        parts: [{ text: sysPrompt }]
      },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.85, topP: 0.92, maxOutputTokens: settings._longForm ? 8192 : 4096 }
    };

    var fetchOpts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    };
    if (signal) fetchOpts.signal = signal;

    return fetch(url, fetchOpts).then(function (res) {
      if (!res.ok) return parseHttpError(res, 'Gemini').then(function (msg) { throw new Error(msg); });
      return res.json();
    }).then(function (data) {
      var parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
      var thoughtParts = parts.filter(function (p) { return p && p.thought; });
      if (thoughtParts.length && options && typeof options.onNativeThought === 'function') {
        var gemThought = thoughtParts.map(function (p) { return p.text || ''; }).join('\n').trim();
        if (gemThought) options.onNativeThought(gemThought);
      }
      // Filter out internal thinking parts (p.thought === true) on Gemini 2.5 / 3.x models.
      // Never fall back to thought parts — if only thoughts came back, treat it as empty.
      var visibleParts = parts.filter(function (p) { return p && !p.thought; });
      var text = visibleParts.map(function (p) { return p.text || ''; }).join('').trim();
      if (!text) throw new Error('Gemini returned an empty response. Please try again.');
      return text;
    }).catch(function (err) {
      if (isAbortError(err) || (signal && signal.aborted)) throw makeAbortError();
      if (/Failed to fetch|NetworkError|TypeError/i.test(String(err && err.message))) {
        throw new Error('Network error: could not reach Google Gemini. Check your internet connection and base URL.');
      }
      throw err;
    });
  }

  function callAnthropic(settings, prompt, options) {
    var signal = options && options.signal;
    if (signal && signal.aborted) return Promise.reject(makeAbortError());
    var baseUrl = String(settings.baseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
    if (!settings.apiKey) throw new Error('Please set your Anthropic API key in Options.');
    var url = baseUrl + '/messages';
    var sysPrompt = (settings && settings.personaEnabled === false)
      ? 'You write short, human-sounding LinkedIn comments for real professionals.'
      : SYSTEM_PROMPT;
    var payload = {
      model: settings.model,
      max_tokens: settings._longForm ? 4000 : 1200,
      system: sysPrompt,
      messages: [{ role: 'user', content: prompt }]
    };

    var fetchOpts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(payload)
    };
    if (signal) fetchOpts.signal = signal;

    return fetch(url, fetchOpts).then(function (res) {
      if (!res.ok) return parseHttpError(res, 'Anthropic').then(function (msg) { throw new Error(msg); });
      return res.json();
    }).then(function (data) {
      var blocks = (data && Array.isArray(data.content)) ? data.content : [];
      var thinkingBlocks = blocks.filter(function (b) { return b && (b.type === 'thinking' || typeof b.thinking === 'string'); });
      if (thinkingBlocks.length && options && typeof options.onNativeThought === 'function') {
        var antThought = thinkingBlocks.map(function (b) { return b.thinking || b.text || ''; }).join('\n').trim();
        if (antThought) options.onNativeThought(antThought);
      }
      var text = blocks
        .filter(function (b) { return b && b.type === 'text'; })
        .map(function (b) { return b.text || ''; })
        .join('')
        .trim();
      if (!text) throw new Error('Anthropic returned an empty response. Please try again.');
      return text;
    }).catch(function (err) {
      if (isAbortError(err) || (signal && signal.aborted)) throw makeAbortError();
      if (/Failed to fetch|NetworkError|TypeError/i.test(String(err && err.message))) {
        throw new Error('Network error: could not reach Anthropic. Check your internet connection and base URL.');
      }
      throw err;
    });
  }

  function callProvider(settings, prompt, options) {
    var provider = String(settings.provider || 'openai').toLowerCase();
    if (provider === 'gemini') return callGemini(settings, prompt, options);
    if (provider === 'anthropic') return callAnthropic(settings, prompt, options);
    return callOpenAICompat(settings, prompt, options);
  }

  /* ---------------- live API model discovery & analysis ---------------- */

  var PROVIDER_DEFAULT_BASE_URLS = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
    gemini: 'https://generativelanguage.googleapis.com/v1beta',
    openrouter: 'https://openrouter.ai/api/v1',
    groq: 'https://api.groq.com/openai/v1',
    deepseek: 'https://api.deepseek.com',
    ollama: 'http://localhost:11434/v1'
  };

  var STEALTH_CODENAMES = /(?:^|[-_/.:])(argon|terra|luna|astra|fable|horizon|quasar|cypher|optimus|sonoma|stealth|healer|hunter)(?:$|[-_/.:0-9])/i;

  function normalizeModelEntry(provider, rawItem, fromCatalog) {
    if (!rawItem) return null;
    var p = String(provider || 'openai').toLowerCase();
    if (typeof rawItem === 'string') {
      var sId = rawItem.trim();
      if (p === 'gemini') sId = sId.replace(/^models\//i, '');
      return sId ? {
        id: sId,
        displayName: sId,
        description: '',
        version: '',
        created: 0,
        methods: null,
        outputModalities: null,
        modality: '',
        isFree: /:free$/i.test(sId) || sId.toLowerCase() === 'openrouter/free',
        active: true
      } : null;
    }
    var rawId = String(rawItem.id || rawItem.name || rawItem.model || '').trim();
    if (!rawId) return null;
    if (p === 'gemini') {
      rawId = rawId.replace(/^models\//i, '');
    }
    if (fromCatalog && p !== 'openrouter') {
      if (STEALTH_CODENAMES.test(rawId)) return null;
      if (p === 'gemini' || p === 'openai' || p === 'anthropic' || p === 'deepseek') {
        rawId = rawId.replace(/^(google|openai|anthropic|deepseek)\//i, '');
      }
      if (p === 'anthropic') {
        rawId = rawId
          .replace(/^(claude-[a-z]+-\d+)\.(\d+)$/i, '$1-$2')
          .replace(/^(claude-\d+)\.(\d+-[a-z]+)/i, '$1-$2');
      }
    }
    var arch = rawItem.architecture || null;
    var pricing = rawItem.pricing || null;
    var isFree = /:free$/i.test(rawId) || rawId.toLowerCase() === 'openrouter/free' ||
      Boolean(pricing && String(pricing.prompt) === '0' && String(pricing.completion) === '0');
    var created = 0;
    if (typeof rawItem.created === 'number' && rawItem.created > 0) {
      created = rawItem.created < 1e12 ? rawItem.created * 1000 : rawItem.created;
    } else if (rawItem.created_at || rawItem.modified_at) {
      created = Date.parse(rawItem.created_at || rawItem.modified_at) || 0;
    }
    return {
      id: rawId,
      displayName: String(rawItem.displayName || rawItem.display_name || rawItem.name || rawId).trim(),
      description: String(rawItem.description || '').trim(),
      version: String(rawItem.version || '').trim(),
      created: created,
      methods: Array.isArray(rawItem.supportedGenerationMethods) ? rawItem.supportedGenerationMethods : null,
      outputModalities: (arch && Array.isArray(arch.output_modalities)) ? arch.output_modalities : null,
      modality: (arch && typeof arch.modality === 'string') ? arch.modality : '',
      isFree: isFree,
      active: rawItem.active !== false
    };
  }

  function isCompatibleChatModel(provider, entry, options) {
    if (!entry || !entry.id) return false;
    if (entry.active === false) return false;
    var opts = options || {};
    var p = String(provider || 'openai').toLowerCase();
    var id = entry.id;
    var lower = id.toLowerCase();

    // Never auto-recommend or pollute standard provider lists with stealth/codename models
    if (STEALTH_CODENAMES.test(lower)) {
      if (p !== 'openrouter') return false;
    }

    // OpenRouter returns every model available on its API; keep all of them (including :free, :extended, etc.)
    if (p === 'openrouter' && !opts.fromCatalog) {
      if (Array.isArray(entry.outputModalities) && entry.outputModalities.length && entry.outputModalities.indexOf('text') === -1) {
        return false;
      }
      return true;
    }

    // For other providers (or when deriving provider lists from the public catalog), exclude routing variants
    if (p !== 'ollama' && p !== 'openrouter' && /:(batch|free|extended|nitro|floor|exacto|thinking)$/i.test(lower)) {
      return false;
    }

    // Gemini API provides supportedGenerationMethods: must support generateContent
    if (Array.isArray(entry.methods) && entry.methods.indexOf('generateContent') === -1) {
      return false;
    }

    // Multimodal output metadata: must generate text (not image/audio/video generation models)
    if (Array.isArray(entry.outputModalities)) {
      if (entry.outputModalities.indexOf('text') === -1) return false;
      if (entry.outputModalities.indexOf('image') !== -1 ||
          entry.outputModalities.indexOf('audio') !== -1 ||
          entry.outputModalities.indexOf('video') !== -1) {
        return false;
      }
    }
    if (entry.modality && entry.modality.indexOf('->') !== -1) {
      var outSide = entry.modality.split('->')[1] || '';
      if (outSide !== 'text') return false;
    }

    // Universal exclusions for non-text-chat models
    if (/^ft:/i.test(lower)) return false;
    if (/(?:^|[-_/.:])(embed|embedding|embeddings|rerank|bge|minilm|nomic-embed|mxbai-embed|moderation|llama-guard|prompt-guard|safeguard|shieldgemma|aqa)(?:$|[-_/.:0-9])/i.test(lower)) {
      return false;
    }
    if (/(?:^|[-_/.:])(imagen|dall-e|gpt-image|flux|stable-diffusion|veo|sora|whisper|tts|playai|orpheus|audio|realtime|transcribe|speech|lyria|nano-banana|image-generation|image-preview|image|live)(?:$|[-_/.:0-9])/i.test(lower)) {
      return false;
    }
    if (/(?:^|[-_/.:])(robotics|computer-use|customtools|deep-research|learnlm|bisheng|medlm|palm|bison|gecko|davinci|curie|babbage|ada|codex)(?:$|[-_/.:0-9])/i.test(lower)) {
      return false;
    }

    if (p === 'gemini') {
      if (!/^(gemini|gemma)-/i.test(lower)) return false;
    } else if (p === 'openai') {
      var bareOpenai = lower.replace(/^openai\//, '');
      if (!/^(gpt-|o[1-9](?:$|-)|chatgpt-)/i.test(bareOpenai)) return false;
      if (/^gpt-oss/i.test(bareOpenai) || /-instruct$/i.test(bareOpenai)) return false;
    } else if (p === 'anthropic') {
      var bareAnthropic = lower.replace(/^anthropic\//, '');
      if (!/^claude-/i.test(bareAnthropic)) return false;
    } else if (p === 'deepseek') {
      var bareDeepseek = lower.replace(/^deepseek\//, '');
      if (!/^deepseek-/i.test(bareDeepseek)) return false;
    }

    return true;
  }

  function extractModelVersion(provider, entry) {
    var raw = String((entry && entry.id) || '').toLowerCase();
    var bare = raw.replace(/^[a-z0-9_-]+\//, '');
    // Strip trailing date stamps before extracting version numbers
    var clean = bare
      .replace(/-20\d{2}-\d{2}-\d{2}$/, '')
      .replace(/-20\d{6}$/, '')
      .replace(/-\d{2}-20\d{2}$/, '')
      .replace(/-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/, '')
      .replace(/-(?:0[1-9]|1[0-2])\d{2}$/, '')
      .replace(/-latest$/, '');

    var m;
    if (/^gemini-/i.test(clean)) {
      m = clean.match(/^gemini-(\d+(?:\.\d+)?)/);
      if (m) return parseFloat(m[1]);
      var disp = String((entry && entry.displayName) || '').match(/gemini\s+(\d+(?:\.\d+)?)/i);
      if (disp) return parseFloat(disp[1]);
      if (/-latest$/i.test(bare)) return 2.45;
      return 1.8;
    }
    if (/^gemma-/i.test(clean)) {
      m = clean.match(/^gemma-(\d+(?:\.\d+)?)/);
      return m ? parseFloat(m[1]) * 0.2 : 0.4;
    }
    if (/^claude-/i.test(clean)) {
      m = clean.match(/^claude-[a-z]+-(\d+)[.-](\d+)/);
      if (m) return parseFloat(m[1] + '.' + m[2]);
      m = clean.match(/^claude-(\d+)[.-](\d+)-[a-z]+/);
      if (m) return parseFloat(m[1] + '.' + m[2]);
      m = clean.match(/^claude-[a-z]+-(\d+)/) || clean.match(/^claude-(\d+)-[a-z]+/);
      if (m) return parseFloat(m[1]);
      return 3.0;
    }
    if (/^gpt-4o/i.test(clean) || /^chatgpt-4o/i.test(clean)) {
      return 4.05;
    }
    if (/^gpt-/i.test(clean)) {
      m = clean.match(/^gpt-(\d+(?:\.\d+)?)/);
      if (m) {
        var gVer = parseFloat(m[1]);
        if (STEALTH_CODENAMES.test(raw) || gVer >= 6) return Math.min(gVer, 4.5);
        return gVer;
      }
      if (/^gpt-chat/i.test(clean)) return 5.45;
      return 4.0;
    }
    if (/^o(\d+)(?:$|-)/i.test(clean)) {
      m = clean.match(/^o(\d+)/);
      return 3.5 + parseFloat(m[1]) * 0.3;
    }
    if (/^deepseek-/i.test(clean)) {
      m = clean.match(/^deepseek-(?:chat-)?v(\d+(?:\.\d+)?)/);
      if (m) return parseFloat(m[1]);
      if (clean === 'deepseek-chat') return 3.5;
      if (clean === 'deepseek-reasoner') return 3.4;
      m = clean.match(/^deepseek-r(\d+(?:\.\d+)?)/);
      if (m) return 2.5 + parseFloat(m[1]) * 0.5;
      return 3.0;
    }
    m = clean.match(/(?:llama|qwen|gemma|mistral|mixtral|phi|glm)-?(\d+(?:\.\d+)?)/);
    if (m && parseFloat(m[1]) < 15) return parseFloat(m[1]);
    m = clean.match(/(?:^|[-_v])(\d+\.\d+)(?!\d*b\b)/);
    if (m && parseFloat(m[1]) < 10) return parseFloat(m[1]);
    return 1.0;
  }

  function scoreModel(provider, entry) {
    var p = String(provider || 'openai').toLowerCase();
    var id = String((entry && entry.id) || '').toLowerCase();
    var bare = id.replace(/^[a-z0-9_-]+\//, '');
    var ver = extractModelVersion(p, entry);
    var score = ver * 10000;

    // Stability / canonical release bonus within the same version
    var hasDateSuffix = /(?:-20\d{2}-\d{2}-\d{2}|-20\d{6}|-\d{2}-20\d{2}|-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])|-(?:0[1-9]|1[0-2])\d{2})$/.test(bare);
    var hasNumberedRev = /-00\d$/.test(bare);
    var isPreview = /(?:\b|-)preview(?:\b|-)/.test(bare);
    var isExp = /(?:\b|-)(?:exp|experimental|beta)(?:\b|-)/.test(bare);
    var isLatestAlias = /-latest$/.test(bare);

    if (!hasDateSuffix && !hasNumberedRev && !isPreview && !isExp && !isLatestAlias) {
      score += 100;
    } else if (isLatestAlias) {
      score += 80;
    } else if (hasNumberedRev) {
      score += 60;
    } else if (isPreview && !hasDateSuffix) {
      score += 45;
    } else if (isPreview) {
      score += 35;
    } else if (hasDateSuffix) {
      score += 30;
    } else if (isExp) {
      score += 10;
    }

    // Tier suitability for fast, natural comment generation within the same version
    if (/^gemini-/.test(bare)) {
      if (/-flash(?:$|-)/.test(bare) && !/-flash-lite/.test(bare) && !/-flash-8b/.test(bare)) {
        score += 25;
      } else if (/-pro(?:$|-)/.test(bare)) {
        score += 20;
      } else if (/-flash-lite|-lite/.test(bare)) {
        score += 15;
      }
    } else if (/^claude-/.test(bare)) {
      if (/sonnet/.test(bare)) score += 25;
      else if (/haiku/.test(bare)) score += 20;
      else if (/opus/.test(bare)) score += 15;
    } else if (/^gpt-|^o[1-9]/.test(bare)) {
      if (/-mini(?:$|-)/.test(bare)) score += 25;
      else if (!/-(?:nano|pro|mini)(?:$|-)/.test(bare)) score += 22;
      else if (/-nano(?:$|-)/.test(bare)) score += 15;
      else if (/-pro(?:$|-)/.test(bare)) score += 12;
    } else if (/^deepseek-/.test(bare)) {
      if (/flash|chat/.test(bare) && !/reasoner/.test(bare)) score += 25;
      else if (/pro/.test(bare)) score += 20;
      else if (/reasoner/.test(bare)) score += 10;
    } else {
      if (/flash|mini|scout|maverick|turbo|versatile|instruct/.test(bare)) score += 20;
    }

    // For OpenRouter, preserve a diverse, unbiased ranking across all providers while keeping :batch variants lower
    if (p === 'openrouter') {
      if (id === 'openrouter/free' || id === 'openrouter/auto') {
        score += 45000;
      } else if (entry && entry.isFree) {
        score += 15000;
      }
      if (/:batch$/i.test(id)) {
        score -= 40000;
      }
      if (STEALTH_CODENAMES.test(id)) {
        score -= 25000;
      }
    }

    // Tie-break by creation timestamp (0 to 9 points)
    if (entry && entry.created > 0) {
      score += Math.min(9, Math.max(0, (entry.created - 1700000000000) / 20000000000));
    }

    return score;
  }

  function analyzeAndRankModels(provider, rawItems, options) {
    var opts = options || {};
    var p = String(provider || 'openai').toLowerCase();
    var items = Array.isArray(rawItems) ? rawItems : [];
    var seen = Object.create(null);
    var valid = [];

    for (var i = 0; i < items.length; i++) {
      var entry = normalizeModelEntry(p, items[i], Boolean(opts.fromCatalog));
      if (!entry || !isCompatibleChatModel(p, entry, opts)) continue;
      if (seen[entry.id]) continue;
      seen[entry.id] = true;
      entry.score = scoreModel(p, entry);
      valid.push(entry);
    }

    valid.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      if (b.created !== a.created) return b.created - a.created;
      return a.id.localeCompare(b.id);
    });

    var models = valid.map(function (e) { return e.id; });
    var freeModels = valid.filter(function (e) { return e.isFree; }).map(function (e) { return e.id; });
    return {
      models: models,
      freeModels: freeModels,
      recommended: models[0] || ''
    };
  }

  function fetchGeminiModelsDirect(baseUrl, apiKey) {
    var all = [];
    function fetchPage(pageToken, depth) {
      var url = baseUrl + '/models?key=' + encodeURIComponent(apiKey) + '&pageSize=100' +
        (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
      return fetch(url, { method: 'GET' }).then(function (res) {
        if (!res.ok) return parseHttpError(res, 'Gemini').then(function (msg) { throw new Error(msg); });
        return res.json();
      }).then(function (data) {
        var pageModels = (data && Array.isArray(data.models)) ? data.models : [];
        all.push.apply(all, pageModels);
        if (data && data.nextPageToken && depth < 4) {
          return fetchPage(data.nextPageToken, depth + 1);
        }
        return all;
      });
    }
    return fetchPage('', 0);
  }

  var catalogCache = { ts: 0, list: null, pending: null };

  function fetchRawCatalogModels() {
    var now = Date.now();
    if (catalogCache.list && catalogCache.list.length && (now - catalogCache.ts < 60000)) {
      return Promise.resolve(catalogCache.list);
    }
    if (catalogCache.pending) return catalogCache.pending;
    catalogCache.pending = fetch('https://openrouter.ai/api/v1/models', { method: 'GET' }).then(function (res) {
      if (!res.ok) return [];
      return res.json();
    }).then(function (data) {
      var list = (data && Array.isArray(data.data)) ? data.data : [];
      if (list.length) {
        catalogCache.list = list;
        catalogCache.ts = Date.now();
      }
      catalogCache.pending = null;
      return list;
    }).catch(function () {
      catalogCache.pending = null;
      return catalogCache.list || [];
    });
    return catalogCache.pending;
  }

  function fetchCatalogModelsForProvider(provider) {
    var p = String(provider || 'openai').toLowerCase();
    var prefixMap = {
      gemini: ['google/'],
      openai: ['openai/'],
      anthropic: ['anthropic/'],
      deepseek: ['deepseek/'],
      groq: ['meta-llama/', 'qwen/'],
      openrouter: null
    };
    var prefixes = prefixMap[p];
    if (prefixes === undefined) return Promise.resolve([]);
    return fetchRawCatalogModels().then(function (list) {
      if (!prefixes) return list;
      return list.filter(function (item) {
        var id = String((item && item.id) || '').toLowerCase();
        return prefixes.some(function (pref) { return id.indexOf(pref) === 0; });
      });
    });
  }

  function fetchAvailableModels(settings) {
    var rawSettings = settings || {};
    var s = Object.assign({}, DEFAULT_SETTINGS, rawSettings);
    var provider = String(s.provider || 'openai').toLowerCase();
    var defaultBase = PROVIDER_DEFAULT_BASE_URLS[provider] || '';
    var rawBase = String(rawSettings.baseUrl || '').trim();
    if (!rawBase || (provider !== 'openai' && rawBase === DEFAULT_SETTINGS.baseUrl)) {
      rawBase = defaultBase;
    }
    var baseUrl = rawBase.replace(/\/+$/, '');
    var apiKey = String(s.apiKey || '').trim();

    function fetchDirect() {
      if (provider === 'gemini') {
        return fetchGeminiModelsDirect(baseUrl || PROVIDER_DEFAULT_BASE_URLS.gemini, apiKey);
      }
      if (provider === 'anthropic') {
        return fetch((baseUrl || PROVIDER_DEFAULT_BASE_URLS.anthropic) + '/models?limit=100', {
          method: 'GET',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
          }
        }).then(function (res) {
          if (!res.ok) return parseHttpError(res, 'Anthropic').then(function (msg) { throw new Error(msg); });
          return res.json();
        }).then(function (data) {
          return (data && Array.isArray(data.data)) ? data.data : [];
        });
      }
      if (provider === 'ollama') {
        var ollamaBase = baseUrl || PROVIDER_DEFAULT_BASE_URLS.ollama;
        return fetch(ollamaBase + '/models', { method: 'GET' }).then(function (res) {
          if (!res.ok) throw new Error('Ollama /v1/models returned ' + res.status);
          return res.json();
        }).then(function (data) {
          var list = (data && (data.data || data.models)) || [];
          if (list.length) return list;
          throw new Error('Empty model list');
        }).catch(function () {
          var origin = ollamaBase.replace(/\/v1$/, '');
          return fetch(origin + '/api/tags', { method: 'GET' }).then(function (res) {
            if (!res.ok) throw new Error('Could not reach Ollama at ' + origin);
            return res.json();
          }).then(function (data) {
            return (data && Array.isArray(data.models)) ? data.models : [];
          });
        });
      }

      var headers = {};
      if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
      return fetch(baseUrl + '/models', {
        method: 'GET',
        headers: headers
      }).then(function (res) {
        if (!res.ok) return parseHttpError(res, providerLabel(s)).then(function (msg) { throw new Error(msg); });
        return res.json();
      }).then(function (data) {
        if (Array.isArray(data)) return data;
        if (data && Array.isArray(data.data)) return data.data;
        if (data && Array.isArray(data.models)) return data.models;
        return [];
      });
    }

    var canQueryDirect = (provider === 'ollama' || provider === 'openrouter') || Boolean(apiKey);
    if (canQueryDirect && baseUrl) {
      return fetchDirect().then(function (rawList) {
        var analyzed = analyzeAndRankModels(provider, rawList, { fromCatalog: false });
        if (!analyzed.models.length) {
          throw new Error('No compatible text generation models were returned by ' + providerLabel(s) + '.');
        }
        return {
          ok: true,
          source: 'direct',
          models: analyzed.models,
          freeModels: analyzed.freeModels || [],
          recommended: analyzed.recommended
        };
      });
    }

    // When no API key is entered yet, query live public catalog so the UI still shows current models
    return fetchCatalogModelsForProvider(provider).then(function (rawList) {
      var analyzed = analyzeAndRankModels(provider, rawList, { fromCatalog: true });
      if (!analyzed.models.length) {
        throw new Error('Enter your ' + providerLabel(s) + ' API key to load available models from the API.');
      }
      return {
        ok: true,
        source: 'catalog',
        models: analyzed.models,
        freeModels: analyzed.freeModels || [],
        recommended: analyzed.recommended
      };
    });
  }

  function saveResolvedModelToStorage(provider, model, models) {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && chrome.storage.local.set) {
      chrome.storage.local.set({
        model: model,
        availableModels: models,
        recommendedModel: models[0] || model,
        modelDetectedForProvider: provider,
        modelDetectedFromApi: true
      });
    }
  }

  function ensureLatestModel(settings) {
    var provider = String(settings.provider || 'openai').toLowerCase();
    var needsResolution = !settings.model ||
      (!settings.userSelectedModel && (!settings.modelDetectedFromApi || settings.modelDetectedForProvider !== provider));
    if (!needsResolution) return Promise.resolve(settings);

    return fetchAvailableModels(settings).then(function (res) {
      if (res && res.ok && res.recommended) {
        var nextModel = res.recommended;
        if (settings.userSelectedModel && settings.model) {
          nextModel = settings.model;
        }
        var updated = Object.assign({}, settings, {
          model: nextModel,
          modelDetectedFromApi: res.source === 'direct',
          modelDetectedForProvider: provider
        });
        if (res.source === 'direct') {
          saveResolvedModelToStorage(provider, nextModel, res.models);
        }
        return updated;
      }
      return settings;
    }).catch(function () {
      return settings;
    });
  }

  function isModelUnavailableError(err) {
    var msg = String((err && err.message) || '');
    return /\b404\b|not found|does not exist|model_not_found|invalid model|deprecated|decommissioned|not supported for generateContent|limit:\s*0\b/i.test(msg);
  }

  function resModelInPreset(provider, model) {
    var m = String(model || '');
    return m === 'gpt-5-mini' || m === 'claude-sonnet-4-6' || m === 'gemini-2.5-flash' ||
      m === 'openrouter/auto' || m === 'meta-llama/llama-4-scout-17b-16e-instruct' ||
      m === 'deepseek-chat' || m === 'qwen3:8b';
  }

  function callProviderWithModelFallback(settings, prompt, options) {
    var signal = options && options.signal;
    if (signal && signal.aborted) return Promise.reject(makeAbortError());
    return ensureLatestModel(settings).then(function (resolvedSettings) {
      if (signal && signal.aborted) throw makeAbortError();
      return callProvider(resolvedSettings, prompt, options).then(function (raw) {
        return { raw: raw, settings: resolvedSettings };
      }).catch(function (err) {
        if (isAbortError(err) || (signal && signal.aborted)) throw makeAbortError();
        var prov = String(resolvedSettings.provider || '').toLowerCase();
        var isExplicit = Boolean(resolvedSettings.userSelectedModel);
        if ((prov === 'openrouter' && isExplicit) || /:free$/i.test(resolvedSettings.model || '')) {
          throw err;
        }
        if (!isModelUnavailableError(err)) throw err;
        return fetchAvailableModels(resolvedSettings).then(function (res) {
          if (signal && signal.aborted) throw makeAbortError();
          if (!res || !res.ok || !Array.isArray(res.models) || !res.models.length) throw err;
          // If the user explicitly selected a model that STILL exists in the provider's live model list,
          // do not silently switch to a different model — surface the real error.
          if (isExplicit && res.models.indexOf(resolvedSettings.model) !== -1) {
            throw err;
          }
          var candidates = res.models.filter(function (m) { return m !== resolvedSettings.model; });
          if (!candidates.length) throw err;
          var fallbackModel = candidates[0];
          var retrySettings = Object.assign({}, resolvedSettings, { model: fallbackModel });
          if (!isExplicit) {
            saveResolvedModelToStorage(String(retrySettings.provider || 'openai').toLowerCase(), fallbackModel, res.models);
          }
          return callProvider(retrySettings, prompt, options).then(function (raw) {
            return { raw: raw, settings: retrySettings };
          });
        });
      });
    });
  }

  function providerLabel(settings) {
    var p = String(settings.provider || 'openai').toLowerCase();
    var map = {
      openai: 'OpenAI', anthropic: 'Anthropic', openrouter: 'OpenRouter', groq: 'Groq',
      deepseek: 'DeepSeek', gemini: 'Gemini', ollama: 'Ollama', custom: 'Custom'
    };
    return map[p] || p;
  }

  function testConnection(settings) {
    return callProvider(settings, 'Reply with exactly the single word: OK').then(function (raw) {
      var reply = cleanComment(raw).slice(0, 80) || String(raw).trim().slice(0, 80);
      return {
        ok: true,
        detail: 'Connected to ' + providerLabel(settings) + ' model "' + settings.model +
          '". Model replied: ' + (reply || '(empty)')
      };
    });
  }

  /* ---------------- active generation cancellation ---------------- */

  var activeControllers = Object.create(null);

  function registerGenerationController(requestId) {
    var key = requestId != null && String(requestId) !== '' ? String(requestId) : '__default__';
    if (activeControllers[key]) {
      try { activeControllers[key].abort(); } catch (e) { /* ignore */ }
    }
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    if (ctrl) activeControllers[key] = ctrl;
    return { key: key, controller: ctrl, signal: ctrl ? ctrl.signal : null };
  }

  function cancelGeneration(requestId) {
    var cancelled = 0;
    if (requestId != null && String(requestId) !== '') {
      var key = String(requestId);
      if (activeControllers[key]) {
        try { activeControllers[key].abort(); } catch (e) { /* ignore */ }
        delete activeControllers[key];
        cancelled++;
      }
    } else {
      var keys = Object.keys(activeControllers);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        try { activeControllers[k].abort(); } catch (e) { /* ignore */ }
        delete activeControllers[k];
        cancelled++;
      }
    }
    return { ok: true, cancelled: cancelled > 0 };
  }

  /* ---------------- comment & thought-process history ---------------- */

  var COMMENT_HISTORY_KEY = 'commentHistory';
  var MAX_HISTORY_THREADS = 1000;

  function toLocalDateKey(ts) {
    var d = ts ? new Date(ts) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function simpleHash(str) {
    var s = String(str || '');
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  function computeThreadKey(payload, nowTs) {
    var p = payload || {};
    if (p.threadId && String(p.threadId).trim()) {
      return String(p.threadId).trim();
    }
    var dateKey = toLocalDateKey(nowTs);
    var author = String(p.author || '').trim().toLowerCase();
    var text = String(p.text || '').replace(/\s+/g, ' ').trim().slice(0, 400).toLowerCase();
    var postUrl = String(p.postUrl || '').trim().replace(/[?#].*$/, '');
    var channel = String(p.channel || 'comment').toLowerCase().trim();
    if (!text && !postUrl) {
      return 'thr_' + dateKey + '_' + generateRandomSeed(6);
    }
    return 'thr_' + dateKey + '_' + simpleHash(channel + '|' + author + '|' + postUrl + '|' + text);
  }

  function getHistoryThreads() {
    return new Promise(function (resolve) {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve([]);
        return;
      }
      chrome.storage.local.get(COMMENT_HISTORY_KEY, function (raw) {
        var list = (raw && Array.isArray(raw[COMMENT_HISTORY_KEY])) ? raw[COMMENT_HISTORY_KEY] : [];
        resolve(list);
      });
    });
  }

  function saveHistoryThreads(threads) {
    return new Promise(function (resolve) {
      var list = Array.isArray(threads) ? threads.slice(0, MAX_HISTORY_THREADS) : [];
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve(list);
        return;
      }
      var obj = {};
      obj[COMMENT_HISTORY_KEY] = list;
      chrome.storage.local.set(obj, function () {
        resolve(list);
      });
    });
  }

  function detectPlatformFromPayload(payload) {
    var p = payload || {};
    if (p.platform) return String(p.platform).toLowerCase();
    var ch = String(p.channel || '').toLowerCase();
    if (ch === 'x_post') return 'x';
    if (ch === 'linkedin_post' || ch === 'linkedin_long') return 'linkedin';
    var url = String(p.postUrl || p.pageUrl || '').toLowerCase();
    if (url.indexOf('x.com') !== -1 || url.indexOf('twitter.com') !== -1) return 'x';
    return 'linkedin';
  }

  function recordHistoryGeneration(record) {
    var r = record || {};
    var now = typeof r.createdAt === 'number' ? r.createdAt : Date.now();
    var dateKey = toLocalDateKey(now);
    var threadId = computeThreadKey(r, now);
    var entryId = 'gen_' + now.toString(36) + '_' + generateRandomSeed(4);
    var entry = {
      id: entryId,
      createdAt: now,
      comment: String(r.comment || '').trim(),
      finalComment: '',
      thoughtProcess: String(r.thoughtProcess || '').trim(),
      nativeReasoning: String(r.nativeReasoning || '').trim(),
      tone: String(r.tone || 'Engaging').trim(),
      channel: String(r.channel || 'comment').toLowerCase().trim(),
      angle: String(r.angle || '').trim(),
      seed: String(r.seed || '').trim(),
      provider: String(r.provider || 'openai').toLowerCase().trim(),
      model: String(r.model || '').trim(),
      status: 'generated',
      insertedAt: null,
      copiedAt: null
    };

    return getHistoryThreads().then(function (threads) {
      var list = Array.isArray(threads) ? threads.slice() : [];
      var existingIdx = -1;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].threadId === threadId) {
          existingIdx = i;
          break;
        }
      }
      var thread;
      if (existingIdx !== -1) {
        thread = Object.assign({}, list[existingIdx]);
        thread.updatedAt = now;
        if (!thread.postAuthor && r.author) thread.postAuthor = String(r.author).trim();
        if (!thread.postText && r.text) thread.postText = String(r.text).trim();
        if (!thread.postUrl && r.postUrl) thread.postUrl = String(r.postUrl).trim();
        thread.entries = Array.isArray(thread.entries) ? thread.entries.slice() : [];
        thread.entries.push(entry);
        list.splice(existingIdx, 1);
        list.unshift(thread);
      } else {
        thread = {
          threadId: threadId,
          createdAt: now,
          updatedAt: now,
          dateKey: dateKey,
          platform: detectPlatformFromPayload(r),
          channel: entry.channel,
          postAuthor: String(r.author || '').trim(),
          postText: String(r.text || '').trim(),
          postUrl: String(r.postUrl || r.pageUrl || '').trim(),
          entries: [entry]
        };
        list.unshift(thread);
      }
      return saveHistoryThreads(list).then(function () {
        return { thread: thread, entry: entry };
      });
    });
  }

  function markHistoryAction(params) {
    var p = params || {};
    var targetHistoryId = String(p.historyId || '').trim();
    var targetThreadId = String(p.threadId || '').trim();
    var action = String(p.action || 'inserted').toLowerCase().trim();
    var finalComment = String(p.finalComment || '').trim();
    var now = Date.now();

    return getHistoryThreads().then(function (threads) {
      var list = Array.isArray(threads) ? threads.slice() : [];
      var updatedThread = null;
      var updatedEntry = null;

      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        if (!t || !Array.isArray(t.entries)) continue;
        if (targetThreadId && t.threadId !== targetThreadId && !targetHistoryId) continue;
        for (var j = t.entries.length - 1; j >= 0; j--) {
          var e = t.entries[j];
          if (!e) continue;
          if ((targetHistoryId && e.id === targetHistoryId) || (!targetHistoryId && t.threadId === targetThreadId && j === t.entries.length - 1)) {
            if (action === 'inserted') {
              e.status = 'inserted';
              e.insertedAt = now;
            } else if (action === 'copied') {
              if (e.status !== 'inserted') e.status = 'copied';
              e.copiedAt = now;
            }
            if (finalComment) {
              e.finalComment = finalComment;
            }
            t.updatedAt = now;
            updatedThread = t;
            updatedEntry = e;
            break;
          }
        }
        if (updatedEntry) break;
      }

      if (!updatedEntry) {
        return { ok: false, error: 'History entry not found.' };
      }
      return saveHistoryThreads(list).then(function () {
        return { ok: true, thread: updatedThread, entry: updatedEntry };
      });
    });
  }

  function deleteHistoryThread(params) {
    var p = params || {};
    var threadId = String(p.threadId || '').trim();
    var entryId = String(p.entryId || '').trim();
    return getHistoryThreads().then(function (threads) {
      var list = Array.isArray(threads) ? threads.slice() : [];
      if (entryId) {
        list = list.map(function (t) {
          if (!t || !Array.isArray(t.entries)) return t;
          if (threadId && t.threadId !== threadId) return t;
          var nextEntries = t.entries.filter(function (e) { return e && e.id !== entryId; });
          return Object.assign({}, t, { entries: nextEntries });
        }).filter(function (t) { return t && Array.isArray(t.entries) && t.entries.length > 0; });
      } else if (threadId) {
        list = list.filter(function (t) { return t && t.threadId !== threadId; });
      }
      return saveHistoryThreads(list).then(function (saved) {
        return { ok: true, threads: saved };
      });
    });
  }

  function clearHistoryThreads() {
    return saveHistoryThreads([]).then(function () {
      return { ok: true, threads: [] };
    });
  }

  function importHistoryThreads(importedThreads) {
    var incoming = Array.isArray(importedThreads) ? importedThreads : [];
    return getHistoryThreads().then(function (existing) {
      var map = Object.create(null);
      var combined = [];
      existing.concat(incoming).forEach(function (t) {
        if (!t || !t.threadId || !Array.isArray(t.entries) || !t.entries.length) return;
        if (!map[t.threadId]) {
          var clone = Object.assign({}, t, { entries: t.entries.slice() });
          map[t.threadId] = clone;
          combined.push(clone);
        } else {
          var cur = map[t.threadId];
          var seenIds = Object.create(null);
          cur.entries.forEach(function (e) { if (e && e.id) seenIds[e.id] = true; });
          t.entries.forEach(function (e) {
            if (e && e.id && !seenIds[e.id]) {
              seenIds[e.id] = true;
              cur.entries.push(e);
            }
          });
          if ((t.updatedAt || 0) > (cur.updatedAt || 0)) cur.updatedAt = t.updatedAt;
        }
      });
      combined.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      return saveHistoryThreads(combined).then(function (saved) {
        return { ok: true, threads: saved };
      });
    });
  }

  /* ---------------- message handling ---------------- */

  function onMessage(msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    if (msg.type === 'cancelGeneration') {
      sendResponse(cancelGeneration(msg.requestId));
      return false;
    }

    if (msg.type === 'listModels') {
      getSettings().then(function (stored) {
        var merged = Object.assign({}, stored, msg.settings || {});
        return fetchAvailableModels(merged);
      }).then(function (result) {
        sendResponse(result);
      }).catch(function (err) {
        sendResponse({ ok: false, error: (err && err.message) || 'Could not fetch models from provider API.' });
      });
      return true;
    }

    if (msg.type === 'generateComment') {
      var reg = registerGenerationController(msg.requestId);
      getSettings().then(function (settings) {
        if (reg.signal && reg.signal.aborted) throw makeAbortError();
        var payload = Object.assign({}, msg.payload || {});
        var seed = String(payload.seed || generateRandomSeed(24)).trim();
        payload.seed = seed;
        var channel = String(payload.channel || settings.channel || 'comment').toLowerCase().trim();
        var tone = String(payload.tone || settings.tone || 'Engaging').trim();
        var prompt = buildPrompt(settings, payload);
        var nativeReasoning = '';
        var isPost = (channel === 'linkedin_post' || channel === 'linkedin_long' || channel === 'x_post');
        var cleanOpts = {
          multiline: isPost,
          maxLength: channel === 'x_post' ? 280 : (channel === 'linkedin_long' ? 12000 : (channel === 'linkedin_post' ? 1500 : 900))
        };
        var callSettings = channel === 'linkedin_long' ? Object.assign({}, settings, { _longForm: true }) : settings;
        return callProviderWithModelFallback(callSettings, prompt, {
          signal: reg.signal,
          onNativeThought: function (t) { nativeReasoning = t; }
        }).then(function (res) {
          if (reg.signal && reg.signal.aborted) throw makeAbortError();
          var comment = cleanComment(res.raw, cleanOpts);
          if (comment && !looksLikeReasoningLeak(comment)) {
            return { res: res, comment: comment, thoughtRaw: res.raw };
          }
          // Model returned only reasoning (unclosed <think> / truncated) or leaked reasoning into the output.
          // Preserve any reasoning from the first attempt for the thought-process panel, and ask for ONLY the final text.
          var firstSplit = splitModelOutput(res.raw);
          var firstThoughts = firstSplit.thoughts.length ? firstSplit.thoughts.join('\n\n') : String(res.raw || '').trim();
          var retryPrompt = prompt + buildStrictRetrySuffix(channel);
          return callProvider(res.settings, retryPrompt, {
            signal: reg.signal,
            onNativeThought: function (t) { if (t && !nativeReasoning) nativeReasoning = t; }
          }).then(function (retryRaw) {
            if (reg.signal && reg.signal.aborted) throw makeAbortError();
            var retryComment = cleanComment(retryRaw, cleanOpts);
            if (!retryComment || looksLikeReasoningLeak(retryComment)) {
              throw new Error('The AI did not return a usable comment. Please try again.');
            }
            return {
              res: { raw: retryRaw, settings: res.settings },
              comment: retryComment,
              thoughtRaw: (firstThoughts ? '<think>' + firstThoughts + '</think>\n' : '') + retryRaw
            };
          });
        }).then(function (out) {
          var res = out.res;
          var comment = out.comment;
          var thoughtProcess = extractThoughtProcess(out.thoughtRaw, nativeReasoning, {
            text: payload.text,
            author: payload.author,
            tone: tone,
            channel: channel,
            angle: payload.angle,
            seed: seed,
            model: res.settings.model,
            provider: res.settings.provider
          });
          return recordHistoryGeneration({
            threadId: payload.threadId,
            text: payload.text,
            author: payload.author,
            postUrl: payload.postUrl,
            pageUrl: payload.pageUrl || (sender && sender.tab && sender.tab.url) || '',
            platform: payload.platform,
            tone: tone,
            channel: channel,
            angle: payload.angle,
            seed: seed,
            provider: res.settings.provider,
            model: res.settings.model,
            comment: comment,
            thoughtProcess: thoughtProcess,
            nativeReasoning: nativeReasoning
          }).then(function (saved) {
            return {
              ok: true,
              comment: comment,
              thoughtProcess: thoughtProcess,
              nativeReasoning: nativeReasoning,
              seed: seed,
              model: res.settings.model,
              provider: res.settings.provider,
              historyId: saved && saved.entry && saved.entry.id,
              threadId: saved && saved.thread && saved.thread.threadId
            };
          });
        });
      }).then(function (result) {
        if (activeControllers[reg.key] === reg.controller) delete activeControllers[reg.key];
        sendResponse(result);
      }).catch(function (err) {
        if (activeControllers[reg.key] === reg.controller) delete activeControllers[reg.key];
        if (isAbortError(err) || (reg.signal && reg.signal.aborted)) {
          sendResponse({ ok: false, cancelled: true, error: 'Generation stopped.' });
          return;
        }
        sendResponse({ ok: false, error: (err && err.message) || 'Unexpected error while generating the comment.' });
      });
      return true; // keep the channel open for async response
    }

    if (msg.type === 'markHistoryAction') {
      markHistoryAction(msg).then(function (res) {
        sendResponse(res);
      }).catch(function (err) {
        sendResponse({ ok: false, error: (err && err.message) || 'Could not update history status.' });
      });
      return true;
    }

    if (msg.type === 'getHistory') {
      getHistoryThreads().then(function (threads) {
        sendResponse({ ok: true, threads: threads });
      }).catch(function (err) {
        sendResponse({ ok: false, error: (err && err.message) || 'Could not load history.' });
      });
      return true;
    }

    if (msg.type === 'deleteHistoryThread') {
      deleteHistoryThread(msg).then(function (res) {
        sendResponse(res);
      }).catch(function (err) {
        sendResponse({ ok: false, error: (err && err.message) || 'Could not delete history thread.' });
      });
      return true;
    }

    if (msg.type === 'clearHistory') {
      clearHistoryThreads().then(function (res) {
        sendResponse(res);
      }).catch(function (err) {
        sendResponse({ ok: false, error: (err && err.message) || 'Could not clear history.' });
      });
      return true;
    }

    if (msg.type === 'importHistory') {
      importHistoryThreads(msg.threads).then(function (res) {
        sendResponse(res);
      }).catch(function (err) {
        sendResponse({ ok: false, error: (err && err.message) || 'Could not import history.' });
      });
      return true;
    }

    if (msg.type === 'openHistory') {
      var query = msg.threadId ? ('?thread=' + encodeURIComponent(msg.threadId)) : '';
      var url = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
        ? chrome.runtime.getURL('history.html' + query)
        : ('history.html' + query);
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
        chrome.tabs.create({ url: url });
      } else if (typeof window !== 'undefined' && window.open) {
        window.open(url, '_blank');
      }
      sendResponse({ ok: true, url: url });
      return false;
    }

    if (msg.type === 'testConnection') {
      getSettings().then(function (settings) {
        var merged = migrateSettings(Object.assign({}, settings, msg.settings || {}));
        return callProviderWithModelFallback(merged, 'Reply with exactly the single word: OK').then(function (res) {
          var reply = cleanComment(res.raw).slice(0, 80) || String(res.raw).trim().slice(0, 80);
          return {
            ok: true,
            model: res.settings.model,
            detail: 'Connected to ' + providerLabel(res.settings) + ' model "' + res.settings.model +
              '". Model replied: ' + (reply || '(empty)')
          };
        });
      }).then(function (result) {
        sendResponse(result);
      }).catch(function (err) {
        sendResponse({ ok: false, error: (err && err.message) || 'Connection test failed.' });
      });
      return true;
    }

    if (msg.type === 'openOptions') {
      if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
      }
      sendResponse({ ok: true });
      return false;
    }
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(onMessage);
  }

  /* ---------------- export for unit tests ---------------- */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      DEFAULT_SETTINGS: DEFAULT_SETTINGS,
      DEFAULT_BANNED_WORDS: DEFAULT_BANNED_WORDS,
      DEFAULT_SIGNATURE_PHRASES: DEFAULT_SIGNATURE_PHRASES,
      DEFAULT_VOICE_PROFILE: DEFAULT_VOICE_PROFILE,
      TONE_GUIDES: TONE_GUIDES,
      SYSTEM_PROMPT: SYSTEM_PROMPT,
      RETIRED_MODEL_MIGRATIONS: RETIRED_MODEL_MIGRATIONS,
      COMMENT_HISTORY_KEY: COMMENT_HISTORY_KEY,
      migrateSettings: migrateSettings,
      generateRandomSeed: generateRandomSeed,
      findRepeatedSubstrings: findRepeatedSubstrings,
      buildPrompt: buildPrompt,
      buildStrictRetrySuffix: buildStrictRetrySuffix,
      splitModelOutput: splitModelOutput,
      looksLikeReasoningLeak: looksLikeReasoningLeak,
      extractThoughtProcess: extractThoughtProcess,
      cleanComment: cleanComment,
      callProvider: callProvider,
      callProviderWithModelFallback: callProviderWithModelFallback,
      callOpenAICompat: callOpenAICompat,
      callGemini: callGemini,
      callAnthropic: callAnthropic,
      cancelGeneration: cancelGeneration,
      getHistoryThreads: getHistoryThreads,
      recordHistoryGeneration: recordHistoryGeneration,
      markHistoryAction: markHistoryAction,
      deleteHistoryThread: deleteHistoryThread,
      clearHistoryThreads: clearHistoryThreads,
      importHistoryThreads: importHistoryThreads,
      computeThreadKey: computeThreadKey,
      onMessage: onMessage,
      fetchAvailableModels: fetchAvailableModels,
      analyzeAndRankModels: analyzeAndRankModels,
      isCompatibleChatModel: isCompatibleChatModel,
      scoreModel: scoreModel,
      extractModelVersion: extractModelVersion,
      testConnection: testConnection,
      truncate: truncate
    };
  }
}());