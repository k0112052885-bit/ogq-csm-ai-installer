// Evidence report for an installed employee collector: is the 5h / 7d reading REALLY from the Claude SDK on this Mac, or could it be a fixture / hand-written file? Two parts:
//  1. collectEvidence: offline, read-only. Looks at the installed SDK package (a stub has no code and tiny declarations), the poller's own log (a real reading has a matching `polled-ok`
//     entry written by the poller at that moment), the identity sidecar and the delivery records. It answers "live-observed", "synthetic-suspected" or "no-observation-yet" and names the
//     reasons. Local files can be forged by the machine's owner, so this is EVIDENCE for the operator, never proof for a third party; the dashboard keeps labelling readings self-reported.
//  2. liveCheck: opt-in (the script needs --live --yes). Starts the SDK exactly like the poller does (no prompt, no tools, no transcripts, persistSession off), asks for identity and
//     usage, WRITES NOTHING and prints only presence / percentages / a yes-no identity match - never the e-mail, tokens or the raw response.
import fs from "node:fs";
import path from "node:path";
import { loadDevice } from "./fleet-device.mjs";
import { bindingFor, readSalt, SDK_IDENTITY_SIDECAR } from "./identity.mjs";
import { pollerPaths, summarizePoller } from "./sdk-poller.mjs";
import { REFERENCE_VERSION, SDK_PACKAGE, sdkPreflight } from "./sdk-preflight.mjs";
import { probeUsage } from "./sdk-usage-probe.mjs";

export const MATCH_MINUTES = 5; // a snapshot belongs to a poller log entry written within this many minutes of its observedAt
export const REAL_SDK_MIN_BYTES = 20000; // the real package ships a large declaration file AND a large JavaScript bundle; a test stub ships neither

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};
const iso = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null);

export function sdkEvidence(appDir) {
  const dir = path.join(appDir, "node_modules", ...SDK_PACKAGE.split("/"));
  const pkg = readJson(path.join(dir, "package.json"));
  if (!pkg) return { installed: false, version: null, realLooking: false, reasons: ["the SDK package is not installed under the app folder"] };
  const size = (rel) => {
    try {
      return fs.statSync(path.join(dir, rel)).size;
    } catch {
      return 0;
    }
  };
  const typesBytes = size(typeof pkg.types === "string" ? pkg.types : typeof pkg.typings === "string" ? pkg.typings : "sdk.d.ts");
  let jsBytes = 0;
  try {
    for (const n of fs.readdirSync(dir)) if (/\.(m?js|cjs)$/.test(n)) jsBytes += size(n);
  } catch {
    /* unreadable folder */
  }
  const reasons = [];
  if (pkg.version !== REFERENCE_VERSION) reasons.push(`version ${pkg.version ?? "unknown"} is not the pinned ${REFERENCE_VERSION}`);
  if (typesBytes < REAL_SDK_MIN_BYTES) reasons.push(`the declaration file is only ${typesBytes} bytes (the real SDK's is far larger): looks like a stub`);
  if (jsBytes < REAL_SDK_MIN_BYTES) reasons.push(`the package holds only ${jsBytes} bytes of JavaScript at its top level (the real SDK ships its bundle there): looks like a stub`);
  return { installed: true, version: pkg.version ?? null, typesBytes, jsBytes, realLooking: reasons.length === 0, reasons };
}

export function pollerEvidence(dataDir, now = new Date()) {
  const p = pollerPaths(dataDir);
  let lines = [];
  try {
    lines = fs.readFileSync(p.log, "utf8").split("\n").filter(Boolean).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    /* no log yet */
  }
  const ok = lines.filter((l) => l.outcome === "polled-ok" && iso(l.t) !== null);
  const outcomes = {};
  for (const l of lines) outcomes[l.outcome] = (outcomes[l.outcome] ?? 0) + 1;
  const last = ok.at(-1) ?? null;
  return { logEntries: lines.length, polledOk: ok.length, outcomes, firstOkAt: ok[0]?.t ?? null, lastOkAt: last?.t ?? null, lastWindows: last?.windows ?? null, okTimes: ok.map((l) => iso(l.t)), summary: summarizePoller(dataDir, now) };
}

