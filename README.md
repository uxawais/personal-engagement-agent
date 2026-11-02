# ✨ LinkedIn & X Comment AI

> Privacy-first Chrome & Edge browser extension (Manifest V3) that drafts authentic, high-signal comments and posts on **LinkedIn** and **X (Twitter)** using any modern LLM provider — with live model auto-detection, anti-robotic reasoning, and zero AI fluff.

[![Tests](https://img.shields.io/badge/tests-77%20passed-brightgreen.svg)](#testing--quality-assurance)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-orange.svg)](manifest.json)
[![Privacy](https://img.shields.io/badge/Privacy-100%25%20Local-success.svg)](#privacy--security)

---

## 🎯 Why This Extension Exists

Most AI comment extensions generate hollow, robotic praise: *"Great post! Thanks for sharing. In today's fast-paced digital landscape, this resonates deeply..."* 

This extension is built differently:
1. **Reads the Entire Caption First:** Never replies to just the first sentence or keywords. It comprehends the entire argument, story, tension, or lesson.
2. **Entropy-Seeded Comment Procedure:** Each draft generates a fresh 48-character random hex seed (equivalent to `openssl rand -hex 24`) that derives an intentional creative direction (cadence, sentence density, stance, and diction) so drafts never sound templated.
3. **Anti-Robotic Guardrails:** Strictly bans opening pleasantries (*"Great post!"*, *"Spot on!"*, *"Love this!"*), cheesy closing bait (*"Thoughts? Agree? 👇"*), and AI buzzwords (*"delve"*, *"tapestry"*, *"game-changer"*, *"testament"*, *"leverage"*, *"unleash"*).
4. **Thought Process Visibility:** Explains *why* the comment was written (identifying the post's core message, the chosen angle, and why it works) in a collapsable preview and on a dedicated history page.
5. **Multi-Channel & Multi-Tone:** Drafts quick comments (1–3 sentences), punchy X posts (<280 chars), standard LinkedIn posts, or in-depth long-form articles (500–900 words).
6. **Bring Your Own Model:** Works out of the box with OpenAI, Anthropic Claude, Google Gemini, OpenRouter, Groq, DeepSeek, local offline Ollama (100% free), or any custom OpenAI-compatible endpoint.

---

## 🚀 Quick Start (Install in 2 Minutes)

### 1. Clone or Download This Repository
```bash
git clone https://github.com/uxawais/personal-engagement-agent.git
cd personal-engagement-agent
```
*(Or download and extract the ZIP file).*

### 2. Load into Your Chromium Browser (Chrome, Edge, Brave, Arc, Opera)
1. Open your browser and navigate to:
   - **Chrome / Brave / Arc:** `chrome://extensions`
   - **Microsoft Edge:** `edge://extensions`
2. Turn ON **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** (top-left).
4. Select this project's folder.
5. Pin the extension to your toolbar for quick access!

---

## ⚙️ Configuration

1. Click the extension icon in your browser toolbar or right-click and choose **Options** (Settings).
2. Choose your preferred AI provider:
   - **Google Gemini:** Paste your API key from [Google AI Studio](https://aistudio.google.com/apikey).
   - **Anthropic (Claude):** Paste your key from [Anthropic Console](https://console.anthropic.com/settings/keys).
   - **OpenAI:** Paste your key from [OpenAI Platform](https://platform.openai.com/api-keys).
   - **OpenRouter:** Paste your key from [OpenRouter](https://openrouter.ai/keys) (supports 100+ models, including completely free `:free` models).
   - **Groq:** Ultra-fast inference with Llama models ([Groq Console](https://console.groq.com/keys)).
   - **DeepSeek:** Paste your key from [DeepSeek Platform](https://platform.deepseek.com/api_keys).
   - **Ollama (Local & Free):** Run models locally (e.g., `ollama run qwen2.5` or `llama3.3`). **No API key required!**
   - **Custom:** Any OpenAI-compatible server (vLLM, LM Studio, LocalAI, Azure OpenAI).
3. Click **Test connection** to verify connectivity.
4. Click **Save settings**.

### Personalizing Your Voice & Identity
In the Settings page:
- **Your Name & Role (Optional):** Enter your name and professional background (e.g. *"Product Designer"*, *"Distributed Systems Engineer"*, *"B2B SaaS Founder"*).
- **Contextual Persona Checkbox:** When enabled, your background is used **only** when the post is genuinely relevant to your domain. If the post is about life, leadership, humor, or general news, the AI replies as an observant human without forcing tech jargon.
- **Custom Banned Words:** Add any words or phrases you never want the AI to write.
- **Optional Signature Phrases:** Words or transitions you naturally use in conversation.
- **Custom Instructions:** Add specific rules, favorite comment examples, or target audiences.

---

## 💡 How to Use

### 1. On LinkedIn & X Feeds (Commenting)
- Browse LinkedIn (`linkedin.com`) or X (`x.com`).
- Click the **✨ AI** button added directly to any post's action bar, **OR**
- Click into any comment box to reveal the floating **✨ AI Draft** badge.
- A quick preview appears with:
  - The generated comment (ready to edit or insert).
  - A custom angle field (e.g., *"ask about their pricing"* or *"make a witty analogy"*).
  - Tone & channel selectors.
  - **💭 Why this comment?** toggle showing the thought process.
- Click **Insert** (or press Enter) to place the draft directly into the comment composer.

### 2. Drafting Original Posts (LinkedIn & X)
- Open LinkedIn's **"Start a post"** modal or X's composer.
- The assistant automatically detects the post modal (including open Shadow DOMs).
- Enter draft notes or topics in the prompt box, select **LinkedIn Post** or **LinkedIn Long-Form Post (500+ words)**, and click generate!

### 3. Stop In-Flight Generations Anytime
- Hit the **■ Stop** button or press `Escape` at any time to immediately cancel generation.

### 4. Comment & Thought History UI
- Click **🕘 Comment History** in the extension popup or settings.
- View all past drafts, original post captions, model details, and internal reasoning.
- Search by post author, content, or thoughts.
- Export your history as formatted **Markdown (.md)** or a complete **JSON backup**.

---

## 🔒 Privacy & Security

- **Zero Cloud Middleman:** Requests go directly from your browser to your chosen AI provider API.
- **No Analytics / Telemetry:** No user data or analytics are collected, logged, or transmitted.
- **Local Storage:** Your API keys and history are stored securely in your browser's private `chrome.storage.local`.
- **Open Source:** Fully inspectable source code with no obfuscation or hidden dependencies.

---

## 🛠️ Development & Testing

### Prerequisites
- Node.js 18+ (Node 20+ recommended).

### Running Tests
The project features a comprehensive test suite (77 automated unit and integration tests) using Node's native test runner and JSDOM:
```bash
# Run unit and integration tests
npm test

# Run syntax check across all scripts
npm run check

# Generate extension icons
npm run icons

# Package the extension for deployment
npm run pack
```

---

## 🤖 Instructions for AI Coding Agents

If you are an AI assistant (Cursor, Claude, Copilot, Antigravity, Devin, etc.) working on or modifying this extension:
- **Read [`AGENTS.md`](AGENTS.md)** before writing code.
- It contains complete architecture guidelines, DOM selectors, message schemas, test conventions, and safety rules.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
