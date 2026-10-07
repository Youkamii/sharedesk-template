import { NextRequest, NextResponse } from "next/server";
import {
  SHARE_LINK_ID_PATTERN,
  formatUtcExpiry,
  shareLandingPath,
  shareLandingPreviewPlan,
  wantsShareLanding,
} from "@/lib/share-landing";
import { recordShareLinkDownloadAfter } from "@/lib/share-link-downloads";
import { resolveShareLink } from "@/lib/share-links";
import { runWithSpace } from "@/lib/space-context";
import { getAdapter } from "@/lib/storage";
import type { DownloadResult, Entry, StorageAdapter } from "@/lib/storage/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function missing() {
  return NextResponse.json(
    { error: "링크가 만료되었거나 존재하지 않습니다" },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// inlineType이 있으면(받기 화면의 미리보기) 그 형식으로 inline, 없으면 지금까지처럼
// attachment 고정이다.
function downloadResponse(
  file: DownloadResult,
  downloadName = file.name,
  inlineType: string | null = null,
): Response {
  const asciiName = downloadName
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "'");
  const encodedName = encodeURIComponent(downloadName).replace(
    /['()*!]/g,
    (character) =>
      "%" + character.charCodeAt(0).toString(16).toUpperCase(),
  );
  const headers = new Headers({
    "Content-Type": inlineType ?? file.mimeType,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Content-Disposition": inlineType
      ? `inline; filename="${asciiName}"; filename*=UTF-8''${encodedName}`
      : `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
  });
  if (file.acceptRanges !== false) headers.set("Accept-Ranges", "bytes");
  const length = file.contentLength ?? file.size;
  if (length !== null) headers.set("Content-Length", String(length));
  if (file.status === 206 && file.contentRange) {
    headers.set("Content-Range", file.contentRange);
  }
  return new Response(file.stream, { status: file.status, headers });
}

// 앞 maxBytes만 흘려보내고 원본은 닫는다 — 저장소가 범위 요청을 무시하고
// 전체를 주더라도 텍스트 미리보기는 앞부분만 나간다.
function limitDownload(file: DownloadResult, maxBytes: number): DownloadResult {
  const reader = file.stream.getReader();
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) {
        controller.close();
        return;
      }
      const room = maxBytes - sent;
      const part =
        chunk.value.byteLength > room ? chunk.value.subarray(0, room) : chunk.value;
      sent += part.byteLength;
      if (part.byteLength > 0) controller.enqueue(part);
      if (sent >= maxBytes) {
        controller.close();
        await reader.cancel().catch(() => undefined);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const length = file.contentLength ?? file.size;
  return {
    ...file,
    stream,
    contentLength: length === null ? null : Math.min(length, maxBytes),
  };
}

function previewUnsupported(): Response {
  return NextResponse.json(
    { error: "미리보기로 열 수 없는 파일입니다(형식이나 크기)" },
    { status: 415, headers: { "Cache-Control": "no-store" } },
  );
}

// 받기 화면(#17 B-3)의 작은 미리보기(preview=1). 링크·폴더 범위 가드는 내려받기와
// 같은 길을 지난 뒤에만 여기 온다. 미리보기는 받아 간 횟수(B-7)에 세지 않으므로:
// - 이미지·PDF·텍스트만 inline으로 낸다(텍스트는 text/plain 강제, nosniff).
// - 크기 상한(이미지 8MB·PDF 16MB)을 넘거나 크기를 모르면 내주지 않는다(415) —
//   큰 파일이 세지 않는 내려받기 통로가 되지 않게. 상한 이하의 작은 이미지·PDF는
//   미리보기로도 통째 받을 수 있다(그만큼은 세지 않는다).
// - 텍스트는 크기와 상관없이 앞 64KB만 낸다(요청의 Range는 보지 않는다).
// - 그 밖의 형식은 415.
// 먼저 항목 정보로 판정해 넘는 파일은 저장소에서 읽지도 않고, 저장소가 실제로
// 내준 형식·크기로 한 번 더 판정한다(저장소마다 항목 정보와 다를 수 있다).
async function previewResponse(
  adapter: StorageAdapter,
  id: string,
  name: string,
  entry: Entry,
  range: string | undefined,
): Promise<Response> {
  const planned = shareLandingPreviewPlan({ name, mimeType: entry.mimeType });
  if (!planned) return previewUnsupported();
  const tooLarge = (size: number | null) =>
    planned.kind !== "text" && (size === null || size > planned.maxBytes);
  if (tooLarge(entry.size)) return previewUnsupported();
  const file = await adapter.download(
    id,
    planned.kind === "text" ? `bytes=0-${planned.maxBytes - 1}` : range,
  );
  const served = shareLandingPreviewPlan({ name, mimeType: file.mimeType });
  if (!served || served.kind !== planned.kind || tooLarge(file.size)) {
    void file.stream.cancel().catch(() => undefined);
    return previewUnsupported();
  }
  // 텍스트는 "앞 64KB짜리 본문"으로 낸다 — 요청에 Range가 없었으니 206·Content-Range
  // 없이 200으로, 이어받기 광고(Accept-Ranges)도 하지 않는다.
  return downloadResponse(
    served.kind === "text"
      ? {
          ...limitDownload(file, served.maxBytes),
          status: 200,
          contentRange: null,
          acceptRanges: false,
        }
      : file,
    name,
    served.inlineType,
  );
}

function folderPage(
  linkId: string,
  rootName: string,
  expiresAt: string,
  current: Entry,
  entries: Entry[],
): Response {
  const base = `/api/share/${encodeURIComponent(linkId)}`;
  const rows = entries
    .map((entry) => {
      const href = `${base}?entryId=${encodeURIComponent(entry.id)}`;
      return `<li><a href="${href}"><span>${entry.isFolder ? "▣" : "▪"}</span>${escapeHtml(entry.name)}${entry.isFolder ? "/" : ""}</a></li>`;
    })
    .join("");
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(rootName)} · ShareDesk</title>
<style>body{margin:0;background:#10172b;color:#111629;font:14px system-ui,sans-serif}.window{width:min(720px,calc(100% - 24px));margin:32px auto;background:#f4e7c5;border:2px solid #080d1c;box-shadow:6px 6px 0 #070b16}.title{padding:10px 12px;color:#fff4d2;background:#2d5c5b;font-weight:700}.path{display:flex;gap:8px;padding:10px 12px;background:#fff8e7;border-bottom:2px solid #7d7180}.path a{color:#2d5c5b}.list{min-height:180px;margin:0;padding:10px;list-style:none}.list li{border-bottom:1px solid #d8c7a5}.list a{display:flex;gap:9px;padding:10px;color:#111629;text-decoration:none}.list a:hover{background:#ffd27d}.empty{padding:28px;text-align:center;color:#686474}.foot{padding:8px 12px;color:#cdd5e8;background:#182446;font-size:12px}</style></head>
<body><main class="window"><header class="title">ShareDesk · ${escapeHtml(rootName)}</header><nav class="path"><a href="${base}">맨 위</a><span>/</span><strong>${escapeHtml(current.name)}</strong></nav>${rows ? `<ul class="list">${rows}</ul>` : '<p class="empty">빈 폴더입니다.</p>'}<footer class="foot">이 링크는 ${escapeHtml(formatUtcExpiry(expiresAt))}에 닫힙니다.</footer></main></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// 받는 데스크가 복사에 필요한 최소 정보만 담는다. 폴더면 바로 아래 항목까지
// 알려 주고, 하위 폴더는 받는 쪽이 entryId로 다시 물어본다 — 한 응답에 전체
// 트리를 담으면 큰 폴더에서 응답이 무한정 커진다.
function manifestResponse(
  expiresAt: string,
  entry: Entry,
  children: Entry[] | null,
): Response {
  const describe = (value: Entry) => ({
    id: value.id,
    name: value.name,
    isFolder: value.isFolder,
    size: value.size,
    mimeType: value.mimeType,
  });
  return NextResponse.json(
    {
      kind: entry.isFolder ? "folder" : "file",
      expiresAt,
      // 가리키는 항목 자신의 id는 싣지 않는다. 받는 쪽은 링크 주소로 바로
      // 받으므로 쓰지 않고, local 저장소의 id는 base64url로 감싼 경로라
      // 링크만 아는 외부에 폴더 구조를 흘리게 된다. 하위 목록의 id는
      // entryId로 지목하는 데 필요해 그대로 둔다.
      name: entry.name,
      isFolder: entry.isFolder,
      size: entry.size,
      mimeType: entry.mimeType,
      ...(children ? { entries: children.map(describe) } : {}),
    },
    {
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

// 공개 라우트 — 링크 소비는 아직 기본 데스크만 본다(스페이스 링크는 인수인계
// 문서의 "나중에 다룰 것"). 기본 문맥을 명시해 그 사실을 코드에 고정한다.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ linkId: string }> },
) {
  return runWithSpace(null, async () => {
    const { linkId } = await params;
    // 사람이 브라우저로 연 링크(#17 B-3)는 받기 화면으로 보낸다 — 이름·크기·
    // 보낸 사람·남은 시간을 보고 "받기"를 누르게. 화면이 링크·항목 판정을
    // 직접 하므로 여기서는 저장소를 읽지 않는다. curl·다운로드 관리자처럼
    // html을 바라지 않는 요청, format=json·download=1·preview=1은 지금까지처럼
    // 아래에서 바로 처리한다. Location은 상대 경로 — 터널·프록시 뒤에서도 같은
    // 호스트로 돌아온다.
    if (
      SHARE_LINK_ID_PATTERN.test(linkId) &&
      wantsShareLanding(req.headers.get("accept"), req.nextUrl.searchParams)
    ) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: shareLandingPath(
            linkId,
            req.nextUrl.searchParams.get("entryId"),
          ),
          "Cache-Control": "private, no-store",
          Vary: "Accept",
        },
      });
    }
    const link = await resolveShareLink(linkId).catch(() => null);
    if (!link) return missing();

    const rawRange = req.headers.get("range");
    const range =
      rawRange && rawRange.length <= 100 && /^bytes=[\d,\s-]+$/.test(rawRange)
        ? rawRange
        : undefined;
    // 다른 데스크가 복사해 갈 때는 사람이 보는 HTML 대신 기계가 읽을 목록이
    // 필요하다. 노출 범위는 HTML 목록과 같다 — 링크를 아는 쪽만 볼 수 있다.
    const wantsManifest = req.nextUrl.searchParams.get("format") === "json";
    // 받기 화면의 미리보기(#17 B-3) — 받아 간 횟수에 세지 않는다(크기 상한은
    // previewResponse).
    const wantsPreview = req.nextUrl.searchParams.get("preview") === "1";
    // "받아 갔는지"(#17 B-7) = 저장소가 파일 본문 전송을 시작한 것. 끝까지
    // 받았는지는 보지 않는다(중간에 끊긴 내려받기도 센다 — 데스크·공개 폴더
    // 기록과 같은 설계). 처음부터 받는 요청만 센다: Range 없음, 또는
    // "bytes=0-"(브라우저·다운로드 관리자가 처음부터 받으며 붙인다). 그 밖의
    // 범위 요청은 한 번의 내려받기가 쪼개진 이어받기라 세지 않고, HEAD는 GET이
    // 자동으로 대신 받지만 본문을 가져가지 않는다. 목록(HTML·manifest)은
    // 파일을 받은 것이 아니라 세지 않는다.
    const fromStart = !range || range.replace(/\s+/g, "") === "bytes=0-";
    const countsAsDownload = fromStart && req.method !== "HEAD";
    try {
      const adapter = getAdapter();
      if (link.kind === "folder") {
        const targetId = req.nextUrl.searchParams.get("entryId") ?? link.fileId;
        if (!(await adapter.isWithin(targetId, link.fileId))) return missing();
        const entry = await adapter.getEntry(targetId);
        if (entry.isFolder) {
          const children = await adapter.list(entry.id);
          if (wantsManifest) {
            return manifestResponse(link.expiresAt, entry, children);
          }
          return folderPage(link.linkId, link.name, link.expiresAt, entry, children);
        }
        if (wantsManifest) return manifestResponse(link.expiresAt, entry, null);
        if (wantsPreview) {
          return previewResponse(adapter, entry.id, entry.name, entry, range);
        }
        const file = await adapter.download(entry.id, range);
        // 폴더 링크 안의 개별 파일도 기록한다 — 링크 횟수와 그 파일의 내력.
        if (countsAsDownload) {
          recordShareLinkDownloadAfter({
            linkId: link.linkId,
            linkName: link.name,
            fileId: entry.id,
            layoutKey: entry.layoutKey,
          });
        }
        return downloadResponse(file);
      }
      if (wantsManifest) {
        const entry = await adapter.getEntry(link.fileId);
        // 파일 링크의 표시 이름은 링크에 적힌 값을 그대로 쓴다 (다운로드와 동일).
        return manifestResponse(
          link.expiresAt,
          { ...entry, name: link.name },
          null,
        );
      }
      if (wantsPreview) {
        // 파일 링크의 표시 이름은 링크에 적힌 값(간이 링크의 임시 파일은 저장
        // 이름에 확장자가 없다).
        const entry = await adapter.getEntry(link.fileId);
        return previewResponse(adapter, link.fileId, link.name, entry, range);
      }
      const file = await adapter.download(link.fileId, range);
      // 저장소가 파일을 내주기 시작했을 때만 센다(없는 파일은 아래 catch가 404로 접는다).
      if (countsAsDownload) {
        recordShareLinkDownloadAfter({
          linkId: link.linkId,
          linkName: link.name,
          fileId: link.fileId,
        });
      }
      return downloadResponse(file, link.name);
    } catch {
      return missing();
    }
  });
}
