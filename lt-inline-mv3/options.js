const DEFAULTS = {
  endpoint: "https://languagetool.example.com/v2/check",
  language: "auto",
  preferredVariants: "en-US,de-DE",
  motherTongue: "",
  debounceMs: 700,
  minLength: 4,
  ignoredCategories: "",
  rewriteEndpoint: "https://languagetool.example.com/llm/v1/chat/completions",
  rewritePrompt:
    "You are a writing assistant. Rewrite the text so it is grammatically correct, clear, and natural, keeping the original meaning and the same language. Output only the rewritten text, with no explanations, quotes, or preamble.",
  rephraseVariants: false,
};

const fields = [
  "endpoint",
  "language",
  "preferredVariants",
  "motherTongue",
  "debounceMs",
  "minLength",
  "ignoredCategories",
  "rewriteEndpoint",
  "rewritePrompt",
  "rephraseVariants",
];

async function load() {
  const cfg = await browser.storage.local.get(DEFAULTS);
  for (const f of fields) {
    const el = document.getElementById(f);
    if (el.type === "checkbox") el.checked = !!cfg[f];
    else el.value = cfg[f];
  }
}

async function save() {
  const cfg = {
    endpoint: document.getElementById("endpoint").value.trim(),
    language: document.getElementById("language").value.trim() || "auto",
    preferredVariants: document.getElementById("preferredVariants").value.trim(),
    motherTongue: document.getElementById("motherTongue").value.trim(),
    debounceMs: parseInt(document.getElementById("debounceMs").value, 10) || 700,
    minLength: parseInt(document.getElementById("minLength").value, 10) || 1,
    ignoredCategories: document.getElementById("ignoredCategories").value.trim(),
    rewriteEndpoint: document.getElementById("rewriteEndpoint").value.trim(),
    rewritePrompt: document.getElementById("rewritePrompt").value.trim() || DEFAULTS.rewritePrompt,
    rephraseVariants: document.getElementById("rephraseVariants").checked,
  };
  await browser.storage.local.set(cfg);
  const status = document.getElementById("status");
  status.textContent = "Saved.";
  setTimeout(() => (status.textContent = ""), 1500);
}

function initTabs() {
  const tabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".panel");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      panels.forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
    });
  });
}

document.getElementById("save").addEventListener("click", save);
initTabs();
load();
