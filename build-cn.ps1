# easyCodex build script with China mirror acceleration
# Uses npmmirror.com instead of GitHub for downloads

$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"

Write-Host "Building easyCodex with China mirrors..." -ForegroundColor Cyan
Write-Host "  ELECTRON_MIRROR=$($env:ELECTRON_MIRROR)"
Write-Host "  ELECTRON_BUILDER_BINARIES_MIRROR=$($env:ELECTRON_BUILDER_BINARIES_MIRROR)"

npm run build @args
Write-Host "Done." -ForegroundColor Green
