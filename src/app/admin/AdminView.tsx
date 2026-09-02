"use client";

import ShareOutButton from "../ShareOutButton";
import QrCodeToggle from "../QrCodeToggle";

import { apiPath } from "@/lib/client/api-path";
import {
  type CSSProperties,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import {
  LOCALE_BCP47,
  LOCALE_LABELS,
  LOCALES,
  parseLocale,
  translate,
  type DeskLocaleSettings,
  type Locale,
} from "@/lib/i18n";
import {
  ROLE_LABELS,
  USER_ROLES,
  resolveUserRole,
  type UserRole,
} from "@/lib/roles";
import type { User } from "@/lib/users";
import styles from "./admin.module.css";
import PublicFoldersPanel from "./PublicFoldersPanel";
import type { ActivityAction, ActivityEntry } from "@/lib/activity";

type InvitationState = "active" | "inactive" | "used" | "expired";
type InvitationUsageMode = "once" | "unlimited";

interface InvitationSummary {
  id: string;
  createdAt: string;
  createdByEmail: string;
  expiresAt: string;
  durationMinutes: number;
  usageMode: InvitationUsageMode;
  role: UserRole;
  usageCount: number;
  lastUsedAt: string | null;
  lastUsedByEmail: string | null;
  state: InvitationState;
  code: string | null;
}

type LastInvitationAccess = {
  invitationId: string;
  code: string;
};

interface OwnerRegistryStatus {
  enabled: boolean;
  unset: boolean;
  version: string;
  site: string | null;
  repository: string | null;
  error: string | null;
}

// 관리자 페이지 좌측 탭 — 사용자(기존 초대·사용자 관리)와 설정(언어·테마·바탕화면).
type AdminTab = "users" | "public" | "settings" | "activity";

// 활동 종류별 표시 문구 — 서버의 ActivityAction 값과 1:1. 타입을 좁혀
// 서버에 액션이 늘면 컴파일러가 라벨 누락을 잡는다.
const ACTIVITY_LABELS: Record<ActivityAction, string> = {
  upload: "업로드",
  trash: "휴지통으로 이동",
  restore: "복원",
  purge: "완전 삭제",
  "empty-trash": "휴지통 비우기",
  rename: "이름 변경",
  move: "이동",
  mkdir: "새 폴더",
  edit: "내용 수정",
  nickname: "닉네임 변경",
};

// 테마는 화면 전체의 UI·질감이고 바탕화면은 그 위에 까는 그림이다 — 서로 다른 설정.
// 지금 쓰는 도트 화면이 기본 테마이며, 테마가 늘어나면 이 목록에 추가한다.
const THEMES = [{ id: "classic", name: "기본" }] as const;
type ThemeId = (typeof THEMES)[number]["id"];

// 바탕화면은 개인 취향이라 FilesView와 같은 localStorage 키에 저장한다.
// 파일 화면이 다음 로드 때 이 값을 읽어 반영한다 (FilesView.tsx와 리터럴 일치).
const WALLPAPER_STORAGE_KEY = "sharedesk.wallpaper";
const WALLPAPERS = [
  { id: "dusk", name: "해 질 녘", src: "/art/sharedesk-dusk.png" },
  { id: "night", name: "깊은 밤", src: "/art/wall-night.png" },
  { id: "dawn", name: "여명", src: "/art/wall-dawn.png" },
  { id: "tide", name: "밤바다", src: "/art/wall-tide.png" },
] as const;
type WallpaperId = (typeof WALLPAPERS)[number]["id"];

const STATUS_LABEL: Record<User["status"], string> = {
  pending: "코드 입력 대기",
  approved: "승인됨",
  blocked: "차단됨",
};

const STATUS_STYLE: Record<User["status"], string> = {
  pending: styles.statusPending,
  approved: styles.statusApproved,
  blocked: styles.statusBlocked,
};

const INVITE_LABEL: Record<InvitationState, string> = {
  active: "사용 가능",
  inactive: "비활성",
  used: "사용 완료",
  expired: "기간 만료",
};

const INVITE_STYLE: Record<InvitationState, string> = {
  active: styles.statusApproved,
  inactive: styles.statusInactive,
  used: styles.statusUsed,
  expired: styles.statusPending,
};

const USAGE_MODE_LABEL: Record<InvitationUsageMode, string> = {
  once: "1회용",
  unlimited: "기간 내 무제한",
};

type Translator = (
  text: string,
  vars?: Record<string, string | number>,
) => string;

type AdminDeskSettings = DeskLocaleSettings & {
  autoUpdate: boolean;
  maxUploadBytes: number | null;
  deskStorageLimitBytes: number | null;
};

type StorageStatus = {
  deskUsedBytes: number;
  hostUsedBytes: number | null;
  hostLimitBytes: number | null;
  reservedBytes: number;
};

const GIB = 1024 ** 3;

function bytesAsInputGiB(value: number | null): string {
  return value === null ? "" : String(Number((value / GIB).toFixed(3)));
}

function formatBytes(value: number | null): string {
  if (value === null) return "—";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let amount = value;
  let unit = -1;
  do {
    amount /= 1024;
    unit += 1;
  } while (amount >= 1024 && unit < units.length - 1);
  return `${amount >= 100 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

function byteLimitFromForm(value: FormDataEntryValue | null): number | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  const gib = Number(text);
  if (!Number.isFinite(gib) || gib <= 0) {
    throw new Error("용량은 0보다 큰 GB 값으로 입력해 주세요");
  }
  const bytes = Math.round(gib * GIB);
  if (!Number.isSafeInteger(bytes)) {
    throw new Error("용량 값이 너무 큽니다");
  }
  return bytes;
}

function formatDate(value: string | null, locale: Locale): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(LOCALE_BCP47[locale], {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
}

function formatDuration(minutes: number, t: Translator): string {
  if (minutes === 60) return t("1시간");
  if (minutes === 1_440) return t("24시간");
  if (minutes === 10_080) return t("7일");
  if (minutes === 43_200) return t("30일");
  return t("{분}분", { 분: minutes });
}

export default function AdminView({ locale }: { locale: Locale }) {
  const router = useRouter();
  const t = useCallback<Translator>(
    (text, vars) => translate(locale, text, vars),
    [locale],
  );
  const mutationInFlightRef = useRef(false);
  const [users, setUsers] = useState<User[]>([]);
  const [invitations, setInvitations] = useState<InvitationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [lastAccess, setLastAccess] = useState<LastInvitationAccess | null>(null);
  const [ownerRegistry, setOwnerRegistry] =
    useState<OwnerRegistryStatus | null>(null);
  const [ownerRegistryBusy, setOwnerRegistryBusy] = useState(false);
  const [inviteForm, setInviteForm] = useState({
    expiresInMinutes: 1_440,
    usageMode: "once" as InvitationUsageMode,
    role: "editor" as UserRole,
  });
  const [activeTab, setActiveTab] = useState<AdminTab>("users");
  const [deskSettings, setDeskSettings] = useState<
    AdminDeskSettings | null
  >(null);
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null);
  // 활동 탭 — 열 때마다 최근 활동을 새로 불러온다.
  const [activity, setActivity] = useState<
    { entries: ActivityEntry[] } | { error: string } | null
  >(null);
  // 별 감지 대기 — 버튼 한 번이면 앱이 몇 초 간격으로 별을 재확인하다가
  // 감지되는 순간 자동으로 켠다. 타이머는 ref에 들고 언마운트 때 정리한다.
  const [starWaiting, setStarWaiting] = useState(false);
  const starPollTimerRef = useRef<number | null>(null);
  const starPollDeadlineRef = useRef(0);
  useEffect(() => {
    return () => {
      if (starPollTimerRef.current !== null) {
        window.clearTimeout(starPollTimerRef.current);
      }
    };
  }, []);
  // 자동 업데이트가 켜졌을 때 설정 화면에서 보여 주는 버전·릴리스 정보.
  const [updateInfo, setUpdateInfo] = useState<{
    currentVersion: string | null;
    latestVersion: string | null;
    latestNotes: string | null;
    failed: boolean;
  } | null>(null);
  const [wallpaperId, setWallpaperId] = useState<WallpaperId>("dusk");
  // 테마는 아직 기본 하나뿐이라 선택 상태만 보여 준다.
  const [themeId, setThemeId] = useState<ThemeId>("classic");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [userResponse, inviteResponse] = await Promise.all([
        fetch(apiPath("/api/admin/users")),
        fetch(apiPath("/api/admin/invitations")),
      ]);
      if (
        userResponse.status === 401 ||
        userResponse.status === 403 ||
        inviteResponse.status === 401 ||
        inviteResponse.status === 403
      ) {
        router.replace("/files");
        return;
      }
      const [userBody, inviteBody] = await Promise.all([
        userResponse.json().catch(() => null),
        inviteResponse.json().catch(() => null),
      ]);
      if (!userResponse.ok) {
        throw new Error(userBody?.error ?? t("사용자 목록을 불러오지 못했습니다"));
      }
      if (!inviteResponse.ok) {
        throw new Error(inviteBody?.error ?? t("초대 목록을 불러오지 못했습니다"));
      }
      setUsers(userBody.users);
      setInvitations(inviteBody.invitations);
      setLastAccess((current) => {
        if (!current) return null;
        const invitation = inviteBody.invitations.find(
          (item: InvitationSummary) => item.id === current.invitationId,
        );
        return invitation?.state === "active" && invitation.code
          ? {
              invitationId: invitation.id,
              code: invitation.code,
            }
          : null;
      });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : t("관리 정보를 불러오지 못했습니다"),
      );
    } finally {
      setLoading(false);
    }
  }, [router, t]);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(initial);
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    const initial = window.setTimeout(() => {
      void fetch(apiPath("/api/admin/owner-registry"), {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          if (response.status === 401 || response.status === 403) {
            router.replace("/files");
            return null;
          }
          const body = (await response.json().catch(() => null)) as
            | OwnerRegistryStatus
            | { error?: string }
            | null;
          if (!response.ok || !body || !("enabled" in body)) {
            throw new Error(
              body?.error ?? t("설치 등록부 상태를 확인하지 못했습니다"),
            );
          }
          return body;
        })
        .then((status) => {
          if (status) setOwnerRegistry(status);
        })
        .catch((caught) => {
          if (caught instanceof DOMException && caught.name === "AbortError") return;
          setError(
            caught instanceof Error
              ? caught.message
              : t("설치 등록부 상태를 확인하지 못했습니다"),
          );
        });
    }, 0);
    return () => {
      window.clearTimeout(initial);
      controller.abort();
    };
  }, [router, t]);

  // 설정 탭의 데스크 언어 값 — 마운트 때 한 번 현재값을 불러온다.
  useEffect(() => {
    const controller = new AbortController();
    const initial = window.setTimeout(() => {
      void fetch(apiPath("/api/admin/desk-settings"), {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          if (response.status === 401 || response.status === 403) {
            router.replace("/files");
            return null;
          }
          const body = (await response.json().catch(() => null)) as {
            locale?: unknown;
            allowMemberLocale?: unknown;
            autoUpdate?: unknown;
            maxUploadBytes?: unknown;
            deskStorageLimitBytes?: unknown;
            error?: string;
          } | null;
          const deskLocale = parseLocale(body?.locale);
          if (
            !response.ok ||
            !body ||
            !deskLocale ||
            typeof body.allowMemberLocale !== "boolean"
          ) {
            throw new Error(
              body?.error ?? t("데스크 설정을 불러오지 못했습니다"),
            );
          }
          return {
            locale: deskLocale,
            allowMemberLocale: body.allowMemberLocale,
            autoUpdate: body.autoUpdate === true,
            maxUploadBytes:
              body.maxUploadBytes === null ||
              Number.isSafeInteger(body.maxUploadBytes)
                ? (body.maxUploadBytes as number | null)
                : null,
            deskStorageLimitBytes:
              body.deskStorageLimitBytes === null ||
              Number.isSafeInteger(body.deskStorageLimitBytes)
                ? (body.deskStorageLimitBytes as number | null)
                : null,
          };
        })
        .then((settings) => {
          if (settings) setDeskSettings(settings);
        })
        .catch((caught) => {
          if (caught instanceof DOMException && caught.name === "AbortError") return;
          setError(
            caught instanceof Error
              ? caught.message
              : t("데스크 설정을 불러오지 못했습니다"),
          );
        });
    }, 0);
    return () => {
      window.clearTimeout(initial);
      controller.abort();
    };
  }, [router, t]);

  const loadStorage = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const response = await fetch(apiPath("/api/storage/usage"), {
          cache: "no-store",
          signal,
        });
        if (response.status === 401 || response.status === 403) {
          router.replace("/files");
          return;
        }
        const body = (await response.json().catch(() => null)) as
          | (StorageStatus & { error?: string })
          | null;
        if (
          !response.ok ||
          !body ||
          !Number.isSafeInteger(body.deskUsedBytes) ||
          !Number.isSafeInteger(body.reservedBytes)
        ) {
          throw new Error(body?.error ?? t("저장 용량을 불러오지 못했습니다"));
        }
        setStorageStatus(body);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(
          caught instanceof Error
            ? caught.message
            : t("저장 용량을 불러오지 못했습니다"),
        );
      }
    },
    [router, t],
  );

  useEffect(() => {
    if (activeTab !== "settings") return;
    const controller = new AbortController();
    const refresh = () => void loadStorage(controller.signal);
    const initial = window.setTimeout(refresh, 0);
    const interval = window.setInterval(refresh, 60_000);
    const onVisibility = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      controller.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [activeTab, loadStorage]);

  // 바탕화면 선택은 개인 설정 — FilesView와 같은 키의 localStorage에서 읽는다.
  // 렌더 직후 한 틱 미뤄 읽어 effect 안의 동기 setState(연쇄 렌더)를 피한다.
  useEffect(() => {
    const initial = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(WALLPAPER_STORAGE_KEY);
        if (saved && WALLPAPERS.some((wallpaper) => wallpaper.id === saved)) {
          setWallpaperId(saved as WallpaperId);
        }
      } catch {
        // 저장소 접근이 막힌 브라우저에서는 기본값을 보여 준다.
      }
    }, 0);
    return () => window.clearTimeout(initial);
  }, []);

  // 자동 업데이트가 켜진 동안에는 설정 화면이 업데이트 버튼을 대신해
  // 현재 버전과 최신 릴리스 내용을 보여 준다. 릴리스는 공개 저장소라
  // 키 없이 GitHub 공개 API로 읽는다.
  const autoUpdateOn = deskSettings?.autoUpdate === true;
  useEffect(() => {
    if (!autoUpdateOn) return;
    const controller = new AbortController();
    const initial = window.setTimeout(() => {
      void Promise.all([
        fetch(apiPath("/api/update-policy"), {
          cache: "no-store",
          signal: controller.signal,
        })
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null),
        fetch(
          "https://api.github.com/repos/Youkamii/sharedesk-template/releases/latest",
          { signal: controller.signal },
        )
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null),
      ]).then(([policy, release]) => {
        if (controller.signal.aborted) return;
        const currentVersion =
          typeof (policy as { currentVersion?: unknown } | null)
            ?.currentVersion === "string"
            ? ((policy as { currentVersion: string }).currentVersion)
            : null;
        const tag = (release as { tag_name?: unknown } | null)?.tag_name;
        const notes = (release as { body?: unknown } | null)?.body;
        setUpdateInfo({
          currentVersion,
          latestVersion:
            typeof tag === "string" ? tag.replace(/^v/, "") : null,
          latestNotes:
            typeof notes === "string" && notes.trim().length > 0
              ? notes.trim().slice(0, 1200)
              : null,
          failed: currentVersion === null && typeof tag !== "string",
        });
      });
    }, 0);
    return () => {
      window.clearTimeout(initial);
      controller.abort();
    };
  }, [autoUpdateOn]);

  // 자동 업데이트 중 즉시 업데이트 — 예약된 자동 실행을 기다리지 않고
  // 지금 바로 올린다. 서버 게이트(별 동의·중복 실행)는 POST가 판정하고,
  // 여기서는 그 결과만 단계로 보여 준다.
  const [instantUpdate, setInstantUpdate] = useState<
    | { phase: "idle" }
    | { phase: "starting" }
    | { phase: "started" }
    | { phase: "star"; starPageUrl: string }
    | { phase: "failed"; message: string }
  >({ phase: "idle" });

  async function startInstantUpdate(agreeToStar = false) {
    setInstantUpdate({ phase: "starting" });
    try {
      const response = await fetch(apiPath("/api/admin/update"), {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ star: agreeToStar }),
      });
      const body = (await response.json().catch(() => null)) as {
        error?: unknown;
        starRequired?: unknown;
        starPageUrl?: unknown;
      } | null;
      if (response.status === 409 && body?.starRequired === true) {
        setInstantUpdate({
          phase: "star",
          starPageUrl:
            typeof body.starPageUrl === "string" && body.starPageUrl
              ? body.starPageUrl
              : "https://github.com/Youkamii/sharedesk-template",
        });
        return;
      }
      // 이미 진행 중인 실행(409)은 실패가 아니다 — 그 실행을 탄 것으로 본다.
      if (!response.ok && response.status !== 409) {
        throw new Error(
          typeof body?.error === "string"
            ? body.error
            : "업데이트를 시작하지 못했습니다",
        );
      }
      setInstantUpdate({ phase: "started" });
    } catch (cause) {
      setInstantUpdate({
        phase: "failed",
        message: t(
          cause instanceof Error && cause.message
            ? cause.message
            : "업데이트를 시작하지 못했습니다",
        ),
      });
    }
  }

  useEffect(() => {
    if (activeTab !== "activity") return;
    const controller = new AbortController();
    const initial = window.setTimeout(() => {
      void fetch(apiPath("/api/admin/activity"), {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          if (response.status === 401 || response.status === 403) {
            router.replace("/files");
            return;
          }
          const body = (await response.json().catch(() => null)) as {
            entries?: unknown;
            error?: string;
          } | null;
          if (!response.ok || !Array.isArray(body?.entries)) {
            setActivity({
              error: body?.error ?? t("활동을 불러오지 못했습니다"),
            });
            return;
          }
          setActivity({ entries: body.entries as ActivityEntry[] });
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setActivity({ error: t("활동을 불러오지 못했습니다") });
          }
        });
    }, 0);
    return () => {
      window.clearTimeout(initial);
      controller.abort();
    };
  }, [activeTab, router, t]);

  async function recordCurrentInstallation() {
    if (!ownerRegistry?.enabled || ownerRegistryBusy) return;
    setOwnerRegistryBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(apiPath("/api/admin/owner-registry"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      if (response.status === 401 || response.status === 403) {
        router.replace("/files");
        return;
      }
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        created?: boolean;
        error?: string;
        status?: OwnerRegistryStatus;
      } | null;
      if (!response.ok || body?.ok !== true) {
        throw new Error(body?.error ?? t("현재 설치 정보를 등록하지 못했습니다"));
      }
      if (body.status) setOwnerRegistry(body.status);
      setNotice(
        body.created
          ? t("ShareDesk {버전} 설치 정보를 등록했습니다.", {
              버전: ownerRegistry.version,
            })
          : t("ShareDesk {버전} 기록을 갱신했습니다.", {
              버전: ownerRegistry.version,
            }),
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : t("현재 설치 정보를 등록하지 못했습니다"),
      );
    } finally {
      setOwnerRegistryBusy(false);
    }
  }

  function beginMutation(operationId: string): boolean {
    if (mutationInFlightRef.current) return false;
    mutationInFlightRef.current = true;
    setBusyId(operationId);
    return true;
  }

  function finishMutation() {
    mutationInFlightRef.current = false;
    setBusyId(null);
  }

  async function act(id: string, action: string, sessionId?: string) {
    const operationId = sessionId
      ? `session:${id}:${sessionId}`
      : `user:${id}`;
    if (!beginMutation(operationId)) return;
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(apiPath("/api/admin/users"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action, sessionId }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? t("처리하지 못했습니다"));
      if (body?.warning) setNotice(body.warning);
      else if (action === "revoke-session") {
        setNotice(t("선택한 로그인을 끊었습니다"));
      }
      setConfirmRemoveId(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("처리하지 못했습니다"));
    } finally {
      finishMutation();
    }
  }

  async function changeRole(id: string, role: UserRole) {
    if (!beginMutation(`user:${id}`)) return;
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(apiPath("/api/admin/users"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "role", role }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? t("처리하지 못했습니다"));
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("처리하지 못했습니다"));
    } finally {
      finishMutation();
    }
  }

  async function createInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!beginMutation("invite:create")) return;
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(apiPath("/api/admin/invitations"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(inviteForm),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? t("초대 코드를 만들지 못했습니다"));
      }
      setLastAccess(
        body.invitation.state === "active" &&
          body.invitation.code
          ? {
              invitationId: body.invitation.id,
              code: body.invitation.code,
            }
          : null,
      );
      setInviteForm({
        expiresInMinutes: 1_440,
        usageMode: "once",
        role: "editor",
      });
      setNotice(t("초대 코드를 만들었습니다. 아래 코드를 전달해 주세요."));
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : t("초대 코드를 만들지 못했습니다"),
      );
    } finally {
      finishMutation();
    }
  }

  async function invitationAction(
    invitation: InvitationSummary,
    action: "toggle" | "rotate",
  ) {
    if (!beginMutation(`invite:${invitation.id}`)) return;
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(apiPath("/api/admin/invitations"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "rotate"
            ? { id: invitation.id, action: "rotate" }
            : {
                id: invitation.id,
                action: "update",
                active: invitation.state !== "active",
              },
        ),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? t("초대를 바꾸지 못했습니다"));
      }
      if (action === "rotate") {
        setLastAccess(
          body.invitation.code
            ? {
                invitationId: body.invitation.id,
                code: body.invitation.code,
              }
            : null,
        );
        setNotice(
          t(
            "예전 코드를 무효화하고 같은 사용 기간의 새 코드를 만들었습니다. 사용 횟수와 마지막 사용 기록은 유지됩니다.",
          ),
        );
      } else if (
        body.invitation.state === "active" &&
        body.invitation.code
      ) {
        setLastAccess({
          invitationId: body.invitation.id,
          code: body.invitation.code,
        });
      } else {
        setLastAccess((current) =>
          current?.invitationId === invitation.id ? null : current,
        );
      }
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : t("초대를 바꾸지 못했습니다"),
      );
    } finally {
      finishMutation();
    }
  }

  async function copyInvitationValue(
    value: string,
    invitation: LastInvitationAccess,
  ) {
    if (mutationInFlightRef.current) return;
    setError(null);
    try {
      await navigator.clipboard.writeText(value);
      setNotice(t("초대 코드를 복사했습니다."));
    } catch {
      setLastAccess(invitation);
      setNotice(t("아래 코드를 직접 선택해 복사해 주세요."));
    }
  }

  // 데스크 언어·개별 언어 허용을 부분 갱신한다. 알림 문구는 한국어 원문으로
  // 저장해 두면 router.refresh()로 언어가 바뀐 뒤에도 그 언어로 번역돼 나온다.
  async function updateDeskSettings(
    patch: {
      locale?: Locale;
      allowMemberLocale?: boolean;
      autoUpdate?: boolean;
      autoUpdateTimezone?: string;
      maxUploadBytes?: number | null;
      deskStorageLimitBytes?: number | null;
      star?: boolean;
    },
    successNotice: string,
  ) {
    if (!beginMutation("desk-settings")) return;
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(apiPath("/api/admin/desk-settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (response.status === 401 || response.status === 403) {
        router.replace("/files");
        return;
      }
      const body = (await response.json().catch(() => null)) as {
        locale?: unknown;
        allowMemberLocale?: unknown;
        autoUpdate?: unknown;
        maxUploadBytes?: unknown;
        deskStorageLimitBytes?: unknown;
        error?: string;
      } | null;
      const savedLocale = parseLocale(body?.locale);
      if (
        !response.ok ||
        !body ||
        !savedLocale ||
        typeof body.allowMemberLocale !== "boolean"
      ) {
        throw new Error(
          typeof body?.error === "string"
            ? t(body.error)
            : t("데스크 설정을 저장하지 못했습니다"),
        );
      }
      setDeskSettings({
        locale: savedLocale,
        allowMemberLocale: body.allowMemberLocale,
        autoUpdate: body.autoUpdate === true,
        maxUploadBytes:
          body.maxUploadBytes === null || Number.isSafeInteger(body.maxUploadBytes)
            ? (body.maxUploadBytes as number | null)
            : null,
        deskStorageLimitBytes:
          body.deskStorageLimitBytes === null ||
          Number.isSafeInteger(body.deskStorageLimitBytes)
            ? (body.deskStorageLimitBytes as number | null)
            : null,
      });
      setNotice(successNotice);
      // 데스크 언어·개별 언어 허용 둘 다 지금 보이는 화면 언어를 바꿀 수 있다.
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : t("데스크 설정을 저장하지 못했습니다"),
      );
    } finally {
      finishMutation();
    }
  }

  async function saveStorageLimits(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const maxUploadBytes = byteLimitFromForm(form.get("maxUploadGiB"));
      const deskStorageLimitBytes = byteLimitFromForm(
        form.get("deskStorageLimitGiB"),
      );
      if (
        maxUploadBytes !== null &&
        deskStorageLimitBytes !== null &&
        maxUploadBytes > deskStorageLimitBytes
      ) {
        throw new Error("한 번 업로드 제한은 데스크 전체 제한보다 작아야 합니다");
      }
      await updateDeskSettings(
        { maxUploadBytes, deskStorageLimitBytes },
        "저장 용량 제한을 바꿨습니다.",
      );
      await loadStorage();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? t(caught.message)
          : t("용량 제한 값을 확인해 주세요"),
      );
    }
  }

  // 자동 업데이트 켜기 한 번의 시도. 결과만 돌려주고 알림·상태는 호출부가 정한다.
  async function tryEnableAutoUpdate(): Promise<"on" | "waiting" | "failed"> {
    try {
      const response = await fetch(apiPath("/api/admin/desk-settings"), {
        method: "PATCH",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          autoUpdate: true,
          autoUpdateTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          star: true,
        }),
      });
      if (response.status === 401 || response.status === 403) {
        router.replace("/files");
        return "failed";
      }
      const body = (await response.json().catch(() => null)) as {
        autoUpdate?: unknown;
        allowMemberLocale?: unknown;
        locale?: unknown;
        starRequired?: unknown;
        error?: string;
      } | null;
      if (response.ok && body?.autoUpdate === true) {
        const savedLocale = parseLocale(body.locale);
        if (savedLocale && typeof body.allowMemberLocale === "boolean") {
          setDeskSettings((current) => ({
            locale: savedLocale,
            allowMemberLocale: body.allowMemberLocale as boolean,
            autoUpdate: true,
            maxUploadBytes: current?.maxUploadBytes ?? null,
            deskStorageLimitBytes: current?.deskStorageLimitBytes ?? null,
          }));
        }
        setNotice(t("이제 자정에 자동으로 업데이트됩니다."));
        setError(null);
        router.refresh();
        return "on";
      }
      if (response.status === 409 && body?.starRequired === true) {
        return "waiting";
      }
      setError(body?.error ?? t("자동 업데이트를 켜지 못했습니다"));
      return "failed";
    } catch {
      setError(t("자동 업데이트를 켜지 못했습니다"));
      return "failed";
    }
  }

  function stopStarPolling() {
    if (starPollTimerRef.current !== null) {
      window.clearTimeout(starPollTimerRef.current);
      starPollTimerRef.current = null;
    }
    setStarWaiting(false);
  }

  function scheduleStarPoll() {
    starPollTimerRef.current = window.setTimeout(() => {
      void (async () => {
        const result = await tryEnableAutoUpdate();
        if (result === "waiting") {
          if (Date.now() < starPollDeadlineRef.current) {
            scheduleStarPoll();
            return;
          }
          setError(t("별을 확인하지 못했습니다. 별을 누른 뒤 버튼을 다시 눌러 주세요"));
        }
        stopStarPolling();
      })();
    }, 5_000);
  }

  async function startEnableAutoUpdate() {
    if (starWaiting) return;
    // GitHub 버튼답게 저장소 페이지를 연다 — 사용자는 거기서 별만 누르면
    // 되고, 앱이 몇 초 간격으로 감지해 자동으로 켠다.
    window.open(
      "https://github.com/Youkamii/sharedesk-template",
      "_blank",
      "noopener",
    );
    const result = await tryEnableAutoUpdate();
    if (result !== "waiting") return;
    setStarWaiting(true);
    setError(null);
    setNotice(t("GitHub에서 별을 누르면 자동으로 켜집니다."));
    // 별 감지는 최대 3분까지 기다린다.
    starPollDeadlineRef.current = Date.now() + 180_000;
    scheduleStarPoll();
  }

  function selectWallpaper(id: WallpaperId) {
    setWallpaperId(id);
    try {
      window.localStorage.setItem(WALLPAPER_STORAGE_KEY, id);
    } catch {
      // 시크릿 모드 등에서 저장이 막혀도 이 화면의 선택 표시는 유지된다.
    }
  }

  const buttonClass = styles.pixelButton;
  const inputClass = styles.select;
  const pending = users.filter((user) => user.status === "pending");
  const storageUsedBytes = storageStatus?.deskUsedBytes ?? null;
  const storageReservedBytes = storageStatus?.reservedBytes ?? 0;
  const storageLimitBytes = deskSettings?.deskStorageLimitBytes ?? null;
  const storageUsedPercent =
    storageUsedBytes !== null && storageLimitBytes !== null
      ? Math.min(100, (storageUsedBytes / storageLimitBytes) * 100)
      : 0;
  const storageTotalPercent =
    storageUsedBytes !== null && storageLimitBytes !== null
      ? Math.min(
          100,
          ((storageUsedBytes + storageReservedBytes) / storageLimitBytes) * 100,
        )
      : 0;
  const storageRemainingBytes =
    storageUsedBytes !== null && storageLimitBytes !== null
      ? Math.max(
          0,
          storageLimitBytes - storageUsedBytes - storageReservedBytes,
        )
      : null;
  const storageDonutStyle = {
    "--storage-used": `${storageUsedPercent}%`,
    "--storage-total": `${storageTotalPercent}%`,
  } as CSSProperties;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headingGroup}>
          <span className={styles.brandMark} aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <div>
            <p className={styles.eyebrow}>SHAREDESK / ADMIN TOOL</p>
            <h1 className={styles.pageTitle}>{t("관리자")}</h1>
          </div>
        </div>
        <div className={styles.headerActions}>
          {/* 언어 변경은 설정 탭 안으로 옮겼다 — 헤더에는 토글을 두지 않는다. */}
          {/* 선택 기능인 설치 등록부는 아예 설정하지 않은 설치에서는 숨긴다.
              값을 넣었는데 틀린 설정 오류는 고칠 수 있도록 계속 보여 준다. */}
          {ownerRegistry && !ownerRegistry.unset && (
            <span
              className={styles.registryControl}
              title={ownerRegistry.error ?? undefined}
            >
              <span
                className={`${styles.registryLamp} ${ownerRegistry.enabled ? styles.registryLampOn : ""}`}
                aria-hidden="true"
              />
              {ownerRegistry.enabled ? (
                <button
                  type="button"
                  className={styles.registryButton}
                  disabled={ownerRegistryBusy}
                  onClick={() => void recordCurrentInstallation()}
                >
                  {ownerRegistryBusy ? t("등록 중…") : t("현재 설치 등록")}
                </button>
              ) : (
                <span className={styles.registryLabel}>
                  {ownerRegistry.error ?? t("등록부 확인 중")}
                </span>
              )}
            </span>
          )}
          <a href="/files" className={styles.headerLink}>
            <span aria-hidden="true">←</span>
            {t("파일로 돌아가기")}
          </a>
        </div>
      </header>

      <main className={styles.main}>
        {pending.length > 0 && (
          <p
            className={`${styles.message} ${styles.warningMessage}`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <span className={styles.messageMark} aria-hidden="true">!</span>
            {t("초대 코드 입력을 기다리는 사용자가 {인원}명 있습니다.", {
              인원: pending.length,
            })}
          </p>
        )}
        {error && (
          <p
            className={`${styles.message} ${styles.errorMessage}`}
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
          >
            <span className={styles.messageMark} aria-hidden="true">×</span>
            {/* 서버 오류 문구도 사전에 있으면 번역돼 나간다. */}
            {t(error)}
          </p>
        )}
        {notice && (
          <p
            className={`${styles.message} ${styles.noticeMessage}`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <span className={styles.messageMark} aria-hidden="true">✓</span>
            {t(notice)}
          </p>
        )}

        <div className={styles.layout}>
          <div
            role="tablist"
            aria-label={t("관리 메뉴")}
            aria-orientation="vertical"
            className={styles.tabRail}
          >
            <button
              type="button"
              role="tab"
              id="tab-users"
              aria-selected={activeTab === "users"}
              aria-controls="panel-users"
              className={`${styles.tabButton} ${activeTab === "users" ? styles.tabButtonActive : ""}`}
              onClick={() => setActiveTab("users")}
            >
              {t("사용자")}
            </button>
            <button
              type="button"
              role="tab"
              id="tab-public"
              aria-selected={activeTab === "public"}
              aria-controls="panel-public"
              className={`${styles.tabButton} ${activeTab === "public" ? styles.tabButtonActive : ""}`}
              onClick={() => setActiveTab("public")}
            >
              {t("공개 폴더")}
            </button>
            <button
              type="button"
              role="tab"
              id="tab-settings"
              aria-selected={activeTab === "settings"}
              aria-controls="panel-settings"
              className={`${styles.tabButton} ${activeTab === "settings" ? styles.tabButtonActive : ""}`}
              onClick={() => setActiveTab("settings")}
            >
              {t("설정")}
            </button>
            <button
              type="button"
              role="tab"
              id="tab-activity"
              aria-selected={activeTab === "activity"}
              aria-controls="panel-activity"
              className={`${styles.tabButton} ${activeTab === "activity" ? styles.tabButtonActive : ""}`}
              onClick={() => setActiveTab("activity")}
            >
              {t("활동")}
            </button>
          </div>

          <div
            role="tabpanel"
            id="panel-users"
            aria-labelledby="tab-users"
            hidden={activeTab !== "users"}
            className={styles.tabPanel}
          >
            <section aria-labelledby="invite-title">
              <div className={styles.window}>
                <header className={styles.windowTitlebar}>
                  <span className={styles.windowTitle}>
                    <span className={styles.inviteGlyph} aria-hidden="true" />
                    <h2 id="invite-title">{t("초대 코드")}</h2>
                  </span>
                  <span className={styles.windowMeta} aria-hidden="true">INVITES</span>
                </header>
                <div className={styles.windowBody}>
                  <p id="invite-description" className={styles.description}>
                    {t(
                      "받는 사람을 미리 지정하지 않습니다. Google 로그인 후 가입 대기 중인 사용자가 코드를 입력해 가입합니다. 1회용은 한 명이 가입하면 소진됩니다. 기간 내 무제한은 만료되거나 관리자가 끌 때까지 여러 명이 함께 씁니다.",
                    )}
                  </p>

                  <form onSubmit={createInvite} className={styles.inviteForm}>
                    <label className={styles.field}>
                      <span>{t("유효 기간")}</span>
                      <select
                        value={inviteForm.expiresInMinutes}
                        onChange={(event) =>
                          setInviteForm((current) => ({
                            ...current,
                            expiresInMinutes: Number(event.target.value),
                          }))
                        }
                        className={inputClass}
                      >
                        <option value={60}>{t("1시간")}</option>
                        <option value={1_440}>{t("24시간 (기본)")}</option>
                        <option value={10_080}>{t("7일")}</option>
                        <option value={43_200}>{t("30일")}</option>
                      </select>
                    </label>
                    <label className={styles.field}>
                      <span>{t("사용 방식")}</span>
                      <select
                        value={inviteForm.usageMode}
                        onChange={(event) =>
                          setInviteForm((current) => ({
                            ...current,
                            usageMode: event.target.value as InvitationUsageMode,
                          }))
                        }
                        className={inputClass}
                      >
                        <option value="once">{t("1회용")}</option>
                        <option value="unlimited">{t("기간 내 무제한")}</option>
                      </select>
                    </label>
                    <label className={styles.field}>
                      <span>{t("역할")}</span>
                      <select
                        value={inviteForm.role}
                        onChange={(event) =>
                          setInviteForm((current) => ({
                            ...current,
                            role: resolveUserRole(event.target.value),
                          }))
                        }
                        className={inputClass}
                      >
                        {USER_ROLES.map((role) => (
                          <option key={role} value={role}>
                            {t(ROLE_LABELS[role])}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="submit"
                      disabled={busyId !== null}
                      className={`${styles.pixelButton} ${styles.primaryButton}`}
                    >
                      {busyId === "invite:create" ? t("생성 중…") : t("초대 코드 생성")}
                    </button>
                  </form>

                  {lastAccess && (
                    <div className={styles.codePanel}>
                      <p className={styles.codeLabel}>{t("지금 전달할 초대 코드")}</p>
                      <div className={styles.codeRow}>
                        <input
                          readOnly
                          value={lastAccess.code}
                          onFocus={(event) => event.currentTarget.select()}
                          className={styles.codeInput}
                          aria-label={t("생성된 초대 코드")}
                        />
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() =>
                            void copyInvitationValue(lastAccess.code, lastAccess)
                          }
                          className={buttonClass}
                        >
                          {t("코드 복사")}
                        </button>
                        <ShareOutButton
                          text={lastAccess.code}
                          label={t("공유")}
                          className={buttonClass}
                          disabled={busyId !== null}
                          onOutcome={(outcome) => {
                            if (outcome === "copied") {
                              setNotice(t("초대 코드를 복사했습니다."));
                            } else if (outcome === "manual") {
                              setNotice(
                                t("아래 코드를 직접 선택해 복사해 주세요."),
                              );
                            }
                          }}
                        />
                        {/* 폰 카메라로 찍으면 코드가 채워진 가입 화면이
                            열린다(/join?code=…) — 온보딩이 "보여주고 찍기"로
                            끝난다(#15 A-5). */}
                        <QrCodeToggle
                          value={`${window.location.origin}/join?code=${encodeURIComponent(lastAccess.code)}`}
                          label="QR"
                          closeLabel={t("닫기")}
                          className={buttonClass}
                        />
                      </div>
                    </div>
                  )}

                  <div
                    className={styles.tableRegion}
                    role="region"
                    aria-labelledby="invite-title"
                    aria-describedby="invite-description"
                    tabIndex={0}
                  >
                    <table className={`${styles.table} ${styles.inviteTable}`}>
                      <caption className={styles.srOnly}>
                        {t("초대 코드의 만료일, 사용 기록, 상태와 관리 작업")}
                      </caption>
                      <thead>
                        <tr className={styles.tableHeadRow}>
                          <th>{t("초대 코드")}</th>
                          <th>{t("만료일")}</th>
                          <th>{t("사용 방식")}</th>
                          <th>{t("사용 기록")}</th>
                          <th>{t("생성 정보")}</th>
                          <th>{t("상태")}</th>
                          <th><span className={styles.srOnly}>{t("관리 작업")}</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {loading ? (
                          <tr>
                            <td colSpan={7} className={styles.emptyCell}>
                              {t("불러오는 중…")}
                            </td>
                          </tr>
                        ) : invitations.length === 0 ? (
                          <tr>
                            <td colSpan={7} className={styles.emptyCell}>
                              {t("아직 만든 초대가 없습니다")}
                            </td>
                          </tr>
                        ) : (
                          invitations.map((invitation) => (
                            <tr key={invitation.id} className={styles.tableRow}>
                              <td className={styles.codeCell}>
                                {invitation.code ?? "—"}
                              </td>
                              <td className={styles.compactCell}>
                                <div>{formatDate(invitation.expiresAt, locale)}</div>
                                <div>
                                  {formatDuration(invitation.durationMinutes, t)}
                                </div>
                              </td>
                              <td className={styles.compactCell}>
                                <div>{t(USAGE_MODE_LABEL[invitation.usageMode])}</div>
                                <div>
                                  {t(ROLE_LABELS[resolveUserRole(invitation.role)])}
                                </div>
                              </td>
                              <td className={styles.compactCell}>
                                <div>
                                  {t("{횟수}회", { 횟수: invitation.usageCount })}
                                </div>
                                {invitation.lastUsedAt && (
                                  <div>
                                    {invitation.lastUsedByEmail} · {formatDate(invitation.lastUsedAt, locale)}
                                  </div>
                                )}
                              </td>
                              <td className={styles.compactCell}>
                                <div>{invitation.createdByEmail}</div>
                                <div>{formatDate(invitation.createdAt, locale)}</div>
                              </td>
                              <td>
                                <span className={`${styles.statusBadge} ${INVITE_STYLE[invitation.state]}`}>
                                  {t(INVITE_LABEL[invitation.state])}
                                </span>
                              </td>
                              <td className={styles.actionsCell}>
                                {invitation.state !== "used" && (
                                  <span className={styles.rowActions}>
                                    {invitation.state === "active" && invitation.code && (
                                      <>
                                      <button
                                        type="button"
                                        disabled={busyId !== null}
                                        onClick={() =>
                                          void copyInvitationValue(invitation.code!, {
                                            invitationId: invitation.id,
                                            code: invitation.code!,
                                          })
                                        }
                                        className={buttonClass}
                                      >
                                        {t("코드 복사")}
                                      </button>
                                      <ShareOutButton
                                        text={invitation.code!}
                                        label={t("공유")}
                                        className={buttonClass}
                                        disabled={busyId !== null}
                                        onOutcome={(outcome) => {
                                          if (outcome === "copied") {
                                            setNotice(
                                              t("초대 코드를 복사했습니다."),
                                            );
                                          } else if (outcome === "manual") {
                                            setLastAccess({
                                              invitationId: invitation.id,
                                              code: invitation.code!,
                                            });
                                            setNotice(
                                              t("아래 코드를 직접 선택해 복사해 주세요."),
                                            );
                                          }
                                        }}
                                      />
                                      <QrCodeToggle
                                        value={`${window.location.origin}/join?code=${encodeURIComponent(invitation.code!)}`}
                                        label="QR"
                                        closeLabel={t("닫기")}
                                        className={buttonClass}
                                      />
                                      </>
                                    )}
                                    {invitation.state !== "expired" && (
                                      <button
                                        type="button"
                                        disabled={busyId !== null}
                                        onClick={() =>
                                          void invitationAction(invitation, "toggle")
                                        }
                                        className={buttonClass}
                                      >
                                        {invitation.state === "active"
                                          ? t("비활성")
                                          : t("활성")}
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      disabled={busyId !== null}
                                      onClick={() =>
                                        void invitationAction(invitation, "rotate")
                                      }
                                      className={buttonClass}
                                    >
                                      {t("새 코드")}
                                    </button>
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </section>

            <section aria-labelledby="user-title">
              <div className={styles.window}>
                <header className={`${styles.windowTitlebar} ${styles.userTitlebar}`}>
                  <span className={styles.windowTitle}>
                    <span className={styles.userGlyph} aria-hidden="true" />
                    <h2 id="user-title">{t("사용자")}</h2>
                  </span>
                  <span className={styles.windowMeta} aria-hidden="true">
                    {users.length.toString().padStart(2, "0")} USERS
                  </span>
                </header>
                <div className={styles.windowBody}>
                  <div
                    className={styles.tableRegion}
                    role="region"
                    aria-labelledby="user-title"
                    tabIndex={0}
                  >
                    <table className={`${styles.table} ${styles.userTable}`}>
                      <caption className={styles.srOnly}>
                        {t("사용자 등록일, 상태, 역할, 로그인 기기와 관리 작업")}
                      </caption>
                      <thead>
                        <tr className={styles.tableHeadRow}>
                          <th>{t("사용자")}</th>
                          <th>{t("등록일")}</th>
                          <th>{t("상태")}</th>
                          <th>{t("역할")}</th>
                          <th>{t("로그인 기기")}</th>
                          <th><span className={styles.srOnly}>{t("관리 작업")}</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {loading ? (
                          <tr>
                            <td colSpan={6} className={styles.emptyCell}>
                              {t("불러오는 중…")}
                            </td>
                          </tr>
                        ) : users.length === 0 ? (
                          <tr>
                            <td colSpan={6} className={styles.emptyCell}>
                              {t("아직 등록된 사용자가 없습니다")}
                            </td>
                          </tr>
                        ) : (
                          users.map((user) => (
                            <tr key={user.id} className={styles.tableRow}>
                              <td>
                                <div className={styles.userName}>
                                  {user.nickname ?? user.name}
                                  {user.isAdmin && (
                                    <span className={styles.adminBadge}>
                                      {t("관리자")}
                                    </span>
                                  )}
                                </div>
                                {/* 닉네임이 있으면 구글 이름을 함께 보여 준다(#13). */}
                                {user.nickname && (
                                  <div className={styles.userEmail}>
                                    {user.name}
                                  </div>
                                )}
                                <div className={styles.userEmail}>{user.email}</div>
                                {(user.nicknameHistory?.length ?? 0) > 0 && (
                                  <details className={styles.userEmail}>
                                    <summary>
                                      {t("닉 변경 기록 {count}건", {
                                        count: user.nicknameHistory.length,
                                      })}
                                    </summary>
                                    <ul>
                                      {user.nicknameHistory.map((entry) => (
                                        <li key={`${entry.at}-${entry.nickname}`}>
                                          {entry.nickname} —{" "}
                                          {formatDate(entry.at, locale)}
                                        </li>
                                      ))}
                                    </ul>
                                  </details>
                                )}
                              </td>
                              <td className={styles.compactCell}>
                                {formatDate(user.createdAt, locale)}
                              </td>
                              <td>
                                <span className={`${styles.statusBadge} ${STATUS_STYLE[user.status]}`}>
                                  {t(STATUS_LABEL[user.status])}
                                </span>
                              </td>
                              <td>
                                {user.isAdmin ? (
                                  <span className={styles.muted}>{t("관리자")}</span>
                                ) : (
                                  <select
                                    value={resolveUserRole(user.role)}
                                    disabled={busyId !== null}
                                    onChange={(event) =>
                                      void changeRole(
                                        user.id,
                                        resolveUserRole(event.target.value),
                                      )
                                    }
                                    className={`${styles.select} ${styles.roleSelect}`}
                                    aria-label={t("{이름} 역할 변경", {
                                      이름: user.name,
                                    })}
                                  >
                                    {USER_ROLES.map((role) => (
                                      <option key={role} value={role}>
                                        {t(ROLE_LABELS[role])}
                                      </option>
                                    ))}
                                  </select>
                                )}
                              </td>
                              <td>
                                {user.sessions.length === 0 ? (
                                  <span className={styles.muted}>{t("기록 없음")}</span>
                                ) : (
                                  <ul className={styles.sessionList}>
                                    {[...user.sessions].reverse().map((session) => (
                                      <li key={session.id} className={styles.sessionRow}>
                                        <span className={styles.sessionInfo}>
                                          <span className={styles.sessionDevice}>
                                            {session.deviceLabel}
                                          </span>
                                          <span className={styles.sessionDate}>
                                            {formatDate(session.createdAt, locale)}
                                          </span>
                                        </span>
                                        {!user.isAdmin ? (
                                          <button
                                            disabled={busyId !== null}
                                            onClick={() =>
                                              void act(user.id, "revoke-session", session.id)
                                            }
                                            className={`${styles.pixelButton} ${styles.dangerButton}`}
                                          >
                                            {t("이 로그인 끊기")}
                                          </button>
                                        ) : null}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </td>
                              <td className={styles.actionsCell}>
                                {user.isAdmin ? (
                                  <span className={styles.muted}>—</span>
                                ) : confirmRemoveId === user.id ? (
                                  <span className={styles.rowActions}>
                                    <button
                                      disabled={busyId !== null}
                                      onClick={() => void act(user.id, "remove")}
                                      className={`${styles.pixelButton} ${styles.dangerButton}`}
                                    >
                                      {t("삭제 확인")}
                                    </button>
                                    <button
                                      onClick={() => setConfirmRemoveId(null)}
                                      className={buttonClass}
                                    >
                                      {t("취소")}
                                    </button>
                                  </span>
                                ) : (
                                  <span className={styles.rowActions}>
                                    {user.status === "approved" && (
                                      <>
                                        <button
                                          disabled={busyId !== null}
                                          onClick={() => void act(user.id, "revoke")}
                                          className={buttonClass}
                                          title={t(
                                            "이 사람의 모든 기기에서 로그인을 끊습니다",
                                          )}
                                        >
                                          {t("모든 로그인 끊기")}
                                        </button>
                                        <button
                                          disabled={busyId !== null}
                                          onClick={() => void act(user.id, "block")}
                                          className={buttonClass}
                                        >
                                          {t("차단")}
                                        </button>
                                      </>
                                    )}
                                    {user.status === "blocked" && (
                                      <button
                                        disabled={busyId !== null}
                                        onClick={() => void act(user.id, "pending")}
                                        className={buttonClass}
                                      >
                                        {t("대기로")}
                                      </button>
                                    )}
                                    <button
                                      onClick={() => setConfirmRemoveId(user.id)}
                                      className={buttonClass}
                                    >
                                      {t("삭제")}
                                    </button>
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                  <ul className={styles.helpList}>
                    <li>
                      {t(
                        "차단하면 화면 접근은 즉시 막히고, 열려 있던 파일 목록도 최대 5초 안에 끊깁니다.",
                      )}
                    </li>
                    <li>
                      {t(
                        "차단·모든 로그인 끊기를 하면 기존 로그인이 전부 무효가 되어, 다시 가입 대기로 바꾼 뒤에도 새로 로그인하고 초대 코드를 입력해야 합니다.",
                      )}
                    </li>
                  </ul>
                </div>
              </div>
            </section>
          </div>

          <div
            role="tabpanel"
            id="panel-public"
            aria-labelledby="tab-public"
            hidden={activeTab !== "public"}
            className={styles.tabPanel}
          >
            <PublicFoldersPanel locale={locale} active={activeTab === "public"} />
          </div>

          <div
            role="tabpanel"
            id="panel-settings"
            aria-labelledby="tab-settings"
            hidden={activeTab !== "settings"}
            className={styles.tabPanel}
          >
            <section aria-labelledby="locale-title">
              <div className={styles.window}>
                <header
                  className={`${styles.windowTitlebar} ${styles.localeTitlebar}`}
                >
                  <span className={styles.windowTitle}>
                    <span className={styles.localeGlyph} aria-hidden="true" />
                    <h2 id="locale-title">{t("언어")}</h2>
                  </span>
                  {/* 데스크 언어와 별개로, 참여자 개인의 언어 선택을 허용할지. */}
                  <label
                    className={styles.allowToggle}
                    htmlFor="allow-member-locale"
                  >
                    <input
                      id="allow-member-locale"
                      type="checkbox"
                      checked={deskSettings?.allowMemberLocale ?? false}
                      disabled={deskSettings === null || busyId !== null}
                      onChange={(event) =>
                        void updateDeskSettings(
                          { allowMemberLocale: event.target.checked },
                          event.target.checked
                            ? "이제 참여자가 자기 화면 언어를 따로 고를 수 있습니다."
                            : "이제 모든 참여자 화면에 데스크 언어가 적용됩니다.",
                        )
                      }
                    />
                    {t("개별 언어 허용")}
                  </label>
                </header>
                <div className={styles.windowBody}>
                  <p className={styles.description}>
                    {t(
                      "데스크 언어는 모든 참여자 화면에 함께 적용됩니다. 개별 언어 허용을 켜면 참여자가 자기 화면 언어를 따로 고를 수 있습니다.",
                    )}
                  </p>
                  <label className={`${styles.field} ${styles.settingsField}`}>
                    <span>{t("데스크 언어")}</span>
                    <select
                      value={deskSettings?.locale ?? locale}
                      disabled={deskSettings === null || busyId !== null}
                      onChange={(event) => {
                        const next = parseLocale(event.target.value);
                        if (next) {
                          void updateDeskSettings(
                            { locale: next },
                            "데스크 언어를 바꿨습니다.",
                          );
                        }
                      }}
                      className={inputClass}
                    >
                      {LOCALES.map((item) => (
                        <option key={item} value={item}>
                          {LOCALE_LABELS[item]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
            </section>

            <section aria-labelledby="storage-title">
              <div className={styles.window}>
                <header className={styles.windowTitlebar}>
                  <span className={styles.windowTitle}>
                    <h2 id="storage-title">{t("저장 용량")}</h2>
                  </span>
                  <span className={styles.windowMeta}>STORAGE</span>
                </header>
                <div className={styles.windowBody}>
                  <div className={styles.storageLayout}>
                    <div>
                      <p className={styles.description}>
                        {t(
                          "한 파일의 최대 업로드 크기와 이 데스크가 사용할 수 있는 전체 용량을 정합니다. 비워 두면 제한하지 않습니다.",
                        )}
                      </p>
                      <form
                        key={`${deskSettings?.maxUploadBytes ?? "none"}:${deskSettings?.deskStorageLimitBytes ?? "none"}`}
                        onSubmit={(event) => void saveStorageLimits(event)}
                      >
                        <label className={`${styles.field} ${styles.settingsField}`}>
                          <span>{t("한 파일 업로드 제한 (GB)")}</span>
                          <input
                            name="maxUploadGiB"
                            type="number"
                            min="0.001"
                            step="0.001"
                            inputMode="decimal"
                            defaultValue={bytesAsInputGiB(
                              deskSettings?.maxUploadBytes ?? null,
                            )}
                            disabled={deskSettings === null || busyId !== null}
                            placeholder={t("제한 없음")}
                            className={inputClass}
                          />
                        </label>
                        <label className={`${styles.field} ${styles.settingsField}`}>
                          <span>{t("데스크 전체 제한 (GB)")}</span>
                          <input
                            name="deskStorageLimitGiB"
                            type="number"
                            min="0.001"
                            step="0.001"
                            inputMode="decimal"
                            defaultValue={bytesAsInputGiB(
                              deskSettings?.deskStorageLimitBytes ?? null,
                            )}
                            disabled={deskSettings === null || busyId !== null}
                            placeholder={t("제한 없음")}
                            className={inputClass}
                          />
                        </label>
                        <button
                          type="submit"
                          className={`${styles.pixelButton} ${styles.storageSubmit}`}
                          disabled={deskSettings === null || busyId !== null}
                        >
                          {t("용량 제한 저장")}
                        </button>
                      </form>
                    </div>

                    <aside
                      className={styles.storageMeter}
                      aria-label={`${t("데스크 사용량")}: ${formatBytes(storageUsedBytes)} / ${formatBytes(storageLimitBytes)}`}
                    >
                      <div
                        className={`${styles.storageDonut} ${storageLimitBytes === null ? styles.storageDonutUnlimited : ""}`}
                        style={storageDonutStyle}
                        aria-hidden="true"
                      >
                        <span className={styles.storageDonutCenter}>
                          <strong>{formatBytes(storageUsedBytes)}</strong>
                          <small>
                            {storageLimitBytes === null
                              ? t("제한 없음")
                              : `${Math.round(storageTotalPercent)}%`}
                          </small>
                        </span>
                      </div>
                      <dl className={styles.storageLegend}>
                        <div>
                          <dt><i className={styles.storageUsedMark} />{t("데스크 사용량")}</dt>
                          <dd>{formatBytes(storageUsedBytes)}</dd>
                        </div>
                        <div>
                          <dt><i className={styles.storageReservedMark} />{t("업로드 중")}</dt>
                          <dd>{formatBytes(storageReservedBytes)}</dd>
                        </div>
                        <div>
                          <dt><i className={styles.storageFreeMark} />{t("남은 용량")}</dt>
                          <dd>
                            {storageLimitBytes === null
                              ? t("제한 없음")
                              : formatBytes(storageRemainingBytes)}
                          </dd>
                        </div>
                      </dl>
                    </aside>
                  </div>
                  <p className={`${styles.description} ${styles.hostStorageSummary}`}>
                    {t("호스트 사용량")}: {formatBytes(storageStatus?.hostUsedBytes ?? null)}
                    {" / "}
                    {formatBytes(storageStatus?.hostLimitBytes ?? null)}
                  </p>
                </div>
              </div>
            </section>

            <section aria-labelledby="auto-update-title">
              <div className={styles.window}>
                <header className={styles.windowTitlebar}>
                  <span className={styles.windowTitle}>
                    <h2 id="auto-update-title">{t("업데이트")}</h2>
                  </span>
                  {autoUpdateOn && (
                    <button
                      type="button"
                      className={styles.pixelButton}
                      disabled={deskSettings === null || busyId !== null}
                      onClick={() =>
                        void updateDeskSettings(
                          { autoUpdate: false },
                          "자동 업데이트를 껐습니다. 작업표시줄의 업데이트 버튼으로 직접 업데이트할 수 있습니다.",
                        )
                      }
                    >
                      {t("자동 업데이트 멈추기")}
                    </button>
                  )}
                </header>
                <div className={styles.windowBody}>
                  {/* 설정을 아직 못 읽었을 때(업데이트 직후 콜드 스타트 등)
                      "꺼짐"으로 그리면 켜 둔 사람에게 풀린 것처럼 보인다 —
                      로딩은 로딩으로 표시한다. */}
                  <p className={styles.description}>
                    <strong>
                      {deskSettings === null
                        ? t("불러오는 중…")
                        : autoUpdateOn
                          ? t("매 자정에 새로운 버전으로 업데이트됩니다.")
                          : t("템플릿 자동 업데이트를 위해 별을 눌러주세요.")}
                    </strong>
                  </p>
                  {deskSettings !== null && !autoUpdateOn && (
                    <button
                      type="button"
                      className={styles.githubStarButton}
                      aria-label={t("자동 업데이트")}
                      disabled={
                        deskSettings === null || busyId !== null || starWaiting
                      }
                      onClick={() => void startEnableAutoUpdate()}
                    >
                      <svg
                        className={styles.githubMark}
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                        focusable="false"
                      >
                        <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
                      </svg>
                      <span>{starWaiting ? t("별 확인 중…") : "Github"}</span>
                      <span className={styles.starGlyph} aria-hidden="true">
                        ★
                      </span>
                    </button>
                  )}
                  {autoUpdateOn && updateInfo && (
                    <div className={styles.description}>
                      {updateInfo.failed ? (
                        <p>{t("최신 릴리스 정보를 불러오지 못했습니다")}</p>
                      ) : (
                        <>
                          {updateInfo.currentVersion && (
                            <p>
                              {t("현재 버전")}: {updateInfo.currentVersion}
                            </p>
                          )}
                          {updateInfo.latestVersion && (
                            <p>
                              {t("최신 버전")}: {updateInfo.latestVersion}
                              {updateInfo.currentVersion ===
                                updateInfo.latestVersion &&
                                ` — ${t("지금 최신 버전입니다")}`}
                            </p>
                          )}
                          {/* 새 버전이 있으면 자동 실행 예약을 기다리지 않고
                              지금 바로 올릴 수 있다(즉시 업데이트). */}
                          {updateInfo.latestVersion &&
                            updateInfo.currentVersion !==
                              updateInfo.latestVersion && (
                              <div className={styles.instantUpdate}>
                                {instantUpdate.phase === "star" ? (
                                  <>
                                    <p>
                                      {t(
                                        "ShareDesk는 GitHub 저장소의 별로 응원을 받습니다. 업데이트를 시작하려면 별 남기기에 동의해 주세요. 관리자 GitHub 계정으로 별이 추가됩니다.",
                                      )}
                                    </p>
                                    <a
                                      className={styles.pixelButton}
                                      href={instantUpdate.starPageUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      {t("저장소 열기")}
                                    </a>
                                    <button
                                      type="button"
                                      className={styles.pixelButton}
                                      onClick={() =>
                                        void startInstantUpdate(true)
                                      }
                                    >
                                      {t("GitHub에 별 남기기")}
                                    </button>
                                  </>
                                ) : instantUpdate.phase === "started" ? (
                                  <p role="status">
                                    {t(
                                      "업데이트를 시작했습니다. 완료되면 데스크가 새 버전으로 다시 시작됩니다.",
                                    )}
                                  </p>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      className={styles.pixelButton}
                                      disabled={
                                        instantUpdate.phase === "starting"
                                      }
                                      onClick={() => void startInstantUpdate()}
                                    >
                                      {instantUpdate.phase === "starting"
                                        ? t("업데이트 시작 중…")
                                        : t("지금 업데이트")}
                                    </button>
                                    {instantUpdate.phase === "failed" && (
                                      <p role="alert">{instantUpdate.message}</p>
                                    )}
                                  </>
                                )}
                              </div>
                            )}
                          {updateInfo.latestNotes && (
                            <pre className={styles.releaseNotes}>
                              {updateInfo.latestNotes}
                            </pre>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </section>

            <section aria-labelledby="theme-title">
              <div className={styles.window}>
                <header
                  className={`${styles.windowTitlebar} ${styles.themeTitlebar}`}
                >
                  <span className={styles.windowTitle}>
                    <span className={styles.themeGlyph} aria-hidden="true" />
                    <h2 id="theme-title">{t("테마")}</h2>
                  </span>
                  <span className={styles.windowMeta} aria-hidden="true">
                    THEME
                  </span>
                </header>
                <div className={styles.windowBody}>
                  <p className={styles.description}>
                    {t(
                      "테마는 화면 전체의 모양과 질감입니다. 지금 쓰는 도트 화면이 기본 테마이고, 앞으로 늘어납니다.",
                    )}
                  </p>
                  <div
                    className={styles.wallpaperGrid}
                    role="group"
                    aria-label={t("테마")}
                  >
                    {THEMES.map((theme) => (
                      <button
                        key={theme.id}
                        type="button"
                        aria-pressed={themeId === theme.id}
                        className={`${styles.wallpaperOption} ${themeId === theme.id ? styles.wallpaperSelected : ""}`}
                        onClick={() => setThemeId(theme.id)}
                      >
                        <span
                          className={`${styles.wallpaperThumb} ${styles.themeThumb}`}
                          aria-hidden="true"
                        />
                        <span className={styles.wallpaperName}>
                          {t(theme.name)}
                          {themeId === theme.id && (
                            <span className={styles.wallpaperCheck}>
                              {t("현재 선택")}
                            </span>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            <section aria-labelledby="wallpaper-title">
              <div className={styles.window}>
                <header
                  className={`${styles.windowTitlebar} ${styles.themeTitlebar}`}
                >
                  <span className={styles.windowTitle}>
                    <span className={styles.themeGlyph} aria-hidden="true" />
                    <h2 id="wallpaper-title">{t("바탕화면")}</h2>
                  </span>
                  <span className={styles.windowMeta} aria-hidden="true">
                    WALLPAPER
                  </span>
                </header>
                <div className={styles.windowBody}>
                  <p className={styles.description}>
                    {t(
                      "바탕화면은 이 기기의 내 화면에만 적용되는 개인 설정입니다. 파일 화면을 다음에 열 때 반영됩니다.",
                    )}
                  </p>
                  <div
                    className={styles.wallpaperGrid}
                    role="group"
                    aria-label={t("바탕화면")}
                  >
                    {WALLPAPERS.map((wallpaper) => (
                      <button
                        key={wallpaper.id}
                        type="button"
                        aria-pressed={wallpaperId === wallpaper.id}
                        className={`${styles.wallpaperOption} ${wallpaperId === wallpaper.id ? styles.wallpaperSelected : ""}`}
                        onClick={() => selectWallpaper(wallpaper.id)}
                      >
                        <span
                          className={styles.wallpaperThumb}
                          style={{ backgroundImage: `url(${wallpaper.src})` }}
                          aria-hidden="true"
                        />
                        <span className={styles.wallpaperName}>
                          {t(wallpaper.name)}
                          {wallpaperId === wallpaper.id && (
                            <span className={styles.wallpaperCheck}>
                              {t("현재 선택")}
                            </span>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </section>
          </div>

          <div
            role="tabpanel"
            id="panel-activity"
            aria-labelledby="tab-activity"
            hidden={activeTab !== "activity"}
            className={styles.tabPanel}
          >
            <section aria-labelledby="activity-title">
              <div className={styles.window}>
                <header className={styles.windowTitlebar}>
                  <span className={styles.windowTitle}>
                    <h2 id="activity-title">{t("활동")}</h2>
                  </span>
                </header>
                <div className={styles.windowBody}>
                  <p className={styles.description}>
                    {t(
                      "참여자들이 데스크에서 한 일이 최근 것부터 보입니다. 업로드, 삭제, 이름 변경 같은 변화만 기록합니다.",
                    )}
                  </p>
                  {activity === null ? (
                    <p className={styles.description}>{t("불러오는 중…")}</p>
                  ) : "error" in activity ? (
                    <p className={styles.description} role="alert">
                      {activity.error}
                    </p>
                  ) : activity.entries.length === 0 ? (
                    <p className={styles.description}>
                      {t("아직 기록된 활동이 없습니다.")}
                    </p>
                  ) : (
                    <ul className={styles.activityList}>
                      {activity.entries.map((entry, index) => (
                        <li
                          key={`${entry.at}-${index}`}
                          className={styles.activityItem}
                        >
                          <span className={styles.activityTime}>
                            {formatDate(entry.at, locale)}
                          </span>
                          <span className={styles.activityActor}>
                            {entry.actorName}
                          </span>
                          <span>
                            {t(ACTIVITY_LABELS[entry.action])}
                            {entry.action === "empty-trash"
                              ? ` · ${t("{count}개 항목", { count: entry.name })}`
                              : entry.name
                                ? ` · ${entry.name}`
                                : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
