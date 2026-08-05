import { NextRequest, NextResponse } from "next/server";
import { getAdapter } from "@/lib/storage";
import { errorResponse, requireSession } from "@/lib/api";

export async function POST(req: NextRequest) {
  const denied = await requireSession();
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  if (
    !body ||
    typeof body.id !== "string" ||
    typeof body.name !== "string"
  ) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }
  try {
    const entry = await getAdapter().rename(body.id, body.name);
    return NextResponse.json({ entry });
  } catch (e) {
    return errorResponse(e);
  }
}
