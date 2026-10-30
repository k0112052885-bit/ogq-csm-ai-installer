// Employee-side installer engine (driven by scripts/employee-install.mjs, which an AI agent runs step by step on the employee's own Mac).
// What it does: verifies the package, installs a private copy of the code under one folder (default ~/.ogq-csm), links the employee's Claude login to the account label
// (device-local fingerprint only), enrolls the device with the admin through a FILE HANDOFF, and - only on explicit permission - installs two launchd agents that keep
// the usage reading fresh and produce signed reading files. What it never does: contact the admin or any server, send Slack messages, read or write Claude settings
// or credentials, hold any admin secret or signing key, or install anything without a named consent. Enrollment is NEVER automatic: the device stays
// PENDING_ADMIN_APPROVAL until the admin approves it and the signed approval file comes back (by hand, or through an optional shared drop folder).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deliverReading, fetchApproval, submitEnrollment, validateIngestUrl } from "./fleet-client.mjs";
import { enrollDevice, finalizeApproval, loadDevice, makeReading } from "./fleet-device.mjs";
import { bindLabel, summarizeIdentity } from "./identity.mjs";
import { observeIdentity } from "./identity-observe.mjs";
import { MANIFEST_FILE, verifyManifest } from "./package-manifest.mjs";
import { defaultConfig, pollerPaths, summarizePoller, validateConfig } from "./sdk-poller.mjs";
import { REFERENCE_VERSION, sdkPreflight } from "./sdk-preflight.mjs";

export const CONFIG_SCHEMA = "csm-employee-config/v1";
export const LABELS = { poll: "com.ogq.csm.employee.poll", tick: "com.ogq.csm.employee.tick" };
export const POLL_MINUTES = 15;
export const TICK_MINUTES = 30;
export const SCRIPT = "scripts/employee-install.mjs";
export const CONSENTS = {
  install: "Copy the package code into a private folder in your home directory (nothing outside it is changed)?",
  sdk: "Download the pinned Claude Agent SDK 0.3.301 from the npm registry into that folder (needs internet)?",
  observe: "Make ONE identity-only call to the Claude SDK to see which Claude account is logged in on this Mac? (No prompt is sent, no usage request, your e-mail is never stored: only a salted fingerprint.)",
  bind: "Is the Claude account that is logged in on THIS Mac right now the one you want counted for this subscription?",
  enroll: "Create a signing key that stays on this Mac and an enrollment request file for the admin (public key + login fingerprint only)?",
  configure: "Save the shared hand-off folder / ingest address / auto-accept setting you were given?",
  transport: "Send your enrollment request and, once approved, your signed usage readings (percentages and reset times only) to the dashboard address in your settings? Nothing else is sent, and it stays pending until the admin approves.",
  agents: "Install two background agents (launchd) that run when you log in or restart: one asks the Claude SDK for your plan usage (no prompt is sent) every 15 minutes, one writes signed usage reading files every 30 minutes?",
  update: "Replace the installed code with the newer verified package (your key, login link and settings stay)?",
  uninstall: "Remove the background agents and the installed code?",
};

export class NeedsConsent extends Error {
  constructor(id) {
    super(`consent required: ${id}`);
    this.consent = id;
    this.question = CONSENTS[id];
  }
}

export const defaultRoot = () => path.join(os.homedir(), ".ogq-csm");
export function layout(root) {
  const j = (...p) => path.join(root, ...p);
  return { root, app: j("app"), data: j("data"), device: j("device"), outbox: j("outbox"), readings: j("outbox", "readings"), inbox: j("inbox"), logs: j("logs"), launchd: j("launchd"), private: j("private"), config: j("config.json"), health: j("health.json"), installState: j("install.json"), transport: j("transport.json") };
}

