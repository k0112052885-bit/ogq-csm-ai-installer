import { isDate } from "./dates.mjs";

export const SCHEMA_VERSION = 1;

export const PLANS = {
  max20x: { label: "Max 20x" },
  max5x: { label: "Max 5x" },
  pro: { label: "Pro" },
  other: { label: "Other (unspecified)" },
};

/** Ladder used only for upgrade/downgrade suggestions; plans outside it never get a tier suggestion. */
export const PLAN_LADDER = ["pro", "max5x", "max20x"];

export const CATEGORIES = ["development", "mixed", "general"];

export const MAX_FLEXIBLE_ACCOUNTS = 50;
export const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Empty registry for the flexible layout (any number of accounts, registered later via the team file). */
export function createFlexibleState(now = new Date().toISOString()) {
  return { schemaVersion: SCHEMA_VERSION, layout: "flexible", createdAt: now, currency: "USD", settings: { ...DEFAULT_SETTINGS }, accounts: [], activity: [], coverage: [] };
}

export const SOURCES = ["import", "manual"];

export const DEFAULT_SETTINGS = {
  inactiveWarnDays: 7,
  inactiveCancelDays: 14,
  renewalLeadDays: 3,
  highFrequencyActiveDays7: 5,
  demandSessions7d: 30,
  demandMessages7d: 300,
  staleCoverageDays: 3,
};

export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

export function validateAlias(alias) {
  if (typeof alias !== "string" || !ALIAS_RE.test(alias)) {
    return "alias must be 1-40 chars of letters, digits, space, '.', '_' or '-' (no emails or real identities)";
  }
  return null;
}

export function validateCurrency(c) {
  return typeof c === "string" && CURRENCY_RE.test(c) ? null : "currency must be a 3-letter ISO code such as USD";
}

/** Fixed 4 x (Max 20x, development) + 2 x (Max 5x, mixed) layout with neutral placeholder aliases. */
export function createInitialState(now = new Date().toISOString()) {
  const accounts = [];
  for (let i = 1; i <= 4; i++) {
    accounts.push(newAccount(`dev-20x-${i}`, `DEV-20X-${i}`, "max20x", "development"));
  }
  for (let i = 1; i <= 2; i++) {
    accounts.push(newAccount(`mixed-5x-${i}`, `MIXED-5X-${i}`, "max5x", "mixed"));
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: now,
    currency: "USD",
    settings: { ...DEFAULT_SETTINGS },
    accounts,
    activity: [],
    coverage: [],
  };
}

function newAccount(id, alias, plan, category) {
  return {
    id,
    alias,
    plan,
    category,
    active: true,
    monthlyPrice: null, // actual price is entered manually; never guessed
    renewalDate: null,
    notes: "",
  };
}

const isNonNegInt = (n) => Number.isInteger(n) && n >= 0 && n <= 1e9;

