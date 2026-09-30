import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { selectLatestStableVersion } from "../src/lib/update-status";
import { selectStableRelease } from "../scripts/sharedesk-update.mjs";
import {
  assetUrl,
  mergeLatest,
  platformTarget,
  readWidgetVersion,
  WIDGET_RELEASE_REPOSITORY,
  WIDGET_RELEASE_TAG,
} from "../scripts/widget-release.mjs";
import {
  WIDGET_RELEASE_PAGE_URL,
  WIDGET_WINDOWS_INSTALLER_URL,
  widgetDownloadTarget,
} from "../src/lib/widget-download";

test("the widget rolling release never counts as a stable ShareDesk release", () => {
  // 위젯은 템플릿 저장소의 고정 릴리스(widget, prerelease)에 산다. 웹의 업데이트 확인과
  // updater 스크립트 모두 이 릴리스를 건너뛰고 진짜 웹 릴리스만 골라야 한다.
  const releases = [
    { tag_name: "widget", draft: false, prerelease: true },
    { tag_name: "widget-v0.1.0", draft: false, prerelease: false },
    { tag_name: "v0.9.2", draft: false, prerelease: false },
  ];
  assert.equal(selectLatestStableVersion(releases), "0.9.2");
  assert.equal(selectStableRelease(releases)?.tag_name, "v0.9.2");
  // 웹 릴리스가 하나도 없으면 위젯 릴리스 때문에 엉뚱한 버전이 나오지 않는다
  assert.equal(selectLatestStableVersion(releases.slice(0, 2)), null);
  assert.equal(selectStableRelease(releases.slice(0, 2)), null);
});

test("widget release channel is the public template repository's fixed release", () => {
  assert.equal(WIDGET_RELEASE_REPOSITORY, "Youkamii/sharedesk-template");
  assert.equal(WIDGET_RELEASE_TAG, "widget");
  assert.equal(
    assetUrl("latest.json"),
    "https://github.com/Youkamii/sharedesk-template/releases/download/widget/latest.json",
  );
});

test("the desk sidebar downloads the widget from the release channel's fixed alias (#27)", () => {
  // 사이드바 링크는 발행 스크립트가 올리는 별칭 이름과 한 글자만 달라도 404가 된다.
  const windows = platformTarget("win32", "x64");
  assert.equal(WIDGET_WINDOWS_INSTALLER_URL, assetUrl(windows.latestAlias));
  assert.equal(
    WIDGET_RELEASE_PAGE_URL,
    `https://github.com/${WIDGET_RELEASE_REPOSITORY}/releases/tag/${WIDGET_RELEASE_TAG}`,
  );

  // 브라우저가 Windows라고 말할 때만 설치 파일 직행, 나머지(서버 포함)는 릴리스 페이지.
  assert.deepEqual(
    widgetDownloadTarget("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"),
    { href: WIDGET_WINDOWS_INSTALLER_URL, hint: "Windows" },
  );
  const releasePage = { href: WIDGET_RELEASE_PAGE_URL, hint: "GitHub" };
  assert.deepEqual(
    widgetDownloadTarget("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15"),
    releasePage,
  );
  assert.deepEqual(
    widgetDownloadTarget("Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101"),
    releasePage,
  );
  assert.deepEqual(widgetDownloadTarget("Node.js/22"), releasePage);
  assert.deepEqual(widgetDownloadTarget(undefined), releasePage);
});

test("배선: 사이드바 데스크톱 위젯 칸 — 링크 둘 다 새 탭·noopener, 누르면 닫힘, 화면 언어의 안내 (#27)", async () => {
  const view = await readFile(
    new URL("../src/app/files/FilesView.tsx", import.meta.url),
    "utf8",
  );
  const section = view.match(/styles\.sidebarWidget\b[\s\S]*?<\/section>/)?.[0];
  assert.ok(section, "사이드바에 데스크톱 위젯 칸이 있어야 합니다");
  assert.equal(section.match(/<a\s/g)?.length, 2, "내려받기·안내 링크 두 개");
  assert.equal(section.match(/target="_blank"/g)?.length, 2);
  assert.equal(section.match(/rel="noopener noreferrer"/g)?.length, 2);
  assert.equal(section.match(/setSidebarOpen\(false\)/g)?.length, 2);
  assert.match(section, /WIDGET_DOWNLOAD\.href/);
  assert.match(section, /widgetGuideUrl/);
  assert.match(section, /\{t\("위젯 내려받기"\)\}/);
  assert.match(section, /\{t\("위젯 안내"\)\}/);
  assert.match(view, /docUrl\("WIDGET", locale\)/);

  const css = await readFile(
    new URL("../src/app/files/desktop.module.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.sidebarWidget \{/);
  assert.match(css, /\.sidebarWidgetHint \{/);
});

test("widget version is consistent across tauri.conf.json, Cargo.toml and package.json", () => {
  assert.match(readWidgetVersion(), /^\d+\.\d+\.\d+$/);
});

test("platform targets map to Tauri updater keys and space-free asset names", () => {
  const windows = platformTarget("win32", "x64");
  assert.equal(windows.key, "windows-x86_64");
  assert.equal(windows.assetName("0.1.0"), "sharedesk-widget-0.1.0-windows-x64-setup.exe");
  assert.ok(windows.pattern.test("ShareDesk Widget_0.1.0_x64-setup.exe"));
  const mac = platformTarget("darwin", "arm64");
  assert.equal(mac.key, "darwin-aarch64");
  assert.ok(mac.pattern.test("ShareDesk Widget.app.tar.gz"));
  assert.throws(() => platformTarget("linux", "x64"), /지원하지 않는 플랫폼/);
});

test("latest.json merge keeps same-version platforms and drops stale ones", () => {
  const now = new Date("2026-09-29T00:00:00.000Z");
  const win = { signature: "sig-win", url: assetUrl("sharedesk-widget-0.2.0-windows-x64-setup.exe") };
  const mac = { signature: "sig-mac", url: assetUrl("sharedesk-widget-0.2.0-macos-arm64.app.tar.gz") };
  const first = mergeLatest(null, "0.2.0", "windows-x86_64", win, now);
  assert.deepEqual(first, {
    version: "0.2.0",
    notes: "ShareDesk Widget 0.2.0",
    pub_date: "2026-09-29T00:00:00.000Z",
    platforms: { "windows-x86_64": win },
  });
  // 같은 버전의 맥 항목은 나란히 남는다
  const both = mergeLatest(first, "0.2.0", "darwin-aarch64", mac, now);
  assert.deepEqual(Object.keys(both.platforms).sort(), ["darwin-aarch64", "windows-x86_64"]);
  // 버전이 올라가면 옛 버전의 다른 플랫폼 항목은 버린다 — 업데이터는 최상위 version만 본다
  const next = mergeLatest(both, "0.3.0", "windows-x86_64", { ...win, url: assetUrl("x-0.3.0.exe") }, now);
  assert.deepEqual(Object.keys(next.platforms), ["windows-x86_64"]);
  assert.equal(next.version, "0.3.0");
});
