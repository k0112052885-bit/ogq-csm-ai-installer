// resets_at is accepted as epoch seconds, epoch milliseconds or an ISO string (exact format is not verified against live output; see docs/statusline-setup.md).
// Anything else becomes null. Pure; shared by the statusLine parser (src/statusline.mjs) and the SDK/API response adapter, which is part of the employee package.
export function normalizeResetsAt(v) {
  let ms = null;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) ms = v > 1e12 ? v : v * 1000;
  else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) ms = Date.parse(v);
  if (ms === null || Number.isNaN(ms)) return null;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  return y >= 2000 && y <= 2100 ? d.toISOString() : null;
}
