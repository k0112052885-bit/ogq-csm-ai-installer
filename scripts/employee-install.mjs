#!/usr/bin/env node
// Single entrypoint of the employee package. Every command prints ONE JSON line { ok, step, ..., next } so an AI agent can drive it; step-by-step instructions
// are in AGENT_INSTALL.md. Nothing is changed without its named consent flag, nothing is sent anywhere, and enrollment always waits for the admin.
//   node scripts/employee-install.mjs preflight [--expect-fingerprint <12 hex from the admin>] [--kit-dir <private device kit>]   read-only checks (code-only package: --kit-dir also on install)
//   node scripts/employee-install.mjs setup [--consent-all] [--wait-minutes 30] [--profile b --claude-config-dir /abs/.claude-b] [--sdk-from DIR]
//                                          the WHOLE link installation after ONE consent: without --consent-all it prints the consolidated question (needsConsent: "all") and exit code 2;
//                                          with it: install, SDK, identify + link the logged-in Claude account, register (PENDING until the owner approves), background agents. Re-run to continue.
//   ONE LINK: when the repository carries join.json (built with package-code-only.mjs --server), `install --consent-install` needs no other argument.
//   LINK REGISTRATION (no kit, no invite): install --server https://dashboard.example.com --label <short name> [--profile b --claude-config-dir /abs/.claude-b] --consent-install
//                                          ... then sdk, observe, bind as usual, then:  join --consent-join   (PENDING until the owner approves in the dashboard; agents auto-finalize)
//   node scripts/employee-install.mjs status                                                     phase, pending items, health, next step (read-only)
//   node scripts/employee-install.mjs install --consent-install                                    verified copy into ~/.ogq-csm (or --root)
//   node scripts/employee-install.mjs sdk --consent-sdk [--sdk-from <folder>]                      pinned Claude Agent SDK (npm, or an offline folder)
//   node scripts/employee-install.mjs observe --consent-observe                                    ONE identity-only SDK call
//   node scripts/employee-install.mjs bind --consent-bind                                          link the logged-in Claude account to this subscription label
//   node scripts/employee-install.mjs enroll --consent-enroll                                      key + enrollment request for the admin (then WAIT)
//   node scripts/employee-install.mjs finalize [--approval approval.json]                          accept the admin's signed approval (or report that it is still pending)
//   node scripts/employee-install.mjs configure --consent-configure [--drop-dir /abs/shared/folder] [--ingest-url https://dashboard.example.com] [--auto-finalize]
//   node scripts/employee-install.mjs enable-transport --consent-transport                        send the (signed) enrollment request and readings to the ingest address; still waits for the admin
//   node scripts/employee-install.mjs install-agents --consent-agents [--agents-dir DIR]          launchd agents (macOS), idempotent
//   node scripts/employee-install.mjs tick                                                         one report cycle (what the agent runs)
//   node scripts/employee-install.mjs update --package-dir NEW --consent-update | uninstall --consent-uninstall [--purge]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import fs from "node:fs";
import { bindLogin, configure, defaultRoot, enableTransport, enroll, finalize, finalizeRemote, installAgents, installApp, installSdk, joinRemote, layout, makeCtx, NeedsConsent, observeLogin, PROFILE_RE, preflight, resolveJoin, setupAll, status, syncRemote, tick, uninstall, update } from "../src/employee-installer.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = (o) => console.log(JSON.stringify(o));
const CONSENT_FLAGS = ["all", "install", "sdk", "observe", "bind", "enroll", "join", "configure", "transport", "agents", "update", "uninstall"];

