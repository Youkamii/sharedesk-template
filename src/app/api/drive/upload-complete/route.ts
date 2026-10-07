import { NextRequest, NextResponse } from "next/server";
import { errorResponse, runWithUploadRights } from "@/lib/api";
import { changedSince, recordEntryUploadAfter } from "@/lib/entry-audit";
import { getAdapter } from "@/lib/storage";
import {
  claimUploadReservation,
  finishUploadReservation,
  getUploadReservation,
} from "@/lib/storage-quota";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  return runWithUploadRights({ fresh: true }, async ({ session }) => {
    const body = (await req.json().catch(() => null)) as {
      reservationId?: unknown;
      fileId?: unknown;
    } | null;
    if (
      !body ||
      typeof body.reservationId !== "string" ||
      typeof body.fileId !== "string"
    ) {
      return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
    }
    try {
      const reservation = await getUploadReservation(
        body.reservationId,
        session.userId,
      );
      if (!reservation || reservation.transport !== "direct") {
        return NextResponse.json(
          { error: "업로드 예약을 찾지 못했습니다" },
          { status: 409 },
        );
      }
      const adapter = getAdapter();
      const entry = await adapter.getEntry(body.fileId);
      if (entry.isFolder || entry.size === null) {
        return NextResponse.json(
          { error: "업로드된 파일 정보가 일치하지 않습니다" },
          { status: 409 },
        );
      }
      if (!(await adapter.isDirectChild(entry.id, reservation.parentId))) {
        return NextResponse.json(
          { error: "업로드된 파일 위치가 일치하지 않습니다" },
          { status: 409 },
        );
      }
      const claimed = await claimUploadReservation(
        body.reservationId,
        session.userId,
        {
          parentId: reservation.parentId,
          name: reservation.name,
          size: reservation.size,
          transport: "direct",
        },
      );
      if (!claimed) {
        return NextResponse.json(
          { error: "업로드 예약을 찾지 못했습니다" },
          { status: 409 },
        );
      }
      const completed = await finishUploadReservation(
        body.reservationId,
        session.userId,
        entry,
      );
      if (!completed) {
        return NextResponse.json(
          { error: "업로드 예약을 찾지 못했습니다" },
          { status: 409 },
        );
      }
      // 직행 업로드(drive)도 항목별 내력에 남긴다(proxy 업로드 라우트와 같은
      // 기록 — 속성 창 #14·최근 파일 #16 C-1). 단 fileId는 클라이언트가 보낸
      // 값이라 같은 폴더의 기존 파일을 가리킬 수 있다: 파일이 이 예약 뒤에
      // 생기거나 바뀐 게 아니면, 올린 사람 기록이 없을 때만 남긴다.
      recordEntryUploadAfter(entry, session, {
        onlyIfUnrecorded: !changedSince(entry.modifiedAt, reservation.createdAt),
      });
      return NextResponse.json({ ok: true });
    } catch (error) {
      return errorResponse(error);
    }
  });
}
