// Read-only, offline preflight for the (experimental) Agent SDK usage probe. It never imports the SDK, never spawns a
// process, never reads credentials and never uses the network: it only reads the SDK's OWN published type declarations
// from a project-local node_modules (if installed) to verify that the usage API this probe relies on exists in that
// exact version, and to show its declared shape. If the declarations do not match, the probe must not run.
//
// Checked against the real declarations of @anthropic-ai/claude-agent-sdk 0.3.301 (sdk.d.ts):
//   Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(opts?: { skipBehaviors?: boolean }): Promise<SDKControlGetUsageResponse>
//   SDKControlGetUsageRequest  = { subtype: 'get_usage'; skip_behaviors?: boolean }
//   SDKControlGetUsageResponse = { session, subscription_type: string | null, rate_limits_available: boolean,
//       rate_limits: { five_hour?: { utilization: number | null; resets_at: string | null } | null; seven_day?: {...} | null; ... } | null, behaviors }
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
export const REFERENCE_VERSION = "0.3.301";
export const TYPES_URL = `https://app.unpkg.com/${SDK_PACKAGE}@${REFERENCE_VERSION}/files/sdk.d.ts`;
export const USAGE_METHOD_NAME = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";
const MAX_DTS_BYTES = 8 * 1024 * 1024;
const BLOCK_CAP = 3000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\n\s*\n+/g, "\n");
}

