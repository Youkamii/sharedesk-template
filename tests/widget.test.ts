import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  disableWidgetWall,
  enableWidgetWall,
  hideWidgetWindow,
  installStrayDropGuard,
  isUnsupportedCommandError,
  isWidgetHidden,
  parseWallSide,
  parseWidgetMode,
  parseWidgetWall,
  readWidgetMode,
  readWidgetWall,
  recentWidgetFiles,
  reportWallZone,
  sortWidgetEntries,
  tauriInternals,
  WALL_HANDLE_SLACK,
  wallZoneRect,
  WIDGET_DRAG_OUT_TYPE,
  WIDGET_HIDDEN_FLAG,
  WIDGET_HIDDEN_POLL_MS,
  WIDGET_LIST_POLL_MS,
  WIDGET_MODE_KEY,
  WIDGET_WALL_HOVER_EVENT,
  WIDGET_WALL_KEY,
  WIDGET_WALL_SIDE_EVENT,
  widgetDragOutData,
  widgetPollInterval,
  writeWidgetMode,
  writeWidgetWall,
} from "../src/lib/client/widget";
import { apiPath } from "../src/lib/client/api-path";
import { uploadEntry } from "../src/lib/client/upload-entry";

function entry(
  name: string,
  isFolder = false,
  modifiedAt: string | null = null,
) {
  return {
    id: name,
    layoutKey: name,
    name,
    isFolder,
    size: null,
    modifiedAt,
    mimeType: null,
    version: null,
  };
}

test("widget grid puts folders first and sorts names naturally", () => {
  const sorted = sortWidgetEntries(
    [
      entry("b.txt"),
      entry("photo 10.png"),
      entry("Z folder", true),
      entry("a folder", true),
      entry("photo 2.png"),
      entry("A.txt"),
    ],
    "en-US",
  ).map((item) => item.name);
  assert.deepEqual(sorted, [
    "a folder",
    "Z folder",
    "A.txt",
    "b.txt",
    "photo 2.png",
    "photo 10.png",
  ]);
  // 한글도 숫자를 자연 순서로 센다 (문자 종류 간 순서는 로케일이 정한다)
  const korean = sortWidgetEntries(
    [entry("사진 10"), entry("사진 2"), entry("보고서", true)],
    "ko-KR",
  ).map((item) => item.name);
  assert.deepEqual(korean, ["보고서", "사진 2", "사진 10"]);
});

test("recent files skip folders, newest first, undated last", () => {
  const recent = recentWidgetFiles(
    [
      entry("old.txt", false, "2026-01-01T00:00:00.000Z"),
      entry("folder", true, "2026-09-01T00:00:00.000Z"),
      entry("new.txt", false, "2026-09-02T00:00:00.000Z"),
      entry("undated.txt", false, null),
      entry("broken.txt", false, "not-a-date"),
      entry("mid.txt", false, "2026-05-01T00:00:00.000Z"),
    ],
    4,
  ).map((item) => item.name);
  assert.deepEqual(recent, ["new.txt", "mid.txt", "old.txt", "broken.txt"]);
  assert.deepEqual(recentWidgetFiles([entry("x.txt")], 0), []);
});

test("widget mode is remembered per browser and falls back to the drawer", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
  assert.equal(readWidgetMode(storage), "desk");
  writeWidgetMode(storage, "window");
  assert.equal(store.get(WIDGET_MODE_KEY), "window");
  assert.equal(readWidgetMode(storage), "window");
  assert.equal(parseWidgetMode("garbage"), "desk");
  assert.equal(readWidgetMode(null), "desk");
  // 저장소가 던져도 화면은 살아야 한다
  const throwing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(readWidgetMode(throwing), "desk");
  assert.doesNotThrow(() => writeWidgetMode(throwing, "window"));
});

test("polling slows down while the widget window is hidden", () => {
  assert.equal(widgetPollInterval(WIDGET_LIST_POLL_MS, false), WIDGET_LIST_POLL_MS);
  assert.equal(widgetPollInterval(WIDGET_LIST_POLL_MS, true), WIDGET_HIDDEN_POLL_MS);
  assert.equal(widgetPollInterval(WIDGET_HIDDEN_POLL_MS * 2, true), WIDGET_HIDDEN_POLL_MS * 2);
  // 브라우저의 document.hidden과 껍데기가 심는 표식 둘 다 "숨김"이다
  assert.equal(isWidgetHidden({ hidden: false }, {}), false);
  assert.equal(isWidgetHidden({ hidden: true }, {}), true);
  assert.equal(isWidgetHidden({ hidden: false }, { [WIDGET_HIDDEN_FLAG]: true }), true);
  assert.equal(isWidgetHidden({ hidden: false }, { [WIDGET_HIDDEN_FLAG]: "yes" }), false);
  assert.equal(isWidgetHidden({ hidden: false }, null), false);
});

