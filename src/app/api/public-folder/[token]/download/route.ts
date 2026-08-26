import { NextRequest } from "next/server";
import { runWithSpace } from "@/lib/space-context";
import { getAdapter } from "@/lib/storage";
import type { DownloadResult } from "@/lib/storage/types";
import { missing, resolveOpenPublicFolder } from "../shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// share/[linkId]와 같은 attachment 고정 응답 — 브라우저 안에서 렌더되지
// 않게 하고, Range를 지원한다.
function downloadResponse(file: DownloadResult): Response {
  const asciiName = file.name
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "'");
  const encodedName = encodeURIComponent(file.name).replace(
    /['()*!]/g,
    (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase(),
  );
  const headers = new Headers({
    "Content-Type": file.mimeType,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
  });
  if (file.acceptRanges !== false) headers.set("Accept-Ranges", "bytes");
  const length = file.contentLength ?? file.size;
  if (length !== null) headers.set("Content-Length", String(length));
  if (file.status === 206 && file.contentRange) {
    headers.set("Content-Range", file.contentRange);
  }
  return new Response(file.stream, { status: file.status, headers });
}

// 공개 폴더(#10) 파일 다운로드 — 무로그인. 폴더 밖 항목 id를 끼워 넣는
// 시도는 isWithin이 걸러낸다.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  return runWithSpace(null, async () => {
    const resolved = await resolveOpenPublicFolder(token);
    if (!resolved) return missing();
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return missing();
    const rawRange = req.headers.get("range");
    const range =
      rawRange && rawRange.length <= 100 && /^bytes=[\d,\s-]+$/.test(rawRange)
        ? rawRange
        : undefined;
    try {
      const adapter = getAdapter();
      if (!(await adapter.isWithin(id, resolved.folder.folderId))) {
        return missing();
      }
      const entry = await adapter.getEntry(id);
      if (entry.isFolder) return missing();
      return downloadResponse(await adapter.download(id, range));
    } catch {
      return missing();
    }
  });
}
