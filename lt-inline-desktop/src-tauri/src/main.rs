// SPDX-License-Identifier: AGPL-3.0-or-later
// LanguageTool Inline (desktop) — Copyright (C) 2026 Oratorian. See LICENSE.

// Prevent an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

// ---- Persisted configuration (edited via the Settings window) ------------
#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
struct Config {
    lt_endpoint: String,
    language: String,
    preferred_variants: String, // with language=auto: en-US vs en-GB, de-DE, … (comma-separated)
    mother_tongue: String,      // e.g. "de-DE" — enables false-friends warnings; blank = off
    ignored_categories: String,
    rewrite_endpoint: String,
    rewrite_prompt: String,
    rephrase_variants: bool, // plain Rephrase returns multiple styles when true
    ui_language: String, // "auto" | "en" | "de"
}

impl Default for Config {
    fn default() -> Self {
        Self {
            lt_endpoint: "https://languagetool.example.com/v2/check".into(),
            language: "auto".into(),
            preferred_variants: "en-US,de-DE".into(),
            mother_tongue: String::new(),
            ignored_categories: String::new(),
            rewrite_endpoint: "https://languagetool.example.com/llm/v1/chat/completions".into(),
            rewrite_prompt: "You are a writing assistant. Rewrite the text so it is grammatically correct, clear, and natural, keeping the original meaning and the same language. Output only the rewritten text, with no explanations, quotes, or preamble.".into(),
            rephrase_variants: false,
            ui_language: "auto".into(),
        }
    }
}

fn config_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&dir);
    dir.join("config.json")
}