try {
  const options = { "wait-minutes": { type: "string" }, server: { type: "string" }, label: { type: "string" }, profile: { type: "string" }, "claude-config-dir": { type: "string" }, root: { type: "string" }, "package-dir": { type: "string" }, "kit-dir": { type: "string" }, "expect-fingerprint": { type: "string" }, "sdk-from": { type: "string" }, approval: { type: "string" }, "drop-dir": { type: "string" }, "ingest-url": { type: "string" }, "auto-finalize": { type: "boolean" }, "agents-dir": { type: "string" }, purge: { type: "boolean" } };
  for (const c of CONSENT_FLAGS) options[`consent-${c}`] = { type: "boolean" };
  const { values, positionals } = parseArgs({ allowPositionals: true, options });
  const [cmd = "status"] = positionals;
  const consent = Object.fromEntries(CONSENT_FLAGS.map((c) => [c, values[`consent-${c}`] === true]));
  if (values.profile !== undefined && !PROFILE_RE.test(values.profile)) throw new Error("--profile must be 1-20 characters: lowercase letters, digits, dashes");
  // root: --root, else the profile's own folder, else the folder this installed copy lives in (so each install finds ITS settings), else ~/.ogq-csm
  const installedRoot = path.basename(HERE) === "scripts" && path.basename(path.dirname(HERE)) === "app" ? path.dirname(path.dirname(HERE)) : null;
  const ctx = makeCtx({ root: values.root ?? (values.profile ? defaultRoot(values.profile) : installedRoot ?? undefined), consent, ...(values["agents-dir"] ? { agentsDir: values["agents-dir"] } : {}) });
  const packageDir = path.resolve(values["package-dir"] ?? path.join(HERE, ".."));
  const withNext = async (step, data) => ({ ok: true, step, ...data, next: (await status({ ctx })).next });
  const kitDir = values["kit-dir"] ?? null; // private per-device kit (invite.json + package-config.json) when the code came from a code-only package
  // link (self-service) registration: --server + --label, no kit and no invite; a second account on the same Mac adds --profile and its own --claude-config-dir
  // When the repository has a built-in address (join.json) nothing at all is needed from the human: the address comes from there and the alias is the installed one or a neutral generated one.
  const join = resolveJoin({ server: values.server ?? null, label: values.label ?? null, profile: values.profile ?? null, claudeConfigDir: values["claude-config-dir"] ?? null, packageDir, kitDir, ctx, ...(cmd === "preflight" ? { randomHex: () => "xxxxxx" } : {}) }); // (preflight shows a placeholder alias: only install creates one)
  // an install bound to its own Claude config folder (second account) reads THAT login in every later step
  try {
    const saved = JSON.parse(fs.readFileSync(layout(ctx.root).config, "utf8"));
    if (typeof saved.claudeConfigDir === "string") process.env.CLAUDE_CONFIG_DIR = saved.claudeConfigDir;
  } catch {
    if (values["claude-config-dir"]) process.env.CLAUDE_CONFIG_DIR = values["claude-config-dir"];
  }
  if (cmd === "preflight") out({ ok: true, step: "preflight", ...preflight({ packageDir, kitDir, join, expectFingerprint: values["expect-fingerprint"] ?? null, ctx }) });
  else if (cmd === "status") out({ ok: true, step: "status", ...(await status({ ctx })) });
  else if (cmd === "install") {
    const pf = preflight({ packageDir, kitDir, join, expectFingerprint: values["expect-fingerprint"] ?? null, ctx });
    if (!pf.ok) {
      out({ ok: false, step: "install", error: "preflight failed", checks: pf.checks.filter((c) => !c.ok && c.level === "required") });
      process.exit(1);
    }
    out(await withNext("install", installApp({ packageDir, kitDir, join, ctx })));
  } else if (cmd === "setup") {
    // ONE command after ONE consolidated consent (--consent-all): install -> SDK -> identify -> link -> register (PENDING) -> background agents. Never approves anything.
    const wait = values["wait-minutes"] === undefined ? 0 : Number(values["wait-minutes"]);
    if (!Number.isFinite(wait) || wait < 0 || wait > 180) throw new Error("--wait-minutes must be 0-180");
    const r = await setupAll({ packageDir, kitDir, join, ctx, expectFingerprint: values["expect-fingerprint"] ?? null, waitMinutes: wait, sdkFrom: values["sdk-from"] ?? null });
    out({ step: "setup", ...r });
    if (!r.ok) process.exit(1);
  } else if (cmd === "join") out(await withNext("join", await joinRemote({ ctx, waitMinutes: values["wait-minutes"] === undefined ? 0 : Math.min(180, Math.max(0, Number(values["wait-minutes"]) || 0)) })));
  else if (cmd === "sdk") out(await withNext("sdk", await installSdk({ ctx, from: values["sdk-from"] ?? null })));
  else if (cmd === "observe") {
    const r = await observeLogin({ ctx, live: true });
    out(await withNext("observe", { outcome: r.outcome, emailAvailable: r.emailAvailable ?? null, loginTag: r.tag ?? null, reason: r.reason ?? r.status ?? null }));
  } else if (cmd === "bind") out(await withNext("bind", { bound: Boolean(bindLogin({ ctx })) }));
  else if (cmd === "enroll") out(await withNext("enroll", enroll({ ctx })));
  else if (cmd === "finalize") {
    let r = finalize({ ctx, approvalFile: values.approval ?? null });
    if (!r.approved) r = { ...r, ...(await finalizeRemote({ ctx })) }; // no local approval file: ask the dashboard (only when the transport was consented to)
    out(await withNext("finalize", r));
  } else if (cmd === "configure") out(await withNext("configure", configure({ ctx, dropDir: values["drop-dir"], autoFinalize: values["auto-finalize"], ingestUrl: values["ingest-url"] })));
  else if (cmd === "enable-transport") out(await withNext("enable-transport", enableTransport({ ctx })));
  else if (cmd === "install-agents") out(await withNext("install-agents", await installAgents({ ctx })));
  else if (cmd === "tick") {
    const t = tick({ ctx });
    out({ ok: true, step: "tick", ...t, remote: await syncRemote({ ctx }) });
  }
  else if (cmd === "update") out(await withNext("update", update({ ctx, packageDir })));
  else if (cmd === "uninstall") out({ ok: true, step: "uninstall", ...(await uninstall({ ctx, purge: values.purge === true })) });
  else throw new Error("Usage: employee-install.mjs preflight|status|setup|install|sdk|observe|bind|enroll|join|finalize|configure|install-agents|tick|update|uninstall (see AGENT_INSTALL.md)");
} catch (e) {
  if (e instanceof NeedsConsent) {
    out({ ok: false, needsConsent: e.consent, question: e.question, rerun: `add --consent-${e.consent}` });
    process.exit(2);
  }
  out({ ok: false, error: String(e.message).slice(0, 300) });
  process.exit(1);
}
