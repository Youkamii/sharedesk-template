import { NextRequest, NextResponse } from "next/server";
import { getAdapter } from "@/lib/storage";
import { ROOT_ID } from "@/lib/storage/types";
import { errorResponse, requireSession } from "@/lib/api";

export async function POST(req: NextRequest) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const parentId = req.nextUrl.searchParams.get("parentId") ?? ROOT_ID;
  const name = req.nextUrl.searchParams.get("name") ?? "";
  const mimeType =
    req.headers.get("content-type") || "application/octet-stream";
  if (!req.body) {
    return NextResponse.json({ error: "본문이 없습니다" }, { status: 400 });
  }
  try {
    const entry = await getAdapter().upload(
      parentId,
      name,
      mimeType,
      req.body as ReadableStream<Uint8Array>,
    );
    return NextResponse.json({ entry }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
