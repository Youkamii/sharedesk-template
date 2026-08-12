import { randomUUID } from "node:crypto";
import { isValidSessionId } from "@/lib/session-token";
import { getAdapter } from "@/lib/storage";
import { StorageError } from "@/lib/storage/types";

// 사용자와 초대 명단은 저장소(.sharedesk/users.json)에 함께 둔다.
// 초대 소비와 사용자 승인이 같은 CAS 쓰기로 끝나야 한 코드가 정확히 한 번만 쓰인다.

const FILE = "users.json";
const CACHE_MS = 5_000;
const WRITE_RETRIES = 3;
export const MIN_INVITATION_DURATION_MINUTES = 5;
export const MAX_INVITATION_DURATION_MINUTES = 30 * 24 * 60;
export const DEFAULT_INVITATION_DURATION_MINUTES = 24 * 60;
export const LEGACY_INVITATION_DURATION_MINUTES = 7 * 24 * 60;
export const MAX_DEVICE_SESSIONS = 20;
export const MAX_DEVICE_LABEL_LENGTH = 80;
const MAX_USER_AGENT_LENGTH = 512;

export type UserStatus = "pending" | "approved" | "blocked";
export type InvitationUsageMode = "once" | "unlimited";

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
  active: boolean;
  // 코드를 재발급하면 증가한다. 파생 코드의 값도 바뀌어 예전 코드는 즉시 무효다.
  tokenVersion: number;
  usageMode: InvitationUsageMode;
  usageCount: number;
  durationMinutes: number;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string;
  createdByEmail: string;
  lastUsedAt: string | null;
  lastUsedByUserId: string | null;
  lastUsedByEmail: string | null;
}

