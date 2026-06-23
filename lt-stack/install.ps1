# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Oratorian. See LICENSE.
<#
.SYNOPSIS
  LanguageTool + LLM self-hosted stack installer (Windows).

.DESCRIPTION
  Sets up a privacy-first grammar + AI-rephrase backend. EVERYTHING is fetched
  from the official upstream servers at install time on THIS machine — nothing
  is re-hosted or redistributed. LanguageTool is LGPL (see attribution at the
  end); the n-gram data, fastText model, llamafile runner and the LLM weights
  come from their own official sources under their own licenses.

  It does NOT and CANNOT enable LanguageTool's premium-only rules: those rely on
  proprietary data that is not publicly downloadable. The companion clients use
  a local LLM proofread pass to cover the confusions the free engine misses.

.PARAMETER Mode
  docker  — run via meyay/languagetool using YOUR docker-compose.yml next to this script.
  native  — download the free LanguageTool build + optional n-grams + fastText.

.PARAMETER WithLlm   Also fetch the llamafile runner + GGUF and print launch cmd.
.PARAMETER WithNginx Emit an nginx reverse-proxy snippet.

.EXAMPLE
  pwsh ./install.ps1 -Mode docker -WithLlm
#>
param(
    [ValidateSet('docker', 'native')] [string] $Mode,
    [switch] $WithLlm,
    [switch] $WithNginx
)

$ErrorActionPreference = 'Stop'

# ============================================================================
# CONFIG — edit these. Defaults point at official sources; pin versions here.
# ============================================================================
$LtVersion   = '6.8'
$LtZipUrl    = "https://internal1.languagetool.org/snapshots/LanguageTool-latest-snapshot.zip"

$NgramBaseUrl = 'https://languagetool.org/download/ngram-data'
$NgramFiles   = @{ en = 'ngrams-en-20150817.zip'; de = 'ngrams-de-20150819.zip' }
$NgramLangs   = @('en', 'de')

$FastTextModelUrl = 'https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.bin'

# Self-contained Mozilla llamafiles (model + runner in one executable). Both fit
# a 6 GB GPU (tested ~55 t/s on a GTX 1660 Ti); the 2B also runs acceptably on
# CPU only. Pick 4B for best quality, 2B for low-/no-GPU machines.
$Llamafiles = [ordered]@{
    '4B (Q5_K_S) - best quality, fits a 6GB GPU' = 'https://huggingface.co/mozilla-ai/llamafile_0.10/resolve/main/Qwen3.5-4B-Q5_K_S.llamafile'
    '2B (Q8_0) - smaller, runs even on CPU only'  = 'https://huggingface.co/mozilla-ai/llamafile_0.10/resolve/main/Qwen3.5-2B-Q8_0.llamafile'
}
$LlmPort  = 6181
# A bundled .llamafile IS the runner — no -m needed (the model is baked in).
$LlmFlags = "--server --nobrowser --port $LlmPort -ngl 999 --temp 0.1 --top-p 0.9 --top-k 20"

$InstallDir   = if ($env:LT_INSTALL_DIR) { $env:LT_INSTALL_DIR } else { Join-Path $HOME 'lt-stack' }
# ============================================================================

