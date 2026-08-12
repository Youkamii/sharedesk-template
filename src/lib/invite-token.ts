import { createHmac, timingSafeEqual } from "node:crypto";
import {
  listInvitations,
  type InvitationCheck,
  type InvitationTokenRef,
} from "@/lib/users";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 24;
const CODE_GROUP_LENGTH = 4;
const MAX_CODE_INPUT_LENGTH = 96;

function codeSignature(ref: InvitationTokenRef): Buffer {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 16) {
    throw new Error(
      "SESSION_SECRET이 없거나 너무 짧습니다 — npm run setup으로 생성하세요",
    );
  }
  return createHmac("sha256", `sharedesk-invite-code:v1:${value}`)
    .update(`${ref.id}:${ref.tokenVersion}`)
    .digest();
}

function compactInvitationCode(ref: InvitationTokenRef): string {
  let value = BigInt(`0x${codeSignature(ref).toString("hex")}`);
  const radix = BigInt(CODE_ALPHABET.length);
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[Number(value % radix)];
    value /= radix;
  }
  return code;
}

export function createInvitationCode(ref: InvitationTokenRef): string {
  return compactInvitationCode(ref)
    .match(new RegExp(`.{1,${CODE_GROUP_LENGTH}}`, "g"))!
    .join("-");
}

export function normalizeInvitationCode(
  input: string | undefined | null,
): string | null {
  if (!input || input.length > MAX_CODE_INPUT_LENGTH) return null;
  const rawCompact = input.replace(/[\s-]/gu, "");
  if (
    ![...rawCompact].every((character) => {
      const upper = character.toUpperCase();
      return upper.length === 1 && CODE_ALPHABET.includes(upper);
    })
  ) {
    return null;
  }
  const compact = rawCompact.toUpperCase();
  if (
    compact.length !== CODE_LENGTH ||
    ![...compact].every((character) => CODE_ALPHABET.includes(character))
  ) {
    return null;
  }
  return compact;
}

export async function findInvitationByCode(
  input: string | undefined | null,
): Promise<InvitationCheck> {
  const supplied = normalizeInvitationCode(input);
  if (!supplied) return { ok: false, reason: "invite_invalid" };

  let match: InvitationTokenRef | null = null;
  let matchedInvitation: Awaited<ReturnType<typeof listInvitations>>[number] | null = null;
  let collision = false;
  try {
    const invitations = await listInvitations({ fresh: true });
    const suppliedBytes = Buffer.from(supplied, "ascii");
    for (const invitation of invitations) {
      const expectedBytes = Buffer.from(
        compactInvitationCode({
          id: invitation.id,
          tokenVersion: invitation.tokenVersion,
        }),
        "ascii",
      );
      if (timingSafeEqual(suppliedBytes, expectedBytes)) {
        if (match) collision = true;
        match = {
          id: invitation.id,
          tokenVersion: invitation.tokenVersion,
        };
        matchedInvitation = invitation;
      }
    }
  } catch {
    return { ok: false, reason: "invite_invalid" };
  }
  if (!match || !matchedInvitation || collision) {
    return { ok: false, reason: "invite_invalid" };
  }
  if (matchedInvitation.usedAt) return { ok: false, reason: "invite_used" };
  if (Date.parse(matchedInvitation.expiresAt) <= Date.now()) {
    return { ok: false, reason: "invite_expired" };
  }
  if (!matchedInvitation.active) return { ok: false, reason: "invite_inactive" };
  return { ok: true, invitation: matchedInvitation };
}
