import { NextRequest, NextResponse } from "next/server";
import { getLayoutSnapshot } from "@/lib/desktop-layout";
import { runWithSpace } from "@/lib/space-context";
import { getAdapter } from "@/lib/storage";
import { missing, resolveOpenPublicFolder } from "./shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 공개 폴더(#10) 목록 — 무로그인 외부인도 연다. 화면이 바탕화면과 똑같이
// 그리도록 저장된 아이콘 좌표를 함께 준다.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  return runWithSpace(null, async () => {
    const resolved = await resolveOpenPublicFolder(token);
    if (!resolved) return missing();
    const adapter = getAdapter();
    const entries = await adapter.list(resolved.folder.folderId);
    // 좌표는 저장분만 읽는다(getLayoutSnapshot은 순수 읽기 — 익명 GET이
    // 레이아웃 쓰기를 유발하면 안 된다). layoutKey는 호스트 내부 값이라
    // 익명에게 내리지 않고 entry id로 재키잉한다. 좌표가 없는 항목은
    // 화면이 기본 격자에 배치한다.
    const positions: Record<string, { x: number; y: number }> = {};
    try {
      const snapshot = await getLayoutSnapshot(resolved.folder.folderId);
      for (const entry of entries) {
        const position = snapshot.positions[entry.layoutKey];
        if (position) positions[entry.id] = { x: position.x, y: position.y };
      }
    } catch {
      // 레이아웃 파일이 없거나 깨졌으면 기본 배치로 그린다.
    }
    return NextResponse.json(
      {
        name: resolved.folder.name,
        entries: entries.map((entry) => ({
          id: entry.id,
          name: entry.name,
          isFolder: entry.isFolder,
          size: entry.size,
          mimeType: entry.mimeType,
        })),
        positions,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  });
}