fn load_config(app: &tauri::AppHandle) -> Config {
    std::fs::read_to_string(config_path(app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn get_config(app: tauri::AppHandle) -> Config {
    load_config(&app)
}

#[tauri::command]
fn set_config(app: tauri::AppHandle, config: Config) -> Result<(), String> {
    let s = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(config_path(&app), s).map_err(|e| e.to_string())
}

// ---- Window position + panel size (its own file, so settings & window
// state can't clobber each other). x/y = collapsed button pos; w/h = expanded
// panel size. Each writer preserves the other's fields. -----------------------
#[derive(Serialize, Deserialize, Clone, Copy, Default)]
struct WinState {
    x: Option<i32>,
    y: Option<i32>,
    w: Option<i32>,
    h: Option<i32>,
    tour_seen: Option<bool>,
}

fn pos_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&dir);
    dir.join("position.json")
}

fn load_win_state(app: &tauri::AppHandle) -> WinState {
    std::fs::read_to_string(pos_path(app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_win_state(app: &tauri::AppHandle, st: &WinState) -> Result<(), String> {
    let s = serde_json::to_string(st).map_err(|e| e.to_string())?;
    std::fs::write(pos_path(app), s).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_position(app: tauri::AppHandle, x: i32, y: i32) -> Result<(), String> {
    let mut st = load_win_state(&app);
    st.x = Some(x);
    st.y = Some(y);
    write_win_state(&app, &st)
}

#[tauri::command]
fn save_size(app: tauri::AppHandle, w: i32, h: i32) -> Result<(), String> {
    let mut st = load_win_state(&app);
    st.w = Some(w);
    st.h = Some(h);
    write_win_state(&app, &st)
}

#[tauri::command]
fn load_position(app: tauri::AppHandle) -> WinState {
    load_win_state(&app)
}

#[tauri::command]
fn set_tour_seen(app: tauri::AppHandle) -> Result<(), String> {
    let mut st = load_win_state(&app);
    st.tour_seen = Some(true);
    write_win_state(&app, &st)
}

#[derive(Serialize)]
struct Variant {
    label: String,
    text: String,
}

// Strip Qwen reasoning blocks and wrapping quotes the model sometimes adds.
fn clean(s: &str) -> String {
    let mut t = s.to_string();
    loop {
        if let (Some(a), Some(b)) = (t.find("<think>"), t.find("</think>")) {
            if a < b {
                t.replace_range(a..b + "</think>".len(), "");
                continue;
            }
        }
        break;
    }
    t.trim()
        .trim_matches(|c| c == '"' || c == '\'' || c == '\u{201c}' || c == '\u{201d}')
        .trim()
        .to_string()
}

// Simulate Ctrl+<key> against whatever window currently has focus. Because our
// own window is non-activating (see set_noactivate), focus never leaves the
// target app, so this lands in the right place.
fn send_ctrl(key: char) {
    use enigo::{
        Direction::{Click, Press, Release},
        Enigo, Key, Keyboard, Settings,
    };
    if let Ok(mut e) = Enigo::new(&Settings::default()) {
        let _ = e.key(Key::Control, Press);
        let _ = e.key(Key::Unicode(key), Click);
        let _ = e.key(Key::Control, Release);
    }
}

#[tauri::command]
fn capture_selection() -> Result<String, String> {
    // Preserve the user's clipboard; we restore it before returning.
    let original = {
        let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        cb.get_text().unwrap_or_default()
    };

    // 1) Try the current selection: clear clipboard, then Ctrl+C.
    {
        let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        let _ = cb.clear();
    }
    send_ctrl('c');
    std::thread::sleep(std::time::Duration::from_millis(140));
    let mut text = {
        let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        cb.get_text().unwrap_or_default()
    };

    // 2) Nothing was selected → select the whole field (Ctrl+A) and copy it.
    if text.trim().is_empty() {
        send_ctrl('a');
        std::thread::sleep(std::time::Duration::from_millis(60));
        send_ctrl('c');
        std::thread::sleep(std::time::Duration::from_millis(140));
        let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        text = cb.get_text().unwrap_or_default();
    }

    // Restore the user's original clipboard (apply_text sets the result later).
    {
        let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        let _ = cb.set_text(original);
    }

    Ok(text)
}

#[tauri::command]
fn apply_text(text: String) -> Result<(), String> {
    {
        let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        cb.set_text(text).map_err(|e| e.to_string())?;
    }
    std::thread::sleep(std::time::Duration::from_millis(60));
    send_ctrl('v');
    Ok(())
}

#[tauri::command]
async fn fix_grammar(app: tauri::AppHandle, text: String) -> Result<String, String> {
    let cfg = load_config(&app);
    let ignored: std::collections::HashSet<String> = cfg
        .ignored_categories
        .split(',')
        .map(|s| s.trim().to_uppercase())
        .filter(|s| !s.is_empty())
        .collect();

    let mut params: Vec<(&str, &str)> = vec![
        ("text", text.as_str()),
        ("language", cfg.language.as_str()),
    ];
    // preferredVariants is ONLY valid with language=auto — sending it alongside
    // an explicit language (e.g. de-DE) makes LanguageTool return HTTP 400.
    if cfg.language == "auto" && !cfg.preferred_variants.is_empty() {
        params.push(("preferredVariants", cfg.preferred_variants.as_str()));
    }
    // motherTongue enables false-friends detection; valid with any language.
    if !cfg.mother_tongue.is_empty() {
        params.push(("motherTongue", cfg.mother_tongue.as_str()));
    }

    let client = reqwest::Client::new();
    let res = client
        .post(&cfg.lt_endpoint)
        .form(&params)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;

    // (offset, length, replacement). NOTE: LanguageTool offsets are UTF-16 code
    // units (Java string indices), so we splice on a UTF-16 buffer.
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    if let Some(arr) = json["matches"].as_array() {
        for m in arr {
            let cat = m["rule"]["category"]["id"].as_str().unwrap_or("").to_uppercase();
            if ignored.contains(&cat) {
                continue;
            }
            let offset = m["offset"].as_u64().unwrap_or(0) as usize;
            let len = m["length"].as_u64().unwrap_or(0) as usize;
            if let Some(rep) = m["replacements"]
                .as_array()
                .and_then(|r| r.first())
                .and_then(|r| r["value"].as_str())
            {
                edits.push((offset, len, rep.to_string()));
            }
        }
    }
    edits.sort_by(|a, b| b.0.cmp(&a.0)); // right-to-left keeps earlier offsets valid

    let mut units: Vec<u16> = text.encode_utf16().collect();
    for (offset, len, rep) in edits {
        if offset.saturating_add(len) <= units.len() {
            let r: Vec<u16> = rep.encode_utf16().collect();
            units.splice(offset..offset + len, r);
        }
    }
    Ok(String::from_utf16_lossy(&units))
}

#[derive(Serialize)]
struct GMatch {
    offset: usize,
    length: usize,
    message: String,
    word: String,
    replacements: Vec<String>,
}

// Return LanguageTool's flagged spans + suggestions for the interactive picker
// (offsets are UTF-16 code units, which line up with JS string indices).
#[tauri::command]
async fn check_grammar(app: tauri::AppHandle, text: String) -> Result<Vec<GMatch>, String> {
    let cfg = load_config(&app);
    let ignored: std::collections::HashSet<String> = cfg
        .ignored_categories
        .split(',')
        .map(|s| s.trim().to_uppercase())
        .filter(|s| !s.is_empty())
        .collect();

    let mut params: Vec<(&str, &str)> = vec![
        ("text", text.as_str()),
        ("language", cfg.language.as_str()),
    ];
    // preferredVariants only with language=auto (LT 400s otherwise).
    if cfg.language == "auto" && !cfg.preferred_variants.is_empty() {
        params.push(("preferredVariants", cfg.preferred_variants.as_str()));
    }
    // motherTongue enables false-friends detection; valid with any language.
    if !cfg.mother_tongue.is_empty() {
        params.push(("motherTongue", cfg.mother_tongue.as_str()));
    }

    let client = reqwest::Client::new();
    let res = client
        .post(&cfg.lt_endpoint)
        .form(&params)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;

    let units: Vec<u16> = text.encode_utf16().collect();
    let mut out = Vec::new();
    if let Some(arr) = json["matches"].as_array() {
        for m in arr {
            let cat = m["rule"]["category"]["id"].as_str().unwrap_or("").to_uppercase();
            if ignored.contains(&cat) {
                continue;
            }
            let offset = m["offset"].as_u64().unwrap_or(0) as usize;
            let length = m["length"].as_u64().unwrap_or(0) as usize;
            let word = if offset + length <= units.len() {
                String::from_utf16_lossy(&units[offset..offset + length])
            } else {
                String::new()
            };
            let replacements: Vec<String> = m["replacements"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|r| r["value"].as_str().map(|s| s.to_string()))
                        .take(6)
                        .collect()
                })
                .unwrap_or_default();
            let message = m["shortMessage"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or_else(|| m["message"].as_str())
                .unwrap_or("")
                .to_string();
            out.push(GMatch { offset, length, message, word, replacements });
        }
    }
    Ok(out)
}

async fn call_llm(endpoint: &str, body: serde_json::Value) -> Result<String, String> {
    let client = reqwest::Client::new();
    let res = client
        .post(endpoint)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("rewrite server HTTP {}", res.status()));
    }
    let json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string())
}

#[tauri::command]
async fn rephrase(app: tauri::AppHandle, text: String) -> Result<String, String> {
    let cfg = load_config(&app);
    let body = serde_json::json!({
        "messages": [
            { "role": "system", "content": cfg.rewrite_prompt },
            { "role": "user", "content": text }
        ],
        "temperature": 0.2, "top_p": 0.9, "top_k": 20, "min_p": 0,
        "max_tokens": 256, "stream": false
    });
    let raw = call_llm(&cfg.rewrite_endpoint, body).await?;
    Ok(clean(&raw))
}

// Parse the delimiter-separated variants format (mirrors the extension's
// parseVariants): [label]\n<text> blocks split on a "===VARIANT===" line. Plain
// text, so a small model can't malform it the way it does a big JSON string.
fn parse_variants(raw: &str) -> Vec<Variant> {
    let t = clean_no_quotes(raw);
    let t = t
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let mut out = Vec::new();
    for block in split_on_variant_marker(t) {
        let b = block.trim();
        if b.is_empty() {
            continue;
        }
        let (label, body) = if b.starts_with('[') {
            if let Some(close) = b.find(']') {
                (b[1..close].trim().to_string(), b[close + 1..].to_string())
            } else {
                ("Option".to_string(), b.to_string())
            }
        } else {
            ("Option".to_string(), b.to_string())
        };
        let text = clean(&body);
        if !text.is_empty() {
            let label = if label.is_empty() { "Option".into() } else { label };
            out.push(Variant { label, text });
        }
    }
    out
}

// Split on lines that are essentially "===VARIANT===" (>=2 '=', case-insensitive).
fn split_on_variant_marker(t: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut current = String::new();
    for line in t.lines() {
        let l = line.trim();
        let stripped: String = l.chars().filter(|c| *c != '=' && *c != ' ').collect();
        let eqs = l.chars().filter(|c| *c == '=').count();
        if eqs >= 2 && stripped.eq_ignore_ascii_case("variant") {
            blocks.push(std::mem::take(&mut current));
        } else {
            current.push_str(line);
            current.push('\n');
        }
    }
    blocks.push(current);
    blocks
}

#[tauri::command]
async fn rephrase_variants(app: tauri::AppHandle, text: String) -> Result<Vec<Variant>, String> {
    let cfg = load_config(&app);
    let system = format!(
        "{}\n\nProvide several alternatives in distinct writing styles. If no specific styles are requested above, use exactly these three: casual, professional, and concise. Write every rewrite in the SAME LANGUAGE as the input (e.g. German input -> German rewrites), and write each style label in that same language too.\n\nFormat your answer EXACTLY like this, with each alternative separated by a line containing only ===VARIANT===, and each alternative starting with its style label in square brackets on its own line:\n[casual]\nthe casual rewrite here\n===VARIANT===\n[professional]\nthe professional rewrite here\n===VARIANT===\n[concise]\nthe concise rewrite here\n\nOutput nothing else.",
        cfg.rewrite_prompt
    );
    let body = serde_json::json!({
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": text }
        ],
        "temperature": 0.2, "top_p": 0.9, "top_k": 20, "min_p": 0,
        "max_tokens": 2048, "stream": false
    });
    let raw = call_llm(&cfg.rewrite_endpoint, body).await?;
    Ok(parse_variants(&raw))
}

