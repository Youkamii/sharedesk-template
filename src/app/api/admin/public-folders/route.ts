import { NextRequest, NextResponse } from "next/server";
import { errorResponse, runWithAdmin } from "@/lib/api";
import {
  addPublicFolder,
  listPublicFolders,
  parsePublicFolderFileLimit,
  parsePublicFolderName,
  parsePublicFolderTime,
  type PublicFolder,
  type PublicFolderPatch,
} from "@/lib/public-folders";
import { USER_ROLES, type UserRole } from "@/lib/roles";
import { getAdapter } from "@/lib/storage";
import { ROOT_ID } from "@/lib/storage/types";
import { parseOptionalByteLimit } from "@/lib/users";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 공개 폴더 관리(#10) — admin 전용. 등록은 항상 데스크 루트에 새 폴더를
// 만든다(기존 폴더 지정 없음 — 평평 보장이 생성 시점부터 성립).

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export interface AdminPublicFolderSummary
  extends Omit<PublicFolder, "folderIdentity"> {
  url: string;
  // 대상 폴더가 지워졌거나 다른 실체로 바뀌었다(identity 불일치) — 주소는
  // 이미 404로 닫혀 있고, 관리 화면은 정리를 안내한다.
  missing: boolean;
}

async function describe(folder: PublicFolder): Promise<AdminPublicFolderSummary> {
  let missing = false;
  try {
    const target = await getAdapter().getEntry(folder.folderId);
    missing = !target.isFolder || target.layoutKey !== folder.folderIdentity;
  } catch {
    missing = true;
  }
  const summary: AdminPublicFolderSummary & { folderIdentity?: string } = {
    ...folder,
    url: `/public/${folder.id}`,
    missing,
  };
  delete summary.folderIdentity;
  return summary;
}

export async function GET() {
  return runWithAdmin({ fresh: true }, async () => {
    try {
      const folders = await listPublicFolders();
      const described = [];
      for (const folder of folders) {
        described.push(await describe(folder));
      }
      return NextResponse.json(
        { folders: described },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (e) {
      return errorResponse(e);
    }
  });
}

// 공통 필드 파서 — POST(생성)와 PATCH(수정)가 같은 검증을 쓴다. 각 필드는
// body에 존재할 때만 patch에 실리고, 형태가 어긋나면 오류 문구를 돌려준다.
export function parseSettingsPatch(
  body: Record<string, unknown>,
): { patch: Omit<PublicFolderPatch, "name"> } | { error: string } {
  const patch: Omit<PublicFolderPatch, "name"> = {};
  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") return { error: "잘못된 요청입니다" };
    patch.enabled = body.enabled;
  }
  for (const key of ["opensAt", "closesAt"] as const) {
    if (!(key in body)) continue;
    const parsed = parsePublicFolderTime(body[key]);
    if (parsed === undefined) {
      return { error: "공개 시각 값을 확인해 주세요" };
    }
    patch[key] = parsed;
  }
  for (const key of ["maxTotalBytes", "maxFileBytes"] as const) {
    if (!(key in body)) continue;
    const parsed = parseOptionalByteLimit(body[key]);
    if (parsed === undefined) {
      return { error: "용량 제한 값을 확인해 주세요" };
    }
    patch[key] = parsed;
  }
  if ("maxFiles" in body) {
    const parsed = parsePublicFolderFileLimit(body.maxFiles);
    if (parsed === undefined) {
      return { error: "파일 개수 제한 값을 확인해 주세요" };
    }
    patch.maxFiles = parsed;
  }
  if ("minRole" in body) {
    if (body.minRole === null) patch.minRole = null;
    else if (USER_ROLES.includes(body.minRole as UserRole)) {
      patch.minRole = body.minRole as UserRole;
    } else return { error: "역할 값을 확인해 주세요" };
  }
  if ("userIds" in body) {
    if (
      !Array.isArray(body.userIds) ||
      body.userIds.some((id) => typeof id !== "string" || !id) ||
      body.userIds.length > 200
    ) {
      return { error: "개인 지정 값을 확인해 주세요" };
    }
    patch.userIds = body.userIds as string[];
  }
  // 교차 불변식은 라이브러리(assertTimeOrder)가 최종 판정하지만, 두 값이
  // 함께 온 경우는 여기서도 미리 거른다(desk-settings 이중 검증 관례).
  if (
    patch.opensAt != null &&
    patch.closesAt != null &&
    Date.parse(patch.opensAt) >= Date.parse(patch.closesAt)
  ) {
    return { error: "공개 종료 시각은 시작 시각보다 뒤여야 합니다" };
  }
  return { patch };
}

export async function POST(req: NextRequest) {
  return runWithAdmin({ fresh: true }, async ({ session }) => {
    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) return badRequest("잘못된 요청입니다");
    const name = parsePublicFolderName(body.name);
    if (!name) return badRequest("공개 폴더 이름을 확인해 주세요");
    const parsed = parseSettingsPatch(body);
    if ("error" in parsed) return badRequest(parsed.error);

    try {
      const adapter = getAdapter();
      const created = await adapter.createFolder(ROOT_ID, name);
      try {
        const folder = await addPublicFolder({
          folderId: created.id,
          folderIdentity: created.layoutKey,
          name,
          createdByUserId: session.userId,
          ...parsed.patch,
        });
        console.info("[admin]", {
          event: "public-folder-created",
          publicFolderId: folder.id,
          actorUserId: session.userId,
        });
        return NextResponse.json(
          { folder: await describe(folder) },
          { status: 201, headers: { "Cache-Control": "no-store" } },
        );
      } catch (error) {
        // 등록에 실패하면 방금 만든 폴더를 되돌린다 — 고아 폴더 방지.
        await adapter.remove(created.id).catch(() => undefined);
        throw error;
      }
    } catch (e) {
      return errorResponse(e);
    }
  });
}
