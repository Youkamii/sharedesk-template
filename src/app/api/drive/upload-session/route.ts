import { NextRequest, NextResponse } from "next/server";
import { getAdapter } from "@/lib/storage";
import { ROOT_ID } from "@/lib/storage/types";
import { errorResponse, requireSession } from "@/lib/api";

export async function POST(req: NextRequest) {
  const denied = await requireSession();
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  if (!body || typeof body.name !== "string") {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }
  const parentId =
    typeof body.parentId === "string" ? body.parentId : ROOT_ID;
  const mimeType =
    typeof body.mimeType === "string" && body.mimeType
      ? body.mimeType
      : "application/octet-stream";
  const size = typeof body.size === "number" ? body.size : 0;
  const origin = req.headers.get("origin") ?? req.nextUrl.origin;
  try {
    const session = await getAdapter().createUploadSession(
      parentId,
      body.name,
      mimeType,
      size,
      origin,
    );
    return NextResponse.json(session);
  } catch (e) {
    return errorResponse(e);
  }
}
