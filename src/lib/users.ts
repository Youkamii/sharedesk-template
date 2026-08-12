import { randomUUID } from "node:crypto";
import { isValidSessionId } from "@/lib/session-token";
import { getAdapter } from "@/lib/storage";
import { StorageError } from "@/lib/storage/types";

// 사용자와 초대 명단은 저장소(.sharedesk/users.json)에 함께 둔다.
// 초대 소비와 사용자 승인이 같은 CAS 쓰기로 끝나야 한 링크가 정확히 한 번만 쓰인다.

const FILE = "users.json";
const CACHE_MS = 5_000;
const WRITE_RETRIES = 3;
const MAX_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 320;
const MAX_NOTE_LENGTH = 500;
export const MAX_DEVICE_SESSIONS = 20;
export const MAX_DEVICE_LABEL_LENGTH = 80;
const MAX_USER_AGENT_LENGTH = 512;

export type UserStatus = "pending" | "approved" | "blocked";

export interface UserSession {
  id: string;
  createdAt: string;
  deviceLabel: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  isAdmin: boolean;
  createdAt: string;
  invitationId: string | null;
  // 이 시각(ms) 이전에 발급된 세션은 무효 — 기기 분실 시 전부 끊는 용도.
  sessionsValidFrom: number;
  // 같은 초에 발급·철회가 겹쳐도 즉시 끊을 수 있도록 토큰과 맞춰 보는 값.
  sessionVersion: number;
  sessions: UserSession[];
}

export interface Invitation {
  id: string;
  recipientName: string;
  email: string;
  note: string;
  active: boolean;
  // 링크를 재발급하면 증가한다. 서명 안의 값과 다르면 예전 링크는 즉시 무효다.
  tokenVersion: number;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string;
  createdByEmail: string;
  usedAt: string | null;
  usedByUserId: string | null;
  usedByEmail: string | null;
}

export interface InvitationInput {
  recipientName: string;
  email: string;
  note?: string;
  active?: boolean;
}

export interface InvitationPatch {
  recipientName?: string;
  email?: string;
  note?: string;
  active?: boolean;
}

export interface InvitationTokenRef {
  id: string;
  tokenVersion: number;
}

export type LoginFailureReason =
  | "invite_required"
  | "invite_invalid"
  | "invite_inactive"
  | "invite_used"
  | "invite_email_mismatch"
  | "blocked";

export type LoginResult =
  | { ok: true; user: User; session: UserSession; sessionToken?: string }
  | { ok: false; reason: LoginFailureReason };

interface LoginContext {
  userAgent?: string | null;
  issueSessionToken?: (
    userId: string,
    sessionVersion: number,
    sessionId: string,
  ) => Promise<string>;
}

interface UserFile {
  version: 2;
  rev: number;
  users: User[];
  invitations: Invitation[];
}

interface LoadedFile {
  data: UserFile;
  storageVersion: string | null;
}

let cache:
  | { data: UserFile; storageVersion: string | null; at: number; gen: number }
  | null = null;
let stateHint: { version: string; value: UserFile } | null = null;
let generation = 0;
let writeChain: Promise<unknown> = Promise.resolve();

function emptyFile(): UserFile {
  return { version: 2, rev: 0, users: [], invitations: [] };
}

function isoOrEpoch(value: unknown): string {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : new Date(0).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanStoredDeviceLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  if (
    !label ||
    label.length > MAX_DEVICE_LABEL_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(label)
  ) {
    return null;
  }
  return label;
}

export function deviceLabelFromUserAgent(
  userAgent: string | null | undefined,
): string {
  const clean = (userAgent ?? "")
    .slice(0, MAX_USER_AGENT_LENGTH)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const browser = /\bEdg(?:A|iOS)?\//.test(clean)
    ? "Edge"
    : /\b(?:Firefox|FxiOS)\//.test(clean)
      ? "Firefox"
      : /\b(?:Chrome|CriOS)\//.test(clean)
        ? "Chrome"
        : /\bSafari\//.test(clean) && /\bVersion\//.test(clean)
          ? "Safari"
          : "";
  const platform = /Windows NT/.test(clean)
    ? "Windows"
    : /Android/.test(clean)
      ? "Android"
      : /(?:iPhone|iPad|iPod)/.test(clean)
        ? "iPhone/iPad"
        : /CrOS/.test(clean)
          ? "ChromeOS"
          : /Mac OS X/.test(clean)
            ? "macOS"
            : /Linux/.test(clean)
              ? "Linux"
              : "";
  const recognized = [browser, platform].filter(Boolean).join(" · ");
  if (recognized) return recognized;
  return clean.slice(0, MAX_DEVICE_LABEL_LENGTH).trim() || "알 수 없는 기기";
}

