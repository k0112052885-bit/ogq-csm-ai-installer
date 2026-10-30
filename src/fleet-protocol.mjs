// The part of the enrollment protocol that BOTH sides share and that contains no admin logic and no key material: the request format, the body that is signed/MACed,
// and an atomic private-file writer. The employee package ships this module; the registry (src/fleet-registry.mjs, admin only) builds on it.
import fs from "node:fs";
import path from "node:path";

export const ENROLL_SCHEMA = "csm-fleet-enroll/v1";

/** The body an enrolling device signs and MACs (the MAC key is the one-time invite code, so the code itself never travels). */
export const enrollBody = (r) => ({ inviteId: r.inviteId, deviceId: r.deviceId, publicKey: r.publicKey, deviceFp: r.deviceFp });

// Self-service join (no invite): the device proves it holds the key it presents; it carries NO secret and grants nothing. The server assigns the device id, the administrator assigns
// the account at approval, and the verification code (sas) is compared by a human, so a join request is only ever a PENDING entry.
export const JOIN_SCHEMA = "csm-fleet-join/v1";
export const joinBody = (r) => ({ label: r.label, publicKey: r.publicKey, deviceFp: r.deviceFp, nonce: r.nonce });

export function writePrivate(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}
