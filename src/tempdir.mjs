// Scratch directory for simulations. Uses the system temp dir; if that is not writable (sandbox EPERM/ENOENT) it falls back to a
// project-local, git-ignored folder instead of failing. Only used by throw-away simulation entry points.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function makeTempDir(prefix, { bases = [os.tmpdir(), path.join(ROOT, ".tmp-test")] } = {}) {
  let last;
  for (const base of bases) {
    try {
      fs.mkdirSync(base, { recursive: true });
      return fs.mkdtempSync(path.join(base, prefix));
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`No writable scratch directory (${last?.code ?? "error"}); pass --dir <folder> explicitly.`);
}
