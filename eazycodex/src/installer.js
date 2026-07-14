/**
 * Dependency installer: installs Node.js and Codex desktop.
 *
 * Key design decisions:
 * - Node.js: via winget (winget source, package OpenJS.NodeJS.LTS)
 * - Codex DESKTOP app: via winget msstore source with Store ID 9PLM9XGG6VKS
 *   (NOT winget source with OpenAI.Codex, which is the CLI!)
 *
 * The Codex desktop app is published to the Microsoft Store as "ChatGPT"
 * by OpenAI. Its Store Product ID is 9PLM9XGG6VKS, and its
 * PackageFamilyName is OpenAI.Codex_2p2nqsd0c76g0.
 *
 * winget msstore uses the same CDN as Windows Update
 * (tlu.dl.delivery.mp.microsoft.com) which is accessible in China.
 */

'use strict';

const { execFile, spawn } = require('child_process');
const detector = require('./detector');

// Store Product ID for the Codex desktop app (published as "ChatGPT" by OpenAI)
const CODEX_STORE_ID = '9PLM9XGG6VKS';

/**
 * Check if winget is available on this system.
 */
function checkWinget() {
  return new Promise((resolve) => {
    execFile('winget', ['--version'], { timeout: 5000 }, (err, stdout) => {
      resolve(!err && stdout.trim().length > 0);
    });
  });
}

/**
 * Success patterns for both English and Chinese winget output.
 */
var SUCCESS_PATTERNS = [
  'already installed',
  'no available upgrade',
  'already on the latest',
  'installed package was found',
  'successfully installed',
  '找到已安装的现有包',
  '找不到可用的升级',
  '已成功安装',
  '已安装的包'
];

function isAlreadyInstalledLine(text) {
  var lower = (text || '').toLowerCase();
  for (var i = 0; i < SUCCESS_PATTERNS.length; i++) {
    if (lower.indexOf(SUCCESS_PATTERNS[i].toLowerCase()) >= 0) return true;
  }
  return false;
}

/**
 * Run a winget install command with a hard timeout.
 *
 * Args is the full winget argument array including source selection.
 * This is used for BOTH winget source (Node.js) and msstore source (Codex).
 */
function wingetRun(args, progressCb, timeoutMs) {
  timeoutMs = timeoutMs || 120000;

  return new Promise((resolve) => {
    var child = spawn('winget', args, {
      windowsHide: false,
      shell: true
    });

    var output = '';
    var resolved = false;

    function done(result) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      resolve(result);
    }

    var timer = setTimeout(function() {
      progressCb({ type: 'output', message: '操作超时，正在回退...' });
      done({ success: false, output: output + '\n[timeout]', code: -1 });
    }, timeoutMs);

    function processText(text) {
      output += text;
      var parts = text.split(/[\r\n]+/);
      for (var i = 0; i < parts.length; i++) {
        var line = parts[i].trim();
        if (!line) continue;
        if (/^[=\-\|\/\\>%\s\d.]+$/.test(line)) continue;
        progressCb({ type: 'output', message: line });
      }
    }

    child.stdout.on('data', function(data) { processText(data.toString()); });
    child.stderr.on('data', function(data) { processText(data.toString()); });

    child.on('close', function(code) {
      // 0 = success, -1978335189 = already installed (EN), -1978335142 = no upgrade
      if (code === 0) {
        done({ success: true, output: output, code: code });
      } else if (isAlreadyInstalledLine(output)) {
        done({ success: true, output: output, code: code });
      } else {
        done({ success: false, output: output, code: code });
      }
    });

    child.on('error', function() {
      done({ success: false, output: 'Failed to launch winget', code: -1 });
    });
  });
}

/**
 * Install Node.js LTS via winget (winget source).
 */
async function installNode(progressCb) {
  var nodeInfo = detector.detectNode();
  if (nodeInfo.installed) {
    progressCb({ type: 'output', message: 'Node.js ' + nodeInfo.version + ' \u5df2\u5b89\u88c5\uff0c\u8df3\u8fc7' });
    progressCb({ type: 'done', message: 'Node.js \u5df2\u5b89\u88c5' });
    return { success: true, message: 'Node.js already installed: ' + nodeInfo.version };
  }

  var hasWinget = await checkWinget();
  if (!hasWinget) {
    progressCb({ type: 'fallback', url: 'https://npmmirror.com/mirrors/node/' });
    return { success: false, message: 'winget \u4e0d\u53ef\u7528\uff0c\u6b63\u5728\u6253\u5f00\u56fd\u5185\u955c\u50cf' };
  }

  progressCb({ type: 'status', message: '\u6b63\u5728\u901a\u8fc7 winget \u5b89\u88c5 Node.js...' });
  var result = await wingetRun([
    'install',
    '--id', 'OpenJS.NodeJS.LTS',
    '--source', 'winget',
    '--accept-source-agreements',
    '--accept-package-agreements',
    '--disable-interactivity'
  ], progressCb);

  if (result.success) {
    progressCb({ type: 'done', message: 'Node.js \u5b89\u88c5\u6210\u529f' });
  } else {
    progressCb({ type: 'fallback', url: 'https://npmmirror.com/mirrors/node/' });
  }

  return result;
}

