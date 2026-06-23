// SPDX-License-Identifier: AGPL-3.0-or-later
// LanguageTool Inline (desktop) — Copyright (C) 2026 Oratorian. See LICENSE.
//
// Uses the global Tauri API (withGlobalTauri: true) so no bundler is needed.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow, currentMonitor, LogicalSize, LogicalPosition, PhysicalPosition } =
  window.__TAURI__.window;

const win = getCurrentWindow();
const fab = document.getElementById("fab");
const panel = document.getElementById("panel");
const result = document.getElementById("result");
const status = document.getElementById("status");

let captured = "";
let isCollapsed = true;
let savePosTimer = null;

// Resolve UI language from config (or system), then translate the DOM.
async function refreshLocale() {
  let lang = "auto";
  try {
    const cfg = await invoke("get_config");
    lang = cfg.ui_language || "auto";
  } catch (_) {}
  setLocale(resolveLocale(lang));
  applyTranslations(document);
}

const COLLAPSED = { w: 72, h: 72 };
const EXPANDED = { w: 360, h: 520 };
// Current expanded panel size (logical px) — restored from disk, updated on resize.
let panelW = EXPANDED.w;
let panelH = EXPANDED.h;

async function positionBottomRight(w, h) {
  const mon = await currentMonitor();
  if (!mon) return;
  const sf = mon.scaleFactor || 1;
  const sw = mon.size.width / sf;
  const sh = mon.size.height / sf;
  await win.setPosition(new LogicalPosition(sw - w - 24, sh - h - 48));
}

async function metrics() {
  const sf = await win.scaleFactor();
  return {
    bw: Math.round(COLLAPSED.w * sf),
    bh: Math.round(COLLAPSED.h * sf),
    pw: Math.round(panelW * sf),
    ph: Math.round(panelH * sf),
  };
}

async function init() {
  await refreshLocale();
  await win.setSize(new LogicalSize(COLLAPSED.w, COLLAPSED.h));
  const saved = await invoke("load_position");
  if (saved && Number.isFinite(saved.w) && Number.isFinite(saved.h)) {
    panelW = saved.w;
    panelH = saved.h;
  }
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    await win.setPosition(new PhysicalPosition(saved.x, saved.y));
  } else {
    await positionBottomRight(COLLAPSED.w, COLLAPSED.h);
  }
  isCollapsed = true;
  panel.classList.add("hidden");
  fab.classList.remove("hidden");
}

async function expand() {
  isCollapsed = false;
  const p = await win.outerPosition(); // current button position (may be dragged)
  const { bw, bh, pw, ph } = await metrics();
  await win.setSize(new LogicalSize(panelW, panelH));
  // Grow up-left so the panel's bottom-right stays anchored to the button.
  await win.setPosition(
    new PhysicalPosition(Math.max(0, p.x + bw - pw), Math.max(0, p.y + bh - ph))
  );
  fab.classList.add("hidden");
  panel.classList.remove("hidden");
}

async function collapse() {
  const p = await win.outerPosition(); // current panel position (may be dragged)
  const { bw, bh, pw, ph } = await metrics();
  isCollapsed = true;
  panel.classList.add("hidden");
  fab.classList.remove("hidden");
  result.innerHTML = "";
  status.textContent = "";
  await win.setSize(new LogicalSize(COLLAPSED.w, COLLAPSED.h));
  // Put the button at the panel's bottom-right corner (mirrors expand()).
  await win.setPosition(
    new PhysicalPosition(Math.max(0, p.x + pw - bw), Math.max(0, p.y + ph - bh))
  );
}

async function start() {
  await refreshLocale();
  status.textContent = t("panel.reading");
  try {
    captured = await invoke("capture_selection");
  } catch (e) {
    captured = "";
  }
  await expand();
  if (!captured || !captured.trim()) {
    result.innerHTML = "";
    status.textContent = t("panel.selectFirst");
  } else {
    const preview = captured.slice(0, 90) + (captured.length > 90 ? "…" : "");
    status.textContent = "“" + preview + "”";
  }
}

