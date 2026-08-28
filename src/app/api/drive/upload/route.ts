import { NextRequest, NextResponse } from "next/server";
import { recordActivityAfter } from "@/lib/activity";
import { recordEntryUploadAfter } from "@/lib/entry-audit";
import { getAdapter } from "@/lib/storage";
import { ROOT_ID, StorageError } from "@/lib/storage/types";
import { errorResponse, runWithUploadRights } from "@/lib/api";
import {
  claimUploadReservation,
  exactSizeUploadStream,
  finishUploadReservation,
  parseUploadContentLength,
  reserveUpload,
} from "@/lib/storage-quota";

export async function POST(req: NextRequest) {
  return runWithUploadRights({ fresh: true }, async ({ session }) => {
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
        const reservation = await claimUploadReservation(
          requestedReservationId,
          session.userId,
          {
            parentId,
            name,
            size: declaredSize,
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
          parentId,
          name,
          size: declaredSize,
          transport: "proxy",
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
      const completed = await finishUploadReservation(
        reservationId,
        session.userId,
        entry,
      );
      if (!completed) {
        throw new StorageError("CONFLICT", "업로드 완료 예약을 찾지 못했습니다");
      }
      recordActivityAfter(session, "upload", entry.name);
      // 속성 창(#14)이 "누가 올렸는지"를 보여주려면 항목별로도 남겨야 한다 —
      // activity.json은 최근 200건이라 오래된 파일은 밀려난다.
      recordEntryUploadAfter(entry.layoutKey, session.name);
      return NextResponse.json({ entry }, { status: 201 });
    } catch (e) {
      await finishUploadReservation(
        reservationId,
        session.userId,
      ).catch(() => undefined);
      return errorResponse(e);
    }
  });
}
