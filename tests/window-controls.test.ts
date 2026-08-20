import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("데스크의 모든 일반 창은 최소화·최대화와 작업표시줄 복원을 제공한다", async () => {
  const [view, css, quick, links, chat] = await Promise.all([
    readFile(new URL("../src/app/files/FilesView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/files/desktop.module.css", import.meta.url), "utf8"),
    readFile(new URL("../src/app/files/QuickLinkWindow.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/files/ShareLinksWindow.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/files/ChatPanel.tsx", import.meta.url), "utf8"),
  ]);

  for (const state of ["searchWindow", "trashWindow", "previewWindow", "folderNoteWindow"]) {
    assert.match(view, new RegExp(`\\{${state} && !${state}\\.minimized && \\(`));
    assert.match(view, new RegExp(`${state}\\.maximized \\? styles\\.utilityMaximized`));
  }
  for (const focus of [
    "focusSearchWindow",
    "focusTrashWindow",
    "focusPreviewWindow",
    "focusFolderNoteWindow",
  ]) {
    assert.match(view, new RegExp(`onClick=\\{${focus}\\}`));
  }
  assert.match(view, /aria-label=\{searchWindow\.maximized \? t\("복원"\) : t\("최대화"\)\}/);
  assert.match(view, /aria-label=\{trashWindow\.maximized \? t\("복원"\) : t\("최대화"\)\}/);
  assert.match(view, /aria-label=\{previewWindow\.maximized \? t\("복원"\) : t\("최대화"\)\}/);
  assert.match(css, /\.folderWindow\.utilityMaximized \{/);

  for (const utility of [quick, links]) {
    assert.match(utility, /aria-label=\{t\("최소화"\)\}/);
    assert.match(utility, /maximized \? t\("복원"\) : t\("최대화"\)/);
  }
  assert.match(view, /\{quickLinkWindow && \(/);
  assert.match(quick, /minimized \? styles\.utilityHidden/);
  assert.match(chat, /aria-label=\{t\("최소화"\)\}/);
  assert.doesNotMatch(chat, /maximizeGlyph|"최대화"/);
});
