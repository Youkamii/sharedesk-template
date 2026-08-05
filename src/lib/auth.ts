// 세션 토큰 서명/검증 — edge(proxy)와 Node(route) 양쪽에서 돌아야 하므로 Web Crypto만 사용한다.

const enc = new TextEncoder();

export const COOKIE_NAME = "sharedesk_session";
export const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
// 서버 간 시계 오차 허용치. 이보다 미래의 iat는 위조로 본다.
const CLOCK_SKEW_SECONDS = 300;

function toB64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64Url(s: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function getAccessKeys(): string[] {
  return (process.env.ACCESS_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

// SESSION_SECRET이 없으면 등록된 키에서 파생한다 — 키를 아는 사람은 이미 접근 권한이
// 있으므로 개발 환경에선 안전한 폴백이다. 키마저 없으면 파생할 비밀이 없다는 뜻이라
// 예외를 던져 fail-closed로 간다 (상수 비밀로 열리는 것을 막는다).
function secretMaterial(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  const keys = getAccessKeys();
  if (keys.length === 0) {
    throw new Error(
      "ACCESS_KEYS와 SESSION_SECRET이 모두 비어 있습니다 — 인증을 구성할 수 없습니다",
    );
  }
  return "sharedesk-derived:" + keys.join(",");
}

let cached: { material: string; key: Promise<CryptoKey> } | null = null;
function getHmacKey(): Promise<CryptoKey> {
  const material = secretMaterial();
  if (!cached || cached.material !== material) {
    cached = {
      material,
      key: crypto.subtle.importKey(
        "raw",
        enc.encode(material),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      ),
    };
  }
  return cached.key;
}

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

// 어떤 키로 입장했는지를 지문으로 남긴다. 주인이 ACCESS_KEYS에서 키를 빼면
// 그 키로 발급된 세션은 다음 요청에서 즉시 무효가 된다.
function keyFingerprint(keyHash: string): string {
  return keyHash.slice(0, 32);
}

export async function createSessionToken(keyHash: string): Promise<string> {
  const payload = enc.encode(
    JSON.stringify({
      k: keyFingerprint(keyHash),
      iat: Math.floor(Date.now() / 1000),
    }),
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

  let hmacKey: CryptoKey;
  try {
    hmacKey = await getHmacKey();
  } catch {
    return false;
  }
  if (!(await crypto.subtle.verify("HMAC", hmacKey, sig, payload))) {
    return false;
  }

  let claims: { k?: unknown; iat?: unknown };
  try {
    claims = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return false;
  }
  const { k, iat } = claims;
  if (typeof k !== "string" || typeof iat !== "number") return false;

  const now = Date.now() / 1000;
  if (iat > now + CLOCK_SKEW_SECONDS) return false;
  if (iat + MAX_AGE_SECONDS <= now) return false;

  for (const key of getAccessKeys()) {
    if (keyFingerprint(await sha256Hex(key)) === k) return true;
  }
  return false;
}

// 문자열 직접 비교 대신 해시끼리 비교해 타이밍 누출을 막는다.
// 성공 시 그 키의 해시를 돌려준다 (세션 지문 재료).
export async function matchKey(submitted: string): Promise<string | null> {
  const target = await sha256Hex(submitted);
  let matched: string | null = null;
  for (const key of getAccessKeys()) {
    if ((await sha256Hex(key)) === target) matched = target;
  }
  return matched;
}
