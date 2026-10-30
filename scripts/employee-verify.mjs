#!/usr/bin/env node
// Is the 5h / 7d reading on THIS Mac a real observation or synthetic? Part of the employee package (runs from the installed copy).
//   node ~/.ogq-csm/app/scripts/employee-verify.mjs [--root DIR | --profile b] [--json]                OFFLINE evidence report (reads files only; starts nothing)
//   node ~/.ogq-csm/app/scripts/employee-verify.mjs --live --yes [--root DIR | --profile b] [--json]   ONE read-only SDK call (identity + usage, no prompt, writes nothing)
// Exit: evidence: 0 live-observed / 1 otherwise. live: 0 both windows / 2 one window or none / 1 failed / 3 refused (no --yes).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { collectEvidence, liveCheck } from "../src/live-evidence.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
try {
  const { values } = parseArgs({ options: { root: { type: "string" }, profile: { type: "string" }, live: { type: "boolean" }, yes: { type: "boolean" }, json: { type: "boolean" } } });
  if (values.profile !== undefined && !/^[a-z0-9][a-z0-9-]{0,19}$/.test(values.profile)) throw new Error("--profile must be 1-20 characters: lowercase letters, digits, dashes");
  const installed = path.basename(HERE) === "scripts" && path.basename(path.dirname(HERE)) === "app" ? path.dirname(path.dirname(HERE)) : null;
  const root = path.resolve(values.root ?? (values.profile ? path.join(os.homedir(), `.ogq-csm-${values.profile}`) : installed ?? path.join(os.homedir(), ".ogq-csm")));
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
    if (typeof cfg.claudeConfigDir === "string") process.env.CLAUDE_CONFIG_DIR = cfg.claudeConfigDir; // a second account reads ITS Claude login
  } catch {
    /* not installed: reported below */
  }
  const show = (o) => console.log(values.json ? JSON.stringify(o) : JSON.stringify(o, null, 2));
  if (values.live) {
    if (!values.yes) {
      console.log("Refusing to start anything without --yes. --live starts the SDK's local Claude Code process with this Mac's login (no message is sent, nothing is written), asks for identity and usage, and closes it.");
      process.exit(3);
    }
    const r = await liveCheck({ root });
    show({ mode: "live-read-only", root, ...r });
    process.exit(r.outcome === "both-windows" ? 0 : r.status === "ok" ? 2 : 1);
  }
  const e = collectEvidence({ root });
  show({ mode: "offline-evidence", root, ...e });
  process.exit(e.verdict === "live-observed" ? 0 : 1);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
