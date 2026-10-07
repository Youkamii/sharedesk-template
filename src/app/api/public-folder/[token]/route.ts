import { NextRequest, NextResponse } from "next/server";
import { getLayoutSnapshot } from "@/lib/desktop-layout";
import {
  publicFolderNoteHash,
  readPublicFolderNote,
} from "@/lib/public-folders";
import { runWithSpace } from "@/lib/space-context";
import { getAdapter } from "@/lib/storage";
import { missing, resolveOpenPublicFolder } from "./shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 공개 폴더(#10) 목록 — 무로그인 외부인도 연다. 화면이 바탕화면과 똑같이
// 그리도록 저장된 아이콘 좌표를 함께 준다.
export async function GET(
  req: NextRequest,
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
    // 안내문(#17 B-5) — 관리자가 "안내문 보이기"를 켠 폴더만, 켜져 있을 때만.
    // 꺼져 있으면 noteHash·note 키 자체가 없다(메모를 읽지도 않는다). 켜져
    // 있으면 지문(noteHash)은 늘 싣고, 본문(note)은 화면이 보낸 지문
    // (?noteHash=)과 다를 때만 싣는다 — 30초 폴링마다 메모(최대 100 KiB)를 다시
    // 보내지 않게. 관리자가 끄거나 메모를 고치면 다음 목록부터 반영된다.
    const note = await readPublicFolderNote(resolved.folder);
    const noteHash = note === null ? null : publicFolderNoteHash(note);
    const knownHash = req.nextUrl.searchParams.get("noteHash");
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
        ...(noteHash !== null
          ? { noteHash, ...(knownHash === noteHash ? {} : { note }) }
          : {}),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  });
}
