import { NextRequest, NextResponse } from "next/server";
import {
  type LayoutUpdate,
  getLayoutSnapshot,
  updateLayout,
} from "@/lib/desktop-layout";
import { errorResponse, requireSession, requireUploadRights } from "@/lib/api";
import { ROOT_ID } from "@/lib/storage/types";

function badRequest() {
  return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
}

export async function GET(req: NextRequest) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const folderId = req.nextUrl.searchParams.get("folderId") ?? ROOT_ID;
  try {
    // 길이·형식 검증은 getLayoutSnapshot의 assertId에 위임한다(BAD_ID → 400).
    return NextResponse.json(await getLayoutSnapshot(folderId));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: NextRequest) {
  const auth = await requireUploadRights({ fresh: true });
  if ("response" in auth) return auth.response;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return badRequest();
  }

  // 최소한의 형태만 확인하고, 항목별 검증(id·좌표 범위·개수·중복)은 updateLayout이
  // 무조건 호출하는 assertUpdates에 위임한다 — 라우트에서 이중 검증하면 좌표 상한
  // 같은 규칙이 두 곳으로 갈라진다. assertUpdates의 BAD_ID는 400으로 매핑된다.
  const value = body as Record<string, unknown>;
  if (
    typeof value.folderId !== "string" ||
    typeof value.folderIdentity !== "string" ||
    !Array.isArray(value.updates) ||
    (value.expectedRevision !== undefined &&
      (!Number.isSafeInteger(value.expectedRevision) ||
        (value.expectedRevision as number) < 0))
  ) {
    return badRequest();
  }

  try {
    const t0 = Date.now();
    const result = await updateLayout(
      value.folderId,
      value.updates as LayoutUpdate[],
      auth.session.userId,
      value.folderIdentity,
      value.expectedRevision as number | undefined,
    );
    if (process.env.SHAREDESK_TRACE) {
      console.log(`[layout] updateLayout total ${Date.now() - t0}ms`);
    }
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