/** Declaration text of `type NAME = ...` / `interface NAME {...}` (brace matched; `& {..}` / `| {..}` parts kept). Public type text only. */
export function extractDeclaration(dts, name, cap = BLOCK_CAP) {
  const m = new RegExp(`(?:export\\s+)?(?:declare\\s+)?(?:type|interface)\\s+${name}\\b`).exec(dts);
  if (!m) return null;
  const open = dts.indexOf("{", m.index);
  const semi = dts.indexOf(";", m.index);
  if (open === -1 || (semi !== -1 && semi < open)) return dts.slice(m.index, semi === -1 ? m.index + 200 : semi + 1).slice(0, cap);
  let depth = 0;
  for (let i = open; i < dts.length; i++) {
    if (dts[i] === "{") depth++;
    else if (dts[i] === "}" && --depth === 0) {
      const more = /^\s*[&|]\s*(?=\{)/.exec(dts.slice(i + 1, i + 40));
      if (!more) return dts.slice(m.index, i + 1).slice(0, cap);
      i += more[0].length;
    }
  }
  return dts.slice(m.index, m.index + cap);
}

function findPackageDir(roots) {
  for (const start of roots) {
    let dir = path.resolve(start);
    for (let i = 0; i < 6; i++) {
      const cand = path.join(dir, "node_modules", ...SDK_PACKAGE.split("/"));
      if (fs.existsSync(path.join(cand, "package.json"))) return cand;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return null;
}

/** Nearest ancestor of a file that is the SDK package (package.json name matches), or null. */
export function packageDirOf(file) {
  let dir = path.dirname(path.resolve(file));
  for (let i = 0; i < 6; i++) {
    try {
      if (JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name === SDK_PACKAGE) return dir;
    } catch {
      /* keep walking */
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const OPTION_NAMES = ["abortController", "cwd", "env", "persistSession", "settingSources", "tools", "allowedTools", "strictMcpConfig", "mcpServers"];

/**
 * Does the installed version declare EXACTLY what this probe uses? Every check is on the declaration text with comments removed.
 * `ok` is false (and `reasons` says why) when anything differs: the probe then refuses to start.
 */
export function checkCompatibility(dts) {
  const t = stripComments(dts);
  const reasons = [];
  const need = (cond, why) => {
    if (!cond) reasons.push(why);
  };
  need(new RegExp(`${USAGE_METHOD_NAME}\\s*\\(\\s*opts\\s*\\?\\s*:\\s*\\{\\s*skipBehaviors\\s*\\?\\s*:\\s*boolean\\s*;?\\s*\\}\\s*\\)\\s*:\\s*Promise<SDKControlGetUsageResponse>`).test(t), `Query.${USAGE_METHOD_NAME}(opts?: { skipBehaviors?: boolean }) is not declared as expected`);
  const req = extractDeclaration(t, "SDKControlGetUsageRequest", 20000);
  need(Boolean(req) && /subtype\s*:\s*'get_usage'/.test(req) && /skip_behaviors\s*\?\s*:\s*boolean/.test(req), "SDKControlGetUsageRequest { subtype: 'get_usage'; skip_behaviors?: boolean } not declared as expected");
  const res = extractDeclaration(t, "SDKControlGetUsageResponse", 200000) ?? "";
  need(/subscription_type\s*:\s*string\s*\|\s*null/.test(res), "response.subscription_type: string | null not declared");
  need(/rate_limits_available\s*:\s*boolean/.test(res), "response.rate_limits_available: boolean not declared");
  need(/rate_limits\s*:\s*\{/.test(res) && /five_hour\s*\?\s*:/.test(res) && /seven_day\s*\?\s*:/.test(res), "response.rate_limits.five_hour? / seven_day? not declared");
  need(/utilization\s*:\s*number\s*\|\s*null/.test(res), "window.utilization: number | null not declared");
  need(/resets_at\s*:\s*string\s*\|\s*null/.test(res), "window.resets_at: string | null not declared");
  for (const o of OPTION_NAMES) need(new RegExp(`\\b${o}\\s*\\?\\s*:`).test(t), `Options.${o} not declared`);
  need(/prompt\s*:\s*string\s*\|\s*AsyncIterable</.test(t), "query({ prompt: string | AsyncIterable<...> }) not declared");
  need(/\bclose\s*\(\s*\)\s*:\s*void/.test(t), "Query.close(): void not declared");
  return { ok: reasons.length === 0, reasons };
}

export function sdkPreflight({ roots = [ROOT], packageDir = null, env = process.env, nodeVersion = process.versions.node } = {}) {
  const major = Number(nodeVersion.split(".")[0]);
  const r = {
    nodeVersion,
    nodeOk: major >= 18,
    installed: false,
    version: null,
    matchesReference: null,
    typesFile: false,
    mentions: { get_usage: false, getUsage: false, experimentalMethods: [] },
    declarations: { SDKControlGetUsageRequest: null, SDKControlGetUsageResponse: null },
    shapeHints: [],
    compat: { ok: false, reasons: ["SDK declarations not checked"] },
    envNotes: [],
    actions: [],
  };
  const stripped = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"].filter((k) => env[k]);
  if (stripped.length) r.envNotes.push(`set in this environment (names only; the probe removes them for its child process): ${stripped.join(", ")}`);
  if (!r.nodeOk) r.actions.push("Node 18 or newer is required by the SDK.");

  const dir = packageDir ? path.resolve(packageDir) : findPackageDir(roots);
  if (!dir) {
    r.actions.push(`SDK not installed. Local, non-global install: npm install --no-save ${SDK_PACKAGE}@${REFERENCE_VERSION}  (run inside this project; never -g)`);
    return r;
  }
  r.installed = true;
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    r.actions.push("SDK package.json unreadable.");
  }
  r.version = typeof pkg.version === "string" && /^[0-9A-Za-z.+-]{1,30}$/.test(pkg.version) ? pkg.version : null;
  r.matchesReference = r.version === null ? null : r.version === REFERENCE_VERSION;
  const typesRel = typeof pkg.types === "string" ? pkg.types : typeof pkg.typings === "string" ? pkg.typings : "sdk.d.ts";
  const typesPath = path.resolve(dir, typesRel);
  if (!typesPath.startsWith(dir + path.sep)) {
    r.actions.push("SDK types path points outside the package: ignored.");
    r.compat = { ok: false, reasons: ["types path outside the package"] };
    return r;
  }
  let dts = null;
  try {
    if (fs.statSync(typesPath).size <= MAX_DTS_BYTES) dts = fs.readFileSync(typesPath, "utf8");
  } catch {
    /* no types file */
  }
  if (dts === null) {
    r.actions.push("SDK type declarations not found; cannot verify the usage API for this version.");
    r.compat = { ok: false, reasons: ["type declarations not found"] };
    return r;
  }
  r.typesFile = true;
  r.mentions.get_usage = /['"]get_usage['"]/.test(dts);
  r.mentions.getUsage = /\bgetUsage\b/.test(dts);
  r.mentions.experimentalMethods = [...new Set([...dts.matchAll(/\busage_EXPERIMENTAL\w*/g)].map((m) => m[0]))].slice(0, 5);
  const clean = stripComments(dts);
  for (const n of ["SDKControlGetUsageRequest", "SDKControlGetUsageResponse"]) r.declarations[n] = extractDeclaration(clean, n);
  const fullResponse = extractDeclaration(clean, "SDKControlGetUsageResponse", 200000) ?? "";
  r.shapeHints = ["five_hour", "seven_day", "utilization", "used_percentage", "resets_at", "rate_limits_available", "subscription_type"].filter((k) => fullResponse.includes(k));
  r.compat = checkCompatibility(dts);
  if (!r.mentions.get_usage && !r.mentions.getUsage && !r.mentions.experimentalMethods.length) r.actions.push(`This SDK version's types do not mention a usage API (get_usage / getUsage / ${USAGE_METHOD_NAME}). Compare with ${TYPES_URL}.`);
  if (r.matchesReference === false) r.actions.push(`Installed ${r.version} differs from the reference ${REFERENCE_VERSION}: the compatibility check below decides whether the probe may run.`);
  if (!r.compat.ok) r.actions.push(`INCOMPATIBLE with this probe (it will refuse to start): ${r.compat.reasons.join("; ")}`);
  return r;
}
