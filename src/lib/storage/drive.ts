import {
  DownloadResult,
  Entry,
  ROOT_ID,
  STATE_DIR,
  StorageAdapter,
  StorageError,
  UploadSession,
  assertUserName,
  assertValidName,
  conflictError,
  stateAccessDenied,
} from "./types";

// Google Drive v3 REST 어댑터 — googleapis 패키지 없이 fetch만 사용.
// drive.file scope라 이 앱이 만든 파일·폴더만 보인다. 접근 범위 격리는
// scope가 담당하고, 루트 폴더 밖 id는 애초에 조회가 실패한다.

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILE_FIELDS = "id,name,mimeType,size,modifiedTime";
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

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

// drive.file scope는 "이 앱이 만든 파일"까지만 좁혀줄 뿐, 그 파일이 나중에 주인 손으로
// ShareDesk 폴더 밖으로 옮겨져도 id만 알면 계속 닿는다. 앱이 약속한 경계는 루트 폴더이므로
// 조상을 따라 올라가 루트 자손임을 직접 확인한다. 휴지통에 든 대상도 여기서 걸러진다.
const MAX_ANCESTOR_HOPS = 32;
const verifiedIds = new Map<string, number>();
const VERIFIED_TTL_MS = 5 * 60 * 1000;

// 앱 내부 영역(.sharedesk). 파일 API가 이 폴더나 그 자손에 닿으면 거부한다 —
// 명단이 곧 접근 권한이라 사용자가 읽거나 고칠 수 있으면 안 된다.
let stateDirId: string | null = null;
const stateFileIds = new Map<string, string>();

function assertNotStateArea(id: string): void {
  if (stateDirId && id === stateDirId) throw stateAccessDenied();
}

function forgetStateFile(name: string): void {
  stateFileIds.delete(name);
  stateDirId = null;
}

async function ensureStateDir(): Promise<string> {
  if (stateDirId) return stateDirId;
  const root = rootFolderId();
  const params = new URLSearchParams({
    q: `'${root}' in parents and name='${escapeQuery(STATE_DIR)}' and mimeType='${FOLDER_MIME}' and trashed=false`,
    fields: "files(id)",
    pageSize: "1",
  });
  const found = (await (await driveFetch(`${API}/files?${params}`)).json()) as {
    files: DriveFile[];
  };
  if (found.files[0]) {
    stateDirId = found.files[0].id;
    return stateDirId;
  }
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
  ).json()) as DriveFile;
  stateDirId = created.id;
  return created.id;
}

async function findStateFile(name: string): Promise<string | null> {
  const cached = stateFileIds.get(name);
  if (cached) return cached;
  const dir = await ensureStateDir();
  const params = new URLSearchParams({
    q: `'${dir}' in parents and name='${escapeQuery(name)}' and trashed=false`,
    fields: "files(id)",
    pageSize: "1",
  });
  const found = (await (await driveFetch(`${API}/files?${params}`)).json()) as {
    files: DriveFile[];
  };
  const id = found.files[0]?.id ?? null;
  if (id) stateFileIds.set(name, id);
  return id;
}

async function createStateFile(name: string): Promise<string> {
  const dir = await ensureStateDir();
  // 다른 인스턴스가 방금 만들었을 수 있다. 드라이브는 동명 파일을 허용하므로
  // 만들기 직전에 한 번 더 확인해 명단이 둘로 갈리는 것을 줄인다.
  const params = new URLSearchParams({
    q: `'${dir}' in parents and name='${escapeQuery(name)}' and trashed=false`,
    fields: "files(id)",
    pageSize: "1",
  });
  const again = (await (await driveFetch(`${API}/files?${params}`)).json()) as {
    files: DriveFile[];
  };
  if (again.files[0]) {
    stateFileIds.set(name, again.files[0].id);
    return again.files[0].id;
  }
  const created = (await (
    await driveFetch(`${API}/files?fields=id`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ name, parents: [dir] }),
    })
  ).json()) as DriveFile;
  stateFileIds.set(name, created.id);
  return created.id;
}

function markVerified(id: string): void {
  verifiedIds.set(id, Date.now() + VERIFIED_TTL_MS);
  if (verifiedIds.size > 5000) {
    const now = Date.now();
    for (const [k, exp] of verifiedIds) if (exp < now) verifiedIds.delete(k);
  }
}

