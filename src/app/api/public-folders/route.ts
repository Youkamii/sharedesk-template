import { NextResponse } from "next/server";
import { errorResponse, runWithSession } from "@/lib/api";
import { listPublicFolders, publicFolderAccess } from "@/lib/public-folders";
import { getAdapter } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 사이드바 "공개 폴더 입장"(#11) — 지금 세션으로 열려 있는 공개 폴더만 준다.
// 판정은 공개 라우트와 같은 publicFolderAccess 하나로 한다(별도 관리자
// 특례 없음 — 꺼졌거나 기간 밖이면 관리자에게도 안 보인다). 등록부는 기본
// 데스크 상태 파일이므로 스페이스 문맥에서는 빈 목록이다.
export async function GET() {
  return runWithSession({ fresh: true }, async ({ session, space }) => {
    try {
      if (space !== null) {
        return NextResponse.json(
          { folders: [] },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      const now = new Date();
      const adapter = getAdapter();
      const folders = [];
      for (const folder of await listPublicFolders()) {
        if (publicFolderAccess(folder, session, now) !== "open") continue;
        // 대상 폴더가 지워졌거나 바뀐 등록(공개 주소가 404인 것)은 죽은
        // 링크가 되므로 목록에서도 뺀다 — 공개 라우트와 같은 identity 대조.
        try {
          const target = await adapter.getEntry(folder.folderId);
          if (!target.isFolder || target.layoutKey !== folder.folderIdentity) {
            continue;
          }
        } catch {
          continue;
        }
        folders.push({
          id: folder.id,
          name: folder.name,
          url: `/public/${folder.id}`,
        });
      }
      return NextResponse.json(
        { folders },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      return errorResponse(error);
    }
  });
}
