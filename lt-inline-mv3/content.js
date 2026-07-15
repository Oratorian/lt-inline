// SPDX-License-Identifier: AGPL-3.0-or-later
// LanguageTool Inline — Copyright (C) 2026 Oratorian. See LICENSE.
//
// Content script (v2): passive inline underlines + an in-field icon. Nothing
// auto-pops; the suggestion list only opens when the user clicks the icon, and
// closes when focus leaves. Underlines (contenteditable, via the CSS Custom
// Highlight API) never cover text. Selection rephrasing is via the right-click
// menu.

(() => {
  if (window.__ltInlineLoaded) return;
  window.__ltInlineLoaded = true;

  let cfg = { debounceMs: 700, minLength: 4 };
  browser.storage.local.get(cfg).then((c) => (cfg = { ...cfg, ...c }));
  browser.storage.onChanged.addListener((changes) => {
    for (const [k, { newValue }] of Object.entries(changes)) cfg[k] = newValue;
  });

  // ---- element helpers -----------------------------------------------------
  const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", ""]);
  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") return TEXT_INPUT_TYPES.has((el.type || "").toLowerCase());
    return false;
  }
  function getText(el) {
    return el.isContentEditable ? el.textContent || "" : el.value || "";
  }

  // Red = spelling + grammar; yellow = everything else.
  function severityOf(m) {
    const it = (m.issueType || "").toLowerCase();
    return it === "misspelling" || it === "grammar" ? "major" : "minor";
  }

  // ---- CSS Custom Highlight API (contenteditable underlines) ---------------
  const supportsHighlight = typeof Highlight !== "undefined" && !!(window.CSS && CSS.highlights);
  let hlMajor = null;
  let hlMinor = null;
  let hlAI = null;
  if (supportsHighlight) {
    hlMajor = new Highlight();
    hlMinor = new Highlight();
    hlAI = new Highlight();
    CSS.highlights.set("lt-major", hlMajor);
    CSS.highlights.set("lt-minor", hlMinor);
    CSS.highlights.set("lt-ai", hlAI);
  }

  // ---- state ---------------------------------------------------------------
  let activeEl = null;
  let debounceTimer = null;
  let lastText = null;
  let checkedText = null;
  let currentMatches = [];
  let aiMatches = []; // LLM proofread issues (located in checkedText), separate layer
  let aiState = "idle"; // idle | running | done | error
  // Set while WE apply a suggestion, so the resulting `input`/re-check keeps the
  // remaining AI suggestions (shifted) instead of wiping them. {start,end,delta}.
  let selfEdit = null;
  const disabledFields = new WeakSet();

  // In-field pill placement. `side:null` = auto (text-end edge; RTL-aware).
  // offX/offY are the user's drag nudge relative to the computed anchor. Persisted
  // globally so a moved/flipped pill stays put across fields and page loads.
  let place = { side: null, offX: 0, offY: 0 };
  browser.storage.local.get({ ltPlace: null }).then((c) => {
    if (c.ltPlace) place = c.ltPlace;
    positionIcon();
  });
  function savePlace() {
    browser.storage.local.set({ ltPlace: place });
  }

  // ---- contenteditable range mapping (textContent offset -> DOM Range) -----
  function rangeFor(root, start, end) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let pos = 0;
    let sNode = null;
    let sOff = 0;
    let eNode = null;
    let eOff = 0;
    let node;
    while ((node = walker.nextNode())) {
      const len = node.nodeValue.length;
      const ns = pos;
      const ne = pos + len;
      if (sNode === null && start >= ns && start <= ne) {
        sNode = node;
        sOff = start - ns;
      }
      if (sNode !== null && end >= ns && end <= ne) {
        eNode = node;
        eOff = end - ns;
        break;
      }
      pos = ne;
    }
    if (!sNode || !eNode) return null;
    const r = document.createRange();
    try {
      r.setStart(sNode, sOff);
      r.setEnd(eNode, eOff);
    } catch (_) {
      return null;
    }
    return r;
  }

  // ---- apply fixes ---------------------------------------------------------
  function applyToInput(el, offset, length, replacement) {
    const v = el.value;
    el.value = v.slice(0, offset) + replacement + v.slice(offset + length);
    const caret = offset + replacement.length;
    try {
      el.setSelectionRange(caret, caret);
    } catch (_) {}
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function applyToContentEditable(root, offset, length, replacement) {
    const r = rangeFor(root, offset, offset + length);
    if (!r) return false;
    r.deleteContents();
    r.insertNode(document.createTextNode(replacement));
    root.normalize();
    root.dispatchEvent(new InputEvent("input", { bubbles: true }));
    return true;
  }
  // Shift match offsets after an edit at [start,end) that changed length by
  // `delta`: drop any match that overlapped the edited span, and push those
  // after it by `delta`. Keeps unapplied suggestions valid against the new text
  // instead of discarding them.
  function shiftMatches(list, start, end, delta) {
    return list
      .filter((m) => m.offset + m.length <= start || m.offset >= end) // drop overlaps
      .map((m) => (m.offset >= end ? { ...m, offset: m.offset + delta } : m));
  }

  // If the field changed since the check, offsets are stale — bail and let the
  // pending re-check refresh things.
  function applyRange(start, end, replacement) {
    if (!activeEl || getText(activeEl) !== checkedText) return;
    const delta = replacement.length - (end - start);
    // Mark this as our own edit so the ensuing re-check preserves AI results.
    selfEdit = { start, end, delta };
    if (activeEl.isContentEditable) applyToContentEditable(activeEl, start, end - start, replacement);
    else applyToInput(activeEl, start, end - start, replacement);
    activeEl.focus();
    // Shift the remaining matches so the immediate re-render stays consistent;
    // the applied one drops out. The debounced re-check then refreshes LT's
    // matches authoritatively while the AI suggestions (kept) ride along.
    currentMatches = shiftMatches(currentMatches, start, end, delta);
    aiMatches = shiftMatches(aiMatches, start, end, delta);
    checkedText = getText(activeEl);
    renderUnderlines();
    updateIcon();
    if (popup && popup.style.display === "block" && popup.dataset.mode === "issues") renderIssues();
  }
  function applyWhole(text) {
    if (!activeEl || getText(activeEl) !== checkedText) return;
    const len = getText(activeEl).length;
    if (activeEl.isContentEditable) applyToContentEditable(activeEl, 0, len, text);
    else applyToInput(activeEl, 0, len, text);
    activeEl.focus();
  }

  // ---- underlines ----------------------------------------------------------
  function clearUnderlines() {
    removeOverlay(); // form-field overlay (no-op if none)
    if (!supportsHighlight) return;
    hlMajor.clear();
    hlMinor.clear();
    hlAI.clear();
  }
  function renderUnderlines() {
    // Form fields (input/textarea) use the mirror overlay; contenteditable uses
    // the native Highlight API below.
    renderOverlay();
    if (!supportsHighlight) return;
    hlMajor.clear();
    hlMinor.clear();
    hlAI.clear();
    if (!activeEl || !activeEl.isContentEditable || disabledFields.has(activeEl)) return;
    for (const m of currentMatches) {
      const r = rangeFor(activeEl, m.offset, m.offset + m.length);
      if (!r) continue;
      (severityOf(m) === "major" ? hlMajor : hlMinor).add(r);
    }
    for (const m of aiMatches) {
      const r = rangeFor(activeEl, m.offset, m.offset + m.length);
      if (!r) continue;
      hlAI.add(r);
    }
  }

  // ---- textarea / input underline overlay ----------------------------------
  // The CSS Custom Highlight API can only decorate DOM text nodes, so it can't
  // touch text inside <input>/<textarea> (their text lives in native, unreachable
  // internals). To underline errors there we mirror the field into a transparent
  // <div> positioned exactly over it: same text, same metrics, same scroll, with
  // the error ranges wrapped in <span>s that carry the wavy underline. Only the
  // underlines show through; the mirror's own text is transparent.
  let overlay = null;
  let overlayEl = null; // the field the overlay currently mirrors

  // Typographic + box properties the mirror must copy so its wrapped text lands
  // exactly under the real text. Anything affecting glyph advance or line breaks.
  const MIRROR_PROPS = [
    "boxSizing", "width", "height",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant",
    "fontStretch", "letterSpacing", "wordSpacing", "lineHeight", "textIndent",
    "textTransform", "textAlign", "direction", "tabSize",
  ];

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.className = "lt-underlay";
    document.body.appendChild(overlay);
    return overlay;
  }
  function removeOverlay() {
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
    overlayEl = null;
  }
  // Wrap error ranges in the field's text with underline spans. Sorted,
  // non-overlapping segmentation so a char is never double-wrapped (a major/AI
  // overlap just takes the first). Returns a DocumentFragment.
  function buildUnderlineFragment(text) {
    const spans = [];
    for (const m of currentMatches) {
      spans.push({ start: m.offset, end: m.offset + m.length, cls: severityOf(m) });
    }
    for (const m of aiMatches) {
      spans.push({ start: m.offset, end: m.offset + m.length, cls: "ai" });
    }
    spans.sort((a, b) => a.start - b.start);
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const s of spans) {
      const start = Math.max(s.start, pos);
      const end = Math.min(s.end, text.length);
      if (end <= start) continue; // skip empties / overlaps already covered
      if (start > pos) frag.appendChild(document.createTextNode(text.slice(pos, start)));
      const span = document.createElement("span");
      span.className = "lt-ul lt-ul-" + s.cls;
      span.textContent = text.slice(start, end);
      frag.appendChild(span);
      pos = end;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    return frag;
  }
  function renderOverlay() {
    if (!activeEl || activeEl.isContentEditable || disabledFields.has(activeEl)) {
      removeOverlay();
      return;
    }
    const hasMatches = currentMatches.length || aiMatches.length;
    if (!hasMatches) {
      removeOverlay();
      return;
    }
    const ov = ensureOverlay();
    overlayEl = activeEl;
    // Single-line inputs never wrap; textareas wrap like pre-wrap.
    const multiline = activeEl.tagName === "TEXTAREA";
    ov.style.whiteSpace = multiline ? "pre-wrap" : "pre";
    ov.style.overflowWrap = multiline ? "break-word" : "normal";
    ov.textContent = "";
    ov.appendChild(buildUnderlineFragment(getText(activeEl)));
    positionOverlay();
  }
  function positionOverlay() {
    if (!overlay || !overlayEl || overlayEl !== activeEl) return;
    const cs = getComputedStyle(activeEl);
    for (const p of MIRROR_PROPS) overlay.style[p] = cs[p];
    const r = activeEl.getBoundingClientRect();
    overlay.style.left = r.left + "px";
    overlay.style.top = r.top + "px";
    // Mirror the field's internal scroll so wrapped lines stay aligned.
    overlay.scrollTop = activeEl.scrollTop;
    overlay.scrollLeft = activeEl.scrollLeft;
  }

  // ---- in-field icon -------------------------------------------------------
  let icon = null;
  let countEl = null;
  function ensureIcon() {
    if (icon) return icon;
    icon = document.createElement("div");
    icon.className = "lt-icon";

    const toggle = document.createElement("button");
    toggle.className = "lt-i lt-toggle";
    toggle.title = "Enable / disable here";
    toggle.innerHTML =
      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ' +
      'stroke-width="2.4" stroke-linecap="round"><path d="M12 3v8"/>' +
      '<path d="M6.6 6.8a7.5 7.5 0 1 0 10.8 0"/></svg>';

    const reph = document.createElement("button");
    reph.className = "lt-i lt-reph";
    reph.title = "Rephrase";
    reph.textContent = "✨";

    const stat = document.createElement("button");
    stat.className = "lt-i lt-stat";
    stat.title = "Show issues";
    countEl = document.createElement("span");
    countEl.className = "lt-count";
    countEl.textContent = "✓";
    stat.appendChild(countEl);

    icon.append(toggle, reph, stat);
    icon.addEventListener("mousedown", (e) => e.preventDefault()); // keep field focus
    toggle.addEventListener("click", onToggle);
    reph.addEventListener("click", onRephraseField);
    stat.addEventListener("click", onOpenIssues);
    makeDraggable(stat);
    document.body.appendChild(icon);
    return icon;
  }

  // The user can drag the count badge to move the pill anywhere, or Alt-click it
  // to flip which side of the field it anchors to. Both persist globally. A plain
  // click (no drag) still opens the issues popup.
  function makeDraggable(handle) {
    let sx = 0;
    let sy = 0;
    let moved = false;
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      moved = false;
      sx = e.clientX;
      sy = e.clientY;
      icon.dataset.dragging = "1";
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {}
    });
    handle.addEventListener("pointermove", (e) => {
      if (icon.dataset.dragging !== "1") return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      const b = icon.getBoundingClientRect();
      icon.style.left = "auto";
      icon.style.right = Math.max(6, window.innerWidth - b.right - dx) + "px";
      icon.style.top = Math.max(6, Math.min(b.top + dy, window.innerHeight - 32)) + "px";
      icon.dataset.side = "right"; // free-drag is right-anchored; keep expand consistent
      sx = e.clientX;
      sy = e.clientY;
    });
    handle.addEventListener("pointerup", (e) => {
      if (icon.dataset.dragging !== "1") return;
      icon.dataset.dragging = "0";
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {}
      if (!moved || !activeEl) return; // no drag → let the click open issues
      const r = activeEl.getBoundingClientRect();
      const b = icon.getBoundingClientRect();
      place.side = b.left + b.width / 2 < r.left + r.width / 2 ? "left" : "right";
      const h = icon.offsetHeight || 26;
      const baseTop = r.height < h + 12 ? r.top + (r.height - h) / 2 : r.bottom - h - 6;
      place.offY = Math.max(-40, Math.min(b.top - baseTop, 40));
      place.offX = 0;
      savePlace();
      positionIcon();
    });
    handle.addEventListener(
      "click",
      (e) => {
        if (moved) {
          e.stopImmediatePropagation(); // swallow the synthetic post-drag click
          moved = false;
          return;
        }
        if (!e.altKey) return; // plain click → onOpenIssues (bubble phase)
        e.stopImmediatePropagation();
        const rtl = activeEl && getComputedStyle(activeEl).direction === "rtl";
        const cur = place.side || (rtl ? "left" : "right");
        place.side = cur === "right" ? "left" : "right";
        place.offX = 0;
        savePlace();
        positionIcon();
      },
      true // capture: beat onOpenIssues (bubble listener above)
    );
  }
  function showIcon() {
    ensureIcon();
    icon.style.display = "flex";
    positionIcon();
  }
  function hideIcon() {
    if (icon) icon.style.display = "none";
  }
  function positionIcon() {
    if (!icon || !activeEl || icon.style.display === "none") return;
    if (icon.dataset.dragging === "1") return; // don't fight a live drag

    const r = activeEl.getBoundingClientRect();
    const h = icon.offsetHeight || 26;
    // Collapsed pill width for the geometry. Measure it live, but ONLY while the
    // pill isn't hovered — mid-hover-transition offsetWidth is an interpolated
    // value that would make the anchor jitter. Fall back to a sane constant.
    const hovered = icon.matches(":hover");
    const COLLAPSED_W = !hovered && icon.offsetWidth ? icon.offsetWidth : 26;
    const M = 6; // viewport margin
    const GAP = 4; // gap between field edge and an OUTSIDE pill
    const VW = window.innerWidth;
    const VH = window.innerHeight;

    const rtl = getComputedStyle(activeEl).direction === "rtl";
    // "Short" = the field has no empty vertical band tall enough to hide the pill
    // in, so an in-corner pill would sit right on the text (the reported bug).
    const short = r.height < h + 12;

    // ---- vertical ----
    let top = short
      ? r.top + (r.height - h) / 2 + place.offY // center on a short field
      : r.bottom - h - M + place.offY; // bottom-inside on a tall field
    top = Math.max(M, Math.min(top, VH - h - M));
    icon.style.top = top + "px";

    // ---- horizontal ----
    // Default text-end side: right for LTR, left for RTL. User preference wins.
    const preferred = place.side || (rtl ? "left" : "right");

    // Room to place the pill fully OUTSIDE each field edge while staying on-screen.
    const outsideRightOK = short && VW - r.right - GAP - COLLAPSED_W >= M && r.right < VW - M;
    const outsideLeftOK = short && r.left - GAP - COLLAPSED_W >= M && r.left > M;

    // On a tall field we keep the original inside-corner placement (bottom-right/
    // left) — there is genuine empty space there. On a short field we go OUTSIDE
    // the field. Crucially, when outside won't fit (field flush to the viewport
    // edge) we fall back to the field's *text-start* edge, NOT the text-end
    // corner — otherwise we'd re-cover the very text the user was missing.
    let mode; // "outR" | "outL" | "inR" | "inL"
    if (!short) {
      mode = preferred === "left" ? "inL" : "inR";
    } else if (preferred === "right") {
      mode = outsideRightOK ? "outR" : outsideLeftOK ? "outL" : "inL";
    } else {
      mode = outsideLeftOK ? "outL" : outsideRightOK ? "outR" : "inR";
    }

    let left = null;
    let right = null;
    switch (mode) {
      case "outR":
        right = VW - r.right - GAP - COLLAPSED_W;
        break; // outside the right edge
      case "outL":
        left = r.left - GAP - COLLAPSED_W;
        break; // outside the left edge
      case "inR":
        right = VW - r.right + M;
        break; // inside bottom-right corner (tall)
      case "inL":
        left = r.left + M;
        break; // inside the far/text-start edge (short flush fallback)
    }

    // Apply the horizontal user nudge in the anchored axis, then clamp on-screen.
    if (left !== null) {
      left += place.offX;
      left = Math.max(M, Math.min(left, VW - COLLAPSED_W - M));
      icon.style.right = "auto";
      icon.style.left = left + "px";
    } else {
      right -= place.offX;
      right = Math.max(M, Math.min(right, VW - COLLAPSED_W - M));
      icon.style.left = "auto";
      icon.style.right = right + "px";
    }

    // Hover-expand direction follows the ANCHORED edge so the pill always grows
    // AWAY from it (badge stays put): left-anchored → reveal rightward (CSS
    // row-reverse); right-anchored → reveal leftward (default order).
    icon.dataset.side = left !== null ? "left" : "right";
  }
  function updateIcon() {
    if (!icon) return;
    if (activeEl && disabledFields.has(activeEl)) {
      countEl.textContent = "○";
      icon.dataset.sev = "off";
      return;
    }
    const n = currentMatches.length + aiMatches.length;
    const hasMajor = currentMatches.some((m) => severityOf(m) === "major");
    const hasAI = aiMatches.length > 0;
    countEl.textContent = n ? String(n) : "✓";
    icon.dataset.sev = n ? (hasMajor ? "major" : hasAI ? "ai" : "minor") : "clean";
  }
  // AI results are pinned to a specific checked text; drop them when it changes.
  function resetAi() {
    aiMatches = [];
    aiState = "idle";
  }
  function onToggle() {
    if (!activeEl) return;
    if (disabledFields.has(activeEl)) {
      disabledFields.delete(activeEl);
      lastText = null;
      scheduleCheck();
    } else {
      disabledFields.add(activeEl);
      currentMatches = [];
      clearUnderlines();
      closePopup();
      updateIcon();
    }
  }

  // ---- on-demand suggestions popup ----------------------------------------
  let popup = null;
  function ensurePopup() {
    if (popup) return popup;
    popup = document.createElement("div");
    popup.className = "lt-popup";
    popup.addEventListener("mousedown", (e) => e.preventDefault());
    document.body.appendChild(popup);
    return popup;
  }
  function closePopup() {
    if (popup) popup.style.display = "none";
  }
  function positionPopup() {
    if (!popup || !activeEl || popup.style.display !== "block") return;
    const r = activeEl.getBoundingClientRect();
    const MARGIN = 8;
    const GAP = 6; // gap between field edge and popup
    const w = Math.min(340, window.innerWidth - 2 * MARGIN);
    popup.style.width = w + "px";

    // Prefer opening to the SIDE of the field (anchored near the pill at the
    // bottom-right corner): a side has the full viewport height to grow into,
    // which is far more room than the sliver above/below a short textbox.
    const spaceRight = window.innerWidth - r.right - GAP - MARGIN;
    const spaceLeft = r.left - GAP - MARGIN;

    let left;
    let avail; // vertical budget for max-height
    let top;
    if (Math.max(spaceRight, spaceLeft) >= w) {
      // Side placement: right if it fits (or has more room), else left. Bias
      // toward the side the pill actually sits on so the popup stays anchored to
      // it after a flip/drag/left-fallback.
      const pillLeft = icon && icon.dataset.side === "left";
      const right = pillLeft
        ? spaceRight >= w && spaceLeft < w
        : spaceRight >= w || spaceRight >= spaceLeft;
      left = right ? r.right + GAP : r.left - GAP - w;
      avail = window.innerHeight - 2 * MARGIN;
      popup.style.maxHeight = avail + "px";
      // Anchor the popup near the pill (field's bottom), then clamp on-screen.
      const h = Math.min(popup.offsetHeight, avail);
      top = Math.min(Math.max(MARGIN, r.bottom - h), window.innerHeight - MARGIN - h);
    } else {
      // No horizontal room (narrow window / full-width field): fall back to
      // below/above, whichever has more vertical space.
      const spaceBelow = window.innerHeight - r.bottom - 2 * MARGIN;
      const spaceAbove = r.top - 2 * MARGIN;
      const below = spaceBelow >= spaceAbove;
      avail = Math.max(80, below ? spaceBelow : spaceAbove);
      popup.style.maxHeight = avail + "px";
      const h = Math.min(popup.offsetHeight, avail);
      top = below ? r.bottom + MARGIN : Math.max(MARGIN, r.top - MARGIN - h);
      left = Math.min(r.left, window.innerWidth - w - MARGIN);
    }
    popup.style.left = Math.max(MARGIN, left) + "px";
    popup.style.top = Math.max(MARGIN, top) + "px";
  }
  function onOpenIssues() {
    const p = ensurePopup();
    if (p.style.display === "block" && p.dataset.mode === "issues") {
      closePopup();
      return;
    }
    renderIssues();
  }
  function renderIssues() {
    const p = ensurePopup();
    p.dataset.mode = "issues";
    p.textContent = "";
    if (!currentMatches.length && !aiMatches.length) {
      const ok = document.createElement("div");
      ok.className = "lt-pp-empty";
      ok.textContent = "No issues 🎉";
      p.appendChild(ok);
    } else {
      for (const m of currentMatches) {
        const row = document.createElement("div");
        row.className = "lt-pp-row lt-" + severityOf(m);
        const msg = document.createElement("div");
        msg.className = "lt-pp-msg";
        msg.textContent = m.shortMessage || m.message;
        msg.title = m.message;
        row.appendChild(msg);
        if (m.replacements.length) {
          const chips = document.createElement("div");
          chips.className = "lt-pp-chips";
          for (const rep of m.replacements.slice(0, 5)) {
            const b = document.createElement("button");
            b.className = "lt-chip";
            b.textContent = rep === "" ? "(remove)" : rep;
            b.addEventListener("click", () => applyRange(m.offset, m.offset + m.length, rep));
            chips.appendChild(b);
          }
          row.appendChild(chips);
        }
        p.appendChild(row);
      }
      // AI issues, in their own clearly-labelled blue rows.
      for (const m of aiMatches) {
        const row = document.createElement("div");
        row.className = "lt-pp-row lt-ai";
        const msg = document.createElement("div");
        msg.className = "lt-pp-msg";
        msg.innerHTML = '<span class="lt-pp-aitag">AI</span>';
        msg.appendChild(document.createTextNode(m.reason || "Possible word confusion"));
        row.appendChild(msg);
        const chips = document.createElement("div");
        chips.className = "lt-pp-chips";
        const b = document.createElement("button");
        b.className = "lt-chip";
        b.textContent = m.suggestion;
        b.addEventListener("click", () => applyRange(m.offset, m.offset + m.length, m.suggestion));
        chips.appendChild(b);
        row.appendChild(chips);
        p.appendChild(row);
      }
    }
    renderAiFooter(p);
    p.style.display = "block";
    positionPopup();
  }

  // The on-demand "AI proofread" trigger / status line at the bottom of the
  // issues popup. Only meaningful when there's checked text to send.
  function renderAiFooter(p) {
    const foot = document.createElement("div");
    foot.className = "lt-pp-aifoot";
    if (aiState === "running") {
      foot.classList.add("lt-pp-empty");
      foot.textContent = "AI proofreading…";
    } else if (aiState === "error") {
      foot.classList.add("lt-pp-empty");
      foot.textContent = "AI proofread failed.";
    } else if (aiState === "done" && !aiMatches.length) {
      foot.classList.add("lt-pp-empty");
      foot.textContent = "AI found nothing extra ✓";
    } else {
      const b = document.createElement("button");
      b.className = "lt-chip lt-ai-run";
      b.textContent = aiState === "done" ? "↻ AI proofread again" : "✦ AI proofread";
      b.title = "Send the text to the LLM to catch confused words LanguageTool misses";
      b.addEventListener("click", onAiCheck);
      foot.appendChild(b);
      // Disclaimer right under the trigger — AI can be wrong, so review each
      // suggestion before applying. Shown alongside the button (not while a run
      // is in flight or after an empty/failed result).
      const note = document.createElement("div");
      note.className = "lt-pp-ainote";
      note.textContent = "AI can make mistakes — review each suggestion before applying.";
      foot.appendChild(note);
    }
    p.appendChild(foot);
  }

  async function onAiCheck() {
    if (!activeEl || aiState === "running") return;
    const text = checkedText != null ? checkedText : getText(activeEl);
    if (!text || !text.trim()) return;
    aiState = "running";
    aiMatches = [];
    renderIssues();
    const resp = await browser.runtime.sendMessage({ type: "lt-aicheck", text });
    // Bail if the field/text moved on while we waited.
    if (!activeEl || getText(activeEl) !== text || checkedText !== text) return;
    if (!resp || !resp.ok) {
      aiState = "error";
    } else {
      aiMatches = resp.issues || [];
      aiState = "done";
    }
    renderUnderlines();
    updateIcon();
    if (popup && popup.style.display === "block" && popup.dataset.mode === "issues") renderIssues();
  }

  function requestRewrite(text) {
    return browser.runtime.sendMessage({ type: "lt-rewrite", text });
  }

  async function onRephraseField() {
    if (!activeEl) return;
    const text = getText(activeEl);
    if (!text.trim()) return;
    const p = ensurePopup();
    p.dataset.mode = "rephrase";
    p.textContent = "";
    const status = document.createElement("div");
    status.className = "lt-pp-empty";
    status.textContent = "Rephrasing…";
    p.appendChild(status);
    p.style.display = "block";
    positionPopup();

    const resp = await requestRewrite(text);
    if (!resp || !resp.ok) {
      status.textContent = resp ? resp.error : "Rephrase failed.";
      return;
    }
    p.textContent = "";
    const items = resp.variants && resp.variants.length ? resp.variants : [{ text: resp.text }];
    for (const v of items) {
      const row = document.createElement("div");
      row.className = "lt-pp-row";
      if (v.label) {
        const lbl = document.createElement("div");
        lbl.className = "lt-pp-label";
        lbl.textContent = v.label;
        row.appendChild(lbl);
      }
      const tx = document.createElement("div");
      tx.className = "lt-pp-rewrite";
      tx.textContent = v.text;
      row.appendChild(tx);
      const b = document.createElement("button");
      b.className = "lt-chip lt-apply";
      b.textContent = v.label ? "Use this" : "Apply";
      b.addEventListener("click", () => {
        applyWhole(v.text);
        closePopup();
      });
      row.appendChild(b);
      p.appendChild(row);
    }
    positionPopup();
  }

  // ---- check flow ----------------------------------------------------------
  async function doCheck(el) {
    if (!el || el !== activeEl || disabledFields.has(el)) return;
    const text = getText(el);
    // A re-check triggered by our own suggestion-apply keeps the (already
    // shifted) AI suggestions; only a real user edit invalidates them.
    const fromSelfEdit = selfEdit !== null;
    selfEdit = null;
    if (text.trim().length < (cfg.minLength || 1)) {
      lastText = text;
      checkedText = text;
      currentMatches = [];
      resetAi();
      clearUnderlines();
      updateIcon();
      return;
    }
    if (text === lastText) return;
    lastText = text;
    const resp = await browser.runtime.sendMessage({ type: "lt-check", text });
    if (el !== activeEl || getText(el) !== text) return;
    if (!resp || !resp.ok) {
      currentMatches = [];
      resetAi();
      clearUnderlines();
      if (icon) {
        countEl.textContent = "!";
        icon.dataset.sev = "error";
      }
      return;
    }
    checkedText = text;
    currentMatches = resp.matches;
    if (!fromSelfEdit) resetAi(); // a typed edit invalidates the prior AI pass
    renderUnderlines();
    updateIcon();
    if (popup && popup.style.display === "block" && popup.dataset.mode === "issues") renderIssues();
  }
  function scheduleCheck() {
    clearTimeout(debounceTimer);
    const el = activeEl;
    debounceTimer = setTimeout(() => doCheck(el), cfg.debounceMs || 700);
  }

  // ---- events --------------------------------------------------------------
  document.addEventListener(
    "focusin",
    (e) => {
      if (!isEditable(e.target)) return;
      activeEl = e.target;
      lastText = null;
      checkedText = null;
      currentMatches = [];
      resetAi();
      clearUnderlines();
      showIcon();
      updateIcon();
      scheduleCheck();
    },
    true
  );
  document.addEventListener(
    "focusout",
    (e) => {
      if (e.target !== activeEl) return;
      activeEl = null;
      lastText = null;
      clearTimeout(debounceTimer);
      clearUnderlines();
      hideIcon();
      closePopup();
      hideChooser();
    },
    true
  );
  document.addEventListener(
    "input",
    (e) => {
      if (e.target !== activeEl) return;
      clearUnderlines(); // drop stale underlines while typing; they return after the check
      positionIcon(); // re-anchor as textareas / contenteditables auto-grow
      scheduleCheck();
    },
    true
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePopup();
  });
  window.addEventListener(
    "scroll",
    () => {
      positionIcon();
      positionPopup();
      positionOverlay(); // keep the form-field underline mirror aligned
      hideChooser();
    },
    true
  );
  window.addEventListener("resize", () => {
    positionIcon();
    positionPopup();
    positionOverlay();
  });

  // ---- selection rephrase (right-click menu) -------------------------------
  let lastPointer = null;
  let chooser = null;
  let toastEl = null;
  let toastTimer = null;

  function toast(msg, sticky) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "lt-inline-toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.display = "block";
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => toastEl && (toastEl.style.display = "none"), 2500);
  }

  function editableSelection() {
    const el = document.activeElement;
    if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT") && isEditable(el)) {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      if (start != null && start !== end) {
        return { kind: "input", el, start, end, text: el.value.slice(start, end) };
      }
    }
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const text = sel.toString();
      const anchor = sel.anchorNode;
      const host = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement);
      if (text.trim() && host && host.isContentEditable) {
        return { kind: "ce", host, range: sel.getRangeAt(0).cloneRange(), text };
      }
    }
    return null;
  }
  function applySelectionText(s, text) {
    if (s.kind === "input") {
      const v = s.el.value;
      s.el.value = v.slice(0, s.start) + text + v.slice(s.end);
      const caret = s.start + text.length;
      try {
        s.el.setSelectionRange(caret, caret);
      } catch (_) {}
      s.el.dispatchEvent(new Event("input", { bubbles: true }));
      s.el.focus();
    } else {
      s.range.deleteContents();
      s.range.insertNode(document.createTextNode(text));
      s.host.normalize();
      s.host.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
  }
  function renderVariantOptions(container, variants, onPick) {
    container.textContent = "";
    for (const v of variants) {
      const row = document.createElement("div");
      row.className = "lt-inline-variant";
      const label = document.createElement("div");
      label.className = "lt-inline-variant-label";
      label.textContent = v.label;
      row.appendChild(label);
      const txt = document.createElement("div");
      txt.className = "lt-inline-rewritten";
      txt.textContent = v.text;
      row.appendChild(txt);
      const btn = document.createElement("button");
      btn.className = "lt-chip lt-apply";
      btn.textContent = "Use this";
      btn.addEventListener("click", () => onPick(v.text));
      row.appendChild(btn);
      container.appendChild(row);
    }
  }
  function ensureChooser() {
    if (chooser) return chooser;
    chooser = document.createElement("div");
    chooser.className = "lt-inline-chooser";
    chooser.addEventListener("mousedown", (e) => e.preventDefault());
    document.body.appendChild(chooser);
    return chooser;
  }
  function hideChooser() {
    if (chooser) chooser.style.display = "none";
  }
  function showVariantChooser(variants, onPick, x, y) {
    const c = ensureChooser();
    renderVariantOptions(c, variants, (text) => {
      hideChooser();
      onPick(text);
    });
    c.style.display = "block";
    c.style.left = Math.min(Math.max(8, x), window.innerWidth - 348) + "px";
    c.style.top = Math.min(Math.max(8, y), window.innerHeight - 80) + "px";
  }
  async function doRephraseSelection(s) {
    if (!s) {
      toast("Select some text in an editable field first.");
      return;
    }
    toast("Rephrasing…", true);
    const resp = await requestRewrite(s.text);
    if (!resp || !resp.ok) {
      toast(resp ? resp.error : "Rephrase failed.");
      return;
    }
    if (resp.variants && resp.variants.length) {
      toast("Pick a style ↓");
      const x = lastPointer ? lastPointer.x : 120;
      const y = lastPointer ? lastPointer.y + 12 : 120;
      showVariantChooser(
        resp.variants,
        (text) => {
          applySelectionText(s, text);
          toast("Rephrased ✓");
        },
        x,
        y
      );
      return;
    }
    applySelectionText(s, resp.text);
    toast("Rephrased ✓");
  }

  // Track the cursor so the variant chooser can pop near the click.
  document.addEventListener(
    "mousemove",
    (e) => {
      lastPointer = { x: e.clientX, y: e.clientY };
    },
    true
  );
  document.addEventListener("keyup", (e) => {
    if (e.key === "Escape") hideChooser();
  });

  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "lt-rephrase-selection") {
      doRephraseSelection(editableSelection());
    }
  });
})();
