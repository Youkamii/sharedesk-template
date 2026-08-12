import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireAdmin } from "@/lib/api";
import {
  createDrivePermission,
  deleteDrivePermission,
  getDriveSharing,
  parseShareRole,
  updateDrivePermission,
} from "@/lib/drive-shares";

function badRequest() {
  return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!id) return badRequest();
  try {
    return NextResponse.json(
      await getDriveSharing(id, auth.session.userId),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin({ fresh: true });
  if ("response" in auth) return auth.response;
  const body = await req.json().catch(() => null);
  if (
    typeof body?.id !== "string" ||
    typeof body?.targetUserId !== "string" ||
    (body.sendNotificationEmail !== undefined &&
      typeof body.sendNotificationEmail !== "boolean")
  ) {
    return badRequest();
  }
  try {
    const permission = await createDrivePermission({
      fileId: body.id,
      targetUserId: body.targetUserId,
      role: parseShareRole(body.role),
      sendNotificationEmail: body.sendNotificationEmail ?? false,
      createdByUserId: auth.session.userId,
    });
    console.info("[share]", {
      event: "created",
      fileId: body.id,
      permissionId: permission.permissionId,
      targetUserId: permission.targetUserId,
      actorUserId: auth.session.userId,
    });
    return NextResponse.json({ permission }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin({ fresh: true });
  if ("response" in auth) return auth.response;
  const body = await req.json().catch(() => null);
  if (
    typeof body?.id !== "string" ||
    typeof body?.permissionId !== "string"
  ) {
    return badRequest();
  }
  try {
    const permission = await updateDrivePermission({
      fileId: body.id,
      permissionId: body.permissionId,
      role: parseShareRole(body.role),
    });
    console.info("[share]", {
      event: "updated",
      fileId: body.id,
      permissionId: permission.permissionId,
      actorUserId: auth.session.userId,
    });
    return NextResponse.json({ permission });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin({ fresh: true });
  if ("response" in auth) return auth.response;
  const body = await req.json().catch(() => null);
  if (
    typeof body?.id !== "string" ||
    typeof body?.permissionId !== "string"
  ) {
    return badRequest();
  }
  try {
    await deleteDrivePermission({
      fileId: body.id,
      permissionId: body.permissionId,
    });
    console.info("[share]", {
      event: "deleted",
      fileId: body.id,
      permissionId: body.permissionId,
      actorUserId: auth.session.userId,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
