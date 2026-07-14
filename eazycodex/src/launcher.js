/**
 * Codex launcher: launches the Codex DESKTOP app (MSIX/Store).
 *
 * Uses the App User Model ID (AUMID) to launch via shell:AppsFolder.
 * This is the correct way to launch MSIX desktop apps, and it is
 * robust against version updates because the package family name
 * (e.g. OpenAI.Codex_2p2nqsd0c76g0) never changes between versions.
 */

'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Find the Codex desktop app AUMID via Get-AppxPackage.
 * Returns the AUMID string, or null if not found.
 */
function findCodexAumid() {
  try {
    const output = execSync(
      'powershell -NoProfile -Command "Get-AppxPackage -Name \'OpenAI.Codex\' | Select-Object -ExpandProperty PackageFamilyName"',
      { encoding: 'utf8', timeout: 8000 }
    ).trim();
    if (output) {
      // AUMID = PackageFamilyName + "!" + ApplicationId
      // The Application Id is "App" per the AppxManifest.xml
      return output + '!App';
    }
  } catch {}
  return null;
}

/**
 * Find the Codex desktop app via the AppxManifest.
 * Returns the package install location, or null.
 */
function findCodexInstall() {
  try {
    const output = execSync(
      'powershell -NoProfile -Command "Get-AppxPackage -Name \'OpenAI.Codex\' | Select-Object -ExpandProperty InstallLocation"',
      { encoding: 'utf8', timeout: 8000 }
    ).trim();
    if (output && fs.existsSync(output)) {
      return output;
    }
  } catch {}
  return null;
}

/**
 * Check if the Codex desktop app is installed.
 */
function isCodexInstalled() {
  return findCodexAumid() !== null;
}

/**
 * Launch the Codex desktop app via AUMID.
 * Returns { success: bool, message: string }
 */
function launch() {
  const aumid = findCodexAumid();
  if (!aumid) {
    return {
      success: false,
      message: 'Codex desktop app not found. Please install Codex first.'
    };
  }

  try {
    // Launch via shell:AppsFolder - the standard way to start MSIX apps
    const child = spawn('explorer.exe', ['shell:AppsFolder\\' + aumid], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();

    return { success: true, message: 'Codex desktop app launched', aumid: aumid };
  } catch (e) {
    return { success: false, message: 'Failed to launch: ' + e.message };
  }
}

module.exports = { findCodexAumid, findCodexInstall, isCodexInstalled, launch };
