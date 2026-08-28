import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  isTextEntryTarget,
  pastedFileName,
} from "../src/lib/client/paste-upload";

const AT = new Date(2026, 7, 28, 14, 5, 38);

test("스크린샷 붙여넣기는 image.png 대신 시각이 붙은 이름을 쓴다 (#14)", () => {
  assert.equal(
    pastedFileName({ name: "image.png", type: "image/png" }, AT),
    "붙여넣기 20260828-140538.png",
  );
  assert.equal(
    pastedFileName({ name: "", type: "image/jpeg" }, AT),
    "붙여넣기 20260828-140538.jpg",
  );
  assert.equal(
    pastedFileName({ name: "IMAGE.PNG", type: "image/png" }, AT),
    "붙여넣기 20260828-140538.png",
    "브라우저마다 대소문자가 달라도 같은 이름 규칙을 쓴다",
  );
});

test("이름이 있는 파일은 붙여넣어도 그 이름을 지킨다 (#14)", () => {
  assert.equal(
    pastedFileName({ name: "보고서.pdf", type: "application/pdf" }, AT),
    "보고서.pdf",
  );
  assert.equal(
    pastedFileName({ name: "설계 초안.png", type: "image/png" }, AT),
    "설계 초안.png",
  );
});

test("글자 입력 칸에 붙여넣는 중이면 가로채지 않는다 (#14)", () => {
  // 최소한의 DOM 흉내 — closest만 쓰므로 실제 DOM 없이 확인할 수 있다.
  const field = (
    tagName: string,
    extra: Record<string, unknown> = {},
  ): EventTarget => {
    const node = { tagName, type: "text", readOnly: false, disabled: false, ...extra };
    return {
      ...node,
      isContentEditable: false,
      closest: (selector: string) =>
        selector.includes(tagName.toLowerCase()) ? node : null,
    } as unknown as EventTarget;
  };

  assert.equal(isTextEntryTarget(field("INPUT")), true);
  assert.equal(isTextEntryTarget(field("TEXTAREA")), true);
  // 만들어진 링크를 보여주는 읽기 전용 칸은 붙여넣어도 잃을 게 없다.
  assert.equal(isTextEntryTarget(field("INPUT", { readOnly: true })), false);
  assert.equal(
    isTextEntryTarget(field("INPUT", { type: "checkbox" })),
    false,
    "1시간 뒤 삭제 체크박스에서도 붙여넣기가 살아 있어야 한다",
  );
  assert.equal(isTextEntryTarget(null), false);
});

test("붙여넣기 리스너는 창이 맨 앞일 때만 붙는다 (#14)", async () => {
  const source = await readFile(
    new URL("../src/app/files/QuickLinkWindow.tsx", import.meta.url),
    "utf8",
  );

  // 다른 창을 쓰는 중에 Ctrl+V가 여기로 새면 안 된다.
  assert.match(source, /if \(!active \|\| minimized\) return;/);
  assert.match(source, /window\.addEventListener\("paste", onPaste\)/);
  assert.match(source, /window\.removeEventListener\("paste", onPaste\)/);
  // 클립보드에 파일이 없으면(글자만) 기본 동작을 막지 않는다.
  assert.match(source, /if \(files\.length === 0\) return;\s*\n\s*event\.preventDefault\(\);/);
});