export function collectEvidence({ root, now = new Date() }) {
  const appDir = path.join(root, "app");
  const dataDir = path.join(root, "data");
  const cfg = readJson(path.join(root, "config.json"));
  const sdk = sdkEvidence(appDir);
  const poller = pollerEvidence(dataDir, now);
  const snap = readJson(path.join(dataDir, "sdk-quota-latest.json"));
  const sidecar = readJson(path.join(dataDir, SDK_IDENTITY_SIDECAR));
  const observedMs = iso(snap?.observedAt);
  const matched = observedMs !== null && poller.okTimes.some((t) => Math.abs(t - observedMs) <= MATCH_MINUTES * 60000);
  const binding = cfg?.label ? bindingFor(dataDir, cfg.label) : null;
  const windows = { fiveHour: snap?.fiveHour?.kind === "used", weekly: snap?.weekly?.kind === "used" };
  const dev = loadDevice(path.join(root, "device"));
  const tx = readJson(path.join(root, "transport.json"));
  const health = readJson(path.join(root, "health.json"));
  const reasons = [];
  let verdict;
  if (!snap) {
    verdict = "no-observation-yet";
    reasons.push("no sdk-quota-latest.json exists yet: the poller has not stored a reading on this Mac");
  } else {
    if (snap.source !== "claude-agent-sdk-usage") reasons.push(`the snapshot's source is '${snap.source}', not the SDK poller's`);
    if (!sdk.realLooking) reasons.push(...sdk.reasons);
    if (!matched) reasons.push(`no poller log entry 'polled-ok' within ${MATCH_MINUTES} minutes of the snapshot's observedAt: the file was not written by the poller (hand-made or copied)`);
    if (sidecar?.trust !== "verified") reasons.push(`the identity sidecar says trust '${sidecar?.trust ?? "missing"}', not 'verified'`);
    else if (binding && sidecar.fingerprint !== binding.fingerprint) reasons.push("the sidecar's login fingerprint differs from the bound login");
    verdict = reasons.length === 0 ? "live-observed" : !sdk.realLooking || !matched ? "synthetic-suspected" : "unproven";
  }
  return {
    verdict,
    reasons,
    sdk,
    poller: { polledOk: poller.polledOk, logEntries: poller.logEntries, outcomes: poller.outcomes, firstOkAt: poller.firstOkAt, lastOkAt: poller.lastOkAt, enabled: poller.summary.enabled, identityTrust: poller.summary.identityTrust, halted: poller.summary.halted },
    snapshot: snap ? { observedAt: snap.observedAt, source: snap.source, windows, matchedByPollerLog: matched } : null,
    device: dev ? { deviceId: dev.deviceId, approved: dev.approved === true, accountId: dev.accountId ?? null, lastSeq: dev.seq } : null,
    delivery: { delivered: tx?.delivered?.length ?? 0, rejected: tx?.rejected?.length ?? 0, lastRemoteError: health?.remote?.error ?? null },
    note: "Local files can be forged by whoever controls this Mac: this is evidence for the operator, not proof. The dashboard shows delivered readings as self-reported.",
  };
}

/** Opt-in live read: asks the real SDK for identity + usage and reports presence / numbers / identity match. Writes nothing. `probe` is injectable for tests. */
export async function liveCheck({ root, now = new Date(), probe = probeUsage, env = process.env, timeoutMs = 20000 }) {
  const appDir = path.join(root, "app");
  const dataDir = path.join(root, "data");
  const cfg = readJson(path.join(root, "config.json"));
  if (!cfg?.label) return { status: "not-installed", detail: "no installed collector settings in this folder" };
  // sdkPreflight({ packageDir }) trusts the caller that the folder exists (it reports installed:true for any explicit path), so presence is decided here from the package.json itself
  if (!sdkEvidence(appDir).installed) return { status: "sdk-not-installed", detail: "run the installer's sdk step first" };
  const pre = sdkPreflight({ packageDir: path.join(appDir, "node_modules", ...SDK_PACKAGE.split("/")) });
  if (!pre.compat.ok) return { status: "sdk-incompatible", detail: `the installed SDK does not match what the probe relies on: ${pre.compat.reasons.slice(0, 2).join("; ")}` };
  const realness = sdkEvidence(appDir);
  if (!realness.realLooking) return { status: "sdk-looks-synthetic", detail: `a live check on this package would not prove anything: ${realness.reasons.join("; ")}` };
  const salt = readSalt(dataDir);
  if (!salt) return { status: "no-identity-salt", detail: "run the installer's observe step first (it creates the device-local salt)" };
  const r = await probe({ account: cfg.label, timeoutMs, now, identitySalt: salt, env });
  const binding = bindingFor(dataDir, cfg.label);
  const win = (w) => (w ? { present: true, percent: w.percent, resetsAt: w.resetsAt ?? null } : { present: false });
  const identity = r.identity?.ok ? { ok: true, matchesBinding: binding ? r.identity.fingerprint === binding.fingerprint : null } : { ok: false, reason: r.identity?.reason ?? (r.status === "ok" ? "not-read" : null) };
  const fiveHour = win(r.raw?.fiveHour);
  const weekly = win(r.raw?.weekly);
  return {
    status: r.status,
    method: r.method,
    subscriptionType: r.subscriptionType,
    rateLimitsAvailable: r.rateLimitsAvailable,
    fiveHour,
    weekly,
    identity,
    modelActivity: r.messages?.modelActivity === true,
    outcome: r.status !== "ok" ? "failed" : fiveHour.present && weekly.present ? "both-windows" : fiveHour.present || weekly.present ? "one-window" : "no-windows",
    detail: r.error ?? null,
    wrote: false,
  };
}
