# lt-stack — self-hosted backend

The backend the clients talk to: a **LanguageTool** server (grammar) + a local
**LLM** behind an OpenAI-compatible endpoint (AI proofread / rephrase), fronted
by a TLS reverse proxy.

Everything here is **fetched from official upstream sources at install time on
your machine** — nothing is re-hosted or redistributed. It does **not** unlock
LanguageTool's premium rules (that data isn't public); the LLM pass covers the
confusions the free engine misses instead.

---

## Contents

```
lt-stack/
├─ install.sh                       # Linux/server installer (bash)
├─ install.ps1                      # Windows installer (PowerShell)
├─ docker-compose.yml               # portable base (self-contained)
├─ docker-compose.override.example.yml  # copy → override for your host topology
├─ bin/                             # bundled Windows fasttext.exe goes here
└─ README.md
```

---

## Option A — install script (recommended)

Two parallel installers with the same flow. Each prompts for a mode, or you pass
it as a flag.

**Linux / server:**

```bash
chmod +x install.sh
./install.sh --mode docker            # run LanguageTool via Docker
# or
./install.sh --mode native            # download + run the LT build directly
# add the LLM and/or print an nginx snippet:
./install.sh --mode docker --with-llm --with-nginx
```

**Windows (PowerShell 7):**

```powershell
pwsh ./install.ps1 -Mode docker
pwsh ./install.ps1 -Mode native -WithLlm -WithNginx
```

**Modes:**

- **`docker`** — runs LanguageTool via the `meyay/languagetool` image using the
  `docker-compose.yml` in this folder. (See *Docker details* below.)
- **`native`** — downloads the free LanguageTool build and runs it with Java,
  optionally fetching n-gram data and setting up fastText.

**Flags:**

- **`--with-llm` / `-WithLlm`** — also download a self-contained Mozilla
  **llamafile** (you pick **4B** for best quality or **2B** for low-/no-GPU) and
  print its launch command.
- **`--with-nginx` / `-WithNginx`** — print a ready reverse-proxy snippet (with
  the trailing-slash fix already applied — see *Gotchas*).

> All download URLs and versions live in an **editable CONFIG block at the top**
> of each script. Adjust them there (e.g. pin a LanguageTool version, change the
> n-gram languages) without touching the logic.

---

## Docker details

The committed `docker-compose.yml` is **portable**: a self-contained network and
a published port (`localhost:8081`), so a fresh `docker compose up -d` just works.

For a host with its own topology (external network, static IPs, bind-mounted data
dirs), copy the example override — Docker merges it automatically and it's
gitignored so your private addressing never gets committed:

```bash
cp docker-compose.override.example.yml docker-compose.override.yml
# edit it for your network, then:
docker compose up -d
```

The image (`meyay/languagetool`) is configured via environment variables in the
compose file — n-gram languages (`download_ngrams_for_langs`), the n-gram path
(`langtool_languageModel`), heap (`JAVA_XMX`), pipeline caching/pre-warming, etc.

---

## Native mode details

### LanguageTool

Downloads the free build and runs it with **Java 17+**:

```bash
java -Xmx4g -cp languagetool-server.jar org.languagetool.server.HTTPServer \
     --port 8081 --allow-origin '*' --config server.properties
```

The script writes `server.properties` with the paths it set up (n-grams,
fastText). Keep LanguageTool bound to loopback and expose it only through the
reverse proxy.

### n-gram confusion data (optional, large)

LanguageTool's confusion rules need the n-gram data (several GB per language),
downloaded from the official LanguageTool data servers. The installer prompts
per language and points `languageModel` at the directory.

### fastText auto language detection (optional)

`language=auto` works without fastText (LanguageTool has a built-in detector),
but fastText is more accurate on short text. It needs **two** things:

- the **`lid.176.bin`** model (official download), and
- the compiled **`fasttext` binary** (`fasttextBinary` property).

**Linux:** the installer resolves the binary by *detect → package manager
(`apt`/`pacman`/`dnf`/`zypper`) → build from source*. Source build needs `git` +
a C++11 compiler + `make` (the requirement is ancient, so this works on any
modern distro). It aborts if none succeed.

**Windows:** there's no package/compiler path, so bundle a prebuilt
**`fasttext.exe`** in [`bin/`](bin/) (see [`bin/README.md`](bin/README.md) for the
CMake build command). LanguageTool on Windows needs `fasttext` runnable from
**any console**, so the installer copies it to a dir and adds that dir to your
user **PATH**; `server.properties` then uses the bare command name `fasttext`.

---

## LLM (llamafile)

A self-contained Mozilla **llamafile** bundles the model + runner in one
executable — no separate weights file. Two are offered:

| Model | Use it when |
|---|---|
| **Qwen 4B (Q5_K_S)** | best quality; fits a 6 GB GPU (~55 tok/s on a GTX 1660 Ti) |
| **Qwen 2B (Q8_0)** | smaller; runs acceptably on **CPU only** |

Launch (the `.llamafile` *is* the runner — no `-m`):

```bash
./Qwen3.5-4B-Q5_K_S.llamafile --server --nobrowser --port 6181 \
    -ngl 999 --temp 0.1 --top-p 0.9 --top-k 20
```

- `-ngl 999` offloads all layers to the GPU; drop it for CPU.
- Exposes `POST /v1/chat/completions`.
- Run "thinking" models in **non-thinking** mode for clean, fast output (the
  clients also strip stray `<think>…</think>` defensively).

---

## Reverse proxy (TLS + paths)

Front both services under one HTTPS host so the clients only speak
`https://<your-host>` (also avoids browser mixed-content blocking). `--with-nginx`
prints this; here it is for reference:

```nginx
location /v2/ {
    proxy_pass http://127.0.0.1:8081/v2/;
}

location /llm/ {
    proxy_pass http://127.0.0.1:6181/;   # <-- trailing slash REQUIRED
    # equivalently: rewrite ^/llm/(.*)$ /$1 break;
    proxy_set_header Host $host;
    proxy_read_timeout 120s;
    proxy_buffering off;
}
```

Resulting client endpoints:
- Grammar: `https://<your-host>/v2/check`
- Rephrase / AI proofread: `https://<your-host>/llm/v1/chat/completions`

**TLS:** the cert must be trusted by the client machine. A real-CA cert (e.g.
Let's Encrypt on a real domain) works everywhere without importing a private CA —
handy on machines you don't control.

---

## Gotchas

- **Nginx Proxy Manager strips the trailing `/` off `proxy_pass`.** Without it the
  upstream receives `/llm/v1/...` and 404s, so the proxy returns **502** while
  `/v2/check` still works. If `/llm` 502s but grammar works, suspect this first —
  keep the trailing slash or use the explicit `rewrite`.
- **n-gram archive filenames** in the CONFIG block are dated (e.g.
  `ngrams-en-20150817.zip`); verify them against the current LanguageTool
  download page if a fetch 404s.
- **PATH changes on Windows reach only *new* consoles** — start (or restart)
  LanguageTool from a fresh console after the installer adds fastText to PATH.

---

## Licensing

This installer is AGPL-3.0 (see the repo [LICENSE](../LICENSE)). It downloads —
but does not redistribute — LanguageTool (LGPL), fastText (MIT), llamafile
(Apache-2.0) and the model weights (their own licenses) from their official
sources. See [NOTICE.md](../NOTICE.md).
