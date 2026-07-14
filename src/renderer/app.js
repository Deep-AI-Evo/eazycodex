/**
 * easyCodex - Frontend logic with dependency wizard
 */

'use strict';

const $ = (id) => document.getElementById(id);

// --- State ---
var wizardData = null;
var settings = null;
var ctxUserTouched = false;

var MODEL_CTX = {
  'deepseek-v4-flash': 1000000,
  'deepseek-v4-pro': 128000
};

function formatCtx(n) {
  if (!n || n <= 0) return '';
  if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
  return String(n);
}

function updateCtxHint() {
  var model = $('modelSelect').value;
  var def = MODEL_CTX[model] || 128000;
  $('ctxHint').textContent = '默认 ' + formatCtx(def);
  if (!ctxUserTouched) {
    $('ctxInput').value = String(def);
  }
}

// --- Init ---
async function init() {
  bindEvents();
  await loadSettings();
  await refreshWizard();
  startProxyPolling();
}

// --- Dependency Wizard ---
async function refreshWizard() {
  try {
    wizardData = await window.easyCodex.checkWizard();
    updateWizardUI(wizardData);
  } catch (e) {
    console.error('Wizard check failed:', e);
  }
}

function updateWizardUI(data) {
  var allReady = data.allReady;
  var bannerOk = $('depBannerOk');
  var bannerWarn = $('depBannerWarn');
  var depList = $('depList');

  if (allReady) {
    bannerOk.style.display = 'flex';
    bannerWarn.style.display = 'none';
    var models = data.deps.find(function(d) { return d.id === 'deepseek'; });
    $('depOkDetail').textContent = models && models.detail ? '  模型: ' + models.detail : '';
    depList.classList.remove('expanded');
    bannerOk.querySelector('.dep-banner-chevron').classList.remove('expanded');
  } else {
    bannerOk.style.display = 'none';
    bannerWarn.style.display = 'flex';
    depList.classList.add('expanded');
    bannerWarn.querySelector('.dep-banner-chevron').classList.add('expanded');
  }

  for (var i = 0; i < data.deps.length; i++) {
    var dep = data.deps[i];
    var elId = 'dep' + dep.id.charAt(0).toUpperCase() + dep.id.slice(1);
    var el = $(elId);
    if (!el) continue;

    var desc = el.querySelector('.dep-desc');
    var btn = el.querySelector('.dep-btn');

    if (dep.installed) {
      el.className = 'dep-item ok';
      desc.textContent = dep.detail || '已安装';
      btn.style.display = 'none';
    } else {
      el.className = 'dep-item ' + (dep.required ? 'err' : 'warn');
      desc.textContent = dep.required ? '未安装' : '未安装（可选）';
      btn.style.display = 'block';
    }
  }

  updateLaunchButton(data);
}

function toggleDepList() {
  var depList = $('depList');
  var banners = document.querySelectorAll('.dep-banner-chevron');
  depList.classList.toggle('expanded');
  banners.forEach(function(b) {
    if (depList.classList.contains('expanded')) {
      b.classList.add('expanded');
    } else {
      b.classList.remove('expanded');
    }
  });
}

// --- Install Handler ---
async function handleInstall(dependency) {
  if (dependency === 'deepseek') {
    var configBody = $('configBody');
    if (!configBody.classList.contains('expanded')) {
      $('configToggle').click();
    }
    $('apiKeyInput').focus();
    return;
  }

  var btn = document.querySelector('[data-dep="' + dependency + '"]');
  if (!btn) return;

  btn.classList.add('installing');
  btn.disabled = true;
  var originalText = btn.textContent;
  btn.textContent = '安装中...';

  try {
    var result = await window.easyCodex.installDependency(dependency);
    if (result.success) {
      showToast('安装成功', 'success');
    } else {
      showToast(result.message || '安装失败', 'error');
    }
  } catch (e) {
    showToast('安装错误: ' + e.message, 'error');
  }

  btn.classList.remove('installing');
  btn.disabled = false;
  btn.textContent = originalText;

  await refreshWizard();
}

