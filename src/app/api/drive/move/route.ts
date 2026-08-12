import { NextRequest, NextResponse } from "next/server";
import { getAdapter } from "@/lib/storage";
import { errorResponse, requireSession } from "@/lib/api";

export async function POST(req: NextRequest) {
  const auth = await requireSession({ fresh: true });
  if ("response" in auth) return auth.response;
  const body = await req.json().catch(() => null);
  if (
    !body ||
    typeof body.id !== "string" ||
    typeof body.targetFolderId !== "string" ||
    typeof body.expectedVersion !== "string" ||
    !body.expectedVersion
  ) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }
  try {
    const entry = await getAdapter().move(
      body.id,
      body.targetFolderId,
      body.expectedVersion,
    );
    return NextResponse.json({ entry });
  } catch (e) {
    return errorResponse(e);
  }
}
