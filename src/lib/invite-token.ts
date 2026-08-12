import { createHmac, timingSafeEqual } from "node:crypto";
import type { InvitationTokenRef } from "@/lib/users";

const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_VERSION = 1;
const CODE_BYTES = 40;
const CODE_LENGTH = 64;
const CODE_GROUP_LENGTH = 4;
const MAX_CODE_INPUT_LENGTH = 192;
const PAYLOAD_BYTES = 24;
const SIGNATURE_BYTES = CODE_BYTES - PAYLOAD_BYTES;
const UUID_PATTERN =
  /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i;

function secretMaterial(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 16) {
    throw new Error(
      "SESSION_SECRET이 없거나 너무 짧습니다 — npm run setup으로 생성하세요",
    );
  }
  return value;
}

function uuidToBytes(id: string): Buffer {
  const match = UUID_PATTERN.exec(id);
  if (!match) throw new Error("초대 ID 형식이 올바르지 않습니다");
  return Buffer.from(match.slice(1).join(""), "hex");
}

function bytesToUuid(bytes: Uint8Array): string {
  const value = Buffer.from(bytes).toString("hex");
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20),
  ].join("-");
}

function createPayload(ref: InvitationTokenRef): Buffer {
  if (!Number.isSafeInteger(ref.tokenVersion) || ref.tokenVersion < 1) {
    throw new Error("초대 코드 버전이 올바르지 않습니다");
  }
  const payload = Buffer.alloc(PAYLOAD_BYTES);
  payload[0] = CODE_VERSION;
  uuidToBytes(ref.id).copy(payload, 1);
  let version = ref.tokenVersion;
  for (let index = PAYLOAD_BYTES - 1; index >= 17; index -= 1) {
    payload[index] = version % 256;
    version = Math.floor(version / 256);
  }
  if (version !== 0) throw new Error("초대 코드 버전이 너무 큽니다");
  return payload;
}

function signPayload(payload: Uint8Array): Buffer {
  return createHmac("sha256", secretMaterial())
    .update("sharedesk-invite-code:v2\0", "ascii")
    .update(payload)
    .digest()
    .subarray(0, SIGNATURE_BYTES);
}

function encodeBase32(bytes: Uint8Array): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += CODE_ALPHABET[(buffer >>> bits) & 31];
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits > 0) output += CODE_ALPHABET[(buffer << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value: string): Buffer | null {
  const output = Buffer.alloc(CODE_BYTES);
  let offset = 0;
  let buffer = 0;
  let bits = 0;
  for (const character of value) {
    const digit = CODE_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    buffer = (buffer << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      if (offset >= output.length) return null;
      output[offset] = (buffer >>> bits) & 0xff;
      offset += 1;
      buffer &= (1 << bits) - 1;
    }
  }
  return offset === CODE_BYTES && bits === 0 ? output : null;
}

export function createInvitationCode(ref: InvitationTokenRef): string {
  const payload = createPayload(ref);
  const compact = encodeBase32(Buffer.concat([payload, signPayload(payload)]));
  return compact
    .match(new RegExp(`.{1,${CODE_GROUP_LENGTH}}`, "g"))!
    .join("-");
}

export function normalizeInvitationCode(
  input: string | undefined | null,
): string | null {
  if (!input || input.length > MAX_CODE_INPUT_LENGTH) return null;
  const rawCompact = input.replace(/[\s-]/gu, "");
  const compact = rawCompact.toUpperCase();
  if (compact.length !== CODE_LENGTH) return null;
  if (
    [...rawCompact].some((character) => {
      const upper = character.toUpperCase();
      return upper.length !== 1 || !CODE_ALPHABET.includes(upper);
    })
  ) {
    return null;
  }
  return compact;
}

// 코드의 서명과 구조만 확인한다. 활성·만료·사용 횟수는 저장 시점의
// redeemInvitationForUser CAS가 최종 판정한다.
export function parseInvitationCode(
  input: string | undefined | null,
): InvitationTokenRef | null {
  const compact = normalizeInvitationCode(input);
  if (!compact) return null;
  const decoded = decodeBase32(compact);
  if (!decoded) return null;
  const payload = decoded.subarray(0, PAYLOAD_BYTES);
  const suppliedSignature = decoded.subarray(PAYLOAD_BYTES);
  let expectedSignature: Buffer;
  try {
    expectedSignature = signPayload(payload);
  } catch {
    return null;
  }
  if (!timingSafeEqual(suppliedSignature, expectedSignature)) return null;
  if (payload[0] !== CODE_VERSION) return null;

  let tokenVersion = 0;
  for (const byte of payload.subarray(17)) {
    tokenVersion = tokenVersion * 256 + byte;
  }
  if (!Number.isSafeInteger(tokenVersion) || tokenVersion < 1) {
    return null;
  }
  return {
    id: bytesToUuid(payload.subarray(1, 17)),
    tokenVersion,
  };
}
