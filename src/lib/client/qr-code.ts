// QR 코드 인코더(#15 A-5) — 바이트 모드, 오류정정 M, 버전 1~10 (payload
// 최대 213바이트). 런타임 의존성 0 방침 때문에 자체 구현한다. 외부 요청도
// 없다 — 링크가 화면 밖으로 나가지 않는다.
//
// 구현 범위는 ISO/IEC 18004의 부분집합이다: 링크·초대 코드처럼 짧은
// 문자열만 다루므로 버전 10에서 자른다. 마스크는 8종을 전부 채점해
// 벌점(N1~N4)이 가장 낮은 것을 쓴다.

export interface QrCode {
  version: number;
  size: number;
  // modules[y][x] — true가 어두운 칸.
  modules: boolean[][];
}

// ── GF(256) ──────────────────────────────────────────────────────────
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

// Reed-Solomon 생성 다항식 (차수 degree).
function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= gfMul(poly[j], GF_EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: Uint8Array, degree: number): Uint8Array {
  const generator = rsGenerator(degree);
  const remainder = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[degree - 1] = 0;
    if (factor === 0) continue;
    // generator는 오름차순 계수(인덱스=차수)다. 나눗셈 레지스터는
    // 최고차부터 소거하므로 x^(degree-1-i) 계수를 곱해야 한다 — 순서를
    // 뒤집으면 EC 코드워드 전체가 틀려 스캐너가 읽지 못한다(red-review).
    for (let i = 0; i < degree; i += 1) {
      remainder[i] ^= gfMul(generator[degree - 1 - i], factor);
    }
  }
  return remainder;
}

// ── 버전 표 (오류정정 M) ─────────────────────────────────────────────
// blocks: [블록 수, 블록당 데이터 코드워드] 묶음. ecPerBlock: 블록당 EC.
const VERSIONS: Array<{
  ecPerBlock: number;
  blocks: Array<[count: number, dataCodewords: number]>;
  alignment: number[];
  remainderBits: number;
}> = [
  { ecPerBlock: 10, blocks: [[1, 16]], alignment: [], remainderBits: 0 },
  { ecPerBlock: 16, blocks: [[1, 28]], alignment: [6, 18], remainderBits: 7 },
  { ecPerBlock: 26, blocks: [[1, 44]], alignment: [6, 22], remainderBits: 7 },
  { ecPerBlock: 18, blocks: [[2, 32]], alignment: [6, 26], remainderBits: 7 },
  { ecPerBlock: 24, blocks: [[2, 43]], alignment: [6, 30], remainderBits: 7 },
  { ecPerBlock: 16, blocks: [[4, 27]], alignment: [6, 34], remainderBits: 7 },
  { ecPerBlock: 18, blocks: [[4, 31]], alignment: [6, 22, 38], remainderBits: 0 },
  {
    ecPerBlock: 22,
    blocks: [
      [2, 38],
      [2, 39],
    ],
    alignment: [6, 24, 42],
    remainderBits: 0,
  },
  {
    ecPerBlock: 22,
    blocks: [
      [3, 36],
      [2, 37],
    ],
    alignment: [6, 26, 46],
    remainderBits: 0,
  },
  {
    ecPerBlock: 26,
    blocks: [
      [4, 43],
      [1, 44],
    ],
    alignment: [6, 28, 50],
    remainderBits: 0,
  },
];

// 포맷 정보(M × 마스크 0~7) — BCH(15,5) 계산 결과를 상수로 둔다.
const FORMAT_M = [
  0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0,
];

// 버전 정보(버전 7~10) — BCH(18,6).
const VERSION_INFO: Record<number, number> = {
  7: 0x07c94,
  8: 0x085bc,
  9: 0x09a99,
  10: 0x0a4d3,
};

function dataCodewordCount(version: number): number {
  return VERSIONS[version - 1].blocks.reduce(
    (sum, [count, data]) => sum + count * data,
    0,
  );
}

function lengthBits(version: number): number {
  // 바이트 모드: 버전 1~9는 8비트, 10부터 16비트.
  return version <= 9 ? 8 : 16;
}

function pickVersion(byteLength: number): number {
  for (let version = 1; version <= VERSIONS.length; version += 1) {
    const capacityBits = dataCodewordCount(version) * 8;
    const neededBits = 4 + lengthBits(version) + byteLength * 8;
    if (neededBits <= capacityBits) return version;
  }
  throw new Error("QR로 담기에 너무 깁니다 (최대 213바이트)");
}

// ── 비트 → 코드워드 ──────────────────────────────────────────────────
function buildCodewords(bytes: Uint8Array, version: number): Uint8Array {
  const capacity = dataCodewordCount(version);
  const bits: number[] = [];
  const push = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, lengthBits(version));
  for (const byte of bytes) push(byte, 8);
  // 종료자(최대 4비트) + 바이트 경계 정렬.
  push(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  // 채움 바이트.
  const pads = [0xec, 0x11];
  for (let i = 0; codewords.length < capacity; i += 1) {
    codewords.push(pads[i % 2]);
  }
  return Uint8Array.from(codewords);
}

