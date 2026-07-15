# Package the single MV3 source into per-store zips.
#
# Chrome / Edge / Opera all run the SAME Chromium MV3 package — the only reason
# we emit three zips is so each store gets its own clearly-named upload (and so
# you can diverge per-store metadata later if needed). Firefox MV3 uses the same
# source but keeps the browser_specific_settings.gecko block; the Chromium zips
# strip it (Chromium ignores it anyway, and it keeps store validators quiet).
#
# Usage:  pwsh ./package.ps1            # build all targets into ./dist
#         pwsh ./package.ps1 -Stores chrome,firefox
#         pwsh ./package.ps1 -Sign      # also AMO-sign the Firefox build (unlisted .xpi)
#
# Signing: -Sign runs `web-ext sign` on the Firefox build to produce a
# self-hosted, self-updating .xpi. It needs AMO API credentials in the
# environment as WEB_EXT_API_KEY / WEB_EXT_API_SECRET (load them however you
# like, e.g. `Import-Module DevKit; dotenv ./.hidden`). Only the Firefox target
# is signable; -Sign is a no-op warning if 'firefox' isn't in -Stores.

param(
    [string[]] $Stores = @('chrome', 'edge', 'opera', 'firefox'),
    [string]   $OutDir = 'dist',
    [switch]   $Sign,
    [ValidateSet('unlisted', 'listed')]
    [string]   $Channel = 'unlisted'
)

$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$dist = Join-Path $src $OutDir
New-Item -ItemType Directory -Force -Path $dist | Out-Null

# Preflight the signing prerequisites up front, so a long build doesn't run only
# to fail at the sign step for a missing key.
if ($Sign) {
    if ($Stores -notcontains 'firefox') {
        Write-Warning "-Sign only applies to the Firefox build, but 'firefox' isn't in -Stores; nothing will be signed."
    }
    foreach ($v in 'WEB_EXT_API_KEY', 'WEB_EXT_API_SECRET') {
        if (-not [Environment]::GetEnvironmentVariable($v)) {
            throw "-Sign needs $v in the environment. Load your AMO keys first (e.g. Import-Module DevKit; dotenv ./.hidden)."
        }
    }
}

# Read version + name from the manifest for the output filename.
$manifest = Get-Content (Join-Path $src 'manifest.json') -Raw | ConvertFrom-Json
$version = $manifest.version

# Files that make up the extension (everything except dev/packaging artifacts).
$exclude = @('dist', 'package.ps1', '*.zip', '.amo-upload-uuid', '.git', '*.psd1', '*.psm1')

function Get-PayloadFiles {
    Get-ChildItem -Path $src -Recurse -File | Where-Object {
        $rel = $_.FullName.Substring($src.Length + 1)
        $top = ($rel -split '[\\/]')[0]
        -not ($exclude | Where-Object { $top -like $_ -or $_.Name -like $_ })
    }
}

# Chromium stores don't need the gecko block; produce a stripped manifest for them.
function New-ChromiumManifest($destDir) {
    $m = Get-Content (Join-Path $src 'manifest.json') -Raw | ConvertFrom-Json
    $m.PSObject.Properties.Remove('browser_specific_settings')
    # Chromium uses a service worker for the background.
    $m.background = [pscustomobject]@{ service_worker = 'background.js' }
    $m | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $destDir 'manifest.json') -Encoding utf8
}

# Self-hosted Firefox update URL. Kept OUT of the repo (source manifest.json is
# store-neutral): read from the FF_UPDATE_URL environment variable so the private
# update-server hostname never lands in version control. Load it however you load
# your other secrets, e.g. `Import-Module DevKit; dotenv ./.hidden`. If it isn't
# set, the Firefox build is produced WITHOUT update_url (a valid AMO/store-style
# build with no self-update) and a warning is printed — we never hardcode a URL.
$FirefoxUpdateUrl = [Environment]::GetEnvironmentVariable('FF_UPDATE_URL')

# Firefox MV3 uses an event page, NOT a service worker: background.scripts (an
# array), with the polyfill loaded as the first entry (background.js's
# importScripts guard then no-ops). Keeps the gecko block and injects update_url.
function New-FirefoxManifest($destDir) {
    $m = Get-Content (Join-Path $src 'manifest.json') -Raw | ConvertFrom-Json
    $m.background = [pscustomobject]@{ scripts = @('browser-polyfill.min.js', 'background.js') }
    # Inject update_url into the gecko block for the self-hosted auto-update flow.
    # Add-Member -Force overwrites it if a stray copy is ever left in source.
    if ($FirefoxUpdateUrl) {
        $gecko = $m.browser_specific_settings.gecko
        $gecko | Add-Member -NotePropertyName 'update_url' -NotePropertyValue $FirefoxUpdateUrl -Force
    } else {
        Write-Warning "FF_UPDATE_URL not set - Firefox build will have NO update_url (no self-update). Load it (e.g. dotenv ./.hidden) before building the release .xpi."
    }
    $m | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $destDir 'manifest.json') -Encoding utf8
}

foreach ($store in $Stores) {
    $stage = Join-Path $dist "_stage_$store"
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $stage | Out-Null

    # Copy the full source, then (for Chromium) overwrite manifest with the
    # gecko-stripped variant.
    Copy-Item -Path (Join-Path $src '*') -Destination $stage -Recurse -Force `
        -Exclude @('dist', 'package.ps1', '*.zip', '.amo-upload-uuid')
    if ($store -eq 'firefox') {
        New-FirefoxManifest $stage
    } else {
        New-ChromiumManifest $stage
    }

    $zipName = "lt-inline-$store-$version.zip"
    $zipPath = Join-Path $dist $zipName
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

    # Zip the staged CONTENTS (not the folder itself) so the manifest is at root.
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zipPath -Force

    # Sign the Firefox build (from the stage dir, which carries the correct
    # event-page manifest) BEFORE we delete the stage. web-ext builds+signs from a
    # source directory, not a zip, and reads WEB_EXT_API_KEY/SECRET from the env.
    if ($Sign -and $store -eq 'firefox') {
        Write-Host "  firefox  -> signing ($Channel) ..." -ForegroundColor Yellow
        npx --yes web-ext sign `
            --source-dir $stage `
            --channel $Channel `
            --artifacts-dir $dist
        if ($LASTEXITCODE -ne 0) { throw "web-ext sign failed (exit $LASTEXITCODE)." }
        $xpi = Get-ChildItem $dist -Filter '*.xpi' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($xpi) { Write-Host ("  firefox  -> signed {0}" -f $xpi.Name) -ForegroundColor Green }
    }

    Remove-Item $stage -Recurse -Force

    $kb = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
    Write-Host ("  {0,-8} -> {1} ({2} KB)" -f $store, $zipName, $kb) -ForegroundColor Green
}

Write-Host "`nDone. Upload from $dist :" -ForegroundColor Cyan
Write-Host "  chrome  -> Chrome Web Store     (chromewebstore.google.com/devconsole)"
Write-Host "  edge    -> Edge Add-ons         (partner.microsoft.com/dashboard/microsoftedge)"
Write-Host "  opera   -> Opera Add-ons        (addons.opera.com/developer)"
Write-Host "  firefox -> AMO / self-host xpi  (keeps the gecko block + self-update)"
