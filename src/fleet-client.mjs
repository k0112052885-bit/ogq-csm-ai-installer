// Employee-side client of the intake transport. It sends ONLY what the file hand-off would carry (the signed enrollment request, the signed readings) and asks whether the
// device was approved. No credentials, cookies or admin secrets exist on this side: authenticity comes from the device's own signatures, and the approval it receives is verified
// against the aggregator key that came inside the invite. Secure by construction: https is required (plain http only for localhost tests), redirects are refused, calls time out,
// responses are size-capped, and a network failure is reported as "retry" instead of throwing. `fetchImpl` is injectable for tests.
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
export const MAX_RESPONSE_BYTES = 65536;

/** Returns the normalized base (origin without trailing slash). Throws a plain message for anything that is not a bare https origin (or a localhost http one). */
export function validateIngestUrl(value) {
  let u;
  try {
    u = new URL(String(value));
  } catch {
    throw new Error("the ingest address must be a URL such as https://dashboard.example.com");
  }
  if (u.username || u.password || u.search || u.hash || u.pathname !== "/") throw new Error("the ingest address must be a bare origin (no credentials, path, query or fragment)");
  if (u.protocol === "https:") return u.origin;
  if (u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname)) return u.origin; // local tests only: nothing leaves this machine
  throw new Error("the ingest address must use https (plain http is accepted only for localhost testing)");
}

async function request(base, method, pathname, body, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  try {
    const res = await fetchImpl(`${base}${pathname}`, { method, headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    if (res.status >= 300 && res.status < 400) return { ok: false, status: res.status, retry: false, error: "redirect refused" };
    const text = String(await res.text()).slice(0, MAX_RESPONSE_BYTES);
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, body: parsed, retry: res.status >= 500 || res.status === 429 || res.status === 408 };
  } catch {
    return { ok: false, status: 0, body: null, retry: true, error: "network" }; // offline, DNS, TLS failure, timeout: keep the work queued
  }
}

export const submitEnrollment = (base, enrollRequest, opts) => request(base, "POST", "/api/v1/enroll", enrollRequest, opts);
export const fetchApproval = (base, deviceId, opts) => request(base, "GET", `/api/v1/approval/${encodeURIComponent(deviceId)}`, undefined, opts);
export const deliverReading = (base, envelope, opts) => request(base, "POST", "/api/v1/readings", envelope, opts);
