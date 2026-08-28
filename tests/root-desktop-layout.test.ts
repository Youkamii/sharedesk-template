import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  moveRootDesktopGroup,
  normalizeRootDesktopLayout,
  rootPlacementOverlapsTrash,
  ROOT_DESKTOP_HEIGHT,
  ROOT_DESKTOP_WIDTH,
  ROOT_ICON_HEIGHT,
  ROOT_ICON_WIDTH,
  type RootDesktopPlacement,
} from "../src/lib/client/root-desktop-layout";

function entries(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    layoutKey: `entry-${String(index).padStart(3, "0")}`,
  }));
}

function defaultPlacement(index: number): RootDesktopPlacement {
  return {
    x: 12 + (index % 6) * 96,
    y: 10 + Math.floor(index / 6) * 104,
    version: 0,
  };
}

function assertInside(placement: RootDesktopPlacement) {
  assert.ok(placement.x >= 0);
  assert.ok(placement.y >= 0);
  assert.ok(placement.x + ROOT_ICON_WIDTH <= ROOT_DESKTOP_WIDTH);
  assert.ok(placement.y + ROOT_ICON_HEIGHT <= ROOT_DESKTOP_HEIGHT);
}

function overlaps(
  left: RootDesktopPlacement,
  right: RootDesktopPlacement,
) {
  return (
    left.x < right.x + ROOT_ICON_WIDTH &&
    left.x + ROOT_ICON_WIDTH > right.x &&
    left.y < right.y + ROOT_ICON_HEIGHT &&
    left.y + ROOT_ICON_HEIGHT > right.y
  );
}

test("ROOT의 화면 안 저장 좌표는 그대로 둔다", () => {
  const input = entries(3);
  const stored = {
    [input[0].layoutKey]: { x: 0, y: 0, version: 2 },
    [input[1].layoutKey]: { x: 481, y: 217, version: 5 },
    [input[2].layoutKey]: { x: 900, y: 400, version: 9 },
  };

  const normalized = normalizeRootDesktopLayout(input, stored);

  input.forEach((entry) => {
    assert.deepEqual(
      normalized.positions[entry.layoutKey],
      stored[entry.layoutKey],
    );
  });
  assert.deepEqual(normalized.corrections, []);
});

test("휴지통과 겹쳐 저장된 ROOT 좌표도 안전한 자리로 보정한다", () => {
  const [entry] = entries(1);
  const stored = { x: 1192, y: 534, version: 9 };
  const normalized = normalizeRootDesktopLayout([entry], {
    [entry.layoutKey]: stored,
  });

  assert.notDeepEqual(normalized.positions[entry.layoutKey], stored);
  assert.equal(
    rootPlacementOverlapsTrash(normalized.positions[entry.layoutKey]),
    false,
  );
  assert.deepEqual(normalized.corrections, [
    {
      layoutKey: entry.layoutKey,
      placement: normalized.positions[entry.layoutKey],
    },
  ]);
});

test("31개와 36개의 기존 기본 배치를 유지하고 77개까지 안전 격자 안에 둔다", () => {
  for (const count of [31, 36]) {
    const input = entries(count);
    const normalized = normalizeRootDesktopLayout(input, {});
    input.forEach((entry, index) => {
      assert.deepEqual(
        normalized.positions[entry.layoutKey],
        defaultPlacement(index),
      );
    });
    assert.deepEqual(normalized.corrections, []);
  }

  // 손잡이 폭(20px)만 뺀 유효 영역의 최대 수용량은 77이다(#14).
  const input = entries(77);
  const normalized = normalizeRootDesktopLayout(input, {});
  const placements = input.map((entry) => normalized.positions[entry.layoutKey]);
  placements.forEach(assertInside);
  placements.forEach((placement, index) => {
    placements.slice(index + 1).forEach((other) => {
      assert.equal(overlaps(placement, other), false);
    });
    assert.equal(rootPlacementOverlapsTrash(placement), false);
  });
  assert.deepEqual(normalized.corrections, []);
  assert.deepEqual(normalized.unresolvedLayoutKeys, []);
});

