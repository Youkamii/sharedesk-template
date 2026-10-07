import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createVisitorDownloadRunner,
  type VisitorDownloadIo,
} from "../src/lib/client/visitor-downloads";
import {
  EMPTY_VISITOR_SELECTION,
  clickVisitorSelection,
  isVisitorSelected,
  pruneVisitorSelection,
  rectangleVisitorSelection,
  selectedVisitorFiles,
} from "../src/lib/client/visitor-selection";

// 공개 폴더 방문자 여러 파일 한꺼번에 받기(#17 B-6): 고르기 순수 함수(데스크
// 규칙 — Ctrl/⌘ 넣고 빼기, Shift 범위, 고무줄), 3개씩 차례로 받는 큐(공개 폴더
// 주소), 화면 배선(데스크톱 작업표시줄·고무줄, 좁은 화면 고르기 모드), 사전.

const read = (relative: string) =>
  readFile(new URL(`../${relative}`, import.meta.url), "utf8");

const ORDER = ["a", "b", "c", "d", "e"];
const plain = { toggle: false, range: false };
const ctrl = { toggle: true, range: false };
const shift = { toggle: false, range: true };
const ctrlShift = { toggle: true, range: true };

test("고르기: 그냥 누르면 하나, Ctrl/⌘는 넣고 빼기 (#17 B-6)", () => {
  let selection = clickVisitorSelection(EMPTY_VISITOR_SELECTION, "b", ORDER, plain);
  assert.deepEqual(selection, { ids: ["b"], anchorId: "b" });
  selection = clickVisitorSelection(selection, "d", ORDER, ctrl);
  assert.deepEqual(selection, { ids: ["b", "d"], anchorId: "d" });
  selection = clickVisitorSelection(selection, "e", ORDER, ctrl);
  assert.deepEqual(selection.ids, ["b", "d", "e"]);
  assert.ok(isVisitorSelected(selection, "e"));
  // Ctrl로 다시 누르면 뺀다.
  selection = clickVisitorSelection(selection, "d", ORDER, ctrl);
  assert.deepEqual(selection.ids, ["b", "e"]);
  // 그냥 누르면 그것 하나로 바뀐다.
  assert.deepEqual(clickVisitorSelection(selection, "c", ORDER, plain), {
    ids: ["c"],
    anchorId: "c",
  });
  // 하나 남은 것을 Ctrl로 빼면 빈 선택.
  assert.deepEqual(
    clickVisitorSelection({ ids: ["a"], anchorId: "a" }, "a", ORDER, ctrl),
    EMPTY_VISITOR_SELECTION,
  );
});

test("고르기: Shift는 기준부터 화면 순서로 범위, Ctrl+Shift는 범위를 더한다 (#17 B-6)", () => {
  const start = clickVisitorSelection(EMPTY_VISITOR_SELECTION, "b", ORDER, plain);
  const forward = clickVisitorSelection(start, "d", ORDER, shift);
  assert.deepEqual(forward, { ids: ["b", "c", "d"], anchorId: "b" });
  // 같은 기준에서 다시 재면 범위가 바뀐다(뒤쪽으로).
  assert.deepEqual(clickVisitorSelection(forward, "a", ORDER, shift).ids, ["a", "b"]);
  // Ctrl+Shift는 기존 선택에 범위를 더한다.
  const withE = clickVisitorSelection(start, "e", ORDER, ctrl);
  assert.deepEqual(clickVisitorSelection(withE, "c", ORDER, ctrlShift).ids, [
    "b",
    "e",
    "c",
    "d",
  ]);
  // 기준이 없으면 Shift도 그냥 누름과 같다.
  assert.deepEqual(clickVisitorSelection(EMPTY_VISITOR_SELECTION, "c", ORDER, shift), {
    ids: ["c"],
    anchorId: "c",
  });
});