test("shell IPC is optional: no internals means hide is a no-op", async () => {
  assert.equal(tauriInternals({}), null);
  assert.equal(tauriInternals(null), null);
  assert.equal(await hideWidgetWindow({}), false);
  const calls: Array<[string, unknown]> = [];
  const host = {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args?: unknown) => {
        calls.push([command, args]);
      },
    },
  };
  assert.equal(await hideWidgetWindow(host), true);
  assert.deepEqual(calls, [["hide_widget", undefined]]);
  const failing = {
    __TAURI_INTERNALS__: {
      invoke: async () => {
        throw new Error("denied");
      },
    },
  };
  assert.equal(await hideWidgetWindow(failing), false);
});

test("stray drops are cancelled unless the page already handled them", () => {
  const listeners = new Map<string, (event: Event) => void>();
  const target = {
    addEventListener: (type: string, listener: (event: Event) => void) =>
      void listeners.set(type, listener),
    removeEventListener: (type: string) => void listeners.delete(type),
  };
  const uninstall = installStrayDropGuard(target);
  assert.deepEqual([...listeners.keys()].sort(), ["dragover", "drop"]);

  const fakeEvent = (handled: boolean) => {
    const transfer = { dropEffect: "copy" };
    const event = {
      defaultPrevented: handled,
      dataTransfer: transfer,
      prevented: 0,
      preventDefault() {
        this.prevented += 1;
      },
    };
    return { event, transfer };
  };
  // 아무도 처리하지 않은 드래그 → 기본 동작(파일로 이동) 차단 + 놓을 수 없음 표시
  const stray = fakeEvent(false);
  listeners.get("dragover")!(stray.event as unknown as Event);
  assert.equal(stray.event.prevented, 1);
  assert.equal(stray.transfer.dropEffect, "none");
  const strayDrop = fakeEvent(false);
  listeners.get("drop")!(strayDrop.event as unknown as Event);
  assert.equal(strayDrop.event.prevented, 1);
  // 서랍 모드가 이미 처리한(preventDefault된) 드래그는 건드리지 않는다
  const handled = fakeEvent(true);
  listeners.get("dragover")!(handled.event as unknown as Event);
  assert.equal(handled.event.prevented, 0);
  assert.equal(handled.transfer.dropEffect, "copy");
  uninstall();
  assert.equal(listeners.size, 0);
});

// ── 벽 붙임 (#28) ──────────────────────────────────────────────────────

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
}

test("wall mode is a separate per-browser toggle that defaults to off (#28)", () => {
  const storage = memoryStorage();
  assert.equal(readWidgetWall(storage), false);
  writeWidgetWall(storage, true);
  assert.equal(storage.store.get(WIDGET_WALL_KEY), "on");
  assert.equal(readWidgetWall(storage), true);
  // 서랍/창가 모드 저장과 섞이지 않는다
  assert.equal(readWidgetMode(storage), "desk");
  writeWidgetWall(storage, false);
  assert.equal(storage.store.get(WIDGET_WALL_KEY), "off");
  assert.equal(readWidgetWall(storage), false);
  // 모르는 값·막힌 저장소는 꺼짐
  assert.equal(parseWidgetWall("true"), false);
  assert.equal(parseWidgetWall(1), false);
  assert.equal(readWidgetWall(null), false);
  const throwing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(readWidgetWall(throwing), false);
  assert.doesNotThrow(() => writeWidgetWall(throwing, true));
});

test("wall side accepts only left/right from the shell (#28)", () => {
  assert.equal(parseWallSide("left"), "left");
  assert.equal(parseWallSide("right"), "right");
  assert.equal(parseWallSide("top"), null);
  assert.equal(parseWallSide(null), null);
  assert.equal(parseWallSide(undefined), null);
});

test("wall zone is the handle plus slack while folded and the whole window while open (#28)", () => {
  const slack = WALL_HANDLE_SLACK;
  const handle = { left: 100, top: 50, width: 10, height: 20 };
  const viewport = { width: 300, height: 400 };
  assert.deepEqual(wallZoneRect(false, handle, viewport), [
    100 - slack,
    50 - slack,
    10 + slack * 2,
    20 + slack * 2,
  ]);
  assert.deepEqual(wallZoneRect(true, handle, viewport), [0, 0, 300, 400]);
});

