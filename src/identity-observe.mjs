// One-shot, identity-ONLY observation: asks the pinned SDK for Query.accountInfo() (no usage / rate-limit request), stores only the HMAC fingerprint in the
// private observation log so that `identity.mjs bind` has something to bind. It never touches the poller's state, backoff, interval, snapshot or quarantine,
// never binds, never prints the e-mail, and sends nothing anywhere. Dry-run unless live is true.
import { pathToFileURL } from "node:url";
import { ensureSalt, recordObservation } from "./identity.mjs";
import { realPreflight, summarizePoller, validateConfig } from "./sdk-poller.mjs";
import { probeIdentity } from "./sdk-usage-probe.mjs";

export async function observeIdentity({ config, now = new Date(), live = false, preflight = realPreflight, probe = probeIdentity }) {
  const v = validateConfig(config);
  if (!v.ok) throw new Error(`Invalid poller config:\n- ${v.errors.join("\n- ")}`);
  const pre = preflight(config);
  if (!pre.installed) return { outcome: "refused", reason: "the SDK is not installed" };
  if (pre.version !== config.pinnedVersion) return { outcome: "refused", reason: `installed SDK ${pre.version} is not the pinned ${config.pinnedVersion}` };
  if (!pre.compat?.ok) return { outcome: "refused", reason: "the installed SDK declarations do not match what the probe relies on" };
  if (summarizePoller(config.dir, now).halted?.status === "model-activity") return { outcome: "refused", reason: "the poller is halted for model activity: review it first" };
  if (!live) return { outcome: "would-observe" };
  const salt = ensureSalt(config.dir);
  const loadSdk = config.sdkModule ? async () => import(pathToFileURL(config.sdkModule).href) : undefined;
  const r = await probe({ loadSdk, salt, timeoutMs: config.timeoutSeconds * 1000 });
  if (r.status !== "ok") return { outcome: "failed", status: r.status };
  recordObservation(config.dir, { t: now, identity: r.identity, source: "sdk-identity" });
  return r.identity?.ok ? { outcome: "observed", emailAvailable: true, tag: r.identity.fingerprint.slice(0, 6) } : { outcome: "observed", emailAvailable: false, reason: r.identity?.reason ?? "unknown" };
}
