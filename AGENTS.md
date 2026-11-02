# AI Agent Guidelines & Architecture Map (`AGENTS.md`)

This document is designed for AI coding assistants (Claude, Cursor, Copilot, Antigravity, Devin, Codex) to understand the codebase structure, design patterns, message protocols, and constraints before proposing or making changes.

---

## 🏗️ Architectural Overview (Manifest V3)

The project is a pure, modular vanilla JavaScript Chrome/Edge extension conforming strictly to Manifest V3 specifications. It contains no heavy frameworks or runtime bundlers.

```
├── manifest.json         # Extension manifest (MV3), host permissions, content script rules
├── background.js         # Service worker: LLM API routing, prompts, reasoning extraction, models API
├── content.js            # Content script: DOM scraping, UI injection, keyboard handlers, editor detection
├── content.css           # Styling for floating badges, preview modals, and action bar buttons
├── popup.html / popup.js # Extension action popup (status, activation, fast settings link)
├── options.html / .js    # Full settings dashboard (providers, models, persona, banned words)
├── options.css           # Settings page styles
├── history.html / .js    # Comment & thought process history dashboard (LLM thread style)
├── history.css           # History page styles
├── scripts/make-icons.py # Script to regenerate icons into icons/
└── tests/
    ├── run.test.js       # Comprehensive unit tests for background & content script logic
    └── pages.test.js     # JSDOM smoke tests for options, popup, and history UI
```

---

## 📡 Message Passing Protocol

All communication between `content.js`, `popup.js`, `options.js`, and `background.js` uses `chrome.runtime.sendMessage`.

### Message Types Handled by `background.js`:
| Message Type | Sender | Payload | Description |
|---|---|---|---|
| `generateComment` | `content.js` | `{ payload: { text, author, tone, channel, angle, seed }, requestId }` | Constructs entropy-seeded prompt, queries LLM, extracts `<think>` reasoning, cleans output, stores history, and returns `{ ok, comment, thoughtProcess, seed }`. |
| `cancelGeneration` | `content.js` | `{ requestId }` | Aborts in-flight `fetch()` via `AbortController`. |
| `listModels` | `options.js` | `{ settings }` | Queries `/models` or Gemini metadata API, filters chat models, ranks newest first, returns `{ ok, models, freeModels, recommended, source }`. |
| `testConnection` | `options.js` | `{ settings }` | Sends a lightweight ping to the configured model and reports connectivity status. |
| `saveCommentHistory` | `content.js` | `{ threadId, entryId, status, finalComment }` | Updates insertion status or final user-edited text in `commentHistory`. |
| `getCommentHistory` | `history.js` | `{}` | Retrieves saved threads from `chrome.storage.local`. |
| `rescan` | `popup.js` | `{ openComposer }` | Tells `content.js` to scan the active feed for posts and attach AI buttons. |

---

## 🧠 LLM Prompting & Reasoning Pipeline

### 1. Entropy Seeding (`openssl rand -hex 24`)
- Each generation generates a 48-character random hex string (`generateRandomSeed(24)`).
- The seed is injected into the prompt along with rules to derive writing constraints (cadence, sentence length, stance, diction).
- Any repeated 4-character substring in the seed is detected (`findRepeatedSubstrings`) and optionally used for rhetorical mirroring.

### 2. Multi-Provider API Layer
- **OpenAI / OpenRouter / Groq / DeepSeek / Ollama / Custom:** Dispatched via `callOpenAICompat()`. Supports both `max_completion_tokens` (newer models / reasoning models) and `max_tokens` fallbacks.
- **Anthropic Claude:** Dispatched via `callAnthropic()` using the Messages API (`/v1/messages`) with `x-api-key` and `anthropic-version: 2023-06-01`.
- **Google Gemini:** Dispatched via `callGemini()` using `v1beta/models/{model}:generateContent?key={apiKey}`. Strips `thought` parts from internal Gemini reasoning.

### 3. Anti-Thinking-Leak & Reasoning Extraction
Modern reasoning models (DeepSeek-R1, o3/o4, Qwen-Max, Claude 3.7 Sonnet) output internal reasoning. The pipeline handles this robustly:
- Separates reasoning into `<think>` / `<thinking>` blocks or Harmony tokens.
- `extractThoughtProcess()` extracts the reasoning to display in the collapsible "Why this comment?" card and History page.
- `cleanComment()` strips thought blocks, sycophantic openers (*"Great post!"*), banned AI words (*"delve"*, *"tapestry"*), and echoed seeds.
- If a model leaks raw reasoning without tags (`looksLikeReasoningLeak()`), the system automatically retries with a strict final-only prompt suffix.

---

## 🖥️ Content Script DOM Handling

### Supported Platforms & Selectors
1. **LinkedIn Feed:**
   - Detects posts using `.feed-shared-update-v2`, `div[data-urn]`, and fallback parent traversal from `.feed-shared-social-action-bar`.
   - Obfuscated SDUI heuristic: traverses up from any native "Comment" button to locate the post container.
   - Extracts complete captions by clicking and reading `.feed-shared-inline-show-more-text` while ignoring visually hidden duplicate tags.
2. **LinkedIn Post Composer ("Start a post"):**
   - Detects standard post creation modals and open Shadow DOMs (`#interop-outlet`).
   - Injects **AI Post** badges and switches default channel to `linkedin_post` or `linkedin_long`.
3. **X (Twitter / X.com):**
   - Supports tweet articles (`article[data-testid="tweet"]`).
   - Injects comments into Twitter's `Draft.js` contenteditable composer using synthetic clipboard paste events (`clipboardData.setData('text/plain', ...)`) to prevent DOM corruption or double-typing.

---

## 🧪 Testing & Verification Protocol

Always verify changes using the test suite before committing:

```bash
# Run all tests
npm test

# Run syntax linter
npm run check
```

### Key Testing Invariants:
1. **No External Network Calls:** All API tests in `tests/run.test.js` and `tests/pages.test.js` mock `fetch` and `chrome.*` APIs. Never make live network requests during tests.
2. **Preserve Clean Code:** Never introduce personal names, personal handles, hardcoded personal paths, or secret API keys into source code or test fixtures.
3. **Keep JSDOM Isolation Clean:** In `tests/pages.test.js`, always mock `chrome.storage.local`, `chrome.runtime.sendMessage`, and wait for async renders (`setTimeout`).

---

## 💡 Guidelines for Extending Functionality

- **Adding a new AI provider:** Add endpoint metadata to `PRESETS` in `options.js`, handle provider-specific headers in `background.js` (`callProvider`), and add the URL pattern to `host_permissions` in `manifest.json`.
- **Modifying DOM selectors:** Always provide multiple fallback selectors and keep the obfuscated SDUI heuristic working without depending on fragile CSS class names.
- **Privacy:** All user configurations, keys, and history must remain in `chrome.storage.local`. Never send user post text or keys to third-party tracking services.
