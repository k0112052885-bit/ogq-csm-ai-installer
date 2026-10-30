#!/usr/bin/env node
// Employee-device setup, written so that an AI assistant can run it step by step (every command prints one JSON line with { step, ok, next }).
// Each step that changes anything needs an explicit consent flag, so the person only has to approve small, named actions. No admin Slack secret, bot token or
// e-mail is ever read or written; nothing is installed or scheduled; nothing is sent anywhere (files are handed to the admin by the person).
//   employee-setup.mjs plan  --label <L>                      the ordered steps and what each one does (read-only)
//   employee-setup.mjs check [--source-dir ~/.csm] --label L   read-only: is the login bound on this device? SDK present?
//   employee-setup.mjs enroll --invite invite.json --out enroll-request.json --label L --consent-enroll [--source-dir ~/.csm] [--device-dir ~/.csm/device]
//   employee-setup.mjs finalize --approval approval.json --consent-finalize [--device-dir ~/.csm/device]
//   employee-setup.mjs reading --out-dir ./outbox [--source-dir ~/.csm] [--device-dir ~/.csm/device] --consent-share-usage     one signed reading file (percentages + reset times only)
//   employee-setup.mjs status [--device-dir ~/.csm/device]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { enrollDevice, finalizeApproval, loadDevice, makeReading } from "../src/fleet-device.mjs";
import { bindingFor } from "../src/identity.mjs";
import { sdkPreflight } from "../src/sdk-preflight.mjs";

const out = (o) => console.log(JSON.stringify(o));
const writeOut = (f, obj) => fs.writeFileSync(f, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });

export function planSteps(label = "<LABEL>") {
  return [
    { id: "check", consent: false, does: "Read-only: checks Node/SDK and whether your Claude login is already linked on this device.", command: `node scripts/employee-setup.mjs check --label ${label}` },
    { id: "identity-observe", consent: true, does: "ONE identity-only call to the Claude SDK (accountInfo). No usage request, no prompt. Stores only a salted fingerprint, never your e-mail.", command: "node scripts/identity.mjs observe --live" },
    { id: "identity-bind", consent: true, does: `Records that the login you are using right now is the one for ${label}.`, command: `node scripts/identity.mjs bind --label ${label} --i-confirm-this-login` },
    { id: "enroll", consent: true, does: "Creates a device-only signing key and an enrollment request file for the admin (public key + login fingerprint tag only).", command: `node scripts/employee-setup.mjs enroll --invite <invite.json> --out enroll-request.json --label ${label} --consent-enroll` },
    { id: "send-request", consent: true, does: "YOU send enroll-request.json to the admin and read them the short verification code printed by the previous step.", command: null },
    { id: "finalize", consent: true, does: "Accepts the admin's signed approval file.", command: "node scripts/employee-setup.mjs finalize --approval approval.json --consent-finalize" },
    { id: "reading", consent: true, does: "Writes one signed usage reading (percentages and reset times only) for you to hand to the admin; repeat whenever you like. Scheduling it is optional and yours to do.", command: "node scripts/employee-setup.mjs reading --out-dir ./outbox --consent-share-usage" },
  ];
}

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { label: { type: "string" }, "source-dir": { type: "string" }, "device-dir": { type: "string" }, invite: { type: "string" }, out: { type: "string" }, "out-dir": { type: "string" }, approval: { type: "string" }, "consent-enroll": { type: "boolean" }, "consent-finalize": { type: "boolean" }, "consent-share-usage": { type: "boolean" } } });
  const [cmd] = positionals;
  const sourceDir = path.resolve(values["source-dir"] ?? path.join(os.homedir(), ".csm"));
  const deviceDir = path.resolve(values["device-dir"] ?? path.join(os.homedir(), ".csm", "device"));
  const need = (flag, what) => {
    if (values[flag] !== true) throw new Error(`this step ${what}: add --${flag} to confirm you agree`);
  };
  if (cmd === "plan") {
    out({ step: "plan", ok: true, steps: planSteps(values.label) });
  } else if (cmd === "check") {
    const sdk = sdkPreflight();
    const dev = loadDevice(deviceDir);
    out({ step: "check", ok: true, node: process.versions.node, sdkInstalled: sdk.installed, sdkVersion: sdk.version, loginBound: values.label ? Boolean(bindingFor(sourceDir, values.label)) : null, enrolled: Boolean(dev), approved: Boolean(dev?.approved), next: !dev ? "identity-observe, identity-bind, then enroll" : dev.approved ? "reading" : "send-request / finalize" });
  } else if (cmd === "enroll") {
    need("consent-enroll", "creates a device key and a request file");
    if (!values.invite || !values.out || !values.label) throw new Error("--invite, --out and --label are required");
    const r = enrollDevice({ deviceDir, invite: JSON.parse(fs.readFileSync(path.resolve(values.invite), "utf8")), sourceDir, label: values.label });
    writeOut(path.resolve(values.out), r.request);
    out({ step: "enroll", ok: true, requestFile: values.out, verificationCode: r.sas, next: "send the request file to the admin and read them the verification code" });
  } else if (cmd === "finalize") {
    need("consent-finalize", "stores the admin's approval");
    const r = finalizeApproval({ deviceDir, approval: JSON.parse(fs.readFileSync(path.resolve(values.approval ?? ""), "utf8")) });
    out({ step: "finalize", ok: true, deviceId: r.deviceId, accountId: r.accountId, next: "reading" });
  } else if (cmd === "reading") {
    need("consent-share-usage", "creates a file with your usage percentages and reset times");
    const r = makeReading({ deviceDir, sourceDir });
    if (r.skipped) out({ step: "reading", ok: false, skipped: r.skipped, next: r.skipped === "no-new-reading" ? "nothing new since the last reading" : "see docs/fleet-multi-device.md (skip reasons)" });
    else {
      const dir = path.resolve(values["out-dir"] ?? ".");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${r.envelope.payload.deviceId}-${String(r.envelope.payload.seq).padStart(6, "0")}.json`);
      writeOut(file, r.envelope);
      out({ step: "reading", ok: true, file, seq: r.envelope.payload.seq });
    }
  } else if (cmd === "status") {
    const d = loadDevice(deviceDir);
    out({ step: "status", ok: true, enrolled: Boolean(d), approved: Boolean(d?.approved), deviceId: d?.deviceId ?? null, accountId: d?.accountId ?? null, seq: d?.seq ?? null });
  } else {
    throw new Error("Usage: employee-setup.mjs plan|check|enroll|finalize|reading|status (see the header of this file)");
  }
} catch (e) {
  out({ ok: false, error: e.message });
  process.exit(1);
}
