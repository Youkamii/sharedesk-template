import { NextRequest, NextResponse } from "next/server";
import { errorResponse, runWithAdmin } from "@/lib/api";
import {
  parsePublicFolderName,
  removePublicFolder,
  updatePublicFolder,
  type PublicFolderPatch,
} from "@/lib/public-folders";
import { parseSettingsPatch } from "../route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function missing() {
  return NextResponse.json(
    { error: "공개 폴더 등록을 찾을 수 없습니다" },
    { status: 404 },
  );
}

// 설정 변경 — 부분 갱신. 표시 이름은 등록부만 바꾼다(폴더 이름과 무관하게
// 화면 라벨만 바뀐다 — 폴더 이름을 바꾸면 local id가 끊기므로 rename은
// 가드로 막혀 있다).
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return runWithAdmin({ fresh: true }, async ({ session }) => {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) return badRequest("잘못된 요청입니다");
    const parsed = parseSettingsPatch(body);
    if ("error" in parsed) return badRequest(parsed.error);
    const patch: PublicFolderPatch = { ...parsed.patch };
    if ("name" in body) {
      const name = parsePublicFolderName(body.name);
      if (!name) return badRequest("공개 폴더 이름을 확인해 주세요");
      patch.name = name;
    }
    if (Object.keys(patch).length === 0) {
      return badRequest("잘못된 요청입니다");
    }
    try {
      const updated = await updatePublicFolder(id, patch);
      if (!updated) return missing();
      console.info("[admin]", {
        event: "public-folder-updated",
        publicFolderId: updated.id,
        actorUserId: session.userId,
      });
      return NextResponse.json(
        { folder: updated },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (e) {
      return errorResponse(e);
    }
  });
}

// 등록 해제 — 폴더·파일은 데스크에 남는다. 주소는 즉시 404가 된다.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return runWithAdmin({ fresh: true }, async ({ session }) => {
    const { id } = await params;
    try {
      const removed = await removePublicFolder(id);
      if (!removed) return missing();
      console.info("[admin]", {
        event: "public-folder-removed",
        publicFolderId: id,
        actorUserId: session.userId,
      });
      return NextResponse.json({ removed: true, filesKept: true });
    } catch (e) {
      return errorResponse(e);
    }
  });
}
