// Deploy the standalone LOM explorer without changing Recall's capture script.
//
// Live scans <User Library>/Remote Scripts/<Name>/ and offers <Name> in
// Preferences -> Link/Tempo/MIDI as a Control Surface.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SURFACE_NAME = "RecallExplorer";
const SOURCE_DIR = join(here, "..", "remote-script", SURFACE_NAME);

// Override on another machine with RECALL_USER_LIBRARY.
const USER_LIBRARY =
  process.env.RECALL_USER_LIBRARY || "M:\\Ableton Library\\User Library";
const DEST_DIR = join(USER_LIBRARY, "Remote Scripts", SURFACE_NAME);

function fail(message, hint) {
  console.error(`\n  x ${message}`);
  if (hint) console.error(`    ${hint}`);
  process.exit(1);
}

if (!existsSync(SOURCE_DIR)) {
  fail(`Source not found: ${SOURCE_DIR}`);
}

if (!existsSync(USER_LIBRARY)) {
  fail(
    `Ableton User Library not found: ${USER_LIBRARY}`,
    "Set RECALL_USER_LIBRARY to your User Library path.",
  );
}

mkdirSync(DEST_DIR, { recursive: true });
const files = readdirSync(SOURCE_DIR).filter((name) => name.endsWith(".py"));
if (files.length === 0) {
  fail(`No .py files in ${SOURCE_DIR}`);
}

for (const name of files) {
  const from = join(SOURCE_DIR, name);
  const to = join(DEST_DIR, name);
  copyFileSync(from, to);
  if (readFileSync(from, "utf8") !== readFileSync(to, "utf8")) {
    fail(`Copied ${name} but the destination does not match.`, "Deploy again.");
  }
}

console.log(`\n  ok ${SURFACE_NAME} deployed (${files.length} file(s))`);
console.log(`     ${DEST_DIR}`);
console.log("  Restart Live, then select RecallExplorer in an unused Control Surface slot.");
console.log("  It writes a bounded read-only LOM scan to Live's Log.txt.\n");
