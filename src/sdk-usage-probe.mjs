// EXPERIMENTAL, OPT-IN, READ-ONLY probe of the Claude Agent SDK's usage control request (`get_usage`), as an alternative to the
// statusLine's missing five_hour key. Written against the REAL declarations of @anthropic-ai/claude-agent-sdk 0.3.301:
//   Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(opts?: { skipBehaviors?: boolean }): Promise<SDKControlGetUsageResponse>
//   response.rate_limits.five_hour|seven_day = { utilization: number | null (percent USED, 0-100); resets_at: string | null (ISO 8601) } | null
// Design rules:
//  - nothing runs unless the caller explicitly opts in (see scripts/sdk-usage-probe.mjs; default is a dry-run plan);
//  - NO user message is ever sent: the query is opened with an idle input stream that yields nothing, the control request is
//    made, and the stream is closed. (Intended to avoid any model turn - UNVERIFIED against a live process.)
//  - `skipBehaviors: true` is ALWAYS passed: otherwise the SDK scans every local transcript of the last 7 days (conversation data);
//  - the child gets a sanitised environment (API-key / base-url / cloud-provider variables removed; per the SDK docs `env` REPLACES
//    the child's environment, so the rest is passed through explicitly), `persistSession: false`, no setting sources, no tools, no MCP;
//    no credentials are read or printed by this code;
//  - the raw response is never stored or printed: only subscription type, availability and the 5h/7d numbers; the response is first
//    validated against the declared shape, and anything that does not match ends the probe (the API is experimental).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fingerprintOf } from "./identity.mjs";
import { adaptOfficialUsage, MAPPING_SCHEMA, validateMapping } from "./official-usage-adapter.mjs";
import { SDK_PACKAGE, TYPES_URL, USAGE_METHOD_NAME } from "./sdk-preflight.mjs";
import { makeTempDir } from "./tempdir.mjs";

export const SDK_SOURCE = "claude-agent-sdk-usage";

/** utilization = percentage USED (0-100); resets_at = ISO 8601 string. Matches the declared SDKControlGetUsageResponse. */
export const DEFAULT_MAPPING = {
  schema: MAPPING_SCHEMA,
  docs: TYPES_URL,
  fiveHour: { used: "/rate_limits/five_hour/utilization", resetsAt: "/rate_limits/five_hour/resets_at" },
  weekly: { used: "/rate_limits/seven_day/utilization", resetsAt: "/rate_limits/seven_day/resets_at" },
};

const STRIP_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

export function sanitizedEnv(env = process.env) {
  const out = { ...env };
  for (const k of STRIP_ENV) delete out[k];
  return out;
}

const redact = (s) => String(s ?? "").replace(/(sk-ant-[\w-]+|xox[bp]-[\w-]+|Bearer\s+\S+|eyJ[\w-]{10,}\.[\w-]+\.[\w-]+)/g, "[redacted]").slice(0, 160);

/** Names (never values) of a value's structure. */
export function shapeOf(v, depth = 0) {
  if (v === null) return "null";
  if (Array.isArray(v)) return depth >= 4 ? "array" : ["array", v.length ? shapeOf(v[0], depth + 1) : "empty"];
  if (typeof v === "object") {
    if (depth >= 4) return "object";
    const out = {};
    for (const k of Object.keys(v).slice(0, 30)) out[/^[A-Za-z0-9_]{1,40}$/.test(k) ? k : "?"] = shapeOf(v[k], depth + 1);
    return out;
  }
  return typeof v;
}

/**
 * The usage method on a Query: the verified experimental name first, then `getUsage` (the name the SDK says the API will
 * get once stabilised), then any other `usage_EXPERIMENTAL*` variant. The type gate in the script only admits SDK versions
 * that declare the verified name with `skipBehaviors`.
 */
export function findUsageMethod(q) {
  const names = new Set();
  for (let o = q; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) for (const n of Object.getOwnPropertyNames(o)) if (typeof q[n] === "function") names.add(n);
  const all = [...names];
  const name = all.includes(USAGE_METHOD_NAME) ? USAGE_METHOD_NAME : all.includes("getUsage") ? "getUsage" : all.find((n) => /^usage_EXPERIMENTAL/.test(n)) ?? null;
  return { name, fn: name ? q[name].bind(q) : null, candidates: all.filter((n) => /usage/i.test(n)).slice(0, 10) };
}

const isWindow = (w) => w === null || w === undefined || (typeof w === "object" && !Array.isArray(w) && (w.utilization === null || typeof w.utilization === "number") && (w.resets_at === null || typeof w.resets_at === "string"));