test("예전의 화면 밖 좌표를 즉시 공통 ROOT 경계 안으로 당긴다", () => {
  const [entry] = entries(1);
  const normalized = normalizeRootDesktopLayout([entry], {
    [entry.layoutKey]: { x: 1500, y: 800, version: 1 },
  });

  // 우측 한계는 손잡이 폭만 뺀 1172다(#14).
  assert.deepEqual(normalized.positions[entry.layoutKey], {
    x: 1068,
    y: 530,
    version: 1,
  });
  assert.equal(
    rootPlacementOverlapsTrash(normalized.positions[entry.layoutKey]),
    false,
  );
  assert.deepEqual(normalized.corrections, [
    {
      layoutKey: entry.layoutKey,
      placement: normalized.positions[entry.layoutKey],
    },
  ]);
});

test("저장 좌표가 아직 없는 optimistic 항목은 PATCH 보정 대상으로 만들지 않는다", () => {
  const [entry] = entries(1);
  const normalized = normalizeRootDesktopLayout([entry], {});

  assert.deepEqual(normalized.positions[entry.layoutKey], defaultPlacement(0));
  assert.deepEqual(normalized.corrections, []);
});

test("77개의 서버 기본 좌표를 겹침과 휴지통 없이 빽빽하게 보정한다", () => {
  const input = entries(77);
  const stored = Object.fromEntries(
    input.map((entry, index) => [
      entry.layoutKey,
      { ...defaultPlacement(index), version: 1 },
    ]),
  );

  const normalized = normalizeRootDesktopLayout(input, stored);
  const placements = input.map((entry) => normalized.positions[entry.layoutKey]);
  placements.forEach((placement, index) => {
    assertInside(placement);
    assert.equal(rootPlacementOverlapsTrash(placement), false);
    placements.slice(index + 1).forEach((other) => {
      assert.equal(overlaps(placement, other), false);
    });
  });
  assert.equal(normalized.corrections.length, 41);
  assert.deepEqual(normalized.unresolvedLayoutKeys, []);
});

test("77번째 항목은 커스텀 좌표를 보존하며 남은 기본 아이콘을 촘촘히 채운다", () => {
  const input = entries(77);
  const stored = Object.fromEntries(
    input.slice(0, 76).map((entry, index) => [
      entry.layoutKey,
      { ...defaultPlacement(index), version: 1 },
    ]),
  );
  stored[input[0].layoutKey] = { x: 13, y: 10, version: 1 };

  const normalized = normalizeRootDesktopLayout(input, stored);
  const custom = normalized.positions[input[0].layoutKey];
  assert.deepEqual(custom, stored[input[0].layoutKey]);
  assert.equal(
    normalized.corrections.some(
      ({ layoutKey }) => layoutKey === input[0].layoutKey,
    ),
    false,
  );
  const placements = input.map((entry) => normalized.positions[entry.layoutKey]);
  placements.forEach((placement, index) => {
    assertInside(placement);
    assert.equal(rootPlacementOverlapsTrash(placement), false);
    placements.slice(index + 1).forEach((other) => {
      assert.equal(overlaps(placement, other), false);
    });
  });
  assert.deepEqual(normalized.unresolvedLayoutKeys, []);
});

test("두 커스텀 좌표에 맞춘 격자로 76개 아이콘을 겹침 없이 채운다", () => {
  const input = entries(76);
  const stored = {
    [input[0].layoutKey]: { x: 13, y: 10, version: 7 },
    [input[1].layoutKey]: { x: 189, y: 10, version: 8 },
  };

  const normalized = normalizeRootDesktopLayout(input, stored);
  input.slice(0, 2).forEach((entry) => {
    assert.deepEqual(normalized.positions[entry.layoutKey], stored[entry.layoutKey]);
    assert.equal(
      normalized.corrections.some(
        ({ layoutKey }) => layoutKey === entry.layoutKey,
      ),
      false,
    );
  });
  const placements = input.map((entry) => normalized.positions[entry.layoutKey]);
  placements.forEach((placement, index) => {
    assertInside(placement);
    assert.equal(rootPlacementOverlapsTrash(placement), false);
    placements.slice(index + 1).forEach((other) => {
      assert.equal(overlaps(placement, other), false);
    });
  });
  assert.deepEqual(normalized.unresolvedLayoutKeys, []);
});

