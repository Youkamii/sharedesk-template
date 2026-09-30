import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  disableWidgetWall,
  enableWidgetWall,
  hideWidgetWindow,
  installStrayDropGuard,
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
  wallHold,
  wallZoneRect,
  WIDGET_HIDDEN_FLAG,
  WIDGET_HIDDEN_POLL_MS,
  WIDGET_LIST_POLL_MS,
  WIDGET_MODE_KEY,
  WIDGET_WALL_HOVER_EVENT,
  WIDGET_WALL_KEY,
  WIDGET_WALL_SIDE_EVENT,
  widgetPollInterval,
  writeWidgetMode,
  writeWidgetWall,
} from "../src/lib/client/widget";
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
  const handle = { left: 326, top: 224, width: 14, height: 72 };
  const viewport = { width: 340, height: 520 };
  assert.equal(WALL_HANDLE_SLACK, 4);
  assert.deepEqual(wallZoneRect(false, handle, viewport), [322, 220, 22, 80]);
  assert.deepEqual(wallZoneRect(true, handle, viewport), [0, 0, 340, 520]);
  // 왼쪽 벽 손잡이는 창 밖(-4)까지 여유를 둔다 — 벽 끝에서 커서가 살짝 벗어나도 붙잡는다
  assert.deepEqual(
    wallZoneRect(false, { left: 0, top: 224, width: 14, height: 72 }, viewport),
    [-4, 220, 22, 80],
  );
});

test("wall hold keeps the widget open for menus, uploads and dragged files (#28)", () => {
  const idle = { menuOpen: false, uploading: false, fileOver: false };
  assert.equal(wallHold(idle), false);
  assert.equal(wallHold({ ...idle, menuOpen: true }), true);
  assert.equal(wallHold({ ...idle, uploading: true }), true);
  assert.equal(wallHold({ ...idle, fileOver: true }), true);
});

test("wall commands go through the shell IPC and an old shell falls back to floating (#28)", async () => {
  // 껍데기가 없으면(브라우저) 켤 수 없고, 끄기·영역 보고는 조용히 넘어간다
  assert.equal(await enableWidgetWall({}), null);
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
  assert.equal(await enableWidgetWall(shell("right")), "right");
  await disableWidgetWall(shell(null));
  await reportWallZone(shell(null), { rect: [322, 220, 22, 80], hold: true });
  assert.deepEqual(calls, [
    ["set_wall_mode", { enabled: true }],
    ["set_wall_mode", { enabled: false }],
    ["set_wall_zone", { zone: { rect: [322, 220, 22, 80], hold: true } }],
  ]);
  // 엉뚱한 답도 켜지지 않은 것으로 본다
  assert.equal(await enableWidgetWall(shell("middle")), null);

  // 옛 껍데기: 명령이 없어 invoke가 거부된다 → null(화면은 떠 있는 위젯 유지 + 안내)
  const oldShell = {
    __TAURI_INTERNALS__: {
      invoke: async (command: string) => {
        throw new Error(`Command ${command} not allowed by ACL`);
      },
    },
  };
  assert.equal(await enableWidgetWall(oldShell), null);
  await assert.doesNotReject(disableWidgetWall(oldShell));
  await assert.doesNotReject(reportWallZone(oldShell, { rect: [0, 0, 1, 1], hold: false }));
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
  assert.match(view, /void reportWallZone\(window, \{\s+rect: wallZoneRect\(wallExpanded,/);
  // 옛 껍데기면 표식을 끄고 업데이트를 안내한다
  assert.match(
    view,
    /writeWidgetWall\(window\.localStorage, false\);[\s\S]{0,120}t\("위젯을 업데이트하면 벽 붙임을 쓸 수 있습니다"\)/,
  );

  // 손잡이: 파일을 끌어와 대면 붙잡아 달라고 한다(dragenter) — 펼침은 껍데기가 정한다
  const handle = view.match(/className=\{styles\.wallHandle\}[\s\S]*?<\/div>/)?.[0];
  assert.ok(handle, "벽 손잡이가 있어야 합니다");
  assert.match(
    handle,
    /onDragEnter=\{\(event\) => \{\s+if \(event\.dataTransfer\.types\.includes\("Files"\)\) setFileOver\(true\);/,
  );
  assert.match(view, /fileOver: fileOver \|\| dragOver/);
  assert.match(view, /menuOpen: contextMenu !== null/);

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
  assert.match(globals, /html\[data-widget\]\[data-widget-wall\] body \{\s+background: transparent;/);
  assert.match(
    css,
    /\.widget\[data-wall="right"\]:not\(\[data-wall-expanded\]\) \{\s+transform: translateX\(100%\);/,
  );
  assert.match(
    css,
    /\.widget\[data-wall="left"\]:not\(\[data-wall-expanded\]\) \{\s+transform: translateX\(-100%\);/,
  );
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
