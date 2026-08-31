import assert from "node:assert/strict";
import test from "node:test";
import { encodeQr, qrSvgPath } from "../src/lib/client/qr-code";

// 포맷 정보(M × 마스크 0~7) — 인코더와 같은 표. 행렬에서 읽어낸 15비트가
// 이 중 하나여야 하고, 그 인덱스가 곧 쓰인 마스크다.
const FORMAT_M = [
  0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0,
];

function readFormat(modules: boolean[][]): number {
  const size = modules.length;
  // 사본 2에서 표준 배치(ISO 18004)대로 읽는다: 오른쪽 위 행 8비트 +
  // 왼쪽 아래 열 7비트. 인코더와 같은 커스텀 규약으로 읽으면 배치가
  // 통째로 틀려도 통과해 버린다 — 실제로 그랬다(red-review).
  let bits = 0;
  for (let i = 0; i <= 7; i += 1) {
    bits |= (modules[8][size - 1 - i] ? 1 : 0) << i;
  }
  for (let i = 8; i <= 14; i += 1) {
    bits |= (modules[size - 15 + i][8] ? 1 : 0) << i;
  }
  return bits;
}

function finderOk(modules: boolean[][], left: number, top: number): boolean {
  for (let dy = 0; dy <= 6; dy += 1) {
    for (let dx = 0; dx <= 6; dx += 1) {
      const ring = dx === 0 || dx === 6 || dy === 0 || dy === 6;
      const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
      if (modules[top + dy][left + dx] !== (ring || core)) return false;
    }
  }
  return true;
}

test("짧은 링크는 버전 1(21×21), 세 모서리에 파인더가 선다", () => {
  const qr = encodeQr("https://a.io/x");
  assert.equal(qr.version, 1);
  assert.equal(qr.size, 21);
  assert.equal(qr.modules.length, 21);
  assert.ok(finderOk(qr.modules, 0, 0), "왼쪽 위 파인더");
  assert.ok(finderOk(qr.modules, 21 - 7, 0), "오른쪽 위 파인더");
  assert.ok(finderOk(qr.modules, 0, 21 - 7), "왼쪽 아래 파인더");
});

test("타이밍 패턴은 6행·6열에서 흑백이 번갈아 선다", () => {
  const qr = encodeQr("https://example.com/share/abcdef");
  for (let i = 8; i < qr.size - 8; i += 1) {
    assert.equal(qr.modules[6][i], i % 2 === 0, `타이밍 행 ${i}`);
    assert.equal(qr.modules[i][6], i % 2 === 0, `타이밍 열 ${i}`);
  }
});

test("포맷 정보는 오류정정 M의 유효한 마스크 코드다", () => {
  for (const text of ["hi", "https://desk.example/api/share/" + "a".repeat(48)]) {
    const bits = readFormat(encodeQr(text).modules);
    assert.ok(
      FORMAT_M.includes(bits),
      `포맷 비트 ${bits.toString(2)}가 M 표에 없다`,
    );
  }
});

test("긴 주소는 버전이 올라가고 다크 모듈과 버전 정보가 제자리에 있다", () => {
  // 실제 간이 링크 꼴(원본 오리진 + 48-hex 토큰)보다 훨씬 긴 값.
  const url = "https://youkamii-sharedesk.vercel.app/api/share/" + "f".repeat(96);
  const qr = encodeQr(url);
  assert.ok(qr.version >= 5, `버전이 예상보다 낮다: ${qr.version}`);
  assert.equal(qr.size, 17 + 4 * qr.version);
  // 다크 모듈 (8, 4v+9).
  assert.equal(qr.modules[4 * qr.version + 9][8], true);
  if (qr.version >= 7) {
    // 버전 정보 두 사본이 서로 전치 관계다.
    for (let i = 0; i < 18; i += 1) {
      const a = Math.floor(i / 3);
      const b = qr.size - 11 + (i % 3);
      assert.equal(qr.modules[b][a], qr.modules[a][b], `버전 정보 비트 ${i}`);
    }
  }
});

test("같은 입력은 항상 같은 행렬이 나온다 (결정적)", () => {
  const a = encodeQr("https://example.com/join?code=ABC123");
  const b = encodeQr("https://example.com/join?code=ABC123");
  assert.deepEqual(a.modules, b.modules);
});

test("담을 수 없는 길이는 명확히 거절한다", () => {
  assert.throws(() => encodeQr("x".repeat(214)), /너무 깁니다/);
  // 경계값은 들어간다 (버전 10, payload 213바이트).
  assert.equal(encodeQr("x".repeat(213)).version, 10);
});

test("SVG 패스는 quiet zone을 지키고 어두운 칸 수와 일치한다", () => {
  const qr = encodeQr("https://a.io/x");
  const path = qrSvgPath(qr.modules, 1, 4);
  const rects = path.match(/M\d+ \d+h1v1h-1z/g) ?? [];
  const dark = qr.modules.flat().filter(Boolean).length;
  assert.equal(rects.length, dark);
  // 모든 칸이 quiet zone(4) 이상에서 시작한다.
  for (const rect of rects) {
    const [, x, y] = rect.match(/M(\d+) (\d+)/)!;
    assert.ok(Number(x) >= 4 && Number(y) >= 4);
  }
});

// ── 실디코더 교차 검증 ───────────────────────────────────────────────
// 구조 테스트는 인코더와 같은 가정을 공유하면 함께 틀릴 수 있다 — 실제로
// 포맷 배치가 역순인데 자체 리더도 역순으로 읽어 통과했었다(red-review).
// 독립 구현(jsQR, devDependency)으로 "폰이 읽는가"를 직접 판정한다.
import jsQR from "jsqr";

function rasterize(modules: boolean[][], scale = 4, quiet = 4) {
  const size = (modules.length + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < modules.length; y += 1) {
    for (let x = 0; x < modules.length; x += 1) {
      if (!modules[y][x]) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const index =
            (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4;
          data[index] = 0;
          data[index + 1] = 0;
          data[index + 2] = 0;
        }
      }
    }
  }
  return { data, width: size, height: size };
}

test("독립 디코더(jsQR)가 모든 버전대의 QR을 원문 그대로 읽는다", () => {
  const samples = [
    "https://a.io/x",
    "https://youkamii-sharedesk.vercel.app/join?code=ABCD-EFGH-IJKL-MNOP",
    "https://youkamii-sharedesk.vercel.app/api/share/" + "f".repeat(48),
    "한글 링크도 그대로 https://example.com/공유",
    "x".repeat(180),
  ];
  for (const text of samples) {
    const qr = encodeQr(text);
    const image = rasterize(qr.modules);
    const decoded = jsQR(image.data, image.width, image.height);
    assert.ok(decoded, `디코드 실패 (v${qr.version}): ${text.slice(0, 40)}…`);
    assert.equal(decoded!.data, text, `내용 불일치 (v${qr.version})`);
  }
});
