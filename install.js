#!/usr/bin/env node

// Cross-platform installer for Orellius Browser Bridge native messaging host.
// Supports macOS, Linux, and Windows.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const NATIVE_HOST_NAME = "com.orellius.browser_bridge";
const FIREFOX_ADDON_ID = "orellius@kivimedia.co";
const platform = os.platform();

// Parse args. Chromium extension IDs (32-char alphanumeric) are passed
// positionally for backward compatibility. Firefox is opt-in via --firefox.
const rawArgs = process.argv.slice(2);
const wantFirefox = rawArgs.includes("--firefox");
const extensionIds = rawArgs.filter((a) => !a.startsWith("--"));

if (extensionIds.length === 0 && !wantFirefox) {
  console.error(`
❌ Error: No extension IDs provided.

Usage:
  node install.js <chromium-extension-id> [<id-2> ...]   # Chrome/Brave/Edge
  node install.js --firefox                              # Firefox only
  node install.js <chromium-id> --firefox                # Both

How to get your Chromium extension ID:
1. Open chrome://extensions (or brave://extensions, edge://extensions)
2. Enable "Developer mode" (top-right toggle)
3. Click "Load unpacked" and select the extension/ folder
4. Copy the ID shown on the extension card

Firefox uses a fixed addon ID (orellius@kivimedia.co), so no ID is needed.
The XPI must be installed first via about:debugging or AMO.
`);
  process.exit(1);
}

console.log(`🔧 Installing Orellius Browser Bridge native messaging host...`);
console.log(`   Platform: ${platform}`);
console.log(`   Extension IDs: ${extensionIds.join(", ")}\n`);

// Path to native-host.js (absolute)
const nativeHostPath = path.resolve(__dirname, "host", "native-host.js");

if (!fs.existsSync(nativeHostPath)) {
  console.error(`❌ Error: native-host.js not found at ${nativeHostPath}`);
  process.exit(1);
}

// On Windows, the OS can't directly execute a .js file from a native messaging
// manifest — it consults the .js file association, which is usually an editor
// (VS Code) and opens the file instead of running it. Point the manifest at a
// .bat wrapper that explicitly invokes node. macOS/Linux execute the .js via
// its shebang and +x bit, so they keep using the .js path directly.
const nativeHostBatPath = path.resolve(__dirname, "host", "native-host.bat");
if (platform === "win32" && !fs.existsSync(nativeHostBatPath)) {
  console.error(`❌ Error: native-host.bat not found at ${nativeHostBatPath}`);
  process.exit(1);
}
const manifestHostPath = platform === "win32" ? nativeHostBatPath : nativeHostPath;

// Build allowed_origins array (Chromium uses chrome-extension:// origins)
const allowedOrigins = extensionIds.map((id) => `chrome-extension://${id}/`);

// Chromium native messaging host manifest
const chromiumManifest = {
  name: NATIVE_HOST_NAME,
  description: "Orellius Browser Bridge - Native messaging host for browser automation",
  path: manifestHostPath,
  type: "stdio",
  allowed_origins: allowedOrigins,
};

// Firefox uses a different schema: allowed_extensions (addon IDs), not origins
const firefoxManifest = {
  name: NATIVE_HOST_NAME,
  description: "Orellius Browser Bridge - Native messaging host (Firefox)",
  path: manifestHostPath,
  type: "stdio",
  allowed_extensions: [FIREFOX_ADDON_ID],
};

// Platform-specific installation
if (platform === "win32") {
  if (extensionIds.length > 0) installWindows(chromiumManifest);
  if (wantFirefox) installWindowsFirefox(firefoxManifest);
} else if (platform === "darwin") {
  if (extensionIds.length > 0) installMacOS(chromiumManifest);
  if (wantFirefox) installMacOSFirefox(firefoxManifest);
} else if (platform === "linux") {
  if (extensionIds.length > 0) installLinux(chromiumManifest);
  if (wantFirefox) installLinuxFirefox(firefoxManifest);
} else {
  console.error(`❌ Unsupported platform: ${platform}`);
  process.exit(1);
}

console.log(`\n✅ Installation complete!`);
console.log(`\nNext steps:`);
console.log(`1. Fully restart your browser (close ALL windows)`);
console.log(`2. Reopen and verify the extension is loaded`);
console.log(`3. Register with Claude Code:`);
console.log(`   claude mcp add orellius-browser-bridge -- node "${path.resolve(__dirname, 'host', 'mcp-server.js')}"`);

