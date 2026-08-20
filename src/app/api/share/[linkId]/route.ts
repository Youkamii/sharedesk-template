import { NextRequest, NextResponse } from "next/server";
import { resolveShareLink } from "@/lib/share-links";
import { getAdapter } from "@/lib/storage";
import type { DownloadResult, Entry } from "@/lib/storage/types";

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

function downloadResponse(file: DownloadResult, downloadName = file.name): Response {
  const asciiName = downloadName
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "'");
  const encodedName = encodeURIComponent(downloadName).replace(
    /['()*!]/g,
    (character) =>
      "%" + character.charCodeAt(0).toString(16).toUpperCase(),
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

function folderPage(
  linkId: string,
  rootName: string,
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
<body><main class="window"><header class="title">ShareDesk · ${escapeHtml(rootName)}</header><nav class="path"><a href="${base}">맨 위</a><span>/</span><strong>${escapeHtml(current.name)}</strong></nav>${rows ? `<ul class="list">${rows}</ul>` : '<p class="empty">빈 폴더입니다.</p>'}<footer class="foot">이 링크는 정해진 시간이 지나면 자동으로 닫힙니다.</footer></main></body></html>`;
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

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ linkId: string }> },
) {
  const { linkId } = await params;
  const link = await resolveShareLink(linkId).catch(() => null);
  if (!link) return missing();

  const rawRange = req.headers.get("range");
  const range =
    rawRange && rawRange.length <= 100 && /^bytes=[\d,\s-]+$/.test(rawRange)
      ? rawRange
      : undefined;
  try {
    const adapter = getAdapter();
    if (link.kind === "folder") {
      const targetId = req.nextUrl.searchParams.get("entryId") ?? link.fileId;
      if (!(await adapter.isWithin(targetId, link.fileId))) return missing();
      const entry = await adapter.getEntry(targetId);
      if (entry.isFolder) {
        return folderPage(
          link.linkId,
          link.name,
          entry,
          await adapter.list(entry.id),
        );
      }
      return downloadResponse(await adapter.download(entry.id, range));
    }
    return downloadResponse(
      await adapter.download(link.fileId, range),
      link.name,
    );
  } catch {
    return missing();
  }
}
