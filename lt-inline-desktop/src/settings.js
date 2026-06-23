const { invoke } = window.__TAURI__.core;

// Text/select fields (string values) and boolean checkbox fields, handled
// separately because checkboxes use .checked rather than .value.
const fields = [
  "ui_language",
  "lt_endpoint",
  "language",
  "preferred_variants",
  "mother_tongue",
  "ignored_categories",
  "rewrite_endpoint",
  "rewrite_prompt",
];
const boolFields = ["rephrase_variants"];
const status = document.getElementById("status");

function applyUiLang(val) {
  setLocale(resolveLocale(val));
  applyTranslations(document);
}

async function load() {
  const cfg = await invoke("get_config");
  for (const f of fields) {
    const el = document.getElementById(f);
    if (el) el.value = cfg[f] ?? "";
  }
  for (const f of boolFields) {
    const el = document.getElementById(f);
    if (el) el.checked = !!cfg[f];
  }
  applyUiLang(cfg.ui_language);
}

async function save() {
  const config = {};
  for (const f of fields) config[f] = document.getElementById(f).value.trim();
  for (const f of boolFields) config[f] = document.getElementById(f).checked;
  if (!config.language) config.language = "auto";
  if (!config.ui_language) config.ui_language = "auto";
  try {
    await invoke("set_config", { config });
    status.textContent = t("settings.saved");
    setTimeout(() => (status.textContent = ""), 1500);
  } catch (e) {
    status.textContent = "Error: " + e;
  }
}

function initTabs() {
  const tabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".panel");
  tabs.forEach((tb) => {
    tb.addEventListener("click", () => {
      tabs.forEach((x) => x.classList.remove("active"));
      panels.forEach((p) => p.classList.remove("active"));
      tb.classList.add("active");
      document.getElementById("tab-" + tb.dataset.tab).classList.add("active");
    });
  });
}

document.getElementById("save").addEventListener("click", save);
// Live-preview the interface language as you change the dropdown.
document.getElementById("ui_language").addEventListener("change", (e) => applyUiLang(e.target.value));
initTabs();
load();
