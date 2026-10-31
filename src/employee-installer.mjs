// Employee-side installer engine (driven by scripts/employee-install.mjs, which an AI agent runs step by step on the employee's own Mac).
// What it does: verifies the package, installs a private copy of the code under one folder (default ~/.ogq-csm), links the employee's Claude login to the account label
// (device-local fingerprint only), enrolls the device with the admin through a FILE HANDOFF, and - only on explicit permission - installs two launchd agents that keep
// the usage reading fresh and produce signed reading files. What it never does: contact the admin or any server, send Slack messages, read or write Claude settings
// or credentials, hold any admin secret or signing key, or install anything without a named consent. Enrollment is NEVER automatic: the device stays
// PENDING_ADMIN_APPROVAL until the admin approves it and the signed approval file comes back (by hand, or through an optional shared drop folder).
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deliverReading, fetchApproval, submitEnrollment, submitJoin, validateIngestUrl } from "./fleet-client.mjs";
import { enrollDevice, finalizeApproval, joinDevice, loadDevice, makeReading } from "./fleet-device.mjs";
import { validateAlias } from "./model.mjs";
import { bindLabel, summarizeIdentity } from "./identity.mjs";
import { observeIdentity } from "./identity-observe.mjs";
import { MANIFEST_FILE, verifyManifest } from "./package-manifest.mjs";
import { defaultConfig, pollerPaths, summarizePoller, validateConfig } from "./sdk-poller.mjs";
import { REFERENCE_VERSION, sdkPreflight } from "./sdk-preflight.mjs";

