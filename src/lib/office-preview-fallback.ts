import type { DownloadResult } from "@/lib/storage/types";

interface OfficePreviewFallbackOptions {
  id: string;
  name: string;
  reason: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export function createOfficePreviewFallback({
  id,
  name,
  reason,
}: OfficePreviewFallbackOptions): DownloadResult {
  const safeName = escapeHtml(name);
  const safeReason = escapeHtml(reason);
  const downloadHref = escapeHtml(
    `/api/drive/download?id=${encodeURIComponent(id)}`,
  );
  const html = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeName} 미리보기 안내</title>
  <style>
    @font-face {
      font-family: "Galmuri11";
      src: url("/fonts/Galmuri11.woff2") format("woff2");
      font-style: normal;
      font-weight: 400;
      font-display: swap;
    }
    :root {
      color-scheme: dark;
      font-family: "Galmuri11", sans-serif;
      background: #10172b;
    }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body {
      min-height: 100vh;
      min-height: 100dvh;
      display: grid;
      place-items: center;
      margin: 0;
      padding: clamp(14px, 4vw, 34px);
      color: #fff4d2;
      background:
        linear-gradient(rgb(8 13 31 / 18%), rgb(8 13 31 / 58%)),
        radial-gradient(circle at 78% 18%, #2f4670 0 2px, transparent 3px),
        radial-gradient(circle at 18% 72%, #61b3a6 0 1px, transparent 2px),
        #10172b;
      background-size: auto, 48px 48px, 36px 36px, auto;
    }
    .window {
      width: min(620px, 100%);
      color: #1b1b2f;
      background: #f4e7c5;
      border: 3px solid #10172b;
      box-shadow:
        inset 2px 2px 0 #fff8e7,
        inset -2px -2px 0 #9c8c78,
        8px 8px 0 rgb(5 9 20 / 72%);
    }
    .titlebar {
      min-height: 38px;
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 7px 11px;
      color: #fff8e7;
      background: #2d5c5b;
      border-bottom: 3px solid #10172b;
    }
    .mark {
      display: grid;
      width: 18px;
      height: 18px;
      flex: 0 0 auto;
      grid-template-columns: 1fr 1fr;
      gap: 2px;
      padding: 2px;
      background: #0b1021;
      border: 2px solid #f2a56f;
      box-shadow: 2px 2px 0 #173837;
    }
    .mark i:nth-child(1) { background: #ffd27d; }
    .mark i:nth-child(2) { background: #61b3a6; }
    .mark i:nth-child(3) { background: #e96872; }
    .mark i:nth-child(4) { background: #79a8e8; }
    .body {
      display: grid;
      grid-template-columns: 76px minmax(0, 1fr);
      gap: clamp(16px, 4vw, 26px);
      align-items: center;
      padding: clamp(22px, 6vw, 40px);
    }
    .document {
      position: relative;
      width: 66px;
      height: 82px;
      background: #fff8e7;
      border: 3px solid #10172b;
      box-shadow: inset -4px -4px 0 #d8c9a8, 5px 5px 0 #9c8c78;
    }
    .document::before {
      content: "";
      position: absolute;
      top: -3px;
      right: -3px;
      width: 22px;
      height: 22px;
      background: #ffd27d;
      border-left: 3px solid #10172b;
      border-bottom: 3px solid #10172b;
    }
    .document::after {
      content: "···";
      position: absolute;
      left: 12px;
      bottom: 13px;
      color: #2f4670;
      font-size: 18px;
      letter-spacing: 2px;
    }
    h1 {
      margin: 0 0 13px;
      color: #10172b;
      font-size: clamp(16px, 4vw, 21px);
      line-height: 1.4;
    }
    .filename {
      max-width: 100%;
      overflow: hidden;
      margin: 0 0 10px;
      color: #2d5c5b;
      font-size: 13px;
      line-height: 1.5;
      overflow-wrap: anywhere;
    }
    .reason {
      margin: 0;
      color: #4f4853;
      font-size: 12px;
      line-height: 1.65;
      white-space: pre-wrap;
    }
    .actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      padding: 14px clamp(18px, 5vw, 30px);
      background: #e5d6b7;
      border-top: 2px solid #9c8c78;
    }
    .hint {
      margin: 0;
      color: #666b78;
      font-size: 11px;
      line-height: 1.5;
    }
    a {
      min-height: 38px;
      display: inline-flex;
      flex: 0 0 auto;
      align-items: center;
      justify-content: center;
      padding: 8px 14px;
      color: #fff8e7;
      background: #2f4670;
      border: 2px solid #10172b;
      box-shadow:
        inset 2px 2px 0 #6c83ae,
        inset -2px -2px 0 #172342,
        3px 3px 0 #9c8c78;
      text-decoration: none;
    }
    a:focus-visible {
      outline: 3px solid #ffd27d;
      outline-offset: 3px;
    }
    @media (max-width: 460px) {
      .body { grid-template-columns: 1fr; }
      .document { display: none; }
      .actions { align-items: stretch; flex-direction: column; }
      a { width: 100%; }
    }
  </style>
</head>
<body>
  <main class="window">
    <header class="titlebar">
      <span class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
      <strong>ShareDesk 문서 미리보기</strong>
    </header>
    <section class="body">
      <span class="document" aria-hidden="true"></span>
      <div>
        <h1>이 문서를 미리보기로 바꾸지 못했어요.</h1>
        <p class="filename">${safeName}</p>
        <p class="reason">${safeReason}</p>
      </div>
    </section>
    <footer class="actions">
      <p class="hint">원본 파일은 그대로 보관되어 있습니다.</p>
      <a href="${downloadHref}">원본 다운로드</a>
    </footer>
  </main>
</body>
</html>`;
  const bytes = new TextEncoder().encode(html);
  return {
    stream: new Blob([bytes]).stream(),
    name: `${name}.preview.html`,
    size: bytes.byteLength,
    mimeType: "text/html; charset=utf-8",
    status: 200,
    contentRange: null,
    contentLength: bytes.byteLength,
    acceptRanges: false,
    generatedPreview: "office-fallback",
  };
}
