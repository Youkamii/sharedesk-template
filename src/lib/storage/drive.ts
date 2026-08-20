import { randomUUID } from "node:crypto";
import {
  CreatePermissionOptions,
  DownloadResult,
  EmptyTrashResult,
  Entry,
  ROOT_ID,
  STATE_DIR,
  StateRead,
  StorageAdapter,
  StorageError,
  StoragePermission,
  StorageUsage,
  ShareRole,
  TrashDeleteTarget,
  TrashEntry,
  UploadSession,
  assertUserName,
  assertValidName,
  conflictError,
  stateAccessDenied,
} from "./types";
import {
  isGoogleWorkspacePreviewMime,
  officePreviewImport,
  type OfficePreviewImport,
} from "@/lib/preview";
import { createOfficePreviewFallback } from "@/lib/office-preview-fallback";

// Google Drive v3 REST 어댑터 — googleapis 패키지 없이 fetch만 사용.
// drive.file scope라 이 앱이 만든 파일·폴더만 보인다. 접근 범위 격리는
// scope가 담당하고, 루트 폴더 밖 id는 애초에 조회가 실패한다.

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const V2_API = "https://www.googleapis.com/drive/v2";
const V2_UPLOAD_API = "https://www.googleapis.com/upload/drive/v2";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILE_FIELDS = "id,name,mimeType,size,modifiedTime";
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const TRASH_CONCURRENCY = 4;
const MAX_OFFICE_PREVIEW_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_OFFICE_PREVIEW_PDF_BYTES = 10 * 1024 * 1024;
const OFFICE_PREVIEW_PREFIX = ".sharedesk-preview-";
const OFFICE_PREVIEW_CLEANUP_ATTEMPTS = 3;
const OFFICE_PREVIEW_STALE_MS = 10 * 60 * 1000;
const pendingOfficePreviewCleanupIds = new Set<string>();

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      async () => {
        while (next < items.length) {
          const index = next++;
          results[index] = await task(items[index]);
        }
      },
    ),
  );
  return results;
}

let cachedToken: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.exp) return cachedToken.token;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new StorageError(
      "UPSTREAM",
      "구글 인증 정보가 없습니다 — npm run setup을 먼저 실행하세요",
    );
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new StorageError(
      "UPSTREAM",
      "구글 토큰 갱신에 실패했습니다 — npm run setup으로 재인증이 필요할 수 있습니다",
    );
  }
  const body = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  cachedToken = {
    token: body.access_token,
    exp: Date.now() + (body.expires_in - 60) * 1000,
  };
  return cachedToken.token;
}

function rootFolderId(): string {
  const id = process.env.DRIVE_ROOT_FOLDER_ID;
  if (!id) {
    throw new StorageError(
      "UPSTREAM",
      "루트 폴더가 설정되지 않았습니다 — npm run setup을 먼저 실행하세요",
    );
  }
  return id;
}

function resolveId(id: string): string {
  const real = id === ROOT_ID ? rootFolderId() : id;
  if (!ID_PATTERN.test(real)) {
    throw new StorageError("BAD_ID", "잘못된 id입니다");
  }
  return real;
}

function assertNotRootShareTarget(fileId: string): void {
  if (fileId === rootFolderId()) {
    throw new StorageError("BAD_ID", "루트 폴더 자체는 공유할 수 없습니다");
  }
}

// drive.file scope는 "이 앱이 만든 파일"까지만 좁혀줄 뿐, 그 파일이 나중에 주인 손으로
// ShareDesk 폴더 밖으로 옮겨져도 id만 알면 계속 닿는다. 앱이 약속한 경계는 루트 폴더이므로
// 조상을 따라 올라가 루트 자손임을 직접 확인한다. 휴지통에 든 대상도 여기서 걸러진다.
const MAX_ANCESTOR_HOPS = 32;

// 앱 내부 영역(.sharedesk). 파일 API가 이 폴더나 그 자손에 닿으면 거부한다 —
// 명단이 곧 접근 권한이라 사용자가 읽거나 고칠 수 있으면 안 된다.
let stateDirId: string | null = null;
let stateDirPromise: Promise<string> | null = null;
const stateFileIds = new Map<string, string>();

function assertNotStateArea(id: string): void {
  if (stateDirId && id === stateDirId) throw stateAccessDenied();
}

function forgetStateFile(name: string): void {
  stateFileIds.delete(name);
  stateDirId = null;
  stateDirPromise = null;
}

type StateFolder = {
  id: string;
  name?: string;
  mimeType?: string;
  parents?: string[];
  trashed?: boolean;
  createdTime?: string;
};

function sortStateFolders(files: StateFolder[]): StateFolder[] {
  return [...files].sort(
    (a, b) =>
      (a.createdTime ?? "").localeCompare(b.createdTime ?? "") ||
      a.id.localeCompare(b.id),
  );
}

async function listStateDirs(root: string): Promise<StateFolder[]> {
  const params = new URLSearchParams({
    q: `'${root}' in parents and name='${escapeQuery(STATE_DIR)}' and mimeType='${FOLDER_MIME}' and trashed=false`,
    fields: "files(id,createdTime)",
    pageSize: "1000",
  });
  const found = (await (await driveFetch(`${API}/files?${params}`)).json()) as {
    files: StateFolder[];
  };
  return sortStateFolders(found.files);
}