test("물리 한계를 넘으면 겹친 좌표를 보정 목록에 넣어 영구 저장하지 않는다", () => {
  const input = entries(84);
  const stored = Object.fromEntries(
    input.map((entry, index) => [
      entry.layoutKey,
      { ...defaultPlacement(index), version: 1 },
    ]),
  );

  const normalized = normalizeRootDesktopLayout(input, stored);
  Object.values(normalized.positions).forEach((placement) => {
    assertInside(placement);
    assert.equal(rootPlacementOverlapsTrash(placement), false);
  });
  const corrected = normalized.corrections.map(({ placement }) => placement);
  assert.equal(corrected.length, 83);
  corrected.forEach((placement, index) => {
    assert.equal(rootPlacementOverlapsTrash(placement), false);
    corrected.slice(index + 1).forEach((other) => {
      assert.equal(overlaps(placement, other), false);
    });
  });
  assert.deepEqual(normalized.unresolvedLayoutKeys, [input[83].layoutKey]);
  assert.equal(
    normalized.corrections.some(
      ({ layoutKey }) => layoutKey === input[83].layoutKey,
    ),
    false,
  );
});

test("커스텀 좌표가 슬롯을 넘쳐도 표시 위치는 휴지통 아래로 들어가지 않는다", () => {
  const input = entries(84);
  const stored = Object.fromEntries(
    input.map((entry, index) => [
      entry.layoutKey,
      { x: 1500 + index, y: 800 + index, version: index + 1 },
    ]),
  );

  const normalized = normalizeRootDesktopLayout(input, stored);
  Object.values(normalized.positions).forEach((placement) => {
    assertInside(placement);
    assert.equal(rootPlacementOverlapsTrash(placement), false);
  });
  assert.equal(normalized.corrections.length, 83);
  assert.deepEqual(
    normalized.unresolvedLayoutKeys,
    [input[83].layoutKey],
  );
  normalized.unresolvedLayoutKeys.forEach((layoutKey) => {
    assert.equal(
      normalized.corrections.some(
        (correction) => correction.layoutKey === layoutKey,
      ),
      false,
    );
  });
});

test("경계로 당긴 좌표가 겹치면 비어 있는 13x6 격자로 옮긴다", () => {
  const [fixed, legacy] = entries(2);
  const normalized = normalizeRootDesktopLayout([fixed, legacy], {
    [fixed.layoutKey]: { x: 1192, y: 534, version: 3 },
    [legacy.layoutKey]: { x: 1500, y: 800, version: 4 },
  });
  const moved = normalized.positions[legacy.layoutKey];

  assertInside(moved);
  assert.equal(overlaps(normalized.positions[fixed.layoutKey], moved), false);
  assert.equal(moved.version, 4);
});

test("화면 밖 좌표의 충돌 결과는 목록 순서와 상관없이 같다", () => {
  const [alpha, beta] = entries(2);
  const stored = {
    [alpha.layoutKey]: { x: 1500, y: 800, version: 1 },
    [beta.layoutKey]: { x: 1500, y: 800, version: 2 },
  };

  const forward = normalizeRootDesktopLayout([alpha, beta], stored);
  const reverse = normalizeRootDesktopLayout([beta, alpha], stored);

  assert.deepEqual(
    forward.positions[alpha.layoutKey],
    reverse.positions[alpha.layoutKey],
  );
  assert.deepEqual(
    forward.positions[beta.layoutKey],
    reverse.positions[beta.layoutKey],
  );
});

test("ROOT 묶음 드래그는 같은 delta를 써서 상대 간격을 보존한다", () => {
  const start = [
    { x: 100, y: 120, version: 1 },
    { x: 260, y: 210, version: 2 },
  ];
  const moved = moveRootDesktopGroup(start, 2_000, 2_000);

  // 우측 한계는 사이드바 예약 폭을 뺀 960이다(#14).
  assert.deepEqual(moved, [
    { x: 942, y: 444, version: 1 },
    { x: 1102, y: 534, version: 2 },
  ]);
  assert.equal(moved[1].x - moved[0].x, start[1].x - start[0].x);
  assert.equal(moved[1].y - moved[0].y, start[1].y - start[0].y);
  moved.forEach(assertInside);
  moved.forEach((placement) => {
    assert.equal(rootPlacementOverlapsTrash(placement), false);
  });

  const returned = moveRootDesktopGroup(moved, -2_000, -2_000);
  assert.deepEqual(returned, [
    { x: 0, y: 0, version: 1 },
    { x: 160, y: 90, version: 2 },
  ]);
});