// ---- AI proofread (LLM second pass) --------------------------------------
// Mirrors the browser extension: the model returns the WHOLE corrected text as
// plain text, then a ===CHANGES=== marker, then a short JSON reasons list. We
// compute edit locations ourselves by diffing original vs corrected, so offsets
// are minimal/exact and the model can't over-reach. Offsets are UTF-16 code
// units to match the frontend (same convention as check_grammar).
const AI_PROOFREAD_PROMPT: &str = "You are a meticulous proofreader. The text was already spell- and grammar-checked by a basic tool. Correct ONLY real remaining errors it likely missed: confused words (their/there/they're, your/you're, its/it's, then/than, to/too), wrong word choice, and missing or misplaced punctuation. Do NOT rephrase, reword, restructure, or change writing style; change as few words as possible and leave everything else exactly as it was. Use only plain ASCII punctuation (straight quotes, regular hyphens).\n\nOutput the full corrected text first, as plain text exactly as it should read, with no quotes, no markdown, and no numbering or labels. Then output a line containing only the marker ===CHANGES=== and, after it, a JSON array of the changes you made: [{\"from\":\"<wrong word>\",\"to\":\"<fix>\",\"reason\":\"<short reason, max 8 words>\"}]. If you changed nothing, output the unchanged text, the marker, and [].";

