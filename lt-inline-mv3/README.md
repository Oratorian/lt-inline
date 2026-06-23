# LanguageTool Inline — browser extension (MV3)

A single **Manifest V3** build that runs on **Chrome, Edge, Opera, and Firefox**.
It checks grammar inline against your self-hosted LanguageTool server and adds an
LLM-powered **AI proofread** and **rephrase** pass.

> Needs the backend running first — see [`../lt-stack/`](../lt-stack/). The shipped
> endpoints are placeholders (`https://languagetool.example.com`); set your own in
> the options page.

---

## Features

- **Inline underlines** on `contenteditable` fields via the CSS Custom Highlight
  API — **red** = spelling/grammar, **yellow** = style/other, **blue** = AI
  proofread. They never cover the text.
- **In-field icon** — collapses to an issue-count badge (colored by worst
  severity), expands on hover to a power toggle + ✨ rephrase. Click the badge to
  open the on-demand suggestion popup (opens to the side of the field, grows with
  content).
- **AI proofread** — a manual LLM pass (✦ button in the popup) that catches the
  confused words LanguageTool's free tier misses. Whole-text correction is
  diffed locally into per-change apply-on-click suggestions with reasons; nothing
  auto-applies, and an "AI can make mistakes" note is shown. (See the root README
  for how the diff keeps it safe.)
- **✨ Rephrase** — rewrite the whole field, or just a **selection** via the
  right-click menu. Optional **multiple-style** mode returns labelled variants
  (casual / professional / concise) to pick from, in the input's language.
- **Toolbar button** — left-click opens settings; right-click → Settings /
  Check connection. A **server-reachability indicator** shows green / grey + a red
  `!` badge, with a periodic ping.
- **Language settings** — `language` (default `auto`), **preferred variants**
  (en-US vs en-GB, de-DE …; sent only with `language=auto`), and **mother
  tongue** (enables LanguageTool false-friends warnings).
- **Tabbed options page** (Grammar / Rephrase), dark-mode aware.

> Inputs/`<textarea>`s get the icon + popup + AI proofread, but **not** inline
> underlines — the Highlight API can't target their internal text (a mirror
> overlay is the deferred way to add it).

---

## Load unpacked (development / personal use)

The source folder is dual-key (declares both `service_worker` and `scripts`
background entries), so it load-unpacks directly in both engines.

**Chrome / Edge / Opera:**
1. Go to `chrome://extensions` (or `edge://extensions`, `opera://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** → select this `lt-inline-mv3/` folder.

**Firefox:**
1. Go to `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on** → select `lt-inline-mv3/manifest.json`.
   (Temporary add-ons are removed on restart.)

Then open the extension's **options** and set your LanguageTool + rewrite
endpoints.

### Try it without a backend

To evaluate before self-hosting, set the endpoints to the maintainer's public
test server:

- LanguageTool endpoint: `https://lang.mahesvara.cloud/v2/check`
- Rewrite endpoint: `https://lang.mahesvara.cloud/llm/v1/chat/completions`

> ⚠️ **For testing only.** Your text is sent to a server operated by the
> maintainer (not your own machine) — **not private**, possibly rate-limited, and
> may go away at any time. Don't use it for sensitive or production content;
> self-host for privacy.

---

## Packaging for the stores

`package.ps1` builds one zip per store into `dist/` from this single source:

```powershell
pwsh ./package.ps1                      # all targets
pwsh ./package.ps1 -Stores chrome,firefox
```

| Output | Upload to | Background key | gecko block |
|---|---|---|---|
| `lt-inline-chrome-<v>.zip` | Chrome Web Store | `service_worker` | stripped |
| `lt-inline-edge-<v>.zip` | Edge Add-ons | `service_worker` | stripped |
| `lt-inline-opera-<v>.zip` | Opera Add-ons | `service_worker` | stripped |
| `lt-inline-firefox-<v>.zip` | AMO / self-host | `scripts` (event page) | kept |

Chrome/Edge/Opera all take the **same** Chromium package; the three zips just
keep store uploads clearly separated. Firefox gets an event-page background and
keeps its `browser_specific_settings.gecko` (id, min-version, self-update).

**Store listing notes:**
- Category: **Productivity**.
- Justify the broad host access: *"the content script attaches an inline
  grammar-check UI to editable text fields on any site where you type."*
- Privacy / Terms URLs: link [`../PRIVACY.md`](../PRIVACY.md) and
  [`../TERMS.md`](../TERMS.md) (e.g. their GitHub `blob/main/` URLs).

---

## Firefox signing & self-update (optional)

Firefox requires signing for permanent install. Sign via AMO's **unlisted**
channel:

```bash
export WEB_EXT_API_KEY="user:XXXX:YY"            # JWT issuer
export WEB_EXT_API_SECRET="<64-char hex secret>"  # NO surrounding spaces!
npx --yes web-ext sign --source-dir <firefox-build> --channel=unlisted
```

- **Bump `version` in `manifest.json` before every re-sign** (AMO rejects a
  re-used version).
- AMO does **not** auto-update unlisted add-ons. Self-host
  [`../addons/updates.json`](../addons/updates.json) + the signed `.xpi`, and the
  manifest's `update_url` points Firefox at it. (See the gotcha below about the
  source needing real endpoints when you build the Firefox zip.)

---

## How the code is wired (MV3 specifics)

- **`browser-polyfill.min.js`** (Mozilla webextension-polyfill) is loaded before
  every script, so the code uses promise-based `browser.*` on Chromium too.
- **`background.js`** is a non-persistent **service worker**: it `importScripts`
  the polyfill (guarded so it no-ops in Firefox's event page), and creates the
  context menus + health alarm in `runtime.onInstalled` (since the worker is
  killed when idle). Event listeners are top-level so they re-register on wake.
- **PNG icons** (Chromium can't use SVG for the toolbar) at 16/32/48/96/128.
- **`content.js`** does the underlines, the in-field icon, the popup, AI-proofread
  rendering, and selection rephrase. It's plain `browser.*` and needs no MV3
  changes beyond the polyfill.

---

## Files

```
lt-inline-mv3/
├─ manifest.json            # MV3, dual background key for cross-engine load-unpacked
├─ background.js            # service worker: LT + LLM calls, menus, health ping
├─ content.js              # inline UI, underlines, popup, AI proofread, rephrase
├─ options.html/.css/.js    # tabbed settings (Grammar / Rephrase)
├─ panel.css                # underline + popup styling
├─ browser-polyfill.min.js  # Mozilla webextension-polyfill
├─ icon-*.png               # toolbar / store icons
└─ package.ps1              # per-store zip builder
```

---

## Configuration reference

| Setting | Meaning | Default |
|---|---|---|
| LanguageTool endpoint | `…/v2/check` URL | `https://languagetool.example.com/v2/check` |
| Language | `auto`, or a code like `en-US`, `de-DE` | `auto` |
| Preferred variants | per-language variant (sent only with `language=auto`) | `en-US,de-DE` |
| Mother tongue | enables false-friends warnings; blank = off | (blank) |
| Ignored categories | comma-separated LanguageTool category IDs to skip | (none) |
| Rewrite endpoint | OpenAI-compatible `…/v1/chat/completions` URL | `https://languagetool.example.com/llm/v1/chat/completions` |
| System prompt | instruction sent with every rephrase | a "rewrite, output only the text" prompt |
| Multiple rephrase styles | offer labelled style variants | off |

Selection rephrase is **right-click only**. The AI-proofread prompt is hardcoded
(not user-editable) so its output contract stays reliable.