async function assertInsideRoot(id: string): Promise<void> {
  const root = rootFolderId();
  // 내부 영역 id를 모르는 상태에서는 차단 판정을 할 수 없으므로 먼저 확보한다.
  await ensureStateDir();
  assertNotStateArea(id);
  if (id === root) return;
  const cachedExp = verifiedIds.get(id);
  if (cachedExp !== undefined && cachedExp > Date.now()) return;

  const chain: string[] = [];
  let current = id;
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop++) {
    const res = await driveFetch(
      `${API}/files/${current}?fields=id,parents,trashed`,
    );
    const meta = (await res.json()) as {
      id: string;
      parents?: string[];
      trashed?: boolean;
    };
    if (meta.trashed) {
      throw new StorageError("NOT_FOUND", "대상이 휴지통에 있습니다");
    }
    chain.push(meta.id);
    const parent = meta.parents?.[0];
    if (!parent) break;
    // 조상 어딘가가 내부 영역이면 그 아래 전부 접근 금지.
    assertNotStateArea(parent);
    if (parent === root) {
      for (const c of chain) markVerified(c);
      return;
    }
    const parentExp = verifiedIds.get(parent);
    if (parentExp !== undefined && parentExp > Date.now()) {
      for (const c of chain) markVerified(c);
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
  const token = await accessToken();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 404) {
    throw new StorageError("NOT_FOUND", "대상이 없습니다");
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
}

function toEntry(f: DriveFile): Entry {
  const isFolder = f.mimeType === FOLDER_MIME;
  return {
    id: f.id,
    name: f.name,
    isFolder,
    size: !isFolder && f.size !== undefined ? Number(f.size) : null,
    modifiedAt: f.modifiedTime ?? null,
    mimeType: f.mimeType,
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
  async list(folderId: string): Promise<Entry[]> {
    const folder = resolveId(folderId);
    await assertInsideRoot(folder);
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: `'${folder}' in parents and trashed=false`,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: "1000",
        orderBy: "folder,name",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await driveFetch(`${API}/files?${params}`);
      const body = (await res.json()) as {
        files: DriveFile[];
        nextPageToken?: string;
      };
      files.push(...body.files);
      pageToken = body.nextPageToken;
    } while (pageToken);
    // 앱 내부 파일(.sharedesk 등)은 탐색기에 노출하지 않는다.
    return files.filter((f) => !f.name.startsWith(".")).map(toEntry);
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

  async rename(id: string, name: string): Promise<Entry> {
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
    const res = await driveFetch(
      `${API}/files/${real}?fields=${FILE_FIELDS}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ name: clean }),
      },
    );
    return toEntry((await res.json()) as DriveFile);
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

  async download(id: string): Promise<DownloadResult> {
    const real = resolveId(id);
    await assertInsideRoot(real);
    const metaRes = await driveFetch(
      `${API}/files/${real}?fields=${FILE_FIELDS}`,
    );
    const meta = (await metaRes.json()) as DriveFile;
    if (meta.mimeType === FOLDER_MIME) {
      throw new StorageError("BAD_ID", "폴더는 다운로드할 수 없습니다");
    }
    if (meta.mimeType.startsWith("application/vnd.google-apps.")) {
      throw new StorageError(
        "UPSTREAM",
        "구글 문서 형식(문서·시트 등)은 아직 다운로드를 지원하지 않습니다",
      );
    }
    const res = await driveFetch(`${API}/files/${real}?alt=media`);
    if (!res.body) {
      throw new StorageError("UPSTREAM", "다운로드 스트림을 열지 못했습니다");
    }
    return {
      stream: res.body as ReadableStream<Uint8Array>,
      name: meta.name,
      size: meta.size !== undefined ? Number(meta.size) : null,
      mimeType: meta.mimeType || "application/octet-stream",
    };
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
      id = await createStateFile(clean);
      await write(id);
      return;
    }
    try {
      await write(id);
    } catch (e) {
      if (e instanceof StorageError && e.code === "NOT_FOUND") {
        forgetStateFile(clean);
        const retryId = (await findStateFile(clean)) ?? (await createStateFile(clean));
        await write(retryId);
        return;
      }
      throw e;
    }
  }
}
