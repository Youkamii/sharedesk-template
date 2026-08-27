import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  classifyMoveFailure,
  confirmedMoveEntries,
  dragTerminalAction,
  foldersAwaitingIdle,
  isDragPointer,
  needsDetachedFolderRefresh,
  shouldRetryFolderReconciliation,
  windowsContainingFolder,
} from "../src/lib/client/file-move";
import {
  batchMutationNotice,
  removeSelectedLayoutKeys,
  selectLayoutKey,
  selectLayoutsInRectangle,
} from "../src/lib/client/batch-selection";
import {
  downloadFileName,
  fileActivationAction,
} from "../src/lib/client/file-activation";
import {
  DOWNLOAD_CONCURRENCY,
  downloadPercent,
  downloadQueueSummary,
  newDownloadItem,
  nextDownloadStarts,
  parseContentLength,
  patchDownloadItem,
  pruneFinishedDownloads,
  retryDownloadItem,
  runningDownloadCount,
  startDownloads,
} from "../src/lib/client/download-queue";
import {
  folderPathKey,
  isFolderExistsConflict,
  matchExistingFolder,
  planFolderUpload,
  resolveUploadTargets,
} from "../src/lib/client/folder-upload";
import {
  groupLayoutMigrationTargets,
  migrateEntryLayoutKey,
  migrateLayoutKey,
  migrateLayoutKeys,
} from "../src/lib/client/layout-key-migration";
import { previewDiscardReason } from "../src/lib/client/preview-draft";
import {
  fitLogicalRect,
  folderAddress,
  logicalPointerDelta,
  logicalViewportFor,
  nextNotepadName,
  reconcileSavedDraft,
  renamedCrumbsFromEntries,
  uiScaleForViewport,
} from "../src/app/files/ui-scale";

test("화면 비율이 달라도 데스크톱 전체를 스크롤 없이 확대·축소한다", () => {
  assert.equal(uiScaleForViewport(320, 568), 0.25);
  assert.equal(uiScaleForViewport(390, 844), 390 / 1280);
  assert.equal(uiScaleForViewport(768, 1024), 0.6);
  assert.equal(uiScaleForViewport(1280, 720), 1);
  assert.equal(uiScaleForViewport(1920, 1200), 1.5);

  assert.deepEqual(logicalViewportFor(1280, 720), {
    width: 1280,
    height: 720,
  });
  assert.deepEqual(logicalViewportFor(1920, 1200), {
    width: 1280,
    height: 800,
  });
  assert.deepEqual(logicalViewportFor(320, 568), {
    width: 1280,
    height: 2272,
  });
  assert.equal(logicalPointerDelta(90, 0.25), 360);

  for (const [width, height] of [
    [320, 568],
    [360, 640],
    [390, 844],
    [768, 1024],
    [1280, 720],
    [1366, 768],
    [1920, 1080],
    [2560, 1080],
  ]) {
    const logical = logicalViewportFor(width, height);
    assert.ok(logical.width >= 1280);
    assert.ok(logical.height >= 720);
  }
});

test("화면 크기가 바뀌면 일반 창과 최대화 창을 새 작업 영역에 맞춘다", () => {
  const viewport = { width: 900, height: 600 };
  const bounds = {
    left: 6,
    top: 40,
    right: 6,
    bottom: 64,
    minWidth: 390,
    minHeight: 300,
  };

  assert.deepEqual(
    fitLogicalRect(
      { x: 800, y: 500, width: 720, height: 500 },
      viewport,
      bounds,
    ),
    { x: 174, y: 40, width: 720, height: 496 },
  );
  assert.deepEqual(
    fitLogicalRect(
      { x: 120, y: 90, width: 500, height: 320 },
      viewport,
      bounds,
      true,
    ),
    { x: 6, y: 40, width: 888, height: 496 },
  );
});

test("저장 중에 이어 쓴 글은 유지하고 전송한 snapshot만 저장 기준으로 삼는다", () => {
  assert.deepEqual(reconcileSavedDraft("전송 뒤에 이어 쓴 글", "서버에 전송한 글"), {
    draft: "전송 뒤에 이어 쓴 글",
    original: "서버에 전송한 글",
    dirty: true,
  });
  assert.deepEqual(reconcileSavedDraft("같은 글", "같은 글"), {
    draft: "같은 글",
    original: "같은 글",
    dirty: false,
  });
});

test("편집 가능한 TXT의 미저장 내용과 저장 중 상태만 버리기 확인 대상이다", () => {
  assert.equal(
    previewDiscardReason({
      editable: false,
      text: "바뀐 글",
      originalText: "원래 글",
      saving: true,
    }),
    null,
  );
  assert.equal(
    previewDiscardReason({
      editable: true,
      text: "같은 글",
      originalText: "같은 글",
      saving: false,
    }),
    null,
  );
  assert.equal(
    previewDiscardReason({
      editable: true,
      text: "바뀐 글",
      originalText: "원래 글",
      saving: false,
    }),
    "unsaved",
  );
  assert.equal(
    previewDiscardReason({
      editable: true,
      text: "같은 글",
      originalText: "같은 글",
      saving: true,
    }),
    "saving",
  );
});

