import { NextRequest, NextResponse } from "next/server";
import { recordActivityAfter } from "@/lib/activity";
import { isRegisteredPublicFolder } from "@/lib/public-folders";
import { getAdapter } from "@/lib/storage";
import { errorResponse, runWithEditRights } from "@/lib/api";

export async function POST(req: NextRequest) {
  return runWithEditRights({ fresh: true }, async ({ session, space }) => {
    const body = await req.json().catch(() => null);
    if (
      !body ||
      typeof body.id !== "string" ||
      typeof body.targetFolderId !== "string" ||
      typeof body.expectedVersion !== "string" ||
      !body.expectedVersion
    ) {
      return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
    }
    try {
      // 공개 폴더(#10) 가드 — 기본 데스크 문맥에서만 판정한다.
      // (a) 공개 폴더 자신은 옮길 수 없다: local의 폴더 id는 경로 기반이라
      //     옮기면 등록이 끊긴다. (b) 폴더를 공개 폴더 안으로 옮기면 평평
      //     유지가 깨진다 — 파일 이동은 허용(기존 파일을 공개하는 통로).
      if (space === null) {
        if (await isRegisteredPublicFolder(body.id)) {
          return NextResponse.json(
            { error: "공개 폴더는 이동하거나 이름을 바꿀 수 없습니다" },
            { status: 400 },
          );
        }
        if (await isRegisteredPublicFolder(body.targetFolderId)) {
          const moving = await getAdapter().getEntry(body.id);
          if (moving.isFolder) {
            return NextResponse.json(
              { error: "공개 폴더에는 하위 폴더를 만들 수 없습니다" },
              { status: 400 },
            );
          }
        }
      }
      const entry = await getAdapter().move(
        body.id,
        body.targetFolderId,
        body.expectedVersion,
      );
      // 어디서 어디로 옮겼는지는 표시용 정보다 — 클라이언트가 아는 만큼만
      // 받아 길이를 자르고 기록에 붙인다.
      // 기록 위조 방지: 제어 문자와 방향 제어 문자를 걷어내고 길이를 자른다.
      const trimName = (value: unknown) => {
        if (typeof value !== "string") return null;
        const clean = value
          .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
          .trim()
          .slice(0, 120);
        return clean.length > 0 ? clean : null;
      };
      const fromName = trimName((body as { fromName?: unknown }).fromName);
      const toName = trimName((body as { toName?: unknown }).toName);
      recordActivityAfter(
        session,
        "move",
        fromName && toName
          ? `${entry.name} (${fromName} → ${toName})`
          : toName
            ? `${entry.name} (→ ${toName})`
            : entry.name,
      );
      return NextResponse.json({ entry });
    } catch (e) {
      return errorResponse(e);
    }
  });
}