test("wall commands go through the shell IPC and an old shell falls back to floating (#28)", async () => {
  // 껍데기가 없으면(브라우저) 켤 수 없고, 끄기·영역 보고는 조용히 넘어간다
  assert.deepEqual(await enableWidgetWall({}), { reason: "unsupported" });
  await assert.doesNotReject(disableWidgetWall({}));
  await assert.doesNotReject(reportWallZone({}, null));

  const calls: Array<[string, unknown]> = [];
  const shell = (answer: unknown) => ({
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args?: unknown) => {
        calls.push([command, args]);
        return answer;
      },
    },
  });
  assert.deepEqual(await enableWidgetWall(shell("right")), { side: "right" });
  await disableWidgetWall(shell(null));
  await reportWallZone(shell(null), { rect: [322, 220, 22, 80], hold: true });
  assert.deepEqual(calls, [
    ["set_wall_mode", { enabled: true }],
    ["set_wall_mode", { enabled: false }],
    ["set_wall_zone", { zone: { rect: [322, 220, 22, 80], hold: true } }],
  ]);
  // 엉뚱한 답은 붙이지 못한 것으로 본다
  assert.deepEqual(await enableWidgetWall(shell("middle")), { reason: "failed" });

  // Tauri는 거절 사유를 문자열로 준다 — 없는·막힌 명령이면 옛 껍데기(업데이트 안내)
  const rejecting = (reason: unknown) => ({
    __TAURI_INTERNALS__: {
      invoke: async () => {
        throw reason;
      },
    },
  });
  assert.deepEqual(await enableWidgetWall(rejecting("Command set_wall_mode not allowed by ACL")), {
    reason: "unsupported",
  });
  assert.deepEqual(await enableWidgetWall(rejecting("Command set_wall_mode not found")), {
    reason: "unsupported",
  });
  // 새 껍데기가 붙이지 못했거나 데스크 페이지가 아니면 실패(표식 유지)
  assert.deepEqual(await enableWidgetWall(rejecting("창을 벽에 붙이지 못했습니다")), { reason: "failed" });
  assert.deepEqual(
    await enableWidgetWall(rejecting("데스크 페이지에서만 벽 붙임을 쓸 수 있습니다")),
    { reason: "failed" },
  );
  const oldShell = rejecting("Command set_wall_mode not allowed by ACL");
  await assert.doesNotReject(disableWidgetWall(oldShell));
  await assert.doesNotReject(reportWallZone(oldShell, { rect: [0, 0, 1, 1], hold: false }));
});

test("old-shell detection matches Tauri 2's missing/denied command rejections only (#28)", () => {
  // tauri 2.12 src/webview/mod.rs · src/ipc/authority.rs 의 실제 문구
  for (const message of [
    "Command set_wall_mode not found",
    "Command set_wall_mode not allowed by ACL",
    "set_wall_mode not allowed. Command not found",
    "set_wall_mode not allowed on origin [http://localhost:3100/files]. Please create a capability",
  ]) {
    assert.equal(isUnsupportedCommandError(message), true, message);
    assert.equal(isUnsupportedCommandError(new Error(message)), true, message);
  }
  for (const message of ["창을 벽에 붙이지 못했습니다", "데스크 페이지에서만 벽 붙임을 쓸 수 있습니다", "", null]) {
    assert.equal(isUnsupportedCommandError(message), false, String(message));
  }
});

