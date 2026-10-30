#!/usr/bin/env node
// Single entrypoint of the employee package. Every command prints ONE JSON line { ok, step, ..., next } so an AI agent can drive it; step-by-step instructions
// are in AGENT_INSTALL.md. Nothing is changed without its named consent flag, nothing is sent anywhere, and enrollment always waits for the admin.
//   node scripts/employee-install.mjs preflight [--expect-fingerprint <12 hex from the admin>] [--kit-dir <private device kit>]   read-only checks (code-only package: --kit-dir also on install)
//   node scripts/employee-install.mjs status                                                       phase, pending items, health, next step (read-only)
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
import { bindLogin, configure, enableTransport, enroll, finalize, finalizeRemote, installAgents, installApp, installSdk, makeCtx, NeedsConsent, observeLogin, preflight, status, syncRemote, tick, uninstall, update } from "../src/employee-installer.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = (o) => console.log(JSON.stringify(o));
const CONSENT_FLAGS = ["install", "sdk", "observe", "bind", "enroll", "configure", "transport", "agents", "update", "uninstall"];

try {
  const options = { root: { type: "string" }, "package-dir": { type: "string" }, "kit-dir": { type: "string" }, "expect-fingerprint": { type: "string" }, "sdk-from": { type: "string" }, approval: { type: "string" }, "drop-dir": { type: "string" }, "ingest-url": { type: "string" }, "auto-finalize": { type: "boolean" }, "agents-dir": { type: "string" }, purge: { type: "boolean" } };
  for (const c of CONSENT_FLAGS) options[`consent-${c}`] = { type: "boolean" };
  const { values, positionals } = parseArgs({ allowPositionals: true, options });
  const [cmd = "status"] = positionals;
  const consent = Object.fromEntries(CONSENT_FLAGS.map((c) => [c, values[`consent-${c}`] === true]));
  const ctx = makeCtx({ root: values.root, consent, ...(values["agents-dir"] ? { agentsDir: values["agents-dir"] } : {}) });
  const packageDir = path.resolve(values["package-dir"] ?? path.join(HERE, ".."));
  const withNext = async (step, data) => ({ ok: true, step, ...data, next: (await status({ ctx })).next });
  const kitDir = values["kit-dir"] ?? null; // private per-device kit (invite.json + package-config.json) when the code came from a code-only package
  if (cmd === "preflight") out({ ok: true, step: "preflight", ...preflight({ packageDir, kitDir, expectFingerprint: values["expect-fingerprint"] ?? null, ctx }) });
  else if (cmd === "status") out({ ok: true, step: "status", ...(await status({ ctx })) });
  else if (cmd === "install") {
    const pf = preflight({ packageDir, kitDir, expectFingerprint: values["expect-fingerprint"] ?? null, ctx });
    if (!pf.ok) {
      out({ ok: false, step: "install", error: "preflight failed", checks: pf.checks.filter((c) => !c.ok && c.level === "required") });
      process.exit(1);
    }
    out(await withNext("install", installApp({ packageDir, kitDir, ctx })));
  } else if (cmd === "sdk") out(await withNext("sdk", await installSdk({ ctx, from: values["sdk-from"] ?? null })));
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
  else throw new Error("Usage: employee-install.mjs preflight|status|install|sdk|observe|bind|enroll|finalize|configure|install-agents|tick|update|uninstall (see AGENT_INSTALL.md)");
} catch (e) {
  if (e instanceof NeedsConsent) {
    out({ ok: false, needsConsent: e.consent, question: e.question, rerun: `add --consent-${e.consent}` });
    process.exit(2);
  }
  out({ ok: false, error: String(e.message).slice(0, 300) });
  process.exit(1);
}
