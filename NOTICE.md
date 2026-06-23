# Licensing & Attribution

## This project's code — AGPL-3.0-or-later

Copyright (C) 2026 Oratorian

The original code in this repository (the browser extension, the desktop app,
the install scripts, and supporting tooling) is free software: you can
redistribute it and/or modify it under the terms of the **GNU Affero General
Public License** as published by the Free Software Foundation, either version 3
of the License, or (at your option) any later version. See [LICENSE](LICENSE).

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU AGPL for more details.

**Why AGPL:** if you run a modified version of this software as a network
service, the AGPL (§13) requires you to make your modified source available to
the users of that service. This keeps hosted forks open.

The complete corresponding source is available at:
<https://github.com/Oratorian/lt-inline>  <!-- update before publishing -->

## Third-party components (NOT covered by this project's license)

This software *uses* but does not include or redistribute the following. The
install scripts download them from their official sources at install time, on
the user's own machine. Each remains under its own license:

- **LanguageTool** — the grammar engine this project talks to over HTTP.
  Free software under the **GNU LGPL 2.1**. <https://languagetool.org> /
  <https://github.com/languagetool-org/languagetool>. This project does not
  modify, bundle, or redistribute LanguageTool, and does not enable or
  redistribute any of LanguageTool's premium-only rules or data.

- **fastText** — language identification (the `fasttext` binary + `lid.176.bin`
  model). **MIT License**. <https://github.com/facebookresearch/fastText> and
  <https://fasttext.cc>.

- **n-gram data** — LanguageTool's confusion n-grams, downloaded from the
  official LanguageTool data servers under LanguageTool's terms.

- **llamafile** — Mozilla's self-contained LLM runner used for the AI proofread
  / rephrase pass. **Apache-2.0** (with parts under other permissive licenses).
  <https://github.com/Mozilla-Ocho/llamafile>.

- **the LLM weights** (e.g. Qwen-family GGUF in the bundled llamafiles) — under
  their respective model licenses; see the model card on the source repository.

- **webextension-polyfill** — Mozilla, **MPL-2.0**, bundled with the MV3 build.
  <https://github.com/mozilla/webextension-polyfill>.
