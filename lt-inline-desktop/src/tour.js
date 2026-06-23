const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const win = getCurrentWindow();

const STEPS = [
  { icon: "✨", t: "tour.s1.title", b: "tour.s1.body" },
  { icon: "✓", t: "tour.s2.title", b: "tour.s2.body" },
  { icon: "🖱️", t: "tour.s3.title", b: "tour.s3.body" },
  { icon: "✅", t: "tour.s4.title", b: "tour.s4.body" },
  { icon: "🪄", t: "tour.s5.title", b: "tour.s5.body" },
  { icon: "⚙️", t: "tour.s6.title", b: "tour.s6.body" },
];

let i = 0;

function render() {
  const s = STEPS[i];
  document.getElementById("icon").textContent = s.icon;
  document.getElementById("title").textContent = t(s.t);
  document.getElementById("body").textContent = t(s.b);

  const dots = document.getElementById("dots");
  dots.innerHTML = "";
  STEPS.forEach((_, idx) => {
    const d = document.createElement("span");
    d.className = "dot" + (idx === i ? " active" : "");
    dots.appendChild(d);
  });

  const last = i === STEPS.length - 1;
  const back = document.getElementById("back");
  const skip = document.getElementById("skip");
  back.textContent = t("tour.back");
  back.style.visibility = i === 0 ? "hidden" : "visible";
  skip.textContent = t("tour.skip");
  skip.style.visibility = last ? "hidden" : "visible";
  document.getElementById("next").textContent = last ? t("tour.done") : t("tour.next");
}

function closeTour() {
  win.hide();
}

document.getElementById("next").addEventListener("click", () => {
  if (i < STEPS.length - 1) {
    i++;
    render();
  } else {
    closeTour();
  }
});
document.getElementById("back").addEventListener("click", () => {
  if (i > 0) {
    i--;
    render();
  }
});
document.getElementById("skip").addEventListener("click", closeTour);

(async () => {
  let lang = "auto";
  try {
    const cfg = await invoke("get_config");
    lang = cfg.ui_language || "auto";
  } catch (_) {}
  setLocale(resolveLocale(lang));
  // Shown once = seen, so it won't auto-open again (re-openable from the menu).
  invoke("set_tour_seen").catch(() => {});
  i = 0;
  render();
})();