/** Runtime twin of the declaration check: does the response have the declared shape? Experimental API => anything else ends the probe. */
export function checkUsageResponse(resp) {
  const reasons = [];
  if (!resp || typeof resp !== "object" || Array.isArray(resp)) return { ok: false, reasons: ["the usage response is not an object"] };
  if (typeof resp.rate_limits_available !== "boolean") reasons.push("rate_limits_available is not a boolean");
  if (resp.subscription_type !== null && typeof resp.subscription_type !== "string") reasons.push("subscription_type is neither string nor null");
  const rl = resp.rate_limits;
  if (rl !== null && (typeof rl !== "object" || Array.isArray(rl) || rl === undefined)) reasons.push("rate_limits is neither an object nor null");
  else if (rl) for (const k of ["five_hour", "seven_day"]) if (!isWindow(rl[k])) reasons.push(`rate_limits.${k} does not look like { utilization: number|null, resets_at: string|null }`);
  return { ok: reasons.length === 0, reasons };
}

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`${label} timed out after ${ms} ms`)), ms)))]).finally(() => clearTimeout(t));
}

export const defaultLoadSdk = () => import(/* a variable keeps this optional dependency out of static analysis */ SDK_PACKAGE);

/**
 * Runs the probe. `loadSdk` is injectable (tests use a fake SDK). Never throws: returns { status, ... }.
 * status: ok | rate-limits-unavailable | no-windows | api-incompatible | sdk-not-installed | sdk-incompatible | method-not-found | timeout | error
 */
/**
 * Account identity of the SAME child process that answered the usage request: Query.accountInfo() (declared in SDK 0.3.301, every field optional).
 * Only a salted HMAC fingerprint of the e-mail leaves this function; the raw AccountInfo is dropped. Never throws.
 */
export async function readIdentity(q, salt, timeoutMs = 15000) {
  if (typeof q?.accountInfo !== "function") return { ok: false, reason: "accountInfo-missing" };
  try {
    return fingerprintOf(await withTimeout(Promise.resolve(q.accountInfo()), Math.min(timeoutMs, 15000), "accountInfo"), salt);
  } catch {
    return { ok: false, reason: "accountInfo-failed" };
  }
}

/**
 * IDENTITY-ONLY probe: same isolated, prompt-free child as probeUsage, but it asks ONLY Query.accountInfo(); the usage (rate-limit) request is never made.
 * Returns { status: "ok"|"sdk-not-installed"|"sdk-incompatible"|"timeout"|"error"|"model-activity", identity, error }; identity is { ok, fingerprint, device } | { ok:false, reason }.
 * Never returns the raw AccountInfo or the e-mail. Never throws.
 */
