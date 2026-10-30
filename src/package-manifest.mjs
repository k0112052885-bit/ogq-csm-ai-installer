// Integrity manifest of an employee package: every shipped file with its SHA-256, plus a short fingerprint the admin can read out over another channel.
// This detects accidental damage and casual tampering of the folder; it is NOT a signature (no key ships in the package). The out-of-band fingerprint is the trust anchor.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MANIFEST_FILE = "MANIFEST.json";
export const MANIFEST_SCHEMA = "csm-employee-package-manifest/v1";
const IGNORED = new Set([".DS_Store", ".git"]); // .git: a git clone of a code-only package carries its own metadata; install copies only manifest-listed files, so it never ships onward

export const sha256File = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
export const fingerprintOf = (text) => crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);

const safeRel = (rel) => typeof rel === "string" && rel.length > 0 && !path.isAbsolute(rel) && !rel.split(/[\\/]/).includes("..") && !rel.includes("\0");

export function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED.has(e.name) || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out.sort();
}

/** Writes MANIFEST.json for the given relative files (all must exist). Returns { manifest, text, fingerprint }. */
export function writeManifest(dir, relFiles, { version, builtAt }) {
  const files = {};
  for (const rel of [...relFiles].sort()) {
    if (!safeRel(rel) || rel === MANIFEST_FILE) throw new Error(`unsafe manifest path: ${rel}`);
    const p = path.join(dir, rel);
    files[rel] = { sha256: sha256File(p), size: fs.statSync(p).size };
  }
  const manifest = { schema: MANIFEST_SCHEMA, version, builtAt, files };
  const text = JSON.stringify(manifest, null, 2) + "\n";
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), text, { mode: 0o644 });
  return { manifest, text, fingerprint: fingerprintOf(text) };
}

/** Verifies a package folder against its manifest. Never throws. */
export function verifyManifest(dir) {
  const problems = [];
  let text;
  let manifest;
  try {
    text = fs.readFileSync(path.join(dir, MANIFEST_FILE), "utf8");
    manifest = JSON.parse(text);
  } catch {
    return { ok: false, problems: ["MANIFEST.json missing or unreadable"], fingerprint: null, manifest: null };
  }
  if (!manifest || manifest.schema !== MANIFEST_SCHEMA || !manifest.files || typeof manifest.files !== "object") return { ok: false, problems: ["MANIFEST.json is not a package manifest"], fingerprint: null, manifest: null };
  for (const [rel, meta] of Object.entries(manifest.files)) {
    if (!safeRel(rel)) {
      problems.push(`unsafe path in manifest: ${String(rel).slice(0, 60)}`);
      continue;
    }
    const p = path.join(dir, rel);
    try {
      if (fs.statSync(p).size !== meta.size || sha256File(p) !== meta.sha256) problems.push(`modified: ${rel}`);
    } catch {
      problems.push(`missing: ${rel}`);
    }
  }
  for (const rel of listFiles(dir)) if (rel !== MANIFEST_FILE && !manifest.files[rel]) problems.push(`unlisted file: ${rel}`);
  return { ok: problems.length === 0, problems, fingerprint: fingerprintOf(text), manifest };
}
