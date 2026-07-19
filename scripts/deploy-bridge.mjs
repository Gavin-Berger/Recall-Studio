// Deploy the Max for Live bridge to the copy Ableton actually loads.
//
// Why this exists: the running bridge lives in Ableton's User Library, NOT in
// this repo. Editing m4l/recall_m4l_bridge.js changes nothing in Ableton until
// it's copied across, and when the two drift you end up debugging behaviour that
// isn't the code you're reading. That has bitten this project more than once
// (a copy sat two versions behind for weeks). This makes the copy one command
// and prints the versions so the drift is impossible to miss.
//
//   npm run deploy:bridge
//
// Override the destination on another machine:
//   RECALL_BRIDGE_DEST="/path/to/User Library/.../recall_m4l_bridge.js" npm run deploy:bridge

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(repoRoot, "m4l", "recall_m4l_bridge.js");

// The Audio Effect copy is the live one. (There is also a stale MIDI Effect
// copy in the User Library — deliberately not touched.)
const DEFAULT_DEST =
  "M:\\Ableton Library\\User Library\\Presets\\Audio Effects\\Max Audio Effect\\recall_m4l_bridge.js";
const DEST = process.env.RECALL_BRIDGE_DEST || DEFAULT_DEST;

function versionOf(file) {
  const match = readFileSync(file, "utf8").match(/BRIDGE_VERSION\s*=\s*"([^"]+)"/);
  return match ? match[1] : "unknown";
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function fail(message, hint) {
  console.error(`\n  ✗ ${message}`);
  if (hint) console.error(`    ${hint}`);
  process.exit(1);
}

if (!existsSync(SOURCE)) {
  fail(`Bridge source not found: ${SOURCE}`);
}

const destDir = dirname(DEST);
if (!existsSync(destDir)) {
  fail(
    `Destination folder not found: ${destDir}`,
    "Is the drive mounted? If your Ableton User Library lives elsewhere, set RECALL_BRIDGE_DEST.",
  );
}

const newVersion = versionOf(SOURCE);
const oldVersion = existsSync(DEST) ? versionOf(DEST) : null;

// Keep the outgoing copy, named for what it actually contains, so a rollback
// never depends on remembering which version was live.
if (oldVersion && oldVersion !== newVersion) {
  const backup = join(destDir, `recall_m4l_bridge_${oldVersion}_backup.bak`);
  copyFileSync(DEST, backup);
  console.log(`  backed up ${oldVersion} → ${backup}`);
}

copyFileSync(SOURCE, DEST);

if (sha256(SOURCE) !== sha256(DEST)) {
  fail("Copy finished but the destination does not match the source.", "Deploy again.");
}

console.log("");
if (oldVersion === null) {
  console.log(`  ✓ Bridge ${newVersion} deployed (no previous copy)`);
} else if (oldVersion === newVersion) {
  console.log(`  ✓ Bridge ${newVersion} redeployed (was already ${oldVersion})`);
} else {
  console.log(`  ✓ Bridge ${oldVersion} → ${newVersion} deployed`);
}
console.log(`    ${DEST}`);
console.log("    verified identical to the repo copy");
console.log("");
console.log(`  Reload the RECALL device in Ableton, then confirm the Max Console says v${newVersion}.`);
console.log("");
