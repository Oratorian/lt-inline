// Shared translations (loaded before main.js / settings.js). Plain globals,
// no bundler. English is the fallback for any missing key/locale.
const I18N = {
  en: {
    "panel.fix": "✓  Fix grammar",
    "panel.rephrase": "✨  Rephrase",
    "panel.variants": "🎛  Rephrase — styles",
    "panel.apply": "Apply (paste)",
    "panel.useThis": "Use this",
    "panel.proofread": "✦  AI proofread",
    "panel.reading": "Reading selection…",
    "panel.selectFirst": "Select some text first, then trigger again.",
    "panel.working": "Working…",
    "panel.aiWorking": "AI proofreading…",
    "panel.aiNothing": "AI found nothing extra ✓",
    "panel.aiConfusion": "Possible word confusion",
    "panel.aiNote": "AI can make mistakes — review each suggestion before applying.",
    "panel.noVariants": "No variants returned.",
    "panel.noIssues": "No issues found.",
    "panel.fixAll": "Apply all (best)",
    "panel.nothing": "Nothing captured.",
    "panel.error": "Error: ",

    "settings.subtitle": "Desktop — local grammar & AI rephrasing",
    "settings.tab.grammar": "Grammar",
    "settings.tab.rephrase": "Rephrase",
    "settings.uiLanguage": "Interface language",
    "settings.uiLanguage.hint": "Language of this app's interface.",
    "settings.uiLanguage.auto": "Automatic (system)",
    "settings.ltEndpoint": "LanguageTool endpoint",
    "settings.ltEndpoint.hint": "Full URL of the /v2/check endpoint.",
    "settings.language": "Language",
    "settings.language.hint": "auto, or a code like en-US, de-DE.",
    "settings.ignored": "Ignored categories",
    "settings.ignored.hint": "Comma-separated LanguageTool category IDs to skip.",
    "settings.rewriteEndpoint": "Rewrite endpoint",
    "settings.rewriteEndpoint.hint": "OpenAI-compatible /v1/chat/completions URL (your llamafile behind nginx).",
    "settings.prompt": "System prompt",
    "settings.prompt.hint": "Instruction sent with every rephrase. Tune freely — no server restart needed.",
    "settings.preferredVariants": "Preferred variants",
    "settings.preferredVariants.hint": "With language=auto: which variant per detected language (en-US vs en-GB, …).",
    "settings.motherTongue": "Mother tongue",
    "settings.motherTongue.hint": "Your native language (e.g. de-DE). Enables false-friends warnings. Blank = off.",
    "settings.rephraseVariants": "Offer multiple style options for “Rephrase”",
    "settings.rephraseVariants.hint": "When on, the plain “Rephrase” action returns several styles to pick from.",
    "settings.save": "Save",
    "settings.saved": "Saved.",
    "settings.about": "Free software under the AGPL-3.0.",
    "settings.source": "Source code",

    "tour.next": "Next",
    "tour.back": "Back",
    "tour.skip": "Skip",
    "tour.done": "Got it!",
    "tour.s1.title": "LanguageTool Inline",
    "tour.s1.body": "A local grammar checker and AI rephraser that works in any app on your PC. Your text only ever goes to your own server.",
    "tour.s2.title": "The floating button",
    "tour.s2.body": "The green button stays on top of everything. Drag it anywhere to move it, click it to open — or press Ctrl+Alt+R from any app.",
    "tour.s3.title": "Pick your text",
    "tour.s3.body": "Select some text first and it works on just that. Select nothing and it grabs the whole text field you're in.",
    "tour.s4.title": "Fix grammar",
    "tour.s4.body": "Each flagged word shows LanguageTool's suggestions — click the right one (context matters!) or use “Apply all (best)”. Then “Apply (paste)” drops it back into your app.",
    "tour.s5.title": "Rephrase",
    "tour.s5.body": "Rewrite your text with your local AI model — one polished version, or several styles (casual, professional, concise) to choose from.",
    "tour.s6.title": "Right-click & Settings",
    "tour.s6.body": "Right-click the button for quick actions and Settings, where you set the server endpoints, language and interface language. Reopen this tour anytime from that menu.",
  },
  de: {
    "panel.fix": "✓  Grammatik korrigieren",
    "panel.rephrase": "✨  Umformulieren",
    "panel.variants": "🎛  Umformulieren — Stile",
    "panel.apply": "Übernehmen (einfügen)",
    "panel.useThis": "Diesen verwenden",
    "panel.proofread": "✦  KI-Korrektur",
    "panel.reading": "Auswahl wird gelesen…",
    "panel.selectFirst": "Erst Text markieren, dann erneut auslösen.",
    "panel.working": "Wird verarbeitet…",
    "panel.aiWorking": "KI prüft…",
    "panel.aiNothing": "KI hat nichts weiter gefunden ✓",
    "panel.aiConfusion": "Mögliche Wortverwechslung",
    "panel.aiNote": "KI kann Fehler machen — prüfe jeden Vorschlag vor dem Übernehmen.",
    "panel.noVariants": "Keine Varianten erhalten.",
    "panel.noIssues": "Keine Probleme gefunden.",
    "panel.fixAll": "Alle übernehmen (beste)",
    "panel.nothing": "Nichts erfasst.",
    "panel.error": "Fehler: ",

    "settings.subtitle": "Desktop — lokale Grammatik & KI-Umformulierung",
    "settings.tab.grammar": "Grammatik",
    "settings.tab.rephrase": "Umformulieren",
    "settings.uiLanguage": "Oberflächensprache",
    "settings.uiLanguage.hint": "Sprache der Benutzeroberfläche dieser App.",
    "settings.uiLanguage.auto": "Automatisch (System)",
    "settings.ltEndpoint": "LanguageTool-Endpunkt",
    "settings.ltEndpoint.hint": "Vollständige URL des /v2/check-Endpunkts.",
    "settings.language": "Sprache",
    "settings.language.hint": "auto oder ein Code wie en-US, de-DE.",
    "settings.ignored": "Ignorierte Kategorien",
    "settings.ignored.hint": "Kommagetrennte LanguageTool-Kategorie-IDs zum Überspringen.",
    "settings.rewriteEndpoint": "Umformulierungs-Endpunkt",
    "settings.rewriteEndpoint.hint": "OpenAI-kompatible /v1/chat/completions-URL (dein llamafile hinter nginx).",
    "settings.prompt": "System-Prompt",
    "settings.prompt.hint": "Anweisung bei jeder Umformulierung. Frei anpassbar — kein Server-Neustart nötig.",
    "settings.preferredVariants": "Bevorzugte Varianten",
    "settings.preferredVariants.hint": "Bei language=auto: welche Variante je erkannter Sprache (en-US vs en-GB, …).",
    "settings.motherTongue": "Muttersprache",
    "settings.motherTongue.hint": "Deine Muttersprache (z. B. de-DE). Aktiviert Warnungen zu falschen Freunden. Leer = aus.",
    "settings.rephraseVariants": "Mehrere Stiloptionen für „Umformulieren“ anbieten",
    "settings.rephraseVariants.hint": "Wenn aktiv, liefert die einfache „Umformulieren“-Aktion mehrere Stile zur Auswahl.",
    "settings.save": "Speichern",
    "settings.saved": "Gespeichert.",
    "settings.about": "Freie Software unter der AGPL-3.0.",
    "settings.source": "Quellcode",

    "tour.next": "Weiter",
    "tour.back": "Zurück",
    "tour.skip": "Überspringen",
    "tour.done": "Verstanden!",
    "tour.s1.title": "LanguageTool Inline",
    "tour.s1.body": "Eine lokale Grammatikprüfung und KI-Umformulierung, die in jeder App auf deinem PC funktioniert. Dein Text geht nur an deinen eigenen Server.",
    "tour.s2.title": "Der schwebende Button",
    "tour.s2.body": "Der grüne Button bleibt immer im Vordergrund. Zieh ihn an eine beliebige Stelle, klick ihn zum Öffnen – oder drücke Strg+Alt+R in jeder App.",
    "tour.s3.title": "Text auswählen",
    "tour.s3.body": "Markiere zuerst Text, dann wird nur dieser bearbeitet. Markierst du nichts, wird das ganze Textfeld erfasst, in dem du gerade bist.",
    "tour.s4.title": "Grammatik korrigieren",
    "tour.s4.body": "Jedes markierte Wort zeigt LanguageTools Vorschläge – wähle den passenden (der Kontext zählt!) oder nutze „Alle übernehmen (beste)“. Mit „Übernehmen (einfügen)“ landet der Text wieder in deiner App.",
    "tour.s5.title": "Umformulieren",
    "tour.s5.body": "Formuliere deinen Text mit deinem lokalen KI-Modell um – eine saubere Version oder mehrere Stile (locker, professionell, prägnant) zur Auswahl.",
    "tour.s6.title": "Rechtsklick & Einstellungen",
    "tour.s6.body": "Per Rechtsklick auf den Button erreichst du Schnellaktionen und die Einstellungen, wo du Server-Endpunkte, Sprache und Oberflächensprache festlegst. Diese Tour kannst du jederzeit über das Menü erneut öffnen.",
  },
};

let LOCALE = "en";

// uiLang: "auto" | "en" | "de". "auto" → derive from the system/browser language.
function resolveLocale(uiLang) {
  let loc = uiLang;
  if (!loc || loc === "auto") {
    loc = (navigator.language || "en").toLowerCase().startsWith("de") ? "de" : "en";
  }
  return I18N[loc] ? loc : "en";
}

function setLocale(loc) {
  LOCALE = I18N[loc] ? loc : "en";
}

function t(key) {
  const d = I18N[LOCALE] || I18N.en;
  return d[key] ?? I18N.en[key] ?? key;
}

function applyTranslations(root) {
  (root || document).querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
}