test("고르기: 고무줄은 사각형에 걸린 것, Ctrl/⌘면 더한다 (#17 B-6)", () => {
  const icon = (id: string, x: number, y: number) => ({
    layoutKey: id,
    x,
    y,
    width: 88,
    height: 94,
  });
  const candidates = [icon("a", 12, 10), icon("b", 108, 10), icon("c", 12, 114)];
  const rectangle = { x: 0, y: 0, width: 150, height: 50 };
  assert.deepEqual(
    rectangleVisitorSelection({ ids: ["c"], anchorId: "c" }, candidates, rectangle, false).ids,
    ["a", "b"],
  );
  const added = rectangleVisitorSelection({ ids: ["c"], anchorId: "c" }, candidates, rectangle, true);
  assert.deepEqual(added, { ids: ["c", "a", "b"], anchorId: "c" });
  assert.deepEqual(
    rectangleVisitorSelection(EMPTY_VISITOR_SELECTION, candidates, { x: 400, y: 400, width: 5, height: 5 }, false),
    EMPTY_VISITOR_SELECTION,
  );
});

test("고르기: 목록이 바뀌면 사라진 항목은 빠지고, 받을 것은 파일만 화면 순서로 (#17 B-6)", () => {
  const selection = { ids: ["b", "gone", "d"], anchorId: "gone" };
  const pruned = pruneVisitorSelection(selection, ORDER);
  assert.deepEqual(pruned, { ids: ["b", "d"], anchorId: null });
  // 바뀐 게 없으면 같은 객체(그릴 때마다 새 값을 만들지 않는다).
  const kept = { ids: ["a"], anchorId: "a" };
  assert.equal(pruneVisitorSelection(kept, ORDER), kept);

  const entries = [
    { id: "d", isFolder: false, name: "d.txt" },
    { id: "folder", isFolder: true, name: "폴더" },
    { id: "b", isFolder: false, name: "b.txt" },
  ];
  assert.deepEqual(
    selectedVisitorFiles(entries, { ids: ["b", "folder", "d"], anchorId: "b" }).map(
      (entry) => entry.id,
    ),
    ["d", "b"],
  );
});

test("받기 큐: 공개 폴더 주소로 3개씩 차례로, 끝나면 다음 묶음 (#17 B-6)", async () => {
  const token = "f".repeat(48);
  const urlFor = (entryId: string) =>
    `/api/public-folder/${token}/download?id=${encodeURIComponent(entryId)}`;
  const started: string[] = [];
  const pending: Array<() => void> = [];
  let inFlight = 0;
  let peak = 0;
  const io: VisitorDownloadIo = {
    async fetchFile(url) {
      started.push(url);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => pending.push(resolve));
      inFlight -= 1;
      return new Response("x");
    },
    saveBlob() {},
    saveNative() {
      throw new Error("크기를 아는 작은 파일은 브라우저에 맡기지 않는다");
    },
    holdNative: () => Promise.resolve(),
  };
  let seq = 0;
  const runner = createVisitorDownloadRunner({
    urlFor,
    onChange: () => {},
    io,
    makeId: () => `q${(seq += 1)}`,
  });
  runner.enqueue(
    ["가 1.txt", "나.txt", "다.txt", "라.png", "마.csv"].map((name) => ({
      id: name,
      name,
      size: 10,
    })),
  );
  assert.equal(started.length, 3, "처음엔 3개만");
  assert.equal(started[0], `/api/public-folder/${token}/download?id=%EA%B0%80%201.txt`);
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  pending.shift()!();
  await flush();
  await flush();
  assert.equal(started.length, 4, "하나 끝나면 다음 하나");
  while (pending.length > 0) {
    pending.shift()!();
    await flush();
    await flush();
  }
  assert.equal(peak, 3);
  assert.deepEqual(
    runner.items().map((item) => item.status),
    ["done", "done", "done", "done", "done"],
  );
});

