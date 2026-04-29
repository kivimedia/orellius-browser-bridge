#!/usr/bin/env node
// Build the Firefox XPI from extension-firefox/.
//
// Output: dist/orellius-firefox-<version>.xpi
//
// Usage:
//   node scripts/build-firefox.js          # build unsigned XPI (about:debugging-loadable)
//   node scripts/build-firefox.js --sign   # build + sign via web-ext for AMO unlisted
//
// The unsigned XPI is loadable via about:debugging > "Load Temporary Add-on"
// for development. For permanent install on stock Firefox, run with --sign
// (requires AMO API credentials in env: WEB_EXT_API_KEY, WEB_EXT_API_SECRET).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import zlib from "node:zlib";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const SOURCE_DIR = path.join(ROOT, "extension-firefox");
const DIST_DIR = path.join(ROOT, "dist");

if (!fs.existsSync(SOURCE_DIR)) {
  console.error(`Source dir not found: ${SOURCE_DIR}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, "manifest.json"), "utf-8"));
const version = manifest.version;
const xpiName = `orellius-firefox-${version}.xpi`;
const xpiPath = path.join(DIST_DIR, xpiName);

fs.mkdirSync(DIST_DIR, { recursive: true });

const wantSign = process.argv.includes("--sign");

if (wantSign) {
  if (!process.env.WEB_EXT_API_KEY || !process.env.WEB_EXT_API_SECRET) {
    console.error("WEB_EXT_API_KEY and WEB_EXT_API_SECRET must be set in env to sign.");
    console.error("Get them from https://addons.mozilla.org/en-US/developers/addon/api/key/");
    process.exit(1);
  }
  console.log("Signing via web-ext (this submits to AMO unlisted, expect ~60s)...");
  execFileSync("npx", [
    "web-ext", "sign",
    "--source-dir", SOURCE_DIR,
    "--artifacts-dir", DIST_DIR,
    "--channel", "unlisted",
    "--api-key", process.env.WEB_EXT_API_KEY,
    "--api-secret", process.env.WEB_EXT_API_SECRET,
  ], { stdio: "inherit" });
  console.log(`Signed XPI(s) in ${DIST_DIR}`);
  process.exit(0);
}

// Unsigned: just zip the directory into a .xpi (XPI === zip).
// Stream-compress to avoid loading everything into memory.
//
// We avoid the optional `archiver` dep - Node's built-in `zlib` + a tiny
// inline PKZIP writer keeps the build self-contained.

console.log(`Packing ${SOURCE_DIR} -> ${xpiPath} (unsigned)`);

// Walk the source dir and collect entries.
function walk(dir, base = "") {
  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      entries.push(...walk(full, rel));
    } else {
      entries.push({ name: rel.replace(/\\/g, "/"), path: full, mtime: stat.mtime });
    }
  }
  return entries;
}

const files = walk(SOURCE_DIR);

// Minimal PKZIP writer - writes uncompressed entries (stored). Modern Firefox
// accepts XPIs with stored entries, and XPI signing repacks anyway.
const out = createWriteStream(xpiPath);
const records = [];
let offset = 0;

function writeBuf(buf) {
  out.write(buf);
  offset += buf.length;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  const t = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const dt = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time: t & 0xffff, date: dt & 0xffff };
}

for (const f of files) {
  const data = fs.readFileSync(f.path);
  const nameBuf = Buffer.from(f.name, "utf-8");
  const crc = crc32(data);
  const { time, date } = dosTime(f.mtime);
  const localOffset = offset;

  const localHeader = Buffer.alloc(30 + nameBuf.length);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);            // version needed
  localHeader.writeUInt16LE(0, 6);             // flags
  localHeader.writeUInt16LE(0, 8);             // method = stored
  localHeader.writeUInt16LE(time, 10);
  localHeader.writeUInt16LE(date, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(data.length, 18);  // compressed
  localHeader.writeUInt32LE(data.length, 22);  // uncompressed
  localHeader.writeUInt16LE(nameBuf.length, 26);
  localHeader.writeUInt16LE(0, 28);            // extra
  nameBuf.copy(localHeader, 30);

  writeBuf(localHeader);
  writeBuf(data);

  records.push({ name: nameBuf, crc, size: data.length, time, date, localOffset });
}

// Central directory
const centralStart = offset;
for (const r of records) {
  const central = Buffer.alloc(46 + r.name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);  // version made by
  central.writeUInt16LE(20, 6);  // version needed
  central.writeUInt16LE(0, 8);   // flags
  central.writeUInt16LE(0, 10);  // method = stored
  central.writeUInt16LE(r.time, 12);
  central.writeUInt16LE(r.date, 14);
  central.writeUInt32LE(r.crc, 16);
  central.writeUInt32LE(r.size, 20);
  central.writeUInt32LE(r.size, 24);
  central.writeUInt16LE(r.name.length, 28);
  central.writeUInt16LE(0, 30); // extra len
  central.writeUInt16LE(0, 32); // comment len
  central.writeUInt16LE(0, 34); // disk
  central.writeUInt16LE(0, 36); // internal attrs
  central.writeUInt32LE(0, 38); // external attrs
  central.writeUInt32LE(r.localOffset, 42);
  r.name.copy(central, 46);
  writeBuf(central);
}
const centralSize = offset - centralStart;

// End of central directory
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(records.length, 8);
eocd.writeUInt16LE(records.length, 10);
eocd.writeUInt32LE(centralSize, 12);
eocd.writeUInt32LE(centralStart, 16);
eocd.writeUInt16LE(0, 20);
writeBuf(eocd);

out.end(() => {
  const stat = fs.statSync(xpiPath);
  console.log(`Built ${xpiName} (${stat.size} bytes, ${records.length} files)`);
  console.log(`\nInstall via about:debugging:`);
  console.log(`  1. Open about:debugging in Firefox`);
  console.log(`  2. "This Firefox" -> "Load Temporary Add-on..."`);
  console.log(`  3. Select: ${xpiPath}`);
  console.log(`\nFor permanent install, run: node scripts/build-firefox.js --sign`);
});
