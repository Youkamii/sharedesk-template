import { NextRequest, NextResponse } from "next/server";
import { recordActivityAfter } from "@/lib/activity";
import { getAdapter } from "@/lib/storage";
import { ROOT_ID } from "@/lib/storage/types";
import { errorResponse, requireUploadRights } from "@/lib/api";

export async function POST(req: NextRequest) {
  const auth = await requireUploadRights({ fresh: true });
  if ("response" in auth) return auth.response;
  const body = await req.json().catch(() => null);
  if (!body || typeof body.name !== "string") {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }
  const parentId =
    typeof body.parentId === "string" ? body.parentId : ROOT_ID;
  try {
    const entry = await getAdapter().createFolder(parentId, body.name);
    recordActivityAfter(auth.session, "mkdir", entry.name);
    return NextResponse.json({ entry }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
