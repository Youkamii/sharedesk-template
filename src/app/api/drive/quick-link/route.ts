import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireUploadRights } from "@/lib/api";
import { canEdit } from "@/lib/roles";
import {
  createShareLink,
  getShareLink,
  keepQuickLinkFile,
  restoreQuickLinkDeletion,
  revokeShareLink,
  updateQuickLinkTarget,
} from "@/lib/share-links";
import { getAdapter } from "@/lib/storage";
import { TEMPORARY_FILE_PREFIX } from "@/lib/storage/types";
import {
  finishUploadReservation,
  getUploadReservation,
} from "@/lib/storage-quota";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function badRequest() {
  return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
}

function mayChange(link: Awaited<ReturnType<typeof getShareLink>>, userId: string, role: Parameters<typeof canEdit>[0]) {
  return !!link && (link.createdByUserId === userId || canEdit(role));
}

// Drive 직행 업로드가 끝난 뒤 숨김 파일에 1시간 링크를 붙인다.
export async function POST(req: NextRequest) {
  const auth = await requireUploadRights({ fresh: true });
  if ("response" in auth) return auth.response;
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
    const entry = await getAdapter().getEntry(body.fileId);
    if (
      entry.isFolder ||
      !entry.name.startsWith(TEMPORARY_FILE_PREFIX)
    ) {
      return badRequest();
    }
    deleteOnFailure = true;
    if (body.reservationId) {
      const reservation = await getUploadReservation(
        body.reservationId,
        auth.session.userId,
      );
      if (
        !reservation ||
        reservation.name !== body.name ||
        (entry.size !== null && reservation.size !== entry.size)
      ) {
        return NextResponse.json(
          { error: "업로드 예약 정보가 일치하지 않습니다" },
          { status: 409 },
        );
      }
      await finishUploadReservation(
        body.reservationId,
        auth.session.userId,
      );
    }
    const link = await createShareLink(
      entry.id,
      body.name,
      auth.session.name,
      1,
      {
        createdByUserId: auth.session.userId,
        quick: true,
        deleteOnExpire: true,
      },
    );
    deleteOnFailure = false;
    return NextResponse.json({ link }, { status: 201 });
  } catch (error) {
    if (deleteOnFailure) {
      await getAdapter().deleteTemporary(body.fileId).catch(() => undefined);
    }
    return errorResponse(error);
  }
}

// 자동 삭제 체크를 풀면 숨김 파일을 데스크 루트의 원래 이름으로 올린다.
export async function PATCH(req: NextRequest) {
  const auth = await requireUploadRights({ fresh: true });
  if ("response" in auth) return auth.response;
  const body = (await req.json().catch(() => null)) as {
    linkId?: unknown;
  } | null;
  if (!body || typeof body.linkId !== "string") return badRequest();
  const link = await getShareLink(body.linkId);
  if (!mayChange(link, auth.session.userId, auth.session.role)) {
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
}

export async function DELETE(req: NextRequest) {
  const auth = await requireUploadRights({ fresh: true });
  if ("response" in auth) return auth.response;
  const body = (await req.json().catch(() => null)) as {
    linkId?: unknown;
  } | null;
  if (!body || typeof body.linkId !== "string") return badRequest();
  const link = await getShareLink(body.linkId);
  if (!mayChange(link, auth.session.userId, auth.session.role)) {
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
}