test("사이드바가 없는 스페이스는 우측을 예약하지 않는다 (#14 11)", () => {
  const [entry] = entries(1);
  // 기본 데스크는 손잡이 폭(20px)만 피한다 — x=1180이 1172로 살짝 당겨진다.
  const reserved = normalizeRootDesktopLayout([entry], {
    [entry.layoutKey]: { x: 1180, y: 300, version: 4 },
  });
  assert.deepEqual(reserved.positions[entry.layoutKey], {
    x: 1172,
    y: 300,
    version: 4,
  });
  // 스페이스에는 손잡이가 없으니 그 자리가 그대로다.
  const open = normalizeRootDesktopLayout(
    [entry],
    { [entry.layoutKey]: { x: 1180, y: 300, version: 4 } },
    { reserveSidebar: false },
  );
  assert.deepEqual(open.positions[entry.layoutKey], {
    x: 1180,
    y: 300,
    version: 4,
  });
  assert.deepEqual(open.corrections, [], "보정도 저장도 하지 않는다");

  // 드래그 한계도 같은 규칙을 따른다.
  const dragged = moveRootDesktopGroup(
    [{ x: 900, y: 300, version: 1 }],
    2_000,
    0,
    { reserveSidebar: false },
  );
  assert.equal(dragged[0].x, ROOT_DESKTOP_WIDTH - ROOT_ICON_WIDTH);
});

test("ROOT만 스크롤을 막고 폴더 평면과 기존 CAS 저장 흐름은 유지한다", async () => {
  const [source, css, route] = await Promise.all([
    readFile(new URL("../src/app/files/FilesView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/files/desktop.module.css", import.meta.url), "utf8"),
    readFile(
      new URL("../src/app/api/desktop/layout/route.ts", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(css, /\.iconCanvas \{[\s\S]*?overflow: auto;/);
  assert.match(css, /\.rootCanvas \{[\s\S]*?overflow: hidden;/);
  assert.match(source, /const dimensions = isRoot \? null : planeDimensions/);
  assert.match(source, /\{ width: "100%", height: "100%" \}/);
  assert.match(
    source,
    /queueRootDesktopCorrectionsRef\.current = \([\s\S]*?corrections,[\s\S]*?expectedRevision,[\s\S]*?correctionToken,[\s\S]*?queuePlacementBatch\(/,
  );
  assert.match(source, /expectedRevision: first\.node\.expectedRevision/);
  assert.match(source, /expectedRevision: node\.expectedRevision/);
  assert.match(source, /if \(options\.blockDrag\) savingPositionKeysRef\.current\.add\(key\)/);
  assert.match(source, /rootCorrectionToken: correctionToken,[\s\S]*?blockDrag: true/);
  const batchPump = source.slice(
    source.indexOf("async function pumpBatchSave"),
    source.indexOf("function isActiveSave"),
  );
  const singlePump = source.slice(
    source.indexOf("async function pumpSave"),
    source.indexOf("// 포인터 아래의 이동 대상"),
  );
  assert.doesNotMatch(
    batchPump,
    /catch \(error\) \{[\s\S]*?rootDesktopCorrectionAttemptRef\.current = ""/,
  );
  assert.doesNotMatch(
    singlePump,
    /catch \(error\) \{[\s\S]*?rootDesktopCorrectionAttemptRef\.current = ""/,
  );
  assert.match(
    batchPump,
    /await loadRoot\(true\)[\s\S]*?deferRootDesktopCorrectionRetry\(first\.node\)/,
  );
  assert.match(
    singlePump,
    /await loadRoot\(true\)[\s\S]*?deferRootDesktopCorrectionRetry\(node\)/,
  );
  assert.match(
    source,
    /if \(retry\.retried \|\| retry\.timer !== null\) return;[\s\S]*?window\.setTimeout\([\s\S]*?current\.retried = true/,
  );
  assert.match(
    source,
    /const trackRootDesktopCorrectionToken = useCallback\([\s\S]*?\.token === token\) return;[\s\S]*?resetRootDesktopCorrectionRetry\(token\)/,
  );
  assert.match(
    source,
    /const timer = rootDesktopCorrectionRetryRef\.current\.timer;[\s\S]*?window\.clearTimeout\(timer\)/,
  );
  assert.match(
    route,
    /value\.expectedRevision !== undefined[\s\S]*?value\.expectedRevision as number \| undefined/,
  );
  assert.match(source, /scopeId === ROOT_SCOPE[\s\S]*?moveRootDesktopGroup\(/);
});
