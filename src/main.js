/**
 * easyCodex - Main Electron process
 * Manages the proxy server, IPC handlers, and window lifecycle.
 */

'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const https = require('https');

const proxy = require('./proxy');
const detector = require('./detector');
const configManager = require('./configManager');
const launcher = require('./launcher');
const installer = require('./installer');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 820,
    minWidth: 600,
    minHeight: 700,
    resizable: true,
    maximizable: false,
    frame: true,
    title: 'easyCodex',
    backgroundColor: '#0a0e1a',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- IPC Handlers ---

ipcMain.handle('get-status', async () => {
  return detector.getFullStatus();
});

ipcMain.handle('check-wizard', async () => {
  const status = detector.getFullStatus();
  const settings = configManager.readSettings();
  const deps = [
    { id: 'node', name: 'Node.js', required: false, installed: status.node.installed, detail: status.node.version },
    { id: 'codex', name: 'Codex Desktop', required: true, installed: status.codex.installed, detail: status.codex.type },
    { id: 'deepseek', name: 'DeepSeek API Key', required: true, installed: !!settings.apiKey, detail: settings.model || '' }
  ];
  const allReady = deps.filter(d => d.required).every(d => d.installed);
  return { deps, allReady };
});

ipcMain.handle('install-dependency', async (event, dependency) => {
  const result = await installer.install(dependency, (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('install-progress', { dependency, ...progress });
    }
  });
  return result;
});

ipcMain.handle('read-settings', async () => {
  return configManager.readSettings();
});

ipcMain.handle('save-config', async (event, apiKey, model, reasoningEffort) => {
  try {
    configManager.configure(apiKey, model, reasoningEffort, null);
    proxy.setApiKey(apiKey);
    proxy.setModel(model);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('save-config-full', async (event, apiKey, model, reasoningEffort, contextWindow) => {
  try {
    configManager.configure(apiKey, model, reasoningEffort, contextWindow);
    proxy.setApiKey(apiKey);
    proxy.setModel(model);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('launch-codex', async () => {
  // Ensure config and proxy are ready before launching
  const settings = configManager.readSettings();
  if (!settings.apiKey) {
    return { success: false, message: '请先配置 DeepSeek API Key' };
  }

// Make sure config is written
 configManager.configure(settings.apiKey, settings.model, settings.reasoningEffort, settings.contextWindow);
proxy.setApiKey(settings.apiKey);
 proxy.setModel(settings.model);

 // Ensure proxy is running
  if (!proxy.isRunning()) {
    try {
      await proxy.start();
    } catch (e) {
      return { success: false, message: '启动代理失败: ' + e.message };
    }
  }

 return launcher.launch();
});

// Connectivity diagnostic: check DNS + TCP connect to DeepSeek API
ipcMain.handle('diagnose-connection', async () => {
  const dns = require('dns');
  const net = require('net');
  const dnsResult = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'DNS timeout' }), 8000);
    dns.resolve4('api.deepseek.com', (err, addresses) => {
      clearTimeout(timer);
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true, ips: addresses });
    });
  });
  if (!dnsResult.ok) {
    return { ok: false, step: 'dns', message: 'DNS\u89e3\u6790\u5931\u8d25', detail: dnsResult.error, hint: '\u8bf7\u68c0\u67e5\u7f51\u7edc\uff0c\u6216\u5c1d\u8bd5DNS\u8bbe\u4e3a 223.5.5.5' };
  }
  const ip = dnsResult.ips[0];
  const connectResult = await new Promise((resolve) => {
    const sock = net.createConnection(443, ip, () => { sock.destroy(); resolve({ ok: true }); });
    sock.on('error', (e) => resolve({ ok: false, error: e.message }));
    sock.setTimeout(8000, () => { sock.destroy(); resolve({ ok: false, error: 'TCP timeout' }); });
  });
  if (!connectResult.ok) {
    return { ok: false, step: 'tcp', ip: ip, message: '\u65e0\u6cd5\u8fde\u63a5 DeepSeek (' + ip + ':443)', detail: connectResult.error, hint: '\u53ef\u80fd\u662f\u9632\u706b\u5899\u62e6\u622a\uff0c\u8bf7\u5c1d\u8bd5\u5173\u95edVPN/\u4ee3\u7406\u540e\u91cd\u8bd5' };
  }
  return { ok: true, ip: ip, message: '\u7f51\u7edc\u8fde\u63a5\u6b63\u5e38 (' + ip + ')' };
});

ipcMain.handle('test-api-key', async (event, apiKey) => {
  const dns = require('dns');
  const dnsOk = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 8000);
    dns.resolve4('api.deepseek.com', (err) => { clearTimeout(t); resolve(!err); });
  });
  if (!dnsOk) {
    return { success: false, message: '\u65e0\u6cd5\u89e3\u6790 api.deepseek.com\uff0c\u8bf7\u68c0\u67e5DNS\u6216\u7f51\u7edc' };
  }
  return new Promise((resolve) => {
    if (!apiKey || apiKey.length < 10) {
      resolve({ success: false, message: 'API Key 长度不足' });
      return;
    }

    const postData = JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 5,
      stream: false
    });

   const req = https.request({
     hostname: 'api.deepseek.com',
     port: 443,
     path: '/v1/chat/completions',
     method: 'POST',
     headers: {
       'Content-Type': 'application/json',
       'Authorization': `Bearer ${apiKey}`,
       'Content-Length': Buffer.byteLength(postData)
     },
     timeout: 30000,
     family: 4
   }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve({ success: true, message: 'API Key 有效' });
        } else {
          try {
            const parsed = JSON.parse(body);
            const errMsg = parsed.error?.message || `HTTP ${res.statusCode}`;
            resolve({ success: false, message: errMsg });
          } catch {
            resolve({ success: false, message: `HTTP ${res.statusCode}` });
          }
        }
      });
    });

    req.on('error', (e) => {
      resolve({ success: false, message: '网络错误: ' + e.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, message: '请求超时' });
    });

    req.write(postData);
    req.end();
  });
});

ipcMain.handle('open-external', async (event, url) => {
  shell.openExternal(url);
  return { success: true };
});

// --- App Lifecycle ---

const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    createWindow();

    // Start the proxy server
    proxy.setLogCallback((msg) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('proxy-log', msg);
      }
    });

   // Load saved API key into the proxy
   const settings = configManager.readSettings();
   if (settings.apiKey) {
     proxy.setApiKey(settings.apiKey);
   }
   if (settings.model) {
     proxy.setModel(settings.model);
   }

   try {
      await proxy.start();
      console.log('Proxy started on port', proxy.PROXY_PORT);
    } catch (e) {
      console.error('Failed to start proxy:', e.message);
    }
  });

  app.on('window-all-closed', () => {
    proxy.stop();
    app.quit();
  });

  app.on('before-quit', async () => {
    await proxy.stop();
  });
}
