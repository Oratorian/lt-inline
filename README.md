# LanguageTool Inline

> Self-hosted, privacy-first **grammar checking** and **AI writing assistance** —
> in your browser *and* across your whole desktop. Your text only ever travels to
> **your own** server.

Thin clients on top of services you host yourself. There is **no cloud**: text is
sent only to the grammar/AI endpoint *you* configure (intended to be your own
machine or LAN).

| Component | What it is | Folder |
|---|---|---|
| **Browser extension** | Inline grammar checking + AI proofread/rephrase on web pages. One **MV3** build for Chrome, Edge, Opera, and Firefox. | [`lt-inline-mv3/`](lt-inline-mv3/) |
| **Desktop app** | A floating, always-on-top helper that works in **any** Windows app (Discord, Word, native editors) via the clipboard. Tauri v2. | [`lt-inline-desktop/`](lt-inline-desktop/) |
| **Backend stack** | One-shot installers (Docker or native) for the LanguageTool server + the local LLM + reverse-proxy config. | [`lt-stack/`](lt-stack/) |

Each folder has its own detailed **README** — start there to set that part up.

---

## Install the browser extension (published builds)

Don't want to build from source? Install the signed/published extension from your
browser's store. (You still need a backend — see [Quick start](#quick-start) or
the [test endpoint](#try-it-without-a-backend).)

| Browser | Install from | Status |
|---|---|---|
| 🦊 **Firefox** | [Direct `.xpi` (AMO-signed)](https://addons.mozilla.org/firefox/downloads/file/4857735/90c021f94d354338a40c-0.2.2.xpi) | ✅ Available — v0.2.2, **auto-updates** |
| 🔵 **Edge** | Edge Add-ons | ⏳ Pending review |
| 🔴 **Opera** | [Opera Add-ons](https://addons.opera.com/extensions/details/e3d4b572e916c6add8dbb23dcfe68c7d9fdeeec2/) | ✅ Available — auto-updates |
| 🟢 **Chrome** | Chrome Web Store | ⏳ Pending review |
| 🐙 **GitHub Releases** | [Releases](https://github.com/Oratorian/lt-inline/releases) | Per-store `.zip`s + the signed `.xpi` — manual install, **no auto-update** |

> The Firefox `.xpi` is AMO-signed and carries an update URL, so it **updates
> itself automatically** — install it once and you're done. Store links for
> Edge / Opera / Chrome (which also auto-update from their stores) will be added
> here as each listing is approved. The GitHub Releases builds are for manual
> installation and do **not** auto-update — see
> [`lt-inline-mv3/README.md`](lt-inline-mv3/README.md).

---

## How it works

```
┌─────────────────────────┐        ┌──────────────────────────┐
│  Browser extension      │        │  Desktop app (Tauri)     │
│  (Chrome/Edge/Opera/FF) │        │  (any Windows app)       │
└────────────┬────────────┘        └────────────┬─────────────┘
             │  HTTPS                            │  HTTPS
             └─────────────────┬─────────────────┘
                               ▼
                  ┌─────────────────────────┐
                  │  Reverse proxy (TLS)    │   nginx / Nginx Proxy Manager
                  │   /v2/   → LanguageTool │
                  │   /llm/  → llamafile    │
                  └─────────────────────────┘
                      │                  │
                      ▼                  ▼
            ┌──────────────┐    ┌───────────────────┐
            │ LanguageTool │    │ llamafile (LLM)   │
            │  (Java)      │    │ OpenAI-compatible │
            └──────────────┘    └───────────────────┘
```

Two complementary checking passes:

1. **LanguageTool** (`/v2/check`) — fast, deterministic grammar/spelling.
2. **A local LLM** (`/llm/v1/chat/completions`) — an optional second pass that
   catches the **confused words** LanguageTool's free tier misses
   (their/there, its/it's, then/than, affect/effect …) and powers rephrasing.
   A Mozilla **llamafile** running a small Qwen model works great — ~55 tok/s on
   a 6 GB GTX 1660 Ti, and the 2B variant even runs on CPU only.

A **reverse proxy** terminates TLS and serves both under one hostname, so the
clients only ever speak `https://<your-host>` (which also avoids browser
mixed-content blocking). Throughout the docs, replace `<your-host>` with your own
(e.g. `lt.example.lan` or a real domain with a public-CA cert).

---

## Quick start

1. **Stand up the backend** — follow [`lt-stack/README.md`](lt-stack/README.md).
   The easiest path is the install script in **Docker** mode.
2. **Install a client:**
   - Browser → [`lt-inline-mv3/README.md`](lt-inline-mv3/README.md)
   - Desktop → [`lt-inline-desktop/README.md`](lt-inline-desktop/README.md)
3. **Point the client at your server** in its settings (the shipped defaults are
   placeholders like `https://languagetool.example.com`).

### Try it without a backend

To evaluate the clients before self-hosting, you can point them at a public test
server run by the maintainer:

- Grammar: `https://lang.mahesvara.cloud/v2/check`
- Rephrase / AI proofread: `https://lang.mahesvara.cloud/llm/v1/chat/completions`

> ⚠️ **For testing only.** Text you check is sent to a server operated by the
> maintainer, not to your own machine — so this is **not private** and may be
> rate-limited or taken down at any time. Do **not** use it for sensitive or
> production content. **Self-host** (above) for the privacy this project is built
> for.

---

## Features at a glance

| | Browser extension | Desktop app |
|---|---|---|
| Scope | Web pages | **Any** app (clipboard-based) |
| Grammar (LanguageTool) | Inline wavy underlines + on-demand suggestion popup | Interactive suggestion picker |
| **AI proofread** (LLM) | ✓ blue underline layer, per-change apply | ✓ per-change apply |
| Rephrase (LLM) | Whole-field + selection (right-click) | On captured text |
| Multiple rephrase styles | ✓ | ✓ |
| Language config | language / preferred variants / mother tongue | same |
| Localization | English | **en / de**, auto-detected |
| Onboarding | — | First-run tour |
| Distribution | MV3 zip (Chrome/Edge/Opera) + signed `.xpi` (Firefox) | MSI + NSIS installers |

See each component README for the full feature list.

---

## The AI proofread pass (how it stays safe)

The LLM is used as a **proofreader**, not an autocorrect. To stop a small model
from mangling text:

- The model returns the **whole corrected text** as plain text (no fragile JSON
  string), then a short `===CHANGES===` block of reasons.
- The client **diffs** original-vs-corrected itself to derive the exact per-word
  edits, so a word the model leaves unchanged produces no edit (it can't
  over-reach), and applying all edits reproduces the corrected text exactly.
- Each edit is shown as its own apply-on-click suggestion with a reason — nothing
  is applied automatically, and a visible "AI can make mistakes — review each
  suggestion" note is shown.

This catches the confusions LanguageTool's premium rules would (which aren't in
the free engine) **without** any proprietary data — and with full sentence
context the LLM does better than a fixed confusion-word list.

---

## Repository layout

```
.
├─ lt-inline-mv3/        # Browser extension — MV3 (Chrome/Edge/Opera/Firefox)
├─ lt-inline-desktop/    # Desktop app (Tauri v2 + Rust)
├─ lt-stack/             # Backend installers + docker-compose + nginx snippet
├─ addons/               # Firefox unlisted-add-on self-update manifest (updates.json)
├─ LICENSE               # AGPL-3.0
├─ NOTICE.md             # third-party attribution (LanguageTool LGPL, fastText, …)
├─ PRIVACY.md            # privacy policy (link from store listings)
└─ TERMS.md              # terms of use (link from store listings)
```

> The single **MV3** build runs on Chrome, Edge, Opera **and** Firefox (Firefox
> supports MV3), so there is one extension to maintain.

> ⚠️ **Never commit secrets.** AMO signing credentials, any `.hidden`/`.env`, and
> host-specific files (e.g. `docker-compose.override.yml`) stay out of version
> control — see the relevant `.gitignore`s.

---

## Privacy

The clients contact **only** the server you configure; LanguageTool and the LLM
run on your own hardware. No analytics, no telemetry, no third-party cloud. Full
policy: [PRIVACY.md](PRIVACY.md). Terms: [TERMS.md](TERMS.md).

---

## License

This project's own code (extension, desktop app, install scripts) is licensed
under the **GNU Affero General Public License v3 or later (AGPL-3.0-or-later)** —
see [LICENSE](LICENSE). If you run a modified version as a network service, the
AGPL requires you to publish your changes.

Third-party components (LanguageTool — LGPL; fastText — MIT; llamafile —
Apache-2.0; the LLM weights — their own model licenses) are **downloaded from
their official sources at install time**, not bundled or redistributed here. See
[NOTICE.md](NOTICE.md). This project does **not** enable or redistribute any of
LanguageTool's premium-only rules or data.
