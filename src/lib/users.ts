import { getAdapter } from "@/lib/storage";

// 사용자 명단은 저장소(.sharedesk/users.json)에 둔다 — 별도 DB 없이 드라이브를 그대로 쓴다.
// 어댑터가 이 경로를 파일 API로부터 차단하므로 사용자는 명단을 읽거나 고칠 수 없다.

const FILE = "users.json";
// 캐시는 잦은 파일 요청의 저장소 왕복을 줄이는 용도다. 차단이 반영되기까지의
// 최대 지연이기도 하므로 짧게 잡고, 화면 접근 판정은 fresh 옵션으로 캐시를 건너뛴다.
// (서버리스에서는 인스턴스가 여러 개일 수 있어 이 값이 실질 상한이 된다)
const CACHE_MS = 5_000;
const WRITE_RETRIES = 3;

export type UserStatus = "pending" | "approved" | "blocked";

export interface User {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  isAdmin: boolean;
  createdAt: string;
  // 이 시각(ms) 이전에 발급된 세션은 무효 — 기기 분실 시 전부 끊는 용도.
  sessionsValidFrom: number;
}

interface UserFile {
  version: 1;
  // 다른 인스턴스가 사이에 끼어들었는지 판별하는 값. 쓰기 직전에 대조한다.
  rev: number;
  users: User[];
}

let cache: { data: UserFile; at: number; gen: number } | null = null;
let generation = 0;
let writeChain: Promise<unknown> = Promise.resolve();

function emptyFile(): UserFile {
  return { version: 1, rev: 0, users: [] };
}

// 명단은 사람이 직접 열어볼 수 있는 평문 JSON이라, 손으로 고쳐 필드가 빠지는 일이 있다.
// 빠진 필드가 검사를 무력화하지 않도록 읽는 즉시 형태를 맞춘다.
function normalize(raw: unknown): UserFile {
  const file = raw as Partial<UserFile> | null;
  if (!file || !Array.isArray(file.users)) return emptyFile();
  const users = file.users
    .filter((u): u is User => !!u && typeof u.id === "string")
    .map((u) => ({
      id: u.id,
      email: typeof u.email === "string" ? u.email : "",
      name: typeof u.name === "string" ? u.name : "",
      status: (u.status === "approved" || u.status === "blocked"
        ? u.status
        : "pending") as UserStatus,
      isAdmin: u.isAdmin === true,
      createdAt:
        typeof u.createdAt === "string" ? u.createdAt : new Date(0).toISOString(),
      sessionsValidFrom:
        typeof u.sessionsValidFrom === "number" && u.sessionsValidFrom >= 0
          ? u.sessionsValidFrom
          : 0,
    }));
  return {
    version: 1,
    rev: typeof file.rev === "number" ? file.rev : 0,
    users,
  };
}

async function load(force = false): Promise<UserFile> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const myGen = ++generation;
  const data = normalize(await getAdapter().readState<UserFile>(FILE));
  // 읽는 사이 다른 요청이 명단을 갱신했다면 그 결과가 더 최신이다.
  // 뒤늦게 도착한 옛 스냅숏으로 캐시를 되감지 않는다.
  if (!cache || myGen > cache.gen) cache = { data, at: Date.now(), gen: myGen };
  return data;
}

// 읽고-고쳐-쓰기 사이에 다른 요청이 끼어들면 한쪽 변경이 사라진다.
// 인스턴스 안에서는 쓰기를 직렬화하고, 인스턴스 사이는 rev 대조로 감지해 다시 시도한다.
// (드라이브에 조건부 쓰기가 없어 완벽한 잠금은 아니다 — 충돌 창을 좁히는 수준)
async function mutate<T>(fn: (file: UserFile) => T): Promise<T> {
  const run = writeChain.then(async () => {
    for (let attempt = 0; ; attempt++) {
      const before = await load(true);
      const draft: UserFile = JSON.parse(JSON.stringify(before));
      const result = fn(draft);

      if (attempt < WRITE_RETRIES) {
        const latest = normalize(await getAdapter().readState<UserFile>(FILE));
        if (latest.rev !== before.rev) continue; // 남이 먼저 썼다 — 다시 읽어서 적용
      }
      draft.rev = before.rev + 1;
      try {
        await getAdapter().writeState(FILE, draft);
      } catch (e) {
        // 저장에 실패한 변경이 캐시에 남으면 판정이 사실과 어긋난다.
        cache = null;
        throw e;
      }
      cache = { data: draft, at: Date.now(), gen: ++generation };
      return result;
    }
  });
  writeChain = run.catch(() => {});
  return run;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => normalizeEmail(e))
    .filter(Boolean);
}

