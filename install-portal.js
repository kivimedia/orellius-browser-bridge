#!/usr/bin/env node

// Windows-only installer for the KM BOT Portal Bridge native messaging host.
// Separate from install.js on purpose: this registers a DIFFERENT native host
// name (com.kivimedia.portal_bridge, never com.orellius.browser_bridge) so
// Chrome's per-Windows-user native-messaging lookup can never hand the portal
// extension's connectNative() call to the real Orellius host, or vice versa.
//
// Usage:
//   node install-portal.js
//
// The extension id is fixed (extension-portal/manifest.json carries a "key",
// so loadUnpacked always derives the same id regardless of folder path) -
// nothing to pass on the command line.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (os.platform() !== "win32") {
  console.error("install-portal.js is Windows-only (the portal browser runs on Ziv's PC).");
  process.exit(1);
}

const NATIVE_HOST_NAME = "com.kivimedia.portal_bridge";
// Derived once from extension-portal/manifest.json's fixed "key" field - see
// the comment above PORTAL_ALLOWED_HOSTS in background.js for how this was
// generated. Re-derive with scripts/compute-extension-id.mjs if the key ever
// changes (it must not, without also updating this).
const PORTAL_EXTENSION_ID = "epbgfhbknapmahoclnjliabnamjpjhfc";

const nativeHostPath = path.resolve(__dirname, "host", "native-host-portal.js");
if (!fs.existsSync(nativeHostPath)) {
  console.error(`native-host-portal.js not found at ${nativeHostPath}`);
  process.exit(1);
}
const wrapperPath = path.resolve(__dirname, "host", "native-host-wrapper-portal.cmd");
if (!fs.existsSync(wrapperPath)) {
  console.error(`native-host-wrapper-portal.cmd not found at ${wrapperPath}`);
  process.exit(1);
}

const manifest = {
  name: NATIVE_HOST_NAME,
  description: "KM BOT Portal Bridge - isolated native messaging host for HostGator/Cloudways/Cloudflare logins only",
  path: wrapperPath.replace(/\//g, "\\"),
  type: "stdio",
  allowed_origins: [`chrome-extension://${PORTAL_EXTENSION_ID}/`],
};

// Own manifest directory, never ~/.orellius-browser-bridge - hub.js reads
// native-messaging manifests from a fixed set of candidate paths to compute
// ALLOWED_EXTENSION_ORIGINS (see host/hub.js readAllowedExtensionOrigins()),
// and the portal's own hub (18787) has no reason to ever see Ziv's real
// extension's origin or vice versa.
const manifestDir = path.join(os.homedir(), ".portal-browser-bridge");
fs.mkdirSync(manifestDir, { recursive: true });
const manifestPath = path.join(manifestDir, `${NATIVE_HOST_NAME}.json`);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
console.log(`Manifest: ${manifestPath}`);

// Chrome only - the portal never runs in Brave/Edge/Firefox.
const regPath = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
try {
  execSync(`reg add "${regPath}" /ve /t REG_SZ /d "${manifestPath}" /f`, { stdio: "pipe" });
  console.log(`Registry key created at ${regPath}`);
} catch (err) {
  console.error(`Failed to write registry (${err.message})`);
  console.error(`Manual fix: reg add "${regPath}" /ve /t REG_SZ /d "${manifestPath}" /f`);
  process.exit(1);
}

console.log("\nDone. This registers the native host only - it does nothing until");
console.log("portal-supervisor.mjs actually launches the portal Chrome and loads");
console.log("extension-portal/ into it over the DevTools pipe.");
