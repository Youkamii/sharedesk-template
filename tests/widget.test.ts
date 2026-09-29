import assert from "node:assert/strict";
import test from "node:test";
import {
  hideWidgetWindow,
  installStrayDropGuard,
  isWidgetHidden,
  parseWidgetMode,
  readWidgetMode,
  recentWidgetFiles,
  sortWidgetEntries,
  tauriInternals,
  WIDGET_HIDDEN_FLAG,
  WIDGET_HIDDEN_POLL_MS,
  WIDGET_LIST_POLL_MS,
  WIDGET_MODE_KEY,
  widgetPollInterval,
  writeWidgetMode,
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