test("배선: 데스크톱 — 고르기·고무줄·작업표시줄 받기 단추·진행 표시 (#17 B-6)", async () => {
  const [view, desktopCss] = await Promise.all([
    read("src/app/public/[token]/PublicFolderView.tsx"),
    read("src/app/files/desktop.module.css"),
  ]);
  // 단일 선택 상태는 없어졌다 — 선택은 하나의 규칙(visitor-selection)으로.
  assert.doesNotMatch(view, /selectedId|setSelectedId/);
  for (const call of [
    "isVisitorSelected(",
    "clickVisitorSelection(",
    "pruneVisitorSelection(",
    "rectangleVisitorSelection(",
    "selectedVisitorFiles(",
  ]) {
    assert.ok(view.includes(call), call);
  }
  assert.match(view, /event\.shiftKey/);
  // 고무줄: 판(iconPlane)에서 시작, 아이콘 위에서는 시작하지 않는다, 마우스만.
  assert.match(view, /iconPlane\} onPointerDown=\{startMarquee\}/);
  assert.match(view, /data-public-entry/);
  assert.match(view, /pointerType !== "mouse"/);
  assert.match(view, /desktopStyles\.selectionRectangle/);
  // 받기: 공개 폴더 다운로드 주소, 3개씩 차례로(공용 큐), 공용 진행 문구.
  assert.match(view, /useVisitorDownloads\(/);
  assert.match(view, /\/api\/public-folder\/\$\{token\}\/download\?id=/);
  assert.match(view, /\.enqueue\(selectedFiles\)/);
  assert.match(view, /formatVisitorDownloadStatus\(/);
  assert.match(view, /"선택 \{count\}개 받기"/);
  assert.match(desktopCss, /\.publicBatchDownload \{/);
  assert.match(desktopCss, /\.selectionRectangle \{/);
});

test("배선: 좁은 화면 — 고르기 모드, 선택 기준은 전체 파일, 파일이 없으면 모드 자동 해제 (#17 B-6)", async () => {
  const [view, mobileCss] = await Promise.all([
    read("src/app/public/[token]/PublicFolderView.tsx"),
    read("src/app/files/mobile.module.css"),
  ]);
  assert.match(view, /setSelectMode\(/);
  assert.match(view, /"고르기"/);
  assert.match(view, /mobileStyles\.rowCheck/);
  assert.match(view, /\.enqueue\(mobileSelected\)/);
  // 검색 칸은 데스크톱에만 있으므로 좁은 화면의 선택 기준은 files다.
  assert.match(view, /narrow \? files : visibleFiles/);
  assert.match(view, /selectedVisitorFiles\(files,/);
  // 목록에 파일이 없으면 고르기 모드를 끈다(독이 "선택 0개 받기"에 갇히지 않게).
  const exitAt = view.indexOf("setSelectMode(false)");
  assert.ok(exitAt > 0, "고르기 자동 해제");
  assert.ok(
    view.lastIndexOf("setListing(body)", exitAt) > 0,
    "목록을 받은 자리에서 판단한다",
  );
  for (const rule of [".publicSelectToggle {", ".rowPicked {", ".rowCheck {"]) {
    assert.ok(mobileCss.includes(rule), rule);
  }
});

test("i18n: 여러 파일 받기 문구가 네 사전에 있다 (#17 B-6)", async () => {
  const [{ englishDictionary }, { JA }, { HI }, { ZH }] = await Promise.all([
    import("../src/lib/i18n"),
    import("../src/lib/i18n-ja"),
    import("../src/lib/i18n-hi"),
    import("../src/lib/i18n-zh"),
  ]);
  const EN = englishDictionary();
  for (const key of [
    "고르기",
    "취소",
    "선택 {count}개 받기",
    "내려받는 중 {done}/{total}",
    "{count}개를 내려받았습니다",
    "{done}개 받음 · {failed}개 실패",
  ]) {
    for (const [name, dictionary] of Object.entries({ EN, JA, HI, ZH })) {
      assert.ok(key in dictionary, `${name} 사전에 없는 키 — ${key}`);
    }
  }
});