/**
 * Install Codex DESKTOP app.
 *
 * IMPORTANT: The winget source's "OpenAI.Codex" is the Codex CLI, NOT the
 * desktop app. We must use the msstore source with Store ID 9PLM9XGG6VKS
 * (published as "ChatGPT" by OpenAI) to get the desktop app.
 *
 * Detection: Get-AppxPackage -Name 'OpenAI.Codex' finds only the desktop
 * MSIX package. The CLI is a portable zip, not an AppxPackage.
 */
async function installCodex(progressCb) {
  // Pre-check: is the DESKTOP app already installed?
  var codexInfo = detector.detectCodex();
  if (codexInfo.installed) {
    progressCb({ type: 'output', message: 'Codex \u684c\u9762\u7248\u5df2\u5b89\u88c5\uff08v' + (codexInfo.version || '?') + '\uff09\uff0c\u8df3\u8fc7' });
    progressCb({ type: 'done', message: 'Codex \u684c\u9762\u7248\u5df2\u5b89\u88c5' });
   return { success: true, message: 'Codex desktop already installed' };
 }

 // Method 0: try bundled Codex package if available (offline install)
 var bundledResult = await installCodexBundled(progressCb);
 if (bundledResult) {
   return bundledResult;
 }

 // Method 1: winget msstore source (uses Windows Update CDN, accessible in China)
  var hasWinget = await checkWinget();
  if (hasWinget) {
    progressCb({ type: 'status', message: '\u6b63\u5728\u901a\u8fc7\u5fae\u8f6f\u5546\u5e97\u5b89\u88c5 Codex \u684c\u9762\u7248...' });

    var result = await wingetRun([
      'install',
      '--id', CODEX_STORE_ID,
      '--source', 'msstore',
      '--accept-source-agreements',
      '--accept-package-agreements',
      '--disable-interactivity'
    ], progressCb, 300000); // 5 min timeout for the ~700MB download

    // Post-check: did it actually install?
    var recheck = detector.detectCodex();
    if (recheck.installed) {
      progressCb({ type: 'done', message: 'Codex \u684c\u9762\u7248\u5b89\u88c5\u6210\u529f' });
      return { success: true };
    }

    // winget might report success even if detection fails (needs a moment)
    if (result.success) {
      progressCb({ type: 'output', message: '\u5b89\u88c5\u62a5\u544a\u6210\u529f\uff0c\u8bf7\u70b9\u51fb\u201c\u5237\u65b0\u201d\u9a8c\u8bc1' });
      return { success: true };
    }

    progressCb({ type: 'output', message: 'winget \u5b89\u88c5\u5931\u8d25\uff0c\u5c1d\u8bd5\u6253\u5f00\u5546\u5e97...' });
  }

// Method 2: open Microsoft Store deep link for manual install
progressCb({ type: 'status', message: '\u6b63\u5728\u6253\u5f00\u5fae\u8f6f\u5546\u5e97\u5e76\u81ea\u52a8\u5b89\u88c5...' });
 try {
   var storeUrl = 'ms-windows-store://pdp/?ProductId=' + CODEX_STORE_ID;
   spawn('cmd', ['/c', 'start', '', storeUrl], {
     detached: true, stdio: 'ignore', windowsHide: false
   }).unref();

   // Auto-click the install button using Windows UI Automation
   progressCb({ type: 'output', message: '\u6b63\u5728\u81ea\u52a8\u70b9\u51fb\u5b89\u88c5\u6309\u94ae...' });
   var clickResult = await runStoreAutoClick();

   if (clickResult.clicked) {
     progressCb({ type: 'output', message: '\u5df2\u81ea\u52a8\u70b9\u51fb\u5b89\u88c5\uff0c\u7b49\u5f85\u4e0b\u8f7d\u5b8c\u6210...' });
     var installed = await waitForCodexInstall(300000, progressCb);
     if (installed) {
       progressCb({ type: 'done', message: 'Codex \u684c\u9762\u7248\u5b89\u88c5\u6210\u529f' });
       return { success: true };
     }
     progressCb({ type: 'done', message: '\u4e0b\u8f7d\u8fdb\u884c\u4e2d\uff0c\u8bf7\u7a0d\u540e\u70b9\u51fb\u201c\u5237\u65b0\u201d\u9a8c\u8bc1' });
     return { success: true };
   }

   // Auto-click failed (Store may need sign-in, or UI layout differs)
   progressCb({ type: 'done', message: '\u81ea\u52a8\u5b89\u88c5\u672a\u6210\u529f\uff0c\u8bf7\u624b\u52a8\u70b9\u51fb\u201c\u83b7\u53d6\u201d\u6309\u94ae' });
   return { success: false, message: '\u8bf7\u5728\u5fae\u8f6f\u5546\u5e97\u4e2d\u70b9\u51fb\u201c\u83b7\u53d6\u201d\u5b89\u88c5' };
 } catch (e) {
   // Store couldn't open - fall through to web page fallback
 }

 // Method 3: open web page (final fallback)
 progressCb({ type: 'fallback', url: 'https://openai.com/codex/' });
return { success: false, message: '\u8bf7\u624b\u52a8\u4e0b\u8f7d\u5b89\u88c5 Codex' };
}

