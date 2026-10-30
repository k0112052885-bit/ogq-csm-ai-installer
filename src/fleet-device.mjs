// Employee-device side of the multi-device aggregator. Holds a device-local signing key (0600) and turns the device's own VERIFIED SDK reading into one signed
// reading envelope. Nothing here talks to a network or to Slack; envelopes are plain files the employee hands to the admin. No e-mail, token or Slack secret is
// read or stored: the only identity material is the device-local login tag (HMAC fingerprint) produced by src/identity.mjs.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { bindingFor, gateSourceFiles } from "./identity.mjs";
import { ACCOUNT_ID_RE } from "./model.mjs";
import { ENROLL_SCHEMA, JOIN_SCHEMA, enrollBody, joinBody, writePrivate } from "./fleet-protocol.mjs"; // NOT the registry: that module is admin-only
import { generateKeyPair, hmacHex, keyId, sas, sign, verify } from "./fleet-crypto.mjs";

export const DEVICE_FILE = "device.json";
export const READING_SCHEMA = "csm-fleet-reading/v1";

export function loadDevice(deviceDir) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(deviceDir, DEVICE_FILE), "utf8"));
    return d && typeof d.deviceId === "string" && typeof d.privateKey === "string" ? d : null;
  } catch {
    return null;
  }
}
const saveDevice = (deviceDir, d) => writePrivate(path.join(deviceDir, DEVICE_FILE), d);

/**
 * Step "enroll": needs the invite and a login already bound on this device (the tag is the binding's fingerprint). Creates the device key, stores the
 * invite's aggregator public key, returns the enrollment request (public key + login tag + proofs) and the short code to read to the admin.
 */
export function enrollDevice({ deviceDir, invite, sourceDir, label, now = new Date() }) {
  if (!invite || invite.schema !== "csm-fleet-invite/v1") throw new Error("enroll: not an invite file");
  if (Date.parse(invite.expiresAt) < now.getTime()) throw new Error("enroll: the invite has expired; ask the admin for a new one");
  if (loadDevice(deviceDir)) throw new Error("enroll: this device is already enrolled (remove the device folder only after the admin revoked it)");
  const binding = bindingFor(sourceDir, label);
  if (!binding) throw new Error(`enroll: ${label} is not bound to the logged-in account on this device (run identity.mjs observe --live, then bind)`);
  const kp = generateKeyPair();
  const request = { schema: ENROLL_SCHEMA, inviteId: invite.inviteId, deviceId: invite.deviceId, publicKey: kp.publicKey, deviceFp: binding.fingerprint };
  const body = enrollBody(request);
  request.proof = hmacHex(invite.code, body); // the one-time code never leaves the device: only this MAC does
  request.signature = sign(kp.privateKey, body);
  saveDevice(deviceDir, { deviceId: invite.deviceId, accountId: invite.accountId, label, publicKey: kp.publicKey, privateKey: kp.privateKey, aggregatorPublicKey: invite.aggregatorPublicKey, deviceFp: binding.fingerprint, seq: 0, approved: false, enrolledAt: now.toISOString() });
  return { request, sas: sas({ deviceId: invite.deviceId, publicKey: kp.publicKey, deviceFp: binding.fingerprint }) };
}

/**
 * Self-service join (no invite): creates the device key, sends ONLY the public key, the login tag and a short alias through `submit(request)` (the intake client), and keeps the
 * device PENDING. The aggregator public key comes back in the same TLS-authenticated answer; every later approval is verified against it. Nothing is stored unless the server answered.
 * The account is NOT chosen here: the administrator assigns it at approval (finalizeApproval then records it).
 */
export async function joinDevice({ deviceDir, sourceDir, label, now = new Date(), submit, rng = crypto.randomBytes }) {
  if (loadDevice(deviceDir)) throw new Error("join: this device is already registered (remove the device folder only after the admin revoked it)");
  const binding = bindingFor(sourceDir, label);
  if (!binding) throw new Error(`join: ${label} is not bound to the logged-in account on this device (run observe, then bind)`);
  const kp = generateKeyPair();
  const request = { schema: JOIN_SCHEMA, label, publicKey: kp.publicKey, deviceFp: binding.fingerprint, nonce: Buffer.from(rng(16)).toString("hex") };
  request.signature = sign(kp.privateKey, joinBody(request));
  const res = await submit(request);
  const b = res?.body;
  if (!res?.ok || !/^dev_[0-9a-f]{16}$/.test(String(b?.deviceId)) || typeof b?.aggregatorPublicKey !== "string" || !/^[A-Za-z0-9+/=]{40,200}$/.test(b.aggregatorPublicKey)) {
    return { joined: false, status: res?.status ?? 0, reason: String(b?.error ?? res?.error ?? "no usable answer").slice(0, 80) };
  }
  saveDevice(deviceDir, { deviceId: b.deviceId, accountId: null, label, publicKey: kp.publicKey, privateKey: kp.privateKey, aggregatorPublicKey: b.aggregatorPublicKey, deviceFp: binding.fingerprint, seq: 0, approved: false, self: true, enrolledAt: now.toISOString() });
  return { joined: true, deviceId: b.deviceId, sas: sas({ deviceId: b.deviceId, publicKey: kp.publicKey, deviceFp: binding.fingerprint }) };
}