#[derive(Serialize)]
struct AiIssue {
    offset: usize,
    length: usize,
    original: String,
    suggestion: String,
    reason: String,
}

struct AiChange {
    from: String,
    reason: String,
}

// Split the model output into the corrected text and the reasons list.
fn parse_ai_response(raw: &str) -> (String, Vec<AiChange>) {
    let t = clean_no_quotes(raw);
    // Find the ===CHANGES=== marker (>=2 '=', case-insensitive, on its own-ish).
    let lower = t.to_lowercase();
    let marker = lower.find("==changes==").or_else(|| lower.find("===changes==="));
    let (corrected, rest) = match marker {
        Some(_) => {
            // Locate the actual marker span tolerant of '=' count.
            if let Some(idx) = find_changes_marker(&t) {
                let (a, b) = idx;
                (t[..a].trim().to_string(), t[b..].trim().to_string())
            } else {
                (t.clone(), String::new())
            }
        }
        None => (t.clone(), String::new()),
    };
    let corrected = strip_wrap(&corrected);

    let mut changes = Vec::new();
    if !rest.is_empty() {
        let json_str = rest
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();
        if let Ok(serde_json::Value::Array(arr)) = serde_json::from_str::<serde_json::Value>(json_str) {
            for c in arr {
                let from = c["from"].as_str().unwrap_or("").trim().to_string();
                let reason = c["reason"].as_str().unwrap_or("").trim().to_string();
                if !from.is_empty() {
                    changes.push(AiChange { from, reason });
                }
            }
        }
    }
    (corrected, changes)
}

