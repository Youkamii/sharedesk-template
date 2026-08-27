import { NextRequest } from "next/server";
import { runWithSpace } from "@/lib/space-context";
import { getAdapter } from "@/lib/storage";
import type { DownloadResult } from "@/lib/storage/types";
import { missing, resolveOpenPublicFolder } from "../shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// "다운로드 우선"을 끈 방문자에게만, 브라우저가 안전하게 그릴 수 있는
// 형식을 inline으로 연다(#14). HTML·SVG처럼 스크립트가 실행될 수 있는
// 형식은 목록에 없다 — 나머지는 전부 attachment 고정이 유지된다.
// 타입 이름이 정확히 끝나야 한다 — 뒤에 올 수 있는 건 파라미터(;)나
// 공백뿐이다. 앵커가 없으면 image/pngX·text/plainX 같은 변형이 통과한다.
const INLINE_SAFE_TYPES =
  /^(?:image\/(?:png|jpeg|gif|webp|avif|bmp)|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+|application\/pdf|text\/plain)\s*(?:;|$)/i;

// share/[linkId]와 같은 attachment 고정 응답 — 브라우저 안에서 렌더되지
// 않게 하고, Range를 지원한다.
function downloadResponse(file: DownloadResult, open: boolean): Response {
  const asciiName = file.name
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "'");
  const encodedName = encodeURIComponent(file.name).replace(
    /['()*!]/g,
    (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase(),
  );
  const disposition =
    open && INLINE_SAFE_TYPES.test(file.mimeType) ? "inline" : "attachment";
  const headers = new Headers({
    "Content-Type": file.mimeType,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Content-Disposition": `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
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
      return downloadResponse(
        await adapter.download(id, range),
        req.nextUrl.searchParams.get("open") === "1",
      );
    } catch {
      return missing();
    }
  });
}
