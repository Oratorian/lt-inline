// SPDX-License-Identifier: AGPL-3.0-or-later
// LanguageTool Inline — Copyright (C) 2026 Oratorian. See LICENSE.
//
// Background service worker (MV3): the ONLY place that talks to LanguageTool.
// Requests from here are not subject to the visited page's CSP, and (with the
// matching host permission) bypass CORS. Content scripts message us instead of
// fetching directly.
//
// MV3 note: this runs as a NON-PERSISTENT background. On Chromium it's a service
// worker (killed when idle, restarted on demand); on Firefox it's an event page.
// All event listeners are registered at top level (they re-run on every wake);
// one-time setup (menu + alarm CREATION) lives in runtime.onInstalled.
//
// The polyfill is pulled in via importScripts ONLY in the service-worker context
// (Chromium). On Firefox, background.scripts loads the polyfill as a separate
// array entry before this file, so importScripts is both unavailable and
// unnecessary — hence the guard.
if (typeof importScripts === "function" && typeof browser === "undefined") {
  importScripts("browser-polyfill.min.js");
}

const DEFAULTS = {
  endpoint: "https://languagetool.example.com/v2/check",
  language: "auto",        // server-side fastText auto-detects
  preferredVariants: "en-US,de-DE", // with language=auto: which variant per detected language (en-US vs en-GB, …)
  motherTongue: "",        // e.g. "de-DE" — enables "false friends" warnings; blank = off
  debounceMs: 700,
  minLength: 4,            // don't bother checking very short text
  ignoredCategories: "",   // comma-separated LT category IDs to drop (e.g. "STYLE,TYPOGRAPHY")
  // LLM rephrase (OpenAI-compatible endpoint, e.g. a llamafile behind nginx)
  rewriteEndpoint: "https://languagetool.example.com/llm/v1/chat/completions",
  rewritePrompt:
    "You are a writing assistant. Rewrite the text so it is grammatically correct, clear, and natural, keeping the original meaning and the same language. Output only the rewritten text, with no explanations, quotes, or preamble.",
  rephraseVariants: false, // offer multiple style options to choose from
};

async function getConfig() {
  return browser.storage.local.get(DEFAULTS);
}

// --- Server reachability + toolbar status indicator -----------------------
const HEALTH = { UNKNOWN: "unknown", UP: "up", DOWN: "down" };

function hostOf(endpoint) {
  try {
    return new URL(endpoint).host;
  } catch (_) {
    return endpoint;
  }
}

// Cheap GET probe derived from the configured /v2/check URL.
function probeUrl(endpoint) {
  try {
    const u = new URL(endpoint);
    u.search = "";
    u.pathname = u.pathname.replace(/\/check\/?$/, "/languages");
    return u.toString();
  } catch (_) {
    return endpoint;
  }
}

// Reflect reachability on the toolbar icon + hover tooltip.
function setStatus(state, detail, host) {
  const stamp = new Date().toLocaleTimeString();
  const where = host ? ` (${host})` : "";
  if (state === HEALTH.UP) {
    browser.action.setIcon({ path: { 16: "icon-16.png", 32: "icon-32.png", 48: "icon-48.png" } });
    browser.action.setBadgeText({ text: "" });
    browser.action.setTitle({
      title: `LanguageTool Inline\n✓ Server reachable${where}\nLast checked ${stamp}`,
    });
  } else if (state === HEALTH.DOWN) {
    browser.action.setIcon({ path: { 16: "icon-off-16.png", 32: "icon-off-32.png", 48: "icon-off-48.png" } });
    browser.action.setBadgeBackgroundColor({ color: "#b00020" });
    browser.action.setBadgeText({ text: "!" });
    browser.action.setTitle({
      title: `LanguageTool Inline\n✕ Server unreachable${where}${detail ? `\n${detail}` : ""}\nLast checked ${stamp}`,
    });
  } else {
    browser.action.setBadgeText({ text: "" });
    browser.action.setTitle({ title: "LanguageTool Inline\nChecking server…" });
  }
}

