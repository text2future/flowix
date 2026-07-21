// 密码哈希(scrypt)+ JWT(RS256)+ refresh token 工具。
// scrypt 同步纯 JS;N=2^15 在付费 Workers(CPU 30s)内安全。
// 如需 argon2id,可换 hash-wasm(async wasm),接口保持 async 不破坏调用方。
import { scrypt } from "@noble/hashes/scrypt";
import { sha256 } from "@noble/hashes/sha256";
import { SignJWT, importPKCS8 } from "jose";

const encoder = new TextEncoder();

// ---- 编码工具 ----
function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}
function hex(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, "0");
  return out;
}
function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}
export function base64url(b: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function base64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- 密码哈希 ----
const SCRYPT_N = 1 << 15; // 32768
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_DKLEN = 32;
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = scrypt(utf8(password), salt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    dkLen: SCRYPT_DKLEN,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$N=${SCRYPT_N}$r=${SCRYPT_R}$p=${SCRYPT_P}$${hex(salt)}$${hex(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1].split("=")[1]);
  const r = Number(parts[2].split("=")[1]);
  const p = Number(parts[3].split("=")[1]);
  const salt = fromHex(parts[4]);
  const expected = parts[5];
  const hash = scrypt(utf8(password), salt, {
    N,
    r,
    p,
    dkLen: SCRYPT_DKLEN,
    maxmem: SCRYPT_MAXMEM,
  });
  return constantTimeEqual(hex(hash), expected);
}

// ---- JWT(RS256 access token,15min)----
export async function signAccessToken(
  privateKeyPem: string,
  accountId: string,
  deviceId: string
): Promise<string> {
  const pk = await importPKCS8(privateKeyPem, "RS256");
  return new SignJWT({ account_id: accountId, device_id: deviceId })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(pk);
}

// ---- refresh token(opaque,只存 sha256)----
export function generateRefreshToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
export function hashRefreshToken(token: string): string {
  return hex(sha256(utf8(token)));
}

// ---- 通用 sha256(用于正文 content_hash 校验/去重)----
export function sha256Hex(data: Uint8Array): string {
  return hex(sha256(data));
}
