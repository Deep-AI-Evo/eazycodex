# build-light.ps1 - Lightweight easyCodex (no Codex bundled, ~78MB)
# Users download Codex from Microsoft Store during install
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"

node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json'));p.version='4.0.0';delete p.build.extraResources;fs.writeFileSync('package.json',JSON.stringify(p,null,2));console.log('Configured for light build (v4.0.0)');"

Write-Output "Building lightweight version..."
npm run build
Write-Output "Done: dist\easyCodex Setup 4.0.0.exe"