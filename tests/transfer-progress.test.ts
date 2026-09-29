import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  formatTransferBytes,
  transferProgressText,
} from "../src/lib/client/transfer";

test("전송 진행량은 사람이 읽기 쉬운 단위로 표시한다", () => {
  assert.equal(formatTransferBytes(0), "0 B");
  assert.equal(formatTransferBytes(1536), "1.5 KB");
  assert.equal(formatTransferBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(
    transferProgressText({
      id: "one",
      kind: "upload",
      name: "영상.mp4",
      transferred: 1024,
      total: 2048,
    }),
    "1.0 KB / 2.0 KB",
  );
});

test("업로드와 다운로드는 실제 바이트 진행을 접속자 목록에 보고한다", async () => {
  const [view, helper, css, presenceTab] = await Promise.all([
    readFile("src/app/files/FilesView.tsx", "utf8"),
    readFile("src/lib/client/transfer.ts", "utf8"),
    readFile("src/app/files/desktop.module.css", "utf8"),
    readFile("src/lib/client/presence-tab.ts", "utf8"),
  ]);

  assert.match(helper, /XMLHttpRequest/);
  assert.match(helper, /request\.upload\.addEventListener\("progress"/);
  assert.ok(
    helper.indexOf('request.upload.addEventListener("progress"') <
      helper.indexOf("request.open(method, url)"),
  );
  assert.match(helper, /response\.body\.getReader\(\)/);
  assert.match(helper, /writable\.write\(chunk\.value\)/);
  assert.match(helper, /picker\.call\(window/);
  assert.match(helper, /reader\.cancel\(error\)/);
  assert.doesNotMatch(helper, /response\.blob\(\)|arrayBuffer\(\)/);
  assert.match(view, /transfers: \[\.\.\.activeTransfersRef\.current\.values\(\)\]/);
  assert.match(view, /tabId: getPresenceTabId\(\)/);
  // 탭 식별값은 위젯 화면과 공유하는 모듈(presence-tab.ts)이 sessionStorage에 둔다
  assert.match(view, /getPresenceTabId = useCallback\(\(\) => presenceTabId\(\), \[\]\)/);
  assert.match(presenceTab, /PRESENCE_TAB_KEY = "sharedesk\.presence-tab"/);
  assert.match(presenceTab, /window\.sessionStorage\.getItem\(PRESENCE_TAB_KEY\)/);
  assert.match(view, /setActiveTransfers\(\[\.\.\.activeTransfersRef\.current\.values\(\)\]\)/);
  assert.match(view, /Math\.max\(0, 1_500 - visibleFor\)/);
  assert.match(view, /window\.setInterval\(\(\) => void readPresence\(\), 1_000\)/);
  assert.match(view, /activeTransfers\.length > 0/);
  assert.match(view, /올리는 중/);
  assert.match(view, /받는 중/);
  assert.match(view, /<progress/);
  assert.match(css, /\.memberTransfers\s*\{/);
  assert.match(css, /\.transferRow progress\s*\{/);
});

test("업로드 중에는 데스크톱과 모바일, 간이 링크에서 페이지 이탈을 확인한다", async () => {
  const [view, mobileView, quickLinkView] = await Promise.all([
    readFile("src/app/files/FilesView.tsx", "utf8"),
    readFile("src/app/files/MobileFilesView.tsx", "utf8"),
    readFile("src/app/files/QuickLinkWindow.tsx", "utf8"),
  ]);
  const beforeUnloadEffect =
    /useEffect\(\(\) => \{\s*const handleBeforeUnload = [\s\S]*?\n  \}, \[\]\);/;
  const desktopEffect = view.match(beforeUnloadEffect)?.[0] ?? "";
  const mobileEffect = mobileView.match(beforeUnloadEffect)?.[0] ?? "";
  const quickLinkEffect = quickLinkView.match(beforeUnloadEffect)?.[0] ?? "";

  assert.match(desktopEffect, /activeTransfersRef\.current\.values\(\)/);
  assert.match(desktopEffect, /transfer\.kind === "upload"/);
  assert.match(
    desktopEffect,
    /if \(!activePreviewDiscardReason\(\) && !hasActiveUpload\) return;/,
  );
  assert.match(mobileEffect, /if \(activeUploadCountRef\.current <= 0\) return;/);
  assert.match(quickLinkEffect, /if \(!hasActiveUploadRef\.current\) return;/);
  assert.match(quickLinkView, /const hasActiveUploadRef = useRef\(false\)/);
  assert.match(quickLinkView, /useEffect\(\(\) => \{\s*hasActiveUploadRef\.current = items\.some\(\(item\) => item\.status === "uploading"\);\s*\}, \[items\]\);/);
  for (const effect of [desktopEffect, mobileEffect, quickLinkEffect]) {
    assert.match(effect, /event\.preventDefault\(\)/);
    assert.match(effect, /event\.returnValue = ""/);
    assert.match(effect, /window\.addEventListener\("beforeunload", handleBeforeUnload\)/);
    assert.match(effect, /window\.removeEventListener\("beforeunload", handleBeforeUnload\)/);
  }
  assert.match(mobileView, /const activeUploadCountRef = useRef\(0\)/);
  assert.match(
    mobileView,
    /activeUploadCountRef\.current \+= 1;\s*try \{\s*await uploadOne\(/,
  );
  assert.match(mobileView, /finally \{\s*activeUploadCountRef\.current -= 1;/);
});

test("두 화면은 공용 업로드 흐름에 진행 콜백을 연결하고 재개 뒤 각 목록을 갱신한다", async () => {
  const [desktop, mobile] = await Promise.all([
    readFile("src/app/files/FilesView.tsx", "utf8"),
    readFile("src/app/files/MobileFilesView.tsx", "utf8"),
  ]);
  for (const source of [desktop, mobile]) {
    assert.match(source, /import\s*\{[^}]*\bcreatePendingUploadFlow\b[^}]*\}\s*from "@\/lib\/client\/pending-upload-flow"/);
    assert.doesNotMatch(source, /\buploadResumable\b/);
    assert.match(source, /업로드 예약이 만료되어 처음부터 다시 올려야 합니다 · \{name\}/);
    assert.match(source, /ref=\{resumeInputRef\}/);
    assert.match(source, /matchPendingUpload\(\[record\], file\)/);
  }
  assert.match(desktop, /flow\.uploadDirect\(record, file, updateTransfer, \{ persist: true \}\)/);
  assert.match(desktop, /flow\.resume\(record, file, updateTransfer\)/);
  assert.match(desktop, /activeTransfersRef\.current\.has\(record\.id\)/);
  assert.match(desktop, /windowsRef\.current\.find\(\(item\) => item\.path\.at\(-1\)\?\.id === record\.parentId\)/);
  assert.match(desktop, /await refreshScope\(folderWindow\.id\)/);
  assert.match(mobile, /if \(!allowUpload \|\| busy\) return;/);
  assert.match(mobile, /await flow\.resume\(record, file, updateProgress\);[\s\S]*?reload\(\)/);
});
