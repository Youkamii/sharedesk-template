import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api";
import { createInvitationCode } from "@/lib/invite-token";
import {
  Invitation,
  createInvitation,
  isInvitationExpired,
  listInvitations,
  rotateInvitation,
  setInvitationActive,
} from "@/lib/users";

const ALLOWED_INVITATION_DURATIONS = new Set([60, 1_440, 10_080, 43_200]);

function toSummary(invitation: Invitation) {
  const { tokenVersion } = invitation;
  const used = invitation.usageMode === "once" && invitation.usageCount > 0;
  const expired = !used && isInvitationExpired(invitation);
  const code =
    used || expired || !invitation.active
      ? null
      : createInvitationCode({ id: invitation.id, tokenVersion });
  return {
    id: invitation.id,
    createdAt: invitation.createdAt,
    createdByEmail: invitation.createdByEmail,
    expiresAt: invitation.expiresAt,
    durationMinutes: invitation.durationMinutes,
    usageMode: invitation.usageMode,
    usageCount: invitation.usageCount,
    lastUsedAt: invitation.lastUsedAt,
    lastUsedByEmail: invitation.lastUsedByEmail,
    state: used
      ? ("used" as const)
      : expired
        ? ("expired" as const)
        : invitation.active
          ? ("active" as const)
          : ("inactive" as const),
    code,
  };
}

export async function GET() {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;
  const invitations = (await listInvitations()).map(toSummary);
  return NextResponse.json({ invitations });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin({ fresh: true });
  if ("response" in auth) return auth.response;
  const body = await req.json().catch(() => null);
  if (
    typeof body?.expiresInMinutes !== "number" ||
    !ALLOWED_INVITATION_DURATIONS.has(body.expiresInMinutes)
  ) {
    return NextResponse.json(
      { error: "초대 기간을 확인해 주세요" },
      { status: 400 },
    );
  }
  if (body?.usageMode !== "once" && body?.usageMode !== "unlimited") {
    return NextResponse.json(
      { error: "초대 코드 사용 방식을 확인해 주세요" },
      { status: 400 },
    );
  }
  try {
    const invitation = await createInvitation(
      {
        expiresInMinutes: body.expiresInMinutes,
        usageMode: body.usageMode,
      },
      {
        userId: auth.session.userId,
        email: auth.session.email,
      },
    );
    console.info("[invite]", {
      event: "created",
      invitationId: invitation.id,
      actorUserId: auth.session.userId,
    });
    return NextResponse.json(
      { invitation: toSummary(invitation) },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "초대를 만들지 못했습니다" },
      { status: 400 },
    );
  }
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin({ fresh: true });
  if ("response" in auth) return auth.response;
  const body = await req.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id : "";
  const action = typeof body?.action === "string" ? body.action : "";
  if (!id || !action) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }
  try {
    if (action === "update" && typeof body.active !== "boolean") {
      return NextResponse.json(
        { error: "활성 상태를 확인해 주세요" },
        { status: 400 },
      );
    }
    const invitation =
      action === "rotate"
        ? await rotateInvitation(id)
        : action === "update"
          ? await setInvitationActive(id, body.active)
          : null;
    if (!invitation) {
      return NextResponse.json(
        { error: action === "update" || action === "rotate" ? "없는 초대입니다" : "알 수 없는 동작입니다" },
        { status: action === "update" || action === "rotate" ? 404 : 400 },
      );
    }
    console.info("[invite]", {
      event: action === "rotate" ? "rotated" : "updated",
      invitationId: invitation.id,
      actorUserId: auth.session.userId,
      state: toSummary(invitation).state,
    });
    return NextResponse.json({ invitation: toSummary(invitation) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "초대를 바꾸지 못했습니다" },
      { status: 400 },
    );
  }
}
