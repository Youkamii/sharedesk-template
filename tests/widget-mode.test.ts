import assert from "node:assert/strict";
import test from "node:test";
import {
  isWidgetRequest,
  parseWidgetCookie,
  WIDGET_COOKIE,
} from "../src/lib/widget-mode";

test("widget cookie name matches the shell constant", () => {
  // widget/src-tauri/src/lib.rs의 WIDGET_COOKIE와 같아야 한다
  assert.equal(WIDGET_COOKIE, "sharedesk_widget");
});

test("only a version-shaped cookie value counts as the widget shell", () => {
  assert.deepEqual(parseWidgetCookie("0.1.0"), { version: "0.1.0" });
  assert.deepEqual(parseWidgetCookie(" 1.2.3-beta.1 "), { version: "1.2.3-beta.1" });
  assert.equal(isWidgetRequest("12.0.7"), true);
  // 없거나 모양이 다르면 웹 화면이다
  assert.equal(parseWidgetCookie(undefined), null);
  assert.equal(parseWidgetCookie(null), null);
  assert.equal(parseWidgetCookie(""), null);
  assert.equal(parseWidgetCookie("1"), null);
  assert.equal(parseWidgetCookie("true"), null);
  assert.equal(parseWidgetCookie("0.1.0; evil"), null);
  assert.equal(parseWidgetCookie("0.1.0-" + "x".repeat(40)), null);
  assert.equal(isWidgetRequest("yes"), false);
});
