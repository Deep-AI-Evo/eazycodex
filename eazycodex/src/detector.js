/**
 * Environment detection module.
 * Finds Node.js, Codex desktop app, and checks existing configuration.
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Run a command and return trimmed stdout, or null on failure.
 */
function tryExec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 8000 }).trim();
  } catch {
    return null;
  }
}

/**
 * Check if Node.js is installed and get its version.
 */
function detectNode() {
  const version = tryExec('node --version');
  if (version) {
    return { installed: true, version };
  }
  return { installed: false, version: null };
}

/**
 * Find the Codex DESKTOP app (MSIX/Store).
 * Uses Get-AppxPackage to find it, which is robust against version updates
 * because the package family name never changes.
 * Returns { installed: bool, path: string|null, type: 'desktop'|null, version: string|null }
 */
function detectCodex() {
  try {
    const output = execSync(
      'powershell -NoProfile -Command "Get-AppxPackage -Name \'OpenAI.Codex\' | Select-Object Version, InstallLocation | ConvertTo-Json"',
      { encoding: 'utf8', timeout: 8000 }
    ).trim();

    if (output) {
      try {
        var info = JSON.parse(output);
        return {
          installed: true,
          path: info.InstallLocation || null,
          type: 'desktop',
          version: info.Version || null
        };
      } catch {
        // JSON parse failed, but output exists so package is found
        return { installed: true, path: null, type: 'desktop', version: null };
      }
    }
  } catch {
    // PowerShell not available or package not found
  }

  return { installed: false, path: null, type: null, version: null };
}

/**
 * Get the Codex config directory (~/.codex on all platforms).
 */
function getCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/**
 * Check if auth.json exists and what it contains.
 */
function getAuthStatus() {
  const codexHome = getCodexHome();
  const authPath = path.join(codexHome, 'auth.json');
  try {
    const content = fs.readFileSync(authPath, 'utf8');
    const parsed = JSON.parse(content);
    return { exists: true, managed: parsed.OPENAI_API_KEY === 'PROXY_MANAGED' };
  } catch {
    return { exists: false, managed: false };
  }
}

/**
 * Read the current config.toml model provider settings.
 */
function getConfigModelInfo() {
  const codexHome = getCodexHome();
  const configPath = path.join(codexHome, 'config.toml');
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const modelMatch = content.match(/^model\s*=\s*"([^"]+)"/m);
    const providerMatch = content.match(/^model_provider\s*=\s*"([^"]+)"/m);
    const baseUrlMatch = content.match(/base_url\s*=\s*"(http:\/\/127\.0\.0\.1:18731[^"]*)"/);

    return {
      model: modelMatch ? modelMatch[1] : null,
      provider: providerMatch ? providerMatch[1] : null,
      usingEasyCodexProxy: !!baseUrlMatch
    };
  } catch {
    return { model: null, provider: null, usingEasyCodexProxy: false };
  }
}

/**
 * Full environment status check.
 */
function getFullStatus() {
  const nodeInfo = detectNode();
  const codexInfo = detectCodex();
  const authInfo = getAuthStatus();
  const modelInfo = getConfigModelInfo();

  return {
    node: nodeInfo,
    codex: codexInfo,
    auth: authInfo,
    config: modelInfo,
    codexHome: getCodexHome()
  };
}

module.exports = {
  detectNode,
  detectCodex,
  getCodexHome,
  getAuthStatus,
  getConfigModelInfo,
  getFullStatus,
  tryExec
};
