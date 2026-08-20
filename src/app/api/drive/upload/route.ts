import { NextRequest, NextResponse } from "next/server";
import { recordActivityAfter } from "@/lib/activity";
import { getAdapter } from "@/lib/storage";
import { ROOT_ID } from "@/lib/storage/types";
import { errorResponse, requireUploadRights } from "@/lib/api";
import {
  exactSizeUploadStream,
  finishUploadReservation,
  getUploadReservation,
  parseUploadContentLength,
  reserveUpload,
} from "@/lib/storage-quota";

export async function POST(req: NextRequest) {
  const auth = await requireUploadRights({ fresh: true });
  if ("response" in auth) return auth.response;
  const parentId = req.nextUrl.searchParams.get("parentId") ?? ROOT_ID;
  const name = req.nextUrl.searchParams.get("name") ?? "";
  const mimeType =
    req.headers.get("content-type") || "application/octet-stream";
  if (!req.body) {
    return NextResponse.json({ error: "본문이 없습니다" }, { status: 400 });
  }
  const requestedReservationId =
    req.nextUrl.searchParams.get("reservationId") ?? "";
  let reservationId: string | null = null;
  try {
    const declaredSize = parseUploadContentLength(
      req.headers.get("content-length"),
    );
    if (requestedReservationId) {
      const reservation = await getUploadReservation(
        requestedReservationId,
        auth.session.userId,
      );
      if (
        !reservation ||
        reservation.parentId !== parentId ||
        reservation.name !== name ||
        reservation.size !== declaredSize
      ) {
        return NextResponse.json(
          { error: "업로드 예약 정보가 일치하지 않습니다" },
          { status: 409 },
        );
      }
      reservationId = reservation.id;
    } else {
      reservationId = await reserveUpload({
        userId: auth.session.userId,
        parentId,
        name,
        size: declaredSize,
      });
    }
    const entry = await getAdapter().upload(
      parentId,
      name,
      mimeType,
      exactSizeUploadStream(
        req.body as ReadableStream<Uint8Array>,
        declaredSize,
      ),
    );
    await finishUploadReservation(reservationId, auth.session.userId, entry);
    recordActivityAfter(auth.session, "upload", entry.name);
    return NextResponse.json({ entry }, { status: 201 });
  } catch (e) {
    await finishUploadReservation(
      reservationId,
      auth.session.userId,
    ).catch(() => undefined);
    return errorResponse(e);
  }
}