async function resolveStateDir(): Promise<string> {
  const root = rootFolderId();
  const configured = process.env.DRIVE_STATE_FOLDER_ID?.trim();
  if (configured) {
    if (!ID_PATTERN.test(configured)) {
      throw new StorageError("BAD_ID", "잘못된 상태 폴더 id입니다");
    }
    const response = await driveFetch(
      `${API}/files/${configured}?fields=id,name,mimeType,parents,trashed`,
    );
    const folder = (await response.json()) as StateFolder;
    if (
      folder.name !== STATE_DIR ||
      folder.mimeType !== FOLDER_MIME ||
      folder.trashed ||
      folder.parents?.[0] !== root
    ) {
      throw new StorageError(
        "UPSTREAM",
        "DRIVE_STATE_FOLDER_ID가 ShareDesk 루트의 .sharedesk 폴더가 아닙니다",
      );
    }
    return folder.id;
  }

  const existing = await listStateDirs(root);
  if (existing.length > 1) {
    throw new StorageError(
      "UPSTREAM",
      ".sharedesk 폴더가 여러 개입니다. DRIVE_STATE_FOLDER_ID로 사용할 폴더를 지정해 주세요",
    );
  }
  if (existing[0]) return existing[0].id;

  const created = (await (
    await driveFetch(`${API}/files?fields=id`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({
        name: STATE_DIR,
        mimeType: FOLDER_MIME,
        parents: [root],
      }),
    })
  ).json()) as StateFolder;

  // 다른 인스턴스도 동시에 폴더를 만들었을 수 있다. 생성 뒤 다시 조회해
  // 결정적으로 하나를 고르고, 이 인스턴스가 만든 비선택 폴더만 정확히 치운다.
  const afterCreate = await listStateDirs(root);
  const canonical = afterCreate[0];
  if (!canonical) {
    throw new StorageError("UPSTREAM", ".sharedesk 폴더를 확인하지 못했습니다");
  }
  if (canonical.id !== created.id) {
    await driveFetch(`${API}/files/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ trashed: true }),
    });
  }
  return canonical.id;
}

async function ensureStateDir(): Promise<string> {
  if (stateDirId) return stateDirId;
  if (!stateDirPromise) stateDirPromise = resolveStateDir();
  try {
    stateDirId = await stateDirPromise;
    return stateDirId;
  } finally {
    stateDirPromise = null;
  }
}

async function findStateFile(name: string): Promise<string | null> {
  const cached = stateFileIds.get(name);
  if (cached) return cached;
  const dir = await ensureStateDir();
  const params = new URLSearchParams({
    q: `'${dir}' in parents and name='${escapeQuery(name)}' and trashed=false`,
    fields: "files(id,createdTime)",
    pageSize: "1000",
  });
  const found = (await (await driveFetch(`${API}/files?${params}`)).json()) as {
    files: Array<{ id: string; createdTime?: string }>;
  };
  found.files.sort(
    (a, b) =>
      (a.createdTime ?? "").localeCompare(b.createdTime ?? "") ||
      a.id.localeCompare(b.id),
  );
  if (found.files.length > 1) {
    throw new StorageError(
      "UPSTREAM",
      `${name} 상태 파일이 여러 개라 안전하게 선택할 수 없습니다`,
    );
  }
  const id = found.files[0]?.id ?? null;
  if (id) stateFileIds.set(name, id);
  return id;
}

async function createStateFile(
  name: string,
  body: string,
): Promise<{ id: string; created: boolean }> {
  const dir = await ensureStateDir();
  // 다른 인스턴스가 방금 만들었을 수 있다. 드라이브는 동명 파일을 허용하므로
  // 만들기 직전에 한 번 더 확인해 명단이 둘로 갈리는 것을 줄인다.
  const params = new URLSearchParams({
    q: `'${dir}' in parents and name='${escapeQuery(name)}' and trashed=false`,
    fields: "files(id,createdTime)",
    pageSize: "1000",
  });
  const again = (await (await driveFetch(`${API}/files?${params}`)).json()) as {
    files: Array<{ id: string; createdTime?: string }>;
  };
  again.files.sort(
    (a, b) =>
      (a.createdTime ?? "").localeCompare(b.createdTime ?? "") ||
      a.id.localeCompare(b.id),
  );
  if (again.files.length > 1) {
    throw new StorageError(
      "UPSTREAM",
      `${name} 상태 파일이 여러 개라 안전하게 선택할 수 없습니다`,
    );
  }
  if (again.files[0]) {
    stateFileIds.set(name, again.files[0].id);
    return { id: again.files[0].id, created: false };
  }
  const boundary = `sharedesk-${randomUUID()}`;
  const multipart = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify({ name, parents: [dir] }),
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    body,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const created = (await (
    await driveFetch(`${UPLOAD_API}/files?uploadType=multipart&fields=id`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: multipart,
    })
  ).json()) as { id: string };

  stateFileIds.delete(name);
  const candidates = (await (
    await driveFetch(`${API}/files?${params}`)
  ).json()) as {
    files: Array<{ id: string; createdTime?: string }>;
  };
  candidates.files.sort(
    (a, b) =>
      (a.createdTime ?? "").localeCompare(b.createdTime ?? "") ||
      a.id.localeCompare(b.id),
  );
  const canonical = candidates.files[0];
  if (!canonical) {
    throw new StorageError(
      "UPSTREAM",
      `${name} 상태 파일을 확인하지 못했습니다`,
    );
  }
  if (canonical.id !== created.id) {
    await driveFetch(`${API}/files/${created.id}`, { method: "DELETE" });
    stateFileIds.set(name, canonical.id);
    return { id: canonical.id, created: false };
  }
  stateFileIds.set(name, created.id);
  return { id: created.id, created: true };
}

type AncestryMeta = {
  id: string;
  parents?: string[];
  trashed?: boolean;
};

async function assertInsideRoot(
  id: string,
  initialMeta?: AncestryMeta,
  allowTrashed = false,
): Promise<void> {
  const root = rootFolderId();
  // 내부 영역 id를 모르는 상태에서는 차단 판정을 할 수 없으므로 먼저 확보한다.
  await ensureStateDir();
  assertNotStateArea(id);
  if (id === root) return;

  let current = id;
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop++) {
    const meta =
      hop === 0 && initialMeta?.id === current
        ? initialMeta
        : ((await (
            await driveFetch(
              `${API}/files/${current}?fields=id,parents,trashed`,
            )
          ).json()) as AncestryMeta);
    if (meta.trashed && !allowTrashed) {
      throw new StorageError("NOT_FOUND", "대상이 휴지통에 있습니다");
    }
    const parent = meta.parents?.[0];
    if (!parent) break;
    // 조상 어딘가가 내부 영역이면 그 아래 전부 접근 금지.
    assertNotStateArea(parent);
    if (parent === root) {
      return;
    }
    current = parent;
  }
  throw new StorageError("NOT_FOUND", "공유 폴더 안에 없는 대상입니다");
}

function escapeQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function driveFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const t0 = Date.now();
  const token = await accessToken();
  const tTok = Date.now();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  if (process.env.SHAREDESK_TRACE) {
    const path = url.replace("https://www.googleapis.com", "").slice(0, 70);
    console.log(
      `[drive] ${(init.method ?? "GET").padEnd(6)} ${String(
        Date.now() - t0,
      ).padStart(5)}ms (tok ${tTok - t0}ms) ${path}`,
    );
  }
  if (res.status === 404) {
    throw new StorageError("NOT_FOUND", "대상이 없습니다");
  }
  if (res.status === 409 || res.status === 412) {
    throw conflictError();
  }
  if (res.status === 401 || res.status === 403) {
    throw new StorageError(
      "UPSTREAM",
      "구글 드라이브 접근이 거부되었습니다 (권한/토큰 문제)",
    );
  }
  if (!res.ok) {
    throw new StorageError(
      "UPSTREAM",
      `구글 드라이브 오류 (HTTP ${res.status})`,
    );
  }
  return res;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  parents?: string[];
  trashed?: boolean;
}

type DriveUsageFile = {
  id: string;
  mimeType?: string;
  size?: string;
  parents?: string[];
  trashed?: boolean;
};

async function listUsageFiles(trashed: boolean): Promise<DriveUsageFile[]> {
  const files: DriveUsageFile[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: `trashed=${trashed}`,
      fields: "nextPageToken,files(id,mimeType,size,parents,trashed)",
      pageSize: "1000",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await driveFetch(`${API}/files?${params}`);
    const body = (await response.json()) as {
      files?: DriveUsageFile[];
      nextPageToken?: string;
    };
    files.push(...(body.files ?? []));
    pageToken = body.nextPageToken;
  } while (pageToken);
  return files;
}

function numericBytes(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function readPreviewPdf(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > MAX_OFFICE_PREVIEW_PDF_BYTES) {
    throw new StorageError(
      "UPSTREAM",
      "변환된 PDF가 10 MiB를 넘어 브라우저 미리보기 한도를 초과했습니다.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new StorageError("UPSTREAM", "변환된 PDF를 읽지 못했습니다.");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_OFFICE_PREVIEW_PDF_BYTES) {
        await reader.cancel().catch(() => {});
        throw new StorageError(
          "UPSTREAM",
          "변환된 PDF가 10 MiB를 넘어 브라우저 미리보기 한도를 초과했습니다.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function deleteOfficePreviewFile(id: string): Promise<boolean> {
  for (let attempt = 0; attempt < OFFICE_PREVIEW_CLEANUP_ATTEMPTS; attempt++) {
    try {
      await driveFetch(`${API}/files/${id}`, { method: "DELETE" });
      pendingOfficePreviewCleanupIds.delete(id);
      return true;
    } catch (error) {
      if (error instanceof StorageError && error.code === "NOT_FOUND") {
        pendingOfficePreviewCleanupIds.delete(id);
        return true;
      }
      if (attempt < OFFICE_PREVIEW_CLEANUP_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  }
  pendingOfficePreviewCleanupIds.add(id);
  return false;
}

async function cleanupOfficePreviewFiles(stateFolder: string): Promise<void> {
  for (const id of [...pendingOfficePreviewCleanupIds]) {
    await deleteOfficePreviewFile(id);
  }

  const staleBefore = Date.now() - OFFICE_PREVIEW_STALE_MS;
  for (const trashed of [true, false]) {
    const params = new URLSearchParams({
      q: `'${stateFolder}' in parents and name contains '${OFFICE_PREVIEW_PREFIX}' and trashed=${trashed}`,
      fields: "files(id,name,createdTime)",
      pageSize: "1000",
    });
    const response = await driveFetch(`${API}/files?${params}`);
    const body = (await response.json()) as {
      files?: Array<{ id?: string; name?: string; createdTime?: string }>;
    };
    for (const file of body.files ?? []) {
      const createdAt = file.createdTime ? Date.parse(file.createdTime) : NaN;
      if (
        !file.id ||
        !file.name?.startsWith(OFFICE_PREVIEW_PREFIX) ||
        !Number.isFinite(createdAt) ||
        createdAt > staleBefore
      ) {
        continue;
      }
      await deleteOfficePreviewFile(file.id);
    }
  }
}

async function convertOfficePreview(
  real: string,
  meta: DriveFile,
  officeImport: OfficePreviewImport,
): Promise<DownloadResult> {
  const sourceSize = meta.size === undefined ? null : Number(meta.size);
  if (
    sourceSize !== null &&
    Number.isFinite(sourceSize) &&
    sourceSize > MAX_OFFICE_PREVIEW_SOURCE_BYTES
  ) {
    throw new StorageError(
      "UPSTREAM",
      "원본이 25 MiB를 넘어 브라우저 미리보기 변환 한도를 초과했습니다.",
    );
  }

  const source = await driveFetch(`${API}/files/${real}?alt=media`);
  if (!source.body) {
    throw new StorageError("UPSTREAM", "원본 문서를 읽지 못했습니다.");
  }
  const stateFolder = await ensureStateDir();
  await cleanupOfficePreviewFiles(stateFolder).catch((error) => {
    console.error("[drive] 임시 문서 미리보기 이전 파일 정리 실패", error);
  });
  const uploadHeaders: Record<string, string> = {
    "Content-Type": "application/json; charset=UTF-8",
    "X-Upload-Content-Type": officeImport.sourceMimeType,
  };
  const sourceLength = source.headers.get("content-length") ?? meta.size;
  if (sourceLength && /^\d+$/.test(sourceLength)) {
    uploadHeaders["X-Upload-Content-Length"] = sourceLength;
  }
  const uploadSession = await driveFetch(
    `${UPLOAD_API}/files?uploadType=resumable&fields=id,mimeType,trashed`,
    {
      method: "POST",
      headers: uploadHeaders,
      body: JSON.stringify({
        name: `${OFFICE_PREVIEW_PREFIX}${randomUUID()}`,
        mimeType: officeImport.targetMimeType,
        parents: [stateFolder],
        trashed: true,
      }),
    },
  );
  const uploadUrl = uploadSession.headers.get("location");
  if (!uploadUrl) {
    throw new StorageError("UPSTREAM", "문서 변환 세션을 만들지 못했습니다.");
  }

  let temporaryId: string | null = null;
  try {
    const putHeaders: Record<string, string> = {
      "Content-Type": officeImport.sourceMimeType,
    };
    if (sourceLength && /^\d+$/.test(sourceLength)) {
      putHeaders["Content-Length"] = sourceLength;
    }
    const convertedResponse = await driveFetch(uploadUrl, {
      method: "PUT",
      headers: putHeaders,
      body: source.body,
      duplex: "half",
    } as RequestInit);
    const converted = (await convertedResponse.json()) as {
      id?: string;
      mimeType?: string;
      trashed?: boolean;
    };
    temporaryId = converted.id ?? null;
    if (!temporaryId || converted.mimeType !== officeImport.targetMimeType) {
      throw new StorageError("UPSTREAM", "Google 문서 변환이 끝나지 않았습니다.");
    }
    if (converted.trashed !== true) {
      await driveFetch(`${API}/files/${temporaryId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ trashed: true }),
      });
    }

    const params = new URLSearchParams({ mimeType: "application/pdf" });
    const exported = await driveFetch(
      `${API}/files/${temporaryId}/export?${params.toString()}`,
    );
    const pdf = await readPreviewPdf(exported);
    return {
      stream: new Blob([pdf.buffer as ArrayBuffer]).stream(),
      name: meta.name.toLowerCase().endsWith(".pdf")
        ? meta.name
        : `${meta.name}.pdf`,
      size: pdf.byteLength,
      mimeType: "application/pdf",
      status: 200,
      contentRange: null,
      contentLength: pdf.byteLength,
      acceptRanges: false,
    };
  } finally {
    if (temporaryId) {
      const deleted = await deleteOfficePreviewFile(temporaryId);
      if (!deleted) {
        console.error("[drive] 임시 문서 미리보기 정리 실패", {
          temporaryId,
        });
      }
    }
  }
}