// --- Bundled Codex installation (offline) ---

/**
 * Try to install Codex from a bundled package (codex-package.zip) if it exists
 * in the app's resources directory. Returns null if no bundled package exists,
 * or the install result object.
 */
async function installCodexBundled(progressCb) {
  var path = require('path');
  var fs = require('fs');
  var os = require('os');
  var resourcesPath = process.resourcesPath || path.join(__dirname, '..', 'resources');
  var zipPath = path.join(resourcesPath, 'codex-package.zip');
  if (!fs.existsSync(zipPath)) {
    return null;
  }
  progressCb({ type: 'status', message: '\u6b63\u5728\u4ece\u672c\u5730\u5b89\u88c5\u5305\u5b89\u88c5 Codex...' });
  var targetDir = path.join(os.homedir(), 'AppData', 'Local', 'eazyCodex', 'codex-desktop');
  return new Promise(function(resolve) {
    var lines = [
      "$ErrorActionPreference='Stop'",
      "$zip='" + zipPath.replace(/'/g, "''") + "'",
      "$target='" + targetDir.replace(/'/g, "''") + "'",
      "if(Test-Path $target){Remove-Item $target -Recurse -Force}",
      "New-Item -ItemType Directory -Path $target -Force|Out-Null",
      "Write-Output 'Extracting...'",
      "Expand-Archive -Path $zip -DestinationPath $target -Force",
      "$manifest=Join-Path $target 'AppxManifest.xml'",
      "if(-not(Test-Path $manifest)){Write-Output 'ERROR:ManifestNotFound';exit 1}",
      "Write-Output 'Registering Codex package...'",
      "try{",
      "  Add-AppxPackage -Register $manifest -ErrorAction Stop",
      "  Write-Output 'REGISTER_SUCCESS'",
      "}catch{",
      "  Write-Output ('REGISTER_ERROR:'+$_.Exception.Message)",
      "}"
    ];
    var encoded = Buffer.from(lines.join('\n'), 'utf16le').toString('base64');
    var child = spawn('powershell', ['-NoProfile', '-EncodedCommand', encoded], { windowsHide: false });
    var output = '';
    var done = false;
    var timer = setTimeout(function() {
      if (!done) { done = true; try { child.kill(); } catch {} resolve(null); }
    }, 300000);
    child.stdout.on('data', function(d) {
      var text = d.toString();
      output += text;
      text.split(/\r?\n/).forEach(function(line) {
        line = line.trim();
        if (line && !/^[=\-]+$/.test(line)) progressCb({ type: 'output', message: line });
      });
    });
    child.stderr.on('data', function(d) { output += d.toString(); });
    child.on('close', function() {
      if (done) return; done = true; clearTimeout(timer);
      if (output.indexOf('REGISTER_SUCCESS') >= 0) {
        progressCb({ type: 'done', message: 'Codex \u684c\u9762\u7248\u5b89\u88c5\u6210\u529f' });
        resolve({ success: true });
      } else if (output.indexOf('ERROR:ManifestNotFound') >= 0) {
        progressCb({ type: 'output', message: '\u672c\u5730\u5b89\u88c5\u5305\u6587\u4ef6\u635f\u574f\uff0c\u5c1d\u8bd5\u5546\u5e97\u4e0b\u8f7d...' });
        resolve(null);
      } else {
        var errMatch = output.match(/REGISTER_ERROR:(.*)/);
        var errMsg = errMatch ? errMatch[1] : '\u672a\u77e5\u9519\u8bef';
        progressCb({ type: 'output', message: '\u672c\u5730\u5b89\u88c5\u5931\u8d25: ' + errMsg + '\uff0c\u5c1d\u8bd5\u5546\u5e97\u4e0b\u8f7d...' });
        resolve(null);
      }
    });
    child.on('error', function() {
      if (done) return; done = true; clearTimeout(timer);
      resolve(null);
    });
  });
}

// --- Store UI Automation helpers ---

/**
 * Use PowerShell + .NET UIAutomation to find and click the Store's install
 * button ("\u83b7\u53d6"/"Get"/"Install") after the deep link opens the product page.
 * Returns { clicked: bool }.
 */
function runStoreAutoClick() {
  return new Promise(function(resolve) {
    // PowerShell script encoded as UTF-16LE Base64 for -EncodedCommand,
    // avoiding all temp-file and encoding issues.
    var lines = [
      'Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes',
      'Start-Sleep -Seconds 3',
      '$root=[System.Windows.Automation.AutomationElement]::RootElement',
      '$clicked=""',
      "$kw=@('\u83B7\u53D6','\u5B89\u88C5','Install','Get','Free','\u514D\u8D39')",
      "$sk=@('\u5DF2','Open','\u6253\u5F00','\u6B63\u5728','Download','Install\u4E2D','\u66F4\u65B0','Update','Launch','\u542F\u52A8','\u8F7D\u5165')",
      'for($i=0;$i -lt 20;$i++){',
      'if($clicked){break}',
      'Start-Sleep -Seconds 2',
      '$ws=$root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)',
      'foreach($w in $ws){',
      'if($clicked){break}',
      '$n=""',
      'try{$n=$w.Current.Name}catch{}',
      "if($n -notmatch 'Store|\u5546\u5E97'){continue}",
      'try{$w.SetFocus()}catch{}',
      'Start-Sleep -Milliseconds 500',
      '$es=$w.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)',
      'foreach($e in $es){',
      'if($clicked){break}',
      '$en=""',
      'try{$en=$e.Current.Name}catch{}',
      'if(-not $en -or $en.Length -gt 30){continue}',
      '$en=$en.Trim()',
      '$skip=$false',
      'foreach($s in $sk){if($en -like "*$s*"){$skip=$true;break}}',
      'if($skip){continue}',
      '$m=$false',
      'foreach($k in $kw){if($en -eq $k){$m=$true;break}}',
      'if(-not $m){continue}',
      'try{$p=$e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern);$p.Invoke();$clicked=$en}',
      'catch{try{$lp=$e.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern);$lp.DoDefaultAction();$clicked=$en}catch{}}',
      '}',
      '}',
      '}',
      'if($clicked){Write-Output("CLICKED:"+$clicked)}else{Write-Output"NOT_FOUND"}'
    ];
    var encoded = Buffer.from(lines.join('\n'), 'utf16le').toString('base64');
    var child = spawn('powershell', ['-NoProfile', '-EncodedCommand', encoded], { windowsHide: false });
    var output = '';
    var done = false;
    var timer = setTimeout(function() {
      if (!done) { done = true; try { child.kill(); } catch {} resolve({ clicked: false }); }
    }, 60000);
    child.stdout.on('data', function(d) { output += d; });
    child.stderr.on('data', function(d) { output += d; });
    child.on('close', function() {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ clicked: output.indexOf('CLICKED:') >= 0 });
    });
    child.on('error', function() {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ clicked: false });
    });
  });
}

/**
 * Poll for Codex desktop installation by checking Get-AppxPackage.
 * Resolves true when detected, false on timeout.
 */
function waitForCodexInstall(timeoutMs, progressCb) {
  return new Promise(function(resolve) {
    var elapsed = 0;
    function check() {
      if (detector.detectCodex().installed) { resolve(true); return; }
      elapsed += 5000;
      if (elapsed >= timeoutMs) { resolve(false); return; }
      progressCb({ type: 'output', message: '\u7b49\u5f85\u5b89\u88c5\u5b8c\u6210... (' + Math.floor(elapsed / 1000) + 's)' });
      setTimeout(check, 5000);
    }
    setTimeout(check, 3000);
  });
}

/**
 * Install a dependency by name.
 */
async function install(dependency, progressCb) {
  switch (dependency) {
    case 'node':
      return installNode(progressCb);
    case 'codex':
      return installCodex(progressCb);
    default:
      return { success: false, message: 'Unknown dependency: ' + dependency };
  }
}

module.exports = {
  install,
  installNode,
  installCodex,
  checkWinget,
  wingetRun,
  CODEX_STORE_ID
};
