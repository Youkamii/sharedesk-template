import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireUploadRights } from "@/lib/api";
import { createShareLink } from "@/lib/share-links";
import { getAdapter } from "@/lib/storage";
import { ROOT_ID } from "@/lib/storage/types";
import {
  exactSizeUploadStream,
  finishUploadReservation,
  getUploadReservation,
  parseUploadContentLength,
  reserveUpload,
} from "@/lib/storage-quota";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = await requireUploadRights({ fresh: true });
  if ("response" in auth) return auth.response;
  if (!req.body) {
    return NextResponse.json({ error: "본문이 없습니다" }, { status: 400 });
  }
  const name = req.nextUrl.searchParams.get("name") ?? "";
  const requestedReservationId =
    req.nextUrl.searchParams.get("reservationId") ?? "";
  let reservationId: string | null = null;
  let temporaryId: string | null = null;
  try {
    const size = parseUploadContentLength(req.headers.get("content-length"));
    if (requestedReservationId) {
      const reservation = await getUploadReservation(
        requestedReservationId,
        auth.session.userId,
      );
      if (
        !reservation ||
        reservation.parentId !== ROOT_ID ||
        reservation.name !== name ||
        reservation.size !== size
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
        parentId: ROOT_ID,
        name,
        size,
      });
    }
    const entry = await getAdapter().uploadTemporary(
      name,
      req.headers.get("content-type") || "application/octet-stream",
      exactSizeUploadStream(
        req.body as ReadableStream<Uint8Array>,
        size,
      ),
    );
    temporaryId = entry.id;
    await finishUploadReservation(reservationId, auth.session.userId, entry, {
      ignoreEntryName: true,
    });
    const link = await createShareLink(
      entry.id,
      name,
      auth.session.name,
      1,
      {
        createdByUserId: auth.session.userId,
        quick: true,
        deleteOnExpire: true,
      },
    );
    return NextResponse.json({ link }, { status: 201 });
  } catch (error) {
    await finishUploadReservation(
      reservationId,
      auth.session.userId,
    ).catch(() => undefined);
    if (temporaryId) {
      await getAdapter().deleteTemporary(temporaryId).catch(() => undefined);
    }
    return errorResponse(error);
  }
}
