import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  disableWidgetWall,
  enableWidgetWall,
  finishedGauge,
  installStrayDropGuard,
  isUnsupportedCommandError,
  isWidgetHidden,
  parseWallSide,
  parseWidgetDownload,
  parseWidgetMode,
  parseWidgetWall,
  placementSteps,
  readWidgetMode,
  readWidgetPinned,
  readWidgetWall,
  recentWidgetFiles,
  reportWallZone,
  setWidgetPinned,
  sortWidgetEntries,
  tauriInternals,
  transferGauge,
  WALL_GAUGE_HOLD_MS,
  WALL_HANDLE_SLACK,
  wallZoneRect,
  WIDGET_DOWNLOAD_EVENT,
  WIDGET_HIDDEN_FLAG,
  WIDGET_HIDDEN_POLL_MS,
  WIDGET_LIST_POLL_MS,
  WIDGET_MODE_KEY,
  WIDGET_PINNED_EVENT,
  WIDGET_WALL_HOVER_EVENT,
  WIDGET_WALL_KEY,
  WIDGET_WALL_SIDE_EVENT,
  widgetDownloadUrlData,
  widgetPlacement,
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

test("shell IPC is optional: only a host with an invoke function counts", () => {
  assert.equal(tauriInternals({}), null);
  assert.equal(tauriInternals(null), null);
  assert.equal(tauriInternals({ __TAURI_INTERNALS__: { invoke: "nope" } }), null);
  const invoke = async () => undefined;
  assert.equal(tauriInternals({ __TAURI_INTERNALS__: { invoke } })?.invoke, invoke);
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

const readSource = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

// 껍데기 capability의 권한 목록 — default는 로컬 페이지(첫 실행 화면), remote는 데스크 페이지
async function capabilityPermissions(name: "default" | "remote"): Promise<string[]> {
  const capability = JSON.parse(
    await readSource(`../widget/src-tauri/capabilities/${name}.json`),
  ) as { permissions: string[] };
  return capability.permissions;
}

// generate_handler![...] 안의 명령 목록
function handlerBlock(shell: string): string {
  const block = shell.match(/generate_handler!\[([\s\S]*?)\]/)?.[1];
  assert.ok(block, "lib.rs에 generate_handler!가 있어야 합니다");
  return block;
}

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
    await enableWidgetWall(rejecting("데스크 페이지에서만 쓸 수 있는 명령입니다")),
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
  for (const message of ["창을 벽에 붙이지 못했습니다", "데스크 페이지에서만 쓸 수 있는 명령입니다", "", null]) {
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
  assert.match(view, /const hold = [^;]*\bdragOver\b/);

  // 껍데기 명령과 권한 — 데스크 페이지(remote)만 두 명령을 부른다. 로컬 페이지(default)는 부르지 않으므로 열지 않는다
  for (const command of ["set_wall_mode", "set_wall_zone"]) {
    assert.match(handlerBlock(shell), new RegExp(`\\b${command}\\b`));
    assert.match(build, new RegExp(`"${command}"`));
  }
  const remote = await capabilityPermissions("remote");
  const local = await capabilityPermissions("default");
  for (const permission of ["allow-set-wall-mode", "allow-set-wall-zone"]) {
    assert.ok(remote.includes(permission), `remote: ${permission}`);
    assert.ok(!local.includes(permission), `default: ${permission}`);
  }

  // 벽 붙임 중에는 바탕을 비워 손잡이만 남긴다
  assert.match(view, /root\.setAttribute\("data-widget-wall", ""\)/);
  assert.match(globals, /html\[data-widget\]\[data-widget-wall\] body\s*\{\s*background:\s*transparent/);
  assert.match(css, /\.widget\[data-wall="right"\]:not\(\[data-wall-expanded\]\)\s*\{\s*transform:\s*translateX\(100%\)/);
  assert.match(css, /\.widget\[data-wall="left"\]:not\(\[data-wall-expanded\]\)\s*\{\s*transform:\s*translateX\(-100%\)/);
  // 손잡이는 .widget 밖(body)에 있으므로 색 토큰이 문서 뿌리(html[data-widget] 또는 :root)에 있어야 한다.
  // --peach·--ink는 입장 화면 카드(#6)가 웹에서도 읽도록 :root로 올렸다.
  assert.match(globals, /(?::root|html\[data-widget\])\s*\{[^}]*--peach:/);
  assert.doesNotMatch(css, /\.widget\s*\{[^}]*--peach:/);
});

// ── 압정 (#30) ──────────────────────────────────────────────────────────

test("placement is one of floating / wall / pinned, and wall wins a conflict (#30)", () => {
  assert.equal(widgetPlacement(false, false), "floating");
  // 껍데기가 답하기 전·옛 껍데기는 압정이 아니다
  assert.equal(widgetPlacement(false, "unknown"), "floating");
  assert.equal(widgetPlacement(false, "unsupported"), "floating");
  assert.equal(widgetPlacement(false, true), "pinned");
  assert.equal(widgetPlacement(true, false), "wall");
  // 벽 붙임을 켜면 껍데기가 압정을 푼다 — 둘 다 켜진 것으로 보이면 벽이다
  assert.equal(widgetPlacement(true, true), "wall");
});

test("switching placement turns the other mode off first (#30)", () => {
  // 떠 있기에서는 누른 쪽만 켠다
  assert.deepEqual(placementSteps("floating", "pinned"), [{ pinned: true }]);
  assert.deepEqual(placementSteps("floating", "wall"), [{ wall: true }]);
  // 켜진 쪽을 다시 누르면 끄기만
  assert.deepEqual(placementSteps("pinned", "pinned"), [{ pinned: false }]);
  assert.deepEqual(placementSteps("wall", "wall"), [{ wall: false }]);
  // 반대편이 켜져 있으면 먼저 끄고 켠다 — 두 배치가 함께 켜지는 순간이 없다
  assert.deepEqual(placementSteps("wall", "pinned"), [{ wall: false }, { pinned: true }]);
  assert.deepEqual(placementSteps("pinned", "wall"), [{ pinned: false }, { wall: true }]);
});

test("pin commands go through the shell IPC; an old shell reads as unsupported (#30)", async () => {
  // 껍데기가 없으면(브라우저) 압정을 쓸 수 없다
  assert.equal(await readWidgetPinned({}), "unsupported");
  assert.equal(await setWidgetPinned({}, true), null);

  const calls: Array<[string, unknown]> = [];
  const shell = (answer: unknown) => ({
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args?: unknown) => {
        calls.push([command, args]);
        return answer;
      },
    },
  });
  // 두 명령 모두 지금 상태(bool)를 답한다
  assert.equal(await readWidgetPinned(shell(true)), true);
  assert.equal(await readWidgetPinned(shell(false)), false);
  assert.equal(await readWidgetPinned(shell(null)), false);
  assert.equal(await readWidgetPinned(shell({ pinned: true })), false);
  assert.equal(await setWidgetPinned(shell(true), true), true);
  assert.equal(await setWidgetPinned(shell(false), false), false);
  assert.deepEqual(calls.slice(0, 1), [["widget_placement", undefined]]);
  assert.deepEqual(calls.slice(-2), [
    ["set_pinned", { enabled: true }],
    ["set_pinned", { enabled: false }],
  ]);
  // 엉뚱한 답은 바꾸지 못한 것으로 본다
  assert.equal(await setWidgetPinned(shell("yes"), true), null);

  const rejecting = (reason: unknown) => ({
    __TAURI_INTERNALS__: {
      invoke: async () => {
        throw reason;
      },
    },
  });
  // 옛 껍데기(없는·막힌 명령)는 unsupported — 단추를 누르면 업데이트 안내
  assert.equal(await readWidgetPinned(rejecting("Command widget_placement not found")), "unsupported");
  assert.equal(
    await readWidgetPinned(rejecting("Command widget_placement not allowed by ACL")),
    "unsupported",
  );
  // 새 껍데기가 답하지 못한 것은 꺼짐으로 본다
  assert.equal(await readWidgetPinned(rejecting("데스크 페이지에서만 쓸 수 있는 명령입니다")), false);
  assert.equal(await setWidgetPinned(rejecting("데스크 페이지에서만 쓸 수 있는 명령입니다"), true), null);
  assert.equal(await setWidgetPinned(rejecting("벽 붙임을 먼저 끄세요"), true), null);
});

test("배선: 머리띠 단추 — ↗·– 없이 서랍·창가 | 벽·압정, 압정은 껍데기 설정이 원본 (#30)", async () => {
  const view = await readSource("../src/app/widget/WidgetView.tsx");
  const band = await readSource("../src/app/widget/WidgetBand.tsx");
  const frame = await readSource("../src/app/widget/WidgetFrame.tsx");
  const helpers = await readSource("../src/lib/client/widget.ts");
  const shell = await readSource("../widget/src-tauri/src/lib.rs");
  const build = await readSource("../widget/src-tauri/build.rs");

  // 머리띠 자체(로그인·가입 화면의 WidgetFrame 포함)에는 숨기기 단추가 없다 — 숨기기는 트레이
  assert.doesNotMatch(band, /<button/);
  assert.doesNotMatch(band, /hideWidgetWindow|hide_widget/);
  assert.doesNotMatch(helpers, /hideWidgetWindow/);
  assert.match(frame, /<WidgetBand title="ShareDesk" \/>/);

  // 데스크 머리띠: 단추 넷이 서랍·창가 | 벽·압정 순서, ↗(브라우저 열기)는 없다
  const bandSection = view.match(/<WidgetBand title=\{placeTitle\}>[\s\S]*?<\/WidgetBand>/)?.[0];
  assert.ok(bandSection, "WidgetView에 머리띠가 있어야 합니다");
  assert.equal(bandSection.match(/<button/g)?.length, 4);
  const labels = [...bandSection.matchAll(/\{t\("(서랍|창가|벽|압정)"\)\}/g)].map(([, label]) => label);
  assert.deepEqual(labels, ["서랍", "창가", "벽", "압정"]);
  assert.doesNotMatch(bandSection, /↗|openInBrowser|–/);
  assert.match(bandSection, /aria-pressed=\{placement === "wall"\}/);
  assert.match(bandSection, /aria-pressed=\{placement === "pinned"\}/);
  // 껍데기가 답하기 전에는 압정 단추를 잠근다
  assert.match(bandSection, /disabled=\{pinned === "unknown"\}/);
  assert.match(bandSection, /title=\{t\("바탕화면에 압정처럼 고정 — 다른 창 뒤, 바탕화면 위에 머무릅니다"\)\}/);
  assert.match(bandSection, /togglePlacement\("wall"\)/);
  assert.match(bandSection, /togglePlacement\("pinned"\)/);
  // 브라우저에서 열기는 서랍 우클릭 메뉴에 남는다
  assert.match(view, /onClick=\{openInBrowser\}>\s*\{t\("브라우저에서 데스크 열기"\)\}/);

  // 상호 배타는 placementSteps(순수 함수, 위 테스트)의 차례를 따른다 — 벽 끄기·압정 바꾸기는 껍데기 명령으로
  assert.match(view, /useState<PinState>\("unknown"\)/);
  assert.match(view, /widgetPlacement\(wallOn, pinned\)/);
  assert.match(view, /placementSteps\(placement, pressed\)/);
  assert.match(view, /disableWidgetWall\(window\)/);
  assert.match(view, /setWidgetPinned\(window, step\.pinned\)/);
  // 옛 껍데기(unsupported)일 때만 업데이트 안내
  assert.match(view, /pinned === "unsupported"/);
  assert.match(view, /t\("위젯을 업데이트하면 압정을 쓸 수 있습니다"\)/);
  // 로드 때 껍데기에서 읽고, 껍데기가 바꾸면 이벤트로 따라간다
  assert.match(view, /readWidgetPinned\(window\)/);
  assert.match(view, /document\.addEventListener\(WIDGET_PINNED_EVENT, onPinned\)/);
  assert.equal(WIDGET_PINNED_EVENT, "sharedesk:widget-pinned");
  assert.match(shell, /const PINNED_EVENT: &str = "sharedesk:widget-pinned";/);
  assert.match(helpers, /invoke\("widget_placement"\)/);
  assert.match(helpers, /invoke\("set_pinned", \{ enabled \}\)/);

  // 껍데기 명령과 권한: 데스크 페이지(remote)만 연다
  for (const command of ["widget_placement", "set_pinned", "hide_widget"]) {
    assert.match(handlerBlock(shell), new RegExp(`\\b${command}\\b`));
    assert.match(build, new RegExp(`"${command}"`));
  }
  const remote = await capabilityPermissions("remote");
  const local = await capabilityPermissions("default");
  for (const permission of ["allow-widget-placement", "allow-set-pinned", "allow-hide-widget"]) {
    assert.ok(remote.includes(permission), `remote: ${permission}`);
  }
  // 로컬 페이지(첫 실행 화면)는 자기가 부르는 것만
  assert.deepEqual(
    [...local].sort(),
    [
      "allow-hide-widget",
      "allow-save-desk-url",
      "allow-widget-info",
      "core:default",
      "core:window:allow-start-dragging",
    ],
  );

  // 원격에 연 명령은 명령 안에서 다시 원점을 거른다 — hide_widget은 로컬 첫 실행 화면도 받는다
  assert.match(shell, /fn hide_widget\([^)]*\)[^{]*\{\s*require_page\(&window, true\)\?;/);
  for (const command of ["set_wall_mode", "set_wall_zone", "widget_placement", "set_pinned"]) {
    assert.match(
      shell,
      new RegExp(`fn ${command}\\([^)]*\\)[^{]*\\{\\s*require_page\\(&window, false\\)\\?;`),
      command,
    );
  }

  // z 플래그는 한 규칙(settings::z_flags)으로, 시작 때 압정은 빌더 플래그로
  assert.match(shell, /settings::z_flags\(/);
  assert.match(shell, /\.always_on_bottom\(settings\.pinned\)/);
  // 벽 붙임은 붙이기에 성공한 뒤에야 압정을 푼다 (실패하면 압정 그대로)
  const wallMode = shell.slice(shell.indexOf("fn set_wall_mode("), shell.indexOf("fn set_wall_zone("));
  assert.ok(wallMode.indexOf("snap_to_wall(") < wallMode.indexOf("set_pinned_state("), "snap → unpin");
  // 압정 중 트레이 "항상 위"는 꺼진 것으로 보인다
  assert.match(shell, /settings\.always_on_top && !settings\.pinned,/);
});

// ── 전송 게이지 (#31) ──────────────────────────────────────────────────

test("transfer gauge sums active transfers and skips unknown sizes (#31)", () => {
  // 빈 목록·크기를 아는 전송이 없음: null (전송이 있는지는 호출부가 목록 길이로 안다)
  assert.equal(transferGauge([]), null);
  assert.equal(transferGauge([{ transferred: 5, total: null }]), null);
  assert.equal(transferGauge([{ transferred: 0, total: 0 }]), null);
  // 합산: (30 + 10) / (100 + 100)
  assert.equal(
    transferGauge([
      { transferred: 30, total: 100 },
      { transferred: 10, total: 100 },
    ]),
    0.2,
  );
  // 크기를 모르는 전송은 분모·분자에서 뺀다
  assert.equal(
    transferGauge([
      { transferred: 50, total: 200 },
      { transferred: 999, total: null },
    ]),
    0.25,
  );
  // 묶음(D1): 이미 끝나 목록에서 빠진 전송은 다 한 것으로, 아직 시작 안 한 파일(0)도 분모에 든다 —
  // 파일마다 0부터 다시 차지 않는다
  assert.equal(
    transferGauge(
      [
        { transferred: 0, total: 9 },
        { transferred: 0, total: 9 },
      ],
      [{ total: 9 }],
    ),
    1 / 3,
  );
  assert.equal(
    transferGauge(
      [{ transferred: 3, total: 9 }],
      [{ total: 9 }, { total: 9 }, { total: null }],
    ),
    21 / 27,
  );
  // 끝난 것만 남고 진행 중인 것이 크기를 모르면 끝난 것으로만 센다
  assert.equal(transferGauge([{ transferred: 1, total: null }], [{ total: 4 }]), 1);
  // 보고가 크기를 넘거나 음수여도 0..1 안
  assert.equal(transferGauge([{ transferred: 150, total: 100 }]), 1);
  assert.equal(transferGauge([{ transferred: -5, total: 100 }]), 0);
});

test("a finished batch shows red if any transfer failed or was cancelled (#31)", () => {
  const ok = { result: "ok" } as const;
  const failed = { result: "failed" } as const;
  assert.equal(finishedGauge([]), null);
  assert.equal(finishedGauge([ok]), "done");
  assert.equal(finishedGauge([ok, ok, ok]), "done");
  // 성공·실패가 섞이면 빨강
  assert.equal(finishedGauge([ok, failed, ok]), "failed");
  assert.equal(finishedGauge([failed]), "failed");
  assert.deepEqual(WALL_GAUGE_HOLD_MS, { done: 1_000, failed: 3_000 });
});

test("배선: 업로드 중에도 접히고, 접힌 손잡이 테두리가 전송 게이지가 된다 (#31)", async () => {
  const view = await readSource("../src/app/widget/WidgetView.tsx");
  const css = await readSource("../src/app/widget/widget.module.css");
  const globals = await readSource("../src/app/globals.css");
  const notice = await readSource("../src/lib/client/use-auto-dismiss-notice.ts");

  // 올리는 중은 더 이상 붙잡지 않는다 — 커서가 떠나면 접힌다
  assert.doesNotMatch(view, /const hold = [^;]*\buploading\b/);

  // 게이지: 합산 진행률은 --gauge-ratio로 넘기고, 묶음 결과로 끝 표시를 고른다
  assert.match(view, /transferGauge\(activeTransfers, settled\)/);
  assert.match(view, /finishedGauge\(settled\)/);
  assert.match(view, /WALL_GAUGE_HOLD_MS\[finished\]/);
  assert.match(view, /"--gauge-ratio": String\(gaugeRatio\)/);
  assert.match(view, /data-gauge=\{gaugeState\}/);
  assert.match(view, /recordTransferResult\("failed", file\.size\)/);
  assert.match(view, /recordTransferResult\("ok", file\.size\)/);
  // 묶음 진행률(D1): 놓는 순간 모든 파일을 전송 목록에 0부터 올린다
  assert.match(view, /kind: "upload",\s*name: file\.name,\s*transferred: 0,\s*total: file\.size,/);

  // 접힌 동안은 알림이 저절로 사라지지 않는다 — 펼치면 그때부터 센다
  assert.match(view, /useAutoDismissNotice\(NOTICE_DURATION_MS\.default, wallFolded\)/);
  assert.match(notice, /paused = false/);
  assert.match(notice, /\[notice, paused\]/);

  // CSS: 손잡이 테두리 자리에 초록 테두리를 겹쳐 위쪽을 2px 칸으로 잘라 낸다(round 없는 엔진은 칸 없이)
  assert.match(css, /\.wallHandle\[data-gauge\]::after \{[^}]*border: 2px solid var\(--leaf\);/);
  assert.match(css, /round\(down, var\(--gauge-ratio, 0\) \* 100%, 2px\)/);
  assert.match(css, /@supports not \(width: round\(down, 1px, 1px\)\)/);
  assert.match(css, /\.wallHandle\[data-gauge="failed"\]::after \{\s*border-color: var\(--error\);/);
  assert.match(css, /\.wallHandle\[data-gauge="unknown"\]::after \{\s*animation: gaugeBlink 1\.2s/);
  // 손잡이는 body에 있으므로 초록 토큰도 html[data-widget]에
  assert.match(globals, /html\[data-widget\]\s*\{[^}]*--leaf:/);
  assert.doesNotMatch(css, /--leaf:/);
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

test("DownloadURL is mime:name:url with a safe mime and a colon-free name (#29)", () => {
  const url = "http://localhost:3100/api/drive/download?id=a%20b";
  assert.equal(
    widgetDownloadUrlData({ name: "memo.txt", mimeType: "text/plain" }, url),
    `text/plain:memo.txt:${url}`,
  );

  // 이름 안의 콜론은 구분자와 섞이지 않게 "_"로
  const colon = widgetDownloadUrlData({ name: "회의:10:30.txt", mimeType: "text/plain" }, url);
  assert.equal(parseDownloadUrl(colon).name, "회의_10_30.txt");

  // mime이 없거나 비면 application/octet-stream
  for (const mimeType of [null, ""]) {
    const blank = widgetDownloadUrlData({ name: "data.bin", mimeType }, url);
    assert.equal(parseDownloadUrl(blank).mime, "application/octet-stream", String(mimeType));
  }

  // mime에 콜론이 섞여도 칸이 밀리지 않는다 — 데스크 주소에서 원래 이름으로 받는다
  const forged = parseDownloadUrl(
    widgetDownloadUrlData(
      { name: "report.pdf", mimeType: "application/pdf:b.exe:https://evil.example/p" },
      url,
    ),
  );
  assert.equal(forged.mime, "application/octet-stream");
  assert.equal(forged.name, "report.pdf");
  assert.equal(forged.url.host, "localhost:3100");

  // 이름은 우클릭 메뉴의 내려받기와 같은 규칙 — 구글 문서는 PDF로 받아지므로 .pdf가 붙는다
  const doc = widgetDownloadUrlData(
    { name: "보고서", mimeType: "application/vnd.google-apps.document" },
    url,
  );
  assert.equal(parseDownloadUrl(doc).name, "보고서.pdf");
});

test("배선: 끌어내기 — 서랍의 파일 아이콘만 끌리고, 끄는 동안 벽 붙임을 붙잡는다 (#29)", async () => {
  const view = await readFile(new URL("../src/app/widget/WidgetView.tsx", import.meta.url), "utf8");

  // 파일만 끌린다 — 폴더는 draggable={false}이고 dragstart도 폴더면 아무것도 싣지 않는다
  assert.match(view, /draggable=\{!entry\.isFolder\}/);
  assert.match(view, /if \(entry\.isFolder\) return;/);

  // dragstart: 복사로, DownloadURL만 싣는다 — text/plain을 실으면 맥에서 .textClipping이 생길 수 있다
  assert.match(view, /effectAllowed = "copy"/);
  assert.match(view, /setData\(\s*"DownloadURL"/);
  assert.doesNotMatch(view, /setData\("text\/plain"/);

  // 절대 주소는 우클릭 내려받기와 같은 내려받기 경로(apiPath — 스페이스 프리픽스)
  assert.match(view, /encodeURIComponent\(entry\.id\)/);
  assert.match(view, /\$\{window\.location\.origin\}\$\{downloadPath\(entry\)\}/);
  assert.match(view, /const url = downloadPath\(entry\);/);

  // 끄는 중인지는 끌던 id가 지금 서랍 목록에 있는지로 판정한다 — 끄는 도중 아이콘이 사라져
  // onDragEnd가 오지 않아도 hold가 영영 남지 않게
  assert.match(view, /setDragOutId\(entry\.id\)/);
  assert.match(view, /onDragEnd=\{\(\) => setDragOutId\(null\)\}/);
  assert.match(
    view,
    /const draggingOut =\s*dragOutId !== null && mode === "desk" && sorted\.some\(\(entry\) => entry\.id === dragOutId\);/,
  );
  // 아이콘이 사라지면 끌던 id를 렌더 중에 바로 비운다 — 같은 id가 되살아나도 hold가 다시 켜지지 않게
  assert.match(view, /if \(dragOutId !== null && !draggingOut\) setDragOutId\(null\);/);
  // 끌어내는 동안은 커서가 창을 떠나도 접지 않는다
  assert.match(view, /const hold = [^;]*\bdraggingOut\b/);

  // 서랍 밖→안 업로드는 파일 드래그(types에 Files)만 받는다 — 자기 아이콘 끌기의 types엔 Files가
  // 없다(실측: ["text/plain","chromium/x-drag-id"])
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

// ── 내려받기 알림 (macOS 껍데기) ──────────────────────────────────────────

test("shell download result accepts only {success: boolean} and keeps a non-empty name", () => {
  assert.deepEqual(parseWidgetDownload({ success: true, name: "a.png" }), { success: true, name: "a.png" });
  assert.deepEqual(parseWidgetDownload({ success: false, name: null }), { success: false, name: null });
  assert.deepEqual(parseWidgetDownload({ success: true, name: "" }), { success: true, name: null });
  assert.deepEqual(parseWidgetDownload({ success: true }), { success: true, name: null });
  for (const bad of [null, undefined, "ok", 1, {}, { success: "yes" }, { name: "a.png" }]) {
    assert.equal(parseWidgetDownload(bad), null, JSON.stringify(bad));
  }
});

test("배선: 맥 내려받기 — 껍데기가 ~/Downloads에 받고 화면이 같은 이름의 이벤트로 알린다", async () => {
  const view = await readSource("../src/app/widget/WidgetView.tsx");
  const shell = await readSource("../widget/src-tauri/src/lib.rs");

  // 껍데기가 쏘는 이벤트 이름과 화면이 듣는 이름이 같아야 한다
  assert.equal(WIDGET_DOWNLOAD_EVENT, "sharedesk:widget-download");
  assert.match(shell, /const DOWNLOAD_EVENT: &str = "sharedesk:widget-download";/);
  assert.match(view, /document\.addEventListener\(WIDGET_DOWNLOAD_EVENT, onDownload\)/);
  assert.match(view, /showNotice\(t\("\{name\}을\(를\) 저장했습니다", \{ name: result\.name \}\)\)/);
  assert.match(view, /showNotice\(t\("다운로드에 실패했습니다"\)\)/);

  // 핸들러와 트레이 앱 정책은 맥 빌드에만 들어간다 — Windows는 저장 대화상자로 직접 받고, Dock은 skip_taskbar가 맡는다
  assert.match(
    shell,
    /#\[cfg\(target_os = "macos"\)\]\s*\{\s*builder = builder\s*\.data_store_identifier\([^)]*\)[\s\S]{0,160}\.on_download\(handle_download\)/,
  );
  assert.match(shell, /#\[cfg\(target_os = "macos"\)\]\s*fn handle_download\(/);
  assert.match(
    shell,
    /#\[cfg\(target_os = "macos"\)\]\s*app\.set_activation_policy\(tauri::ActivationPolicy::Accessory\)/,
  );
  // 맥은 빌더의 항상 위·맨 아래 플래그가 생성 뒤 남지 않아 창을 띄운 직후 z 플래그를 한 번 다시 건다
  assert.match(
    shell,
    /let _ = window\.show\(\);[\s\S]{0,400}#\[cfg\(target_os = "macos"\)\]\s*let _ = apply_z\(&window, settings\.pinned\);/,
  );
});