// Locate the ===CHANGES=== marker, returning (start, end) byte offsets of the
// marker line so the text before/after can be split out.
fn find_changes_marker(t: &str) -> Option<(usize, usize)> {
    let bytes = t.as_bytes();
    let needle_lower = "changes";
    let lower = t.to_lowercase();
    let mut search_from = 0;
    while let Some(rel) = lower[search_from..].find(needle_lower) {
        let pos = search_from + rel;
        // Walk back over '=' and whitespace to the marker start.
        let mut start = pos;
        while start > 0 && (bytes[start - 1] == b'=' || bytes[start - 1] == b' ') {
            start -= 1;
        }
        // Walk forward over the rest: "changes" then trailing '='.
        let mut end = pos + needle_lower.len();
        while end < bytes.len() && (bytes[end] == b'=' || bytes[end] == b' ') {
            end += 1;
        }
        // Require at least a couple of '=' on at least one side to count as marker.
        let eqs = t[start..end].chars().filter(|&c| c == '=').count();
        if eqs >= 2 {
            return Some((start, end));
        }
        search_from = pos + needle_lower.len();
    }
    None
}

fn clean_no_quotes(s: &str) -> String {
    // Strip <think> blocks (reuse clean's logic) but keep surrounding quotes for now.
    let mut t = s.to_string();
    loop {
        if let (Some(a), Some(b)) = (t.find("<think>"), t.find("</think>")) {
            if a < b {
                t.replace_range(a..b + "</think>".len(), "");
                continue;
            }
        }
        break;
    }
    t.trim().to_string()
}

fn strip_wrap(s: &str) -> String {
    s.trim()
        .trim_matches(|c| c == '"' || c == '\'' || c == '`' || c == '\u{201c}' || c == '\u{201d}')
        .trim()
        .to_string()
}

// A diff token: a run of whitespace or a run of non-whitespace, with its start
// offset measured in UTF-16 code units within the source.
struct Tok {
    text: Vec<u16>,
    off: usize,
}

fn tokenize_u16(units: &[u16]) -> Vec<Tok> {
    let mut toks = Vec::new();
    let is_ws = |u: u16| u == 0x20 || u == 0x09 || u == 0x0a || u == 0x0d;
    let mut i = 0;
    while i < units.len() {
        let start = i;
        let ws = is_ws(units[i]);
        while i < units.len() && is_ws(units[i]) == ws {
            i += 1;
        }
        toks.push(Tok { text: units[start..i].to_vec(), off: start });
    }
    toks
}

