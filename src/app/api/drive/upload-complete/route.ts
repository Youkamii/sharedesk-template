import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireUploadRights } from "@/lib/api";
import { getAdapter } from "@/lib/storage";
import {
  claimUploadReservation,
  finishUploadReservation,
  getUploadReservation,
} from "@/lib/storage-quota";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = await requireUploadRights({ fresh: true });
  if ("response" in auth) return auth.response;
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
      auth.session.userId,
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
      auth.session.userId,
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
      auth.session.userId,
      entry,
    );
    if (!completed) {
      return NextResponse.json(
        { error: "업로드 예약을 찾지 못했습니다" },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
