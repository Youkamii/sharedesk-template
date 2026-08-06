import { getAdapter } from "@/lib/storage";

// 사용자 명단은 저장소(.sharedesk/users.json)에 둔다 — 별도 DB 없이 드라이브를 그대로 쓴다.
// 승인 취소가 즉시 먹혀야 하므로 캐시는 짧게 잡는다.

const FILE = "users.json";
// 캐시는 잦은 파일 요청의 저장소 왕복을 줄이는 용도다. 차단이 반영되기까지의
// 최대 지연이기도 하므로 짧게 잡고, 화면 접근 판정은 아래 fresh 옵션으로 캐시를 건너뛴다.
// (서버리스에서는 인스턴스가 여러 개일 수 있어 이 값이 실질 상한이 된다)
const CACHE_MS = 5_000;

export type UserStatus = "pending" | "approved" | "blocked";

export interface User {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  isAdmin: boolean;
  createdAt: string;
  // 이 시각 이전에 발급된 세션은 무효 — 기기 분실 시 전부 끊는 용도.
  sessionsValidFrom: number;
}

interface UserFile {
  version: 1;
  users: User[];
}

let cache: { data: UserFile; at: number } | null = null;
let writeChain: Promise<unknown> = Promise.resolve();

function emptyFile(): UserFile {
  return { version: 1, users: [] };
}

async function load(force = false): Promise<UserFile> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const raw = await getAdapter().readState<UserFile>(FILE);
  const data =
    raw && Array.isArray(raw.users) ? { version: 1 as const, users: raw.users } : emptyFile();
  cache = { data, at: Date.now() };
  return data;
}

// 읽고-고쳐-쓰기 사이에 다른 요청이 끼어들면 한쪽 변경이 사라진다.
// 인스턴스 안에서는 쓰기를 직렬화하고, 매번 최신 상태를 다시 읽어서 수정한다.
async function mutate<T>(fn: (file: UserFile) => T | Promise<T>): Promise<T> {
  const run = writeChain.then(async () => {
    const file = await load(true);
    const result = await fn(file);
    await getAdapter().writeState(FILE, file);
    cache = { data: file, at: Date.now() };
    return result;
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
  return adminEmails().includes(normalizeEmail(email));
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
        sessionsValidFrom: 0,
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
    if (status !== "approved") user.sessionsValidFrom = Date.now();
    return user;
  });
}

export async function revokeSessions(id: string): Promise<User | null> {
  return mutate((file) => {
    const user = file.users.find((u) => u.id === id);
    if (!user) return null;
    user.sessionsValidFrom = Date.now();
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

export function invalidateCache(): void {
  cache = null;
}
