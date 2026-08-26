import { NextRequest, NextResponse } from "next/server";
import {
  errorResponse,
  runWithEditRights,
  runWithUploadRights,
} from "@/lib/api";
import {
  createShareLink,
  cleanupExpiredShareLinks,
  getShareLink,
  listShareLinks,
  parseExpiryHours,
  revokeShareLink,
} from "@/lib/share-links";
import { getAdapter } from "@/lib/storage";
import { ROOT_ID } from "@/lib/storage/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function badRequest() {
  return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
}

// 외부 공유 링크 관리(#11) — 목록·회수는 자기 링크만, 관리자는 전부.
// createdByUserId가 빈 레거시 링크는 어느 유저와도 일치하지 않으므로
// 관리자에게만 보인다(수용된 동작 — 관리자가 정리한다).
export async function GET(req: NextRequest) {
  return runWithUploadRights({ fresh: true }, async ({ session }) => {
    const fileId = req.nextUrl.searchParams.get("fileId") ?? undefined;
    try {
      await cleanupExpiredShareLinks(10);
      const links = await listShareLinks(fileId);
      return NextResponse.json(
        {
          links: session.isAdmin
            ? links
            : links.filter((link) => link.createdByUserId === session.userId),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      return errorResponse(error);
    }
  });
}

export async function POST(req: NextRequest) {
  return runWithEditRights({ fresh: true }, async ({ session }) => {
    const body = (await req.json().catch(() => null)) as {
      id?: unknown;
      expiresInHours?: unknown;
    } | null;
    const expiresInHours = parseExpiryHours(body?.expiresInHours);
    if (
      !body ||
      typeof body.id !== "string" ||
      !body.id ||
      body.id === ROOT_ID ||
      !expiresInHours
    ) {
      return badRequest();
    }
    try {
      const adapter = getAdapter();
      if (await adapter.isRoot(body.id)) return badRequest();
      const entry = await adapter.getEntry(body.id);
      const link = await createShareLink(
        body.id,
        entry.name,
        session.name,
        expiresInHours,
        {
          kind: entry.isFolder ? "folder" : "file",
          createdByUserId: session.userId,
        },
      );
      return NextResponse.json({ link }, { status: 201 });
    } catch (error) {
      return errorResponse(error);
    }
  });
}

export async function DELETE(req: NextRequest) {
  return runWithUploadRights({ fresh: true }, async ({ session }) => {
    const body = (await req.json().catch(() => null)) as {
      linkId?: unknown;
    } | null;
    if (!body || typeof body.linkId !== "string") return badRequest();
    try {
      const link = await getShareLink(body.linkId);
      if (
        !link ||
        (!session.isAdmin && link.createdByUserId !== session.userId)
      ) {
        return NextResponse.json(
          { error: "이 공유 링크를 멈출 권한이 없습니다" },
          { status: 403 },
        );
      }
      const removed = await revokeShareLink(body.linkId);
      return NextResponse.json({ ok: removed });
    } catch (error) {
      return errorResponse(error);
    }
  });
}
