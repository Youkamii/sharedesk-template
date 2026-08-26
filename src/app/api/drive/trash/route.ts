import { NextRequest, NextResponse } from "next/server";
import { recordActivityAfter } from "@/lib/activity";
import { getAdapter } from "@/lib/storage";
import { errorResponse, runWithEditRights, runWithSession } from "@/lib/api";
import { pruneDrivePermissionsForFiles } from "@/lib/drive-shares";
import {
  listPublicFolders,
  resolvePublicFolderTarget,
} from "@/lib/public-folders";
import { ROOT_ID, type TrashDeleteTarget } from "@/lib/storage/types";

const MAX_EMPTY_TARGETS = 1_000;

function isTrashTarget(value: unknown): value is TrashDeleteTarget {
  const target = value as Partial<TrashDeleteTarget> | null;
  return (
    !!target &&
    typeof target.id === "string" &&
    target.id.length > 0 &&
    target.id.length <= 1024 &&
    typeof target.version === "string" &&
    target.version.length > 0 &&
    target.version.length <= 1024
  );
}

async function cleanupShares(fileIds: string[]) {
  try {
    const shareCleanup = await pruneDrivePermissionsForFiles(fileIds);
    return {
      shareCleanup,
      warning:
        shareCleanup.failed > 0
          ? `파일은 삭제됐지만 공유 장부 ${shareCleanup.failed}건을 정리하지 못했습니다`
          : null,
    };
  } catch (error) {
    console.error("[trash] 삭제 뒤 공유 장부 정리 실패", error);
    return {
      shareCleanup: null,
      warning: "파일은 삭제됐지만 공유 장부를 정리하지 못했습니다",
    };
  }
}

export async function GET() {
  return runWithSession(null, async () => {
    try {
      const entries = await getAdapter().listTrash();
      return NextResponse.json({ entries });
    } catch (e) {
      return errorResponse(e);
    }
  });
}

export async function POST(req: NextRequest) {
  return runWithEditRights({ fresh: true }, async ({ session, space }) => {
    const body = await req.json().catch(() => null);
    const action = body?.action;
    if (action !== "restore" && action !== "purge" && action !== "empty") {
      return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
    }
    if (action !== "empty" && typeof body.id !== "string") {
      return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
    }
    if (
      (action === "purge" &&
        !isTrashTarget({ id: body.id, version: body.version })) ||
      (action === "empty" &&
        (!Array.isArray(body.targets) ||
          body.targets.length > MAX_EMPTY_TARGETS ||
          !body.targets.every(isTrashTarget)))
    ) {
      return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
    }
    try {
      const adapter = getAdapter();
      if (action === "restore") {
        const entry = await adapter.restore(body.id);
        // 평평 유지(#10): 휴지통 복원은 mkdir·move·rename 가드를 거치지 않는
        // 네 번째 쓰기 경로다. 복원 대상이 **폴더**인데 목적지가 등록된 공개
        // 폴더 안이면(원래 부모가 그 사이 공개 폴더가 됐다) 루트로 빼내
        // "공개 폴더엔 하위 폴더가 없다"를 지킨다 — 데이터는 잃지 않는다.
        // 파일 복원은 공개 폴더 안이 정상이므로 건드리지 않는다. 기본 데스크
        // 문맥에서만 검사한다(등록부는 기본 데스크 전용).
        let restored = entry;
        if (space === null && entry.isFolder && entry.version) {
          for (const folder of await listPublicFolders()) {
            // 죽은 등록(대상이 지워졌거나 교체됨)은 건너뛴다 — folderId
            // 문자열이 우연히 새 일반 폴더와 겹쳐도 오이동하지 않는다.
            if (!(await resolvePublicFolderTarget(folder))) continue;
            if (await adapter.isDirectChild(entry.id, folder.folderId)) {
              try {
                restored = await adapter.move(entry.id, ROOT_ID, entry.version);
              } catch (moveError) {
                // 루트 이동 실패(이름 충돌 등) 시 공개 폴더 안에 하위
                // 폴더를 남기지 않는다 — 복원을 되돌려 휴지통으로 보낸다.
                await adapter.remove(entry.id).catch(() => undefined);
                throw moveError;
              }
              break;
            }
          }
        }
        recordActivityAfter(session, "restore", restored.name);
        return NextResponse.json({ entry: restored });
      }
      if (action === "purge") {
        // 이름은 기록용 — 휴지통 목록에서 찾아 두고, 못 찾아도 삭제는 계속한다.
        const purgedName = await adapter
          .listTrash()
          .then((entries) => entries.find((entry) => entry.id === body.id)?.name)
          .catch(() => undefined);
        const fileId = await adapter.purge(body.id, body.version);
        recordActivityAfter(session, "purge", purgedName ?? "");
        return NextResponse.json({
          ok: true,
          ...(await cleanupShares([fileId])),
        });
      }
      const result = await adapter.emptyTrash(body.targets);
      recordActivityAfter(session, "empty-trash", String(result.fileIds.length));
      const cleanup = await cleanupShares(result.fileIds);
      const operationWarnings = [
        result.skipped > 0
          ? `${result.skipped}개 항목은 목록을 연 뒤 변경되어 건너뛰었습니다`
          : null,
        result.failed > 0
          ? `${result.failed}개 항목을 완전히 삭제하지 못했습니다`
          : null,
        cleanup.warning,
      ].filter((warning): warning is string => warning !== null);
      return NextResponse.json({
        ok: true,
        ...result,
        shareCleanup: cleanup.shareCleanup,
        warning:
          operationWarnings.length > 0 ? operationWarnings.join(" · ") : null,
      });
    } catch (e) {
      return errorResponse(e);
    }
  });
}
