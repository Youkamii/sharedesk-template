// 구글 드라이브가 If-Match 조건부 쓰기를 실제로 집행하는지 실측한다.
// 이동(parents 교체) 충돌 방지 설계(#8)의 전제 검증 — 스테일 ETag 패치는 412로
// 거부되어야 한다. 루트 폴더 아래 숨김 테스트 폴더를 만들고 끝나면 영구 삭제한다.
//
// 실행: node scripts/verify-ifmatch.mjs

import { readFile } from "node:fs/promises";

const V2 = "https://www.googleapis.com/drive/v2";
const V3 = "https://www.googleapis.com/drive/v3";
const V3_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";

async function loadEnv() {
  const text = await readFile(new URL("../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

async function accessToken(env) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`토큰 갱신 실패: HTTP ${res.status}`);
  return (await res.json()).access_token;
}

let TOKEN = "";
async function api(method, url, { body, headers = {}, raw = false } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body && !raw ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body && !raw ? JSON.stringify(body) : body,
  });
  return res;
}

async function json(res) {
  return res.json();
}

async function mkFolder(name, parentId) {
  const res = await api("POST", `${V3}/files?fields=id`, {
    body: { name, mimeType: FOLDER_MIME, parents: [parentId] },
  });
  if (!res.ok) throw new Error(`폴더 생성 실패 ${name}: ${res.status}`);
  return (await json(res)).id;
}

async function etagOf(fileId) {
  const res = await api("GET", `${V2}/files/${fileId}?fields=etag`);
  if (!res.ok) throw new Error(`etag 조회 실패: ${res.status}`);
  const { etag } = await json(res);
  if (!etag) throw new Error("etag 없음");
  return etag;
}

