import { createHmac, timingSafeEqual } from "node:crypto";
import type { InvitationTokenRef } from "@/lib/users";

export const INVITE_COOKIE = "sharedesk_invite";
export const INVITE_COOKIE_MAX_AGE = 60 * 60;

const MAX_TOKEN_LENGTH = 512;
const ID_PATTERN = /^[0-9a-f-]{36}$/i;

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 16) {
    throw new Error(
      "SESSION_SECRET이 없거나 너무 짧습니다 — npm run setup으로 생성하세요",
    );
  }
  return `sharedesk-invite:${value}`;
}

function signature(body: string): Buffer {
  return createHmac("sha256", secret()).update(body).digest();
}

export function createInvitationToken(ref: InvitationTokenRef): string {
  const body = Buffer.from(
    JSON.stringify({ v: 1, id: ref.id, n: ref.tokenVersion }),
    "utf8",
  ).toString("base64url");
  return `${body}.${signature(body).toString("base64url")}`;
}

export function openInvitationToken(
  token: string | undefined | null,
): InvitationTokenRef | null {
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || token.indexOf(".", dot + 1) !== -1) return null;
  const body = token.slice(0, dot);
  let supplied: Buffer;
  try {
    supplied = Buffer.from(token.slice(dot + 1), "base64url");
  } catch {
    return null;
  }
  let expected: Buffer;
  try {
    expected = signature(body);
  } catch {
    return null;
  }
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    return null;
  }
  try {
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      v?: unknown;
      id?: unknown;
      n?: unknown;
    };
    if (
      value.v !== 1 ||
      typeof value.id !== "string" ||
      !ID_PATTERN.test(value.id) ||
      !Number.isSafeInteger(value.n) ||
      (value.n as number) < 1
    ) {
      return null;
    }
    return { id: value.id, tokenVersion: value.n as number };
  } catch {
    return null;
  }
}
