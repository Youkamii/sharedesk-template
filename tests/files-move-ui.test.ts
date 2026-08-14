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
    /if \(reason === "saving"\) \{\s*setNotice\("텍스트 파일을 저장하는 중입니다\. 저장이 끝난 뒤 다시 시도해 주세요"\);\s*return false/,
  );
  assert.match(
    source,
    /entry\.isFolder &&\s*previewAffectedByEntryLifecycle\(entry\) &&\s*!confirmPreviewDiscard\(\)/,
  );
  assert.match(
    source,
    /dialog\.kind === "delete" \|\| dialog\.entry\.isFolder[\s\S]*?previewAffectedByEntryLifecycle\(dialog\.entry\)[\s\S]*?!confirmPreviewDiscard\(\)/,
  );
  assert.match(
    source,
    /async function logout\(\) \{\s*if \(!confirmPreviewDiscard\(\)\) return/,
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

test("휴지통은 작업 표시줄이 아닌 화면 우측 하단 고정 아이콘으로 연다", async () => {
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
  assert.match(source, /aria-label="휴지통 열기"/);
  assert.match(source, /function TrashCanIcon\(\)/);
  assert.match(source, /shapeRendering="crispEdges"/);
  assert.match(source, /viewBox="0 0 32 36"/);
  assert.ok(
    (source.match(/<path /g) ?? []).length >= 10,
    "휴지통 아이콘은 뚜껑, 손잡이, 몸통과 세로 홈을 구분해 그려야 합니다.",
  );
  assert.match(launcherStyle, /position: fixed;/);
  assert.match(launcherStyle, /right: max\(18px, env\(safe-area-inset-right\)\);/);
  assert.match(launcherStyle, /bottom: 76px;/);
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
  assert.match(source, /className=\{styles\.trashDanger\}[\s\S]*?>\s*비우기…/);
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
    /function openSearchResult[\s\S]*?fileActivationAction\(result\.entry, downloadFirst\)[\s\S]*?action === "preview"[\s\S]*?openPreview\(result\.entry\)/,
  );
  assert.match(source, /localStorage\.setItem\([\s\S]*?DOWNLOAD_FIRST_STORAGE_KEY/);
  assert.match(source, />다운로드 우선</);
  assert.match(source, /checked=\{downloadFirst\}/);
  assert.match(source, /브라우저에서 열기/);
  assert.match(
    source,
    /fileActivationAction\(entry, false\)[\s\S]*?action === "preview"[\s\S]*?openPreviewInScope\(entry, contextMenu\.scopeId\)/,
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
    /\.previewWindow \{[\s\S]*?grid-template-rows: 30px minmax\(0, 1fr\) 22px;/,
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
  assert.match(source, /aria-label="폴더 미리보기 닫기"/);
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
    /updateTransfer\(0, file\.size\);\s*try \{[\s\S]*?await apiJson<UploadSession>\("\/api\/drive\/upload-session"[\s\S]*?finally \{\s*reportTransferProgress\(null, transferId\);/,
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
  const deskSettingsIndex = taskbar.indexOf("책상 설정");
  assert.ok(searchIndex >= 0 && searchIndex < deskSettingsIndex);
  assert.match(taskbar, /placeholder="전체 파일 검색"/);
  assert.match(taskbar, /className=\{styles\.deskButton\}/);

  assert.match(source, /className={styles\.folderSearch}/);
  assert.match(source, /placeholder="이 폴더 검색"/);
  assert.match(source, /\/api\/drive\/search\?\$\{params\}/);
  assert.match(source, /signal: controller\.signal/);
  assert.match(source, /searchInstanceRef\.current !== instanceId/);
  assert.match(source, /가상 검색결과/);
  assert.match(source, /result\.path/);
  assert.match(source, /openSearchResult\(result\)/);
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

test("관리자 업데이트 화면은 사용자 관리 앞에서 최신 상태를 안전하게 확인한다", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../src/app/files/FilesView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/files/desktop.module.css", import.meta.url), "utf8"),
  ]);

  const trayStart = source.indexOf('<div className={styles.userTray}>');
  const trayEnd = source.indexOf("</div>", trayStart);
  const userTray = source.slice(trayStart, trayEnd);
  const updateIndex = userTray.indexOf("업데이트");
  const userManagementIndex = userTray.indexOf("사용자 관리");

  assert.ok(trayStart >= 0 && trayEnd > trayStart);
  assert.ok(updateIndex >= 0 && updateIndex < userManagementIndex);
  assert.match(
    userTray,
    /\{isAdmin && \([\s\S]*?업데이트[\s\S]*?사용자 관리/,
  );
  assert.match(userTray, /aria-haspopup="dialog"/);

  assert.match(
    source,
    /apiJson<UpdateStatusResponse>\("\/api\/admin\/update", \{[\s\S]*?method: "GET",[\s\S]*?cache: "no-store",[\s\S]*?signal: controller\.signal/,
  );
  assert.match(source, /updateControllerRef\.current\?\.abort\(\)/);
  assert.match(source, /updateRequestIdRef\.current !== requestId/);
  assert.match(source, /if \(!isAdmin\) return;/);

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
  assert.match(source, /status\.error/);
  assert.match(
    source,
    /status\.configured &&[\s\S]*?status\.updateAvailable &&[\s\S]*?status\.workflowUrl && \([\s\S]*?GitHub Actions 화면에서[\s\S]*?Run workflow[\s\S]*?Vercel/,
  );
  assert.match(
    source,
    /\{updatePanel\.status\.configured &&\s*updatePanel\.status\.updateAvailable &&\s*updatePanel\.status\.workflowUrl && \(\s*<button[\s\S]*?window\.open\([\s\S]*?"_blank",[\s\S]*?"noopener,noreferrer"[\s\S]*?>\s*업데이트 시작/,
  );
  assert.match(
    source,
    /https:\/\/github\.com\/Youkamii\/sharedesk-template\/blob\/main\/docs\/UPDATE\.md/,
  );
  assert.doesNotMatch(source, /href="\/docs"/);

  assert.match(css, /\.updateTrayButton \{/);
  assert.match(css, /\.updateDialog \{/);
  assert.match(css, /\.updateDialogBody \{/);
  assert.match(css, /\.updateVersions \{/);
  assert.match(css, /\.updateSetup \{/);
  assert.match(css, /\.updateInstruction \{/);
  assert.match(css, /\.updateError \{/);
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
