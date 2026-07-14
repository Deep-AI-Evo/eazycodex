@echo off
REM easyCodex build script with China mirror acceleration
REM Uses npmmirror.com instead of GitHub for downloads

set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

echo Building easyCodex with China mirrors...
echo   ELECTRON_MIRROR=%ELECTRON_MIRROR%
echo   ELECTRON_BUILDER_BINARIES_MIRROR=%ELECTRON_BUILDER_BINARIES_MIRROR%

call npm run build %*
echo Done.