// ===== macOS Installation =====
function installMacOS(manifest) {
  const browsers = [
    {
      name: "Chrome",
      dir: path.join(os.homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts"),
    },
    {
      name: "Brave",
      dir: path.join(os.homedir(), "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"),
    },
    {
      name: "Edge",
      dir: path.join(os.homedir(), "Library/Application Support/Microsoft Edge/NativeMessagingHosts"),
    },
  ];

  for (const browser of browsers) {
    try {
      fs.mkdirSync(browser.dir, { recursive: true });
      const manifestPath = path.join(browser.dir, `${NATIVE_HOST_NAME}.json`);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
      console.log(`✅ ${browser.name}: ${manifestPath}`);
    } catch (err) {
      console.warn(`⚠️  ${browser.name}: Failed (${err.message})`);
    }
  }
}

// ===== Linux Installation =====
function installLinux(manifest) {
  const browsers = [
    {
      name: "Chrome",
      dir: path.join(os.homedir(), ".config/google-chrome/NativeMessagingHosts"),
    },
    {
      name: "Brave",
      dir: path.join(os.homedir(), ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts"),
    },
    {
      name: "Edge",
      dir: path.join(os.homedir(), ".config/microsoft-edge/NativeMessagingHosts"),
    },
  ];

  for (const browser of browsers) {
    try {
      fs.mkdirSync(browser.dir, { recursive: true });
      const manifestPath = path.join(browser.dir, `${NATIVE_HOST_NAME}.json`);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
      console.log(`✅ ${browser.name}: ${manifestPath}`);
    } catch (err) {
      console.warn(`⚠️  ${browser.name}: Failed (${err.message})`);
    }
  }
}

// ===== Windows Installation =====
function installWindows(manifest) {
  const browsers = [
    {
      name: "Chrome",
      regPath: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\" + NATIVE_HOST_NAME,
    },
    {
      name: "Brave",
      regPath: "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\" + NATIVE_HOST_NAME,
    },
    {
      name: "Edge",
      regPath: "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\" + NATIVE_HOST_NAME,
    },
  ];

  // Write manifest to a temp location (Windows needs a file path in registry)
  const manifestDir = path.join(os.homedir(), ".orellius-browser-bridge");
  fs.mkdirSync(manifestDir, { recursive: true });
  const manifestPath = path.join(manifestDir, `${NATIVE_HOST_NAME}.json`);
  
  // Fix path separators for Windows
  const winManifest = {
    ...manifest,
    path: manifest.path.replace(/\//g, "\\"),
  };
  
  fs.writeFileSync(manifestPath, JSON.stringify(winManifest, null, 2), "utf-8");
  console.log(`📄 Manifest written to: ${manifestPath}\n`);

  for (const browser of browsers) {
    try {
      // Create registry key and set default value to manifest path
      execSync(`reg add "${browser.regPath}" /ve /t REG_SZ /d "${manifestPath}" /f`, {
        stdio: "pipe",
      });
      console.log(`✅ ${browser.name}: Registry key created at ${browser.regPath}`);
    } catch (err) {
      console.warn(`⚠️  ${browser.name}: Failed to write registry (${err.message})`);
      console.warn(`   Manual fix: Run this in PowerShell as Admin:`);
      console.warn(`   reg add "${browser.regPath}" /ve /t REG_SZ /d "${manifestPath}" /f\n`);
    }
  }

  console.log(`\n💡 Tip: If installation failed, you may need to run as Administrator.`);
  console.log(`   Right-click Command Prompt → "Run as administrator" → retry`);
}

// ===== Firefox - macOS =====
function installMacOSFirefox(manifest) {
  const dir = path.join(os.homedir(), "Library/Application Support/Mozilla/NativeMessagingHosts");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const manifestPath = path.join(dir, NATIVE_HOST_NAME + ".json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
    console.log("Firefox: " + manifestPath);
  } catch (err) {
    console.warn("Firefox: Failed (" + err.message + ")");
  }
}

// ===== Firefox - Linux =====
function installLinuxFirefox(manifest) {
  const dir = path.join(os.homedir(), ".mozilla/native-messaging-hosts");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const manifestPath = path.join(dir, NATIVE_HOST_NAME + ".json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
    console.log("Firefox: " + manifestPath);
  } catch (err) {
    console.warn("Firefox: Failed (" + err.message + ")");
  }
}

// ===== Firefox - Windows =====
function installWindowsFirefox(manifest) {
  const regPath = "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\" + NATIVE_HOST_NAME;
  const manifestDir = path.join(os.homedir(), ".orellius-browser-bridge");
  fs.mkdirSync(manifestDir, { recursive: true });
  const manifestPath = path.join(manifestDir, NATIVE_HOST_NAME + "-firefox.json");
  const winManifest = { ...manifest, path: manifest.path.replace(/\//g, "\\") };
  fs.writeFileSync(manifestPath, JSON.stringify(winManifest, null, 2), "utf-8");
  console.log("Firefox manifest written to: " + manifestPath);

  // execFileSync with explicit arg array - no shell, no injection surface.
  try {
    execFileSync("reg", ["add", regPath, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], { stdio: "pipe" });
    console.log("Firefox: Registry key created at " + regPath);
  } catch (err) {
    console.warn("Firefox: Failed to write registry (" + err.message + ")");
    console.warn("   Manual fix: reg add \"" + regPath + "\" /ve /t REG_SZ /d \"" + manifestPath + "\" /f");
  }
}
