import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api";
import { createInvitationToken } from "@/lib/invite-token";
import {
  Invitation,
  createInvitation,
  listInvitations,
  rotateInvitation,
  updateInvitation,
} from "@/lib/users";

function publicOrigin(req: NextRequest): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim();
  return configured ? configured.replace(/\/$/, "") : req.nextUrl.origin;
}

function toSummary(req: NextRequest, invitation: Invitation) {
  const { tokenVersion, ...safe } = invitation;
  const link = invitation.usedAt
    ? null
    : `${publicOrigin(req)}/i/${createInvitationToken({
        id: invitation.id,
        tokenVersion,
      })}`;
  return {
    ...safe,
    state: invitation.usedAt
      ? ("used" as const)
      : invitation.active
        ? ("active" as const)
        : ("inactive" as const),
    link,
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;
  const invitations = (await listInvitations()).map((invitation) =>
    toSummary(req, invitation),
  );
  return NextResponse.json({ invitations });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin({ fresh: true });
  if ("response" in auth) return auth.response;
  const body = await req.json().catch(() => null);
  try {
    const invitation = await createInvitation(
      {
        recipientName:
          typeof body?.recipientName === "string" ? body.recipientName : "",
        email: typeof body?.email === "string" ? body.email : "",
        note: typeof body?.note === "string" ? body.note : "",
        active: body?.active !== false,
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
      { invitation: toSummary(req, invitation) },
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
    const invitation =
      action === "rotate"
        ? await rotateInvitation(id)
        : action === "update"
          ? await updateInvitation(id, {
              recipientName:
                typeof body.recipientName === "string"
                  ? body.recipientName
                  : undefined,
              email: typeof body.email === "string" ? body.email : undefined,
              note: typeof body.note === "string" ? body.note : undefined,
              active:
                typeof body.active === "boolean" ? body.active : undefined,
            })
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
      active: invitation.active,
    });
    return NextResponse.json({ invitation: toSummary(req, invitation) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "초대를 바꾸지 못했습니다" },
      { status: 400 },
    );
  }
}