export function isAdminEmail(email: string): boolean {
  const target = normalizeEmail(email);
  return target.length > 0 && adminEmails().includes(target);
}

// 세션 무효화 기준선은 토큰 iat(초 단위)와 비교된다. 밀리초를 그대로 쓰면 같은 초에
// 발급된 정상 세션까지 죽으므로 초 경계로 내려 맞춘다.
function nowFloorSecond(): number {
  return Math.floor(Date.now() / 1000) * 1000;
}

export async function listUsers(): Promise<User[]> {
  return (await load()).users;
}

export async function findUserById(
  id: string,
  opts?: { fresh?: boolean },
): Promise<User | null> {
  return (await load(opts?.fresh)).users.find((u) => u.id === id) ?? null;
}

// 로그인 성공 시 호출. 처음 보는 사람은 승인 대기로 등록하고,
// 관리자 이메일이면 곧바로 승인한다.
export async function upsertOnLogin(profile: {
  id: string;
  email: string;
  name: string;
}): Promise<User> {
  const email = normalizeEmail(profile.email);
  const admin = isAdminEmail(email);
  return mutate((file) => {
    let user = file.users.find((u) => u.id === profile.id);
    if (!user) {
      user = {
        id: profile.id,
        email,
        name: profile.name || email,
        status: admin ? "approved" : "pending",
        isAdmin: admin,
        createdAt: new Date().toISOString(),
        // 명단에서 지워졌다가 다시 로그인하는 경우, 삭제 전에 발급된 옛 세션이
        // 되살아나면 안 된다. 등록 시점을 기준선으로 잡는다.
        sessionsValidFrom: nowFloorSecond(),
      };
      file.users.push(user);
      return user;
    }
    user.email = email;
    user.name = profile.name || user.name;
    // 관리자 지정은 환경변수가 진실 원천이라 로그인마다 다시 맞춘다.
    user.isAdmin = admin;
    if (admin && user.status !== "approved") user.status = "approved";
    return user;
  });
}

export async function setStatus(
  id: string,
  status: UserStatus,
): Promise<User | null> {
  return mutate((file) => {
    const user = file.users.find((u) => u.id === id);
    if (!user) return null;
    if (isAdminEmail(user.email) && status !== "approved") {
      throw new Error("관리자 계정은 차단할 수 없습니다");
    }
    user.status = status;
    // 차단·보류로 내리면 기존 세션도 즉시 끊는다.
    if (status !== "approved") user.sessionsValidFrom = nowFloorSecond();
    return user;
  });
}

export async function revokeSessions(id: string): Promise<User | null> {
  return mutate((file) => {
    const user = file.users.find((u) => u.id === id);
    if (!user) return null;
    if (isAdminEmail(user.email)) {
      throw new Error("관리자 계정의 세션은 끊을 수 없습니다");
    }
    user.sessionsValidFrom = nowFloorSecond();
    return user;
  });
}

export async function removeUser(id: string): Promise<boolean> {
  return mutate((file) => {
    const i = file.users.findIndex((u) => u.id === id);
    if (i < 0) return false;
    if (isAdminEmail(file.users[i].email)) {
      throw new Error("관리자 계정은 삭제할 수 없습니다");
    }
    file.users.splice(i, 1);
    return true;
  });
}
