# build-bundled.ps1 - Bundled easyCodex (includes Codex desktop, ~750MB)
# Installs Codex from local package, falls back to Store download if it fails
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"

if (-not (Test-Path "resources\codex-package.zip")) {
    Write-Error "resources\codex-package.zip not found!"
    exit 1
}

node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json'));p.version='4.0.0-bundled';p.build.extraResources=[{from:'resources/codex-package.zip',to:'codex-package.zip'}];fs.writeFileSync('package.json',JSON.stringify(p,null,2));console.log('Configured for bundled build (v4.0.0-bundled)');"

Write-Output "Building bundled version..."
npm run build
Write-Output "Done: dist\easyCodex Setup 4.0.0-bundled.exe"