export const UPDATE_RUN_POLL_MS = 5_000;
export const UPDATE_RUN_STALL_MS = 15 * 60_000;

// 디스패치 시각보다 이만큼 오래된 완료 기록은 직전 실행의 잔재로 본다 (시계 오차 허용).
const RUN_ATTEMPT_SKEW_MS = 60_000;

export type UpdateRunInfo = {
  id: number;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  createdAt: string;
};

// 원클릭 업데이트 실행 추적 상태 (패널을 닫아도 유지).
// starting: 디스패치 직후 GitHub run 생성 대기 / running: 워크플로 실행 중
// deploying: 워크플로 성공 후 새 배포 반영 대기 / stalled: 오래 확인이 안 됨
export type UpdateRunState = {
  phase: "starting" | "running" | "deploying" | "done" | "failed" | "stalled";
  startedVersion: string;
  targetVersion: string | null;
  error: string | null;
  htmlUrl: string | null;
  startedAt: number;
};

// 폴링 결과로 실행 단계를 전이한다. 진행 단계가 아니면 손대지 않는다.
export function nextUpdateRunState(
  prev: UpdateRunState,
  currentVersion: string,
  run: UpdateRunInfo | null,
  now: number = Date.now(),
): UpdateRunState {
  if (
    prev.phase !== "starting" &&
    prev.phase !== "running" &&
    prev.phase !== "deploying"
  ) {
    return prev;
  }
  // 디스패치 직후에는 GitHub가 새 실행을 만들기 전이라 직전 실행의 완료 기록이
  // 조회될 수 있다. 이번 시작보다 오래된 완료 기록을 이번 실행으로 오인하면
  // 시작하자마자 실패·배포 중으로 잘못 표시되므로 없는 것으로 취급한다.
  const observedRun =
    prev.phase === "starting" &&
    run &&
    run.status === "completed" &&
    !(Date.parse(run.createdAt) >= prev.startedAt - RUN_ATTEMPT_SKEW_MS)
      ? null
      : run;
  // 현재 버전이 바뀌었으면 배포까지 끝난 것이므로 어느 단계였든 완료다.
  if (currentVersion !== prev.startedVersion) {
    return {
      ...prev,
      phase: "done",
      htmlUrl: observedRun?.htmlUrl ?? prev.htmlUrl,
    };
  }
  if (
    observedRun &&
    observedRun.status === "completed" &&
    observedRun.conclusion !== "success"
  ) {
    return { ...prev, phase: "failed", htmlUrl: observedRun.htmlUrl };
  }
  // 15분 넘게 완료를 못 보면 정체로 보고 수동 새로고침을 안내한다.
  if (now - prev.startedAt > UPDATE_RUN_STALL_MS) {
    return {
      ...prev,
      phase: "stalled",
      htmlUrl: observedRun?.htmlUrl ?? prev.htmlUrl,
    };
  }
  if (observedRun && observedRun.status === "completed") {
    // 워크플로는 성공했지만 새 버전이 아직 반영 전 → Vercel 배포 대기
    return prev.phase === "deploying" && prev.htmlUrl === observedRun.htmlUrl
      ? prev
      : { ...prev, phase: "deploying", htmlUrl: observedRun.htmlUrl };
  }
  if (
    observedRun &&
    (observedRun.status === "queued" || observedRun.status === "in_progress")
  ) {
    return prev.phase === "running" && prev.htmlUrl === observedRun.htmlUrl
      ? prev
      : { ...prev, phase: "running", htmlUrl: observedRun.htmlUrl };
  }
  // run이 아직 없으면 GitHub가 실행을 만드는 중 → starting 유지
  return prev;
}
