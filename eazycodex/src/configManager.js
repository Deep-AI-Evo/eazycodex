/**
 * Config manager: reads/writes Codex config.toml and auth.json.
 * Preserves existing config sections (plugins, marketplaces, etc.) while
 * injecting easyCodex model provider settings.
 *
 * CRITICAL: In TOML, top-level keys MUST appear before any [section] header.
 * Once a [section] is declared, subsequent keys belong to that section.
 * This file separates top-level keys from sections and reassembles correctly.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getCodexHome } = require('./detector');

const PROXY_BASE_URL = 'http://127.0.0.1:18731/v1';

const CONTEXT_WINDOWS = {
  'deepseek-v4-flash': 1000000,
  'deepseek-v4-pro': 128000
};

function getContextWindow(model) {
  return CONTEXT_WINDOWS[model] || 128000;
}

const MANAGED_KEYS = [
  'model',
  'model_provider',
  'model_reasoning_effort',
  'disable_response_storage',
  'model_context_window'
];

const BEGIN_MARKER = '# --- easyCodex managed config (do not edit manually) ---';
const END_MARKER = '# --- end easyCodex managed config ---';

function getSettingsPath() {
  return path.join(getCodexHome(), 'eazycodex.json');
}

function readSettings() {
  try {
    const content = fs.readFileSync(getSettingsPath(), 'utf8');
    return JSON.parse(content);
  } catch {
    return { apiKey: '', model: 'deepseek-v4-pro', reasoningEffort: 'high', contextWindow: 0 };
  }
}

function writeSettings(settings) {
  const dir = getCodexHome();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), 'utf8');
}

function backupConfig() {
  const configPath = path.join(getCodexHome(), 'config.toml');
  if (!fs.existsSync(configPath)) return;
  const backupPath = path.join(getCodexHome(), 'config.toml.eazycodex-backup');
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(configPath, backupPath);
  }
}

function applyConfig(model, reasoningEffort) {
  return applyConfigWithCtx(model, reasoningEffort, 0);
}

function applyConfigWithCtx(model, reasoningEffort, contextWindow) {
  const codexHome = getCodexHome();
  if (!fs.existsSync(codexHome)) {
    fs.mkdirSync(codexHome, { recursive: true });
  }

  const configPath = path.join(codexHome, 'config.toml');
  backupConfig();

  // Read existing content
  let content = '';
  if (fs.existsSync(configPath)) {
    content = fs.readFileSync(configPath, 'utf8');
  }

  // Remove all existing easyCodex managed blocks (both top-level and section)
  const blockRegex = new RegExp(
    BEGIN_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    '[\\s\\S]*?' +
    END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    '\\s*',
    'g'
  );
  content = content.replace(blockRegex, '');

  // Remove stray managed keys anywhere in the file
  for (const key of MANAGED_KEYS) {
    content = content.replace(
      new RegExp('^\\s*' + key + '\\s*=\\s*.*$', 'gm'),
      ''
    );
  }

  // Remove cc-switch references
  content = content.replace(/^\s*model_catalog_json\s*=.*$/gm, '');

  // Remove any orphaned [model_providers.eazycodex] section
  content = content.replace(
    /\n?\[model_providers\.eazycodex\][\s\S]*?(?=\n\[|\n*$)/g,
    ''
  );

  // Clean up blank lines
  content = content.replace(/\n{3,}/g, '\n\n');

  // --- Separate top-level keys from sections ---
  // TOML rule: top-level keys are everything BEFORE the first [section] header.
  // Once a [section] appears, everything after belongs to sections.
  var lines = content.split('\n');
  var topLevelLines = [];
  var sectionLines = [];
  var seenSection = false;

  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    if (/^\s*\[/.test(ln)) {
      seenSection = true;
    }
    if (seenSection) {
      sectionLines.push(ln);
    } else {
      topLevelLines.push(ln);
    }
  }

  // Filter: keep only non-empty existing top-level keys
  var existingTopLevel = topLevelLines.filter(function(l) {
    return l.trim().length > 0;
  });

  // Clean up section content
  var sectionContent = sectionLines.join('\n').replace(/^\s+/, '').replace(/\s+$/, '');
  // Remove leading blank lines from sections
  sectionContent = sectionContent.replace(/^[\s\n]+/, '');

  // Use user-provided context window, or fall back to model default
  var ctxWindow = (contextWindow && contextWindow > 0) ? contextWindow : getContextWindow(model);

  // Build managed top-level keys block
  var managedTopLevel = [
    BEGIN_MARKER,
    'model = "' + model + '"',
    'model_provider = "eazycodex"',
    'model_reasoning_effort = "' + (reasoningEffort || 'high') + '"',
    'model_context_window = ' + ctxWindow,
    'disable_response_storage = true',
    END_MARKER
  ].join('\n');

  // Build managed section block
  var managedSection = [
    BEGIN_MARKER,
    '[model_providers.eazycodex]',
    'name = "DeepSeek (easyCodex)"',
    'base_url = "' + PROXY_BASE_URL + '"',
    'wire_api = "responses"',
    'requires_openai_auth = true',
    END_MARKER
  ].join('\n');

  // Assemble: managed top-level keys FIRST, then existing top-level keys,
  // then all sections, then our managed section at the end.
  var parts = [];

  // Top-level keys go first (managed + existing)
  parts.push(managedTopLevel);
  if (existingTopLevel.length > 0) {
    parts.push(existingTopLevel.join('\n'));
  }

  // Then all existing sections
  if (sectionContent.length > 0) {
    parts.push(sectionContent);
  }

  // Then our model_providers section at the very end
  parts.push(managedSection);

  var result = parts.filter(function(p) { return p && p.trim().length > 0; }).join('\n\n') + '\n';
  fs.writeFileSync(configPath, result, 'utf8');
}

function ensureAuth() {
  const codexHome = getCodexHome();
  if (!fs.existsSync(codexHome)) {
    fs.mkdirSync(codexHome, { recursive: true });
  }
  const authPath = path.join(codexHome, 'auth.json');
  if (fs.existsSync(authPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      if (existing.OPENAI_API_KEY && existing.OPENAI_API_KEY !== 'PROXY_MANAGED') {
        const backupPath = path.join(codexHome, 'auth.json.eazycodex-backup');
        if (!fs.existsSync(backupPath)) {
          fs.copyFileSync(authPath, backupPath);
        }
      }
    } catch {
      // Invalid JSON, will overwrite
    }
  }
  fs.writeFileSync(
    authPath,
    JSON.stringify({ OPENAI_API_KEY: 'PROXY_MANAGED' }, null, 2),
    'utf8'
  );
}

function configure(apiKey, model, reasoningEffort, contextWindow) {
  writeSettings({ apiKey, model, reasoningEffort, contextWindow: contextWindow || 0 });
  applyConfigWithCtx(model, reasoningEffort, contextWindow || 0);
  ensureAuth();
}

function isConfigured() {
  const settings = readSettings();
  return !!settings.apiKey && settings.apiKey.length > 0;
}

module.exports = {
  readSettings,
  writeSettings,
  configure,
  applyConfig,
  applyConfigWithCtx,
  ensureAuth,
  backupConfig,
  isConfigured,
  getSettingsPath,
  PROXY_BASE_URL,
  getContextWindow,
  CONTEXT_WINDOWS
};