export interface InvitationInput {
  expiresInMinutes?: number;
  usageMode: InvitationUsageMode;
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
  | "invite_expired"
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

export interface UserSessionReference {
  issuedAtSeconds: number;
  sessionVersion?: number;
  sessionId?: string;
}

export type InvitationCheck =
  | { ok: true; invitation: Invitation }
  | {
      ok: false;
      reason:
        | "invite_invalid"
        | "invite_inactive"
        | "invite_used"
        | "invite_expired";
    };

export type InvitationRedemptionResult =
  | { ok: true; user: User }
  | { ok: false; reason: LoginFailureReason };

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

function storedDurationMinutes(value: unknown): number | null {
  return Number.isSafeInteger(value) &&
    (value as number) >= MIN_INVITATION_DURATION_MINUTES &&
    (value as number) <= MAX_INVITATION_DURATION_MINUTES
    ? (value as number)
    : null;
}

function expiresAtFrom(start: string, durationMinutes: number): string {
  return new Date(Date.parse(start) + durationMinutes * 60_000).toISOString();
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
    .map((invitation) => {
      const updatedAt = isoOrEpoch(invitation.updatedAt);
      const legacyUsage = invitation as Invitation & {
        usedAt?: unknown;
        usedByUserId?: unknown;
        usedByEmail?: unknown;
      };
      const legacyRecipientBound =
        typeof (invitation as { recipientName?: unknown }).recipientName ===
          "string" ||
        typeof (invitation as { email?: unknown }).email === "string" ||
        typeof (invitation as { note?: unknown }).note === "string";
      const storedTokenVersion =
        Number.isSafeInteger(invitation.tokenVersion) &&
        invitation.tokenVersion >= 1
          ? invitation.tokenVersion
          : 1;
      const tokenVersion = legacyRecipientBound
        ? storedTokenVersion === Number.MAX_SAFE_INTEGER
          ? 1
          : storedTokenVersion + 1
        : storedTokenVersion;
      const durationMinutes =
        storedDurationMinutes(invitation.durationMinutes) ??
        LEGACY_INVITATION_DURATION_MINUTES;
      const hasStoredDuration =
        storedDurationMinutes(invitation.durationMinutes) !== null;
      const expiresAt =
        hasStoredDuration &&
        typeof invitation.expiresAt === "string" &&
        Number.isFinite(Date.parse(invitation.expiresAt))
          ? new Date(invitation.expiresAt).toISOString()
          : expiresAtFrom(updatedAt, durationMinutes);
      const usageMode: InvitationUsageMode =
        invitation.usageMode === "unlimited" ? "unlimited" : "once";
      const lastUsedAtSource =
        typeof invitation.lastUsedAt === "string"
          ? invitation.lastUsedAt
          : legacyUsage.usedAt;
      const lastUsedAt =
        typeof lastUsedAtSource === "string"
          ? isoOrEpoch(lastUsedAtSource)
          : null;
      const storedUsageCount =
        Number.isSafeInteger(invitation.usageCount) &&
        invitation.usageCount >= 0
          ? invitation.usageCount
          : 0;
      const usageCount = Math.max(storedUsageCount, lastUsedAt ? 1 : 0);
      return {
        id: invitation.id,
        // 예전 이메일 전용 코드를 같은 값의 범용 코드로 넓히지 않는다.
        // 관리자가 다시 활성화하거나 회전하면 새 버전의 범용 코드가 표시된다.
        active: invitation.active === true && !legacyRecipientBound,
        tokenVersion,
        usageMode,
        usageCount,
        durationMinutes,
        expiresAt,
        createdAt: isoOrEpoch(invitation.createdAt),
        updatedAt,
        createdByUserId:
          typeof invitation.createdByUserId === "string"
            ? invitation.createdByUserId
            : "",
        createdByEmail:
          typeof invitation.createdByEmail === "string"
            ? normalizeEmail(invitation.createdByEmail)
            : "",
        lastUsedAt,
        lastUsedByUserId:
          typeof invitation.lastUsedByUserId === "string"
            ? invitation.lastUsedByUserId
            : typeof legacyUsage.usedByUserId === "string"
              ? legacyUsage.usedByUserId
              : null,
        lastUsedByEmail:
          typeof invitation.lastUsedByEmail === "string"
            ? normalizeEmail(invitation.lastUsedByEmail)
            : typeof legacyUsage.usedByEmail === "string"
              ? normalizeEmail(legacyUsage.usedByEmail)
              : null,
      };
    });
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
async function mutate<T>(
  fn: (file: UserFile) => T | Promise<T>,
  shouldWrite: (result: T) => boolean = () => true,
): Promise<T> {
  const run = writeChain.then(async () => {
    for (let attempt = 0; attempt <= WRITE_RETRIES; attempt++) {
      const before = await loadState(true);
      const draft = JSON.parse(JSON.stringify(before.data)) as UserFile;
      const result = await fn(draft);
      if (!shouldWrite(result)) return result;
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

function cleanInvitationDuration(value: number | undefined): number {
  const duration = value ?? DEFAULT_INVITATION_DURATION_MINUTES;
  if (
    !Number.isSafeInteger(duration) ||
    duration < MIN_INVITATION_DURATION_MINUTES ||
    duration > MAX_INVITATION_DURATION_MINUTES
  ) {
    throw new Error(
      `초대 기간은 ${MIN_INVITATION_DURATION_MINUTES}분부터 ${MAX_INVITATION_DURATION_MINUTES}분까지의 정수여야 합니다`,
    );
  }
  return duration;
}

export function isInvitationExpired(
  invitation: Pick<Invitation, "expiresAt">,
  now = Date.now(),
): boolean {
  const expiresAt = Date.parse(invitation.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

function invitationFailureReason(
  invitation: Invitation,
): Extract<
  LoginFailureReason,
  "invite_inactive" | "invite_used" | "invite_expired"
> | null {
  if (invitation.usageMode === "once" && invitation.usageCount > 0) {
    return "invite_used";
  }
  if (isInvitationExpired(invitation)) return "invite_expired";
  if (!invitation.active) return "invite_inactive";
  return null;
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

export async function listInvitations(opts?: {
  fresh?: boolean;
}): Promise<Invitation[]> {
  return [...(await load(opts?.fresh)).invitations].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

export async function findInvitation(
  ref: InvitationTokenRef,
  opts?: { fresh?: boolean },
): Promise<InvitationCheck> {
  const invitation = (await load(opts?.fresh)).invitations.find(
    (item) => item.id === ref.id && item.tokenVersion === ref.tokenVersion,
  );
  if (!invitation) return { ok: false, reason: "invite_invalid" };
  const reason = invitationFailureReason(invitation);
  if (reason) return { ok: false, reason };
  return { ok: true, invitation };
}

export async function createInvitation(
  input: InvitationInput,
  creator: { userId: string; email: string },
): Promise<Invitation> {
  const now = new Date(Date.now()).toISOString();
  const durationMinutes = cleanInvitationDuration(input.expiresInMinutes);
  if (input.usageMode !== "once" && input.usageMode !== "unlimited") {
    throw new Error("초대 사용 방식을 확인해 주세요");
  }
  const invitation: Invitation = {
    id: randomUUID(),
    active: true,
    tokenVersion: 1,
    usageMode: input.usageMode,
    usageCount: 0,
    durationMinutes,
    expiresAt: expiresAtFrom(now, durationMinutes),
    createdAt: now,
    updatedAt: now,
    createdByUserId: creator.userId,
    createdByEmail: normalizeEmail(creator.email),
    lastUsedAt: null,
    lastUsedByUserId: null,
    lastUsedByEmail: null,
  };
  return mutate((file) => {
    file.invitations.push(invitation);
    return invitation;
  });
}

export async function setInvitationActive(
  id: string,
  active: boolean,
): Promise<Invitation | null> {
  return mutate((file) => {
    const invitation = file.invitations.find((item) => item.id === id);
    if (!invitation) return null;
    if (
      invitation.usageMode === "once" &&
      invitation.usageCount > 0 &&
      active
    ) {
      throw new Error("사용 완료 초대는 다시 활성화할 수 없습니다");
    }
    invitation.active = active;
    invitation.updatedAt = new Date().toISOString();
    return invitation;
  });
}

export async function rotateInvitation(id: string): Promise<Invitation | null> {
  return mutate((file) => {
    const invitation = file.invitations.find((item) => item.id === id);
    if (!invitation) return null;
    if (invitation.usageMode === "once" && invitation.usageCount > 0) {
      throw new Error("사용 완료 초대는 새 초대로 다시 만들어 주세요");
    }
    const now = new Date(Date.now()).toISOString();
    invitation.tokenVersion += 1;
    invitation.active = true;
    invitation.updatedAt = now;
    invitation.expiresAt = expiresAtFrom(now, invitation.durationMinutes);
    return invitation;
  });
}

function upsertProfile(
  file: UserFile,
  profile: { id: string; email: string; name: string },
  status: "approved" | "pending",
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

    if (isAdminEmail(email) || existing?.status === "approved") {
      const user = upsertProfile(
        file,
        profile,
        "approved",
        existing?.invitationId ?? null,
      );
      return completeLogin(user);
    }

    const user = upsertProfile(file, profile, "pending", null);
    return completeLogin(user);
  });
}

function userSessionReferenceIsCurrent(
  user: User,
  reference: UserSessionReference,
): boolean {
  if (
    !Number.isFinite(reference.issuedAtSeconds) ||
    (reference.sessionVersion === undefined && user.sessionVersion !== 0) ||
    (reference.sessionVersion !== undefined &&
      reference.sessionVersion !== user.sessionVersion) ||
    reference.issuedAtSeconds * 1000 < user.sessionsValidFrom
  ) {
    return false;
  }
  if (reference.sessionId === undefined) return true;
  return user.sessions.some((session) => session.id === reference.sessionId);
}

export async function redeemInvitationForUser(
  userId: string,
  ref: InvitationTokenRef,
  sessionReference?: UserSessionReference,
): Promise<InvitationRedemptionResult> {
  return mutate<InvitationRedemptionResult>((file) => {
    const user = file.users.find((item) => item.id === userId);
    if (!user) return { ok: false, reason: "invite_required" } as const;
    if (user.status === "blocked") {
      return { ok: false, reason: "blocked" } as const;
    }
    if (user.status !== "pending") {
      return { ok: false, reason: "invite_required" } as const;
    }
    if (
      sessionReference &&
      !userSessionReferenceIsCurrent(user, sessionReference)
    ) {
      return { ok: false, reason: "invite_required" } as const;
    }

    const invitation = file.invitations.find(
      (item) =>
        item.id === ref.id && item.tokenVersion === ref.tokenVersion,
    );
    if (!invitation) {
      return { ok: false, reason: "invite_invalid" } as const;
    }
    const reason = invitationFailureReason(invitation);
    if (reason) return { ok: false, reason } as const;

    const now = new Date(Date.now()).toISOString();
    if (invitation.usageMode === "once") invitation.active = false;
    invitation.usageCount += 1;
    invitation.lastUsedAt = now;
    invitation.lastUsedByUserId = user.id;
    invitation.lastUsedByEmail = user.email;
    invitation.updatedAt = now;
    user.status = "approved";
    if (!user.invitationId) user.invitationId = invitation.id;
    return { ok: true, user } as const;
  }, (result) => result.ok);
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
    file.users.splice(index, 1);
    return true;
  });
}
