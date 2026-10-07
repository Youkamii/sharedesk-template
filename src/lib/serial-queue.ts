// 같은 프로세스 안에서 같은 상태 파일을 쓰는 작업을 한 줄로 세운다.
// 응답 뒤(after) 기록이 한꺼번에 몰리면 각자 읽고 CAS로 쓰다 서로 버전이
// 엇갈려, 몇 번뿐인 재시도를 다 써 버리고 기록을 잃는다(같은 링크를 연달아
// 받으면 6번 중 1~2번이 사라졌다). 프로세스 안에서는 차례로 쓰게 해, CAS
// 재시도는 다른 인스턴스와 겹칠 때만 쓰이게 한다.
//
// 앞 작업이 실패해도 다음 작업은 돈다. 작업은 enqueue를 부른 쪽의 비동기
// 문맥(스페이스 ALS)에서 실행된다 — then()을 부른 자리의 문맥을 따른다.

export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
}