// 블록 분할 → EC 계산 → 교차 배치.
function interleave(codewords: Uint8Array, version: number): Uint8Array {
  const spec = VERSIONS[version - 1];
  const dataBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const [count, size] of spec.blocks) {
    for (let i = 0; i < count; i += 1) {
      dataBlocks.push(codewords.slice(offset, offset + size));
      offset += size;
    }
  }
  const ecBlocks = dataBlocks.map((block) =>
    rsRemainder(block, spec.ecPerBlock),
  );
  const output: number[] = [];
  const maxData = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of dataBlocks) if (i < block.length) output.push(block[i]);
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const block of ecBlocks) output.push(block[i]);
  }
  return Uint8Array.from(output);
}

// ── 행렬 배치 ────────────────────────────────────────────────────────
type Matrix = {
  size: number;
  modules: Uint8Array; // 0/1
  reserved: Uint8Array; // 기능 패턴 자리 1
};

function newMatrix(size: number): Matrix {
  return {
    size,
    modules: new Uint8Array(size * size),
    reserved: new Uint8Array(size * size),
  };
}

function set(matrix: Matrix, x: number, y: number, dark: boolean) {
  const index = y * matrix.size + x;
  matrix.modules[index] = dark ? 1 : 0;
  matrix.reserved[index] = 1;
}

function placeFinder(matrix: Matrix, left: number, top: number) {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const x = left + dx;
      const y = top + dy;
      if (x < 0 || y < 0 || x >= matrix.size || y >= matrix.size) continue;
      const inRing =
        dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6 &&
        (dx === 0 || dx === 6 || dy === 0 || dy === 6);
      const inCore = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
      set(matrix, x, y, inRing || inCore);
    }
  }
}

function placeAlignment(matrix: Matrix, centerX: number, centerY: number) {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const dark =
        Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
      set(matrix, centerX + dx, centerY + dy, dark);
    }
  }
}

function placeFunctionPatterns(matrix: Matrix, version: number) {
  const size = matrix.size;
  placeFinder(matrix, 0, 0);
  placeFinder(matrix, size - 7, 0);
  placeFinder(matrix, 0, size - 7);
  // 타이밍 패턴.
  for (let i = 8; i < size - 8; i += 1) {
    if (!matrix.reserved[6 * size + i]) set(matrix, i, 6, i % 2 === 0);
    if (!matrix.reserved[i * size + 6]) set(matrix, 6, i, i % 2 === 0);
  }
  // 정렬 패턴 — 파인더와 겹치는 모서리는 뺀다.
  const centers = VERSIONS[version - 1].alignment;
  for (const cy of centers) {
    for (const cx of centers) {
      const nearFinder =
        (cx <= 8 && cy <= 8) ||
        (cx <= 8 && cy >= size - 9) ||
        (cx >= size - 9 && cy <= 8);
      if (!nearFinder) placeAlignment(matrix, cx, cy);
    }
  }
  // 포맷 정보 자리 예약(값은 마스크 확정 뒤 기록).
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      matrix.reserved[8 * size + i] = 1;
      matrix.reserved[i * size + 8] = 1;
    }
  }
  matrix.reserved[8 * size + 8] = 1;
  // 사본 2 자리 — 오른쪽 위 행 8칸 + 왼쪽 아래 열 7칸. 한 칸이라도 더
  // 예약하면(예: x=size-9) 그 자리는 데이터 모듈이라 지그재그 배치 전체가
  // 밀려 스캔이 깨진다(red-review).
  for (let i = 0; i <= 7; i += 1) {
    matrix.reserved[8 * size + (size - 1 - i)] = 1;
  }
  for (let i = 0; i <= 6; i += 1) {
    matrix.reserved[(size - 1 - i) * size + 8] = 1;
  }
  // 다크 모듈.
  set(matrix, 8, size - 8, true);
  // 버전 정보(7 이상).
  if (version >= 7) {
    const info = VERSION_INFO[version];
    for (let i = 0; i < 18; i += 1) {
      const bit = (info >> i) & 1;
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      set(matrix, a, b, bit === 1);
      set(matrix, b, a, bit === 1);
    }
  }
}

// 데이터 지그재그 배치 — 오른쪽 아래에서 두 열씩 오르내리고 6열은 건넌다.
function placeData(matrix: Matrix, codewords: Uint8Array, version: number) {
  const size = matrix.size;
  const totalBits =
    codewords.length * 8 + VERSIONS[version - 1].remainderBits;
  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      const y = upward ? size - 1 - step : step;
      for (const x of [right, right - 1]) {
        const index = y * size + x;
        if (matrix.reserved[index]) continue;
        let dark = false;
        if (bitIndex < codewords.length * 8) {
          const byte = codewords[bitIndex >> 3];
          dark = ((byte >> (7 - (bitIndex & 7))) & 1) === 1;
        }
        // remainder 비트는 0(밝음).
        if (bitIndex < totalBits) matrix.modules[index] = dark ? 1 : 0;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

const MASKS: Array<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(matrix: Matrix, mask: number) {
  const size = matrix.size;
  const pattern = MASKS[mask];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = y * size + x;
      if (!matrix.reserved[index] && pattern(x, y)) {
        matrix.modules[index] ^= 1;
      }
    }
  }
}

