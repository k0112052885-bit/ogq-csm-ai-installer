// Small crypto helpers for the multi-device aggregator (Node built-ins only): canonical JSON, Ed25519 signatures, HMAC proofs, short authentication strings.
// Nothing here touches the network or a service. Keys are base64 DER (spki public / pkcs8 private).
import crypto from "node:crypto";

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
/** Deterministic JSON (sorted keys): the exact bytes that are signed / MACed. */
export const canonical = (v) => JSON.stringify(sortKeys(v));

export function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"), privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64") };
}

export function sign(privateKeyB64, payload) {
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
  return crypto.sign(null, Buffer.from(canonical(payload)), key).toString("base64");
}

export function verify(publicKeyB64, payload, signatureB64) {
  try {
    if (typeof publicKeyB64 !== "string" || typeof signatureB64 !== "string") return false;
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(canonical(payload)), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

/** Random identifiers. `rng(n)` returns n random bytes; tests inject a counter-based one for deterministic output. */
export const randomId = (prefix, rng = crypto.randomBytes, bytes = 8) => `${prefix}_${Buffer.from(rng(bytes)).toString("hex")}`;
export const randomCode = (rng = crypto.randomBytes) => Buffer.from(rng(24)).toString("base64url");

export const hmacHex = (secret, payload) => crypto.createHmac("sha256", String(secret)).update(canonical(payload)).digest("hex");
export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export const keyId = (publicKeyB64) => crypto.createHash("sha256").update(String(publicKeyB64)).digest("hex").slice(0, 16);

/** Short authentication string both sides can read aloud / compare: binds device id, public key and the device-local login tag. */
export const sas = ({ deviceId, publicKey, deviceFp }) => crypto.createHash("sha256").update(canonical({ deviceId, publicKey, deviceFp })).digest("hex").slice(0, 8).toUpperCase();
