// 클립보드 붙여넣기 업로드(#14)의 순수 규칙. 창 컴포넌트에서 떼어 놓아
// 테스트가 React 없이 돌 수 있게 한다.

// 스크린샷을 붙여넣으면 브라우저는 죄다 "image.png"로 준다. 그대로 두면
// 링크 목록이 같은 이름으로 뒤덮이므로 시각을 붙여 구분한다. 파일 이름은
// 이 저장소 관례대로 한국어 고정이다(새 메모장.txt와 같은 규칙).
const GENERIC_PASTE_NAMES = new Set([
  "",
  "image",
  "image.png",
  "image.jpg",
  "image.jpeg",
  "image.webp",
  "clipboard.png",
  "screenshot.png",
]);

function twoDigits(value: number) {
  return String(value).padStart(2, "0");
}

export function pastedFileName(
  file: Pick<File, "name" | "type">,
  now: Date = new Date(),
): string {
  const name = file.name ?? "";
  if (!GENERIC_PASTE_NAMES.has(name.toLowerCase())) return name;
  const stamp =
    `${now.getFullYear()}${twoDigits(now.getMonth() + 1)}${twoDigits(now.getDate())}` +
    `-${twoDigits(now.getHours())}${twoDigits(now.getMinutes())}${twoDigits(now.getSeconds())}`;
  const dot = name.lastIndexOf(".");
  // 어차피 새 이름을 붙이므로 확장자 대소문자도 하나로 맞춘다.
  const extension =
    dot > 0
      ? name.slice(dot).toLowerCase()
      : file.type === "image/jpeg"
        ? ".jpg"
        : file.type === "image/webp"
          ? ".webp"
          : ".png";
  return `붙여넣기 ${stamp}${extension}`;
}

// 글자를 입력하는 칸에 붙여넣는 중이면 가로채지 않는다. 읽기 전용 칸
// (만들어진 링크를 보여주는 input)은 붙여넣어도 잃을 게 없으므로 통과시킨다.
export function isTextEntryTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.closest !== "function") return false;
  if (element.isContentEditable) return true;
  const field = element.closest("input, textarea") as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;
  if (!field) return false;
  if (field.readOnly || field.disabled) return false;
  if (field.tagName === "TEXTAREA") return true;
  return !/^(?:checkbox|radio|file|button|submit|reset|range|color)$/i.test(
    (field as HTMLInputElement).type,
  );
}
