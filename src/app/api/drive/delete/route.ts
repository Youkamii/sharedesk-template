import { NextRequest, NextResponse } from "next/server";
import { getAdapter } from "@/lib/storage";
import { errorResponse, requireEditRights } from "@/lib/api";

export async function POST(req: NextRequest) {
  const auth = await requireEditRights({ fresh: true });
  if ("response" in auth) return auth.response;
  const body = await req.json().catch(() => null);
  if (!body || typeof body.id !== "string") {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }
  try {
    await getAdapter().remove(body.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