/** Returns a list of human-readable problems; empty list means valid. */
export function validateState(state) {
  const errors = [];
  if (!state || typeof state !== "object") return ["state is not an object"];
  if (state.schemaVersion !== SCHEMA_VERSION) errors.push(`unsupported schemaVersion ${state.schemaVersion}`);
  const cerr = validateCurrency(state.currency);
  if (cerr) errors.push(cerr);
  if (!state.settings || typeof state.settings !== "object") {
    errors.push("settings missing");
  } else {
    for (const k of SETTING_KEYS) {
      if (!isNonNegInt(state.settings[k])) errors.push(`settings.${k} must be a non-negative integer`);
    }
    if (state.settings.inactiveWarnDays >= state.settings.inactiveCancelDays) {
      errors.push("settings.inactiveWarnDays must be smaller than inactiveCancelDays");
    }
  }
  const accounts = Array.isArray(state.accounts) ? state.accounts : null;
  if (!accounts) return [...errors, "accounts must be an array"];
  if (state.layout !== undefined && state.layout !== "fixed" && state.layout !== "flexible") errors.push('layout must be "fixed" or "flexible"');
  if (state.layout === "flexible") {
    // Registered by the admin via the team file: any number of accounts, any known plan/category.
    if (accounts.length > MAX_FLEXIBLE_ACCOUNTS) errors.push(`flexible layout allows at most ${MAX_FLEXIBLE_ACCOUNTS} accounts`);
    for (const a of accounts) if (a && typeof a.id === "string" && !ACCOUNT_ID_RE.test(a.id)) errors.push(`${a.id.slice(0, 40)}: account id must match ${ACCOUNT_ID_RE}`);
  } else {
    // Legacy fixed layout (default of `csm init`): exactly 4 x Max 20x development + 2 x Max 5x mixed.
    if (accounts.length !== 6) errors.push(`expected exactly 6 accounts, found ${accounts.length}`);
    const dev = accounts.filter((a) => a.plan === "max20x" && a.category === "development").length;
    const mixed = accounts.filter((a) => a.plan === "max5x" && a.category === "mixed").length;
    if (dev !== 4 || mixed !== 2) errors.push(`expected 4 max20x/development + 2 max5x/mixed, found ${dev} + ${mixed}`);
  }
  const ids = new Set();
  const aliases = new Set();
  for (const a of accounts) {
    if (!a || typeof a.id !== "string" || !a.id) {
      errors.push("account without id");
      continue;
    }
    if (ids.has(a.id)) errors.push(`duplicate account id ${a.id}`);
    ids.add(a.id);
    const aerr = validateAlias(a.alias);
    if (aerr) errors.push(`${a.id}: ${aerr}`);
    if (aliases.has(a.alias)) errors.push(`duplicate alias ${a.alias}`);
    aliases.add(a.alias);
    if (!PLANS[a.plan]) errors.push(`${a.id}: unknown plan`);
    if (!CATEGORIES.includes(a.category)) errors.push(`${a.id}: unknown category`);
    if (typeof a.active !== "boolean") errors.push(`${a.id}: active must be boolean`);
    if (a.monthlyPrice !== null && !(typeof a.monthlyPrice === "number" && Number.isFinite(a.monthlyPrice) && a.monthlyPrice >= 0)) {
      errors.push(`${a.id}: monthlyPrice must be null or a non-negative number`);
    }
    if (a.renewalDate !== null && !isDate(a.renewalDate)) errors.push(`${a.id}: renewalDate must be null or YYYY-MM-DD`);
  }
  for (const r of Array.isArray(state.activity) ? state.activity : [errors.push("activity must be an array")]) {
    if (!r || typeof r !== "object") continue;
    if (!ids.has(r.accountId)) errors.push(`activity references unknown account ${r.accountId}`);
    if (!SOURCES.includes(r.source)) errors.push(`activity has unknown source ${r.source}`);
    if (r.kind === "day") {
      if (!isDate(r.date)) errors.push("day activity has invalid date");
      for (const f of ["sessions", "messages", "tokens", "activeMinutes"]) {
        if (!isNonNegInt(r[f])) errors.push(`day activity ${f} invalid`);
      }
    } else if (r.kind === "week") {
      if (!isDate(r.weekStart)) errors.push("week activity has invalid weekStart");
      if (!Number.isInteger(r.activeDays) || r.activeDays < 0 || r.activeDays > 7) errors.push("week activeDays must be 0-7");
      if (r.lastActiveDate !== null && !isDate(r.lastActiveDate)) errors.push("week lastActiveDate invalid");
    } else {
      errors.push(`activity has unknown kind ${r.kind}`);
    }
  }
  for (const c of Array.isArray(state.coverage) ? state.coverage : [errors.push("coverage must be an array")]) {
    if (!c || !ids.has(c.accountId) || !isDate(c.from) || !isDate(c.to) || c.from > c.to) {
      errors.push("invalid coverage entry");
    }
  }
  return errors;
}