export const CONFIG_SCHEMA = "csm-employee-config/v1";
export const LABELS = { poll: "com.ogq.csm.employee.poll", tick: "com.ogq.csm.employee.tick" };
export const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,19}$/;
/** Launchd labels. A profile (a second Claude login on the same Mac, kept in its own folder) gets its own pair, so two accounts never share an agent. */
export const labelsFor = (profile = null) => (profile ? { poll: `${LABELS.poll}.${profile}`, tick: `${LABELS.tick}.${profile}` } : LABELS);
export const POLL_MINUTES = 15;
export const TICK_MINUTES = 30;
export const SCRIPT = "scripts/employee-install.mjs";
export const CONSENTS = {
  all: "Do ALL of the following on this Mac, without asking again at each step: (1) copy the installer code into a private folder in your home directory (nothing outside it is changed); (2) download the pinned Claude Agent SDK 0.3.301 from the npm registry into that folder (needs internet); (3) make ONE identity-only call to the Claude SDK to see which Claude account is logged in on this Mac (no prompt is sent, no usage request; your e-mail is never stored, only a salted fingerprint); (4) count the Claude account that is logged in on THIS Mac right now for this install; (5) register this Mac with the owner's dashboard (it sends ONLY a new public key, that salted fingerprint and a neutral short name; it stays PENDING until the owner approves it - nothing is approved automatically, and the owner decides which subscription it counts for); (6) install two background agents (launchd) that ask the Claude SDK for your plan usage every 15 minutes (no prompt is sent) and send signed usage percentages and reset times to the owner's dashboard once approved. You can remove everything later with the uninstall command.",
  install: "Copy the package code into a private folder in your home directory (nothing outside it is changed)?",
  sdk: "Download the pinned Claude Agent SDK 0.3.301 from the npm registry into that folder (needs internet)?",
  observe: "Make ONE identity-only call to the Claude SDK to see which Claude account is logged in on this Mac? (No prompt is sent, no usage request, your e-mail is never stored: only a salted fingerprint.)",
  bind: "Is the Claude account that is logged in on THIS Mac right now the one you want counted for this subscription?",
  enroll: "Create a signing key that stays on this Mac and an enrollment request file for the admin (public key + login fingerprint only)?",
  join: "Register this Mac with the dashboard at the address you were given? It sends ONLY a new public key, your salted login fingerprint and the short name you chose; it waits as PENDING until the owner approves it (nothing is trusted or approved automatically), and the owner decides which subscription it counts for.",
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

export const defaultRoot = (profile = null) => path.join(os.homedir(), profile ? `.ogq-csm-${profile}` : ".ogq-csm");
export function layout(root) {
  const j = (...p) => path.join(root, ...p);
  return { root, app: j("app"), data: j("data"), device: j("device"), outbox: j("outbox"), readings: j("outbox", "readings"), inbox: j("inbox"), logs: j("logs"), launchd: j("launchd"), private: j("private"), config: j("config.json"), health: j("health.json"), installState: j("install.json"), transport: j("transport.json") };
}

/** The launchd labels of THIS install (its profile, when it is a second account on the Mac). */
export const labelsOf = (ctx) => labelsFor(readJson(layout(ctx.root).config)?.profile ?? null);

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
    sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    hasCommand: o.hasCommand ?? realHasCommand,
  };
}
/** Is `cmd` runnable from this Mac's PATH (for prerequisites such as npm)? */
function realHasCommand(cmd) {
  const r = spawnSync(cmd, ["--version"], { encoding: "utf8", timeout: 15000, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  return r.status === 0;
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

/** Validates the self-service (link) onboarding settings: the dashboard address, the short name, an optional profile (2nd account on one Mac) and its Claude config folder. */
export function joinSettings(j) {
  const server = validateIngestUrl(j?.server);
  const label = String(j?.label ?? "");
  const err = validateAlias(label);
  if (err) throw new Error(`label: ${err}`);
  const profile = j?.profile ? String(j.profile) : null;
  if (profile && !PROFILE_RE.test(profile)) throw new Error("profile must be 1-20 characters: lowercase letters, digits, dashes");
  const claudeConfigDir = j?.claudeConfigDir ? String(j.claudeConfigDir) : null;
  if (claudeConfigDir && !path.isAbsolute(claudeConfigDir)) throw new Error("the Claude config folder must be an absolute path");
  if (profile && !claudeConfigDir) throw new Error("a profile (second account on this Mac) needs its own --claude-config-dir so the two logins never share one");
  return { server, label, profile, claudeConfigDir };
}

/** `join.json` of a code-only package built with a built-in intake address (a PUBLIC origin, not a secret), or null. */
export function readJoinDefaults(packageDir) {
  const j = readJson(path.join(packageDir, "join.json"));
  if (!j || j.schema !== "csm-join-defaults/v1" || typeof j.server !== "string") return null;
  try {
    return { server: validateIngestUrl(j.server) };
  } catch {
    return null;
  }
}

/**
 * The link-registration settings for this run, so an employee's AI needs NOTHING but the repository link when the package has a built-in address: explicit --server / --label win; otherwise
 * the built-in address; the alias is the given one, else the one already installed in this folder (so a re-run with no flags is the SAME install, never a refused "different alias"),
 * else a neutral generated one (`ogq-` + 6 hex: no name, no e-mail). Owner device-kit mode is untouched: with --kit-dir and no --server this returns null.
 */
export function resolveJoin({ server = null, label = null, profile = null, claudeConfigDir = null, packageDir, kitDir = null, ctx, randomHex = () => crypto.randomBytes(3).toString("hex") }) {
  if (kitDir && !server) return null;
  const address = server ?? (kitDir ? null : readJoinDefaults(packageDir)?.server ?? null);
  if (!address) return null;
  const installed = readJson(layout(ctx.root).config);
  const alias = label ?? (installed?.selfJoin === true && typeof installed.label === "string" ? installed.label : `ogq-${randomHex()}`);
  return { server: address, label: alias, profile: profile ?? undefined, claudeConfigDir: claudeConfigDir ?? undefined };
}

export function preflight({ packageDir, kitDir = null, join = null, expectFingerprint = null, ctx }) {
  const checks = [];
  const add = (id, ok, detail, level = "required") => checks.push({ id, ok, detail, level });
  const major = Number(process.versions.node.split(".")[0]);
  add("node", major >= 20, `Node ${process.versions.node} (20 or newer needed)`);
  const npmOk = typeof ctx.hasCommand === "function" ? ctx.hasCommand("npm") : true;
  add("npm", npmOk, npmOk ? "npm is available (the SDK step needs it)" : "npm was not found on PATH: install Node.js from https://nodejs.org (it includes npm) before the SDK step, or give an offline copy with --sdk-from <folder>", "later");
  add("platform", ctx.platform === "darwin", ctx.platform === "darwin" ? "macOS: launchd agents are available" : `${ctx.platform}: background agents cannot be installed (manual runs only)`, "agents");
  const v = verifyManifest(packageDir);
  add("package-integrity", v.ok, v.ok ? `${Object.keys(v.manifest.files).length} files verified against MANIFEST.json` : v.problems.slice(0, 5).join("; "));
  if (expectFingerprint) add("fingerprint", v.fingerprint === String(expectFingerprint).toLowerCase(), v.fingerprint === String(expectFingerprint).toLowerCase() ? "matches the fingerprint the admin gave you" : "does NOT match the fingerprint the admin gave you: do not continue");
  else if (join) add("code-pin", true, "link registration: there is NO fingerprint to compare or ask for; the code is pinned by the commit the owner named (git rev-parse HEAD) and every file is verified against MANIFEST.json", "info");
  else add("fingerprint", true, `package fingerprint ${v.fingerprint ?? "n/a"} - compare it with what the admin told you through another channel`, "info");
  if (join) {
    let js = null;
    let why = "";
    try {
      js = joinSettings(join);
    } catch (e) {
      why = e.message;
    }
    add("join-settings", Boolean(js), js ? `self-service registration at ${js.server} as "${js.label}"${js.profile ? ` (profile ${js.profile})` : ""}: no invite is needed, the owner approves it in the dashboard` : why);
  } else {
    const kit = kitOf(packageDir, kitDir);
    const invite = readJson(path.join(kit, "invite.json"));
    const inviteOk = Boolean(invite) && invite.schema === "csm-fleet-invite/v1" && Date.parse(invite.expiresAt) > ctx.now.getTime();
    add("invite", inviteOk, inviteOk ? `enrollment invite valid until ${invite.expiresAt}` : invite ? "the enrollment invite has expired: ask the admin for a new package" : "invite.json missing or unreadable (a code-only package needs the owner's private device kit: pass --kit-dir, or register by link: pass --server and --label)");
    const kitCfg = readJson(path.join(kit, "package-config.json"));
    const kitOk = Boolean(kitCfg?.label) && Boolean(kitCfg?.accountId) && (!invite || kitCfg.accountId === invite.accountId);
    add("device-config", kitOk, kitOk ? `device settings for ${kitCfg.label}` : "package-config.json missing, incomplete, or for a different account than the invite");
  }
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
  // link registration shows no fingerprint at all (nothing for an AI to mistake for something to request); it stays in kit mode and whenever the owner explicitly passed one to check
  return { ok: checks.filter((c) => c.level === "required").every((c) => c.ok), checks, ...(join && !expectFingerprint ? {} : { fingerprint: v.fingerprint }), version: v.manifest?.version ?? null };
}

// ------------------------------------------------------------------ install / sdk / login / enroll / finalize / configure

export function installApp({ packageDir, kitDir = null, join = null, ctx }) {
  need(ctx, "install");
  const js = join ? joinSettings(join) : null; // validated before anything is written
  const v = verifyManifest(packageDir);
  if (!v.ok) throw new Error(`package integrity check failed: ${v.problems.slice(0, 3).join("; ")}`);
  const L = layout(ctx.root);
  if (path.resolve(packageDir) === L.app) throw new Error("run install from the package folder you were given, not from the installed copy");
  const before = readJson(path.join(L.app, MANIFEST_FILE));
  // An existing link install keeps its settings. A different --server / --label / --profile / --claude-config-dir is REFUSED here, before anything is copied or written (never silently kept,
  // never overwritten: the registered device, login link, collected data and settings stay exactly as they are); identical settings are an idempotent re-install.
  const existing = js ? readJson(L.config) : null;
  if (js && !existing && fs.existsSync(L.config)) throw new Error(`install refused, nothing was changed: ${L.config} exists but cannot be read; it is not overwritten (repair or move it yourself)`);
  if (js && existing) {
    if (existing.selfJoin !== true) throw new Error(`install refused, nothing was changed: ${L.root} was installed with an owner device kit; use another --profile / --root`);
    const same = (a, b) => (a === null || a === undefined ? null : path.resolve(a)) === (b === null || b === undefined ? null : path.resolve(b));
    const diff = [];
    if (existing.ingestUrl !== js.server) diff.push(`--server (installed ${existing.ingestUrl ?? "none"}, requested ${js.server})`);
    if (existing.label !== js.label) diff.push(`--label (installed "${existing.label}", requested "${js.label}")`);
    if ((existing.profile ?? null) !== js.profile) diff.push(`--profile (installed ${existing.profile ?? "none"}, requested ${js.profile ?? "none"})`);
    if (!same(existing.claudeConfigDir, js.claudeConfigDir)) diff.push(`--claude-config-dir (installed ${existing.claudeConfigDir ?? "none"}, requested ${js.claudeConfigDir ?? "none"})`);
    if (diff.length) throw new Error(`install refused, nothing was changed: this folder already has different link settings: ${diff.join("; ")}. Use the installed values, or remove this install first.`);
  }
  mkdirs(L.root, L.data, L.outbox, L.readings, L.inbox, L.logs, L.launchd, L.private, L.app);
  for (const rel of Object.keys(v.manifest.files)) {
    if (rel === "invite.json") continue; // the one-time invite goes to the private folder only
    const dest = path.join(L.app, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(packageDir, rel), dest);
    fs.chmodSync(dest, 0o644);
  }
  fs.copyFileSync(path.join(packageDir, MANIFEST_FILE), path.join(L.app, MANIFEST_FILE));
  let cfg;
  if (js) {
    // self-service (link) onboarding: no invite and no account here; the owner assigns the account when approving
    cfg = { label: js.label, accountId: null };
    const fresh = { schema: CONFIG_SCHEMA, label: js.label, accountId: null, selfJoin: true, profile: js.profile, claudeConfigDir: js.claudeConfigDir, packageVersion: v.manifest.version, installedAt: ctx.now.toISOString(), dropDir: null, autoFinalize: true, ingestUrl: js.server, transportEnabled: false };
    if (!existing) writePrivate(L.config, fresh);
  } else {
    const kit = kitOf(packageDir, kitDir);
    cfg = readJson(path.join(kit, "package-config.json"));
    if (!cfg?.label || !cfg?.accountId) throw new Error("package-config.json is missing label/accountId");
    const invitePath = path.join(L.private, "invite.json");
    if (!loadDevice(L.device) && !fs.existsSync(invitePath)) {
      fs.copyFileSync(path.join(kit, "invite.json"), invitePath);
      fs.chmodSync(invitePath, 0o600);
    }
    if (!readJson(L.config)) writePrivate(L.config, { schema: CONFIG_SCHEMA, label: cfg.label, accountId: cfg.accountId, packageVersion: v.manifest.version, installedAt: ctx.now.toISOString(), dropDir: cfg.dropDir ?? null, autoFinalize: false, ingestUrl: cfg.ingestUrl ? validateIngestUrl(cfg.ingestUrl) : null, transportEnabled: false });
  }
  const pc = pollerPaths(L.data).config;
  if (!readJson(pc)) writePrivate(pc, defaultConfig({ account: cfg.label, dir: L.data, intervalMinutes: POLL_MINUTES, enabled: false }));
  writePrivate(L.installState, { installedAt: readJson(L.installState)?.installedAt ?? ctx.now.toISOString(), updatedAt: ctx.now.toISOString(), version: v.manifest.version, fingerprint: v.fingerprint });
  return { installed: true, alreadyInstalled: Boolean(before), version: v.manifest.version, ...(js ? {} : { fingerprint: v.fingerprint }), appDir: L.app, entry: path.join(L.app, SCRIPT) };
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

/** The entry file of the SDK installed under THIS install's app folder, or null (not installed / no JavaScript entry found). */
export function installedSdkEntry(appDir) {
  const dir = path.join(appDir, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  const pkg = readJson(path.join(dir, "package.json"));
  if (!pkg) return null;
  const exp = pkg.exports;
  const rels = [typeof exp === "string" ? exp : null, typeof exp?.["."] === "string" ? exp["."] : null, exp?.["."]?.import, exp?.["."]?.default, exp?.import, exp?.default, pkg.module, pkg.main, "sdk.mjs"].filter((r) => typeof r === "string");
  for (const rel of rels) {
    const abs = path.resolve(dir, rel);
    if (abs.startsWith(dir + path.sep) && fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  }
  return null;
}

export async function observeLogin({ ctx, live = false, preflight: pf, probe }) {
  if (live) need(ctx, "observe");
  const L = layout(ctx.root);
  const config = readJson(pollerPaths(L.data).config);
  if (!config) throw new Error("install the package first");
  // The SDK belongs to THIS install (<root>/app/node_modules), not to whatever folder the running script lives in: a `status` suggestion run from the clone must still find it
  // (the default lookup is relative to the script and would say "SDK not installed"). Not persisted: the poller agents run from the installed copy and need nothing stored.
  const sdkModule = config.sdkModule ?? installedSdkEntry(L.app);
  return observeIdentity({ config: sdkModule ? { ...config, sdkModule } : config, now: ctx.now, live, ...(pf ? { preflight: pf } : {}), ...(probe ? { probe } : {}) });
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

/**
 * Self-service registration (link onboarding): the join step of a package installed with --server/--label. Sends the public key + login tag + alias to the dashboard, which can only queue
 * it as PENDING while the owner has opened registration. From then on the background report agent polls for the owner's signed approval and accepts it (auto-finalize), then collects.
 */
export class RegistrationClosed extends Error {
  constructor() {
    super("the owner has not opened registration (or the window ended): ask them to open it in the dashboard, then run join again");
  }
}

/**
 * `waitMinutes` > 0: while the owner's registration window is closed, ask again every `intervalSeconds` (default 30) for that long - it keeps trying ONLY on "closed" and stops at the first
 * accepted request or any other answer. Waiting changes nothing about trust: the request is still only PENDING and the owner still approves it.
 */
export async function joinRemote({ ctx, waitMinutes = 0, intervalSeconds = 30 }) {
  need(ctx, "join");
  const attempts = Math.floor((Math.max(0, waitMinutes) * 60) / Math.max(5, intervalSeconds));
  for (let i = 0; ; i++) {
    try {
      return { ...(await joinOnce({ ctx })), waitedAttempts: i };
    } catch (e) {
      if (!(e instanceof RegistrationClosed) || i >= attempts) throw e;
      await ctx.sleep(Math.max(5, intervalSeconds) * 1000);
    }
  }
}

async function joinOnce({ ctx }) {
  const L = layout(ctx.root);
  const cfg = readJson(L.config);
  if (!cfg) throw new Error("install the package first");
  if (cfg.selfJoin !== true || !cfg.ingestUrl) throw new Error("this install was not set up for link registration (use enroll with the owner's device kit)");
  if (loadDevice(L.device)) throw new Error("this device is already registered");
  const base = validateIngestUrl(cfg.ingestUrl);
  const r = await joinDevice({ deviceDir: L.device, sourceDir: L.data, label: cfg.label, now: ctx.now, submit: (req) => submitJoin(base, req, { fetchImpl: ctx.fetch }) });
  if (!r.joined) {
    if (r.status === 403) throw new RegistrationClosed();
    if (r.status === 429) throw new Error("registration is busy or full right now: try again later");
    throw new Error(`could not register (${r.reason}${r.status ? `, status ${r.status}` : ""}): nothing was saved, run join again`);
  }
  writePrivate(L.config, { ...cfg, transportEnabled: true, autoFinalize: true });
  writePrivate(L.installState, { ...(readJson(L.installState) ?? {}), enrolledAt: ctx.now.toISOString(), verificationCode: r.sas, deviceId: r.deviceId });
  return { state: "PENDING_ADMIN_APPROVAL", deviceId: r.deviceId, verificationCode: r.sas, server: base };
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
  <dict><key>PATH</key><string>${esc(env.PATH)}</string><key>HOME</key><string>${esc(env.HOME)}</string>${env.CLAUDE_CONFIG_DIR ? `<key>CLAUDE_CONFIG_DIR</key><string>${esc(env.CLAUDE_CONFIG_DIR)}</string>` : ""}</dict>
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
  const labels = labelsOf(ctx);
  const cfgDir = readJson(L.config)?.claudeConfigDir ?? null; // a second account on this Mac: its poll agent reads ITS Claude login, not the default one
  return {
    [`${labels.poll}.plist`]: plistText({ label: labels.poll, seconds: POLL_MINUTES * 60, logFile: path.join(L.logs, "poll.log"), env: cfgDir ? { ...env, CLAUDE_CONFIG_DIR: cfgDir } : env, args: [ctx.execPath, path.join(L.app, "scripts", "employee-poll.mjs"), "--config", pollerPaths(L.data).config] }),
    [`${labels.tick}.plist`]: plistText({ label: labels.tick, seconds: TICK_MINUTES * 60, logFile: path.join(L.logs, "tick.log"), env, args: [ctx.execPath, path.join(L.app, SCRIPT), "tick", "--root", L.root] }),
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
  for (const label of Object.values(labelsOf(ctx))) {
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
  if (phase === "PENDING_ADMIN_APPROVAL") base.pending = cfg.selfJoin === true ? { what: "the owner must approve this device in the dashboard (Devices page) and choose its account", verificationCode: readJson(L.installState)?.verificationCode ?? null, requestFile: null, approvalGoesTo: null } : { what: "the admin must approve this device", verificationCode: readJson(L.installState)?.verificationCode ?? null, requestFile: path.join(L.outbox, "enroll-request.json"), approvalGoesTo: path.join(L.inbox, "approval.json") };
  if (cfg.selfJoin === true) base.profile = cfg.profile ?? null;
  return { ...base, next: nextStep(phase, cfg) };
}
const warn = (o, m) => o.warnings.push(m);

export function nextStep(phase, cfg = null) {
  const self = cfg?.selfJoin === true;
  // a second account on one Mac (profile): every suggested command carries its profile, so running it from a clone can never act on another account's folder
  const sfx = cfg?.profile ? ` --profile ${cfg.profile}` : "";
  const e = (command, consent = null) => ({ command: `node ${SCRIPT} ${command}${sfx}`, consent, question: consent ? CONSENTS[consent] : null });
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
      return self ? e("join --consent-join", "join") : e("enroll --consent-enroll", "enroll");
    case "PENDING_ADMIN_APPROVAL":
      if (self) return { command: `node ${SCRIPT} finalize${sfx}`, consent: null, question: null, note: "WAITING FOR THE OWNER. Read the verification code to the owner (they type it in the dashboard and choose the account). Install the background agents now (install-agents): they pick up the approval by themselves and start collecting. Or run this command again after the owner approved." };
      return { command: `node ${SCRIPT} finalize`, consent: null, question: null, note: "WAITING FOR THE ADMIN. Hand enroll-request.json and the verification code to the admin; when approval.json comes back, put it in the inbox folder (or pass --approval FILE) and run this command again." };
    case "APPROVED_NO_AGENTS":
      return e("install-agents --consent-agents", "agents");
    case "RUNNING":
      return { command: `node ${SCRIPT} status${sfx}`, consent: null, question: null, note: "Installed and running. Nothing else to do; readings are written to the outbox for the admin." };
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
  return { updated: true, from: cur.version, to: v.manifest.version, ...(cfgOld?.selfJoin === true ? {} : { fingerprint: v.fingerprint }) };
}

export async function uninstall({ ctx, purge = false }) {
  need(ctx, "uninstall");
  const L = layout(ctx.root);
  const removed = [];
  for (const label of Object.values(labelsOf(ctx))) {
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

// ------------------------------------------------------------------ one command, one consent

/**
 * The whole link installation in ONE call after ONE consolidated consent (`ctx.consent.all`, whose text lists every action): preflight -> install -> SDK -> identify the logged-in
 * Claude account -> link it -> register with the owner's dashboard (PENDING) -> background agents. It stops at the first step that cannot continue and says which step and why; running it again
 * continues where it stopped (every step is idempotent and already-done steps are skipped). It does NOT and cannot approve anything: the owner opens the registration window and approves
 * the device in the dashboard; the agents pick the signed approval up by themselves. Only the six consents of `all` are granted - never enroll / configure / transport / update / uninstall.
 * `hooks` ({ observePreflight, observeProbe }) exist for tests only.
 */
export async function setupAll({ packageDir, join, ctx, kitDir = null, expectFingerprint = null, waitMinutes = 0, intervalSeconds = 30, sdkFrom = null, hooks = {} }) {
  need(ctx, "all");
  if (!join) throw new Error("setup needs an intake address: the repository's join.json (built with package-code-only.mjs --server) or --server <address> [--label <name>]");
  const c = { ...ctx, consent: { ...ctx.consent, install: true, sdk: true, observe: true, bind: true, join: true, agents: true } };
  const L = layout(c.root);
  const steps = [];
  const done = (step, extra = {}) => steps.push({ step, ok: true, ...extra });
  const stop = (step, error, extra = {}) => ({ ok: false, step, error: String(error).slice(0, 300), steps, ...extra, rerun: "run the same setup command again after fixing this: it continues where it stopped" });
  const pf = preflight({ packageDir, kitDir, join, expectFingerprint, ctx: c });
  if (!pf.ok) return stop("preflight", "preflight failed", { checks: pf.checks.filter((x) => !x.ok && x.level === "required") });
  done("preflight", { npm: pf.checks.find((x) => x.id === "npm")?.ok === true });
  let r;
  try {
    r = installApp({ packageDir, kitDir, join, ctx: c });
  } catch (e) {
    return stop("install", e.message);
  }
  done("install", { alreadyInstalled: r.alreadyInstalled });
  const have = sdkAt(L.app);
  if (have.installed && have.version === REFERENCE_VERSION && have.compat.ok) done("sdk", { skipped: "the pinned SDK is already installed" });
  else {
    try {
      const s = await installSdk({ ctx: c, from: sdkFrom });
      if (!s.installed || !s.pinnedMatches || !s.compatible) return stop("sdk", `the installed SDK is not usable (version ${s.version ?? "unknown"}, pinned ${REFERENCE_VERSION}, compatible ${s.compatible})`);
      done("sdk", { version: s.version });
    } catch (e) {
      return stop("sdk", e.message, { hint: "npm and internet access are needed (Node.js from nodejs.org includes npm), or give an offline copy with --sdk-from <folder>" });
    }
  }
  if (loadDevice(L.device)) done("register", { skipped: "this Mac is already registered", note: "identify / link / register skipped" });
  else {
    try {
      const o = await observeLogin({ ctx: c, live: true, ...(hooks.observePreflight ? { preflight: hooks.observePreflight } : {}), ...(hooks.observeProbe ? { probe: hooks.observeProbe } : {}) });
      if (o.outcome !== "observed") return stop("observe", `the Claude login could not be identified (${o.outcome}${o.reason ?? o.status ? `: ${o.reason ?? o.status}` : ""}). Is Claude Code logged in on this Mac${c.root.includes(".ogq-csm-") ? " (for a second account: under its own --claude-config-dir)" : ""}?`);
      if (o.emailAvailable !== true) return stop("observe", "this Claude login exposes no e-mail the SDK can fingerprint (for example a non-first-party provider): it cannot be linked", { note: "stop and tell the owner" });
      done("observe", { loginTag: o.tag ?? null });
    } catch (e) {
      return stop("observe", e.message);
    }
    try {
      bindLogin({ ctx: c });
      done("link");
    } catch (e) {
      return stop("link", e.message);
    }
    try {
      const j = await joinRemote({ ctx: c, waitMinutes, intervalSeconds });
      done("register", { deviceId: j.deviceId, waitedAttempts: j.waitedAttempts });
    } catch (e) {
      if (e instanceof RegistrationClosed) return stop("register", e.message, { hint: "add --wait-minutes 30 to keep asking until the owner opens the window" });
      return stop("register", e.message);
    }
  }
  try {
    const a = await installAgents({ ctx: c });
    done("agents", { agents: a.agents });
  } catch (e) {
    return stop("agents", e.message);
  }
  const st = await status({ ctx: c });
  const state = readJson(L.installState);
  return { ok: true, steps, alias: readJson(L.config)?.label ?? null, verificationCode: state?.verificationCode ?? null, phase: st.phase, pending: st.pending, warnings: st.warnings, tell: st.phase === "PENDING_ADMIN_APPROVAL" ? `Tell the human: this Mac is registered as "${readJson(L.config)?.label}" and is waiting for the owner. Give the owner this alias and the verification code ${state?.verificationCode}; the owner enters the code in the dashboard and chooses the account. Nothing more is needed here: the background agents pick up the approval and start sending readings by themselves.` : `State: ${st.phase}.`, next: st.next };
}
