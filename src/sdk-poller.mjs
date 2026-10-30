// Periodic, prompt-free usage poller for an owner's Mac, built on the verified SDK probe (src/sdk-usage-probe.mjs).
// One call = one scheduling decision; an external scheduler (that the OWNER installs - never this repo) may call it as often as it
// likes (every 15 minutes is typical): TTL, backoff, a halt state and a lock make extra calls harmless.
//   - TTL: no new probe while the last success is younger than intervalMinutes;
//   - backoff: after timeout/error 15, 30, 60, ... minutes (capped); soft "no data" answers wait longer without counting as failures;
//   - halt: an incompatible SDK/response, a missing method or any model activity stops polling until the SDK version changes
//     (model activity: until a manual `reset`) - the API is experimental;
//   - version pin: only the pinned SDK version is polled;
//   - lock: at most one probe at a time, stale locks are taken over after 10 minutes;
//   - logging: one JSON line per decision (status, booleans, counters, redacted short error) - never responses, credentials or content;
//   - output: a minimal csm-quota/v1 snapshot written atomically (0600) only on success; a failed poll never touches the previous file.
// The statusLine collector is untouched and remains the realtime fallback.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bindingFor, ensureSalt, identityVerdict, recordObservation, SDK_IDENTITY_SIDECAR } from "./identity.mjs";
import { validateAlias } from "./model.mjs";
import { packageDirOf, REFERENCE_VERSION, sdkPreflight } from "./sdk-preflight.mjs";
import { probeUsage } from "./sdk-usage-probe.mjs";

export const POLLER_SCHEMA = "csm-sdk-poller/v1";
export const LOCK_STALE_MINUTES = 10;
export const LOG_MAX_BYTES = 256 * 1024;
export const BACKOFF_BASE_MINUTES = 15;
const CONFIG_KEYS = ["schema", "account", "enabled", "intervalMinutes", "maxBackoffMinutes", "timeoutSeconds", "pinnedVersion", "sdkModule", "dir", "requireIdentity"];
const SOFT = new Set(["rate-limits-unavailable", "no-windows"]);
const HALTING = new Set(["api-incompatible", "sdk-incompatible", "method-not-found", "sdk-not-installed"]);

export function pollerPaths(dir) {
  return {
    config: path.join(dir, "sdk-poller.json"),
    state: path.join(dir, "sdk-poller-state.json"),
    log: path.join(dir, "sdk-poller.log"),
    lock: path.join(dir, "sdk-poller.lock"),
    snapshot: path.join(dir, "sdk-quota-latest.json"),
    identity: path.join(dir, SDK_IDENTITY_SIDECAR),
    quarantine: path.join(dir, "sdk-quota-quarantine.json"),
  };
}

export function defaultConfig({ account, dir = path.join(os.homedir(), ".csm"), intervalMinutes = 60, pinnedVersion = REFERENCE_VERSION, sdkModule = null, enabled = false } = {}) {
  return { schema: POLLER_SCHEMA, account, enabled, intervalMinutes, maxBackoffMinutes: 1440, timeoutSeconds: 30, pinnedVersion, sdkModule, dir };
}

export function validateConfig(c) {
  const errors = [];
  if (!c || typeof c !== "object" || Array.isArray(c)) return { ok: false, errors: ["config must be a JSON object"] };
  for (const k of Object.keys(c)) if (!CONFIG_KEYS.includes(k)) errors.push(`unexpected field "${String(k).slice(0, 40)}"`);
  if (c.schema !== POLLER_SCHEMA) errors.push(`schema must be "${POLLER_SCHEMA}"`);
  const aerr = validateAlias(c.account);
  if (aerr) errors.push(`account: ${aerr}`);
  if (typeof c.enabled !== "boolean") errors.push("enabled must be true/false");
  const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!intIn(c.intervalMinutes, 15, 1440)) errors.push("intervalMinutes must be a whole number 15-1440");
  if (!intIn(c.maxBackoffMinutes, 15, 10080)) errors.push("maxBackoffMinutes must be a whole number 15-10080");
  if (!intIn(c.timeoutSeconds, 1, 120)) errors.push("timeoutSeconds must be a whole number 1-120");
  if (typeof c.pinnedVersion !== "string" || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(c.pinnedVersion)) errors.push("pinnedVersion must look like 0.3.301");
  if (c.sdkModule !== null && (typeof c.sdkModule !== "string" || !path.isAbsolute(c.sdkModule))) errors.push("sdkModule must be null or an absolute path");
  if (typeof c.dir !== "string" || !path.isAbsolute(c.dir)) errors.push("dir must be an absolute path");
  if (c.requireIdentity !== undefined && typeof c.requireIdentity !== "boolean") errors.push("requireIdentity must be true/false");
  return { ok: errors.length === 0, errors };
}

// ------------------------------------------------------------------ small private-file helpers

