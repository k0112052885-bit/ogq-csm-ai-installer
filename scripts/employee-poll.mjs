#!/usr/bin/env node
// One scheduling decision of the usage poller, for the employee package's background agent (the full admin tool, sdk-usage-poller.mjs, pulls in reporting and Slack
// modules and is NOT part of the package). The poller itself decides whether to ask the Claude SDK now (interval, back-off, halt, version pin, lock); it only runs when the
// config says "enabled": true, which the consented install-agents step sets. No prompt is sent, nothing is sent anywhere.
//   node scripts/employee-poll.mjs --config <root>/data/sdk-poller.json
import fs from "node:fs";
import { parseArgs } from "node:util";
import { pollOnce, validateConfig } from "../src/sdk-poller.mjs";

try {
  const { values } = parseArgs({ options: { config: { type: "string" } } });
  if (!values.config) throw new Error("--config is required");
  const config = JSON.parse(fs.readFileSync(values.config, "utf8"));
  const v = validateConfig(config);
  if (!v.ok) throw new Error(`invalid poller config: ${v.errors[0]}`);
  const r = await pollOnce({ config, now: new Date() });
  console.log(JSON.stringify({ ok: true, outcome: r.outcome, status: r.status ?? null, wrote: r.wrote === true }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e.message).slice(0, 200) }));
  process.exit(1);
}