async function run(act) {
  if (!captured || !captured.trim()) {
    status.textContent = t("panel.nothing");
    return;
  }
  if (act === "fix") {
    await grammarFlow(captured);
    return;
  }
  if (act === "proofread") {
    await proofreadFlow(captured);
    return;
  }
  result.innerHTML = "";
  status.textContent = t("panel.working");
  try {
    // "variants" always returns styles. Plain "rephrase" returns styles too when
    // the rephrase_variants setting is on (mirrors the browser extension's
    // single-button behaviour); otherwise a single rewrite.
    let asVariants = act === "variants";
    if (act === "rephrase") {
      try {
        const cfg = await invoke("get_config");
        asVariants = !!cfg.rephrase_variants;
      } catch (_) {}
    }
    if (asVariants) {
      showVariants(await invoke("rephrase_variants", { text: captured }));
    } else {
      showSingle(await invoke("rephrase", { text: captured }));
    }
    status.textContent = "";
  } catch (e) {
    status.textContent = t("panel.error") + e;
  }
}

function applyBtn(text, label) {
  const b = document.createElement("button");
  b.className = "apply";
  b.textContent = label;
  b.addEventListener("click", () => apply(text));
  return b;
}

function showSingle(text) {
  result.innerHTML = "";
  const out = document.createElement("div");
  out.className = "out";
  out.textContent = text;
  result.appendChild(out);
  result.appendChild(applyBtn(text, t("panel.apply")));
}

function showVariants(vars) {
  result.innerHTML = "";
  if (!vars || !vars.length) {
    result.textContent = t("panel.noVariants");
    return;
  }
  for (const v of vars) {
    const row = document.createElement("div");
    row.className = "variant";
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = v.label;
    const out = document.createElement("div");
    out.className = "out";
    out.textContent = v.text;
    row.appendChild(label);
    row.appendChild(out);
    row.appendChild(applyBtn(v.text, t("panel.useThis")));
    result.appendChild(row);
  }
}

// Replace [offset, offset+length) — JS strings are UTF-16, matching LT offsets.
function applyRep(s, offset, length, rep) {
  return s.slice(0, offset) + rep + s.slice(offset + length);
}

// Interactive grammar picker: shows each flagged word with LanguageTool's
// suggestions; picking one (or "Apply all") edits a working copy and re-checks.
async function grammarFlow(text) {
  let working = text;

  async function render() {
    result.innerHTML = "";
    status.textContent = t("panel.working");
    let matches;
    try {
      matches = await invoke("check_grammar", { text: working });
    } catch (e) {
      status.textContent = t("panel.error") + e;
      return;
    }
    status.textContent = "";

    if (!matches.length) {
      const ok = document.createElement("div");
      ok.className = "out";
      ok.textContent = t("panel.noIssues");
      result.appendChild(ok);
    } else {
      const allBtn = document.createElement("button");
      allBtn.className = "apply";
      allBtn.style.marginBottom = "8px";
      allBtn.textContent = t("panel.fixAll");
      allBtn.addEventListener("click", () => {
        const edits = matches
          .filter((m) => m.replacements.length)
          .map((m) => [m.offset, m.length, m.replacements[0]])
          .sort((a, b) => b[0] - a[0]);
        for (const [o, l, r] of edits) working = applyRep(working, o, l, r);
        render();
      });
      result.appendChild(allBtn);

      for (const m of matches) {
        const row = document.createElement("div");
        row.className = "variant";

        const lbl = document.createElement("div");
        lbl.className = "label";
        lbl.textContent = m.word;
        row.appendChild(lbl);

        if (m.message) {
          const msg = document.createElement("div");
          msg.className = "msg";
          msg.textContent = m.message;
          row.appendChild(msg);
        }

        const chips = document.createElement("div");
        if (m.replacements.length) {
          for (const rep of m.replacements) {
            const b = document.createElement("button");
            b.className = "chip";
            b.textContent = rep === "" ? "(remove)" : rep;
            b.addEventListener("click", () => {
              working = applyRep(working, m.offset, m.length, rep);
              render();
            });
            chips.appendChild(b);
          }
        } else {
          const none = document.createElement("span");
          none.className = "msg";
          none.textContent = "—";
          chips.appendChild(none);
        }
        row.appendChild(chips);
        result.appendChild(row);
      }
    }

    result.appendChild(applyBtn(working, t("panel.apply")));
  }

  await render();
}