/** ctx: { root, consent: {id: true}, now, platform, execPath, run(cmd, args, opts) -> {status, stdout, stderr}, uid, agentsDir } */
export function makeCtx(o = {}) {
  return {
    root: path.resolve(o.root ?? defaultRoot()),
    consent: o.consent ?? {},
    now: o.now ?? new Date(),
    platform: o.platform ?? process.platform,
    execPath: o.execPath ?? process.execPath,
    uid: o.uid ?? (typeof process.getuid === "function" ? process.getuid() : 501),
    home: path.resolve(o.home ?? os.homedir()),
    agentsDir: path.resolve(o.agentsDir ?? path.join(o.home ?? os.homedir(), "Library", "LaunchAgents")),
    run: o.run ?? realRun,
    fetch: o.fetch ?? globalThis.fetch,
  };
}
async function realRun(cmd, args, opts = {}) {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd: opts.cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** The SDK that THIS install owns (app/node_modules/...); never an SDK found somewhere above the install folder. */
function sdkAt(app) {
  const dir = path.join(app, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  return fs.existsSync(path.join(dir, "package.json")) ? sdkPreflight({ packageDir: dir }) : { installed: false, version: null, compat: { ok: false, reasons: ["SDK not installed"] } };
}

const need = (ctx, id) => {
  if (ctx.consent?.[id] !== true) throw new NeedsConsent(id);
};
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};
function writePrivate(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const mkdirs = (...dirs) => dirs.forEach((d) => fs.mkdirSync(d, { recursive: true, mode: 0o700 }));
const copyTree = (from, to) => fs.cpSync(from, to, { recursive: true, force: true });

// ------------------------------------------------------------------ preflight (read-only)

// A code-only package (published repository) has no invite.json/package-config.json: the owner hands those over privately as a device kit (--kit-dir).
const kitOf = (packageDir, kitDir) => (kitDir ? path.resolve(kitDir) : packageDir);

export function preflight({ packageDir, kitDir = null, expectFingerprint = null, ctx }) {
  const checks = [];
  const add = (id, ok, detail, level = "required") => checks.push({ id, ok, detail, level });
  const major = Number(process.versions.node.split(".")[0]);
  add("node", major >= 20, `Node ${process.versions.node} (20 or newer needed)`);
  add("platform", ctx.platform === "darwin", ctx.platform === "darwin" ? "macOS: launchd agents are available" : `${ctx.platform}: background agents cannot be installed (manual runs only)`, "agents");
  const v = verifyManifest(packageDir);
  add("package-integrity", v.ok, v.ok ? `${Object.keys(v.manifest.files).length} files verified against MANIFEST.json` : v.problems.slice(0, 5).join("; "));
  if (expectFingerprint) add("fingerprint", v.fingerprint === String(expectFingerprint).toLowerCase(), v.fingerprint === String(expectFingerprint).toLowerCase() ? "matches the fingerprint the admin gave you" : "does NOT match the fingerprint the admin gave you: do not continue");
  else add("fingerprint", true, `package fingerprint ${v.fingerprint ?? "n/a"} - compare it with what the admin told you through another channel`, "info");
  const kit = kitOf(packageDir, kitDir);
  const invite = readJson(path.join(kit, "invite.json"));
  const inviteOk = Boolean(invite) && invite.schema === "csm-fleet-invite/v1" && Date.parse(invite.expiresAt) > ctx.now.getTime();
  add("invite", inviteOk, inviteOk ? `enrollment invite valid until ${invite.expiresAt}` : invite ? "the enrollment invite has expired: ask the admin for a new package" : "invite.json missing or unreadable (a code-only package needs the owner's private device kit: pass --kit-dir)");
  const kitCfg = readJson(path.join(kit, "package-config.json"));
  const kitOk = Boolean(kitCfg?.label) && Boolean(kitCfg?.accountId) && (!invite || kitCfg.accountId === invite.accountId);
  add("device-config", kitOk, kitOk ? `device settings for ${kitCfg.label}` : "package-config.json missing, incomplete, or for a different account than the invite");
  let anc = ctx.root;
  while (!fs.existsSync(anc) && path.dirname(anc) !== anc) anc = path.dirname(anc);
  let writable = true;
  try {
    fs.accessSync(anc, fs.constants.W_OK);
  } catch {
    writable = false;
  }
  add("home-writable", writable, writable ? `can create ${ctx.root}` : `cannot write under ${anc}`);
  const sdk = sdkAt(layout(ctx.root).app);
  add("sdk", sdk.installed, sdk.installed ? `SDK ${sdk.version} present` : "SDK not installed yet (a later step installs the pinned version)", "later");
  return { ok: checks.filter((c) => c.level === "required").every((c) => c.ok), checks, fingerprint: v.fingerprint, version: v.manifest?.version ?? null };
}

// ------------------------------------------------------------------ install / sdk / login / enroll / finalize / configure

export function installApp({ packageDir, kitDir = null, ctx }) {
  need(ctx, "install");
  const v = verifyManifest(packageDir);
  if (!v.ok) throw new Error(`package integrity check failed: ${v.problems.slice(0, 3).join("; ")}`);
  const L = layout(ctx.root);
  if (path.resolve(packageDir) === L.app) throw new Error("run install from the package folder you were given, not from the installed copy");
  const before = readJson(path.join(L.app, MANIFEST_FILE));
  mkdirs(L.root, L.data, L.outbox, L.readings, L.inbox, L.logs, L.launchd, L.private, L.app);
  for (const rel of Object.keys(v.manifest.files)) {
    if (rel === "invite.json") continue; // the one-time invite goes to the private folder only
    const dest = path.join(L.app, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(packageDir, rel), dest);
    fs.chmodSync(dest, 0o644);
  }
  fs.copyFileSync(path.join(packageDir, MANIFEST_FILE), path.join(L.app, MANIFEST_FILE));
  const kit = kitOf(packageDir, kitDir);
  const cfg = readJson(path.join(kit, "package-config.json"));
  if (!cfg?.label || !cfg?.accountId) throw new Error("package-config.json is missing label/accountId");
  const invitePath = path.join(L.private, "invite.json");
  if (!loadDevice(L.device) && !fs.existsSync(invitePath)) {
    fs.copyFileSync(path.join(kit, "invite.json"), invitePath);
    fs.chmodSync(invitePath, 0o600);
  }
  if (!readJson(L.config)) writePrivate(L.config, { schema: CONFIG_SCHEMA, label: cfg.label, accountId: cfg.accountId, packageVersion: v.manifest.version, installedAt: ctx.now.toISOString(), dropDir: cfg.dropDir ?? null, autoFinalize: false, ingestUrl: cfg.ingestUrl ? validateIngestUrl(cfg.ingestUrl) : null, transportEnabled: false });
  const pc = pollerPaths(L.data).config;
  if (!readJson(pc)) writePrivate(pc, defaultConfig({ account: cfg.label, dir: L.data, intervalMinutes: POLL_MINUTES, enabled: false }));
  writePrivate(L.installState, { installedAt: readJson(L.installState)?.installedAt ?? ctx.now.toISOString(), updatedAt: ctx.now.toISOString(), version: v.manifest.version, fingerprint: v.fingerprint });
  return { installed: true, alreadyInstalled: Boolean(before), version: v.manifest.version, fingerprint: v.fingerprint, appDir: L.app, entry: path.join(L.app, SCRIPT) };
}

export async function installSdk({ ctx, from = null }) {
  need(ctx, "sdk");
  const L = layout(ctx.root);
  if (!fs.existsSync(path.join(L.app, MANIFEST_FILE))) throw new Error("install the package first");
  if (from) copyTree(path.resolve(from), path.join(L.app, "node_modules", "@anthropic-ai", "claude-agent-sdk"));
  else {
    const r = await ctx.run("npm", ["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", L.app, `@anthropic-ai/claude-agent-sdk@${REFERENCE_VERSION}`], { cwd: L.app });
    if (r.status !== 0) throw new Error(`npm install failed: ${String(r.stderr).replace(/\s+/g, " ").slice(0, 200)}`);
  }
  const pre = sdkAt(L.app);
  return { installed: pre.installed, version: pre.version, pinnedMatches: pre.version === REFERENCE_VERSION, compatible: pre.compat.ok };
}

export async function observeLogin({ ctx, live = false, preflight: pf, probe }) {
  if (live) need(ctx, "observe");
  const L = layout(ctx.root);
  const config = readJson(pollerPaths(L.data).config);
  if (!config) throw new Error("install the package first");
  return observeIdentity({ config, now: ctx.now, live, ...(pf ? { preflight: pf } : {}), ...(probe ? { probe } : {}) });
}

export function bindLogin({ ctx }) {
  need(ctx, "bind");
  const L = layout(ctx.root);
  const cfg = readJson(L.config);
  if (!cfg) throw new Error("install the package first");
  return bindLabel(L.data, { label: cfg.label, now: ctx.now });
}

export function enroll({ ctx }) {
  need(ctx, "enroll");
  const L = layout(ctx.root);
  const cfg = readJson(L.config);
  const invite = readJson(path.join(L.private, "invite.json"));
  if (!cfg) throw new Error("install the package first");
  if (loadDevice(L.device)) throw new Error("this device is already enrolled");
  if (!invite) throw new Error("the enrollment invite is not in the private folder (was it already used?)");
  const { request, sas } = enrollDevice({ deviceDir: L.device, invite, sourceDir: L.data, label: cfg.label, now: ctx.now });
  const requestFile = path.join(L.outbox, "enroll-request.json");
  writePrivate(requestFile, request);
  fs.rmSync(path.join(L.private, "invite.json"), { force: true }); // the one-time code has done its job
  writePrivate(L.installState, { ...(readJson(L.installState) ?? {}), enrolledAt: ctx.now.toISOString(), verificationCode: sas, deviceId: invite.deviceId });
  return { state: "PENDING_ADMIN_APPROVAL", requestFile, verificationCode: sas, deviceId: invite.deviceId };
}

function findApproval(ctx, explicit) {
  const L = layout(ctx.root);
  const dev = loadDevice(L.device);
  const cfg = readJson(L.config);
  const candidates = [explicit, path.join(L.inbox, "approval.json"), cfg?.dropDir && dev ? path.join(cfg.dropDir, "approvals", `${dev.deviceId}.json`) : null].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

export function finalize({ ctx, approvalFile = null }) {
  const L = layout(ctx.root);
  const file = findApproval(ctx, approvalFile ? path.resolve(approvalFile) : null);
  if (!file) return { state: "PENDING_ADMIN_APPROVAL", approved: false, hint: "no approval file yet: the admin must approve this device and send approval.json back (put it in the inbox folder, or into the shared hand-off folder)" };
  const r = finalizeApproval({ deviceDir: L.device, approval: JSON.parse(fs.readFileSync(file, "utf8")) });
  if (path.dirname(file) === L.inbox) {
    fs.mkdirSync(path.join(L.inbox, "processed"), { recursive: true });
    fs.renameSync(file, path.join(L.inbox, "processed", `approval-${ctx.now.getTime()}.json`));
  }
  return { state: "APPROVED", approved: true, deviceId: r.deviceId, accountId: r.accountId };
}

export function configure({ ctx, dropDir, autoFinalize, ingestUrl }) {
  need(ctx, "configure");
  const L = layout(ctx.root);
  const cfg = readJson(L.config);
  if (!cfg) throw new Error("install the package first");
  if (dropDir !== undefined && dropDir !== null && !path.isAbsolute(dropDir)) throw new Error("the hand-off folder must be an absolute path");
  const url = ingestUrl === undefined ? undefined : ingestUrl === null ? null : validateIngestUrl(ingestUrl); // https only (plain http: localhost tests)
  // a CHANGED ingest address starts switched off: sending to a new address needs the transport consent again
  const next = { ...cfg, ...(dropDir !== undefined ? { dropDir } : {}), ...(autoFinalize !== undefined ? { autoFinalize: autoFinalize === true } : {}), ...(url !== undefined ? { ingestUrl: url, transportEnabled: url === cfg.ingestUrl ? cfg.transportEnabled === true : false } : {}) };
  writePrivate(L.config, next);
  return { dropDir: next.dropDir, autoFinalize: next.autoFinalize, ...(url !== undefined ? { ingestUrl: next.ingestUrl, transportEnabled: next.transportEnabled === true } : {}) };
}

/** Switches the network transport on. Needs the named consent and an ingest address already in the settings; nothing is sent before this. */
export function enableTransport({ ctx }) {
  need(ctx, "transport");
  const L = layout(ctx.root);
  const cfg = readJson(L.config);
  if (!cfg) throw new Error("install the package first");
  if (!cfg.ingestUrl) throw new Error("no ingest address is configured (the package had none: ask the admin, then run configure --ingest-url)");
  writePrivate(L.config, { ...cfg, transportEnabled: true });
  return { ingestUrl: cfg.ingestUrl, transportEnabled: true };
}

const DELIVER_PER_TICK = 50;
/**
 * Network part of a report cycle (async; the file-based tick above is unchanged). Only when the transport was consented to. Order: submit the enrollment request once (the device
 * then waits for the admin), pick up the signed approval (only with the explicit auto-accept setting; otherwise `finalize` does it on request), deliver queued readings. Network
 * trouble keeps everything queued for the next cycle; a permanent rejection by the server is recorded and never retried.
 */
export async function syncRemote({ ctx }) {
  const L = layout(ctx.root);
  const cfg = readJson(L.config);
  const out = { enabled: false, requestSent: false, approved: false, delivered: 0, queued: 0, rejected: 0, error: null };
  if (!cfg?.ingestUrl || cfg.transportEnabled !== true) return out;
  out.enabled = true;
  const dev = loadDevice(L.device);
  if (!dev) return out;
  const tx = readJson(L.transport) ?? { requestSent: false, delivered: [], rejected: [] };
  try {
    const base = validateIngestUrl(cfg.ingestUrl);
    const opts = { fetchImpl: ctx.fetch };
    if (!dev.approved) {
      const req = readJson(path.join(L.outbox, "enroll-request.json"));
      if (!tx.requestSent && req) {
        const r = await submitEnrollment(base, req, opts);
        if (r.ok || (r.status === 400 && /already used|already registered/.test(String(r.body?.error)))) {
          tx.requestSent = true; // accepted into the admin's queue (or an earlier attempt already was)
          out.requestSent = r.ok;
        } else out.error = r.error ?? `enrollment answered ${r.status}`;
      }
      if (cfg.autoFinalize === true) {
        const a = await fetchApproval(base, dev.deviceId, opts);
        if (a.ok && a.body?.status === "approved") {
          finalizeApproval({ deviceDir: L.device, approval: a.body.approval }); // verified against the aggregator key from the invite: a forged answer throws
          out.approved = true;
        }
      }
    }
    if (loadDevice(L.device)?.approved && fs.existsSync(L.readings)) {
      const files = fs.readdirSync(L.readings).filter((n) => n.endsWith(".json")).sort().filter((n) => !tx.delivered.includes(n) && !tx.rejected.includes(n));
      let stopped = false;
      for (const name of files.slice(0, DELIVER_PER_TICK)) {
        if (stopped) break;
        const env = readJson(path.join(L.readings, name));
        if (!env) {
          tx.rejected.push(name);
          out.rejected++;
          continue;
        }
        const r = await deliverReading(base, env, opts);
        if (r.ok || r.status === 409) {
          tx.delivered.push(name); // accepted, or the server already has it (replay)
          out.delivered++;
        } else if (r.retry) {
          stopped = true; // offline or server trouble: keep the rest queued
          out.error = r.error ?? `server answered ${r.status}`;
        } else {
          tx.rejected.push(name); // the server judged it unacceptable (e.g. revoked device, login changed): retrying would not help
          out.rejected++;
          out.error = `server rejected ${name}: ${String(r.body?.reason ?? r.status).slice(0, 40)}`;
        }
      }
      out.queued = fs.readdirSync(L.readings).filter((n) => n.endsWith(".json") && !tx.delivered.includes(n) && !tx.rejected.includes(n)).length;
    }
  } catch (e) {
    out.error = String(e.message).slice(0, 100);
  }
  tx.delivered = tx.delivered.slice(-500);
  tx.rejected = tx.rejected.slice(-500);
  writePrivate(L.transport, tx);
  const health = readJson(L.health) ?? {};
  writePrivate(L.health, { ...health, remote: out });
  return out;
}

/** `finalize` over the network: asks the server whether this device was approved and accepts the signed approval (verified; a wrong signature throws). */
export async function finalizeRemote({ ctx }) {
  const L = layout(ctx.root);
  const cfg = readJson(L.config);
  const dev = loadDevice(L.device);
  if (!cfg?.ingestUrl || cfg.transportEnabled !== true || !dev) return { state: "PENDING_ADMIN_APPROVAL", approved: false };
  const a = await fetchApproval(validateIngestUrl(cfg.ingestUrl), dev.deviceId, { fetchImpl: ctx.fetch });
  if (a.ok && a.body?.status === "approved") {
    const r = finalizeApproval({ deviceDir: L.device, approval: a.body.approval });
    return { state: "APPROVED", approved: true, deviceId: r.deviceId, accountId: r.accountId };
  }
  return { state: "PENDING_ADMIN_APPROVAL", approved: false, serverStatus: a.body?.status ?? (a.error ?? `answered ${a.status}`) };
}

// ------------------------------------------------------------------ tick (what the background agent runs; also safe to run by hand)

export function tick({ ctx }) {
  const L = layout(ctx.root);
  const cfg = readJson(L.config);
  const result = { at: ctx.now.toISOString(), finalized: false, reading: null, handedOff: 0, errors: [] };
  if (!cfg) return { ...result, errors: ["not installed"] };
  let dev = loadDevice(L.device);
  try {
    if (dev && !dev.approved && cfg.autoFinalize === true) {
      const r = finalize({ ctx });
      result.finalized = r.approved === true;
      dev = loadDevice(L.device);
    }
    if (dev?.approved) {
      const r = makeReading({ deviceDir: L.device, sourceDir: L.data, now: ctx.now });
      if (r.envelope) {
        const file = path.join(L.readings, `${r.envelope.payload.deviceId}-${String(r.envelope.payload.seq).padStart(6, "0")}.json`);
        writePrivate(file, r.envelope);
        result.reading = { seq: r.envelope.payload.seq, file: path.basename(file) };
      } else result.reading = { skipped: r.skipped };
    }
    if (cfg.dropDir && dev) {
      try {
        const dest = path.join(cfg.dropDir, "readings");
        fs.mkdirSync(dest, { recursive: true });
        for (const f of fs.existsSync(L.readings) ? fs.readdirSync(L.readings).filter((n) => n.endsWith(".json")).sort() : []) {
          const target = path.join(dest, f);
          if (!fs.existsSync(target)) {
            fs.copyFileSync(path.join(L.readings, f), `${target}.tmp`);
            fs.renameSync(`${target}.tmp`, target);
            result.handedOff++;
          }
        }
        const req = path.join(L.outbox, "enroll-request.json");
        const reqDest = path.join(cfg.dropDir, "requests", `${dev.deviceId}.json`);
        if (!dev.approved && fs.existsSync(req) && !fs.existsSync(reqDest)) {
          fs.mkdirSync(path.dirname(reqDest), { recursive: true });
          fs.copyFileSync(req, reqDest);
        }
      } catch (e) {
        result.errors.push(`hand-off folder: ${String(e.message).slice(0, 80)}`);
      }
    }
  } catch (e) {
    result.errors.push(String(e.message).slice(0, 120));
  }
  writePrivate(L.health, result);
  return result;
}

// ------------------------------------------------------------------ launchd agents (only after explicit consent; injectable runner)

function plistText({ label, args, seconds, logFile, env }) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>${seconds}</integer>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${esc(env.PATH)}</string><key>HOME</key><string>${esc(env.HOME)}</string></dict>
  <key>StandardOutPath</key><string>${esc(logFile)}</string>
  <key>StandardErrorPath</key><string>${esc(logFile)}</string>
</dict>
</plist>
`;
}

export function agentFiles(ctx) {
  const L = layout(ctx.root);
  const home = ctx.home;
  const env = { HOME: home, PATH: [path.dirname(ctx.execPath), path.join(home, ".local", "bin"), path.join(home, ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":") };
  return {
    [`${LABELS.poll}.plist`]: plistText({ label: LABELS.poll, seconds: POLL_MINUTES * 60, logFile: path.join(L.logs, "poll.log"), env, args: [ctx.execPath, path.join(L.app, "scripts", "employee-poll.mjs"), "--config", pollerPaths(L.data).config] }),
    [`${LABELS.tick}.plist`]: plistText({ label: LABELS.tick, seconds: TICK_MINUTES * 60, logFile: path.join(L.logs, "tick.log"), env, args: [ctx.execPath, path.join(L.app, SCRIPT), "tick", "--root", L.root] }),
  };
}

export async function installAgents({ ctx }) {
  need(ctx, "agents");
  if (ctx.platform !== "darwin") throw new Error("background agents need macOS (launchd)");
  const L = layout(ctx.root);
  if (!fs.existsSync(path.join(L.app, MANIFEST_FILE))) throw new Error("install the package first");
  if (!loadDevice(L.device)) throw new Error("enroll this device first (the agents only report for an enrolled device)");
  const files = agentFiles(ctx);
  fs.mkdirSync(ctx.agentsDir, { recursive: true });
  const poller = readJson(pollerPaths(L.data).config);
  if (!poller || !validateConfig(poller).ok) throw new Error("the poller config is missing or invalid");
  writePrivate(pollerPaths(L.data).config, { ...poller, enabled: true }); // the consent covers turning the usage poll on
  const loaded = [];
  for (const [name, text] of Object.entries(files)) {
    writePrivate(path.join(L.launchd, name), text);
    const target = path.join(ctx.agentsDir, name);
    fs.writeFileSync(target, text, { mode: 0o644 });
    await ctx.run("launchctl", ["bootout", `gui/${ctx.uid}`, target]); // idempotent: replace a loaded copy; "not loaded" is fine
    const r = await ctx.run("launchctl", ["bootstrap", `gui/${ctx.uid}`, target]);
    if (r.status !== 0) throw new Error(`launchctl bootstrap failed for ${name}: ${String(r.stderr).replace(/\s+/g, " ").slice(0, 120)}`);
    loaded.push(name.replace(/\.plist$/, ""));
  }
  writePrivate(L.installState, { ...(readJson(L.installState) ?? {}), agents: { installedAt: ctx.now.toISOString(), labels: loaded } });
  return { agents: loaded, dir: ctx.agentsDir };
}

export async function agentStatus(ctx) {
  const out = {};
  for (const label of Object.values(LABELS)) {
    const plist = fs.existsSync(path.join(ctx.agentsDir, `${label}.plist`));
    let loaded = false;
    if (plist && ctx.platform === "darwin") loaded = (await ctx.run("launchctl", ["print", `gui/${ctx.uid}/${label}`])).status === 0;
    out[label] = { plist, loaded };
  }
  return out;
}

// ------------------------------------------------------------------ status / next / update / uninstall

const minutesAgo = (iso, now) => (iso && !Number.isNaN(Date.parse(iso)) ? Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60000)) : null);

export async function status({ ctx }) {
  const L = layout(ctx.root);
  const cfg = readJson(L.config);
  const installed = fs.existsSync(path.join(L.app, MANIFEST_FILE)) && Boolean(cfg);
  const out = { phase: "NOT_INSTALLED", pending: null, root: ctx.root, version: readJson(L.installState)?.version ?? null, warnings: [] };
  if (!installed) return { ...out, next: nextStep("NOT_INSTALLED") };
  const sdk = sdkAt(L.app);
  const id = summarizeIdentity({ dir: L.data, label: cfg.label, now: ctx.now });
  const dev = loadDevice(L.device);
  const agents = await agentStatus(ctx);
  const agentsOn = Object.values(agents).every((a) => a.plist && a.loaded);
  let phase;
  if (!sdk.installed) phase = "NEEDS_SDK";
  else if (!dev && id.state === "NO_OBSERVATION") phase = "NEEDS_LOGIN_OBSERVE";
  else if (!dev && !id.bound) phase = id.state === "NO_IDENTITY" ? "LOGIN_NOT_IDENTIFIABLE" : "NEEDS_LOGIN_BIND";
  else if (!dev) phase = "NEEDS_ENROLL";
  else if (!dev.approved) phase = "PENDING_ADMIN_APPROVAL";
  else phase = agentsOn ? "RUNNING" : "APPROVED_NO_AGENTS";
  const health = readJson(L.health);
  const poller = summarizePoller(L.data, ctx.now);
  const snap = readJson(path.join(L.data, "sdk-quota-latest.json"));
  const readingsOut = fs.existsSync(L.readings) ? fs.readdirSync(L.readings).filter((n) => n.endsWith(".json")).length : 0;
  if (phase === "RUNNING") {
    const age = minutesAgo(snap?.observedAt, ctx.now);
    if (age === null || age > 180) warn(out, `usage reading is ${age === null ? "missing" : `${age} min old`}: check the poll agent log (${path.join(L.logs, "poll.log")})`);
    if (id.state === "MISMATCH") warn(out, "the logged-in Claude account is not the one linked to this device: readings are paused until you log back in");
    const t = minutesAgo(health?.at, ctx.now);
    if (t === null || t > 120) warn(out, `the report agent has not run for ${t === null ? "a long time" : `${t} min`}`);
  }
  if (cfg.dropDir && !fs.existsSync(cfg.dropDir)) warn(out, "the shared hand-off folder is not reachable right now");
  const base = { ...out, phase, label: cfg.label, accountId: cfg.accountId, sdk: { installed: sdk.installed, version: sdk.version, compatible: sdk.compat.ok }, identity: { state: id.state, bound: id.bound, lastObservationMinutesAgo: id.lastObservationMinutesAgo }, device: dev ? { deviceId: dev.deviceId, approved: Boolean(dev.approved), lastSeq: dev.seq } : null, agents, poller: { enabled: poller.enabled, lastSuccessMinutesAgo: poller.lastSuccessMinutesAgo, identityTrust: poller.identityTrust }, outbox: { readingFiles: readingsOut, dropDir: cfg.dropDir ?? null, autoFinalize: cfg.autoFinalize === true }, lastTick: health ? { at: health.at, errors: health.errors } : null };
  const tx = readJson(L.transport) ?? { requestSent: false, delivered: [], rejected: [] };
  const queued = fs.existsSync(L.readings) ? fs.readdirSync(L.readings).filter((n) => n.endsWith(".json") && !tx.delivered.includes(n) && !tx.rejected.includes(n)).length : 0;
  base.transport = { ingestUrl: cfg.ingestUrl ?? null, enabled: cfg.transportEnabled === true, requestSent: tx.requestSent === true, delivered: tx.delivered.length, rejected: tx.rejected.length, queued, lastError: health?.remote?.error ?? null };
  if (cfg.ingestUrl && cfg.transportEnabled !== true && ["PENDING_ADMIN_APPROVAL", "APPROVED_NO_AGENTS", "RUNNING"].includes(phase)) base.transportNext = { command: `node ${SCRIPT} enable-transport --consent-transport`, consent: "transport", question: CONSENTS.transport };
  if (cfg.transportEnabled === true && queued > 0 && phase === "RUNNING") warn(base, `${queued} reading(s) are waiting to be delivered${base.transport.lastError ? ` (${base.transport.lastError})` : ""}`);
  if (phase === "PENDING_ADMIN_APPROVAL") base.pending = { what: "the admin must approve this device", verificationCode: readJson(L.installState)?.verificationCode ?? null, requestFile: path.join(L.outbox, "enroll-request.json"), approvalGoesTo: path.join(L.inbox, "approval.json") };
  return { ...base, next: nextStep(phase) };
}
const warn = (o, m) => o.warnings.push(m);

export function nextStep(phase) {
  const e = (command, consent = null) => ({ command: `node ${SCRIPT} ${command}`, consent, question: consent ? CONSENTS[consent] : null });
  switch (phase) {
    case "NOT_INSTALLED":
      return e("install --consent-install", "install");
    case "NEEDS_SDK":
      return e("sdk --consent-sdk", "sdk");
    case "NEEDS_LOGIN_OBSERVE":
      return e("observe --consent-observe", "observe");
    case "NEEDS_LOGIN_BIND":
      return e("bind --consent-bind", "bind");
    case "LOGIN_NOT_IDENTIFIABLE":
      return { command: null, consent: null, question: null, note: "this Claude login exposes no e-mail the SDK can fingerprint (for example a non-first-party provider): it cannot be linked; stop and tell the admin" };
    case "NEEDS_ENROLL":
      return e("enroll --consent-enroll", "enroll");
    case "PENDING_ADMIN_APPROVAL":
      return { command: `node ${SCRIPT} finalize`, consent: null, question: null, note: "WAITING FOR THE ADMIN. Hand enroll-request.json and the verification code to the admin; when approval.json comes back, put it in the inbox folder (or pass --approval FILE) and run this command again." };
    case "APPROVED_NO_AGENTS":
      return e("install-agents --consent-agents", "agents");
    case "RUNNING":
      return { command: `node ${SCRIPT} status`, consent: null, question: null, note: "Installed and running. Nothing else to do; readings are written to the outbox for the admin." };
    default:
      return { command: null, consent: null, question: null };
  }
}

export function update({ ctx, packageDir }) {
  need(ctx, "update");
  const L = layout(ctx.root);
  const cur = readJson(path.join(L.app, MANIFEST_FILE));
  if (!cur) throw new Error("nothing is installed");
  const v = verifyManifest(packageDir);
  if (!v.ok) throw new Error(`package integrity check failed: ${v.problems.slice(0, 3).join("; ")}`);
  const cfgOld = readJson(L.config);
  const cfgNew = readJson(path.join(packageDir, "package-config.json"));
  const codeOnly = !v.manifest.files["package-config.json"]; // a published code-only package carries no account: the installed settings stay as they are
  if (!codeOnly && (cfgNew?.accountId !== cfgOld?.accountId || cfgNew?.label !== cfgOld?.label)) throw new Error("this package is for a different account/label: refusing to update");
  // replace the code but keep keys, login link, settings and the poller config
  fs.rmSync(path.join(L.app, "scripts"), { recursive: true, force: true });
  fs.rmSync(path.join(L.app, "src"), { recursive: true, force: true });
  for (const rel of Object.keys(v.manifest.files)) {
    if (rel === "invite.json" || rel === "package-config.json") continue;
    const dest = path.join(L.app, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(packageDir, rel), dest);
    fs.chmodSync(dest, 0o644);
  }
  fs.copyFileSync(path.join(packageDir, MANIFEST_FILE), path.join(L.app, MANIFEST_FILE));
  writePrivate(L.installState, { ...(readJson(L.installState) ?? {}), updatedAt: ctx.now.toISOString(), version: v.manifest.version, fingerprint: v.fingerprint });
  writePrivate(L.config, { ...cfgOld, packageVersion: v.manifest.version });
  return { updated: true, from: cur.version, to: v.manifest.version, fingerprint: v.fingerprint };
}

export async function uninstall({ ctx, purge = false }) {
  need(ctx, "uninstall");
  const L = layout(ctx.root);
  const removed = [];
  for (const label of Object.values(LABELS)) {
    const target = path.join(ctx.agentsDir, `${label}.plist`);
    if (fs.existsSync(target)) {
      if (ctx.platform === "darwin") await ctx.run("launchctl", ["bootout", `gui/${ctx.uid}`, target]);
      fs.rmSync(target, { force: true });
      removed.push(`${label}.plist`);
    }
  }
  fs.rmSync(L.app, { recursive: true, force: true });
  fs.rmSync(L.launchd, { recursive: true, force: true });
  if (purge) {
    // also the device key, login link, readings and settings: the device must be re-enrolled with a NEW invite afterwards
    fs.rmSync(ctx.root, { recursive: true, force: true });
  } else {
    writePrivate(L.installState, { ...(readJson(L.installState) ?? {}), uninstalledAt: ctx.now.toISOString() });
  }
  return { removed, purged: purge === true, kept: purge ? [] : ["device key", "login link", "settings", "readings"] };
}