// --- Launch Button State ---
function updateLaunchButton(data) {
  var btn = $('launchBtn');
  var hint = $('launchHint');
  var configPanel = document.querySelector('.config-panel');
  var codexDep = data.deps.find(function(d) { return d.id === 'codex'; });
  var dsDep = data.deps.find(function(d) { return d.id === 'deepseek'; });

  // Reset highlight classes
  configPanel.classList.remove('highlight-pulse');
  hint.classList.remove('warning');

  if (!codexDep.installed) {
    btn.disabled = true;
    hint.textContent = '请先安装 Codex 桌面版，安装完成后即可启动';
    hint.classList.add('warning');
    // Auto-expand dependency list
    if (!$('depList').classList.contains('expanded')) {
      $('depBannerWarn').click();
    }
  } else if (!dsDep.installed) {
    btn.disabled = true;
    hint.textContent = '请先填写 DeepSeek API Key，然后点击启动';
    hint.classList.add('warning');
    // Highlight and auto-expand the config panel
    configPanel.classList.add('highlight-pulse');
    var configBody = $('configBody');
    var configHeader = $('configToggle');
    if (!configBody.classList.contains('expanded')) {
      configHeader.classList.add('expanded');
      configBody.classList.add('expanded');
    }
  } else {
    btn.disabled = false;
    hint.textContent = '点击启动 Codex 桌面版';
  }
}

