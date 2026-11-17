#!/usr/bin/env node

/**
 * Postinstall script for agent-browser
 * 
 * Uses a platform binary already present in this package. Browser binaries ship in
 * the separately signed @unbrowse/browser-<platform> packages.
 * On global installs, patches npm's bin entry to use the native binary directly:
 * - Windows: Overwrites .cmd/.ps1 shims
 * - Mac/Linux: Replaces symlink to point to native binary
 */

import { existsSync, mkdirSync, chmodSync, writeFileSync, symlinkSync, lstatSync, realpathSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { platform, arch } from 'os';
import { execSync, spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const binDir = join(projectRoot, 'bin');

// Detect if the system uses musl libc (e.g. Alpine Linux)
function isMusl() {
  if (platform() !== 'linux') return false;
  try {
    const result = execSync('ldd --version 2>&1 || true', { encoding: 'utf8' });
    return result.toLowerCase().includes('musl');
  } catch {
    return existsSync('/lib/ld-musl-x86_64.so.1') || existsSync('/lib/ld-musl-aarch64.so.1');
  }
}

// Platform detection
const osKey = platform() === 'linux' && isMusl() ? 'linux-musl' : platform();
// Windows ARM64 falls back to x64 binary (no native ARM64 build available).
// x64 binaries run via Windows' built-in emulation on ARM64.
const effectiveArch = platform() === 'win32' && arch() === 'arm64' ? 'x64' : arch();
const platformKey = `${osKey}-${effectiveArch}`;
const ext = platform() === 'win32' ? '.exe' : '';
const binaryName = `agent-browser-${platformKey}${ext}`;
const binaryPath = join(binDir, binaryName);

/** Whether the packaged native binary runs. */
function runs(path) {
  try {
    // npm doesn't preserve the execute bit
    if (platform() !== 'win32') {
      chmodSync(path, 0o755);
    }
    return spawnSync(path, ['--version'], { stdio: 'ignore', timeout: 30_000 }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Detect which package manager ran this postinstall and write a marker file
 * next to the binary so `agent-browser upgrade` can use the correct one
 * without fragile path heuristics or slow subprocess probing.
 *
 * npm_config_user_agent is set by npm/pnpm/yarn/bun during lifecycle scripts,
 * e.g. "pnpm/8.10.0 node/v20.10.0 linux x64"
 */
function writeInstallMethod() {
  const ua = process.env.npm_config_user_agent || '';
  let method = '';
  if (ua.startsWith('pnpm/')) method = 'pnpm';
  else if (ua.startsWith('yarn/')) method = 'yarn';
  else if (ua.startsWith('bun/')) method = 'bun';
  else if (ua.startsWith('npm/')) method = 'npm';

  if (method) {
    try {
      writeFileSync(join(binDir, '.install-method'), method);
    } catch {
      // Non-critical — upgrade will fall back to heuristics
    }
  }
}

async function main() {
  // Check if a working binary is already here
  if (existsSync(binaryPath) && runs(binaryPath)) {
    console.log(`✓ Native binary ready: ${binaryName}`);

    writeInstallMethod();

    // On global installs, fix npm's bin entry to use native binary directly
    await fixGlobalInstallBin();

    showInstallReminder();
    return;
  }

  // Ensure bin directory exists
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
  }

  return noBinary(`No ${binaryName} is included in this package. Install the signed @unbrowse/browser-${platformKey} package or build it locally.`);
}

/** Says why there is no native binary and how to build one. The global command stays on the JS wrapper, which says what is missing. */
function noBinary(message) {
  console.log(message);
  console.log('');
  console.log('To build the native binary locally:');
  console.log('  1. Install Rust: https://rustup.rs');
  console.log('  2. Run: npm run build:native');

  writeInstallMethod();
  showInstallReminder();
}

function findSystemChrome() {
  const os = platform();
  if (os === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    return candidates.find(p => existsSync(p)) || null;
  }
  if (os === 'linux') {
    const names = ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium'];
    for (const name of names) {
      try {
        const result = execSync(`which ${name} 2>/dev/null`, { encoding: 'utf8' }).trim();
        if (result) return result;
      } catch {}
    }
    return null;
  }
  if (os === 'win32') {
    const candidates = [
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
    return candidates.find(p => p && existsSync(p)) || null;
  }
  return null;
}

function showInstallReminder() {
  const systemChrome = findSystemChrome();
  if (systemChrome) {
    console.log('');
    console.log(`  ✓ System Chrome found: ${systemChrome}`);
    console.log('    agent-browser will use it automatically.');
    console.log('');
    return;
  }

  console.log('');
  console.log('  ⚠ No Chrome installation detected.');
  console.log('  If you plan to use a local browser, run:');
  console.log('');
  console.log('    agent-browser install');
  if (platform() === 'linux') {
    console.log('');
    console.log('  On Linux, include system dependencies with:');
    console.log('');
    console.log('    agent-browser install --with-deps');
  }
  console.log('');
  console.log('  You can skip this if you use --cdp, --provider, --engine, or --executable-path.');
  console.log('');
}

/**
 * Unbrowse fork: whether this package is the global one. A project's install
 * runs this script too, and the global command must not move into that
 * project's node_modules, where it breaks when the project goes.
 */
function isGlobalInstall() {
  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf8' }).trim();
    const modules = platform() === 'win32' ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules');
    return realpathSync(join(modules, 'agent-browser')) === realpathSync(projectRoot);
  } catch {
    return false; // npm not available, or no global package
  }
}

/**
 * Fix npm's bin entry on global installs to use the native binary directly.
 * This provides zero-overhead CLI execution for global installs.
 */
async function fixGlobalInstallBin() {
  if (!isGlobalInstall()) {
    return;
  }
  if (platform() === 'win32') {
    await fixWindowsShims();
  } else {
    await fixUnixSymlink();
  }
}

/**
 * Fix npm symlink on Mac/Linux global installs.
 * Replace the symlink to the JS wrapper with a symlink to the native binary.
 */
async function fixUnixSymlink() {
  // Get npm's global bin directory (npm prefix -g + /bin)
  let npmBinDir;
  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf8' }).trim();
    npmBinDir = join(prefix, 'bin');
  } catch {
    return; // npm not available
  }

  const symlinkPath = join(npmBinDir, 'agent-browser');

  // Check if symlink exists (indicates global install)
  try {
    const stat = lstatSync(symlinkPath);
    if (!stat.isSymbolicLink()) {
      return; // Not a symlink, don't touch it
    }
  } catch {
    return; // Symlink doesn't exist, not a global install
  }

  // Replace symlink to point directly to native binary
  try {
    unlinkSync(symlinkPath);
    symlinkSync(binaryPath, symlinkPath);
    console.log('✓ Optimized: symlink points to native binary (zero overhead)');
  } catch (err) {
    // Permission error or other issue - not critical, JS wrapper still works
    console.log(`⚠ Could not optimize symlink: ${err.message}`);
    console.log('  CLI will work via Node.js wrapper (slightly slower startup)');
  }
}

/**
 * Fix npm-generated shims on Windows global installs.
 * npm generates shims that try to run /bin/sh, which doesn't exist on Windows.
 * We overwrite them to invoke the native .exe directly.
 */
async function fixWindowsShims() {
  let npmBinDir;
  try {
    npmBinDir = execSync('npm prefix -g', { encoding: 'utf8' }).trim();
  } catch {
    return;
  }

  const cmdShim = join(npmBinDir, 'agent-browser.cmd');
  const ps1Shim = join(npmBinDir, 'agent-browser.ps1');

  // Shims may not exist yet during postinstall (npm creates them after
  // lifecycle scripts). If missing, fall back: the JS wrapper at
  // bin/agent-browser.js handles Windows correctly via child_process.spawn.
  if (!existsSync(cmdShim)) {
    return;
  }

  // Detect architecture so ARM64 Windows is handled correctly
  // (falls back to x64 binary — see platform detection above)
  const cpuArch = effectiveArch;
  const relativeBinaryPath = `node_modules\\agent-browser\\bin\\agent-browser-win32-${cpuArch}.exe`;
  const absoluteBinaryPath = join(npmBinDir, relativeBinaryPath);

  // Only rewrite shims if the native binary actually exists
  if (!existsSync(absoluteBinaryPath)) {
    return;
  }

  try {
    const cmdContent = `@ECHO off\r\n"%~dp0${relativeBinaryPath}" %*\r\n`;
    writeFileSync(cmdShim, cmdContent);

    const ps1Content = `#!/usr/bin/env pwsh\r\n$basedir = Split-Path $MyInvocation.MyCommand.Definition -Parent\r\n& "$basedir\\${relativeBinaryPath}" $args\r\nexit $LASTEXITCODE\r\n`;
    writeFileSync(ps1Shim, ps1Content);

    console.log('✓ Optimized: shims point to native binary (zero overhead)');
  } catch (err) {
    console.log(`⚠ Could not optimize shims: ${err.message}`);
    console.log('  CLI will work via Node.js wrapper (slightly slower startup)');
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
