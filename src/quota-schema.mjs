// The csm-quota/v1 snapshot format and its strict validator: pure functions, no file access, no trust or admin logic. Shared by the admin side (src/quota.mjs
// re-exports everything here) and by the employee package, which must not carry the store, the trust classification or the admin ledger.
export const QUOTA_SCHEMA = "csm-quota/v1";
export const QUOTA_SOURCES = ["manual-screen", "official-api", "claude-code-statusline", "claude-agent-sdk-usage"];

const TOP_KEYS = ["schema", "account", "source", "observedAt", "fiveHour", "weekly"];
const WINDOW_KEYS = ["kind", "percent", "resetsAt"];
const safeKey = (k) => String(k).replace(/[^A-Za-z0-9_.-]/g, "?").slice(0, 40);
const isIso = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s));
const round2 = (n) => Math.round(n * 100) / 100;

function normalizeWindow(name, w, errors) {
  if (w === undefined) return null;
  if (!w || typeof w !== "object" || Array.isArray(w)) {
    errors.push(`${name} must be an object`);
    return null;
  }
  for (const k of Object.keys(w)) if (!WINDOW_KEYS.includes(k)) errors.push(`${name}: unexpected field "${safeKey(k)}"`);
  if (w.kind !== "used" && w.kind !== "remaining") errors.push(`${name}.kind must be "used" or "remaining" (what the source displayed)`);
  if (typeof w.percent !== "number" || !Number.isFinite(w.percent) || w.percent < 0 || w.percent > 100) {
    errors.push(`${name}.percent must be a number 0-100`);
  }
  if (w.resetsAt !== null && w.resetsAt !== undefined && !isIso(w.resetsAt)) errors.push(`${name}.resetsAt must be an ISO timestamp or null`);
  if (errors.length) return null;
  return {
    kind: w.kind,
    percent: w.percent,
    // Arithmetic complement of the observed figure only; not a prediction.
    usedPercent: w.kind === "used" ? w.percent : round2(100 - w.percent),
    remainingPercent: w.kind === "remaining" ? w.percent : round2(100 - w.percent),
    resetsAt: w.resetsAt ?? null,
  };
}

export function validateQuotaSnapshot(input, { now = new Date() } = {}) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["snapshot must be a JSON object"], snapshot: null };
  }
  for (const k of Object.keys(input)) if (!TOP_KEYS.includes(k)) errors.push(`unexpected field "${safeKey(k)}"`);
  if (input.schema !== QUOTA_SCHEMA) errors.push(`schema must be "${QUOTA_SCHEMA}"`);
  if (typeof input.account !== "string" || !input.account || input.account.length > 40) errors.push("account must be one id or alias");
  if (!QUOTA_SOURCES.includes(input.source)) errors.push(`source must be one of ${QUOTA_SOURCES.join(", ")}`);
  if (!isIso(input.observedAt)) errors.push("observedAt must be an ISO timestamp");
  else if (Date.parse(input.observedAt) > now.getTime() + 5 * 60000) errors.push("observedAt is in the future");
  const fiveHour = normalizeWindow("fiveHour", input.fiveHour, errors);
  const weekly = normalizeWindow("weekly", input.weekly, errors);
  if (input.fiveHour === undefined && input.weekly === undefined) errors.push("at least one of fiveHour / weekly is required");
  if (errors.length) return { ok: false, errors, snapshot: null };
  return {
    ok: true,
    errors: [],
    snapshot: { schema: QUOTA_SCHEMA, account: input.account, source: input.source, observedAt: input.observedAt, fiveHour, weekly },
  };
}
