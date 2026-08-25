import { NextRequest, NextResponse } from "next/server";
import { errorResponse, runWithUploadRights } from "@/lib/api";
import { createShareLink } from "@/lib/share-links";
import { getAdapter } from "@/lib/storage";
import { ROOT_ID, StorageError } from "@/lib/storage/types";
import {
  claimUploadReservation,
  exactSizeUploadStream,
  finishUploadReservation,
  parseUploadContentLength,
  reserveUpload,
} from "@/lib/storage-quota";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  return runWithUploadRights({ fresh: true }, async ({ session }) => {
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
        const reservation = await claimUploadReservation(
          requestedReservationId,
          session.userId,
          {
            parentId: ROOT_ID,
            name,
            size,
            transport: "proxy",
          },
        );
        if (!reservation) {
          return NextResponse.json(
            { error: "업로드 예약 정보가 일치하지 않습니다" },
            { status: 409 },
          );
        }
        reservationId = reservation.id;
      } else {
        reservationId = await reserveUpload({
          userId: session.userId,
          parentId: ROOT_ID,
          name,
          size,
          transport: "proxy",
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
      const completed = await finishUploadReservation(
        reservationId,
        session.userId,
        entry,
        { ignoreEntryName: true },
      );
      if (!completed) {
        throw new StorageError("CONFLICT", "업로드 완료 예약을 찾지 못했습니다");
      }
      const link = await createShareLink(
        entry.id,
        name,
        session.name,
        1,
        {
          createdByUserId: session.userId,
          quick: true,
          deleteOnExpire: true,
        },
      );
      return NextResponse.json({ link }, { status: 201 });
    } catch (error) {
      await finishUploadReservation(
        reservationId,
        session.userId,
      ).catch(() => undefined);
      if (temporaryId) {
        await getAdapter().deleteTemporary(temporaryId).catch(() => undefined);
      }
      return errorResponse(error);
    }
  });
}