test("배선: 벽 붙임 — 화면·껍데기·권한이 같은 이름을 쓴다 (#28)", async () => {
  const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
  const view = await read("../src/app/widget/WidgetView.tsx");
  const helpers = await read("../src/lib/client/widget.ts");
  const wall = await read("../widget/src-tauri/src/wall.rs");
  const shell = await read("../widget/src-tauri/src/lib.rs");
  const build = await read("../widget/src-tauri/build.rs");
  const globals = await read("../src/app/globals.css");
  const css = await read("../src/app/widget/widget.module.css");

  // 껍데기가 쏘는 이벤트 이름과 화면이 듣는 이름이 같아야 한다
  assert.equal(WIDGET_WALL_HOVER_EVENT, "sharedesk:wall-hover");
  assert.equal(WIDGET_WALL_SIDE_EVENT, "sharedesk:wall-side");
  assert.match(wall, /pub const HOVER_EVENT: &str = "sharedesk:wall-hover";/);
  assert.match(wall, /pub const SIDE_EVENT: &str = "sharedesk:wall-side";/);
  assert.match(view, /document\.addEventListener\(WIDGET_WALL_HOVER_EVENT, onHover\)/);
  assert.match(view, /document\.addEventListener\(WIDGET_WALL_SIDE_EVENT, onSide\)/);

  // 화면은 켜기·끄기·영역 보고를 껍데기 명령으로 한다
  assert.match(helpers, /invoke\("set_wall_mode", \{ enabled: true \}\)/);
  assert.match(helpers, /invoke\("set_wall_mode", \{ enabled: false \}\)/);
  assert.match(helpers, /invoke\("set_wall_zone", \{ zone \}\)/);
  assert.match(view, /void enableWidgetWall\(window\)/);
  assert.match(view, /void disableWidgetWall\(window\)/);
  assert.match(view, /void reportWallZone\(window, \{\s*rect: wallZoneRect\(wallExpanded,/);
  // 옛 껍데기면 표식을 끄고 업데이트를 안내하고, 붙이지 못했으면 표식은 두고 알리기만 한다
  assert.match(
    view,
    /result\.reason === "unsupported"[\s\S]{0,200}writeWidgetWall\(storage, false\)[\s\S]{0,120}t\("위젯을 업데이트하면 벽 붙임을 쓸 수 있습니다"\)/,
  );
  assert.match(view, /showNotice\(t\("벽에 붙이지 못했습니다"\)\)/);

  // 손잡이는 body에 포털로 그리고(위젯과 함께 밀려나지 않게), 우클릭 메뉴·업로드·서랍 위 끌기 동안은 붙잡는다
  assert.match(view, /createPortal\(\s*<div\s+ref=\{wallHandleRef\}\s+className=\{styles\.wallHandle\}/);
  assert.match(view, /const hold = contextMenu !== null \|\| uploading \|\| dragOver \|\| draggingOut;/);

  // 껍데기 명령과 권한 — 원격 데스크 페이지도 두 명령을 부를 수 있어야 한다
  assert.match(shell, /set_wall_mode,\s+set_wall_zone\s+\]\)/);
  assert.match(build, /"set_wall_mode",\s+"set_wall_zone",/);
  for (const name of ["default", "remote"]) {
    const capability = JSON.parse(
      await read(`../widget/src-tauri/capabilities/${name}.json`),
    ) as { permissions: string[] };
    assert.ok(capability.permissions.includes("allow-set-wall-mode"), `${name}: allow-set-wall-mode`);
    assert.ok(capability.permissions.includes("allow-set-wall-zone"), `${name}: allow-set-wall-zone`);
  }

  // 벽 붙임 중에는 바탕을 비워 손잡이만 남긴다
  assert.match(view, /root\.setAttribute\("data-widget-wall", ""\)/);
  assert.match(globals, /html\[data-widget\]\[data-widget-wall\] body\s*\{\s*background:\s*transparent/);
  assert.match(css, /\.widget\[data-wall="right"\]:not\(\[data-wall-expanded\]\)\s*\{\s*transform:\s*translateX\(100%\)/);
  assert.match(css, /\.widget\[data-wall="left"\]:not\(\[data-wall-expanded\]\)\s*\{\s*transform:\s*translateX\(-100%\)/);
  // 손잡이는 .widget 밖(body)에 있으므로 색 토큰이 html[data-widget]에 있어야 한다
  assert.match(globals, /html\[data-widget\]\s*\{[^}]*--peach:/);
  assert.doesNotMatch(css, /\.widget\s*\{[^}]*--peach:/);
});

// ── 끌어내기 (#29) ──────────────────────────────────────────────────────

// Chromium ParseDownloadMetadata와 같은 방식: 첫 콜론까지 mime, 다음 콜론까지 이름, 나머지가 주소
function parseDownloadUrl(value: string) {
  const mimeEnd = value.indexOf(":");
  const nameEnd = value.indexOf(":", mimeEnd + 1);
  return {
    mime: value.slice(0, mimeEnd),
    name: value.slice(mimeEnd + 1, nameEnd),
    url: new URL(value.slice(nameEnd + 1)),
  };
}

test("drag-out data is mime:name:absolute download url for Chromium's DownloadURL (#29)", () => {
  assert.equal(WIDGET_DRAG_OUT_TYPE, "DownloadURL");
  const origin = "http://localhost:3100";
  const same = (path: string) => path;
  const memo = widgetDragOutData(
    { id: "a b/c?d", name: "memo.txt", mimeType: "text/plain" },
    origin,
    same,
  );
  assert.deepEqual(memo, {
    downloadUrl: "text/plain:memo.txt:http://localhost:3100/api/drive/download?id=a%20b%2Fc%3Fd",
    text: "memo.txt",
  });
  // 주소는 그대로 되읽혀 같은 id를 가리킨다
  assert.equal(parseDownloadUrl(memo.downloadUrl).url.searchParams.get("id"), "a b/c?d");

  // 이름 안의 콜론은 구분자와 섞이지 않게 "_"로 — 글로 놓을 때(text/plain)는 원래 이름
  const colon = widgetDragOutData(
    { id: "x", name: "회의:10:30.txt", mimeType: "text/plain" },
    origin,
    same,
  );
  assert.deepEqual(parseDownloadUrl(colon.downloadUrl), {
    mime: "text/plain",
    name: "회의_10_30.txt",
    url: new URL("http://localhost:3100/api/drive/download?id=x"),
  });
  assert.equal(colon.text, "회의:10:30.txt");

  // mime이 없거나 비면 application/octet-stream
  for (const mimeType of [null, ""]) {
    const blank = widgetDragOutData({ id: "y", name: "data.bin", mimeType }, origin, same);
    assert.equal(parseDownloadUrl(blank.downloadUrl).mime, "application/octet-stream", String(mimeType));
  }

  // 이름은 우클릭 메뉴의 내려받기와 같은 규칙 — 구글 문서는 PDF로 받아지므로 .pdf가 붙는다
  const doc = widgetDragOutData(
    { id: "g", name: "보고서", mimeType: "application/vnd.google-apps.document" },
    origin,
    same,
  );
  assert.equal(parseDownloadUrl(doc.downloadUrl).name, "보고서.pdf");
});

test("drag-out url carries the space prefix through apiPath (#29)", () => {
  const saved = (globalThis as { window?: unknown }).window;
  const setPath = (pathname: string) => {
    (globalThis as { window?: unknown }).window = { location: { pathname } };
  };
  const file = { id: "f1", name: "a.txt", mimeType: "text/plain" };
  try {
    setPath("/sea/files");
    assert.equal(
      widgetDragOutData(file, "https://desk.example.com", apiPath).downloadUrl,
      "text/plain:a.txt:https://desk.example.com/sea/api/drive/download?id=f1",
    );
    setPath("/files");
    assert.equal(
      widgetDragOutData(file, "https://desk.example.com", apiPath).downloadUrl,
      "text/plain:a.txt:https://desk.example.com/api/drive/download?id=f1",
    );
  } finally {
    if (saved === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = saved;
    }
  }
});

test("배선: 끌어내기 — 서랍의 파일 아이콘만 끌리고, 끄는 동안 벽 붙임을 붙잡는다 (#29)", async () => {
  const view = await readFile(new URL("../src/app/widget/WidgetView.tsx", import.meta.url), "utf8");

  // 파일만 끌린다 — 폴더는 draggable={false}
  assert.match(view, /draggable=\{!entry\.isFolder\}/);
  assert.match(
    view,
    /onDragStart=\{entry\.isFolder \? undefined : \(event\) => onIconDragStart\(event, entry\)\}/,
  );
  assert.match(view, /onDragEnd=\{entry\.isFolder \? undefined : \(\) => setDraggingOut\(false\)\}/);

  // dragstart: 복사로, DownloadURL(절대 주소 — 스페이스 프리픽스는 apiPath)과 파일 이름을 싣는다
  assert.match(
    view,
    /function onIconDragStart\(event: DragEvent<HTMLElement>, entry: Entry\) \{\s*const data = widgetDragOutData\(entry, window\.location\.origin, apiPath\);\s*event\.dataTransfer\.effectAllowed = "copy";\s*event\.dataTransfer\.setData\(WIDGET_DRAG_OUT_TYPE, data\.downloadUrl\);\s*event\.dataTransfer\.setData\("text\/plain", data\.text\);\s*setDraggingOut\(true\);/,
  );

  // 끌어내는 동안은 커서가 창을 떠나도 접지 않는다
  assert.match(view, /const hold = contextMenu !== null \|\| uploading \|\| dragOver \|\| draggingOut;/);

  // 서랍 밖→안 업로드는 파일 드래그(types에 Files)만 받는다 — 자기 아이콘 끌기는 업로드가 아니다
  assert.match(view, /function onDragOver\(event: DragEvent<HTMLElement>\) \{\s*if \(!event\.dataTransfer\.types\.includes\("Files"\)\) return;/);
});

// ── 업로드 공용 흐름 ──────────────────────────────────────────────────

const messages = {
  driveFailed: "drive failed",
  sessionExpired: "expired",
  uploadFailed: "upload failed",
};

function fakeFile(name: string, size: number, type = "text/plain"): File {
  return new File([new Uint8Array(size)], name, { type });
}

test("direct upload: session → PUT to drive → upload-complete with the reservation", async () => {
  const requests: Array<{ pathname: string; body: unknown }> = [];
  const uploads: Array<{ url: string; method: string; contentType: string | null }> = [];
  let heartbeatStopped = 0;
  const id = await uploadEntry(fakeFile("a.txt", 3), "folder-1", {
    apiJson: async <T,>(pathname: string, init: RequestInit) => {
      requests.push({ pathname, body: JSON.parse(String(init.body)) });
      if (pathname === "/api/drive/upload-session") {
        return {
          mode: "direct",
          url: "https://drive.example/upload",
          reservationId: "res-1",
        } as T;
      }
      return {} as T;
    },
    onProgress: () => undefined,
    onSessionExpired: () => assert.fail("must not expire"),
    messages,
    upload: async (url, method, _body, contentType) => {
      uploads.push({ url, method, contentType });
      return { status: 200, responseText: JSON.stringify({ id: "file-9" }) };
    },
    heartbeat: () => () => {
      heartbeatStopped += 1;
    },
  });
  assert.equal(id, "file-9");
  assert.deepEqual(uploads, [
    { url: "https://drive.example/upload", method: "PUT", contentType: null },
  ]);
  assert.deepEqual(
    requests.map((request) => request.pathname),
    ["/api/drive/upload-session", "/api/drive/upload-complete"],
  );
  assert.deepEqual(requests[0].body, {
    parentId: "folder-1",
    name: "a.txt",
    mimeType: "text/plain",
    size: 3,
  });
  assert.deepEqual(requests[1].body, { reservationId: "res-1", fileId: "file-9" });
  assert.equal(heartbeatStopped, 1);
});

test("proxy upload: POST through the server, 401 reports an expired session", async () => {
  let expired = 0;
  const deps = {
    apiJson: async <T,>() => ({ mode: "proxy", reservationId: "res-2" }) as T,
    onProgress: () => undefined,
    onSessionExpired: () => {
      expired += 1;
    },
    messages,
    heartbeat: () => () => undefined,
  };
  const uploaded: string[] = [];
  const id = await uploadEntry(fakeFile("b bin.dat", 2, ""), "root", {
    ...deps,
    upload: async (url, method, _body, contentType) => {
      uploaded.push(`${method} ${url} ${contentType}`);
      return {
        status: 201,
        responseText: JSON.stringify({ entry: { id: "entry-2" } }),
      };
    },
  });
  assert.equal(id, "entry-2");
  assert.deepEqual(uploaded, [
    "POST /api/drive/upload?parentId=root&name=b%20bin.dat&reservationId=res-2 application/octet-stream",
  ]);

  await assert.rejects(
    uploadEntry(fakeFile("c.txt", 1), "root", {
      ...deps,
      upload: async () => ({ status: 401, responseText: "" }),
    }),
    /expired/,
  );
  assert.equal(expired, 1);

  await assert.rejects(
    uploadEntry(fakeFile("d.txt", 1), "root", {
      ...deps,
      upload: async () => ({
        status: 413,
        responseText: JSON.stringify({ error: "too big" }),
      }),
    }),
    /too big/,
  );
});

test("direct upload failure stops the heartbeat and surfaces the drive error", async () => {
  let heartbeatStopped = 0;
  await assert.rejects(
    uploadEntry(fakeFile("e.txt", 1), "root", {
      apiJson: async <T,>() =>
        ({ mode: "direct", url: "https://drive.example/u", reservationId: "r" }) as T,
      onProgress: () => undefined,
      onSessionExpired: () => undefined,
      messages,
      upload: async () => ({ status: 500, responseText: "" }),
      heartbeat: () => () => {
        heartbeatStopped += 1;
      },
    }),
    /drive failed/,
  );
  assert.equal(heartbeatStopped, 1);
});
