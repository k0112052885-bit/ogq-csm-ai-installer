// Account-switch safety for the usage collectors.
// Observed facts (SDK @anthropic-ai/claude-agent-sdk 0.3.301, sdk.d.ts): `Query.accountInfo(): Promise<AccountInfo>` with ALL fields optional:
//   { email?, organization?, subscriptionType?, tokenSource?, apiKeySource?, apiProvider? }. There is NO account UUID. The only usable stable identifier is `email`,
//   and only on a first-party login. Nothing guarantees it is present, so every consumer treats "no identity" as "cannot attribute".
// Not observed: any identity in the statusLine stdin (the parser reads only rate_limits). The statusLine therefore stays UNBOUND and is trusted only when
//   bracketed by two SDK readings of the bound identity (see statuslineTrust).
// Privacy: the e-mail is never stored, logged or returned. A fingerprint is HMAC-SHA256(device-local random salt, normalized e-mail), truncated to 24 hex chars.
//   Fingerprints are therefore device-local on purpose (two devices of one login differ; each device is bound separately; no shared secret to leak).
// Binding is explicit: the owner confirms that the login observed in the latest SDK reading IS the label's login. Nothing is ever guessed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { validateAlias } from "./model.mjs";

export const BINDING_SCHEMA = "csm-identity-binding/v1";
export const SALT_FILE = "identity-salt";
export const BINDING_FILE = "identity-binding.json";
export const LOG_FILE = "identity-log.jsonl";
export const SDK_IDENTITY_SIDECAR = "sdk-quota-latest.identity.json";
export const BRACKET_MINUTES = 90; // a statusLine reading counts only between two SDK readings of the bound login at most this far apart
export const BIND_MAX_AGE_MINUTES = 30; // `bind` needs an SDK observation this fresh
const LOG_KEEP = 400;
const FP_RE = /^[0-9a-f]{24}$/;

function writePrivate(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};

/** Device-local random salt (created once, 0600). */
export function ensureSalt(dir) {
  const file = path.join(dir, SALT_FILE);
  const have = readSalt(dir);
  if (have) return have;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const salt = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(file, salt + "\n", { mode: 0o600, flag: "wx" });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  return readSalt(dir) ?? salt;
}
export function readSalt(dir) {
  try {
    const s = fs.readFileSync(path.join(dir, SALT_FILE), "utf8").trim();
    return /^[0-9a-f]{64}$/.test(s) ? s : null;
  } catch {
    return null;
  }
}
export const deviceTag = (salt) => crypto.createHash("sha256").update(`device|${salt}`).digest("hex").slice(0, 8);

/**
 * Fingerprint from an SDK AccountInfo. Returns { ok:true, fingerprint, device } or { ok:false, reason } (reasons are fixed words, never values).
 * Third-party providers (bedrock, vertex, gateway, ...) carry no OAuth account, so they never produce an identity.
 */
export function fingerprintOf(info, salt) {
  if (!salt) return { ok: false, reason: "no-salt" };
  if (!info || typeof info !== "object" || Array.isArray(info)) return { ok: false, reason: "no-account-info" };
  if (info.apiProvider !== undefined && info.apiProvider !== "firstParty") return { ok: false, reason: "non-first-party-provider" };
  const email = typeof info.email === "string" ? info.email.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(email)) return { ok: false, reason: "no-email" };
  const fingerprint = crypto.createHmac("sha256", salt).update(`csm-identity/v1|${email}`).digest("hex").slice(0, 24);
  return { ok: true, fingerprint, device: deviceTag(salt) };
}

// ---------------------------------------------------------------- observations (append-only, fingerprints and fixed words only)

export function recordObservation(dir, { t, identity, source = "sdk" }) {
  try {
    const file = path.join(dir, LOG_FILE);
    const entry = { t: new Date(t).toISOString(), source, fp: identity?.ok ? identity.fingerprint : null, ...(identity?.ok ? {} : { reason: String(identity?.reason ?? "not-collected").slice(0, 40) }) };
    let lines = [];
    try {
      lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    } catch {
      /* first entry */
    }
    lines.push(JSON.stringify(entry));
    writePrivate(file, lines.slice(-LOG_KEEP).join("\n") + "\n");
  } catch {
    /* logging must never break polling */
  }
}

