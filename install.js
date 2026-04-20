#!/usr/bin/env node

// Cross-platform installer for Orellius Browser Bridge native messaging host.
// Supports macOS, Linux, and Windows.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const NATIVE_HOST_NAME = "com.orellius.browser_bridge";
const platform = os.platform();

// Get extension IDs from command line args
const extensionIds = process.argv.slice(2);

if (extensionIds.length === 0) {
  console.error(`
❌ Error: No extension IDs provided.

Usage:
  node install.js <extension-id> [<extension-id-2> ...]

How to get your extension ID:
1. Open chrome://extensions (or brave://extensions, edge://extensions)
2. Enable "Developer mode" (top-right toggle)
3. Click "Load unpacked" and select the extension/ folder
4. Copy the ID shown on the extension card (e.g., "abcdefghijklmnopqrstuvwxyz123456")
5. Run: node install.js <that-id>

For multiple browsers, pass all IDs:
  node install.js <chrome-id> <brave-id> <edge-id>
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

// Build allowed_origins array
const allowedOrigins = extensionIds.map((id) => `chrome-extension://${id}/`);

// Native messaging host manifest
const manifest = {
  name: NATIVE_HOST_NAME,
  description: "Orellius Browser Bridge - Native messaging host for browser automation",
  path: nativeHostPath,
  type: "stdio",
  allowed_origins: allowedOrigins,
};

// Platform-specific installation
if (platform === "win32") {
  installWindows(manifest);
} else if (platform === "darwin") {
  installMacOS(manifest);
} else if (platform === "linux") {
  installLinux(manifest);
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
