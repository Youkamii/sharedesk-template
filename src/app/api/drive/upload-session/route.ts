import { NextRequest, NextResponse } from "next/server";
import { getAdapter, resolveStorageDriver } from "@/lib/storage";
import { ROOT_ID } from "@/lib/storage/types";
import { errorResponse, requireUploadRights } from "@/lib/api";
import {
  finishUploadReservation,
  reserveUpload,
} from "@/lib/storage-quota";

export async function POST(req: NextRequest) {
  const auth = await requireUploadRights({ fresh: true });
  if ("response" in auth) return auth.response;
  const body = await req.json().catch(() => null);
  if (!body || typeof body.name !== "string") {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }
  const parentId =
    typeof body.parentId === "string" ? body.parentId : ROOT_ID;
  const mimeType =
    typeof body.mimeType === "string" && body.mimeType
      ? body.mimeType
      : "application/octet-stream";
  const size = typeof body.size === "number" ? body.size : 0;
  const origin = req.headers.get("origin") ?? req.nextUrl.origin;
  try {
    const reservationId = await reserveUpload({
      userId: auth.session.userId,
      parentId,
      name: body.name,
      size: body.size,
      transport: resolveStorageDriver() === "drive" ? "direct" : "proxy",
    });
    try {
      const session = await getAdapter().createUploadSession(
        parentId,
        body.name,
        mimeType,
        size,
        origin,
      );
      return NextResponse.json({
        ...session,
        reservationId: reservationId ?? undefined,
      });
    } catch (error) {
      await finishUploadReservation(
        reservationId,
        auth.session.userId,
      ).catch(() => undefined);
      throw error;
    }
  } catch (e) {
    return errorResponse(e);
  }
}
