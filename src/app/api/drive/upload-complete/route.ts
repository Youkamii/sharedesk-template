import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireUploadRights } from "@/lib/api";
import { getAdapter } from "@/lib/storage";
import { finishUploadReservation } from "@/lib/storage-quota";

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
    const entry = await getAdapter().getEntry(body.fileId);
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
