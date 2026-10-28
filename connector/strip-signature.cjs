// Removes the leftover Authenticode signature from the copied node.exe
// BEFORE the SEA blob is injected. node.exe ships signed by the OpenJS
// Foundation, but the moment postject rewrites the binary to inject our
// code, that signature no longer matches the file — leaving a *corrupt*
// signature (postject literally warns "The signature seems corrupted!").
// A binary that looks signed-then-tampered is a genuine red flag to
// Windows SmartScreen / Defender / Chrome Safe Browsing heuristics — worse
// than a plainly unsigned file. Stripping it first (the order Node's own
// SEA docs recommend) makes the result cleanly unsigned instead.
//
// Usage: node strip-signature.cjs <path-to-exe>
const fs = require('node:fs');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node strip-signature.cjs <path-to-exe>');
  process.exit(1);
}

const b = fs.readFileSync(file);
const peOff = b.readUInt32LE(0x3c);
const magic = b.readUInt16LE(peOff + 24);
const isPE32Plus = magic === 0x20b;
const optStart = peOff + 24;
// The Certificate Table is data-directory index 4. It lives right after the
// fixed portion of the optional header: 112 bytes in (PE32+) or 96 (PE32).
const ddStart = optStart + (isPE32Plus ? 112 : 96);
const certEntry = ddStart + 4 * 8; // each directory entry = 8 bytes (offset + size)
const certOff = b.readUInt32LE(certEntry);
const certSize = b.readUInt32LE(certEntry + 4);

if (certSize === 0) {
  console.log('No embedded signature — nothing to strip.');
  process.exit(0);
}

// Zero out the directory entry so Windows no longer treats the file as
// signed at all (rather than validating a broken signature).
b.writeUInt32LE(0, certEntry);
b.writeUInt32LE(0, certEntry + 4);

// The attribute-certificate table is stored as an overlay at the end of the
// file, so when it's the trailing data we can physically drop those bytes
// too for a fully clean result. (If something were appended after it we'd
// leave the now-unreferenced bytes in place rather than corrupt offsets.)
let out = b;
if (certOff + certSize === b.length) {
  out = b.subarray(0, certOff);
}

fs.writeFileSync(file, out);
console.log(`Stripped ${certSize}-byte signature. New size: ${out.length} bytes.`);
