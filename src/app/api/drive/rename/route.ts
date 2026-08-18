import { NextRequest, NextResponse } from "next/server";
import { recordActivityAfter } from "@/lib/activity";
import { getAdapter } from "@/lib/storage";
import { errorResponse, requireEditRights } from "@/lib/api";

export async function POST(req: NextRequest) {
  const auth = await requireEditRights({ fresh: true });
  if ("response" in auth) return auth.response;
  const body = await req.json().catch(() => null);
  if (
    !body ||
    typeof body.id !== "string" ||
    typeof body.name !== "string" ||
    typeof body.expectedVersion !== "string"
  ) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }
  try {
    const entry = await getAdapter().rename(
      body.id,
      body.name,
      body.expectedVersion,
    );
    recordActivityAfter(auth.session, "rename", entry.name);
    return NextResponse.json({ entry });
  } catch (e) {
    return errorResponse(e);
  }
}
