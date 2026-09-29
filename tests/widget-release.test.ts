import assert from "node:assert/strict";
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
