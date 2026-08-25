import { NextRequest, NextResponse } from "next/server";
import { getAdapter, resolveStorageDriver } from "@/lib/storage";
import { ROOT_ID } from "@/lib/storage/types";
import { errorResponse, runWithUploadRights } from "@/lib/api";
import {
  finishUploadReservation,
  reserveUpload,
} from "@/lib/storage-quota";

export async function POST(req: NextRequest) {
  return runWithUploadRights({ fresh: true }, async ({ session }) => {
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
        userId: session.userId,
        parentId,
        name: body.name,
        size: body.size,
        transport: resolveStorageDriver() === "drive" ? "direct" : "proxy",
      });
      try {
        const uploadSession = await getAdapter().createUploadSession(
          parentId,
          body.name,
          mimeType,
          size,
          origin,
        );
        return NextResponse.json({
          ...uploadSession,
          reservationId: reservationId ?? undefined,
        });
      } catch (error) {
        await finishUploadReservation(
          reservationId,
          session.userId,
        ).catch(() => undefined);
        throw error;
      }
    } catch (e) {
      return errorResponse(e);
    }
  });
}
