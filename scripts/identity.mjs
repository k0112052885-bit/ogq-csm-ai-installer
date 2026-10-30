#!/usr/bin/env node
// Account identity binding for the usage collectors (no network, no Slack, no secrets; fingerprints only).
//   node scripts/identity.mjs status [--dir ~/.csm] [--label L]         what the last SDK reading says about the logged-in account (fingerprint tag only)
//   node scripts/identity.mjs observe [--config ~/.csm/sdk-poller.json] [--live]   ONE identity-only SDK call (accountInfo; no usage request, no poller state change); dry-run without --live
//   node scripts/identity.mjs bind --label L --i-confirm-this-login [--dir ~/.csm] [--force]
//        binds label L to the login seen in the latest SDK reading (must be < 30 min old). Run the poller once while logged in to THE account first.
//   node scripts/identity.mjs unbind --label L [--dir ~/.csm]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { observeIdentity } from "../src/identity-observe.mjs";
import { bindLabel, readObservations, removeBinding, summarizeIdentity } from "../src/identity.mjs";

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { dir: { type: "string" }, config: { type: "string" }, live: { type: "boolean" }, label: { type: "string" }, "i-confirm-this-login": { type: "boolean" }, force: { type: "boolean" } } });
  const [cmd] = positionals;
  const dir = path.resolve(values.dir ?? path.join(os.homedir(), ".csm"));
  if (cmd === "status") {
    const s = summarizeIdentity({ dir, label: values.label ?? null });
    const last = readObservations(dir).at(-1);
    console.log(`identity: ${s.state} (${s.label ? `label ${s.label}, ` : ""}enforced ${s.enforced}, bound ${s.bound}${last?.fp ? `, login tag ${last.fp.slice(0, 6)}…` : ""}${s.lastObservationMinutesAgo !== null ? `, last SDK reading ${s.lastObservationMinutesAgo} min ago` : ""}${s.reason ? `, reason ${s.reason}` : ""})`);
    process.exit(s.state === "VERIFIED" ? 0 : 1);
  } else if (cmd === "observe") {
    // identity-only SDK call (accountInfo); no usage request, no poller state/backoff/snapshot change, no binding
    const configFile = path.resolve(values.config ?? path.join(dir, "sdk-poller.json"));
    let config;
    try {
      config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    } catch {
      throw new Error(`cannot read the poller config ${configFile}`);
    }
    const r = await observeIdentity({ config, live: values.live === true });
    if (r.outcome === "would-observe") console.log("Dry-run: would ask the pinned SDK for accountInfo() only (no usage request) and store a fingerprint. Add --live to do it.");
    else if (r.outcome === "observed") console.log(r.emailAvailable ? `email available: yes · login tag ${r.tag}… (stored as a fingerprint only). Next: identity.mjs bind --label <L> --i-confirm-this-login` : `email available: no (${r.reason}) — this login cannot be bound; usage stays unattributed`);
    else console.log(`${r.outcome}: ${r.reason ?? r.status}`);
    process.exit(r.outcome === "observed" && r.emailAvailable ? 0 : 1);
  } else if (cmd === "bind") {
    if (!values.label) throw new Error("--label is required");
    if (values["i-confirm-this-login"] !== true) throw new Error("bind records that the account logged in right now IS the owner of this label: add --i-confirm-this-login to attest it");
    const r = bindLabel(dir, { label: values.label, force: values.force === true });
    console.log(`Bound ${r.label} to the login observed at ${r.observedAt}. From now on usage is attributed to ${r.label} only while this login is active; any other login is quarantined.`);
  } else if (cmd === "unbind") {
    if (!values.label) throw new Error("--label is required");
    console.log(removeBinding(dir, values.label) ? `Binding for ${values.label} removed.` : `${values.label} had no binding.`);
  } else {
    throw new Error("Usage: identity.mjs status|bind|unbind (see the header of this file)");
  }
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
