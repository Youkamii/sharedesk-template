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
  const [view, helper, css] = await Promise.all([
    readFile("src/app/files/FilesView.tsx", "utf8"),
    readFile("src/lib/client/transfer.ts", "utf8"),
    readFile("src/app/files/desktop.module.css", "utf8"),
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
  assert.match(view, /window\.sessionStorage\.getItem\("sharedesk\.presence-tab"\)/);
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