// Word-level LCS diff over UTF-16 units -> minimal change hunks with offsets in
// the ORIGINAL (in UTF-16 units). Anchors insertion-only hunks and coalesces
// hunks separated only by whitespace, so "allot" -> "a lot" is one change and
// applying all hunks reproduces the corrected text exactly.
// (unused_assignments: the flush! macro resets d_start/ins which are dead only
// on the final call — the loop re-reads them on every prior iteration.)
#[allow(unused_assignments)]
fn diff_to_hunks(orig: &[u16], corr: &[u16]) -> Vec<(usize, usize, String)> {
    let a = tokenize_u16(orig);
    let b = tokenize_u16(corr);
    let n = a.len();
    let k = b.len();
    // LCS length table.
    let mut dp = vec![vec![0u32; k + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..k).rev() {
            dp[i][j] = if a[i].text == b[j].text {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }
    // Walk the table, accumulating delete spans + inserted text.
    let mut hunks: Vec<(usize, usize, Vec<u16>)> = Vec::new(); // (start, end, insert)
    let mut i = 0;
    let mut j = 0;
    let mut pos = 0usize; // offset just past the last consumed A token
    let mut d_start: Option<usize> = None;
    let mut d_end: usize = 0;
    let mut ins: Vec<u16> = Vec::new();
    macro_rules! flush {
        () => {
            if d_start.is_some() || !ins.is_empty() {
                let start = d_start.unwrap_or(pos);
                let end = if d_start.is_some() { d_end } else { start };
                hunks.push((start, end, ins.clone()));
            }
            d_start = None;
            ins.clear();
        };
    }
    while i < n && j < k {
        if a[i].text == b[j].text {
            flush!();
            pos = a[i].off + a[i].text.len();
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            if d_start.is_none() {
                d_start = Some(a[i].off);
            }
            d_end = a[i].off + a[i].text.len();
            pos = d_end;
            i += 1;
        } else {
            ins.extend_from_slice(&b[j].text);
            j += 1;
        }
    }
    while i < n {
        if d_start.is_none() {
            d_start = Some(a[i].off);
        }
        d_end = a[i].off + a[i].text.len();
        pos = d_end;
        i += 1;
    }
    while j < k {
        ins.extend_from_slice(&b[j].text);
        j += 1;
    }
    flush!();

    // Map to (offset, length, suggestion-string), drop no-ops.
    let raw: Vec<(usize, usize, String)> = hunks
        .into_iter()
        .map(|(s, e, ins)| (s, e.saturating_sub(s), String::from_utf16_lossy(&ins)))
        .filter(|(s, len, sug)| {
            let orig_slice = String::from_utf16_lossy(&orig[*s..*s + *len]);
            orig_slice != *sug
        })
        .collect();

    // Coalesce hunks separated only by whitespace in the original.
    let mut merged: Vec<(usize, usize, String)> = Vec::new();
    for (s, len, sug) in raw {
        if let Some(last) = merged.last_mut() {
            let gap_start = last.0 + last.1;
            let gap: String = String::from_utf16_lossy(&orig[gap_start..s]);
            if gap.trim().is_empty() {
                last.1 = s + len - last.0;
                last.2 = format!("{}{}{}", last.2, gap, sug);
                continue;
            }
        }
        merged.push((s, len, sug));
    }
    merged
        .into_iter()
        .filter(|(s, len, sug)| String::from_utf16_lossy(&orig[*s..*s + *len]) != *sug)
        .collect()
}

fn categorize(from: &str, to: &str) -> &'static str {
    let f = from.to_lowercase();
    let t = to.to_lowercase();
    const CONFUSIONS: &[&str] = &[
        "their", "there", "they're", "your", "you're", "its", "it's", "then", "than", "to", "too",
        "lose", "loose", "affect", "effect", "accept", "except", "whether", "weather",
    ];
    if CONFUSIONS.contains(&f.as_str()) || CONFUSIONS.contains(&t.as_str()) {
        return "confused word";
    }
    if !from.chars().any(|c| c.is_alphabetic()) || !to.chars().any(|c| c.is_alphabetic()) {
        return "punctuation";
    }
    "word choice"
}

#[tauri::command]
async fn ai_proofread(app: tauri::AppHandle, text: String) -> Result<Vec<AiIssue>, String> {
    let cfg = load_config(&app);
    if cfg.rewrite_endpoint.is_empty() {
        return Err("No LLM endpoint configured.".into());
    }
    let body = serde_json::json!({
        "messages": [
            { "role": "system", "content": AI_PROOFREAD_PROMPT },
            { "role": "user", "content": text }
        ],
        "temperature": 0.1, "top_p": 0.9, "top_k": 20, "min_p": 0,
        "max_tokens": 8000, "stream": false
    });
    let raw = call_llm(&cfg.rewrite_endpoint, body).await?;
    let (corrected, changes) = parse_ai_response(&raw);
    if corrected.is_empty() {
        return Ok(Vec::new());
    }

    let orig: Vec<u16> = text.encode_utf16().collect();
    let corr: Vec<u16> = corrected.encode_utf16().collect();
    let hunks = diff_to_hunks(&orig, &corr);

    let mut out = Vec::new();
    for (offset, length, suggestion) in hunks {
        let original = String::from_utf16_lossy(&orig[offset..offset + length]);
        let from_t = original.trim().to_lowercase();
        let to_t = suggestion.trim();
        // Pair with the model's reason by matching the changed word(s).
        let reason = changes
            .iter()
            .find(|c| {
                let cf = c.from.to_lowercase();
                !cf.is_empty() && (cf == from_t || from_t.contains(&cf))
            })
            .map(|c| c.reason.clone())
            .filter(|r| !r.is_empty())
            .unwrap_or_else(|| format!("{}: {} -> {}", categorize(original.trim(), to_t), original.trim(), to_t));
        out.push(AiIssue { offset, length, original, suggestion, reason });
    }
    Ok(out)
}

// Our own right-click menu (the default WebView2 menu is suppressed in JS).
#[tauri::command]
fn show_menu(window: tauri::WebviewWindow, locale: String) -> Result<(), String> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    let app = window.app_handle();
    let de = locale == "de";
    let l_fix = if de { "✓  Grammatik korrigieren" } else { "✓  Fix grammar" };
    let l_proof = if de { "✦  KI-Korrektur" } else { "✦  AI proofread" };
    let l_rep = if de { "✨  Umformulieren" } else { "✨  Rephrase" };
    let l_var = if de { "🎛  Umformulieren — Stile" } else { "🎛  Rephrase — styles" };
    let l_set = if de { "⚙  Einstellungen" } else { "⚙  Settings" };
    let l_tour = if de { "❔  Einführung" } else { "❔  Tour" };
    let l_quit = if de { "Beenden" } else { "Quit" };

    let fix = MenuItem::with_id(app, "fix", l_fix, true, None::<&str>).map_err(|e| e.to_string())?;
    let proof = MenuItem::with_id(app, "proofread", l_proof, true, None::<&str>).map_err(|e| e.to_string())?;
    let rep = MenuItem::with_id(app, "rephrase", l_rep, true, None::<&str>).map_err(|e| e.to_string())?;
    let var = MenuItem::with_id(app, "variants", l_var, true, None::<&str>).map_err(|e| e.to_string())?;
    let sep = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let settings = MenuItem::with_id(app, "settings", l_set, true, None::<&str>).map_err(|e| e.to_string())?;
    let tour = MenuItem::with_id(app, "tour", l_tour, true, None::<&str>).map_err(|e| e.to_string())?;
    let sep2 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, "quit", l_quit, true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&fix, &proof, &rep, &var, &sep, &settings, &tour, &sep2, &quit])
        .map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())?;
    Ok(())
}

