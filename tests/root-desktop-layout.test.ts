import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  moveRootDesktopGroup,
  normalizeRootDesktopLayout,
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
    [input[2].layoutKey]: { x: 1192, y: 534, version: 9 },
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

test("31개 이상 기존 기본 배치를 유지하고 78개까지 안전 격자 안에 둔다", () => {
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

  const input = entries(78);
  const normalized = normalizeRootDesktopLayout(input, {});
  const placements = input.map((entry) => normalized.positions[entry.layoutKey]);
  placements.forEach(assertInside);
  placements.forEach((placement, index) => {
    placements.slice(index + 1).forEach((other) => {
      assert.equal(overlaps(placement, other), false);
    });
  });
  assert.deepEqual(normalized.corrections, []);
});

test("예전의 화면 밖 좌표를 즉시 공통 ROOT 경계 안으로 당긴다", () => {
  const [entry] = entries(1);
  const normalized = normalizeRootDesktopLayout([entry], {
    [entry.layoutKey]: { x: 1500, y: 800, version: 1 },
  });

  assert.deepEqual(normalized.positions[entry.layoutKey], {
    x: 1192,
    y: 534,
    version: 1,
  });
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

  assert.deepEqual(moved, [
    { x: 1032, y: 444, version: 1 },
    { x: 1192, y: 534, version: 2 },
  ]);
  assert.equal(moved[1].x - moved[0].x, start[1].x - start[0].x);
  assert.equal(moved[1].y - moved[0].y, start[1].y - start[0].y);
  moved.forEach(assertInside);

  const returned = moveRootDesktopGroup(moved, -2_000, -2_000);
  assert.deepEqual(returned, [
    { x: 0, y: 0, version: 1 },
    { x: 160, y: 90, version: 2 },
  ]);
});

test("ROOT만 스크롤을 막고 폴더 평면과 기존 CAS 저장 흐름은 유지한다", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../src/app/files/FilesView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/files/desktop.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(css, /\.iconCanvas \{[\s\S]*?overflow: auto;/);
  assert.match(css, /\.rootCanvas \{[\s\S]*?overflow: hidden;/);
  assert.match(source, /const dimensions = isRoot \? null : planeDimensions/);
  assert.match(source, /\{ width: "100%", height: "100%" \}/);
  assert.match(
    source,
    /queueRootDesktopCorrectionsRef\.current = \(corrections\) => \{[\s\S]*?queuePlacementBatch\(/,
  );
  assert.match(source, /scopeId === ROOT_SCOPE[\s\S]*?moveRootDesktopGroup\(/);
});
