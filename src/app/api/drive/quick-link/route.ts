import { NextRequest, NextResponse } from "next/server";
import { errorResponse, runWithUploadRights } from "@/lib/api";
import {
  createShareLink,
  getShareLink,
  keepQuickLinkFile,
  listShareLinks,
  restoreQuickLinkDeletion,
  revokeShareLink,
  updateQuickLinkTarget,
} from "@/lib/share-links";
import { getAdapter } from "@/lib/storage";
import {
  ROOT_ID,
  StorageError,
  TEMPORARY_FILE_PREFIX,
} from "@/lib/storage/types";
import {
  claimUploadReservation,
  finishUploadReservation,
} from "@/lib/storage-quota";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function badRequest() {
  return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
}

// 간이 링크 변경·회수(#11) — 자기 링크만, 관리자는 전부.
function mayChange(
  link: Awaited<ReturnType<typeof getShareLink>>,
  userId: string,
  isAdmin: boolean,
) {
  return !!link && (link.createdByUserId === userId || isAdmin);
}

// Drive 직행 업로드가 끝난 뒤 숨김 파일에 1시간 링크를 붙인다.
export async function POST(req: NextRequest) {
  return runWithUploadRights({ fresh: true }, async ({ session }) => {
    const body = (await req.json().catch(() => null)) as {
      fileId?: unknown;
      name?: unknown;
      reservationId?: unknown;
    } | null;
    if (
      !body ||
      typeof body.fileId !== "string" ||
      typeof body.name !== "string" ||
      (body.reservationId !== undefined &&
        typeof body.reservationId !== "string")
    ) {
      return badRequest();
    }
    let deleteOnFailure = false;
    try {
      const adapter = getAdapter();
      const entry = await adapter.getEntry(body.fileId);
      if (
        entry.isFolder ||
        !entry.name.startsWith(TEMPORARY_FILE_PREFIX) ||
        !(await adapter.isDirectChild(entry.id, ROOT_ID))
      ) {
        return badRequest();
      }
      if (body.reservationId) {
        const reservation = await claimUploadReservation(
          body.reservationId,
          session.userId,
          {
            parentId: ROOT_ID,
            name: body.name,
            size: entry.size ?? -1,
            transport: "direct",
          },
        );
        if (!reservation) {
          throw new StorageError(
            "CONFLICT",
            "업로드 예약 정보가 일치하지 않습니다",
          );
        }
        deleteOnFailure = true;
        const completed = await finishUploadReservation(
          body.reservationId,
          session.userId,
          entry,
          { ignoreEntryName: true },
        );
        if (!completed) {
          throw new StorageError("CONFLICT", "업로드 예약을 찾지 못했습니다");
        }
      } else {
        deleteOnFailure = true;
      }
      const link = await createShareLink(
        entry.id,
        body.name,
        session.name,
        1,
        {
          createdByUserId: session.userId,
          quick: true,
          deleteOnExpire: true,
        },
      );
      deleteOnFailure = false;
      return NextResponse.json({ link }, { status: 201 });
    } catch (error) {
      if (deleteOnFailure) {
        const activeLinks = await listShareLinks(body.fileId).catch(() => []);
        if (activeLinks.length === 0) {
          await getAdapter().deleteTemporary(body.fileId).catch(() => undefined);
        }
      }
      return errorResponse(error);
    }
  });
}

// 자동 삭제 체크를 풀면 숨김 파일을 데스크 루트의 원래 이름으로 올린다.
export async function PATCH(req: NextRequest) {
  return runWithUploadRights({ fresh: true }, async ({ session }) => {
    const body = (await req.json().catch(() => null)) as {
      linkId?: unknown;
    } | null;
    if (!body || typeof body.linkId !== "string") return badRequest();
    const link = await getShareLink(body.linkId);
    if (!mayChange(link, session.userId, session.isAdmin)) {
      return NextResponse.json(
        { error: "이 간이 링크를 바꿀 권한이 없습니다" },
        { status: 403 },
      );
    }
    if (!link?.quick || !link.deleteOnExpire) return badRequest();
    try {
      const claimed = await keepQuickLinkFile(link.linkId);
      if (!claimed) return badRequest();
      try {
        const entry = await getAdapter().promoteTemporary(
          claimed.fileId,
          claimed.name,
        );
        const updated = await updateQuickLinkTarget(claimed.linkId, entry);
        return NextResponse.json({ link: updated, entry });
      } catch (error) {
        await restoreQuickLinkDeletion(link.linkId).catch(() => undefined);
        throw error;
      }
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
    const link = await getShareLink(body.linkId);
    if (!mayChange(link, session.userId, session.isAdmin)) {
      return NextResponse.json(
        { error: "이 간이 링크를 멈출 권한이 없습니다" },
        { status: 403 },
      );
    }
    try {
      return NextResponse.json({ ok: await revokeShareLink(body.linkId) });
    } catch (error) {
      return errorResponse(error);
    }
  });
}
