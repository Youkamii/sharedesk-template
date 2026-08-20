import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireUploadRights } from "@/lib/api";
import { getAdapter, resolveStorageDriver } from "@/lib/storage";
import { ROOT_ID } from "@/lib/storage/types";
import {
  finishUploadReservation,
  reserveUpload,
} from "@/lib/storage-quota";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = await requireUploadRights({ fresh: true });
  if ("response" in auth) return auth.response;
  const body = (await req.json().catch(() => null)) as {
    name?: unknown;
    mimeType?: unknown;
    size?: unknown;
  } | null;
  if (!body || typeof body.name !== "string") {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }
  const mimeType =
    typeof body.mimeType === "string" && body.mimeType
      ? body.mimeType
      : "application/octet-stream";
  try {
    const reservationId = await reserveUpload({
      userId: auth.session.userId,
      parentId: ROOT_ID,
      name: body.name,
      size: body.size,
      transport: resolveStorageDriver() === "drive" ? "direct" : "proxy",
    });
    try {
      const session = await getAdapter().createTemporaryUploadSession(
        body.name,
        mimeType,
        body.size as number,
        req.headers.get("origin") ?? req.nextUrl.origin,
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
  } catch (error) {
    return errorResponse(error);
  }
}