function normalizeSessions(value: unknown): UserSession[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, UserSession>();
  for (const raw of value) {
    if (!isRecord(raw) || !isValidSessionId(raw.id)) continue;
    if (
      typeof raw.createdAt !== "string" ||
      raw.createdAt.length > 40 ||
      !Number.isFinite(Date.parse(raw.createdAt))
    ) {
      continue;
    }
    const deviceLabel = cleanStoredDeviceLabel(raw.deviceLabel);
    if (!deviceLabel) continue;
    const session = {
      id: raw.id,
      createdAt: new Date(raw.createdAt).toISOString(),
      deviceLabel,
    };
    const previous = byId.get(session.id);
    if (!previous || previous.createdAt < session.createdAt) {
      byId.set(session.id, session);
    }
  }
  return [...byId.values()]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-MAX_DEVICE_SESSIONS);
}

function appendSession(user: User, session: UserSession): void {
  user.sessions = normalizeSessions([...user.sessions, session]);
}

// v1 users.json을 그대로 읽어 v2 형태로 올린다. 실제 파일은 다음 변경 때 CAS로 저장된다.
function normalize(raw: unknown): UserFile {
  const file = raw as Partial<UserFile> | null;
  if (!file || !Array.isArray(file.users)) return emptyFile();
  const users = file.users
    .filter((u): u is User => !!u && typeof u.id === "string")
    .map((u) => ({
      id: u.id,
      email: typeof u.email === "string" ? normalizeEmail(u.email) : "",
      name: typeof u.name === "string" ? u.name : "",
      status: (u.status === "approved" || u.status === "blocked"
        ? u.status
        : "pending") as UserStatus,
      isAdmin: u.isAdmin === true,
      createdAt: isoOrEpoch(u.createdAt),
      invitationId:
        typeof u.invitationId === "string" ? u.invitationId : null,
      sessionsValidFrom:
        typeof u.sessionsValidFrom === "number" && u.sessionsValidFrom >= 0
          ? u.sessionsValidFrom
          : 0,
      sessionVersion:
        Number.isSafeInteger(u.sessionVersion) && u.sessionVersion >= 0
          ? u.sessionVersion
          : 0,
      sessions: normalizeSessions(u.sessions),
    }));
  const rawInvitations = Array.isArray(file.invitations)
    ? file.invitations
    : [];
  const invitations = rawInvitations
    .filter(
      (invitation): invitation is Invitation =>
        !!invitation && typeof invitation.id === "string",
    )
    .map((invitation) => ({
      id: invitation.id,
      recipientName:
        typeof invitation.recipientName === "string"
          ? invitation.recipientName
          : "",
      email:
        typeof invitation.email === "string"
          ? normalizeEmail(invitation.email)
          : "",
      note: typeof invitation.note === "string" ? invitation.note : "",
      active: invitation.active === true,
      tokenVersion:
        Number.isSafeInteger(invitation.tokenVersion) &&
        invitation.tokenVersion >= 1
          ? invitation.tokenVersion
          : 1,
      createdAt: isoOrEpoch(invitation.createdAt),
      updatedAt: isoOrEpoch(invitation.updatedAt),
      createdByUserId:
        typeof invitation.createdByUserId === "string"
          ? invitation.createdByUserId
          : "",
      createdByEmail:
        typeof invitation.createdByEmail === "string"
          ? normalizeEmail(invitation.createdByEmail)
          : "",
      usedAt:
        typeof invitation.usedAt === "string" ? invitation.usedAt : null,
      usedByUserId:
        typeof invitation.usedByUserId === "string"
          ? invitation.usedByUserId
          : null,
      usedByEmail:
        typeof invitation.usedByEmail === "string"
          ? normalizeEmail(invitation.usedByEmail)
          : null,
    }));
  return {
    version: 2,
    rev: typeof file.rev === "number" ? file.rev : 0,
    users,
    invitations,
  };
}