function Say  ($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok   ($m) { Write-Host "  + $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "  ! $m" -ForegroundColor Yellow }
function Die  ($m) { Write-Host "error: $m" -ForegroundColor Red; exit 1 }
function AskYN($m) { (Read-Host "$m [y/N]") -match '^[Yy]$' }
function Need ($c) { if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { Die "missing required tool: $c" } }

# Append a directory to the persistent USER PATH (idempotent) and to the current
# session, so an exe in it runs from any console.
function Add-ToUserPath ($dir) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = ($userPath -split ';') | Where-Object { $_ -ne '' }
    if ($parts -notcontains $dir) {
        [Environment]::SetEnvironmentVariable('Path', (($parts + $dir) -join ';'), 'User')
        Ok "added to user PATH: $dir (new consoles will pick it up)"
    }
    else {
        Ok "already on user PATH: $dir"
    }
    if (($env:Path -split ';') -notcontains $dir) { $env:Path += ";$dir" }  # current session
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $Mode) {
    Write-Host "Choose how to run LanguageTool:"
    Write-Host "  1) docker  — meyay/languagetool image (uses your docker-compose.yml)"
    Write-Host "  2) native  — download the free build and run it directly"
    switch (Read-Host "Mode [1/2]") {
        '1' { $Mode = 'docker' }
        '2' { $Mode = 'native' }
        default { Die "invalid choice" }
    }
}

function Install-Docker {
    Need docker
    $compose = Join-Path $ScriptDir 'docker-compose.yml'
    if (-not (Test-Path $compose)) { Die "docker-compose.yml not found next to this script ($compose). Drop your tested compose file there." }
    Say "Starting LanguageTool via your docker-compose.yml"
    Push-Location $ScriptDir
    try { docker compose up -d; Ok "docker compose up -d completed" } finally { Pop-Location }
}

function Install-Native {
    Need java
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

    Say "Downloading LanguageTool $LtVersion (LGPL) from the official site"
    $zip = Join-Path $InstallDir 'lt.zip'
    Invoke-WebRequest -Uri $LtZipUrl -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $InstallDir -Force
    Remove-Item $zip
    $ltdir = Join-Path $InstallDir "LanguageTool-$LtVersion"
    Ok "LanguageTool extracted to $ltdir"

    $ngramDir = Join-Path $InstallDir 'ngrams'
    if (AskYN "Download n-gram confusion data? (large — several GB per language)") {
        New-Item -ItemType Directory -Force -Path $ngramDir | Out-Null
        foreach ($lang in $NgramLangs) {
            if (AskYN "  include $lang n-grams?") {
                Say "Fetching $lang n-grams from $NgramBaseUrl"
                $nz = Join-Path $InstallDir "ng-$lang.zip"
                Invoke-WebRequest -Uri "$NgramBaseUrl/$($NgramFiles[$lang])" -OutFile $nz -UseBasicParsing
                Expand-Archive -Path $nz -DestinationPath $ngramDir -Force
                Remove-Item $nz
                Ok "$lang n-grams -> $ngramDir\$lang"
            }
        }
    }

    # fastText auto-detection needs BOTH the binary and the model. On Windows
    # LanguageTool requires `fasttext` to be runnable from ANY console, i.e. on
    # PATH — so we place fasttext.exe in a dir and add that dir to the user PATH.
    # server.properties then uses the bare command name `fasttext`.
    $fasttextOk = $false
    $fasttextModel = ''
    if (AskYN "Set up fastText auto language detection? (needs fasttext.exe + ~130 MB model)") {
        # Find the exe: already on PATH, else the bundled copy in .\bin.
        $onPath = (Get-Command fasttext -ErrorAction SilentlyContinue)?.Source
        $bundled = Join-Path $ScriptDir 'bin\fasttext.exe'
        if ($onPath) {
            Ok "fasttext already runnable from PATH ($onPath)"
        }
        elseif (Test-Path $bundled) {
            # Install into the stack's bin dir and put that dir on PATH.
            $binDir = Join-Path $InstallDir 'bin'
            New-Item -ItemType Directory -Force -Path $binDir | Out-Null
            Copy-Item $bundled (Join-Path $binDir 'fasttext.exe') -Force
            if (AskYN "Add $binDir to your user PATH so 'fasttext' runs from any console?") {
                Add-ToUserPath $binDir
            }
            else {
                Die "fasttext must be on PATH for LanguageTool on Windows. Add $binDir to PATH and re-run, or decline fastText."
            }
        }
        else {
            Die "fasttext.exe not found on PATH or at $bundled. Bundle a prebuilt fasttext.exe in .\bin (see bin\README.md), or re-run and decline fastText to use LanguageTool's built-in detection."
        }

        # Confirm it actually resolves now.
        if (-not (Get-Command fasttext -ErrorAction SilentlyContinue)) {
            Die "fasttext still not resolvable on PATH. Open a new console and re-run, or fix PATH manually."
        }
        Ok "fasttext runs as a bare command"

        Say "Fetching fastText lid.176 model (official)"
        $fasttextModel = Join-Path $InstallDir 'lid.176.bin'
        Invoke-WebRequest -Uri $FastTextModelUrl -OutFile $fasttextModel -UseBasicParsing
        Ok "fastText model -> $fasttextModel"
        $fasttextOk = $true
    }

    $props = Join-Path $ltdir 'server.properties'
    $lines = @()
    if (Test-Path $ngramDir) { $lines += "languageModel=$ngramDir" }
    if ($fasttextOk) {
        # Bare command name — LT resolves it via PATH (required on Windows).
        $lines += "fasttextBinary=fasttext"
        $lines += "fasttextModel=$fasttextModel"
    }
    Set-Content -Path $props -Value $lines -Encoding utf8
    Ok "wrote $props"

    Write-Host @"

To start LanguageTool (native):
  cd "$ltdir"
  java -Xmx4g -cp languagetool-server.jar org.languagetool.server.HTTPServer ``
       --port 8081 --allow-origin '*' --config server.properties
"@
}

function Install-Llm {
    $dir = Join-Path $InstallDir 'llm'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null

    # Let the user pick which self-contained llamafile to fetch.
    $labels = @($Llamafiles.Keys)
    for ($i = 0; $i -lt $labels.Count; $i++) { Write-Host "  $($i + 1)) $($labels[$i])" }
    $sel = [int](Read-Host "Which model? [1-$($labels.Count)]") - 1
    if ($sel -lt 0 -or $sel -ge $labels.Count) { Die "invalid choice" }
    $label = $labels[$sel]
    $url = $Llamafiles[$label]
    # Windows runs a .llamafile when named .exe.
    $outName = ([System.IO.Path]::GetFileNameWithoutExtension($url)) + '.exe'
    $out = Join-Path $dir $outName

    Say "Downloading $label (model + runner, ~GB) from Mozilla's HuggingFace repo"
    Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
    Ok "llamafile -> $out"

    Write-Host @"

To start the LLM (the .llamafile IS the runner — no -m needed):
  cd "$dir"
  .\$outName $LlmFlags
"@
}

function Emit-Nginx {
    Write-Host @'

# --- nginx reverse-proxy snippet -------------------------------------------
# NOTE the TRAILING SLASH on proxy_pass for /llm/ — without it the upstream
# receives /llm/v1/... and 404s (the recurring NPM gotcha). Keep the slash, or
# use the explicit rewrite shown.

location /v2/ {
    proxy_pass http://127.0.0.1:8081/v2/;
}

location /llm/ {
    proxy_pass http://127.0.0.1:6181/;   # <-- trailing slash REQUIRED
    # equivalently: rewrite ^/llm/(.*)$ /$1 break;
    proxy_set_header Host $host;
}
'@
}

switch ($Mode) {
    'docker' { Install-Docker }
    'native' { Install-Native }
}
if ($WithLlm)   { Install-Llm }
if ($WithNginx) { Emit-Nginx }

Write-Host @'

Done.

Credits & licensing:
  LanguageTool is free software (LGPL 2.1) — https://languagetool.org
  This installer downloads it and the n-gram/fastText data from the OFFICIAL
  sources at install time; it does not redistribute them and does not unlock
  any premium-only rules. Please respect each component's license.
'@