export async function probeIdentity({ loadSdk = defaultLoadSdk, env = process.env, salt, timeoutMs = 20000, scratchBases } = {}) {
  const result = { status: "error", identity: null, messages: { total: 0, modelActivity: false }, error: null };
  if (!salt) return { ...result, error: "no salt" };
  let sdk;
  try {
    sdk = await loadSdk();
  } catch (e) {
    const notFound = e?.code === "ERR_MODULE_NOT_FOUND" || /Cannot find/.test(String(e?.message));
    return { ...result, status: notFound ? "sdk-not-installed" : "sdk-incompatible", error: redact(notFound ? `${SDK_PACKAGE} is not installed` : `the SDK module failed to load: ${e?.message}`) };
  }
  const query = sdk?.query ?? sdk?.default?.query;
  if (typeof query !== "function") return { ...result, status: "sdk-incompatible", error: "the SDK module does not export query()" };
  let cwd;
  try {
    cwd = makeTempDir("csm-sdk-identity-", scratchBases ? { bases: scratchBases } : undefined);
  } catch (e) {
    return { ...result, error: redact(`no writable scratch directory: ${e?.message}`) };
  }
  const abort = new AbortController();
  let release;
  const gate = new Promise((r) => (release = r));
  const idle = (async function* () {
    await gate;
  })();
  let q;
  let drain = Promise.resolve();
  try {
    q = query({ prompt: idle, options: { cwd, env: sanitizedEnv(env), abortController: abort, persistSession: false, settingSources: [], tools: [], allowedTools: [], strictMcpConfig: true, mcpServers: {} } });
    drain = (async () => {
      try {
        for await (const m of q) {
          result.messages.total++;
          if (m?.type === "assistant" || m?.type === "result") result.messages.modelActivity = true;
        }
      } catch {
        /* the stream ends with an error when we close it */
      }
    })();
    result.identity = await readIdentity(q, salt, timeoutMs);
    await new Promise((r) => setTimeout(r, 20)); // let already-queued stream messages be counted before judging model activity
    if (result.messages.modelActivity) return { ...result, status: "model-activity", identity: null };
    return { ...result, status: "ok" };
  } catch (e) {
    return { ...result, status: "error", error: redact(e?.message) };
  } finally {
    release();
    try {
      abort.abort();
      await q?.close?.();
    } catch {
      /* best effort */
    }
    await Promise.race([drain, new Promise((r) => setTimeout(r, 500))]);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

export async function probeUsage({ loadSdk = defaultLoadSdk, env = process.env, account, mapping = DEFAULT_MAPPING, describeShape = false, timeoutMs = 20000, now = new Date(), scratchBases, identitySalt = null } = {}) {
  const result = { status: "error", identity: null, method: null, subscriptionType: null, rateLimitsAvailable: null, raw: null, omitted: [], shape: null, messages: { total: 0, types: {}, modelActivity: false }, error: null };
  const mv = validateMapping(mapping);
  if (!mv.ok) return { ...result, error: `mapping invalid: ${mv.errors.join("; ")}` };
  let sdk;
  try {
    sdk = await loadSdk();
  } catch (e) {
    const notFound = e?.code === "ERR_MODULE_NOT_FOUND" || /Cannot find/.test(String(e?.message));
    return { ...result, status: notFound ? "sdk-not-installed" : "sdk-incompatible", error: redact(notFound ? `${SDK_PACKAGE} is not installed` : `the SDK module failed to load: ${e?.message}`) };
  }
  const query = sdk?.query ?? sdk?.default?.query;
  if (typeof query !== "function") return { ...result, status: "sdk-incompatible", error: "the SDK module does not export query()" };

  // empty directory: no project files or CLAUDE.md to load. System temp dir first, then a project-local fallback (sandboxes may refuse /tmp with EPERM);
  // settingSources:[] below keeps the SDK from reading settings or CLAUDE.md from any parent folder. A failure is a result, never a throw.
  let cwd;
  try {
    cwd = makeTempDir("csm-sdk-probe-", scratchBases ? { bases: scratchBases } : undefined); // scratchBases: test hook
  } catch (e) {
    return { ...result, status: "error", error: redact(`no writable scratch directory for the probe: ${e?.message}`) };
  }
  const abort = new AbortController();
  let release;
  const gate = new Promise((r) => (release = r));
  // Idle input stream: yields NO message (so no model turn); it just ends when released.
  const idle = (async function* () {
    await gate;
  })();
  let q;
  let drain = Promise.resolve();
  try {
    q = query({
      prompt: idle,
      options: {
        cwd,
        env: sanitizedEnv(env), // replaces the child's environment entirely (SDK docs), hence built from the full env minus API-billing variables
        abortController: abort,
        persistSession: false, // do not write a session to ~/.claude/projects
        settingSources: [], // SDK isolation mode: no user/project/local settings, hooks or CLAUDE.md
        tools: [], // no built-in tools
        allowedTools: [],
        strictMcpConfig: true,
        mcpServers: {},
      },
    });
    drain = (async () => {
      try {
        for await (const m of q) {
          result.messages.total++;
          const t = typeof m?.type === "string" && /^[a-z_]{1,30}$/.test(m.type) ? m.type : "unknown";
          result.messages.types[t] = (result.messages.types[t] ?? 0) + 1;
          if (t === "assistant" || t === "result") result.messages.modelActivity = true; // would mean a model turn happened
        }
      } catch {
        /* the stream ends with an error when we close it */
      }
    })();
    const found = findUsageMethod(q);
    if (!found.fn) return { ...result, status: "method-not-found", error: `no ${USAGE_METHOD_NAME} / getUsage method on the query object${found.candidates.length ? `; usage-like names: ${found.candidates.join(", ")}` : ""}` };
    result.method = found.name;
    // skipBehaviors:true - never let the SDK scan local transcripts (conversation data) for the "behaviors" section
    const resp = await withTimeout(Promise.resolve(found.fn({ skipBehaviors: true })), timeoutMs, "usage request");
    const compat = checkUsageResponse(resp);
    if (!compat.ok) return { ...result, status: "api-incompatible", error: `response does not match the declared shape: ${compat.reasons.join("; ")}` };
    if (identitySalt) result.identity = await readIdentity(q, identitySalt, timeoutMs); // same process/login as the usage answer
    result.subscriptionType = typeof resp.subscription_type === "string" && /^[A-Za-z0-9_-]{1,30}$/.test(resp.subscription_type) ? resp.subscription_type : null;
    result.rateLimitsAvailable = resp.rate_limits_available;
    if (describeShape) result.shape = shapeOf(resp);
    if (resp.rate_limits_available === false || resp.rate_limits === null) return { ...result, status: "rate-limits-unavailable" };
    const adapted = adaptOfficialUsage(resp, mapping, { account, now, source: SDK_SOURCE });
    result.omitted = adapted.omitted;
    if (!adapted.ok) {
      const onlyEmpty = adapted.errors.every((e) => /none of the mapped values/.test(e));
      return { ...result, status: onlyEmpty ? "no-windows" : "api-incompatible", error: adapted.errors.join("; ").slice(0, 200) };
    }
    return { ...result, status: "ok", raw: adapted.raw };
  } catch (e) {
    return { ...result, status: /timed out/.test(String(e?.message)) ? "timeout" : "error", error: redact(e?.message) };
  } finally {
    release();
    try {
      abort.abort();
      await q?.close?.();
    } catch {
      /* closing is best effort */
    }
    await Promise.race([drain, new Promise((r) => setTimeout(r, 500))]);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
