// Strict UTC calendar-date helpers. Dates are always "YYYY-MM-DD" strings.
const DAY_MS = 86400000;

export function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  if (y < 2000 || y > 2100) return null;
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return t;
}

export function isDate(value) {
  return parseDate(value) !== null;
}

export function formatDate(t) {
  return new Date(t).toISOString().slice(0, 10);
}

export function addDays(date, n) {
  return formatDate(parseDate(date) + n * DAY_MS);
}

/** Whole days a - b. */
export function diffDays(a, b) {
  return Math.round((parseDate(a) - parseDate(b)) / DAY_MS);
}

/**
 * Parse a simulated clock (`--now`). The value MUST carry a zone designator ("Z" or "+09:00"): a bare "2026-10-30T11:05" would be read in
 * the machine's own time zone and silently move the Asia/Seoul schedule gates by hours or a day.
 */
export function parseNow(value) {
  const s = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s)) {
    throw new Error("--now must be an ISO timestamp WITH a time zone, e.g. 2026-10-30T11:05:00+09:00 or 2026-10-30T02:05:00Z");
  }
  const t = new Date(s);
  if (Number.isNaN(t.getTime())) throw new Error("--now is not a valid date/time");
  return t;
}

export function today(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Calendar date ("YYYY-MM-DD") of `now` in an IANA time zone, e.g. "Asia/Seoul". Throws on an unknown zone. */
export function todayIn(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Human-readable local time of an ISO instant, rounded to the nearest minute: "Sun 2026-10-25 11:00 KST".
 * Returns null for an unparsable value. Rounding matters for provider reset times such as 10:59:59.740, which mean "11:00".
 */
export function formatLocal(iso, timeZone) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(Math.round(t / 60000) * 60000);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${timeZone === "Asia/Seoul" ? "KST" : timeZone}`;
}

const KO_WEEKDAY = { Sun: "일", Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토" };

/** Korean variant of formatLocal: "2026-11-08(일) 11:00 KST" (rounded to the minute like formatLocal). Null for an unparsable value. */
export function formatLocalKo(iso, timeZone) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(Math.round(t / 60000) * 60000);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}(${KO_WEEKDAY[p.weekday]}) ${p.hour}:${p.minute} ${timeZone === "Asia/Seoul" ? "KST" : timeZone}`;
}

/** Add months, clamping the day to the end of the target month (Jan 31 + 1 => Feb 28/29). */
export function addMonths(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  const idx = y * 12 + (m - 1) + n;
  const ty = Math.floor(idx / 12);
  const tm = idx % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return formatDate(Date.UTC(ty, tm, Math.min(d, last)));
}

export function maxDate(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return a >= b ? a : b;
}

export function minDate(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return a <= b ? a : b;
}

/** Next monthly renewal on/after `now` (KST calendar) for a renewal day, clamped to short months, plus D-7/D-5/D-3 reminder dates. Pure calendar arithmetic. */
export function reminderDates(renewalDay, now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 3600000);
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const inMonth = (y, m) => new Date(Date.UTC(y, m, Math.min(renewalDay, new Date(Date.UTC(y, m + 1, 0)).getUTCDate())));
  const today = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate());
  let r = inMonth(kst.getUTCFullYear(), kst.getUTCMonth());
  if (r.getTime() < today) r = inMonth(kst.getUTCFullYear(), kst.getUTCMonth() + 1);
  const minus = (n) => iso(new Date(r.getTime() - n * 86400000));
  return { renewal: iso(r), d7: minus(7), d5: minus(5), d3: minus(3) };
}