/** Step "finalize": accepts the admin's signed approval (verified with the aggregator key that came inside the invite, or - self-service - in the join answer). */
export function finalizeApproval({ deviceDir, approval }) {
  const d = loadDevice(deviceDir);
  if (!d) throw new Error("finalize: this device has not been enrolled");
  const p = approval?.payload;
  if (!p || p.schema !== "csm-fleet-approval/v1" || !verify(d.aggregatorPublicKey, p, approval.signature)) throw new Error("finalize: the approval is not signed by the aggregator this device registered with");
  const selfAssign = d.self === true && d.accountId === null; // self-service: the administrator's signed choice of account is recorded now
  if (p.deviceId !== d.deviceId || (selfAssign ? typeof p.accountId !== "string" || !ACCOUNT_ID_RE.test(p.accountId) : p.accountId !== d.accountId)) throw new Error("finalize: the approval is for another device or account");
  if (p.aggregatorKeyId !== keyId(d.aggregatorPublicKey)) throw new Error("finalize: aggregator key mismatch");
  saveDevice(deviceDir, { ...d, accountId: p.accountId, approved: true, approvedAt: p.approvedAt });
  return { deviceId: d.deviceId, accountId: p.accountId };
}

/**
 * Step "reading": ONE signed envelope from the newest local SDK reading, only if (a) the device is approved, (b) the local identity gate says the reading
 * belongs to the bound login (sidecar trust verified) and (c) that login is still the one enrolled. Otherwise returns { skipped: reason } and signs nothing.
 */
export function makeReading({ deviceDir, sourceDir, now = new Date(), rng = crypto.randomBytes }) {
  const d = loadDevice(deviceDir);
  if (!d) return { skipped: "not-enrolled" };
  if (!d.approved) return { skipped: "not-approved" };
  const gate = gateSourceFiles({ sourceDir, label: d.label, requireIdentity: true });
  const g = gate.files["sdk-quota-latest.json"];
  if (!g?.use || g.trust !== "verified") return { skipped: "identity-not-verified" };
  const binding = bindingFor(sourceDir, d.label);
  if (!binding || binding.fingerprint !== d.deviceFp) return { skipped: "login-changed" };
  let snap;
  try {
    snap = JSON.parse(fs.readFileSync(path.join(sourceDir, "sdk-quota-latest.json"), "utf8"));
  } catch {
    return { skipped: "no-reading" };
  }
  if (typeof snap.observedAt !== "string" || Number.isNaN(Date.parse(snap.observedAt))) return { skipped: "no-reading" };
  if (d.lastObservedAt && Date.parse(snap.observedAt) <= Date.parse(d.lastObservedAt)) return { skipped: "no-new-reading" };
  const win = (w) => (w && w.kind === "used" && typeof w.percent === "number" ? { percent: w.percent, resetsAt: w.resetsAt ?? null } : null);
  const fiveHour = win(snap.fiveHour);
  const weekly = win(snap.weekly);
  if (!fiveHour && !weekly) return { skipped: "no-usable-window" };
  const seq = d.seq + 1;
  const payload = { v: 1, schema: READING_SCHEMA, deviceId: d.deviceId, accountId: d.accountId, source: "claude-agent-sdk-usage", seq, nonce: Buffer.from(rng(12)).toString("hex"), observedAt: snap.observedAt, deviceFp: d.deviceFp, trust: "verified", ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}) };
  saveDevice(deviceDir, { ...d, seq, lastObservedAt: snap.observedAt }); // persisted BEFORE the envelope is released, so a sequence number is never reused
  return { envelope: { payload, signature: sign(d.privateKey, payload) } };
}