async function pingServer() {
  const cfg = await getConfig();
  const host = hostOf(cfg.endpoint);
  try {
    const res = await fetch(probeUrl(cfg.endpoint), { method: "GET", cache: "no-store" });
    if (res.ok) {
      setStatus(HEALTH.UP, null, host);
      return true;
    }
    setStatus(HEALTH.DOWN, `HTTP ${res.status}`, host);
    return false;
  } catch (e) {
    setStatus(HEALTH.DOWN, String(e), host);
    return false;
  }
}

async function check(text) {
  const cfg = await getConfig();

  const params = new URLSearchParams({ text, language: cfg.language });
  // preferredVariants is ONLY valid with language=auto (LT 400s otherwise).
  if (cfg.language === "auto" && cfg.preferredVariants) {
    params.set("preferredVariants", cfg.preferredVariants);
  }
  // motherTongue enables "false friends" detection; valid with any language.
  if (cfg.motherTongue) params.set("motherTongue", cfg.motherTongue);

  let res;
  try {
    res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
  } catch (e) {
    // Network error / server down / blocked (mixed content, missing host permission).
    setStatus(HEALTH.DOWN, String(e), hostOf(cfg.endpoint));
    return { ok: false, error: `Could not reach LanguageTool: ${e}` };
  }

  if (!res.ok) return { ok: false, error: `LanguageTool returned HTTP ${res.status}` };

  let data;
  try {
    data = await res.json();
  } catch (e) {
    return { ok: false, error: `Bad JSON from LanguageTool: ${e}` };
  }

  const ignored = new Set(
    (cfg.ignoredCategories || "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  );

  const matches = (data.matches || [])
    .filter((m) => !ignored.has((m.rule?.category?.id || "").toUpperCase()))
    .map((m) => ({
      offset: m.offset,
      length: m.length,
      message: m.message,
      shortMessage: m.shortMessage || "",
      replacements: (m.replacements || []).slice(0, 5).map((r) => r.value),
      ruleId: m.rule?.id || "",
      category: m.rule?.category?.name || "",
      issueType: m.rule?.issueType || "",
    }));

  setStatus(HEALTH.UP, null, hostOf(cfg.endpoint));
  return { ok: true, matches };
}

// Strip Qwen reasoning blocks and wrapping quotes the model sometimes adds.
function cleanRewrite(s) {
  return s
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .trim();
}

// Try to pull a [{label, text}] list out of a JSON variants response.
// Parse the delimiter-separated variants format:
//   [label]\n<text>\n===VARIANT===\n[label]\n<text> ...
// Plain text, so (unlike a big JSON string) the model can't malform it. Falls
// back to splitting on a bare "===VARIANT===" if a block has no [label].
function parseVariants(s) {
  let t = s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  // Tolerate a stray ```fence the model might still wrap things in.
  t = t.replace(/^```(?:\w+)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (!t) return null;
  const blocks = t.split(/^\s*={2,}\s*VARIANT\s*={2,}\s*$/im);
  const out = [];
  for (const block of blocks) {
    const b = block.trim();
    if (!b) continue;
    const m = b.match(/^\[([^\]]+)\]\s*([\s\S]*)$/);
    let label;
    let body;
    if (m) {
      label = m[1].trim();
      body = m[2];
    } else {
      label = "Option";
      body = b;
    }
    const text = cleanRewrite(body);
    if (text) out.push({ label: label || "Option", text });
  }
  return out.length ? out : null;
}

// LLM rephrase: POST to an OpenAI-compatible chat endpoint.
async function rewrite(text) {
  const cfg = await getConfig();
  const variants = !!cfg.rephraseVariants;

  let system = cfg.rewritePrompt;
  if (variants) {
    system +=
      "\n\nProvide several alternatives in distinct writing styles. If no specific styles are requested above, use exactly these three: casual, professional, and concise. Write every rewrite in the SAME LANGUAGE as the input (e.g. German input -> German rewrites), and write each style label in that same language too.\n\nFormat your answer EXACTLY like this, with each alternative separated by a line containing only ===VARIANT===, and each alternative starting with its style label in square brackets on its own line:\n[casual]\nthe casual rewrite here\n===VARIANT===\n[professional]\nthe professional rewrite here\n===VARIANT===\n[concise]\nthe concise rewrite here\n\nOutput nothing else.";
  }

  const body = {
    messages: [
      { role: "system", content: system },
      { role: "user", content: text },
    ],
    temperature: 0.2,
    top_p: 0.9,
    top_k: 20,
    min_p: 0,
    max_tokens: variants ? 16384 : 8192,
    stream: false,
  };
  // No response_format: variants use a plain-text delimiter format (parseVariants),
  // which a small model can't malform the way it does a big JSON string.

  let res;
  try {
    res = await fetch(cfg.rewriteEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: `Could not reach rewrite server: ${e}` };
  }
  if (!res.ok) return { ok: false, error: `Rewrite server returned HTTP ${res.status}` };

  let data;
  try {
    data = await res.json();
  } catch (e) {
    return { ok: false, error: `Bad JSON from rewrite server: ${e}` };
  }

  const raw = data?.choices?.[0]?.message?.content || "";

  if (variants) {
    const list = parseVariants(raw);
    if (list && list.length) return { ok: true, variants: list };
    // Fall back to a single rewrite if the model didn't return parseable JSON.
  }

  const out = cleanRewrite(raw);
  if (!out) return { ok: false, error: "Empty rewrite from server" };
  return { ok: true, text: out };
}

// --- AI proofread (LLM second pass) ---------------------------------------
// LanguageTool's free tier misses confused words (their/there, its/it's,
// then/than, …) — those rules are premium-gated. After LT runs, the user can
// trigger an LLM pass to catch exactly that class of error.
//
// Strategy: the model returns the WHOLE corrected text as plain text (so it
// can't malform a big JSON string — a recurring failure on small models), then
// a delimiter, then a SHORT JSON list of {from,to,reason}. We compute the exact
// edit locations ourselves by DIFFING original vs corrected — the diff is the
// source of truth for *where* (so offsets are always minimal and exact, and a
// word the model left unchanged simply produces no hunk). The model's reasons
// only annotate the diff hunks; they can't invent changes.
const AI_PROOFREAD_PROMPT = `You are a meticulous proofreader. The text was already spell- and grammar-checked by a basic tool. Correct ONLY real remaining errors it likely missed: confused words (their/there/they're, your/you're, its/it's, then/than, to/too), wrong word choice, and missing or misplaced punctuation. Do NOT rephrase, reword, restructure, or change writing style; change as few words as possible and leave everything else exactly as it was. Use only plain ASCII punctuation (straight quotes, regular hyphens).

Output the full corrected text first, as plain text exactly as it should read, with no quotes, no markdown, and no numbering or labels. Then output a line containing only the marker ===CHANGES=== and, after it, a JSON array of the changes you made: [{"from":"<wrong word>","to":"<fix>","reason":"<short reason, max 8 words>"}]. If you changed nothing, output the unchanged text, the marker, and [].`;

const AI_DELIM = /={3,}\s*CHANGES\s*={3,}/i;

// Split the model output into the corrected text and the (optional) reasons list.
function parseAiResponse(raw) {
  let t = String(raw || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const m = t.match(AI_DELIM);
  if (!m) {
    // No delimiter — treat the whole thing as the corrected text; reasons auto-derived.
    return { corrected: stripWrap(t), reasons: [] };
  }
  const corrected = stripWrap(t.slice(0, m.index).trim());
  let rest = t.slice(m.index + m[0].length).trim();
  rest = rest.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let reasons = [];
  try {
    const a = JSON.parse(rest);
    if (Array.isArray(a)) reasons = a;
  } catch (_) {
    /* short-string JSON rarely fails; if it does, fall back to auto reasons */
  }
  return { corrected, reasons };
}
function stripWrap(s) {
  return s.replace(/^["'`]+|["'`]+$/g, "").trim();
}

// Tokenize into words + the whitespace/punctuation runs between them, tracking
// each token's start offset in the source string.
function tokenizeWithPos(s) {
  const toks = [];
  const re = /\s+|\S+/g;
  let m;
  while ((m = re.exec(s))) toks.push({ t: m[0], i: m.index });
  return toks;
}

// Word-level LCS diff: returns minimal change hunks as {offset,length,original,
// suggestion} positioned in the ORIGINAL text. Adjacent hunks separated only by
// whitespace are coalesced so a one-to-many split (e.g. "allot" -> "a lot")
// reads as a single change instead of fragments.
function diffToIssues(orig, corr) {
  const A = tokenizeWithPos(orig);
  const B = tokenizeWithPos(corr);
  const n = A.length;
  const k = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(k + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = k - 1; j >= 0; j--) {
      dp[i][j] = A[i].t === B[j].t ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const hunks = [];
  let i = 0;
  let j = 0;
  // `pos` is the offset in `orig` just past the last consumed A token, so an
  // insertion-only hunk (no deletion) still gets a valid anchor — otherwise the
  // inserted tokens would be dropped and apply-all wouldn't reproduce the text.
  let pos = 0;
  let dStart = null;
  let dEnd = null;
  let ins = [];
  const flush = () => {
    if (dStart !== null || ins.length) {
      const start = dStart === null ? pos : dStart;
      hunks.push({ offset: start, end: dEnd === null ? start : dEnd, ins: ins.join("") });
    }
    dStart = null;
    dEnd = null;
    ins = [];
  };
  while (i < n && j < k) {
    if (A[i].t === B[j].t) {
      flush();
      pos = A[i].i + A[i].t.length;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      if (dStart === null) dStart = A[i].i;
      dEnd = A[i].i + A[i].t.length;
      pos = dEnd;
      i++;
    } else {
      ins.push(B[j].t);
      j++;
    }
  }
  while (i < n) {
    if (dStart === null) dStart = A[i].i;
    dEnd = A[i].i + A[i].t.length;
    pos = dEnd;
    i++;
  }
  while (j < k) {
    ins.push(B[j].t);
    j++;
  }
  flush();

  let issues = hunks
    .map((h) => ({
      offset: h.offset,
      length: Math.max(0, h.end - h.offset),
      original: orig.slice(h.offset, h.end),
      suggestion: h.ins,
    }))
    .filter((h) => h.original !== h.suggestion);

  // Coalesce hunks separated only by whitespace in the original: a one-to-many
  // word split (e.g. "allot" -> "a lot") can fragment into adjacent hunks; merge
  // them so each change reads as a single edit.
  const merged = [];
  for (const h of issues) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const gapStart = prev.offset + prev.length;
      const gap = orig.slice(gapStart, h.offset);
      if (gap === "" || /^\s+$/.test(gap)) {
        prev.length = h.offset + h.length - prev.offset;
        prev.original = orig.slice(prev.offset, prev.offset + prev.length);
        prev.suggestion = prev.suggestion + gap + h.suggestion;
        continue;
      }
    }
    merged.push({ ...h });
  }
  return merged.filter((h) => h.original !== h.suggestion);
}

// Light, local category guess for the change chip (no model round-trip).
function categorize(from, to) {
  const f = from.toLowerCase().replace(/[^a-z']/g, "");
  const t = to.toLowerCase().replace(/[^a-z']/g, "");
  const CONFUSIONS = "their there they're your you're its it's then than to too lose loose affect effect accept except whether weather a lot".split(/\s+/);
  if (CONFUSIONS.includes(f) || CONFUSIONS.includes(t)) return "confused word";
  if (!/[a-z]/i.test(from) || !/[a-z]/i.test(to)) return "punctuation";
  return "word choice";
}

async function aiProofread(text) {
  const cfg = await getConfig();
  if (!cfg.rewriteEndpoint) return { ok: false, error: "No LLM endpoint configured." };

  const body = {
    messages: [
      { role: "system", content: AI_PROOFREAD_PROMPT },
      { role: "user", content: text },
    ],
    temperature: 0.1,
    top_p: 0.9,
    top_k: 20,
    min_p: 0,
    max_tokens: 8000, // must fit the whole corrected text + reasons
    stream: false,
  };

  let res;
  try {
    res = await fetch(cfg.rewriteEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: `Could not reach AI server: ${e}` };
  }
  if (!res.ok) return { ok: false, error: `AI server returned HTTP ${res.status}` };

  let data;
  try {
    data = await res.json();
  } catch (e) {
    return { ok: false, error: `Bad JSON from AI server: ${e}` };
  }

  const raw = data?.choices?.[0]?.message?.content || "";
  const { corrected, reasons } = parseAiResponse(raw);
  if (!corrected) return { ok: true, issues: [] };

  const hunks = diffToIssues(text, corrected);
  const issues = hunks.map((h) => {
    const from = h.original.trim();
    const to = h.suggestion.trim();
    // Pair with the model's reason by matching the changed word(s).
    const r = reasons.find((c) => {
      const cf = String(c.from || "").trim().toLowerCase();
      return cf && (cf === from.toLowerCase() || from.toLowerCase().includes(cf));
    });
    const reason = r?.reason ? String(r.reason).trim() : `${categorize(from, to)}: ${from} → ${to}`;
    return { offset: h.offset, length: h.length, original: h.original, suggestion: h.suggestion, reason };
  });
  return { ok: true, issues };
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "lt-check") {
    // Returning a promise sends the resolved value back as the response.
    return check(msg.text);
  }
  if (msg && msg.type === "lt-rewrite") {
    return rewrite(msg.text);
  }
  if (msg && msg.type === "lt-aicheck") {
    return aiProofread(msg.text);
  }
  return false;
});

// --- Toolbar button -------------------------------------------------------
// Left-click the icon, or right-click → "Settings", to open the options page.
// Right-click → "Check connection" forces an immediate reachability re-check.
function openSettings() {
  browser.runtime.openOptionsPage();
}

// One-time setup: create the context menus + the periodic health alarm. Runs on
// install/update (the SW may then be killed; the menus/alarm persist). Creating
// a menu that already exists throws, so we recreate idempotently.
function createMenus() {
  browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({
      id: "lt-open-settings",
      title: "Settings",
      contexts: ["action"],
    });
    browser.contextMenus.create({
      id: "lt-check-conn",
      title: "Check connection",
      contexts: ["action"],
    });
    // Right-click "Rephrase selection" — always available on a text selection.
    browser.contextMenus.create({
      id: "lt-rephrase-selection",
      title: "✨ Rephrase with LanguageTool Inline",
      contexts: ["selection"],
    });
  });
}

browser.runtime.onInstalled.addListener(() => {
  createMenus();
  browser.alarms.create("lt-health", { periodInMinutes: 1 });
  pingServer();
});
// On browser startup the SW spins up but onInstalled does NOT fire — re-probe.
browser.runtime.onStartup.addListener(() => {
  pingServer();
});

// --- Event listeners (top level: re-registered on every SW wake) ----------
browser.action.onClicked.addListener(openSettings);

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "lt-open-settings") openSettings();
  else if (info.menuItemId === "lt-check-conn") pingServer();
  else if (info.menuItemId === "lt-rephrase-selection" && tab && tab.id != null) {
    browser.tabs.sendMessage(tab.id, { type: "lt-rephrase-selection" });
  }
});

browser.alarms.onAlarm.addListener((a) => {
  if (a.name === "lt-health") pingServer();
});

browser.storage.onChanged.addListener((changes) => {
  if (changes.endpoint) pingServer();
});