test("TXT 초안은 저장 완료 전 전환과 창 이탈·로그아웃·상위 폴더 작업에서 보호한다", async () => {
  const source = await readFile(
    new URL("../src/app/files/FilesView.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /addEventListener\("beforeunload", handleBeforeUnload\)/);
  assert.match(source, /event\.preventDefault\(\);\s*event\.returnValue = ""/);
  assert.match(
    source,
    /if \(reason === "saving"\) \{\s*setNotice\(t\("텍스트 파일을 저장하는 중입니다\. 저장이 끝난 뒤 다시 시도해 주세요"\)\);\s*return false/,
  );
  assert.match(
    source,
    /if \(!confirmPreviewDiscard\(\)\) return false;\s*discardActivePreview\(\)/,
  );
  assert.match(
    source,
    /entry\.isFolder &&\s*!confirmPreviewLifecycleChange\(entry\)/,
  );
  assert.match(
    source,
    /dialog\.kind === "delete" \|\| dialog\.entry\.isFolder[\s\S]*?!confirmPreviewLifecycleChange\(dialog\.entry\)/,
  );
  assert.match(
    source,
    /async function logout\(\) \{\s*if \(!confirmPreviewDiscard\(\)\) return;\s*if \(activePreviewDiscardReason\(\)\) discardActivePreview\(\)/,
  );
});

test("로컬 TXT의 새 layoutKey로 좌표와 선택 키를 옮긴다", () => {
  const previous = { id: "note", layoutKey: "old-key", version: "v1" };
  const replacement = { id: "note", layoutKey: "new-key", version: "v2" };
  const original: {
    entries: Array<{ id: string; layoutKey: string; version: string }>;
    positions: Record<string, { x: number; y: number; version: number }>;
  } = {
    entries: [previous, { id: "other", layoutKey: "other-key", version: "v1" }],
    positions: {
      "old-key": { x: 120, y: 80, version: 4 },
      "other-key": { x: 20, y: 10, version: 2 },
    },
  };

  const migrated = migrateEntryLayoutKey(
    original,
    previous,
    replacement,
    { x: 140, y: 90, version: 4 },
  );
  assert.equal(migrated.entries[0], replacement);
  assert.deepEqual(migrated.positions["new-key"], {
    x: 140,
    y: 90,
    version: 0,
  });
  assert.equal(migrated.positions["old-key"], undefined);
  assert.deepEqual(original.positions["old-key"], {
    x: 120,
    y: 80,
    version: 4,
  });
  assert.deepEqual(
    migrateLayoutKeys(["old-key", "other-key", "new-key"], "old-key", "new-key"),
    ["new-key", "other-key"],
  );
  assert.equal(migrateLayoutKey("old-key", "old-key", "new-key"), "new-key");

  const driveReplacement = { ...replacement, layoutKey: previous.layoutKey };
  const drive = migrateEntryLayoutKey(original, previous, driveReplacement);
  assert.equal(drive.positions, original.positions);
  assert.equal(drive.entries[0], driveReplacement);
});

test("같은 폴더를 연 창들은 새 layoutKey 좌표를 서버에 한 번만 저장한다", () => {
  assert.deepEqual(
    groupLayoutMigrationTargets(
      [
        {
          scopeId: "folder-1",
          folderId: "docs",
          folderIdentity: "stale-docs-key",
          position: { x: 10, y: 20 },
        },
        {
          scopeId: "folder-2",
          folderId: "docs",
          folderIdentity: "docs-key",
          position: { x: 30, y: 40 },
        },
        {
          scopeId: "folder-3",
          folderId: "other",
          folderIdentity: "other-key",
          position: { x: 50, y: 60 },
        },
      ],
      "folder-2",
    ),
    [
      {
        folderId: "docs",
        folderIdentity: "docs-key",
        position: { x: 30, y: 40 },
        scopeIds: ["folder-1", "folder-2"],
      },
      {
        folderId: "other",
        folderIdentity: "other-key",
        position: { x: 50, y: 60 },
        scopeIds: ["folder-3"],
      },
    ],
  );
});

test("이름 변경은 미리보기 형식 전환 전에 초안을 확인하고 성공한 응답으로 상태를 다시 만든다", async () => {
  const source = await readFile(
    new URL("../src/app/files/FilesView.tsx", import.meta.url),
    "utf8",
  );
  const renameGuard = source.slice(
    source.indexOf("function confirmPreviewRenameTransition"),
    source.indexOf("function updatePreviewAfterRename"),
  );
  const renameUpdate = source.slice(
    source.indexOf("function updatePreviewAfterRename"),
    source.indexOf("function movePreviewWindow"),
  );
  const submitDialog = source.slice(
    source.indexOf("async function submitDialog"),
    source.indexOf("async function logout"),
  );

  assert.match(renameGuard, /const nextKind = previewKindOf\(nextEntry\)/);
  assert.match(
    renameGuard,
    /activePreviewDiscardReason\(\) === "saving"[\s\S]*?return confirmPreviewDiscard\(\)/,
  );
  assert.match(renameGuard, /isEditableTextEntry\(current\.entry\)/);
  assert.match(renameGuard, /!isEditableTextEntry\(nextEntry\)/);
  assert.match(renameGuard, /return confirmPreviewDiscard\(\)/);
  assert.match(
    submitDialog,
    /confirmPreviewRenameTransition\([\s\S]*?setDialogBusy\(true\)[\s\S]*?\/api\/drive\/rename/,
  );

  assert.match(renameUpdate, /const nextKind = previewKindOf\(entry\)/);
  assert.match(
    renameUpdate,
    /if \(!nextKind\) \{\s*discardActivePreview\(\);[\s\S]*?미리보기를 지원하지 않아 창을 닫았습니다[\s\S]*?return true/,
  );
  assert.match(
    renameUpdate,
    /nextKind === current\.kind && entry\.id === previousId[\s\S]*?text: losesTextEditing \? current\.originalText : current\.text/,
  );
  assert.match(
    renameUpdate,
    /const kindChanged = nextKind !== current\.kind[\s\S]*?kind: nextKind[\s\S]*?text: kindChanged\s*\? null/,
  );
  assert.match(
    renameUpdate,
    /current\.kind === "text" && current\.textLoading/,
  );
  assert.match(
    renameUpdate,
    /if \(shouldReload\) void loadPreviewText\(entry, instanceId\)/,
  );
  assert.doesNotMatch(
    submitDialog,
    /classifyMoveFailure\(error\) === "uncertain"[\s\S]*?discardPreviewForEntry/,
  );
  assert.match(
    submitDialog,
    /if \(!previewClosed\) setNotice\(t\("이름을 바꿨습니다"\)\)/,
  );
});

test("TXT 저장 성공은 새 layoutKey 상태 이관 뒤 대표 좌표를 버전 0으로 저장한다", async () => {
  const source = await readFile(
    new URL("../src/app/files/FilesView.tsx", import.meta.url),
    "utf8",
  );
  const replaceStart = source.indexOf("function replaceEntryEverywhere");
  const persistStart = source.indexOf("async function persistMigratedEntryPositions");
  const saveStart = source.indexOf("async function savePreviewText");
  const saveEnd = source.indexOf("function confirmPreviewDiscard", saveStart);
  const replacement = source.slice(replaceStart, persistStart);
  const persistence = source.slice(persistStart, saveStart);
  const save = source.slice(saveStart, saveEnd);

  assert.match(replacement, /migrateEntryLayoutKey\(/);
  assert.match(replacement, /setSelected\(/);
  assert.match(replacement, /keyboardSelectionRef\.current/);
  assert.match(replacement, /setSearchWindow\(/);
  assert.match(persistence, /previousEntry\.layoutKey === entry\.layoutKey/);
  assert.match(persistence, /groupLayoutMigrationTargets\(/);
  assert.match(persistence, /expectedVersion: 0/);
  assert.match(
    save,
    /entryLayoutTargets\(preview\.entry\)[\s\S]*?replaceEntryEverywhere\(preview\.entry, result\.entry, layoutTargets\)[\s\S]*?persistMigratedEntryPositions\(/,
  );
});

test("상위 목록에서 확인한 폴더 이름을 열린 하위 경로에도 전파한다", () => {
  const path = [
    { id: "root", name: "ShareDesk" },
    { id: "parent", name: "예전 이름" },
    { id: "child", name: "하위" },
  ];
  const renamed = renamedCrumbsFromEntries(path, [
    { id: "parent", name: "새 이름", isFolder: true },
    { id: "file", name: "parent", isFolder: false },
  ]);

  assert.deepEqual(renamed, [
    { id: "root", name: "ShareDesk" },
    { id: "parent", name: "새 이름" },
    { id: "child", name: "하위" },
  ]);
  assert.equal(renamedCrumbsFromEntries(renamed, []), renamed);
});

test("폴더 주소와 겹치지 않는 새 메모장 이름을 ROOT 기준으로 만든다", () => {
  assert.equal(folderAddress([{ id: "root", name: "ShareDesk" }]), "/");
  assert.equal(
    folderAddress([
      { id: "root", name: "ShareDesk" },
      { id: "a", name: "자료" },
      { id: "b", name: "2026" },
    ]),
    "/자료/2026",
  );
  assert.equal(nextNotepadName([]), "새 메모장.txt");
  assert.equal(
    nextNotepadName(["새 메모장.txt", "새 메모장 2.txt"]),
    "새 메모장 3.txt",
  );
});

test("파일 화면은 배율·드래그 고스트·주소창·메모 편집 계약을 함께 지킨다", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../src/app/files/FilesView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/files/desktop.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(source, /data-testid="scaled-desktop-stage"/);
  assert.match(source, /transform: `scale\(\$\{uiScale\}\)`/);
  assert.match(source, /logicalPointerDelta\(next\.clientX - startX, uiScale\)/);
  assert.match(source, /document\.elementFromPoint\(clientX, clientY\)/);
  assert.match(source, /data-testid="file-drag-ghost"/);
  assert.match(source, /left: dragGhost\.clientX/);
  assert.match(css, /\.dragGhost \{[\s\S]*?z-index: 7000;/);

  assert.match(css, /\.closeGlyph \{ top: 50%; left: 50%;/);
  assert.match(css, /\.iconName \{[\s\S]*?text-overflow: ellipsis;[\s\S]*?white-space: nowrap;/);
  assert.match(source, /title=\{entry\.name\}/);

  assert.match(source, /\/api\/drive\/path\?path=/);
  assert.match(source, /data-testid=\{`folder-address-\$\{item\.id\}`\}/);
  assert.match(source, /\/api\/folder-note\?folderId=/);
  assert.match(source, /method: "PATCH"[\s\S]*?folderId: note\.folderId/);
  assert.doesNotMatch(source, /아직 아무도 파일을 놓지 않았어요/);

  assert.match(source, /new File\(\[""\], name, \{ type: "text\/plain" \}\)/);
  assert.match(source, /\/api\/drive\/content/);
  assert.match(source, /expectedVersion: preview\.entry\.version/);
  assert.match(source, /\.txt 파일만 여기에서 편집할 수 있습니다/);
  assert.match(source, /다른 사람이 먼저 파일을 바꿨습니다/);
  assert.match(source, /new TextDecoder\("utf-8", \{ fatal: true \}\)/);
  const folderStatus = source.match(
    /<footer className=\{styles\.windowStatus\}>([\s\S]*?)<\/footer>/,
  )?.[1];
  assert.ok(folderStatus);
  assert.doesNotMatch(
    folderStatus,
    /아이콘을 끌어 위치를 바꾸고|폴더 위에 놓으면/,
  );
  assert.match(source, /previewInstanceRef\.current !== instanceId/);
  assert.match(source, /folderNoteInstanceRef\.current !== instanceId/);
  assert.match(
    source,
    /function openPreview\([\s\S]*?if \(!confirmPreviewDiscard\(\)\) return;[\s\S]*?beginPreviewInstance\(\)/,
  );
  assert.match(
    source,
    /function closePreview\(\) \{[\s\S]*?if \(!confirmPreviewDiscard\(\)\) return;[\s\S]*?cancelPreviewRequests\(\)/,
  );
  assert.match(
    source,
    /beginScopedRequest\(addressRequestsRef\.current, windowId\)/,
  );
});

test("파일 이동의 명확한 4xx 거부만 즉시 원복 대상으로 분류한다", () => {
  const conflict = Object.assign(new Error("다른 사용자가 먼저 옮겼습니다"), {
    status: 409,
  });

  assert.equal(classifyMoveFailure({ status: 400 }), "definitive");
  assert.equal(classifyMoveFailure({ status: 401 }), "definitive");
  assert.equal(classifyMoveFailure({ status: 404 }), "definitive");
  assert.equal(classifyMoveFailure(conflict), "definitive");
});

test("응답 유실과 처리 여부가 모호한 HTTP 오류는 실제 목록을 다시 확인한다", () => {
  assert.equal(classifyMoveFailure(new TypeError("Failed to fetch")), "uncertain");
  assert.equal(classifyMoveFailure({ status: 403 }), "uncertain");
  assert.equal(classifyMoveFailure({ status: 408 }), "uncertain");
  assert.equal(classifyMoveFailure({ status: 422 }), "uncertain");
  assert.equal(classifyMoveFailure({ status: 429 }), "uncertain");
  assert.equal(classifyMoveFailure({ status: 499 }), "uncertain");
  assert.equal(classifyMoveFailure({ status: 500 }), "uncertain");
  assert.equal(classifyMoveFailure({ status: 503 }), "uncertain");
  assert.equal(classifyMoveFailure({ status: "409" }), "uncertain");
  assert.equal(classifyMoveFailure(null), "uncertain");
});

test("드래그는 시작한 포인터만 끝낼 수 있고 취소는 저장하지 않는다", () => {
  assert.equal(isDragPointer(7, 7), true);
  assert.equal(isDragPointer(7, 8), false);
  assert.equal(dragTerminalAction("pointerup", false, true), "ignore");
  assert.equal(dragTerminalAction("pointerup", true, false), "cleanup");
  assert.equal(dragTerminalAction("pointerup", true, true), "commit");
  assert.equal(dragTerminalAction("pointercancel", true, true), "discard");
});

test("겹친 이동이 있으면 폴더가 빌 때까지 기다리고 그 사이 변경되면 다시 조회한다", () => {
  const affectedFolderIds = ["source", "target", "target"];
  const pendingCounts = new Map([
    ["target", 2],
    ["unrelated", 1],
  ]);
  const startedVersions = new Map([
    ["source", 3],
    ["target", 5],
  ]);
  const currentVersions = new Map(startedVersions);

  assert.deepEqual(
    foldersAwaitingIdle(affectedFolderIds, pendingCounts),
    ["target"],
  );
  assert.equal(
    shouldRetryFolderReconciliation(
      affectedFolderIds,
      pendingCounts,
      startedVersions,
      currentVersions,
    ),
    true,
  );

  pendingCounts.delete("target");
  assert.equal(
    shouldRetryFolderReconciliation(
      affectedFolderIds,
      pendingCounts,
      startedVersions,
      currentVersions,
    ),
    false,
  );

  currentVersions.set("source", 4);
  assert.equal(
    shouldRetryFolderReconciliation(
      affectedFolderIds,
      pendingCounts,
      startedVersions,
      currentVersions,
    ),
    true,
  );
});

test("열린 화면이 없는 원본이나 대상 폴더는 별도 GET으로 확인한다", () => {
  assert.equal(needsDetachedFolderRefresh(0), true);
  assert.equal(needsDetachedFolderRefresh(1), false);
  assert.equal(needsDetachedFolderRefresh(2), false);
});

test("로컬 이동처럼 응답 ID가 바뀌어도 낙관적 항목을 중복으로 남기지 않는다", () => {
  const entries = [
    { id: "optimistic-old", name: "이동 항목" },
    { id: "confirmed-new", name: "오래된 응답" },
    { id: "other", name: "다른 항목" },
  ];
  const confirmed = { id: "confirmed-new", name: "이동 항목" };

  assert.deepEqual(
    confirmedMoveEntries(entries, "optimistic-old", confirmed),
    [{ id: "other", name: "다른 항목" }, confirmed],
  );
});

test("옮긴 폴더와 하위 폴더를 연 창을 함께 찾는다", () => {
  const windows = [
    {
      id: "moved-folder-window",
      path: [{ id: "root" }, { id: "moved-folder" }],
    },
    {
      id: "descendant-window",
      path: [
        { id: "root" },
        { id: "moved-folder" },
        { id: "child-folder" },
      ],
    },
    {
      id: "unrelated-window",
      path: [{ id: "root" }, { id: "other-folder" }],
    },
  ];

  assert.deepEqual(
    windowsContainingFolder(windows, "moved-folder").map((item) => item.id),
    ["moved-folder-window", "descendant-window"],
  );
});

test("레이아웃 저장은 폴더 식별값을 보내고 닫힌 창의 이전 요청을 무효화한다", async () => {
  const source = await readFile(
    new URL("../src/app/files/FilesView.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /folderIdentity: node\.folderIdentity/);
  assert.match(source, /signal: controller\.signal/);
  assert.match(
    source,
    /function cancelScopeRequests[\s\S]*?cancelLayoutSaves\(scopeId\);[\s\S]*?\n  }/,
  );
  assert.match(
    source,
    /if \(!isActiveSave\(key, node\) \|\| isAbortError\(error\)\) return;/,
  );
});

test("휴지통은 우측 하단 아이콘으로 열고 열린 뒤 작업 표시줄에서 복원한다", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../src/app/files/FilesView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/files/desktop.module.css", import.meta.url), "utf8"),
  ]);

  const launcherIndex = source.indexOf('data-drop-trash="true"');
  const taskbarStart = source.indexOf('<footer className={styles.taskBar}>');
  const taskbarEnd = source.indexOf("</footer>", taskbarStart);
  const launcherStyleStart = css.indexOf(".trashLauncher {");
  const launcherStyleEnd = css.indexOf("}", launcherStyleStart);
  const launcherStyle = css.slice(launcherStyleStart, launcherStyleEnd + 1);

  assert.ok(launcherIndex >= 0 && launcherIndex < taskbarStart);
  assert.doesNotMatch(source.slice(taskbarStart, taskbarEnd), /onClick=\{openTrash\}/);
  assert.match(source.slice(taskbarStart, taskbarEnd), /onClick=\{focusTrashWindow\}/);
  assert.match(source, /aria-label=\{t\("휴지통 열기"\)\}/);
  assert.match(source, /function TrashCanIcon\(\)/);
  assert.match(source, /shapeRendering="crispEdges"/);
  assert.match(source, /viewBox="0 0 32 36"/);
  assert.ok(
    (source.match(/<path /g) ?? []).length >= 10,
    "휴지통 아이콘은 뚜껑, 손잡이, 몸통과 세로 홈을 구분해 그려야 합니다.",
  );
  assert.match(launcherStyle, /position: fixed;/);
  assert.match(launcherStyle, /right: max\(18px, env\(safe-area-inset-right\)\);/);
  assert.match(launcherStyle, /bottom: 66px;/);
  assert.match(launcherStyle, /z-index: 10;/);
  assert.doesNotMatch(css, /inset: 50px 6px 72px !important/);
});

test("휴지통 목록은 행 구성을 고정하고 목록만 스크롤하며 비우기를 우측 하단에 둔다", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../src/app/files/FilesView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/files/desktop.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(
    css,
    /\.folderWindow\.trashWindow \{[\s\S]*?grid-template-rows: 32px minmax\(0, 1fr\) 26px;/,
  );
  assert.match(
    css,
    /\.trashBody \{[\s\S]*?overflow: hidden;/,
  );
  assert.match(
    css,
    /\.trashList \{[\s\S]*?min-height: 0;[\s\S]*?overflow: hidden auto;/,
  );
  assert.match(
    css,
    /\.trashRow \{[\s\S]*?display: grid;[\s\S]*?grid-template-columns: 32px minmax\(0, 1fr\) auto;/,
  );
  assert.match(
    css,
    /\.trashMeta \{[\s\S]*?overflow: hidden;[\s\S]*?text-overflow: ellipsis;[\s\S]*?white-space: nowrap;/,
  );
  assert.match(
    source,
    /className=\{`\$\{styles\.windowStatus\} \$\{styles\.trashFooter\}`\}/,
  );
  assert.match(source, /className=\{styles\.trashSummary\}/);
  assert.match(
    source,
    /className=\{styles\.trashDanger\}[\s\S]*?>\s*\{t\("비우기…"\)\}/,
  );
  assert.match(
    css,
    /\.trashFooter \{[\s\S]*?justify-content: flex-end;[\s\S]*?\.trashSummary \{[\s\S]*?margin-right: auto;/,
  );
});

test("Ctrl/Command 선택은 같은 폴더에서 항목을 더하고 다시 누르면 뺀다", () => {
  const first = selectLayoutKey(null, "desktop", "a", false);
  const second = selectLayoutKey(first, "desktop", "b", true);

  assert.deepEqual(second, {
    scopeId: "desktop",
    layoutKeys: ["a", "b"],
  });
  assert.deepEqual(selectLayoutKey(second, "desktop", "a", true), {
    scopeId: "desktop",
    layoutKeys: ["b"],
  });
  assert.deepEqual(selectLayoutKey(second, "other", "c", true), {
    scopeId: "other",
    layoutKeys: ["c"],
  });
  assert.equal(
    removeSelectedLayoutKeys(second, "desktop", ["a", "b"]),
    null,
  );
});

test("빈 영역 선택 상자는 닿은 아이콘만 고르고 Ctrl 선택은 기존 항목을 유지한다", () => {
  const candidates = [
    { layoutKey: "a", x: 10, y: 10, width: 88, height: 94 },
    { layoutKey: "b", x: 130, y: 20, width: 88, height: 94 },
    { layoutKey: "c", x: 300, y: 300, width: 88, height: 94 },
  ];

  assert.deepEqual(
    selectLayoutsInRectangle(
      null,
      "desktop",
      candidates,
      { x: 90, y: 0, width: 70, height: 80 },
      false,
    ),
    { scopeId: "desktop", layoutKeys: ["a", "b"] },
  );
  assert.deepEqual(
    selectLayoutsInRectangle(
      { scopeId: "desktop", layoutKeys: ["c"] },
      "desktop",
      candidates,
      { x: 0, y: 0, width: 20, height: 20 },
      true,
    ),
    { scopeId: "desktop", layoutKeys: ["c", "a"] },
  );
});

test("묶음 작업 알림은 일부 실패와 최종 목록 조회 실패를 구분한다", () => {
  assert.equal(
    batchMutationNotice("move", 3, 2, true),
    "2개 옮김, 1개 실패했습니다",
  );
  assert.equal(
    batchMutationNotice("trash", 2, 2, false),
    "2개 항목을 휴지통에 넣었습니다 — 새로고침해 주세요",
  );
});

test("파일 화면은 선택 묶음을 한 고스트로 끌고 작업 뒤 서버 목록을 다시 맞춘다", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../src/app/files/FilesView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/files/desktop.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(source, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(source, /event\.pointerType !== "mouse"/);
  assert.match(source, /selectLayoutsInRectangle\(/);
  assert.match(source, /data-testid=\{`selection-rectangle-\$\{scopeId\}`\}/);
  assert.match(css, /\.selectionRectangle \{/);

  assert.match(source, /count: dragEntries\.length/);
  assert.match(source, /dragGhost\.count > 1/);
  assert.match(source, /trashDraggedEntries\(scopeId, dragEntries\)/);
  assert.match(source, /moveDraggedEntries\(scopeId, dragEntries, moveTarget\.folderId\)/);
  assert.match(css, /\.dragGhostMultiple::before/);

  assert.match(source, /async function pumpBatchSave/);
  assert.match(source, /updates: chunk\.map/);
  assert.match(
    source,
    /async function moveDraggedEntries[\s\S]*?await waitForFoldersIdle\(folderIds\);[\s\S]*?await refreshFolders\(folderIds\)/,
  );
  assert.match(
    source,
    /async function trashDraggedEntries[\s\S]*?await waitForFoldersIdle\(\[sourceFolderId\]\);[\s\S]*?await refreshFolders\(\[sourceFolderId\]\)/,
  );
});

test("작업표시줄 업로드 버튼은 없고 아이콘을 휴지통에 놓으면 실제 삭제 요청을 보낸다", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../src/app/files/FilesView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/files/desktop.module.css", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(source, /className=\{styles\.quickAction\}/);
  assert.doesNotMatch(css, /\.quickAction/);
  assert.match(source, /data-drop-trash="true"/);
  assert.match(source, /element\.closest\("\[data-drop-trash\]"\)/);
  assert.match(
    source,
    /moveTarget\.kind === "trash"[\s\S]*?trashDraggedEntry\(scopeId, entry\)/,
  );
  assert.match(
    source,
    /async function trashDraggedEntry[\s\S]*?"\/api\/drive\/delete"/,
  );
  assert.match(css, /\.trashLauncher\.trashDropTarget/);
});

test("미리보기 파일은 기본으로 열고 다운로드 우선 선택은 브라우저에 저장한다", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../src/app/files/FilesView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/files/desktop.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(source, /DOWNLOAD_FIRST_STORAGE_KEY = "sharedesk\.download-first"/);
  assert.equal(
    fileActivationAction(
      { isFolder: false, name: "사진.png", mimeType: "image/png" },
      false,
    ),
    "preview",
  );
  assert.equal(
    downloadFileName({
      name: "회의 기록",
      mimeType: "application/vnd.google-apps.document",
    }),
    "회의 기록.pdf",
  );
  assert.equal(
    downloadFileName({
      name: "이미.pdf",
      mimeType: "application/vnd.google-apps.document",
    }),
    "이미.pdf",
  );
  assert.equal(
    downloadFileName({ name: "보고서.pdf", mimeType: "application/pdf" }),
    "보고서.pdf",
  );
  assert.equal(
    fileActivationAction(
      { isFolder: false, name: "영상.mp4", mimeType: "video/mp4" },
      true,
    ),
    "download",
  );
  assert.equal(
    fileActivationAction(
      {
        isFolder: false,
        name: "문서",
        mimeType: "application/vnd.google-apps.document",
      },
      false,
    ),
    "preview",
  );
  assert.equal(
    fileActivationAction(
      { isFolder: false, name: "압축.zip", mimeType: "application/zip" },
      false,
    ),
    "download",
  );
  assert.match(source, /fileActivationAction\(entry, downloadFirst\)/);
  assert.match(
    source,
    /function openSearchResult\([\s\S]*?respectDownloadPreference = true[\s\S]*?fileActivationAction\([\s\S]*?result\.entry,[\s\S]*?respectDownloadPreference && downloadFirst[\s\S]*?action === "preview"[\s\S]*?openPreview\([\s\S]*?result\.entry,[\s\S]*?opener \? \{ element: opener, scopeId: ROOT_SCOPE \} : undefined/,
  );
  assert.match(source, /localStorage\.setItem\([\s\S]*?DOWNLOAD_FIRST_STORAGE_KEY/);
  assert.match(source, />\{t\("다운로드 우선"\)\}</);
  assert.match(source, /checked=\{downloadFirst\}/);
  assert.match(source, /ShareDesk에서 열기/);
  assert.match(
    source,
    /function entryOpenLabel[\s\S]*?isEditableTextEntry\(entry\)[\s\S]*?메모장으로 편집/,
  );
  assert.match(
    source,
    /function canOpenPreviewInNewTab[\s\S]*?!isEditableTextEntry\(entry\)/,
  );
  assert.match(
    source,
    /function openPreviewInNewTab\(entry: Entry, opener\?: HTMLElement\)[\s\S]*?window\.open\(previewUrl\(entry\), "_blank", "noopener,noreferrer"\)[\s\S]*?setContextMenu\(null\)[\s\S]*?opener\?\.focus\(\)/,
  );
  assert.match(
    source,
    /canOpenPreviewInNewTab\(contextMenu\.searchResult\.entry\)[\s\S]*?openPreviewInNewTab\([\s\S]*?contextMenu\.searchResult!\.entry/,
  );
  assert.match(
    source,
    /canOpenPreviewInNewTab\(contextMenu\.entry\)[\s\S]*?openPreviewInNewTab\([\s\S]*?contextMenu\.entry!/,
  );
  assert.match(
    source,
    /function searchContextMenuHeight[\s\S]*?canOpenPreviewInNewTab\(entry\) \? 183 : 148/,
  );
  assert.match(
    source,
    /\/api\/drive\/rename[\s\S]*?expectedVersion: dialog\.entry\.version/,
  );
  assert.match(
    source,
    /current\.searchResult[\s\S]*?searchContextMenuHeight\(current\.searchResult\.entry, allowEdit\)/,
  );
  assert.match(
    source,
    /fileActivationAction\(entry, false\)[\s\S]*?action === "preview"[\s\S]*?openPreviewInScope\([\s\S]*?entry,[\s\S]*?contextMenu\.scopeId,[\s\S]*?contextMenu\.opener \?\? undefined/,
  );
  assert.match(css, /\.downloadPreference\s*\{/);
  assert.match(css, /input:checked \+ \.preferenceCheck::after/);
});

test("이미지와 GIF 미리보기는 창의 본문을 채우고 최초 창은 작업 영역 안에 연다", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../src/app/files/FilesView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/files/desktop.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(
    css,
    /\.previewImage,\s*\.previewMedia \{[\s\S]*?width: 100%;[\s\S]*?height: 100%;[\s\S]*?object-fit: contain;/,
  );
  assert.match(
    css,
    /\.folderWindow\.previewWindow \{[\s\S]*?grid-template-rows: 30px minmax\(0, 1fr\) 22px;/,
  );
  assert.match(
    source,
    /const previewWidth = Math\.min\([\s\S]*?const previewHeight = Math\.min\(/,
  );
  assert.match(
    source,
    /x: clamp\([\s\S]*?logicalViewport\.width - previewWidth[\s\S]*?y: clamp\([\s\S]*?logicalViewport\.height - TASK_BAR - previewHeight/,
  );
});

test("열린 폴더는 이미지와 GIF를 우측에서 보고 방향키로 넘긴다", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../src/app/files/FilesView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/files/desktop.module.css", import.meta.url), "utf8"),
  ]);
  const scopedPreview = source.slice(
    source.indexOf("function openPreviewInScope"),
    source.indexOf("function activateEntry"),
  );

  assert.match(source, /sidePreviewLayoutKey: string \| null/);
  assert.match(source, /folderImagePreviewEntries\(item\.data\.entries\)/);
  assert.match(source, /data-folder-side-preview=\{item\.id\}/);
  assert.match(source, /event\.key === "ArrowLeft" \|\| event\.key === "ArrowRight"/);
  assert.match(source, /adjacentFolderImagePreviewKey\(/);
  assert.match(source, /aria-label=\{t\("폴더 미리보기 닫기"\)\}/);
  assert.match(
    source,
    /const sidePreviewOpened = syncFolderSidePreview\([\s\S]*?if \(sidePreviewOpened\) focusFolderSidePreview\(scopeId\);[\s\S]*?else event\.currentTarget\.focus\(\);/,
  );
  assert.match(
    scopedPreview,
    /if \(showFolderSidePreview\([\s\S]*?\)\) return;[\s\S]*?openPreview\(/,
  );
  assert.doesNotMatch(scopedPreview, /confirmPreviewDiscard/);
  assert.match(
    css,
    /\.windowBodyWithPreview \.windowCanvas \{[\s\S]*?right: clamp\(180px, 42%, 360px\);/,
  );
  assert.match(
    css,
    /\.folderSidePreviewBody img \{[\s\S]*?width: 100%;[\s\S]*?height: 100%;[\s\S]*?object-fit: contain;/,
  );
});

test("폴더 우측 미리보기가 아이콘 평면에 고정 최소폭을 남기지 않는다", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../src/app/files/FilesView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/files/desktop.module.css", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(source, /PLANE_MIN_WIDTH/);
  assert.match(source, /function planeDimensions[\s\S]*?let width = 0;/);
  assert.match(css, /\.iconPlane \{[\s\S]*?min-width: 100%;/);
});

test("새 메모장은 서버가 배정한 항목과 좌표를 같은 폴더 화면에 함께 반영한다", async () => {
  const source = await readFile(
    new URL("../src/app/files/FilesView.tsx", import.meta.url),
    "utf8",
  );
  const mergeStart = source.indexOf("function mergeFreshFolderData");
  const mergeEnd = source.indexOf(
    "async function refreshDetachedFolder",
    mergeStart,
  );
  const createStart = source.indexOf("async function createNotepad");
  const createEnd = source.indexOf("async function submitDialog", createStart);
  const mergeFresh = source.slice(mergeStart, mergeEnd);
  const createNotepad = source.slice(createStart, createEnd);

  assert.ok(mergeStart >= 0 && mergeEnd > mergeStart);
  assert.ok(createStart >= 0 && createEnd > createStart);
  assert.match(
    mergeFresh,
    /setRootData\([\s\S]*?mergeFolderData\(current, fresh\)/,
  );
  assert.match(
    mergeFresh,
    /item\.path\.at\(-1\)\?\.id === folderId[\s\S]*?mergeFolderData\(item\.data, fresh\)/,
  );
  assert.match(
    createNotepad,
    /const request = beginScopedRequest\(listRequestsRef\.current, scopeId\)[\s\S]*?const mutationVersion = folderMutationVersionsRef\.current\.get\(folderId\)[\s\S]*?const fresh = await fetchFolder\(folderId, request\.controller\.signal\)/,
  );
  assert.match(
    createNotepad,
    /const staleResult =[\s\S]*?listRequestsRef\.current\.get\(scopeId\) !== request[\s\S]*?pendingFolderMutationsRef\.current\.get\(folderId\)[\s\S]*?folderMutationVersionsRef\.current\.get\(folderId\)[\s\S]*?currentFolderId !== folderId/,
  );
  const staleGuard = createNotepad.indexOf("if (staleResult)");
  const mergeFreshCall = createNotepad.indexOf(
    "mergeFreshFolderData(folderId, fresh)",
  );
  const openFresh = createNotepad.indexOf("openPreview(entry)");
  assert.ok(staleGuard >= 0);
  assert.ok(mergeFreshCall > staleGuard);
  assert.ok(openFresh > mergeFreshCall);
  assert.match(
    createNotepad.slice(staleGuard, mergeFreshCall),
    /foldersNeedingRefreshRef\.current\.add\(folderId\)[\s\S]*?return;/,
  );
  assert.match(
    createNotepad,
    /finally \{[\s\S]*?finishScopedRequest\(listRequestsRef\.current, scopeId, request\)/,
  );
  assert.doesNotMatch(createNotepad, /upsertFolderEntry\(/);
});

test("the root desktop plane owns arrow navigation before an icon has focus", async () => {
  const source = await readFile(
    new URL("../src/app/files/FilesView.tsx", import.meta.url),
    "utf8",
  );
  const canvas = source.slice(
    source.indexOf("function renderCanvas"),
    source.indexOf("\n  return (\n    <main"),
  );
  const sharedArrowHandler = source.slice(
    source.indexOf("function moveSelectionWithKeyboard"),
    source.indexOf("function planeDimensions"),
  );

  assert.match(
    source,
    /document\.activeElement === document\.body[\s\S]*?rootCanvasRef\.current\?\.focus\(\{ preventScroll: true \}\)/,
  );
  assert.match(canvas, /tabIndex=\{isRoot \? 0 : -1\}/);
  assert.match(canvas, /data-keyboard-canvas=\{isRoot \? "root" : undefined\}/);
  assert.match(canvas, /role=\{isRoot \? "group" : undefined\}/);
  assert.match(
    canvas,
    /aria-label=\{isRoot \? t\("공유 바탕화면 아이콘"\) : undefined\}/,
  );
  assert.match(
    canvas,
    /onKeyDown=\{\(event\) => \{[\s\S]*?moveRootPlaneSelectionWithKeyboard\(event, data\.entries\)/,
  );
  assert.match(
    source,
    /if \(scopeId === ROOT_SCOPE\) plane\.focus\(\{ preventScroll: true \}\)/,
  );
  assert.match(
    sharedArrowHandler,
    /event\.target !== event\.currentTarget[\s\S]*?moveSelectionWithKeyboard\(event, ROOT_SCOPE, entries\)/,
  );
  assert.match(sharedArrowHandler, /event\.stopPropagation\(\)/);
  assert.match(
    sharedArrowHandler,
    /shouldIgnoreDesktopSelectionKeydown\(event\.target\)/,
  );
});

test("업로드 세션 생성이 실패해도 전송 표시를 정리한다", async () => {
  const source = await readFile(
    new URL("../src/app/files/FilesView.tsx", import.meta.url),
    "utf8",
  );
  const uploadStart = source.indexOf("async function uploadOne");
  const uploadEnd = source.indexOf("async function uploadFiles", uploadStart);
  const uploadOne = source.slice(uploadStart, uploadEnd);

  assert.ok(uploadStart >= 0 && uploadEnd > uploadStart);
  assert.match(
    uploadOne,
    /updateTransfer\(0, file\.size\);\s*try \{[\s\S]*?await apiJson<UploadSession>\(apiPath\("\/api\/drive\/upload-session"\)[\s\S]*?finally \{\s*reportTransferProgress\(null, transferId\);/,
  );
});

test("책상과 열린 폴더 검색은 가상 결과 창을 쓰고 폴더 올리기 버튼은 제거한다", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../src/app/files/FilesView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/files/desktop.module.css", import.meta.url), "utf8"),
  ]);

  const taskbarStart = source.indexOf('<footer className={styles.taskBar}>');
  const taskbarEnd = source.indexOf("</footer>", taskbarStart);
  const taskbar = source.slice(taskbarStart, taskbarEnd);
  const searchIndex = taskbar.indexOf("className={styles.desktopSearch}");
  assert.ok(searchIndex >= 0);
  assert.match(taskbar, /placeholder=\{t\("전체 파일 검색"\)\}/);
  // 배경 선택은 관리자 설정으로 옮겼다 — 작업표시줄에 책상 설정 버튼을 두지 않는다.
  assert.doesNotMatch(taskbar, /책상 설정|styles\.deskButton/);

  assert.match(source, /className={styles\.folderSearch}/);
  assert.match(source, /placeholder=\{t\("이 폴더 검색"\)\}/);
  assert.match(source, /\/api\/drive\/search\?\$\{params\}/);
  assert.match(source, /signal: controller\.signal/);
  assert.match(source, /searchInstanceRef\.current !== instanceId/);
  assert.match(source, /가상 검색결과/);
  assert.match(source, /result\.path/);
  assert.match(
    source,
    /onDoubleClick=\{\(event\) =>[\s\S]*?openSearchResult\(result, event\.currentTarget\)/,
  );
  assert.match(
    source,
    /event\.key === "Enter"[\s\S]*?openSearchResult\(result, event\.currentTarget\)/,
  );
  assert.match(
    source,
    /onClick=\{\(event\) =>[\s\S]*?openSearchResult\(result, event\.currentTarget\)/,
  );
  assert.match(
    source,
    /openSearchResult\([\s\S]*?contextMenu\.searchResult!,[\s\S]*?contextMenu\.opener \?\? undefined,[\s\S]*?false/,
  );
  assert.match(source, /openOriginalLocation\(result\)/);
  assert.match(source, /원래 위치 열기/);
  assert.match(source, /searchWindow\.truncated/);

  const folderToolbarStart = source.indexOf(
    '<div className={styles.windowToolbar}>',
  );
  const folderToolbarEnd = source.indexOf(
    '<div className={styles.windowBody}>',
    folderToolbarStart,
  );
  const folderToolbar = source.slice(folderToolbarStart, folderToolbarEnd);
  assert.doesNotMatch(folderToolbar, /↑ 올리기/);
  assert.doesNotMatch(folderToolbar, /requestUpload\(item\.id\)/);
  assert.match(source, /void uploadFiles\(event\.dataTransfer\.files, scopeId\)/);
  assert.match(source, /MenuButton onClick=\{\(\) => requestUpload\(contextMenu\.scopeId\)\}/);

  assert.match(css, /\.desktopSearch \{/);
  assert.match(css, /\.desktopSearch \{[\s\S]*?flex: 0 1 250px;[\s\S]*?overflow: hidden;/);
  assert.match(css, /\.windowTasks \{[\s\S]*?min-width: 0;[\s\S]*?overflow: auto hidden;/);
  assert.match(css, /\.folderSearch \{/);
  assert.match(css, /\.searchWindow \{/);
  assert.match(css, /\.searchResults \{/);
  assert.match(css, /\.searchResultPath \{/);
});

test("관리자 업데이트는 새 버전만 별로 알리고 내부 확인 뒤 수동으로 시작한다", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../src/app/files/FilesView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/files/desktop.module.css", import.meta.url), "utf8"),
  ]);

  // 새 버전 알림은 좌상단 로고 옆 배지 하나 — 트레이에는 업데이트 버튼이
  // 없다(#14). 배지는 새 버전이 있을 때만 뜨고, 누르면 업데이트 창이 열린다.
  const brandStart = source.indexOf("{styles.brand}");
  const brandEnd = source.indexOf("</div>", brandStart);
  const brand = source.slice(brandStart, brandEnd);
  assert.ok(brandStart >= 0 && brandEnd > brandStart);
  assert.match(brand, /isAdmin && updateAvailable && \(/);
  assert.match(brand, /styles\.brandUpdate/);
  assert.match(brand, /aria-haspopup="dialog"/);
  assert.match(brand, /openUpdatePanel\(event\.currentTarget\)/);
  assert.match(brand, /updateStatus\?\.latestVersion[\s\S]*?★/);
  assert.doesNotMatch(brand, /href=|window\.open/);
  assert.doesNotMatch(source, /updateTrayButton/);
  assert.match(css, /\.brandUpdate \{/);
  assert.match(
    source,
    /const updateAvailable = Boolean\(updateStatus\?\.updateAvailable\)/,
  );

  assert.match(
    source,
    /apiJson<UpdateStatusResponse>\(apiPath\("\/api\/admin\/update"\), \{[\s\S]*?method: "GET",[\s\S]*?cache: "no-store",[\s\S]*?signal: controller\.signal/,
  );
  assert.match(source, /updateControllerRef\.current\?\.abort\(\)/);
  assert.match(source, /updateRequestIdRef\.current !== requestId/);
  assert.match(source, /if \(!isAdmin\) return;/);
  // 상태 자동 확인은 자동 업데이트 여부와 무관하다 — 배지가 항상 알린다.
  assert.match(
    source,
    /if \(!isAdmin\) return;[\s\S]*?fetch\(apiPath\("\/api\/admin\/update"\), \{[\s\S]*?cache: "no-store"/,
  );
  assert.match(
    source,
    /function openUpdatePanel[\s\S]*?setContextMenu\(null\);\s*void loadUpdateStatus\(\);/,
  );
  assert.doesNotMatch(source, /if \(updateStatus\) \{\s*setUpdatePanel/);
  assert.match(
    source,
    /response\.status === 403[\s\S]*?setUpdateStatus\(null\);[\s\S]*?router\.refresh\(\)/,
  );
  assert.match(
    source,
    /catch \(error\) \{[\s\S]*?setUpdateStatus\(null\);[\s\S]*?loadError: errorMessage/,
  );

  assert.match(
    source,
    /role="dialog"[\s\S]*?aria-modal="true"[\s\S]*?aria-labelledby="update-dialog-title"[\s\S]*?aria-describedby="update-dialog-description"/,
  );
  assert.match(source, /event\.key === "Escape"[\s\S]*?closeUpdatePanel\(\)/);
  assert.match(
    source,
    /event\.target === event\.currentTarget[\s\S]*?closeUpdatePanel\(\)/,
  );
  assert.match(source, /현재 버전[\s\S]*?currentVersion/);
  assert.match(source, /최신 버전[\s\S]*?latestVersion/);
  assert.match(source, /최신 버전을 사용하고 있습니다/);
  // 새 버전 확인 실패는 오류가 아니라 조용한 "새 버전 없음"으로 표시한다.
  assert.doesNotMatch(source, /"확인 실패"/);
  assert.doesNotMatch(source, /"버전 비교 실패"/);
  assert.doesNotMatch(source, /최신 버전을 확인하지 못했습니다/);
  assert.match(
    source,
    /\{updatePanel\.status\.latestVersion \?\?\s*updatePanel\.status\.currentVersion\}/,
  );
  assert.match(
    source,
    /updatePanel\.status\.error &&\s*updatePanel\.status\.latestVersion !== null && \(/,
  );
  assert.match(source, /설치 저장소를 연결해 주세요/);
  assert.match(source, /status\.error/);
  assert.match(
    source,
    /status\.configured &&[\s\S]*?status\.updateAvailable &&[\s\S]*?status\.workflowUrl && \([\s\S]*?자동으로 적용되지는 않습니다[\s\S]*?GitHub[\s\S]*?Run workflow/,
  );
  assert.match(
    source,
    /\{updatePanel\.status\.canDispatch &&\s*updatePanel\.status\.updateAvailable &&\s*!updateRun && \(\s*<button[\s\S]*?onClick=\{\(event\) => requestUpdate\(event\.currentTarget\)\}\s*>\s*\{t\("업데이트 하기"\)\}/,
  );
  assert.match(
    source,
    /\{!updatePanel\.status\.canDispatch &&\s*updatePanel\.status\.configured &&\s*updatePanel\.status\.updateAvailable &&\s*updatePanel\.status\.workflowUrl && \(\s*<button[\s\S]*?window\.open\([\s\S]*?"_blank",[\s\S]*?"noopener,noreferrer"[\s\S]*?>\s*\{t\("업데이트 하기"\)\}/,
  );
  assert.match(
    source,
    /updateRunActive && updateRun && \(\s*<p className=\{styles\.updateProgress\} role="status">/,
  );
  assert.match(
    source,
    /updateRun\?\.phase === "done"[\s\S]*?새로고침하면 새 버전이/,
  );
  assert.match(
    source,
    /updateRun\?\.phase === "failed"[\s\S]*?role="alert"/,
  );
  assert.match(
    source,
    /docUrl\("UPDATE", locale\)/,
  );
  assert.doesNotMatch(source, /href="\/docs"/);

  assert.match(css, /\.updateTrayButton \{/);
  assert.match(css, /\.updateStar \{[\s\S]*?color: #ffd27d;/);
  assert.match(css, /\.updateDialog \{/);
  assert.match(css, /\.updateDialogBody \{/);
  assert.match(css, /\.updateVersions \{/);
  assert.match(css, /\.updateSetup \{/);
  assert.match(css, /\.updateInstruction \{/);
  assert.match(css, /\.updateError \{/);
  // 업데이트는 GitHub 별 동의를 거쳐야 시작한다(#97).
  assert.match(source, /function requestUpdate\(/);
  assert.match(source, /status\.starred !== true/);
  assert.match(source, /startUpdate\(true\)/);
  assert.match(source, /body: JSON\.stringify\(\{ star: /);
  assert.match(css, /\.updateProgress \{/);
});

test("desktop and folder icons keep keyboard focus and range selection wired", async () => {
  const source = await readFile(
    new URL("../src/app/files/FilesView.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /keyboardSelectableIcons\(/);
  assert.match(source, /moveDesktopKeyboardSelection\(/);
  assert.match(source, /extend: event\.shiftKey/);
  assert.match(source, /preserveSelection: toggleModifier && !event\.shiftKey/);
  assert.match(source, /toggleDesktopSelectionKey\(/);
  assert.match(source, /findEntryButton\(scopeId, nextEntry\.id\)\?\.focus\(\)/);
  assert.match(source, /shouldIgnoreDesktopSelectionKeydown\(event\.target\)/);
  assert.match(source, /keyboardSelectionRef\.current = null/);
});

test("승인된 Google 사용자는 파일 화면에서 세션 발신자로 피드백을 보낸다", async () => {
  const [source, page, css] = await Promise.all([
    readFile(new URL("../src/app/files/FilesView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/files/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/files/desktop.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /userEmail=\{session\.email\}/);
  assert.match(page, /import \{ isOwnerRegistryConfigured \} from "@\/lib\/owner-registry"/);
  assert.match(
    page,
    /canSendFeedback=\{!session\.isGuest && isOwnerRegistryConfigured\(\)\}/,
  );
  assert.match(
    source,
    /userEmail: string;[\s\S]*?canSendFeedback: boolean;/,
  );

  const trayStart = source.indexOf('<div className={styles.userTray}>');
  const trayEnd = source.indexOf("</div>", trayStart);
  const userTray = source.slice(trayStart, trayEnd);
  const feedbackButtonIndex = userTray.indexOf("{canSendFeedback && (");
  const adminControlsIndex = userTray.indexOf("{isAdmin && !isSpace && (");

  assert.ok(trayStart >= 0 && trayEnd > trayStart);
  assert.ok(
    feedbackButtonIndex >= 0 && feedbackButtonIndex < adminControlsIndex,
    "일반 승인 사용자와 관리자에게 공통인 피드백 버튼이어야 한다",
  );
  assert.match(
    userTray,
    /\{canSendFeedback && \([\s\S]*?aria-label=\{t\("운영자에게 피드백 보내기"\)\}[\s\S]*?aria-haspopup="dialog"[\s\S]*?className=\{styles\.feedbackMailIcon\}/,
  );

  const feedbackDialogStart = source.indexOf(
    "{canSendFeedback && feedbackOpen && (",
  );
  const feedbackDialogEnd = source.indexOf("{dialog && (", feedbackDialogStart);
  const feedbackDialog = source.slice(feedbackDialogStart, feedbackDialogEnd);

  assert.ok(feedbackDialogStart >= 0 && feedbackDialogEnd > feedbackDialogStart);
  assert.match(feedbackDialog, /role="dialog"/);
  assert.match(feedbackDialog, /aria-modal="true"/);
  assert.match(
    feedbackDialog,
    /<strong aria-label=\{t\("보낸 사람 이메일"\)\}>\{userEmail\}<\/strong>/,
  );
  assert.match(feedbackDialog, /maxLength=\{120\}/);
  assert.match(feedbackDialog, /maxLength=\{4_000\}/);
  assert.doesNotMatch(feedbackDialog, /name=["'](?:sender|from|to)["']/i);
  assert.match(
    feedbackDialog,
    /event\.target === event\.currentTarget && !feedbackBusy[\s\S]*?closeFeedbackDialog\(\)/,
  );
  assert.match(
    feedbackDialog,
    /aria-label=\{t\("피드백 닫기"\)\}\s*disabled=\{feedbackBusy\}\s*onClick=\{closeFeedbackDialog\}/,
  );
  assert.equal(feedbackDialog.match(/disabled=\{feedbackBusy\}/g)?.length, 4);
  assert.match(feedbackDialog, /onKeyDown=\{handleFeedbackDialogKeyDown\}/);

  const submitStart = source.indexOf("async function submitFeedback");
  const submitEnd = source.indexOf("async function submitDialog", submitStart);
  const submitFeedback = source.slice(submitStart, submitEnd);
  const failureStart = submitFeedback.indexOf("} catch (error)");
  const failureEnd = submitFeedback.indexOf("} finally", failureStart);
  const failureBranch = submitFeedback.slice(failureStart, failureEnd);

  assert.ok(submitStart >= 0 && submitEnd > submitStart);
  assert.match(
    submitFeedback,
    /apiJson<\{ ok\?: boolean \}>\(apiPath\("\/api\/feedback"\), \{[\s\S]*?method: "POST"/,
  );
  assert.match(
    submitFeedback,
    /feedbackRequestIdRef\.current \?\? window\.crypto\.randomUUID\(\)[\s\S]*?body: JSON\.stringify\(\{\s*feedbackId,\s*subject: feedbackDraft\.subject,\s*message: feedbackDraft\.message,\s*\}\)/,
  );
  assert.doesNotMatch(submitFeedback, /\b(?:sender|from|to):/i);
  assert.match(
    submitFeedback,
    /feedbackRequestIdRef\.current === feedbackId[\s\S]*?current\.subject === submittedDraft\.subject[\s\S]*?current\.message === submittedDraft\.message[\s\S]*?setFeedbackOpen\(false\);[\s\S]*?setNotice\(t\("피드백을 보냈습니다"\)\)/,
  );
  assert.match(failureBranch, /setFeedbackError\(/);
  assert.doesNotMatch(failureBranch, /setFeedbackDraft|setFeedbackOpen\(false\)/);
  assert.match(
    feedbackDialog,
    /onChange=\{\(event\) => \{\s*feedbackRequestIdRef\.current = null;\s*setFeedbackError\(null\);/,
  );

  assert.match(
    source,
    /if \(!feedbackOpen\) return;[\s\S]*?data-feedback-initial-focus[\s\S]*?const opener = feedbackDialogOpenerRef\.current;[\s\S]*?if \(opener\?\.isConnected\) opener\.focus\(\);/,
  );
  assert.match(
    source,
    /function handleFeedbackDialogKeyDown[\s\S]*?event\.key === "Escape"[\s\S]*?closeFeedbackDialog\(\)[\s\S]*?DIALOG_FOCUSABLE_SELECTOR/,
  );
  assert.match(
    source,
    /function closeFeedbackDialog\(\) \{\s*if \(feedbackBusy\) return;\s*setFeedbackOpen\(false\);\s*\}/,
  );
  assert.match(css, /\.feedbackTrayButton \{/);
  assert.match(css, /\.feedbackMailIcon \{/);
  assert.match(css, /\.feedbackError \{/);
  assert.match(css, /\.feedbackMessage \{[\s\S]*?resize: none;/);
});

test("역할 권한(#80): 업로드·수정 UI는 allowUpload/allowEdit로 숨기고 동작도 함께 차단한다", async () => {
  const [source, page] = await Promise.all([
    readFile(new URL("../src/app/files/FilesView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/files/page.tsx", import.meta.url), "utf8"),
  ]);

  // 계약: 세션 역할을 prop으로 받아 두 게이트를 파생한다.
  assert.match(page, /role=\{session\.role\}/);
  assert.match(
    source,
    /import \{ canEdit, canUpload, type SessionRole \} from "@\/lib\/roles"/,
  );
  assert.match(source, /role: SessionRole;/);
  assert.match(source, /const allowUpload = canUpload\(role\);/);
  assert.match(source, /const allowEdit = canEdit\(role\);/);

  // allowUpload=false — 만들기·올리기 UI를 렌더하지 않고 함수도 앞에서 끊는다.
  assert.match(
    source,
    /\{allowUpload && \(\s*<>\s*<MenuButton[\s\S]*?새 폴더[\s\S]*?새 메모장[\s\S]*?파일 업로드…[\s\S]*?<\/>\s*\)\}/,
  );
  assert.match(source, /\{allowUpload && \(\s*<input\s*ref=\{fileInputRef\}/);
  assert.match(source, /\{allowUpload && \(\s*<button[\s\S]{0,600}?\+ 폴더/);
  assert.match(
    source,
    /function requestUpload\(scopeId: string\) \{\s*if \(!allowUpload\) return;/,
  );
  assert.match(
    source,
    /async function uploadFiles\(files: FileList \| File\[\], scopeId: string\) \{\s*if \(!allowUpload\) return;/,
  );
  // 새 메모장은 만들자마자 내용 저장이 필요하므로 편집 권한 기준이다.
  assert.match(
    source,
    /async function createNotepad\(scopeId: string\) \{[\s\S]{0,220}?if \(!allowEdit\) return;/,
  );
  assert.match(
    source,
    /\{allowEdit && \(\s*<MenuButton\s*onClick=\{\(\) => void createNotepad\(contextMenu\.scopeId\)\}/,
  );
  // 외부 파일 드래그 업로드(드롭존 표시 포함) 차단
  assert.match(source, /onDragOver=\{\(event\) => \{\s*if \(!allowUpload\) return;/);
  // 폴더 드롭도 같은 가드를 지난다 — 권한·로딩 먼저, 그 다음 내용물 확인.
  assert.match(
    source,
    /if \(!allowUpload \|\| data\.loading\) return;[\s\S]{0,220}?if \(!directoryRoots && !event\.dataTransfer\.files\.length\) return;/,
  );
  assert.match(source, /if \(!allowUpload\) return;\s*setNotice\(t\("폴더를 읽는 중입니다"\)\);/);
  // 아이콘 배치 드래그는 시작 자체를 차단하고, 자동 배치 보정 저장도 건너뛴다.
  assert.match(
    source,
    /if \(event\.button !== 0\) return;[\s\S]{0,140}?if \(!allowUpload\) return;/,
  );
  assert.match(source, /if \(!allowUpload\) return;\s*if \(\s*rootData\.loading/);

  // allowEdit=false — 이름 바꾸기·삭제·이동·휴지통 조작·저장을 렌더하지 않고 차단한다.
  assert.match(source, /\{allowEdit && <div className=\{styles\.menuSeparator\} \/>\}/);
  assert.match(
    source,
    /\{allowEdit && scopeParentFolderId\(contextMenu\.scopeId\) && \(/,
  );
  assert.match(
    source,
    /\{allowEdit && \(\s*<MenuButton\s*onClick=\{\(\) => \{\s*openDialog\(\s*\{\s*kind: "rename",/,
  );
  assert.match(
    source,
    /\{allowEdit && \(\s*<MenuButton\s*danger\s*onClick=\{\(\) => \{\s*openDialog\(\s*\{\s*kind: "delete",/,
  );
  assert.match(
    source,
    /if \(nextDialog\.kind === "create" \? !allowUpload : !allowEdit\) return;/,
  );
  assert.match(
    source,
    /if \(dialog\.kind === "create" \? !allowUpload : !allowEdit\) return;/,
  );
  assert.match(source, /allowEdit && event\.key === "F2"/);
  assert.match(source, /allowEdit && event\.key === "Delete"/);
  assert.match(source, /moveTarget = allowEdit\s*\? findMoveTarget\(/);
  assert.match(
    source,
    /async function moveEntry\([\s\S]{0,200}?\) \{\s*if \(!allowEdit\) return false;/,
  );
  assert.match(
    source,
    /async function trashDraggedEntry\([\s\S]{0,140}?\) \{\s*if \(!allowEdit\) return false;/,
  );
  assert.match(
    source,
    /async function trashAction\([\s\S]{0,160}?\) \{\s*if \(!allowEdit\) return;/,
  );
  assert.match(source, /\{allowEdit && trashWindow\.confirmId === entry\.id \? \(/);
  assert.match(source, /\) : allowEdit \? \(/);
  assert.match(source, /\{allowEdit &&\s*trashWindow\.entries\.length > 0/);
  assert.match(
    source,
    /async function saveFolderNote\(\) \{\s*if \(!allowEdit\) return;/,
  );

  // 읽기 전용 표시 — 메모장은 기존 사유 메커니즘 재사용, 폴더 메모는 배너+readOnly.
  assert.match(
    source,
    /function previewTextReadOnlyReason\(\s*preview: PreviewWindowState,\s*allowEdit: boolean,\s*\) \{\s*if \(!allowEdit\) return ROLE_READONLY_REASON;/,
  );
  assert.match(source, /previewTextReadOnlyReason\(previewWindow, allowEdit\)/);
  assert.match(source, /previewTextReadOnlyReason\(preview, allowEdit\)/);
  assert.match(source, /readOnly=\{!allowEdit\}/);
  assert.match(source, /\{t\(ROLE_READONLY_REASON\)\}/);

  // Google Drive 공유는 기존 관리자 게이트를 그대로 둔다.
  assert.match(
    source,
    /\{isAdmin && \(\s*<MenuButton\s*onClick=\{\(\) => openShareDialog\(contextMenu\.entry!\)\}/,
  );
  // 배경 선택 UI는 관리자 설정으로 옮겼다 — 파일 화면에는 적용만 남는다.
  assert.doesNotMatch(source, /function selectWallpaper\(/);
  assert.doesNotMatch(source, /배경 — \{name\}/);
  assert.match(source, /WALLPAPERS\.find\(\(w\) => w\.id === wallpaperId\)/);
});

test("자동 업데이트가 켜지면 수동 업데이트 버튼이 숨고 설정이 내용을 대신 보여 준다", async () => {
  const [filesView, filesPage, adminView] = await Promise.all([
    readFile(new URL("../src/app/files/FilesView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/files/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/admin/AdminView.tsx", import.meta.url), "utf8"),
  ]);
  // 새 버전 알림(로고 배지)·상태 확인은 자동 업데이트 여부와 무관하다(#14).
  // 자동 업데이트 중에도 배지를 눌러 즉시 업데이트할 수 있다.
  assert.match(filesView, /isAdmin && updateAvailable && \(/);
  assert.doesNotMatch(filesView, /if \(!isAdmin \|\| autoUpdate\) return;/);
  assert.match(filesPage, /autoUpdate=\{deskSettings\.autoUpdate\}/);
  // 자동 업데이트는 관리자 설정의 버튼이다: 누르면 별이 남고 켜지며,
  // 멈추면 원상복구된다. 업데이트 창에는 자동 업데이트 UI가 없다.
  assert.doesNotMatch(filesView, /★ 누르고 자동 업데이트/);
  // 수동 업데이트의 별 동의 창은 그대로다("확인된 별"만 통과).
  assert.match(filesView, /status\.starred !== true/);
  assert.match(adminView, /star: true/);
  // 별을 누르고 돌아오면 알아서 켜진다 — 몇 초 간격의 자동 감지.
  assert.match(adminView, /scheduleStarPoll/);
  assert.match(adminView, /별 확인 중…/);
  assert.match(adminView, /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/);
  assert.match(adminView, /자동 업데이트 멈추기/);
  assert.doesNotMatch(adminView, /type="checkbox"[\s\S]{0,200}autoUpdate: true/);
  assert.match(adminView, /releases\/latest/);
  assert.match(adminView, /releaseNotes/);
});

test("동시 다운로드 큐(#103)는 3개까지만 동시에 받고 나머지를 대기시킨다", () => {
  const items = ["a", "b", "c", "d", "e"].map((id, index) =>
    newDownloadItem(id, `entry-${index}`, `${id}.txt`, `${id}.txt`),
  );
  assert.equal(DOWNLOAD_CONCURRENCY, 3);
  const firstStarts = nextDownloadStarts(items);
  assert.deepEqual(firstStarts, ["a", "b", "c"]);
  const running = startDownloads(items, firstStarts);
  assert.equal(runningDownloadCount(running), 3);
  // 캡이 찼으면 대기 항목이 있어도 새로 띄우지 않는다.
  assert.deepEqual(nextDownloadStarts(running), []);
  // 하나가 끝나야 대기 항목이 한 칸 올라온다.
  const oneDone = patchDownloadItem(running, "b", {
    status: "done",
    transferred: 10,
    total: 10,
  });
  assert.deepEqual(nextDownloadStarts(oneDone), ["d"]);

  // 진행률은 Content-Length가 있을 때만 숫자가 되고, 없으면 불확정(null)이다.
  const partial = patchDownloadItem(oneDone, "a", {
    transferred: 25,
    total: 100,
  });
  assert.equal(downloadPercent(partial.find((item) => item.id === "a")!), 25);
  const unknown = patchDownloadItem(partial, "c", {
    transferred: 25,
    total: null,
  });
  assert.equal(downloadPercent(unknown.find((item) => item.id === "c")!), null);
  assert.equal(parseContentLength("2048"), 2048);
  assert.equal(parseContentLength("2 048"), null);
  assert.equal(parseContentLength(null), null);

  // 실패 → 다시 시도는 대기로 되돌려 캡 안에서 다시 뜨게 한다.
  const failed = patchDownloadItem(unknown, "e", {
    status: "failed",
    error: "다운로드에 실패했습니다",
  });
  assert.deepEqual(downloadQueueSummary(failed), {
    total: 5,
    done: 1,
    failed: 1,
    active: 3,
  });
  const retried = retryDownloadItem(failed, "e");
  assert.equal(retried.find((item) => item.id === "e")!.status, "queued");
  // 패널을 닫아도 진행 중·대기 항목은 남고 끝난 항목만 정리된다.
  assert.deepEqual(
    pruneFinishedDownloads(retried).map((item) => item.id),
    ["a", "c", "d", "e"],
  );
});

test("다중 선택 다운로드(#103)는 목록 패널을 거치고 기존 다운로드 경로를 재사용한다", async () => {
  const [source, css, route, roles] = await Promise.all([
    readFile(new URL("../src/app/files/FilesView.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../src/app/files/desktop.module.css", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/app/api/drive/download/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/lib/roles.ts", import.meta.url), "utf8"),
  ]);

  // 진입점: 선택 안에서 연 항목 메뉴에만, 선택된 파일이 둘 이상일 때만 붙는다.
  assert.match(source, /\{\(contextMenu\.batchDownload \?\? 0\) > 1 && \(/);
  assert.match(source, /queueDownloads\(\s*selectedDownloadTargets\(/);
  assert.match(source, /선택한 \{count\}개 다운로드/);
  assert.match(source, /return targets\.length > 1 \? targets : \[\];/);
  // 폴더는 큐에 넣지 않는다 — 단일 다운로드와 같은 규칙이다.
  assert.match(
    source,
    /const targets = entries\.filter\(\(entry\) => !entry\.isFolder\);/,
  );

  // 동시 실행 캡은 순수 모듈이 계산하고, 하나 끝날 때마다 다음을 올린다.
  assert.match(
    source,
    /nextDownloadStarts\(\s*downloadItemsRef\.current,\s*DOWNLOAD_CONCURRENCY,\s*\)/,
  );
  assert.match(
    source,
    /finally \{\s*reportTransferProgress\(null, id\);[\s\S]{0,120}?pumpDownloadQueue\(\);/,
  );

  // 진행률은 fetch 스트림 + Content-Length로 세고, 완료하면 blob을 a[download]로 저장한다.
  assert.match(source, /response\.body\.getReader\(\)/);
  assert.match(
    source,
    /parseContentLength\(response\.headers\.get\("content-length"\)\)/,
  );
  assert.match(source, /saveDownloadedBlob\(new Blob\(chunks\), item\.fileName\)/);
  assert.match(source, /anchor\.download = fileName;/);

  // 항목별 상태 4종 + 불확정 진행률 + 실패 재시도 버튼.
  assert.match(source, /t\("대기 중"\)/);
  assert.match(source, /t\("받는 중 \{percent\}%", \{ percent \}\)/);
  assert.match(source, /t\("완료"\)/);
  assert.match(source, /t\("다운로드 실패"\)/);
  assert.match(source, /<progress className=\{styles\.downloadProgress\} \/>/);
  assert.match(source, /onClick=\{\(\) => retryQueuedDownload\(item\.id\)\}/);

  // 닫아도 진행 중인 다운로드는 계속되고, 작업표시줄 칩으로 다시 연다.
  assert.match(
    source,
    /function closeDownloadPanel\(\) \{\s*writeDownloadItems\(pruneFinishedDownloads\(/,
  );
  assert.match(
    source,
    /\{!downloadPanelOpen &&\s*downloadSummary\.active \+ downloadSummary\.failed > 0 && \(/,
  );

  // 권한: 새 엔드포인트를 만들지 않고 단일 다운로드와 같은 세션 검사 경로를 쓴다.
  // 다운로드는 역할 4단계 어디에도 게이트가 없는 동작이라(canDownload 없음)
  // 화면 게이트는 "선택에 파일이 둘 이상인가"뿐이고, 실제 방어선은 서버 세션이다.
  assert.match(
    source,
    /`\/api\/drive\/download\?id=\$\{encodeURIComponent\(item\.entryId\)\}`/,
  );
  assert.match(route, /runWithSession\(\{ fresh: wantsInline \}/);
  assert.doesNotMatch(route, /runWithUploadRights|runWithEditRights|runWithAdmin/);
  assert.doesNotMatch(roles, /canDownload/);
  assert.doesNotMatch(source, /allow(Edit|Upload) && \(\s*<MenuButton[^>]*>\s*\{t\("선택한/);

  // 패널 스타일은 기존 픽셀 UI 관례(우하단 고정·픽셀 테두리)를 따른다.
  assert.match(css, /\.downloadPanel \{[\s\S]{0,240}?position: fixed;/);
  assert.match(css, /\.downloadRow\[data-status="failed"\] \.downloadState/);
});

test("외부 공유 링크는 수정 가능 역할의 파일에서만 열리고 복사·취소를 갖춘다", async () => {
  const [filesView, dialog] = await Promise.all([
    readFile(new URL("../src/app/files/FilesView.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../src/app/files/ShareLinkDialog.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  // 메뉴 항목: canEdit(allowEdit) 게이트 + 폴더 제외.
  assert.match(filesView, /createFastShareLink\(contextMenu\.entry!\)/);
  assert.match(filesView, /openShareLinkDialog\(contextMenu\.entry!\)/);
  // 창 렌더도 같은 게이트를 지난다.
  assert.match(filesView, /\{allowEdit && shareLinkEntry && \(/);
  // 서버 관리 API를 쓰고, 공개 URL 형식을 만든다.
  assert.match(dialog, /\/api\/drive\/share-link/);
  assert.match(dialog, /\/api\/share\/\$\{linkId\}/);
  // 복사(클립보드 실패 시 직접 선택 안내)와 링크 취소가 있다.
  assert.match(dialog, /navigator\.clipboard\.writeText/);
  assert.match(dialog, /아래 주소를 직접 선택해 복사해 주세요/);
  assert.match(dialog, /링크 취소/);
  // 만료 선택지 4종, 기본 7일.
  assert.match(dialog, /useState<number>\(24 \* 7\)/);
  for (const label of ["1시간", "24시간", "7일", "30일"]) {
    assert.ok(dialog.includes(`"${label}"`), label);
  }
});

test("폴더 드롭 계획은 부모 폴더를 먼저 만들고 빈 폴더도 남긴다", () => {
  const plan = planFolderUpload([
    { kind: "file", path: ["프로젝트", "문서", "메모.txt"], file: { name: "메모.txt" } },
    { kind: "folder", path: ["프로젝트"] },
    { kind: "folder", path: ["프로젝트", "빈폴더"] },
    { kind: "file", path: ["단독.txt"], file: { name: "단독.txt" } },
  ]);
  // 조상은 항상 자식보다 앞에 온다 — 순차 생성이 부모부터 돌아야 한다.
  assert.deepEqual(plan.folders, [
    ["프로젝트"],
    ["프로젝트", "문서"],
    ["프로젝트", "빈폴더"],
  ]);
  assert.deepEqual(
    plan.files.map((item) => [item.file.name, item.folderPath]),
    [
      ["메모.txt", ["프로젝트", "문서"]],
      ["단독.txt", []],
    ],
  );
  assert.equal(plan.skipped, 0);
});

test("점으로 시작하는 항목은 계획에서 빠지고 개수만 센다", () => {
  const plan = planFolderUpload([
    { kind: "folder", path: [".git"] },
    { kind: "skipped", path: ["앱", ".env"] },
    { kind: "file", path: ["앱", ".env"], file: { name: ".env" } },
    { kind: "file", path: [".숨김폴더", "안.txt"], file: { name: "안.txt" } },
    { kind: "file", path: ["앱", "보임.txt"], file: { name: "보임.txt" } },
  ]);
  assert.deepEqual(plan.folders, [["앱"]]);
  assert.deepEqual(plan.files.map((item) => item.file.name), ["보임.txt"]);
  assert.equal(plan.skipped, 4);
});

test("경로 키는 이름에 든 구분자와 섞이지 않는다", () => {
  assert.notEqual(folderPathKey(["a b"]), folderPathKey(["a", "b"]));
  assert.notEqual(folderPathKey(["a/b"]), folderPathKey(["a", "b"]));
  assert.equal(folderPathKey([]), "");
});

test("상위 폴더 생성이 실패한 파일은 올리지 않고 막힌 것으로 센다", () => {
  const plan = planFolderUpload([
    { kind: "file", path: ["열림", "a.txt"], file: { name: "a.txt" } },
    { kind: "file", path: ["막힘", "b.txt"], file: { name: "b.txt" } },
    { kind: "file", path: ["c.txt"], file: { name: "c.txt" } },
  ]);
  const folderIds = new Map([
    [folderPathKey([]), "root"],
    [folderPathKey(["열림"]), "folder-1"],
  ]);
  const { ready, blocked } = resolveUploadTargets(plan.files, folderIds);
  assert.deepEqual(
    ready.map((item) => [item.file.name, item.parentId]),
    [
      ["a.txt", "folder-1"],
      ["c.txt", "root"],
    ],
  );
  assert.equal(blocked, 1);
});

test("mkdir 409만 병합으로 보고, 같은 이름의 폴더를 목록에서 찾는다", () => {
  assert.equal(isFolderExistsConflict(Object.assign(new Error("x"), { status: 409 })), true);
  assert.equal(
    isFolderExistsConflict(Object.assign(new Error("x"), { body: { code: "CONFLICT" } })),
    true,
  );
  assert.equal(isFolderExistsConflict(Object.assign(new Error("x"), { status: 403 })), false);
  assert.equal(isFolderExistsConflict(new Error("x")), false);
  assert.equal(isFolderExistsConflict(null), false);

  const entries = [
    { id: "f1", name: "보고서", isFolder: false },
    { id: "f2", name: "보고서", isFolder: true },
    { id: "f3", name: "사진", isFolder: true },
  ];
  // 같은 이름이라도 폴더만 병합 대상이다.
  assert.equal(matchExistingFolder(entries, "보고서"), "f2");
  assert.equal(matchExistingFolder(entries, " 사진 "), "f3");
  // 파일하고만 부딪히면 찾지 못하고 호출부가 실패로 남긴다.
  assert.equal(matchExistingFolder([entries[0]], "보고서"), null);
});

test("폴더 드롭은 기존 파일 업로드 경로를 그대로 남긴다", async () => {
  const source = await readFile(
    new URL("../src/app/files/FilesView.tsx", import.meta.url),
    "utf8",
  );
  // 디렉터리가 없으면 null → 기존 uploadFiles 경로.
  assert.match(
    source,
    /const directoryRoots = droppedDirectoryEntries\(event\.dataTransfer\);/,
  );
  assert.match(source, /void uploadFiles\(event\.dataTransfer\.files, scopeId\);/);
  assert.match(source, /void uploadDroppedTree\(directoryRoots, scopeId\);/);
  // 업로드 권한·로딩 가드는 그대로.
  assert.match(source, /if \(!allowUpload \|\| data\.loading\) return;/);
  // 파일 진행 UI는 기존 uploadOne(=reportTransferProgress)을 그대로 쓴다.
  assert.match(source, /await uploadOne\(target\.file, target\.parentId\);/);
});