interface DrivePermission {
  id: string;
  type?: string;
  emailAddress?: string;
  role?: string;
  permissionDetails?: Array<{ inherited?: boolean }>;
}

function asStoragePermission(
  permission: DrivePermission,
): StoragePermission | null {
  const details = permission.permissionDetails ?? [];
  const isDirect =
    details.length === 0 || details.some((detail) => detail.inherited === false);
  if (
    !isDirect ||
    permission.type !== "user" ||
    (permission.role !== "reader" && permission.role !== "writer")
  ) {
    return null;
  }
  return { permissionId: permission.id, role: permission.role };
}

function toStoragePermission(permission: DrivePermission): StoragePermission {
  const direct = asStoragePermission(permission);
  if (!direct) {
    throw new StorageError("NOT_FOUND", "관리할 수 있는 직접 권한이 없습니다");
  }
  return direct;
}

function permissionIdPath(permissionId: string): string {
  if (!permissionId || permissionId.length > 256) {
    throw new StorageError("BAD_ID", "잘못된 권한 id입니다");
  }
  return encodeURIComponent(permissionId);
}

async function getDirectPermission(
  fileId: string,
  permissionId: string,
): Promise<StoragePermission> {
  const fields = "id,type,emailAddress,role,permissionDetails(inherited)";
  const response = await driveFetch(
    `${API}/files/${fileId}/permissions/${permissionIdPath(permissionId)}?supportsAllDrives=true&fields=${fields}`,
  );
  return toStoragePermission((await response.json()) as DrivePermission);
}