async function parentsOf(fileId) {
  const res = await api("GET", `${V3}/files/${fileId}?fields=parents`);
  return (await json(res)).parents ?? [];
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

const env = await loadEnv();
TOKEN = await accessToken(env);
const root = env.DRIVE_ROOT_FOLDER_ID;
if (!root) throw new Error("DRIVE_ROOT_FOLDER_ID 없음");

const testDir = await mkFolder(`.ifmatch-test-${Date.now()}`, root);
try {
  const dirX = await mkFolder("X", testDir);
  const dirY = await mkFolder("Y", testDir);
  const fileRes = await api("POST", `${V3}/files?fields=id`, {
    body: { name: "probe.txt", parents: [dirX] },
  });
  const fileId = (await json(fileRes)).id;

  // A. v2 메타데이터 패치 — 신선한 ETag는 통과, 스테일 ETag는 412
  const e0 = await etagOf(fileId);
  const a1 = await api("PATCH", `${V2}/files/${fileId}`, {
    body: { title: "probe-renamed.txt" },
    headers: { "If-Match": e0 },
  });
  const a2 = await api("PATCH", `${V2}/files/${fileId}`, {
    body: { title: "probe-should-fail.txt" },
    headers: { "If-Match": e0 },
  });
  record(
    "A. v2 메타데이터 If-Match",
    a1.ok && a2.status === 412,
    `신선=${a1.status}(200 기대) 스테일=${a2.status}(412 기대)`,
  );

  // B. v2 parents 교체(이동) — 신선한 ETag로 X→Y 성공, 스테일 ETag로 Y→X는 412
  const e1 = await etagOf(fileId);
  const b1 = await api(
    "PATCH",
    `${V2}/files/${fileId}?addParents=${dirY}&removeParents=${dirX}`,
    { body: {}, headers: { "If-Match": e1 } },
  );
  const b2 = await api(
    "PATCH",
    `${V2}/files/${fileId}?addParents=${dirX}&removeParents=${dirY}`,
    { body: {}, headers: { "If-Match": e1 } },
  );
  const parentsAfterB = await parentsOf(fileId);
  record(
    "B. v2 이동(parents) If-Match",
    b1.ok && b2.status === 412 && parentsAfterB.join() === dirY,
    `이동=${b1.status}(200 기대) 스테일이동=${b2.status}(412 기대) 최종위치=${
      parentsAfterB.join() === dirY ? "Y(정상)" : "비정상"
    }`,
  );

  // C. 동시 발사 — 같은 ETag로 서로 다른 폴더로 동시에 이동, 정확히 하나만 성공해야 함
  const e2 = await etagOf(fileId);
  const [c1, c2] = await Promise.all([
    api("PATCH", `${V2}/files/${fileId}?addParents=${dirX}&removeParents=${dirY}`, {
      body: {},
      headers: { "If-Match": e2 },
    }),
    api("PATCH", `${V2}/files/${fileId}?addParents=${testDir}&removeParents=${dirY}`, {
      body: {},
      headers: { "If-Match": e2 },
    }),
  ]);
  const okCount = [c1, c2].filter((r) => r.ok).length;
  const rejCount = [c1, c2].filter((r) => r.status === 412).length;
  const parentsAfterC = await parentsOf(fileId);
  record(
    "C. 동시 이동 경쟁",
    okCount === 1 && rejCount === 1 && parentsAfterC.length === 1,
    `성공=${okCount}(1 기대) 412=${rejCount}(1 기대) 최종 parents 수=${parentsAfterC.length}(1 기대)`,
  );

  // D. 기존 CAS가 쓰는 경로 — v3 업로드 PATCH가 If-Match를 집행하는지
  const e3 = await etagOf(fileId);
  const d1 = await api(
    "PATCH",
    `${V3_UPLOAD}/files/${fileId}?uploadType=media`,
    { body: "one", raw: true, headers: { "If-Match": e3, "Content-Type": "text/plain" } },
  );
  const d2 = await api(
    "PATCH",
    `${V3_UPLOAD}/files/${fileId}?uploadType=media`,
    { body: "two", raw: true, headers: { "If-Match": e3, "Content-Type": "text/plain" } },
  );
  // v3 업로드는 If-Match를 조용히 무시한다(2026-08 실측: 스테일도 200).
  // 그래서 CAS는 반드시 v2 업로드를 써야 한다. 아래는 판정에 넣지 않는 기록용.
  console.log(
    `INFO  D. v3 업로드 If-Match — 신선=${d1.status} 스테일=${d2.status} (v3는 집행 안 함 → CAS에 사용 금지)`,
  );

  // E. v2 업로드 PUT이 If-Match를 집행하는지 — D가 실패할 경우의 CAS 대체 경로
  const V2_UPLOAD = "https://www.googleapis.com/upload/drive/v2";
  const e4 = await etagOf(fileId);
  const f1 = await api(
    "PUT",
    `${V2_UPLOAD}/files/${fileId}?uploadType=media`,
    { body: "three", raw: true, headers: { "If-Match": e4, "Content-Type": "text/plain" } },
  );
  const f2 = await api(
    "PUT",
    `${V2_UPLOAD}/files/${fileId}?uploadType=media`,
    { body: "four", raw: true, headers: { "If-Match": e4, "Content-Type": "text/plain" } },
  );
  record(
    "E. v2 업로드 If-Match (대체 CAS 경로)",
    f1.ok && f2.status === 412,
    `신선=${f1.status}(200 기대) 스테일=${f2.status}(412 기대)`,
  );

  // F. 목록(v2 files.list)이 주는 ETag == files.get ETag이고, 그대로 If-Match에
  // 쓸 수 있는지 — 클라이언트가 목록에서 받은 버전으로 이동을 요청하는 전제.
  const fileParents = await parentsOf(fileId);
  const listRes = await api(
    "GET",
    `${V2}/files?q=${encodeURIComponent(`'${fileParents[0]}' in parents and trashed=false`)}&fields=items(id,etag)`,
  );
  const listItems = (await json(listRes)).items ?? [];
  const listEtag = listItems.find((i) => i.id === fileId)?.etag;
  const getEtag = await etagOf(fileId);
  const g1 = await api("PATCH", `${V2}/files/${fileId}`, {
    body: { title: "probe-via-list-etag.txt" },
    headers: { "If-Match": listEtag ?? "missing" },
  });
  record(
    "F. 목록 ETag의 If-Match 사용",
    listEtag !== undefined && listEtag === getEtag && g1.ok,
    `목록==단건: ${listEtag === getEtag} 목록ETag패치=${g1.status}(200 기대)`,
  );
} finally {
  const del = await api("DELETE", `${V3}/files/${testDir}`);
  console.log(`정리: 테스트 폴더 영구 삭제 → HTTP ${del.status}`);
}

const failed = results.filter((r) => !r.pass);
console.log(
  failed.length === 0
    ? `\n결론: ${results.length}개 검증 전부 통과 — If-Match 설계 전제 성립`
    : `\n결론: ${failed.length}개 실패 — 예비안(CAS 저널) 검토 필요`,
);
process.exit(failed.length === 0 ? 0 : 1);
