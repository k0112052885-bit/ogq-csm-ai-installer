// DORMANT SEAM - no official source for the 5-hour value is currently verified, so nothing in this repo uses this by default.
// If Anthropic documents a machine-readable usage response (CLI/SDK/API), an admin can describe where the numbers sit in that
// response with a small mapping file and import a locally saved copy of the response. The mapping must cite the official
// documentation (https URL). The adapter only EXTRACTS what the response contains: a missing field drops that window, nothing is
// computed or guessed, and this code makes no network call and touches no credentials.
import { QUOTA_SCHEMA, validateQuotaSnapshot } from "./quota-schema.mjs"; // pure format only: no store, no trust/admin modules (employee package boundary)
import { normalizeResetsAt } from "./resets-at.mjs";

export const MAPPING_SCHEMA = "csm-official-mapping/v1";
const POINTER_RE = /^(\/[A-Za-z0-9_-]{1,40}){1,8}$/;
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);
const WINDOW_KEYS = ["used", "remaining", "resetsAt"];

export function validatePointer(ptr) {
  return typeof ptr === "string" && POINTER_RE.test(ptr) && !ptr.split("/").some((s) => FORBIDDEN.has(s));
}

/** Safe JSON-pointer lookup over own properties only; undefined when anything on the path is missing. */
export function getPointer(obj, ptr) {
  let cur = obj;
  for (const seg of ptr.split("/").slice(1)) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

export function validateMapping(m) {
  const errors = [];
  if (!m || typeof m !== "object" || Array.isArray(m)) return { ok: false, errors: ["mapping must be a JSON object"] };
  for (const k of Object.keys(m)) if (!["schema", "docs", "fiveHour", "weekly"].includes(k)) errors.push(`unexpected field "${String(k).slice(0, 40)}"`);
  if (m.schema !== MAPPING_SCHEMA) errors.push(`schema must be "${MAPPING_SCHEMA}"`);
  if (typeof m.docs !== "string" || !/^https:\/\/[^\s]{4,290}$/.test(m.docs)) errors.push("docs must be the https URL of the OFFICIAL documentation that describes this response");
  if (!m.fiveHour && !m.weekly) errors.push("map at least one window (fiveHour and/or weekly)");
  for (const w of ["fiveHour", "weekly"]) {
    if (m[w] === undefined) continue;
    const spec = m[w];
    if (!spec || typeof spec !== "object") {
      errors.push(`${w} must be an object`);
      continue;
    }
    for (const k of Object.keys(spec)) if (!WINDOW_KEYS.includes(k)) errors.push(`${w}: unexpected field "${String(k).slice(0, 40)}"`);
    if ((spec.used === undefined) === (spec.remaining === undefined)) errors.push(`${w}: give exactly one of used / remaining`);
    for (const k of WINDOW_KEYS) if (spec[k] !== undefined && !validatePointer(spec[k])) errors.push(`${w}.${k}: not a safe JSON pointer such as /usage/five_hour/percent`);
  }
  return { ok: errors.length === 0, errors };
}

const toPercent = (v) => {
  const n = typeof v === "string" && /^\d{1,3}(\.\d{1,6})?$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
};

/** Returns { ok, errors, raw, omitted } where raw is a csm-quota/v1 snapshot with source "official-api". */
export function adaptOfficialUsage(response, mapping, { account, now = new Date(), source = "official-api" } = {}) {
  const mv = validateMapping(mapping);
  if (!mv.ok) return { ok: false, errors: mv.errors, raw: null, omitted: [] };
  const errors = [];
  const omitted = [];
  const raw = { schema: QUOTA_SCHEMA, account, source, observedAt: now.toISOString() };
  for (const w of ["fiveHour", "weekly"]) {
    const spec = mapping[w];
    if (!spec) continue;
    const kind = spec.used !== undefined ? "used" : "remaining";
    const value = getPointer(response, spec[kind]);
    if (value === undefined || value === null) {
      omitted.push(w); // the response did not contain it: the window is simply not reported
      continue;
    }
    const percent = toPercent(value);
    if (percent === null) {
      errors.push(`${w}: value at ${spec[kind]} is not a percentage 0-100`);
      continue;
    }
    raw[w] = { kind, percent, resetsAt: spec.resetsAt ? normalizeResetsAt(getPointer(response, spec.resetsAt)) : null };
  }
  if (!raw.fiveHour && !raw.weekly && !errors.length) errors.push("the response contains none of the mapped values");
  if (errors.length) return { ok: false, errors, raw: null, omitted };
  const v = validateQuotaSnapshot(raw, { now: new Date(now.getTime() + 1000) });
  return v.ok ? { ok: true, errors: [], raw, omitted } : { ok: false, errors: v.errors, raw: null, omitted };
}
