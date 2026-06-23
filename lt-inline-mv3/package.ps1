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

param(
    [string[]] $Stores = @('chrome', 'edge', 'opera', 'firefox'),
    [string]   $OutDir = 'dist'
)

$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$dist = Join-Path $src $OutDir
New-Item -ItemType Directory -Force -Path $dist | Out-Null

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

# Firefox MV3 uses an event page, NOT a service worker: background.scripts (an
# array), with the polyfill loaded as the first entry (background.js's
# importScripts guard then no-ops). Keeps the gecko block.
function New-FirefoxManifest($destDir) {
    $m = Get-Content (Join-Path $src 'manifest.json') -Raw | ConvertFrom-Json
    $m.background = [pscustomobject]@{ scripts = @('browser-polyfill.min.js', 'background.js') }
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
    Remove-Item $stage -Recurse -Force

    $kb = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
    Write-Host ("  {0,-8} -> {1} ({2} KB)" -f $store, $zipName, $kb) -ForegroundColor Green
}

Write-Host "`nDone. Upload from $dist :" -ForegroundColor Cyan
Write-Host "  chrome  -> Chrome Web Store     (chromewebstore.google.com/devconsole)"
Write-Host "  edge    -> Edge Add-ons         (partner.microsoft.com/dashboard/microsoftedge)"
Write-Host "  opera   -> Opera Add-ons        (addons.opera.com/developer)"
Write-Host "  firefox -> AMO / self-host xpi  (keeps the gecko block + self-update)"
