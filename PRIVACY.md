# Privacy Policy — LanguageTool Inline

_Last updated: 2026-06-23_

LanguageTool Inline ("the extension") is a privacy-first grammar checker and AI
writing assistant. This policy explains exactly what data it handles and where
it goes.

## Summary

- The extension sends the text you are editing **only to the grammar/AI server
  that you configure** in its settings.
- It does **not** send your data to the developer, to the extension's authors,
  or to any third-party service we operate or control.
- There is **no analytics, no telemetry, no tracking, and no advertising.**
- We (the authors) **do not receive, store, or have access to any of your data.**

## What data is processed, and where it goes

To check grammar or rephrase text, the extension sends the relevant text to an
endpoint **you specify** in the extension's options:

- A **LanguageTool server** (for grammar/spelling checking).
- Optionally, an **OpenAI-compatible LLM endpoint** (for the "AI proofread" and
  "Rephrase" features).

These endpoints are configured by you. In the intended setup they are servers
**you host yourself** on your own machine or network. The extension ships with
placeholder endpoints that do not point at any real server until you set your
own. The text is transmitted directly from your browser to that endpoint; it
does not pass through any server operated by the extension's authors.

**What is sent:** the contents of the text field you are editing (or the text
you select for rephrasing), plus grammar-check parameters (e.g. language,
preferred variants). This is the minimum required to perform the check.

**Where results go:** suggestions returned by your server are shown inline in
your browser and are never transmitted anywhere else.

## What is stored locally

The extension stores its **settings** (such as your server endpoint URLs and
preferences) in the browser's local extension storage on your own device. This
never leaves your device and is not synced to us.

The extension does not store the text you check.

## Permissions and why they are needed

- **Access to website content (`<all_urls>` / host access):** so the extension
  can attach its inline grammar-check UI to editable text fields on the sites
  where you type. It only reads the contents of fields you are editing.
- **Access to your configured server host:** so the background script can send
  text to your LanguageTool/LLM endpoint.
- **Storage:** to save your settings.
- **Context menus / alarms:** for the right-click rephrase action and the
  periodic "is my server reachable?" status check (which only contacts the
  server you configured).

## Third parties

The extension itself contacts **no third parties.** If you choose to configure
a third-party (non-self-hosted) LanguageTool or LLM endpoint, your text will be
sent to that third party, and **their** privacy policy then applies to that
data. Choosing such an endpoint is entirely your decision.

## Children

The extension is a general-purpose writing tool and is not directed at children.

## Changes

This policy may be updated; the "Last updated" date above reflects the latest
version. The current version is always available in the project's source
repository.

## Contact

Questions about this policy can be raised via the project's source repository:
<https://github.com/Oratorian/lt-inline>