export function readObservations(dir) {
  try {
    return fs
      .readFileSync(path.join(dir, LOG_FILE), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((o) => o && typeof o.t === "string" && !Number.isNaN(Date.parse(o.t)) && (o.fp === null || FP_RE.test(String(o.fp))))
      .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- binding (explicit owner confirmation only)

export function loadBindings(dir) {
  const d = readJson(path.join(dir, BINDING_FILE));
  if (!d || d.schema !== BINDING_SCHEMA || !Array.isArray(d.bindings)) return [];
  return d.bindings.filter((b) => b && !validateAlias(b.label) && FP_RE.test(String(b.fingerprint)));
}
export const bindingFor = (dir, label) => loadBindings(dir).find((b) => b.label === label) ?? null;

/**
 * Binds `label` to the login seen in the most recent SDK observation (must be fresh and carry a fingerprint). The caller (CLI) requires the owner's explicit
 * confirmation flag; this function refuses anything it cannot ground: no fresh observation, an observation without identity, a fingerprint already bound
 * to another label, or a different existing binding (unless force).
 */
export function bindLabel(dir, { label, now = new Date(), force = false }) {
  const aerr = validateAlias(label);
  if (aerr) throw new Error(`label: ${aerr}`);
  const last = readObservations(dir).at(-1) ?? null;
  if (!last) throw new Error("no SDK identity observation yet: run the poller once (sdk-usage-poller.mjs run --config F --live) while logged in to the account you are binding");
  if (!last.fp) throw new Error(`the latest SDK reading carried no usable identity (${last.reason ?? "unknown"}): cannot bind; the collector stays unattributed`);
  const ageMin = (now.getTime() - Date.parse(last.t)) / 60000;
  if (ageMin > BIND_MAX_AGE_MINUTES) throw new Error(`the latest identity observation is ${Math.round(ageMin)} min old (limit ${BIND_MAX_AGE_MINUTES}): poll again while logged in to the account you are binding`);
  const all = loadBindings(dir);
  const clash = all.find((b) => b.fingerprint === last.fp && b.label !== label);
  if (clash) throw new Error(`this login is already bound to ${clash.label}; one login = one label`);
  const existing = all.find((b) => b.label === label);
  if (existing && existing.fingerprint !== last.fp && !force) throw new Error(`${label} is already bound to a different login (use --force only if you are sure the owner changed accounts)`);
  const next = [...all.filter((b) => b.label !== label), { label, fingerprint: last.fp, boundAt: now.toISOString(), confirmedBy: "owner", observedAt: last.t }].map((b) => ({ ...b }));
  writePrivate(path.join(dir, BINDING_FILE), JSON.stringify({ schema: BINDING_SCHEMA, bindings: next }, null, 2) + "\n");
  return { label, boundAt: now.toISOString(), observedAt: last.t };
}

export function removeBinding(dir, label) {
  const all = loadBindings(dir);
  const next = all.filter((b) => b.label !== label);
  if (next.length === all.length) return false;
  writePrivate(path.join(dir, BINDING_FILE), JSON.stringify({ schema: BINDING_SCHEMA, bindings: next }, null, 2) + "\n");
  return true;
}

// ---------------------------------------------------------------- decisions

/** Enforcement is on once the label has a binding or the config asks for it (then "unbound" means "do not use"). */
export const enforced = ({ binding, requireIdentity }) => requireIdentity === true || Boolean(binding);

/**
 * Should an SDK reading be written under its label? `identity` is the probe's { ok, fingerprint } | { ok:false, reason } | undefined; `baseline` is the first
 * fingerprint ever seen by the unbound poller (a later different one means the login changed: we cannot know which account the new numbers belong to).
 */
export function identityVerdict({ binding, identity, baseline = null, requireIdentity = false }) {
  const fp = identity?.ok ? identity.fingerprint : null;
  if (enforced({ binding, requireIdentity })) {
    if (!binding) return { write: false, trust: "unbound", reason: "identity is required but this label has no binding" };
    if (!fp) return { write: false, trust: "no-identity", reason: identity?.reason ?? "not-collected" };
    if (fp !== binding.fingerprint) return { write: false, trust: "mismatch", reason: "the logged-in account is not the bound account" };
    return { write: true, trust: "verified", fingerprint: fp };
  }
  if (!fp) return baseline ? { write: false, trust: "identity-lost", reason: identity?.reason ?? "not-collected" } : { write: true, trust: "unknown", reason: identity?.reason ?? "not-collected" };
  if (baseline && fp !== baseline) return { write: false, trust: "switch-suspected", reason: "the logged-in account differs from the one first observed for this label" };
  return { write: true, trust: "observed-unbound", fingerprint: fp, setBaseline: baseline ? undefined : fp };
}

/**
 * statusLine trust: the stdin carries no identity, so a statusLine reading at time t counts only when the SDK observations just before and just after t both
 * show the bound login (adjacent in the log, at most BRACKET_MINUTES apart). Anything else is untrusted.
 */
export function statuslineTrust({ observedAt, binding, observations }) {
  if (!binding) return { use: false, trust: "unbound", reason: "no identity binding" };
  const t = Date.parse(observedAt);
  if (Number.isNaN(t)) return { use: false, trust: "unbound", reason: "bad timestamp" };
  let before = null;
  let after = null;
  for (const o of observations) {
    const ot = Date.parse(o.t);
    if (ot <= t) before = o;
    else {
      after = o;
      break;
    }
  }
  if (!before || !after) return { use: false, trust: "unbound", reason: before ? "waiting for the next SDK identity reading" : "no SDK identity reading before it" };
  if (before.fp !== binding.fingerprint || after.fp !== binding.fingerprint) return { use: false, trust: "unbound", reason: "an adjacent SDK reading shows another or unknown login" };
  if (Date.parse(after.t) - Date.parse(before.t) > BRACKET_MINUTES * 60000) return { use: false, trust: "unbound", reason: "the SDK readings around it are too far apart" };
  return { use: true, trust: "bracketed", reason: null };
}

/**
 * Decides which source files in `sourceDir` may be ingested for `label`. Not enforced (no binding, requireIdentity off) = legacy behaviour: everything is used and
 * marked "legacy-unverified". Enforced: the SDK file needs a matching verified sidecar; the statusLine file needs the bracket rule.
 */
export function gateSourceFiles({ sourceDir, label, requireIdentity = false }) {
  const binding = bindingFor(sourceDir, label);
  const on = enforced({ binding, requireIdentity });
  const out = { enforced: on, bound: Boolean(binding), files: {} };
  if (!on) {
    out.files["sdk-quota-latest.json"] = { use: true, trust: "legacy-unverified" };
    out.files["quota-latest.json"] = { use: true, trust: "legacy-unverified" };
    return out;
  }
  const sdk = readJson(path.join(sourceDir, "sdk-quota-latest.json"));
  const side = readJson(path.join(sourceDir, SDK_IDENTITY_SIDECAR));
  if (!binding) out.files["sdk-quota-latest.json"] = { use: false, trust: "unbound", reason: "no identity binding" };
  else if (!sdk || !side) out.files["sdk-quota-latest.json"] = { use: false, trust: "unbound", reason: "no identity record for this reading" };
  else if (side.trust !== "verified" || side.fingerprint !== binding.fingerprint || side.observedAt !== sdk.observedAt || side.label !== label) out.files["sdk-quota-latest.json"] = { use: false, trust: "unbound", reason: "the reading is not covered by a verified identity record" };
  else out.files["sdk-quota-latest.json"] = { use: true, trust: "verified" };
  const sl = readJson(path.join(sourceDir, "quota-latest.json"));
  out.files["quota-latest.json"] = sl ? { ...statuslineTrust({ observedAt: sl.observedAt, binding, observations: readObservations(sourceDir) }) } : { use: false, trust: "unbound", reason: "no statusLine file" };
  return out;
}

/** Read-only summary for doctors/readiness. */
export function summarizeIdentity({ dir, label, requireIdentity = false, now = new Date() }) {
  const last = readObservations(dir).at(-1) ?? null;
  // No label given: use the binding that matches the last observed login; with no match, the single/first binding (so a foreign login reads MISMATCH, never UNBOUND).
  const all = loadBindings(dir);
  const binding = label ? bindingFor(dir, label) : (all.find((b) => last?.fp && b.fingerprint === last.fp) ?? all[0] ?? null);
  label = label ?? binding?.label ?? null;
  const ageMinutes = last ? Math.max(0, Math.round((now.getTime() - Date.parse(last.t)) / 60000)) : null;
  let state;
  if (!last) state = binding ? "BOUND_NO_OBSERVATION" : "NO_OBSERVATION";
  else if (!last.fp) state = "NO_IDENTITY";
  else if (!binding) state = "UNBOUND";
  else state = last.fp === binding.fingerprint ? "VERIFIED" : "MISMATCH";
  return { state, label, enforced: enforced({ binding, requireIdentity }), bound: Boolean(binding), lastObservationMinutesAgo: ageMinutes, reason: last && !last.fp ? last.reason ?? null : null };
}