async function assertNoPermissionForEmail(
  fileId: string,
  email: string,
): Promise<void> {
  let pageToken: string | undefined;
  const target = email.trim().toLowerCase();
  do {
    const params = new URLSearchParams({
      fields:
        "nextPageToken,permissions(id,type,emailAddress,role,permissionDetails(inherited))",
      pageSize: "100",
      supportsAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await driveFetch(
      `${API}/files/${fileId}/permissions?${params}`,
    );
    const body = (await response.json()) as {
      nextPageToken?: string;
      permissions?: DrivePermission[];
    };
    if (
      (body.permissions ?? []).some(
        (permission) =>
          permission.type === "user" &&
          permission.emailAddress?.trim().toLowerCase() === target,
      )
    ) {
      throw new StorageError("CONFLICT", "이미 Drive 권한이 있는 사용자입니다");
    }
    pageToken = body.nextPageToken;
  } while (pageToken);
}

async function findDirectPermissionForEmail(
  fileId: string,
  email: string,
): Promise<StoragePermission | null> {
  let pageToken: string | undefined;
  const target = email.trim().toLowerCase();
  do {
    const params = new URLSearchParams({
      fields:
        "nextPageToken,permissions(id,type,emailAddress,role,permissionDetails(inherited))",
      pageSize: "100",
      supportsAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await driveFetch(
      `${API}/files/${fileId}/permissions?${params}`,
    );
    const body = (await response.json()) as {
      nextPageToken?: string;
      permissions?: DrivePermission[];
    };
    for (const permission of body.permissions ?? []) {
      if (permission.emailAddress?.trim().toLowerCase() !== target) continue;
      const direct = asStoragePermission(permission);
      if (direct) return direct;
    }
    pageToken = body.nextPageToken;
  } while (pageToken);
  return null;
}

// v2 파일 리소스 — 목록·이동은 v2를 쓴다. v2만 항목별 ETag(버전)를 주고,
// If-Match 조건부 쓰기를 실제로 집행하기 때문이다 (scripts/verify-ifmatch.mjs 실측).
interface DriveFileV2 {
  id: string;
  title: string;
  mimeType: string;
  fileSize?: string;
  modifiedDate?: string;
  etag?: string;
}

function toEntry(f: DriveFile, id = f.id): Entry {
  const isFolder = f.mimeType === FOLDER_MIME;
  return {
    id,
    layoutKey: `drive:${f.id}`,
    name: f.name,
    isFolder,
    size: !isFolder && f.size !== undefined ? Number(f.size) : null,
    modifiedAt: f.modifiedTime ?? null,
    mimeType: f.mimeType,
    version: null,
  };
}

function toEntryV2(f: DriveFileV2): Entry {
  const isFolder = f.mimeType === FOLDER_MIME;
  return {
    id: f.id,
    layoutKey: `drive:${f.id}`,
    name: f.title,
    isFolder,
    size: !isFolder && f.fileSize !== undefined ? Number(f.fileSize) : null,
    modifiedAt: f.modifiedDate ?? null,
    mimeType: f.mimeType,
    version: f.etag ?? null,
  };
}

// 같은 폴더에 같은 이름이 이미 있는지 확인 (충돌 정책 통일 — 덮어쓰지 않는다).
async function assertNameFree(parent: string, name: string): Promise<void> {
  const params = new URLSearchParams({
    q: `'${parent}' in parents and name='${escapeQuery(name)}' and trashed=false`,
    fields: "files(id)",
    pageSize: "1",
  });
  const res = await driveFetch(`${API}/files?${params}`);
  const body = (await res.json()) as { files: DriveFile[] };
  if (body.files.length > 0) throw conflictError();
}

export class DriveAdapter implements StorageAdapter {
  async getEntry(id: string): Promise<Entry> {
    const real = resolveId(id);
    await assertInsideRoot(real);
    const res = await driveFetch(`${API}/files/${real}?fields=${FILE_FIELDS}`);
    return toEntry(
      (await res.json()) as DriveFile,
      id === ROOT_ID ? ROOT_ID : real,
    );
  }

  async list(folderId: string): Promise<Entry[]> {
    const folder = resolveId(folderId);
    await assertInsideRoot(folder);
    // v2 files.list — 항목별 ETag를 왕복 추가 없이 받기 위해서다 (이동 OCC에 필요).
    const files: DriveFileV2[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: `'${folder}' in parents and trashed=false`,
        fields:
          "nextPageToken,items(id,title,mimeType,fileSize,modifiedDate,etag)",
        maxResults: "1000",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await driveFetch(`${V2_API}/files?${params}`);
      const body = (await res.json()) as {
        items: DriveFileV2[];
        nextPageToken?: string;
      };
      files.push(...body.items);
      pageToken = body.nextPageToken;
    } while (pageToken);
    // 앱 내부 파일(.sharedesk 등)은 탐색기에 노출하지 않는다.
    const entries = files
      .filter((f) => !f.title.startsWith("."))
      .map((f) => toEntryV2(f));
    entries.sort((a, b) =>
      a.isFolder === b.isFolder
        ? a.name.localeCompare(b.name, "ko")
        : a.isFolder
          ? -1
          : 1,
    );
    return entries;
  }

  async getStorageUsage(): Promise<StorageUsage> {
    const [aboutResponse, activeFiles, trashedFiles] = await Promise.all([
      driveFetch(`${API}/about?fields=storageQuota(limit,usage)`),
      listUsageFiles(false),
      listUsageFiles(true),
    ]);
    const about = (await aboutResponse.json()) as {
      storageQuota?: { limit?: string; usage?: string };
    };
    const files = [...activeFiles, ...trashedFiles];
    const byId = new Map(files.map((file) => [file.id, file]));
    const root = rootFolderId();
    const insideMemo = new Map<string, boolean>();
    const isInsideDesk = (id: string, seen = new Set<string>()): boolean => {
      if (id === root) return true;
      const cached = insideMemo.get(id);
      if (cached !== undefined) return cached;
      if (seen.has(id)) return false;
      seen.add(id);
      const parent = byId.get(id)?.parents?.[0];
      const inside = !!parent && isInsideDesk(parent, seen);
      insideMemo.set(id, inside);
      return inside;
    };
    let deskUsedBytes = 0;
    for (const file of files) {
      if (file.mimeType === FOLDER_MIME || !isInsideDesk(file.id)) continue;
      deskUsedBytes += numericBytes(file.size) ?? 0;
    }
    return {
      deskUsedBytes,
      hostUsedBytes: numericBytes(about.storageQuota?.usage),
      hostLimitBytes: numericBytes(about.storageQuota?.limit),
    };
  }

  async createFolder(parentId: string, name: string): Promise<Entry> {
    const clean = assertUserName(name);
    const parent = resolveId(parentId);
    await assertInsideRoot(parent);
    await assertNameFree(parent, clean);
    const res = await driveFetch(`${API}/files?fields=${FILE_FIELDS}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({
        name: clean,
        mimeType: FOLDER_MIME,
        parents: [parent],
      }),
    });
    return toEntry((await res.json()) as DriveFile);
  }

  async rename(
    id: string,
    name: string,
    expectedVersion: string,
  ): Promise<Entry> {
    if (!expectedVersion || expectedVersion.length > 1024) {
      throw new StorageError("BAD_ID", "잘못된 파일 버전입니다");
    }
    const clean = assertUserName(name);
    const real = resolveId(id);
    if (real === rootFolderId()) {
      throw new StorageError("BAD_ID", "루트 폴더는 이름을 바꿀 수 없습니다");
    }
    await assertInsideRoot(real);
    const metaRes = await driveFetch(`${API}/files/${real}?fields=id,parents`);
    const parent = ((await metaRes.json()) as { parents?: string[] })
      .parents?.[0];
    if (parent) await assertNameFree(parent, clean);
    const params = new URLSearchParams({
      fields: "id,title,mimeType,fileSize,modifiedDate,etag",
    });
    const res = await driveFetch(`${V2_API}/files/${real}?${params}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "If-Match": expectedVersion,
      },
      body: JSON.stringify({ title: clean }),
    });
    return toEntryV2((await res.json()) as DriveFileV2);
  }

  async move(
    id: string,
    targetFolderId: string,
    expectedVersion: string,
  ): Promise<Entry> {
    const real = resolveId(id);
    if (real === rootFolderId()) {
      throw new StorageError("BAD_ID", "루트 폴더는 옮길 수 없습니다");
    }
    const target = resolveId(targetFolderId);
    if (target === real) {
      throw new StorageError("BAD_ID", "자기 자신 안으로 옮길 수 없습니다");
    }
    await ensureStateDir();
    assertNotStateArea(real);
    assertNotStateArea(target);
    const [metaRes, targetMetaRes] = await Promise.all([
      driveFetch(
        `${API}/files/${real}?fields=id,name,mimeType,parents,trashed`,
      ),
      driveFetch(
        `${API}/files/${target}?fields=id,mimeType,parents,trashed`,
      ),
    ]);
    const meta = (await metaRes.json()) as DriveFile & { parents?: string[] };
    const targetMeta = (await targetMetaRes.json()) as DriveFile & {
      parents?: string[];
    };
    await Promise.all([
      assertInsideRoot(real, meta),
      assertInsideRoot(target, targetMeta),
    ]);
    const parent = meta.parents?.[0];
    if (!parent) {
      throw new StorageError("NOT_FOUND", "대상의 현재 위치를 알 수 없습니다");
    }
    if (targetMeta.mimeType !== FOLDER_MIME) {
      throw new StorageError("BAD_ID", "폴더가 아닙니다");
    }

    // 폴더를 자기 자손 안으로 넣으면 순환이 생긴다. 대상 폴더의 조상을 따라
    // 올라가며 옮기려는 폴더가 나오는지 직접 확인한다 (파일은 순환 불가).
    if (meta.mimeType === FOLDER_MIME) {
      const root = rootFolderId();
      let current = target;
      for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop++) {
        if (current === root) break;
        const hopParent =
          hop === 0
            ? targetMeta.parents?.[0]
            : ((await (
                await driveFetch(`${API}/files/${current}?fields=parents`)
              ).json()) as { parents?: string[] }).parents?.[0];
        if (!hopParent) break;
        if (hopParent === real) {
          throw new StorageError(
            "BAD_ID",
            "폴더를 자기 안쪽 폴더로 옮길 수 없습니다",
          );
        }
        current = hopParent;
      }
    }

    if (parent === target) {
      const currentRes = await driveFetch(
        `${V2_API}/files/${real}?fields=id,title,mimeType,fileSize,modifiedDate,etag`,
      );
      const current = (await currentRes.json()) as DriveFileV2;
      if (current.etag !== expectedVersion) {
        throw new StorageError(
          "CONFLICT",
          "다른 사람이 먼저 옮기거나 수정했습니다",
        );
      }
      return toEntryV2(current);
    }
    await assertNameFree(target, meta.name);

    // 조건부 이동 — 호출자가 마지막으로 본 버전(v2 ETag)일 때만 구글이 받아준다.
    // 그 사이 누가 옮기거나 바꿨으면 412 → CONFLICT. 이 한 번의 패치가 원자적이라
    // 어떤 경쟁에서도 파일은 정확히 한 곳에만 있게 된다.
    const params = new URLSearchParams({
      addParents: target,
      removeParents: parent,
      fields: "id,title,mimeType,fileSize,modifiedDate,etag",
    });
    try {
      const res = await driveFetch(`${V2_API}/files/${real}?${params}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "If-Match": expectedVersion,
        },
        body: "{}",
      });
      return toEntryV2((await res.json()) as DriveFileV2);
    } catch (e) {
      if (e instanceof StorageError && e.code === "CONFLICT") {
        throw new StorageError(
          "CONFLICT",
          "다른 사람이 먼저 옮기거나 수정했습니다",
        );
      }
      throw e;
    }
  }

  async remove(id: string): Promise<void> {
    const real = resolveId(id);
    if (real === rootFolderId()) {
      throw new StorageError("BAD_ID", "루트 폴더는 삭제할 수 없습니다");
    }
    await assertInsideRoot(real);
    await driveFetch(`${API}/files/${real}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ trashed: true }),
    });
  }

  // --- 휴지통 ---
  // drive.file scope라 이 앱이 만든 파일만 보인다. 폴더째 삭제된 경우 자손도
  // trashed=true로 조회되므로 explicitlyTrashed로 최상위 항목만 남긴다.

  async listTrash(): Promise<TrashEntry[]> {
    const files: Array<
      DriveFile & {
        parents?: string[];
        trashed?: boolean;
        trashedTime?: string;
        explicitlyTrashed?: boolean;
      }
    > = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: "trashed=true",
        fields:
          "nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,trashed,trashedTime,explicitlyTrashed)",
        pageSize: "1000",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await driveFetch(`${API}/files?${params}`);
      const body = (await res.json()) as {
        files: typeof files;
        nextPageToken?: string;
      };
      files.push(...body.files);
      pageToken = body.nextPageToken;
    } while (pageToken);
    const insideRoot: typeof files = [];
    for (const file of files) {
      if (file.explicitlyTrashed === false || file.name.startsWith(".")) {
        continue;
      }
      try {
        await assertInsideRoot(
          file.id,
          { id: file.id, parents: file.parents, trashed: file.trashed },
          true,
        );
        insideRoot.push(file);
      } catch (error) {
        if (!(error instanceof StorageError && error.code === "NOT_FOUND")) {
          throw error;
        }
      }
    }
    const entries = await mapWithConcurrency(
      insideRoot,
      TRASH_CONCURRENCY,
      async (file): Promise<TrashEntry> => {
        const versionResponse = await driveFetch(
          `${V2_API}/files/${file.id}?fields=etag`,
        );
        const version = ((await versionResponse.json()) as { etag?: string })
          .etag;
        if (!version) {
          throw new StorageError(
            "UPSTREAM",
            "휴지통 항목의 버전을 확인하지 못했습니다",
          );
        }
        return {
          ...toEntry(file),
          version,
          // trashedTime은 공유 드라이브 전용이라 개인 드라이브에서는 null이다.
          // UI는 null이면 시각 없이 "보관 중"으로만 표시한다.
          trashedAt: file.trashedTime ?? null,
        };
      },
    );
    return entries.sort((a, b) =>
      (b.trashedAt ?? "").localeCompare(a.trashedAt ?? ""),
    );
  }

  // 복원·완전삭제 대상이 "사용자가 직접 버린 최상위 휴지통 항목"인지 확인한다.
  // trashed를 허용한 조상 검사와 explicitlyTrashed·비-dot 검사를 함께 써서,
  // Drive 웹에서 루트 밖으로 옮긴 항목은 휴지통 작업에서도 제외한다.
  // 이 검사가 없으면 살아있는 파일 id를 purge에 넣어 휴지통을 우회한 영구삭제가
  // 가능하고(복구 계약 파괴), 상태 파일(.으로 시작)이 복원·삭제 대상이 될 수 있다.
  private async assertTrashedTopLevel(real: string): Promise<void> {
    if (real === rootFolderId()) {
      throw new StorageError("BAD_ID", "루트 폴더는 대상이 아닙니다");
    }
    const res = await driveFetch(
      `${API}/files/${real}?fields=id,name,parents,trashed,explicitlyTrashed`,
    );
    const meta = (await res.json()) as {
      id: string;
      name: string;
      parents?: string[];
      trashed?: boolean;
      explicitlyTrashed?: boolean;
    };
    if (
      !meta.trashed ||
      meta.explicitlyTrashed === false ||
      meta.name.startsWith(".")
    ) {
      // 존재를 알리지 않도록 "휴지통에 없음"으로 응답한다.
      throw new StorageError("NOT_FOUND", "휴지통에 없는 항목입니다");
    }
    await assertInsideRoot(real, meta, true);
  }

  async restore(id: string): Promise<Entry> {
    const real = resolveId(id);
    await this.assertTrashedTopLevel(real);
    const res = await driveFetch(`${API}/files/${real}?fields=${FILE_FIELDS}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ trashed: false }),
    });
    return toEntry((await res.json()) as DriveFile);
  }

  async purge(id: string, expectedVersion: string): Promise<string> {
    const real = resolveId(id);
    await this.assertTrashedTopLevel(real);
    try {
      await driveFetch(`${V2_API}/files/${real}`, {
        method: "DELETE",
        headers: { "If-Match": expectedVersion },
      });
    } catch (error) {
      if (error instanceof StorageError && error.code === "CONFLICT") {
        throw new StorageError(
          "CONFLICT",
          "휴지통 항목이 목록을 연 뒤 변경되었습니다",
        );
      }
      throw error;
    }
    return real;
  }

  async emptyTrash(targets: TrashDeleteTarget[]): Promise<EmptyTrashResult> {
    // 사용자가 목록에서 확인한 항목만 제한된 동시성으로 조건부 삭제한다.
    // 그 뒤 추가된 항목은 남고, 복원된 항목은 NOT_FOUND로 건너뛴다.
    const uniqueTargets = [
      ...new Map(targets.map((target) => [target.id, target])).values(),
    ];
    const outcomes = await mapWithConcurrency(
      uniqueTargets,
      TRASH_CONCURRENCY,
      async (target) => {
        try {
          return {
            kind: "deleted" as const,
            fileId: await this.purge(target.id, target.version),
          };
        } catch (error) {
          if (
            error instanceof StorageError &&
            (error.code === "NOT_FOUND" || error.code === "CONFLICT")
          ) {
            return { kind: "skipped" as const };
          }
          console.error("[drive] 휴지통 항목 완전 삭제 실패", {
            fileId: target.id,
            error,
          });
          return { kind: "failed" as const };
        }
      },
    );
    return {
      fileIds: outcomes.flatMap((outcome) =>
        outcome.kind === "deleted" ? [outcome.fileId] : [],
      ),
      skipped: outcomes.filter((outcome) => outcome.kind === "skipped").length,
      failed: outcomes.filter((outcome) => outcome.kind === "failed").length,
    };
  }

  private async downloadable(
    id: string,
  ): Promise<{ real: string; meta: DriveFile }> {
    const real = resolveId(id);
    const metaRes = await driveFetch(
      `${API}/files/${real}?fields=${FILE_FIELDS},parents,trashed`,
    );
    const meta = (await metaRes.json()) as DriveFile & {
      parents?: string[];
      trashed?: boolean;
    };
    await assertInsideRoot(real, meta);
    if (meta.mimeType === FOLDER_MIME) {
      throw new StorageError("BAD_ID", "폴더는 다운로드할 수 없습니다");
    }
    return { real, meta };
  }

  private async downloadResolved(
    real: string,
    meta: DriveFile,
    range?: string,
  ): Promise<DownloadResult> {
    if (isGoogleWorkspacePreviewMime(meta.mimeType)) {
      const params = new URLSearchParams({ mimeType: "application/pdf" });
      const res = await driveFetch(
        `${API}/files/${real}/export?${params.toString()}`,
      );
      if (!res.body) {
        throw new StorageError("UPSTREAM", "구글 문서를 열지 못했습니다");
      }
      const length = res.headers.get("content-length");
      const contentLength = length ? Number(length) : null;
      return {
        stream: res.body as ReadableStream<Uint8Array>,
        name: meta.name.toLowerCase().endsWith(".pdf")
          ? meta.name
          : `${meta.name}.pdf`,
        size: contentLength,
        mimeType: "application/pdf",
        status: 200,
        contentRange: null,
        contentLength,
        acceptRanges: false,
      };
    }
    if (meta.mimeType.startsWith("application/vnd.google-apps.")) {
      throw new StorageError(
        "UPSTREAM",
        "이 구글 파일 형식은 아직 미리보기를 지원하지 않습니다",
      );
    }
    // 드라이브 alt=media는 Range를 그대로 받아 206으로 응답한다 (동영상 탐색).
    const res = await driveFetch(
      `${API}/files/${real}?alt=media`,
      range ? { headers: { Range: range } } : {},
    );
    if (!res.body) {
      throw new StorageError("UPSTREAM", "다운로드 스트림을 열지 못했습니다");
    }
    const contentLength = res.headers.get("content-length");
    return {
      stream: res.body as ReadableStream<Uint8Array>,
      name: meta.name,
      size: meta.size !== undefined ? Number(meta.size) : null,
      mimeType: meta.mimeType || "application/octet-stream",
      status: res.status === 206 ? 206 : 200,
      contentRange: res.headers.get("content-range"),
      contentLength: contentLength ? Number(contentLength) : null,
    };
  }

  async download(id: string, range?: string): Promise<DownloadResult> {
    const { real, meta } = await this.downloadable(id);
    return this.downloadResolved(real, meta, range);
  }

  async preview(id: string, range?: string): Promise<DownloadResult> {
    const { real, meta } = await this.downloadable(id);
    const officeImport = officePreviewImport(meta);
    if (!officeImport) return this.downloadResolved(real, meta, range);

    try {
      return await convertOfficePreview(real, meta, officeImport);
    } catch (error) {
      const isPreviewLimit =
        error instanceof StorageError &&
        error.message.includes("한도를 초과했습니다");
      if (!isPreviewLimit) {
        console.error("[drive] Office 문서 미리보기 변환 실패", {
          fileId: real,
          error,
        });
      }
      const reason = isPreviewLimit
        ? (error as StorageError).message
        : "Google 문서 변환이 완료되지 않았습니다.";
      return createOfficePreviewFallback({ id, name: meta.name, reason });
    }
  }

  async replaceContent(
    id: string,
    expectedVersion: string,
    mimeType: string,
    data: ReadableStream<Uint8Array>,
  ): Promise<Entry> {
    if (!expectedVersion || expectedVersion.length > 1024) {
      throw new StorageError("BAD_ID", "잘못된 파일 버전입니다");
    }
    if (!mimeType || mimeType.length > 255 || /[\r\n\0]/.test(mimeType)) {
      throw new StorageError("BAD_ID", "잘못된 파일 형식입니다");
    }
    const real = resolveId(id);
    if (real === rootFolderId()) {
      throw new StorageError("BAD_ID", "루트 폴더는 수정할 수 없습니다");
    }
    const metaResponse = await driveFetch(
      `${API}/files/${real}?fields=id,name,mimeType,parents,trashed`,
    );
    const meta = (await metaResponse.json()) as DriveFile & {
      parents?: string[];
      trashed?: boolean;
    };
    await assertInsideRoot(real, meta);
    if (
      meta.mimeType === FOLDER_MIME ||
      meta.mimeType.startsWith("application/vnd.google-apps.")
    ) {
      throw new StorageError("BAD_ID", "일반 파일이 아닙니다");
    }

    // Drive v3 업로드는 If-Match를 무시한다. 상태 파일·이동과 같은 v2 경로로
    // 조건부 본문 교체를 보내야 오래된 편집이 412(CONFLICT)로 거부된다.
    try {
      const response = await driveFetch(
        `${V2_UPLOAD_API}/files/${real}?uploadType=media&fields=id,title,mimeType,fileSize,modifiedDate,etag`,
        {
          method: "PUT",
          headers: {
            "Content-Type": mimeType,
            "If-Match": expectedVersion,
          },
          body: data,
          duplex: "half",
        } as RequestInit,
      );
      return toEntryV2((await response.json()) as DriveFileV2);
    } catch (error) {
      if (error instanceof StorageError && error.code === "CONFLICT") {
        throw new StorageError(
          "CONFLICT",
          "다른 사람이 먼저 파일을 수정했습니다",
        );
      }
      throw error;
    }
  }

  private async initResumable(
    parent: string,
    name: string,
    mimeType: string,
    size?: number,
    origin?: string,
  ): Promise<string> {
    const token = await accessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
    };
    // 크기를 미리 알리면 구글이 불일치 업로드를 거부한다.
    if (size !== undefined && size > 0) {
      headers["X-Upload-Content-Length"] = String(size);
    }
    if (origin) headers["Origin"] = origin;
    const res = await fetch(
      `${UPLOAD_API}/files?uploadType=resumable&fields=${FILE_FIELDS}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ name, parents: [parent], mimeType }),
      },
    );
    const url = res.headers.get("location");
    if (!res.ok || !url) {
      throw new StorageError(
        "UPSTREAM",
        `업로드 세션을 만들지 못했습니다 (HTTP ${res.status})`,
      );
    }
    return url;
  }

  // UI는 항상 createUploadSession(direct)을 쓴다. 이 경로는 어댑터 계약을 채우고
  // API를 직접 호출하는 클라이언트(curl 등)를 위한 서버 경유 폴백이다.
  async upload(
    parentId: string,
    name: string,
    mimeType: string,
    data: ReadableStream<Uint8Array>,
  ): Promise<Entry> {
    const clean = assertUserName(name);
    const parent = resolveId(parentId);
    await assertInsideRoot(parent);
    await assertNameFree(parent, clean);
    const sessionUrl = await this.initResumable(parent, clean, mimeType);
    const put = await fetch(sessionUrl, {
      method: "PUT",
      headers: { "Content-Type": mimeType },
      body: data,
      // Node fetch(undici)는 스트림 본문에 duplex 지정이 필수
      duplex: "half",
    } as RequestInit);
    if (!put.ok) {
      throw new StorageError(
        "UPSTREAM",
        `드라이브 업로드에 실패했습니다 (HTTP ${put.status})`,
      );
    }
    const file = (await put.json()) as DriveFile;
    return toEntry(file);
  }

  async createUploadSession(
    parentId: string,
    name: string,
    mimeType: string,
    size: number,
    origin: string,
  ): Promise<UploadSession> {
    const clean = assertUserName(name);
    const parent = resolveId(parentId);
    await assertInsideRoot(parent);
    await assertNameFree(parent, clean);
    const url = await this.initResumable(parent, clean, mimeType, size, origin);
    return { mode: "direct", url };
  }

  async createPermission(
    id: string,
    email: string,
    role: ShareRole,
    options: CreatePermissionOptions = {},
  ): Promise<StoragePermission> {
    const fileId = resolveId(id);
    assertNotRootShareTarget(fileId);
    await assertInsideRoot(fileId);
    await assertNoPermissionForEmail(fileId, email);
    const params = new URLSearchParams({
      fields: "id,type,emailAddress,role,permissionDetails(inherited)",
      sendNotificationEmail: String(options.sendNotificationEmail === true),
      supportsAllDrives: "true",
    });
    const response = await driveFetch(
      `${API}/files/${fileId}/permissions?${params}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({
          type: "user",
          role,
          emailAddress: email,
        }),
      },
    );
    return toStoragePermission((await response.json()) as DrivePermission);
  }

  async updatePermission(
    id: string,
    permissionId: string,
    role: ShareRole,
  ): Promise<StoragePermission> {
    const fileId = resolveId(id);
    assertNotRootShareTarget(fileId);
    await assertInsideRoot(fileId);
    await getDirectPermission(fileId, permissionId);
    const params = new URLSearchParams({
      fields: "id,type,emailAddress,role,permissionDetails(inherited)",
      supportsAllDrives: "true",
    });
    const response = await driveFetch(
      `${API}/files/${fileId}/permissions/${permissionIdPath(permissionId)}?${params}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ role }),
      },
    );
    return toStoragePermission((await response.json()) as DrivePermission);
  }

  async deletePermission(id: string, permissionId: string): Promise<void> {
    const fileId = resolveId(id);
    await assertInsideRoot(fileId);
    await getDirectPermission(fileId, permissionId);
    await driveFetch(
      `${API}/files/${fileId}/permissions/${permissionIdPath(permissionId)}?supportsAllDrives=true`,
      { method: "DELETE" },
    );
  }

  async findPermissionByEmail(
    id: string,
    email: string,
  ): Promise<StoragePermission | null> {
    const fileId = resolveId(id);
    assertNotRootShareTarget(fileId);
    await assertInsideRoot(fileId);
    return findDirectPermissionForEmail(fileId, email);
  }

  async deleteTrackedPermission(
    id: string,
    permissionId: string,
  ): Promise<void> {
    const fileId = resolveId(id);
    try {
      const permission = await getDirectPermission(fileId, permissionId);
      await driveFetch(
        `${API}/files/${fileId}/permissions/${permissionIdPath(permission.permissionId)}?supportsAllDrives=true`,
        { method: "DELETE" },
      );
    } catch (error) {
      // 장부에 기록된 권한의 회수는 파일/권한이 먼저 사라졌다면 완료된 것으로 본다.
      if (!(error instanceof StorageError && error.code === "NOT_FOUND")) {
        throw error;
      }
    }
  }

  // --- 앱 상태 파일 (.sharedesk/*.json) ---

  async readState<T>(name: string): Promise<T | null> {
    const clean = assertValidName(name);
    const id = await findStateFile(clean);
    if (!id) return null;
    let text: string;
    try {
      text = await (await driveFetch(`${API}/files/${id}?alt=media`)).text();
    } catch (e) {
      // 캐시된 id가 죽었을 수 있다(주인이 드라이브에서 지웠거나 휴지통으로 옮김).
      // 캐시를 버리고 한 번 다시 찾아본 뒤, 그래도 없으면 "파일 없음"으로 취급한다.
      if (e instanceof StorageError && e.code === "NOT_FOUND") {
        forgetStateFile(clean);
        const retryId = await findStateFile(clean);
        if (!retryId) return null;
        text = await (
          await driveFetch(`${API}/files/${retryId}?alt=media`)
        ).text();
      } else {
        throw e;
      }
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new StorageError("UPSTREAM", `${clean}이 손상되었습니다`);
    }
  }

  async readStateVersioned<T>(
    name: string,
    hint?: { version: string; value: T },
  ): Promise<StateRead<T>> {
    const clean = assertValidName(name);
    let id = await findStateFile(clean);
    if (!id) return { value: null, version: null };
    let result: StateRead<T>;
    const read = async (fileId: string): Promise<StateRead<T>> => {
      // Drive v3의 media 응답에는 ETag가 없다. v2 파일 메타데이터의 ETag를 먼저
      // 읽은 뒤 본문을 읽으면, 그 사이 쓰기가 끼어도 이후 If-Match가 안전하게 실패한다.
      const metadata = await driveFetch(
        `${V2_API}/files/${fileId}?fields=etag`,
      );
      const body = (await metadata.json()) as { etag?: string };
      if (!body.etag) {
        throw new StorageError(
          "UPSTREAM",
          "구글 드라이브가 상태 파일 버전을 보내지 않았습니다",
        );
      }
      // 호출자가 이미 이 버전의 값을 들고 있으면 본문 다운로드를 생략한다.
      if (hint && hint.version === body.etag) {
        return { value: hint.value, version: body.etag };
      }
      const response = await driveFetch(`${API}/files/${fileId}?alt=media`);
      try {
        return {
          value: JSON.parse(await response.text()) as T,
          version: body.etag,
        };
      } catch {
        throw new StorageError("UPSTREAM", `${clean}이 손상되었습니다`);
      }
    };
    try {
      result = await read(id);
    } catch (e) {
      if (!(e instanceof StorageError) || e.code !== "NOT_FOUND") throw e;
      forgetStateFile(clean);
      id = await findStateFile(clean);
      if (!id) return { value: null, version: null };
      result = await read(id);
    }
    return result;
  }

  async writeState(name: string, value: unknown): Promise<void> {
    const clean = assertValidName(name);
    const body = JSON.stringify(value, null, 2);
    const write = async (id: string) =>
      driveFetch(`${UPLOAD_API}/files/${id}?uploadType=media`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body,
      });

    let id = await findStateFile(clean);
    if (!id) {
      const created = await createStateFile(clean, body);
      if (created.created) return;
      id = created.id;
      await write(id);
      return;
    }
    try {
      await write(id);
    } catch (e) {
      if (e instanceof StorageError && e.code === "NOT_FOUND") {
        forgetStateFile(clean);
        const found = await findStateFile(clean);
        const created = found ? null : await createStateFile(clean, body);
        if (created?.created) return;
        const retryId = found ?? created!.id;
        await write(retryId);
        return;
      }
      throw e;
    }
  }

  async compareAndSwapState(
    name: string,
    value: unknown,
    expectedVersion: string | null,
  ): Promise<string | null> {
    const clean = assertValidName(name);
    const body = JSON.stringify(value, null, 2);
    let id = await findStateFile(clean);
    if (expectedVersion === null) {
      if (id) throw conflictError();
      const created = await createStateFile(clean, body);
      if (!created.created) throw conflictError();
      id = created.id;
      const metadata = await driveFetch(`${V2_API}/files/${id}?fields=etag`);
      return ((await metadata.json()) as { etag?: string }).etag ?? null;
    }
    if (!id) throw conflictError();
    try {
      // v3 업로드 엔드포인트는 If-Match를 조용히 무시한다(scripts/verify-ifmatch.mjs로
      // 실측). 조건부 쓰기가 실제로 집행되는 곳은 v2 업로드뿐이다.
      // 응답에서 새 ETag를 받아 돌려주면 호출자가 재읽기 없이 캐시를 이어간다.
      const res = await driveFetch(
        `${V2_UPLOAD_API}/files/${id}?uploadType=media&fields=etag`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json; charset=UTF-8",
            "If-Match": expectedVersion,
          },
          body,
        },
      );
      return ((await res.json()) as { etag?: string }).etag ?? null;
    } catch (e) {
      if (e instanceof StorageError && e.code === "NOT_FOUND") {
        forgetStateFile(clean);
        throw conflictError();
      }
      throw e;
    }
  }
}