// Make the window non-activating (+ tool window) so clicking it never steals
// focus from the app you're editing. This is the bit most likely to need a
// version tweak if `windows`/Tauri's HWND types drift.
#[cfg(windows)]
fn set_noactivate(win: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_BORDER_COLOR};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };
    if let Ok(h) = win.hwnd() {
        let hwnd = HWND(h.0 as *mut core::ffi::c_void);
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(
                hwnd,
                GWL_EXSTYLE,
                ex | (WS_EX_NOACTIVATE.0 as isize) | (WS_EX_TOOLWINDOW.0 as isize),
            );
            // Remove the Windows 11 1px window border (DWMWA_COLOR_NONE).
            let none: u32 = 0xFFFF_FFFE;
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_BORDER_COLOR,
                &none as *const u32 as *const core::ffi::c_void,
                core::mem::size_of::<u32>() as u32,
            );
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.emit("trigger", ());
                        }
                    }
                })
                .build(),
        )
        .on_menu_event(|app, event| match event.id().0.as_str() {
            "quit" => app.exit(0),
            "settings" => {
                if let Some(w) = app.get_webview_window("settings") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "tour" => {
                if let Some(w) = app.get_webview_window("tour") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            other => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.emit("menu-action", other.to_string());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            capture_selection,
            apply_text,
            fix_grammar,
            check_grammar,
            rephrase,
            rephrase_variants,
            ai_proofread,
            show_menu,
            get_config,
            set_config,
            save_position,
            save_size,
            load_position,
            set_tour_seen
        ])
        .setup(|app| {
            #[cfg(windows)]
            if let Some(win) = app.get_webview_window("main") {
                set_noactivate(&win);
            }
            // Hide Settings/Tour on close instead of destroying them, so they
            // can be reopened from the menu any number of times.
            for label in ["settings", "tour"] {
                if let Some(w) = app.get_webview_window(label) {
                    let wc = w.clone();
                    w.on_window_event(move |event| {
                        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                            api.prevent_close();
                            let _ = wc.hide();
                        }
                    });
                }
            }
            // First run: show the welcome tour.
            if load_win_state(app.handle()).tour_seen != Some(true) {
                if let Some(w) = app.get_webview_window("tour") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            // Global hotkey: Ctrl+Alt+R
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyR);
            app.global_shortcut().register(shortcut)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    // Apply hunks (offset/length in UTF-16 units, suggestion string) to the
    // original and confirm it reproduces the corrected text exactly.
    fn apply_all(orig: &str, hunks: &[(usize, usize, String)]) -> String {
        let mut units: Vec<u16> = orig.encode_utf16().collect();
        // Apply right-to-left so earlier offsets stay valid.
        let mut sorted: Vec<&(usize, usize, String)> = hunks.iter().collect();
        sorted.sort_by(|a, b| b.0.cmp(&a.0));
        for (off, len, sug) in sorted {
            let rep: Vec<u16> = sug.encode_utf16().collect();
            units.splice(*off..*off + *len, rep);
        }
        String::from_utf16_lossy(&units)
    }

    #[test]
    fn diff_reproduces_corrected() {
        let orig = "honestly its been a long week and there going to loose it.";
        let corr = "honestly it's been a long week and they're going to lose it.";
        let o: Vec<u16> = orig.encode_utf16().collect();
        let c: Vec<u16> = corr.encode_utf16().collect();
        let hunks = diff_to_hunks(&o, &c);
        assert!(!hunks.is_empty(), "should find changes");
        assert_eq!(apply_all(orig, &hunks), corr, "apply-all must reproduce corrected");
        // Every hunk should be a small span (no clause-grabbing).
        for (_, len, _) in &hunks {
            assert!(*len <= 12, "hunk length {} too large", len);
        }
    }

    #[test]
    fn diff_coalesces_one_to_many() {
        // "allot" -> "a lot": one original token becomes two; must be one hunk.
        let orig = "needs allot more detail";
        let corr = "needs a lot more detail";
        let o: Vec<u16> = orig.encode_utf16().collect();
        let c: Vec<u16> = corr.encode_utf16().collect();
        let hunks = diff_to_hunks(&o, &c);
        assert_eq!(hunks.len(), 1, "should coalesce into a single change");
        assert_eq!(hunks[0].2.trim(), "a lot");
        assert_eq!(apply_all(orig, &hunks), corr);
    }

    #[test]
    fn diff_handles_utf16_offsets() {
        // Non-ASCII before the change: offsets must be UTF-16 units, not bytes.
        let orig = "Schoko schmeckt gut, aber its teuer.";
        let corr = "Schoko schmeckt gut, aber it's teuer.";
        let o: Vec<u16> = orig.encode_utf16().collect();
        let c: Vec<u16> = corr.encode_utf16().collect();
        let hunks = diff_to_hunks(&o, &c);
        assert_eq!(apply_all(orig, &hunks), corr);
    }

    #[test]
    fn parse_ai_splits_corrected_and_reasons() {
        let raw = "This is their last chance.\n===CHANGES===\n[{\"from\":\"there\",\"to\":\"their\",\"reason\":\"possessive\"}]";
        let (corrected, changes) = parse_ai_response(raw);
        assert_eq!(corrected, "This is their last chance.");
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].from, "there");
        assert_eq!(changes[0].reason, "possessive");
    }

    #[test]
    fn parse_ai_no_marker_is_all_corrected() {
        let (corrected, changes) = parse_ai_response("Just the corrected text.");
        assert_eq!(corrected, "Just the corrected text.");
        assert!(changes.is_empty());
    }

    #[test]
    fn parse_variants_splits_blocks() {
        let raw = "[casual]\nHey, got time tomorrow?\n===VARIANT===\n[professional]\nAre you available tomorrow?\n===VARIANT===\n[concise]\nFree tomorrow?";
        let v = parse_variants(raw);
        assert_eq!(v.len(), 3);
        assert_eq!(v[0].label, "casual");
        assert_eq!(v[0].text, "Hey, got time tomorrow?");
        assert_eq!(v[2].label, "concise");
        assert_eq!(v[2].text, "Free tomorrow?");
    }
}