async function loadState(force = false): Promise<LoadedFile> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) {
    return { data: cache.data, storageVersion: cache.storageVersion };
  }
  const myGen = ++generation;
  const state = await getAdapter().readStateVersioned<UserFile>(
    FILE,
    stateHint ?? undefined,
  );
  const data = normalize(state.value);
  if (state.version) stateHint = { version: state.version, value: data };
  else stateHint = null;
  if (!cache || myGen > cache.gen) {
    cache = {
      data,
      storageVersion: state.version,
      at: Date.now(),
      gen: myGen,
    };
  }
  return { data, storageVersion: state.version };
}

async function load(force = false): Promise<UserFile> {
  return (await loadState(force)).data;
}

// 인스턴스 안에서는 직렬화하고, 인스턴스 사이는 저장소 CAS로 조정한다.
async function mutate<T>(fn: (file: UserFile) => T | Promise<T>): Promise<T> {
  const run = writeChain.then(async () => {
    for (let attempt = 0; attempt <= WRITE_RETRIES; attempt++) {
      const before = await loadState(true);
      const draft = JSON.parse(JSON.stringify(before.data)) as UserFile;
      const result = await fn(draft);
      draft.version = 2;
      draft.rev = before.data.rev + 1;
      try {
        const newVersion = await getAdapter().compareAndSwapState(
          FILE,
          draft,
          before.storageVersion,
        );
        stateHint = newVersion ? { version: newVersion, value: draft } : null;
        cache = {
          data: draft,
          storageVersion: newVersion,
          at: Date.now(),
          gen: ++generation,
        };
        return result;
      } catch (error) {
        cache = null;
        stateHint = null;
        if (
          error instanceof StorageError &&
          error.code === "CONFLICT" &&
          attempt < WRITE_RETRIES
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new StorageError("CONFLICT", "사용자 명단이 계속 변경되고 있습니다");
  });
  writeChain = run.catch(() => undefined);
  return run;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => normalizeEmail(email))
    .filter(Boolean);
}

export function isAdminEmail(email: string): boolean {
  const target = normalizeEmail(email);
  return target.length > 0 && adminEmails().includes(target);
}

function nowFloorSecond(): number {
  return Math.floor(Date.now() / 1000) * 1000;
}

function nextSessionVersion(current: number): number {
  if (!Number.isSafeInteger(current) || current < 0) return 1;
  if (current === Number.MAX_SAFE_INTEGER) {
    throw new Error("세션 버전을 더 이상 올릴 수 없습니다");
  }
  return current + 1;
}

function cleanRequired(value: string, label: string, max: number): string {
  const clean = value.trim();
  if (!clean || clean.length > max) {
    throw new Error(`${label}을(를) 확인해 주세요`);
  }
  return clean;
}

function cleanEmail(value: string): string {
  const email = normalizeEmail(value);
  if (
    !email ||
    email.length > MAX_EMAIL_LENGTH ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new Error("Google 이메일을 확인해 주세요");
  }
  return email;
}

function cleanNote(value: string | undefined): string {
  const note = (value ?? "").trim();
  if (note.length > MAX_NOTE_LENGTH) {
    throw new Error(`비고는 ${MAX_NOTE_LENGTH}자 이하로 입력해 주세요`);
  }
  return note;
}

export async function listUsers(): Promise<User[]> {
  return (await load()).users;
}

export async function findUserById(
  id: string,
  opts?: { fresh?: boolean },
): Promise<User | null> {
  return (await load(opts?.fresh)).users.find((user) => user.id === id) ?? null;
}

export async function listInvitations(): Promise<Invitation[]> {
  return [...(await load()).invitations].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

export async function findInvitation(
  ref: InvitationTokenRef,
  opts?: { fresh?: boolean },
): Promise<
  | { ok: true; invitation: Invitation }
  | { ok: false; reason: "invite_invalid" | "invite_inactive" | "invite_used" }
> {
  const invitation = (await load(opts?.fresh)).invitations.find(
    (item) => item.id === ref.id && item.tokenVersion === ref.tokenVersion,
  );
  if (!invitation) return { ok: false, reason: "invite_invalid" };
  if (invitation.usedAt) return { ok: false, reason: "invite_used" };
  if (!invitation.active) return { ok: false, reason: "invite_inactive" };
  return { ok: true, invitation };
}

export async function createInvitation(
  input: InvitationInput,
  creator: { userId: string; email: string },
): Promise<Invitation> {
  const now = new Date().toISOString();
  const email = cleanEmail(input.email);
  const invitation: Invitation = {
    id: randomUUID(),
    recipientName: cleanRequired(
      input.recipientName,
      "이름",
      MAX_NAME_LENGTH,
    ),
    email,
    note: cleanNote(input.note),
    active: input.active !== false,
    tokenVersion: 1,
    createdAt: now,
    updatedAt: now,
    createdByUserId: creator.userId,
    createdByEmail: normalizeEmail(creator.email),
    usedAt: null,
    usedByUserId: null,
    usedByEmail: null,
  };
  return mutate((file) => {
    // 같은 이메일의 미사용 링크는 최신 것 하나만 남긴다.
    for (const current of file.invitations) {
      if (current.email === email && !current.usedAt && current.active) {
        current.active = false;
        current.updatedAt = now;
      }
    }
    file.invitations.push(invitation);
    return invitation;
  });
}

export async function updateInvitation(
  id: string,
  patch: InvitationPatch,
): Promise<Invitation | null> {
  return mutate((file) => {
    const invitation = file.invitations.find((item) => item.id === id);
    if (!invitation) return null;
    const email = patch.email === undefined ? invitation.email : cleanEmail(patch.email);
    if (invitation.usedAt && (patch.email !== undefined || patch.active === true)) {
      throw new Error("사용 완료 초대는 다시 활성화할 수 없습니다");
    }
    if (patch.recipientName !== undefined) {
      invitation.recipientName = cleanRequired(
        patch.recipientName,
        "이름",
        MAX_NAME_LENGTH,
      );
    }
    if (patch.note !== undefined) invitation.note = cleanNote(patch.note);
    if (patch.active !== undefined) invitation.active = patch.active;
    if (email !== invitation.email) {
      invitation.email = email;
      invitation.tokenVersion += 1;
    }
    invitation.updatedAt = new Date().toISOString();
    return invitation;
  });
}

export async function rotateInvitation(id: string): Promise<Invitation | null> {
  return mutate((file) => {
    const invitation = file.invitations.find((item) => item.id === id);
    if (!invitation) return null;
    if (invitation.usedAt) {
      throw new Error("사용 완료 초대는 새 초대로 다시 만들어 주세요");
    }
    invitation.tokenVersion += 1;
    invitation.active = true;
    invitation.updatedAt = new Date().toISOString();
    return invitation;
  });
}

function upsertProfile(
  file: UserFile,
  profile: { id: string; email: string; name: string },
  status: "approved",
  invitationId: string | null,
): User {
  const email = normalizeEmail(profile.email);
  const admin = isAdminEmail(email);
  let user = file.users.find((item) => item.id === profile.id);
  if (!user) {
    user = {
      id: profile.id,
      email,
      name: profile.name || email,
      status,
      isAdmin: admin,
      createdAt: new Date().toISOString(),
      invitationId,
      sessionsValidFrom: nowFloorSecond(),
      sessionVersion: 0,
      sessions: [],
    };
    file.users.push(user);
    return user;
  }
  user.email = email;
  user.name = profile.name || user.name;
  user.isAdmin = admin;
  user.status = status;
  if (!user.invitationId && invitationId) user.invitationId = invitationId;
  return user;
}

export async function loginWithGoogle(
  profile: { id: string; email: string; name: string },
  inviteRef?: InvitationTokenRef,
  context?: LoginContext,
): Promise<LoginResult> {
  const email = normalizeEmail(profile.email);
  const session: UserSession = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    deviceLabel: deviceLabelFromUserAgent(context?.userAgent),
  };
  return mutate(async (file) => {
    const completeLogin = async (user: User): Promise<LoginResult> => {
      appendSession(user, session);
      if (!context?.issueSessionToken) {
        return { ok: true, user, session };
      }
      const sessionToken = await context.issueSessionToken(
        user.id,
        user.sessionVersion,
        session.id,
      );
      return { ok: true, user, session, sessionToken };
    };
    const existing = file.users.find((user) => user.id === profile.id);
    if (existing?.status === "blocked") {
      return { ok: false, reason: "blocked" } as const;
    }

    if (inviteRef) {
      const invitation = file.invitations.find(
        (item) =>
          item.id === inviteRef.id &&
          item.tokenVersion === inviteRef.tokenVersion,
      );
      if (!invitation) {
        return { ok: false, reason: "invite_invalid" } as const;
      }
      if (invitation.usedAt) {
        return { ok: false, reason: "invite_used" } as const;
      }
      if (!invitation.active) {
        return { ok: false, reason: "invite_inactive" } as const;
      }
      if (invitation.email !== email) {
        return { ok: false, reason: "invite_email_mismatch" } as const;
      }

      const now = new Date().toISOString();
      invitation.active = false;
      invitation.usedAt = now;
      invitation.usedByUserId = profile.id;
      invitation.usedByEmail = email;
      invitation.updatedAt = now;
      const user = upsertProfile(file, profile, "approved", invitation.id);
      return completeLogin(user);
    }

    if (isAdminEmail(email) || existing?.status === "approved") {
      const user = upsertProfile(
        file,
        profile,
        "approved",
        existing?.invitationId ?? null,
      );
      return completeLogin(user);
    }

    return { ok: false, reason: "invite_required" } as const;
  });
}

export async function setStatus(
  id: string,
  status: UserStatus,
): Promise<User | null> {
  return mutate((file) => {
    const user = file.users.find((item) => item.id === id);
    if (!user) return null;
    if (isAdminEmail(user.email) && status !== "approved") {
      throw new Error("관리자 계정은 차단할 수 없습니다");
    }
    user.status = status;
    if (status !== "approved") {
      user.sessionsValidFrom = nowFloorSecond();
      user.sessionVersion = nextSessionVersion(user.sessionVersion);
      user.sessions = [];
    }
    return user;
  });
}

export async function revokeSessions(id: string): Promise<User | null> {
  return mutate((file) => {
    const user = file.users.find((item) => item.id === id);
    if (!user) return null;
    if (isAdminEmail(user.email)) {
      throw new Error("관리자 계정의 세션은 끊을 수 없습니다");
    }
    user.sessionsValidFrom = nowFloorSecond();
    user.sessionVersion = nextSessionVersion(user.sessionVersion);
    user.sessions = [];
    return user;
  });
}

export async function revokeDeviceSession(
  id: string,
  sessionId: string,
): Promise<{ user: User; revoked: boolean } | null> {
  if (!isValidSessionId(sessionId)) {
    throw new Error("올바르지 않은 세션 ID입니다");
  }
  return mutate((file) => {
    const user = file.users.find((item) => item.id === id);
    if (!user) return null;
    if (isAdminEmail(user.email)) {
      throw new Error("관리자 계정의 세션은 끊을 수 없습니다");
    }
    const sessions = user.sessions.filter((session) => session.id !== sessionId);
    if (sessions.length === user.sessions.length) {
      return { user, revoked: false };
    }
    user.sessions = sessions;
    return { user, revoked: true };
  });
}

export async function removeUser(id: string): Promise<boolean> {
  return mutate((file) => {
    const index = file.users.findIndex((user) => user.id === id);
    if (index < 0) return false;
    const email = file.users[index].email;
    if (isAdminEmail(email)) {
      throw new Error("관리자 계정은 삭제할 수 없습니다");
    }
    const now = new Date().toISOString();
    for (const invitation of file.invitations) {
      if (invitation.email !== email || invitation.usedAt) continue;
      invitation.active = false;
      invitation.tokenVersion += 1;
      invitation.updatedAt = now;
    }
    file.users.splice(index, 1);
    return true;
  });
}
