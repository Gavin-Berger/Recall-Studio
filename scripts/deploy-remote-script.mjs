// Deploy the Recall control surface into Ableton's User Library.
//
// Same posture as deploy-bridge.mjs, and for the same reason: the live copy is
// NOT the repo copy, so an edit here does nothing until it is copied across.
// Last night that drift meant a rolled-back bridge could have been silently
// reinstalled by the next deploy. One command, and it verifies afterwards.
//
// Live scans <User Library>/Remote Scripts/<Name>/ and offers <Name> in
// Preferences → Link/Tempo/MIDI as a Control Surface.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = join(here, "..", "remote-script", "Recall");

// Override on another machine with RECALL_USER_LIBRARY.
const USER_LIBRARY =
  process.env.RECALL_USER_LIBRARY || "M:\\Ableton Library\\User Library";

const DEST_DIR = join(USER_LIBRARY, "Remote Scripts", "Recall");

function fail(message, hint) {
  console.error(`\n  ✗ ${message}`);
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

console.log(`\n  ✓ Recall control surface deployed (${files.length} file(s))`);
console.log(`    ${DEST_DIR}`);
console.log(`    verified identical to the repo copy\n`);
console.log("  In Live: Preferences → Link/Tempo/MIDI → Control Surface → Recall");
console.log("  Live only rescans this folder at STARTUP — restart Live if it's running.\n");
