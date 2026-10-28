// Flips the PE header's Subsystem field from CUI (console — Windows shows a
// black terminal window at launch) to GUI (no window at all). Node.js runs
// exactly the same either way at the API level (fetch/WebSocket/spawn/fs are
// all unaffected) — Subsystem only controls whether the OS allocates and
// displays a console at process start. Run as the LAST build step (after
// postject), since nothing downstream should touch the PE header again.
//
// Usage: node hide-console.cjs <path-to-exe>
const fs = require('node:fs');

const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;

const file = process.argv[2];
if (!file) {
  console.error('Usage: node hide-console.cjs <path-to-exe>');
  process.exit(1);
}

const b = fs.readFileSync(file);
const peOff = b.readUInt32LE(0x3c);
// Optional Header starts right after the 4-byte "PE\0\0" signature + the
// 20-byte COFF header = peOff + 24. Subsystem is a 2-byte field 68 bytes
// into the Optional Header for both PE32 and PE32+ layouts (it comes before
// the data directories, whose layout is where PE32/PE32+ actually diverge).
const subsystemOff = peOff + 24 + 68;
const current = b.readUInt16LE(subsystemOff);

if (current === IMAGE_SUBSYSTEM_WINDOWS_GUI) {
  console.log('Already GUI subsystem (no console window) — nothing to do.');
  process.exit(0);
}

b.writeUInt16LE(IMAGE_SUBSYSTEM_WINDOWS_GUI, subsystemOff);
fs.writeFileSync(file, b);
console.log(`Patched Subsystem ${current} -> ${IMAGE_SUBSYSTEM_WINDOWS_GUI} (GUI — no console window will ever appear).`);
