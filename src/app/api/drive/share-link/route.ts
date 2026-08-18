import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireEditRights } from "@/lib/api";
import {
  createShareLink,
  listShareLinks,
  parseExpiryHours,
  revokeShareLink,
} from "@/lib/share-links";
import { getAdapter } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function badRequest() {
  return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
}

// 외부 공유 링크 관리 — 관리자·수정 가능 역할만 만들고 거둘 수 있다.
export async function GET(req: NextRequest) {
  const auth = await requireEditRights({ fresh: true });
  if ("response" in auth) return auth.response;
  const fileId = req.nextUrl.searchParams.get("fileId") ?? undefined;
  try {
    return NextResponse.json(
      { links: await listShareLinks(fileId) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireEditRights({ fresh: true });
  if ("response" in auth) return auth.response;
  const body = (await req.json().catch(() => null)) as {
    id?: unknown;
    expiresInHours?: unknown;
  } | null;
  const expiresInHours = parseExpiryHours(body?.expiresInHours);
  if (!body || typeof body.id !== "string" || !body.id || !expiresInHours) {
    return badRequest();
  }
  try {
    // 폴더는 링크로 내보낼 수 없다 — 파일 하나만 통과시킨다.
    const entry = await getAdapter().getEntry(body.id);
    if (entry.isFolder) return badRequest();
    const link = await createShareLink(
      body.id,
      entry.name,
      auth.session.name,
      expiresInHours,
    );
    return NextResponse.json({ link }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireEditRights({ fresh: true });
  if ("response" in auth) return auth.response;
  const body = (await req.json().catch(() => null)) as {
    linkId?: unknown;
  } | null;
  if (!body || typeof body.linkId !== "string") return badRequest();
  try {
    const removed = await revokeShareLink(body.linkId);
    return NextResponse.json({ ok: removed });
  } catch (error) {
    return errorResponse(error);
  }
}