function writeFormat(matrix: Matrix, mask: number) {
  const size = matrix.size;
  const bits = FORMAT_M[mask];
  const put = (x: number, y: number, i: number) => {
    matrix.modules[y * size + x] = ((bits >> i) & 1) === 1 ? 1 : 0;
  };
  // 표준 배치(ISO 18004). 처음 구현은 두 사본 모두 진행 방향이 표준과
  // 정반대라 스캐너가 마스크조차 판독하지 못했다(red-review — 자체
  // 테스트는 같은 뒤집힌 규약으로 읽어서 통과했었다).
  // 사본 1: 왼쪽 위 열(비트 0~7, 타이밍 6은 건너뜀) → 행(비트 8~14).
  for (let i = 0; i <= 5; i += 1) put(8, i, i);
  put(8, 7, 6);
  put(8, 8, 7);
  put(7, 8, 8);
  for (let i = 9; i <= 14; i += 1) put(14 - i, 8, i);
  // 사본 2: 오른쪽 위 행(비트 0~7) + 왼쪽 아래 열(비트 8~14).
  for (let i = 0; i <= 7; i += 1) put(size - 1 - i, 8, i);
  for (let i = 8; i <= 14; i += 1) put(8, size - 15 + i, i);
}

// 마스크 벌점(N1~N4).
function penalty(matrix: Matrix): number {
  const size = matrix.size;
  const at = (x: number, y: number) => matrix.modules[y * size + x];
  let score = 0;
  // N1: 같은 색 5연속 이상.
  for (let y = 0; y < size; y += 1) {
    let runColor = at(0, y);
    let runLength = 1;
    for (let x = 1; x < size; x += 1) {
      if (at(x, y) === runColor) runLength += 1;
      else {
        if (runLength >= 5) score += 3 + (runLength - 5);
        runColor = at(x, y);
        runLength = 1;
      }
    }
    if (runLength >= 5) score += 3 + (runLength - 5);
  }
  for (let x = 0; x < size; x += 1) {
    let runColor = at(x, 0);
    let runLength = 1;
    for (let y = 1; y < size; y += 1) {
      if (at(x, y) === runColor) runLength += 1;
      else {
        if (runLength >= 5) score += 3 + (runLength - 5);
        runColor = at(x, y);
        runLength = 1;
      }
    }
    if (runLength >= 5) score += 3 + (runLength - 5);
  }
  // N2: 2×2 같은 색.
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const c = at(x, y);
      if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) {
        score += 3;
      }
    }
  }
  // N3: 1011101 + 밝은 4칸 패턴.
  const needle1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const needle2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (get: (i: number) => number, start: number) => {
    let hit1 = true;
    let hit2 = true;
    for (let i = 0; i < 11; i += 1) {
      const value = get(start + i);
      if (value !== needle1[i]) hit1 = false;
      if (value !== needle2[i]) hit2 = false;
      if (!hit1 && !hit2) return false;
    }
    return true;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x + 11 <= size; x += 1) {
      if (matches((i) => at(i, y), x)) score += 40;
    }
  }
  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y + 11 <= size; y += 1) {
      if (matches((i) => at(x, i), y)) score += 40;
    }
  }
  // N4: 어두운 칸 비율.
  let dark = 0;
  for (const cell of matrix.modules) dark += cell;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

export function encodeQr(text: string): QrCode {
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length);
  const size = 17 + 4 * version;
  const codewords = interleave(buildCodewords(bytes, version), version);

  const base = newMatrix(size);
  placeFunctionPatterns(base, version);
  placeData(base, codewords, version);

  let bestScore = Number.POSITIVE_INFINITY;
  let bestModules: Uint8Array | null = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate: Matrix = {
      size,
      modules: Uint8Array.from(base.modules),
      reserved: base.reserved,
    };
    applyMask(candidate, mask);
    writeFormat(candidate, mask);
    const score = penalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      bestModules = candidate.modules;
    }
  }

  const modules: boolean[][] = [];
  for (let y = 0; y < size; y += 1) {
    const row: boolean[] = [];
    for (let x = 0; x < size; x += 1) {
      row.push(bestModules![y * size + x] === 1);
    }
    modules.push(row);
  }
  return { version, size, modules };
}

// SVG path — quiet zone(기본 4칸)을 좌표에 더해 그린다.
export function qrSvgPath(
  modules: readonly (readonly boolean[])[],
  moduleSize = 1,
  quietZone = 4,
): string {
  const parts: string[] = [];
  for (let y = 0; y < modules.length; y += 1) {
    for (let x = 0; x < modules[y].length; x += 1) {
      if (!modules[y][x]) continue;
      const px = (x + quietZone) * moduleSize;
      const py = (y + quietZone) * moduleSize;
      parts.push(
        `M${px} ${py}h${moduleSize}v${moduleSize}h-${moduleSize}z`,
      );
    }
  }
  return parts.join("");
}
