# LanguageTool Inline — desktop app (Tauri)

A frameless, transparent, **always-on-top, non-activating** floating button that
brings grammar checking + AI proofread/rephrase to **any** Windows app (Discord,
Word, native editors) via the clipboard. Tauri v2 — Rust backend, plain HTML/JS
frontend (no bundler).

> Needs the backend running first — see [`../lt-stack/`](../lt-stack/). The shipped
> endpoints are placeholders; set your own in Settings.

---

## How it works

The window is **non-activating** (`WS_EX_NOACTIVATE`), so clicking it never steals
focus or selection from the app you're editing. It reads the current selection by
simulating `Ctrl+C`, sends it to your server, and pastes the result back with
`Ctrl+V`. **Summon-only** — it never pops up unprompted.

---

## Features

- **Floating button** — drag to move (position remembered), click to open; or the
  global hotkey **`Ctrl+Alt+R`**.
- **Capture** — works on your **selection**, or grabs the **whole field** (auto
  `Ctrl+A`) when nothing is selected.
- **Fix grammar** — interactive picker: each flagged word shows LanguageTool's
  suggestions to choose from (context matters — the first isn't always right),
  plus an "Apply all (best)" shortcut.
- **✦ AI proofread** — LLM second pass for the confused words LanguageTool misses;
  whole-text correction diffed into per-change apply-on-click suggestions with
  reasons, shown as a distinct blue "AI" layer with a review-before-applying note.
- **✨ Rephrase** — one clean rewrite, or **Rephrase — styles** for several
  labelled variants. (If the "multiple style options" setting is on, the plain
  Rephrase also returns styles — matching the browser extension.)
- **Native right-click menu** (the default WebView2 menu is suppressed): Fix
  grammar / AI proofread / Rephrase / Rephrase-styles / Settings / Tour / Quit.
- **Resizable panel** — drag the bottom-right grip; the size is remembered.
- **Tabbed Settings** (Grammar / Rephrase) incl. preferred variants, mother
  tongue, the rephrase-variants toggle, and an **Interface language** selector.
- **Localization (en/de)** — auto-detected from the system language (English
  fallback), overridable in Settings; applies to the panel, Settings, **and** the
  native menu.
- **First-run welcome tour** (reopenable from the right-click menu).
- Passive typo underlines are deliberately left to each app's own spellcheck
  (Discord/Chromium/Windows already do this).

---

## Prerequisites (Windows)

1. **Rust** — via <https://rustup.rs> (provides `cargo`).
2. **Microsoft C++ Build Tools** (or full Visual Studio) — "Desktop development
   with C++" workload, for the MSVC toolchain Tauri links against.
3. **WebView2 runtime** — preinstalled on Windows 11.
4. **Node.js** — only to run the Tauri CLI.

---

## Run (development)

```bash
cd lt-inline-desktop
npm install
npm run tauri dev      # first build compiles the whole crate tree — slow once, then cached
```

Run the Rust unit tests (cover the diff + parser logic behind AI proofread /
variants):

```bash
cd src-tauri
cargo test
```

---

## Build installers

```bash
npm run tauri icon path\to\icon.png   # once, to generate app icons
npm run tauri build
```

Produces an **MSI** and an **NSIS `.exe`** in
`src-tauri/target/release/bundle/`. (Trim to one with `bundle.targets` in
`tauri.conf.json`.) Installers are **unsigned**, so Windows SmartScreen shows
"unknown publisher" — **More info → Run anyway** (a code-signing cert removes
this).

> The release profile uses `lto = false` + `codegen-units = 16` for faster
> builds. Set `lto = true` only for a final, smallest-binary release.

---

## Try it without a backend

To evaluate before self-hosting, set the endpoints in Settings to the
maintainer's public test server:

- LanguageTool endpoint: `https://lang.mahesvara.cloud/v2/check`
- Rewrite endpoint: `https://lang.mahesvara.cloud/llm/v1/chat/completions`

> ⚠️ **For testing only.** Your text is sent to a server operated by the
> maintainer (not your own machine) — **not private**, possibly rate-limited, and
> may go away at any time. Don't use it for sensitive or production content;
> self-host for privacy.

## Configuration & state

Stored in the OS app-config dir (`%APPDATA%\<app-identifier>\`):

- **`config.json`** — settings (LanguageTool + rewrite endpoints, language,
  preferred variants, mother tongue, ignored categories, system prompt,
  rephrase-variants toggle, UI language). Edited via the Settings window. Uses
  `#[serde(default)]`, so older config files without newer fields still load.
- **`position.json`** — window state (button position, panel size, tour-seen
  flag). Kept separate from `config.json` so a Settings save can't clobber it.

| Setting | Meaning | Default |
|---|---|---|
| LanguageTool endpoint | `…/v2/check` URL | `https://languagetool.example.com/v2/check` |
| Language | `auto`, or `en-US` / `de-DE` | `auto` |
| Preferred variants | per-language variant (with `language=auto`) | `en-US,de-DE` |
| Mother tongue | false-friends warnings; blank = off | (blank) |
| Ignored categories | LanguageTool category IDs to skip | (none) |
| Rewrite endpoint | OpenAI-compatible `…/v1/chat/completions` | `https://languagetool.example.com/llm/v1/chat/completions` |
| System prompt | sent with every rephrase | a "rewrite, output only the text" prompt |
| Multiple style options | plain Rephrase returns styles | off |
| Interface language | `auto` / `en` / `de` | `auto` |

---

## Implementation notes

- **LanguageTool offsets are UTF-16 code units** (Java string indices); the Rust
  side splices replacements — and computes the AI-proofread diff — on a UTF-16
  buffer so they line up with the JS frontend.
- **Non-activating window** (`WS_EX_NOACTIVATE`) is what lets the button
  capture/paste without stealing focus; the Win11 1-px border is removed via
  `DwmSetWindowAttribute(DWMWA_BORDER_COLOR)`.
- **Tauri windows are destroyed on close, not hidden** — Settings/Tour intercept
  `CloseRequested` and hide instead, so they reopen.
- **`fasttextBinary` / PATH** — if you use fastText with a native LanguageTool on
  Windows, see [`../lt-stack/README.md`](../lt-stack/README.md): LT needs
  `fasttext` runnable from any console.

---

## Files

```
lt-inline-desktop/
├─ src/                     # frontend (HTML/CSS/JS, no bundler)
│   ├─ index.html, main.js  #   floating button + panel + flows
│   ├─ settings.*, tour.*   #   Settings + first-run tour
│   └─ i18n.js              #   en/de dictionary + t()
└─ src-tauri/
    ├─ src/main.rs          #   commands: capture, grammar, AI proofread, rephrase, menu
    ├─ Cargo.toml, tauri.conf.json
    └─ capabilities/        #   window/event permissions
```

Licensed AGPL-3.0 — see the repo [LICENSE](../LICENSE) and [NOTICE.md](../NOTICE.md).