// AI proofread picker: the LLM returns whole-text corrections; the Rust side
// diffs them into per-change issues with reasons. Each fix applies to a working
// copy and re-runs the proofread so remaining issues stay valid. Mirrors the
// browser extension's blue "AI" layer.
async function proofreadFlow(text) {
  let working = text;

  async function render() {
    result.innerHTML = "";
    status.textContent = t("panel.aiWorking");
    let issues;
    try {
      issues = await invoke("ai_proofread", { text: working });
    } catch (e) {
      status.textContent = t("panel.error") + e;
      return;
    }
    status.textContent = "";

    if (!issues.length) {
      const ok = document.createElement("div");
      ok.className = "out";
      ok.textContent = t("panel.aiNothing");
      result.appendChild(ok);
    } else {
      for (const m of issues) {
        const row = document.createElement("div");
        row.className = "variant ai";

        const lbl = document.createElement("div");
        lbl.className = "label";
        const tag = document.createElement("span");
        tag.className = "aitag";
        tag.textContent = "AI";
        lbl.appendChild(tag);
        lbl.appendChild(document.createTextNode(" " + (m.reason || t("panel.aiConfusion"))));
        row.appendChild(lbl);

        const chips = document.createElement("div");
        const b = document.createElement("button");
        b.className = "chip";
        b.textContent = m.suggestion;
        b.addEventListener("click", () => {
          working = applyRep(working, m.offset, m.length, m.suggestion);
          render();
        });
        chips.appendChild(b);
        row.appendChild(chips);
        result.appendChild(row);
      }
    }

    result.appendChild(applyBtn(working, t("panel.apply")));
    const note = document.createElement("div");
    note.className = "ainote";
    note.textContent = t("panel.aiNote");
    result.appendChild(note);
  }

  await render();
}

async function apply(text) {
  try {
    await invoke("apply_text", { text });
    await collapse();
  } catch (e) {
    status.textContent = "Paste failed: " + e;
  }
}

// Make an element drag the window; a plain click (no drag) runs opts.onClick.
// opts.ignore is a selector for child elements that should NOT start a drag.
function enableWindowDrag(el, opts) {
  opts = opts || {};
  let down = null;
  let moved = false;
  el.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (opts.ignore && e.target.closest(opts.ignore)) return;
    down = { x: e.clientX, y: e.clientY };
    moved = false;
  });
  el.addEventListener("mousemove", (e) => {
    if (!down) return;
    if (Math.abs(e.clientX - down.x) > 4 || Math.abs(e.clientY - down.y) > 4) {
      moved = true;
      down = null;
      win.startDragging();
    }
  });
  el.addEventListener("mouseup", () => {
    if (down && !moved && opts.onClick) opts.onClick();
    down = null;
  });
}

// The button: drag to move, click to open. The panel header: drag to move
// (but not when clicking the ✕).
enableWindowDrag(fab, { onClick: start });
enableWindowDrag(document.querySelector(".head"), { ignore: "#close" });

document.getElementById("close").addEventListener("click", collapse);

// Resize the panel by dragging the bottom-right grip; remember the size.
const resizeGrip = document.getElementById("resize");
resizeGrip.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  e.stopPropagation();
  resizeGrip.setPointerCapture(e.pointerId);
  const sx = e.screenX;
  const sy = e.screenY;
  const w0 = panelW;
  const h0 = panelH;
  function move(ev) {
    panelW = Math.max(260, Math.round(w0 + (ev.screenX - sx)));
    panelH = Math.max(220, Math.round(h0 + (ev.screenY - sy)));
    win.setSize(new LogicalSize(panelW, panelH));
  }
  function up() {
    resizeGrip.releasePointerCapture(e.pointerId);
    resizeGrip.removeEventListener("pointermove", move);
    resizeGrip.removeEventListener("pointerup", up);
    invoke("save_size", { w: panelW, h: panelH }).catch(() => {});
  }
  resizeGrip.addEventListener("pointermove", move);
  resizeGrip.addEventListener("pointerup", up);
});
document
  .querySelectorAll(".act")
  .forEach((b) => b.addEventListener("click", () => run(b.dataset.act)));

// Global hotkey (Ctrl+Alt+R) emits "trigger" from Rust.
listen("trigger", start);

// Custom right-click menu: suppress the default WebView2 menu and pop our own.
async function quickAction(act) {
  await start();
  if (captured && captured.trim()) await run(act);
}
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  invoke("show_menu", { locale: LOCALE });
});
listen("menu-action", (e) => quickAction(e.payload));

// Remember the button's position whenever it's moved while collapsed (debounced).
win.onMoved((e) => {
  if (!isCollapsed) return;
  clearTimeout(savePosTimer);
  const { x, y } = e.payload;
  savePosTimer = setTimeout(() => invoke("save_position", { x, y }), 400);
});

init();
