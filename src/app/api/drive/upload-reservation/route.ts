import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireUploadRights } from "@/lib/api";
import { renewUploadReservation } from "@/lib/storage-quota";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = await requireUploadRights({ fresh: true });
  if ("response" in auth) return auth.response;
  const body = (await req.json().catch(() => null)) as {
    reservationId?: unknown;
  } | null;
  if (!body || typeof body.reservationId !== "string") {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }
  try {
    const renewed = await renewUploadReservation(
      body.reservationId,
      auth.session.userId,
    );
    return renewed
      ? NextResponse.json({ ok: true })
      : NextResponse.json(
          { error: "업로드 예약을 찾지 못했습니다" },
          { status: 409 },
        );
  } catch (error) {
    return errorResponse(error);
  }
}
