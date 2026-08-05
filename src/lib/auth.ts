// 세션 토큰 서명/검증 — edge(middleware)와 Node(route) 양쪽에서 돌아야 하므로 Web Crypto만 사용한다.

const enc = new TextEncoder();

export const COOKIE_NAME = "sharedesk_session";
export const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function toB64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64Url(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// SESSION_SECRET이 없으면 접속 키에서 파생한다 — 키를 아는 사람은 이미 접근 권한이 있으므로
// 개발 환경에선 안전한 폴백이다. 운영은 setup 스크립트가 실제 비밀을 생성한다.
function secretMaterial(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  return "sharedesk-derived:" + (process.env.ACCESS_KEYS ?? "no-keys");
}

let keyPromise: Promise<CryptoKey> | null = null;
function getHmacKey(): Promise<CryptoKey> {
  keyPromise ??= crypto.subtle.importKey(
    "raw",
    enc.encode(secretMaterial()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return keyPromise;
}

export async function createSessionToken(keyIndex: number): Promise<string> {
  const payload = enc.encode(
    JSON.stringify({ i: keyIndex, iat: Math.floor(Date.now() / 1000) }),
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", await getHmacKey(), payload),
  );
  return `${toB64Url(payload)}.${toB64Url(sig)}`;
}

export async function verifySessionToken(
  token: string | undefined | null,
): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const payload = fromB64Url(token.slice(0, dot));
  const sig = fromB64Url(token.slice(dot + 1));
  if (!payload || !sig) return false;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await getHmacKey(),
    sig,
    payload,
  );
  if (!valid) return false;
  try {
    const { iat } = JSON.parse(new TextDecoder().decode(payload));
    return typeof iat === "number" && iat + MAX_AGE_SECONDS > Date.now() / 1000;
  } catch {
    return false;
  }
}

export function getAccessKeys(): string[] {
  return (process.env.ACCESS_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

// 문자열 직접 비교 대신 해시끼리 비교해 타이밍 누출을 막는다.
export async function findKeyIndex(submitted: string): Promise<number> {
  const target = await sha256Hex(submitted);
  const keys = getAccessKeys();
  let found = -1;
  for (let i = 0; i < keys.length; i++) {
    if ((await sha256Hex(keys[i])) === target) found = i;
  }
  return found;
}