// --- Settings ---
async function loadSettings() {
  try {
    settings = await window.easyCodex.readSettings();
    if (settings.apiKey) {
      $('apiKeyInput').value = settings.apiKey;
    }
    if (settings.model) {
      $('modelSelect').value = settings.model;
    }
    if (settings.reasoningEffort) {
      $('effortSelect').value = settings.reasoningEffort;
    }
    if (settings.contextWindow && settings.contextWindow > 0) {
      $('ctxInput').value = String(settings.contextWindow);
      ctxUserTouched = true;
    }
    updateCtxHint();
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

// --- Proxy Health ---
function startProxyPolling() {
  checkProxyHealth();
  setInterval(checkProxyHealth, 5000);
}

async function checkProxyHealth() {
  var dot = $('proxyDot');
  var text = $('proxyText');

  try {
    var resp = await fetch('http://127.0.0.1:18731/health', {
      signal: AbortSignal.timeout(3000)
    });
    if (resp.ok) {
      var data = await resp.json();
      dot.className = 'status-dot online';
      text.textContent = data.hasKey ? '代理就绪' : '等待 API Key';
    } else {
      dot.className = 'status-dot error';
      text.textContent = '代理错误';
    }
  } catch (e) {
    dot.className = 'status-dot';
    dot.style.background = 'var(--warning)';
    text.textContent = '正在启动代理...';
  }
}

// --- Actions ---
async function handleLaunch() {
  var btn = $('launchBtn');
  var hint = $('launchHint');
  var originalText = btn.querySelector('.launch-btn-text').textContent;

  btn.disabled = true;
  btn.classList.add('launching');
  btn.querySelector('.launch-btn-text').textContent = '正在启动...';
  hint.textContent = '正在打开，请稍等';

  try {
    var result = await window.easyCodex.launchCodex();
    if (result.success) {
      hint.textContent = 'Codex 桌面版已启动，请切换到 Codex 窗口';
      showToast('Codex 桌面版已启动', 'success');
      setTimeout(function() {
        btn.classList.remove('launching');
        btn.querySelector('.launch-btn-text').textContent = originalText;
        btn.disabled = false;
        hint.textContent = '点击启动 Codex 桌面版';
      }, 1500);
    } else {
      hint.textContent = result.message || '启动失败';
      showToast(result.message || '启动失败', 'error');
      btn.classList.remove('launching');
      btn.querySelector('.launch-btn-text').textContent = originalText;
      btn.disabled = false;
      hint.textContent = '点击启动 Codex 桌面版';
    }
  } catch (e) {
    showToast('错误: ' + e.message, 'error');
    btn.classList.remove('launching');
    btn.querySelector('.launch-btn-text').textContent = originalText;
    btn.disabled = false;
    hint.textContent = '点击启动 Codex 桌面版';
  }
}

async function handleSave() {
  var apiKey = $('apiKeyInput').value.trim();
  var model = $('modelSelect').value;
  var effort = $('effortSelect').value;
  var ctxRaw = $('ctxInput').value.trim();
  var ctxWindow = parseInt(ctxRaw.replace(/[^\d]/g, ''), 10) || 0;

  if (!apiKey) {
    showToast('请输入 DeepSeek API Key', 'error');
    return;
  }

  $('saveBtn').disabled = true;
  $('saveBtn').textContent = '保存中...';

 try {
   var result = await window.easyCodex.saveConfigFull(apiKey, model, effort, ctxWindow);
   if (result.success) {
      settings = { apiKey: apiKey, model: model, reasoningEffort: effort, contextWindow: ctxWindow };
      showToast('配置已保存', 'success');
      await refreshWizard();
    } else {
      showToast('保存失败: ' + (result.error || '未知错误'), 'error');
    }
  } catch (e) {
    showToast('错误: ' + e.message, 'error');
  }

  $('saveBtn').disabled = false;
  $('saveBtn').textContent = '保存';
}

async function handleTest() {
  var apiKey = $('apiKeyInput').value.trim();

  if (!apiKey) {
    showToast('请先输入 API Key', 'error');
    return;
  }

 $('testBtn').disabled = true;
 $('testBtn').textContent = '测试中...';

 try {
   var result = await window.easyCodex.testApiKey(apiKey);
   if (result.success) {
     showToast('API Key 验证通过', 'success');
   } else {
     // If network-related, auto-run diagnostic for better error info
     var msg = result.message || '';
     if (msg.indexOf('timed out') >= 0 || msg.indexOf('DNS') >= 0 || msg.indexOf('无法') >= 0 || msg.indexOf('Network') >= 0 || msg.indexOf('网络') >= 0) {
       showToast('网络错误，正在诊断...', 'error');
       var diag = await window.easyCodex.diagnoseConnection();
       if (!diag.ok) {
         var hint = diag.hint || '';
         showToast((diag.message || '连接失败') + (hint ? ' | ' + hint : ''), 'error');
         addLogEntry('[网络诊断] ' + (diag.message || '') + ' detail=' + (diag.detail || '') + ' hint=' + hint, 'error');
       } else {
         showToast('网络正常但请求超时，请重试或检查API Key', 'error');
       }
     } else {
       showToast('验证失败: ' + msg, 'error');
     }
   }
 } catch (e) {
   showToast('错误: ' + e.message, 'error');
 }

 $('testBtn').disabled = false;
 $('testBtn').textContent = '测试';
}

// --- Toast ---
var toastTimeout = null;
function showToast(message, type) {
  var toast = $('toast');
  toast.textContent = message;
  toast.className = 'toast show' + (type ? ' ' + type : '');

  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(function() {
    toast.className = 'toast';
  }, 3500);
}

// --- Logging ---
function addLogEntry(msg, level) {
  var content = $('logContent');
  var entry = document.createElement('div');
  entry.className = 'log-entry' + (level ? ' ' + level : '');
  var time = new Date().toLocaleTimeString('en-US', { hour12: false });
  entry.textContent = '[' + time + '] ' + msg;
  content.appendChild(entry);
  content.scrollTop = content.scrollHeight;

  while (content.children.length > 50) {
    content.removeChild(content.firstChild);
  }
}

// --- Event Bindings ---
function bindEvents() {
  $('launchBtn').addEventListener('click', handleLaunch);
  $('saveBtn').addEventListener('click', handleSave);
  $('testBtn').addEventListener('click', handleTest);

  $('modelSelect').addEventListener('change', function() {
    ctxUserTouched = false;
    updateCtxHint();
    ctxUserTouched = true;
  });

  $('ctxInput').addEventListener('input', function() {
    ctxUserTouched = true;
  });

  $('ctxInput').addEventListener('focus', function() {
    if (!$('ctxInput').value) {
      updateCtxHint();
    }
  });

  // Stop the config panel highlight when user interacts with the API key input
  $('apiKeyInput').addEventListener('focus', function() {
    document.querySelector('.config-panel').classList.remove('highlight-pulse');
  });
  $('apiKeyInput').addEventListener('input', function() {
    document.querySelector('.config-panel').classList.remove('highlight-pulse');
  });

  $('toggleVisibility').addEventListener('click', function() {
    var input = $('apiKeyInput');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  $('configToggle').addEventListener('click', function() {
    var header = $('configToggle');
    var body = $('configBody');
    header.classList.toggle('expanded');
    body.classList.toggle('expanded');
  });

  $('getKeyLink').addEventListener('click', function(e) {
    e.preventDefault();
    window.easyCodex.openExternal('https://platform.deepseek.com/api_keys');
  });

  $('clearLogBtn').addEventListener('click', function() {
    $('logContent').innerHTML = '';
  });

  $('depBannerOk').addEventListener('click', toggleDepList);
  $('depBannerWarn').addEventListener('click', toggleDepList);

  document.querySelectorAll('.dep-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      handleInstall(btn.dataset.dep);
    });
  });

  window.easyCodex.onInstallProgress(function(data) {
    if (data.type === 'fallback' && data.url) {
      window.easyCodex.openExternal(data.url);
    }
    if (data.message) {
      addLogEntry('[' + data.dependency + '] ' + data.message, 'info');
    }
  });

  window.easyCodex.onProxyLog(function(msg) {
    var level = msg.toLowerCase().indexOf('error') >= 0 ? 'error' : 'info';
    addLogEntry(msg, level);
  });
}

// --- Boot ---
document.addEventListener('DOMContentLoaded', init);
