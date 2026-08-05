import {
  DownloadResult,
  Entry,
  ROOT_ID,
  StorageAdapter,
  StorageError,
  UploadSession,
  assertValidName,
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

export class DriveAdapter implements StorageAdapter {
  async list(folderId: string): Promise<Entry[]> {
    const folder = resolveId(folderId);
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
    return files.map(toEntry);
  }

  async createFolder(parentId: string, name: string): Promise<Entry> {
    const clean = assertValidName(name);
    const parent = resolveId(parentId);
    const dupParams = new URLSearchParams({
      q: `'${parent}' in parents and name='${escapeQuery(clean)}' and trashed=false`,
      fields: "files(id)",
      pageSize: "1",
    });
    const dupRes = await driveFetch(`${API}/files?${dupParams}`);
    const dup = (await dupRes.json()) as { files: DriveFile[] };
    if (dup.files.length > 0) {
      throw new StorageError("CONFLICT", "같은 이름이 이미 있습니다");
    }
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
    const clean = assertValidName(name);
    const real = resolveId(id);
    if (real === rootFolderId()) {
      throw new StorageError("BAD_ID", "루트 폴더는 이름을 바꿀 수 없습니다");
    }
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
    await driveFetch(`${API}/files/${real}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ trashed: true }),
    });
  }

  async download(id: string): Promise<DownloadResult> {
    const real = resolveId(id);
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
    origin?: string,
  ): Promise<string> {
    const token = await accessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
    };
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

  async upload(
    parentId: string,
    name: string,
    mimeType: string,
    data: ReadableStream<Uint8Array>,
  ): Promise<Entry> {
    const clean = assertValidName(name);
    const parent = resolveId(parentId);
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
    _size: number,
    origin: string,
  ): Promise<UploadSession> {
    const clean = assertValidName(name);
    const parent = resolveId(parentId);
    const url = await this.initResumable(parent, clean, mimeType, origin);
    return { mode: "direct", url };
  }
}