function writePrivate(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const redact = (s) => String(s ?? "").replace(/(sk-ant-[\w-]+|xox[bp]-[\w-]+|Bearer\s+\S+|eyJ[\w-]{10,}\.[\w-]+\.[\w-]+)/g, "[redacted]").replace(/\/Users\/[^\s/]+/g, "/Users/~").slice(0, 120);

function loadPollerState(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    if (d && d.schemaVersion === 1) return { failures: 0, soft: 0, ...d };
  } catch {
    /* fresh state */
  }
  return { schemaVersion: 1, failures: 0, soft: 0 };
}

function appendLog(file, entry) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`); // keep one previous generation
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch {
    /* logging must never break polling */
  }
}

function acquireLock(file, now) {
  const take = () => {
    const fd = fs.openSync(file, "wx", 0o600);
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, t: now.toISOString() }));
    fs.closeSync(fd);
  };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    take();
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  let t = 0;
  try {
    t = Date.parse(JSON.parse(fs.readFileSync(file, "utf8")).t);
  } catch {
    /* unreadable lock counts as stale */
  }
  if (Number.isFinite(t) && now.getTime() - t < LOCK_STALE_MINUTES * 60000) return false;
  fs.rmSync(file, { force: true });
  try {
    take();
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ real collaborators (injectable for tests)

export function realPreflight(config) {
  if (config.sdkModule) {
    const dir = packageDirOf(config.sdkModule);
    return dir ? sdkPreflight({ packageDir: dir }) : { installed: false, version: null, compat: { ok: false, reasons: ["sdkModule is not inside the SDK package"] } };
  }
  return sdkPreflight();
}

export function realProbe(config, now) {
  const loadSdk = config.sdkModule ? async () => import(pathToFileURL(config.sdkModule).href) : undefined;
  return probeUsage({ loadSdk, account: config.account, timeoutMs: config.timeoutSeconds * 1000, now, identitySalt: ensureSalt(config.dir) });
}

// ------------------------------------------------------------------ one scheduling decision

/**
 * Returns { outcome, status?, nextAllowedAt?, failures, wrote }.
 * outcome: disabled | would-poll (dryRun) | polled-ok | polled-soft | failed | halted | skipped-ttl | skipped-backoff |
 *          skipped-halted | skipped-locked | skipped-not-installed | skipped-version-mismatch | skipped-incompatible
 * dryRun: makes every decision from the saved state but starts nothing and writes nothing.
 */
export async function pollOnce({ config, now = new Date(), dryRun = false, preflight = realPreflight, probe = realProbe, jitter = 0 }) {
  const v = validateConfig(config);
  if (!v.ok) throw new Error(`Invalid poller config:\n- ${v.errors.join("\n- ")}`);
  const p = pollerPaths(config.dir);
  const st = loadPollerState(p.state);
  const iso = now.toISOString();
  const result = (outcome, extra = {}) => ({ outcome, nextAllowedAt: st.nextAllowedAt ?? null, failures: st.failures, wrote: false, ...extra });
  const save = () => {
    if (!dryRun) writePrivate(p.state, JSON.stringify(st, null, 2) + "\n");
  };
  const note = (outcome, extra = {}) => {
    if (outcome.startsWith("skipped-")) {
      // repeated identical skips (every scheduler tick) are logged once, not every 15 minutes
      if (st.lastSkip !== outcome) {
        st.lastSkip = outcome;
        save();
        if (!dryRun) appendLog(p.log, { t: iso, outcome, failures: st.failures, ...extra });
      }
    } else {
      if (st.lastSkip) {
        delete st.lastSkip;
        save();
      }
      if (!dryRun) appendLog(p.log, { t: iso, outcome, failures: st.failures, ...extra });
    }
    return result(outcome, extra);
  };
  const after = (minutes) => new Date(now.getTime() + minutes * 60000 * (1 + jitter)).toISOString();

  if (!config.enabled) return result("disabled");

  const pre = preflight(config);
  if (!pre.installed) return note("skipped-not-installed");
  if (pre.version !== config.pinnedVersion) return note("skipped-version-mismatch", { installed: pre.version, pinned: config.pinnedVersion });
  if (st.halted && st.halted.version !== "*" && st.halted.version !== pre.version) {
    delete st.halted; // the SDK changed since the halt: give it another chance (the gates below still apply)
    delete st.nextAllowedAt;
    save();
  }
  if (st.halted) return note("skipped-halted", { halted: st.halted.status });
  if (!pre.compat.ok) {
    st.halted = { status: "sdk-incompatible", version: pre.version, since: iso };
    st.nextAllowedAt = after(1440);
    save();
    return note("skipped-incompatible", { reasons: pre.compat.reasons.map(redact).slice(0, 3) });
  }
  if (st.nextAllowedAt && now < new Date(st.nextAllowedAt)) return result("skipped-backoff");
  if (st.lastSuccessAt && now.getTime() < Date.parse(st.lastSuccessAt) + config.intervalMinutes * 60000) return result("skipped-ttl");
  if (dryRun) return result("would-poll");

  if (!acquireLock(p.lock, now)) return note("skipped-locked");
  let r;
  try {
    try {
      r = await probe(config, now);
    } catch (e) {
      r = { status: "error", error: e?.message, messages: {} };
    }
    st.lastAttemptAt = iso;
    st.lastStatus = r.status;
    const windows = { five: Boolean(r.raw?.fiveHour), seven: Boolean(r.raw?.weekly) };
    if (r.messages?.modelActivity) {
      st.halted = { status: "model-activity", version: "*", since: iso }; // must never happen: stop until a human resets
      st.nextAllowedAt = after(10080);
      save();
      return note("halted", { status: "model-activity" });
    }
    if (r.status === "ok") {
      // Account-switch safety: the numbers belong to whoever is logged in NOW. They are written under the label only if that login is the bound one
      // (or, while nothing is bound, the same login first observed). Otherwise they are quarantined and the previous snapshot simply ages.
      if (r.identity !== undefined) recordObservation(config.dir, { t: now, identity: r.identity });
      const verdict = identityVerdict({ binding: bindingFor(config.dir, config.account), identity: r.identity, baseline: st.baselineIdentity ?? null, requireIdentity: config.requireIdentity === true });
      if (!verdict.write) {
        writePrivate(p.quarantine, JSON.stringify({ quarantinedAt: iso, trust: verdict.trust, reason: verdict.reason, snapshot: r.raw }, null, 2) + "\n");
        Object.assign(st, { identityTrust: verdict.trust, nextAllowedAt: after(config.intervalMinutes) });
        save();
        return note("quarantined", { status: "ok", trust: verdict.trust, windows, wrote: false });
      }
      writePrivate(p.snapshot, JSON.stringify(r.raw, null, 2) + "\n");
      if (verdict.fingerprint) writePrivate(p.identity, JSON.stringify({ observedAt: r.raw.observedAt, label: config.account, trust: verdict.trust, fingerprint: verdict.fingerprint }, null, 2) + "\n");
      else fs.rmSync(p.identity, { force: true }); // a reading without identity must not inherit an older sidecar
      if (verdict.setBaseline) st.baselineIdentity = verdict.setBaseline;
      Object.assign(st, { failures: 0, soft: 0, lastSuccessAt: iso, nextAllowedAt: after(config.intervalMinutes), identityTrust: verdict.trust });
      delete st.halted;
      save();
      return note("polled-ok", { status: "ok", windows, wrote: true });
    }
    if (SOFT.has(r.status)) {
      st.soft += 1;
      st.nextAllowedAt = after(Math.max(config.intervalMinutes * 4, 360));
      save();
      return note("polled-soft", { status: r.status });
    }
    if (HALTING.has(r.status)) {
      st.halted = { status: r.status, version: pre.version, since: iso };
      st.nextAllowedAt = after(1440);
      save();
      return note("halted", { status: r.status, error: redact(r.error) });
    }
    st.failures += 1;
    st.nextAllowedAt = after(Math.min(config.maxBackoffMinutes, BACKOFF_BASE_MINUTES * 2 ** (st.failures - 1)));
    save();
    return note("failed", { status: r.status, error: redact(r.error) });
  } finally {
    fs.rmSync(p.lock, { force: true });
  }
}

/** Human-readable state for `status` and the owner doctor (no secrets, no raw data). */
export function summarizePoller(dir, now = new Date()) {
  const p = pollerPaths(dir);
  let config = null;
  try {
    const c = JSON.parse(fs.readFileSync(p.config, "utf8"));
    if (validateConfig(c).ok) config = c;
  } catch {
    /* not configured */
  }
  const st = loadPollerState(p.state);
  return {
    configured: Boolean(config),
    enabled: config?.enabled ?? false,
    pinnedVersion: config?.pinnedVersion ?? null,
    intervalMinutes: config?.intervalMinutes ?? null,
    failures: st.failures,
    soft: st.soft,
    lastSuccessAt: st.lastSuccessAt ?? null,
    lastSuccessMinutesAgo: st.lastSuccessAt ? Math.max(0, Math.round((now.getTime() - Date.parse(st.lastSuccessAt)) / 60000)) : null,
    lastStatus: st.lastStatus ?? null,
    nextAllowedAt: st.nextAllowedAt ?? null,
    halted: st.halted ? { status: st.halted.status, since: st.halted.since } : null,
    identityTrust: st.identityTrust ?? null, // verified | observed-unbound | unknown | mismatch | switch-suspected | ... (null = never evaluated)
  };
}

/** Manual recovery after a halt (e.g. you reviewed the SDK change). */
export function resetPoller(dir) {
  const p = pollerPaths(dir);
  const st = loadPollerState(p.state);
  delete st.halted;
  delete st.nextAllowedAt;
  delete st.baselineIdentity; // the owner accepts the current login as the new reference (bound labels are unaffected: they compare to the binding)
  delete st.identityTrust;
  st.failures = 0;
  st.soft = 0;
  writePrivate(p.state, JSON.stringify(st, null, 2) + "\n");
  return st;
}
