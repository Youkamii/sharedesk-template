import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// #6 — 로그인·가입·차단 화면은 위젯과 웹이 같은 도트 카드(src/app/auth.module.css)를 쓴다.
// 미설정 안내(앞)와 /files·/admin(뒤) 사이에서 입장 화면만 Tailwind 카드로 끊기지 않게 고정한다.

const read = (path: string) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

const ENTRY_FILES = [
  "src/app/page.tsx",
  "src/app/join/page.tsx",
  "src/app/pending/page.tsx",
  "src/app/KeyForm.tsx",
];

test("배선: 입장 화면 네 파일은 공용 도트 모듈을 쓰고 Tailwind 카드 클래스가 없다 (#6)", async () => {
  for (const file of ENTRY_FILES) {
    const source = await read(file);
    assert.match(
      source,
      /import auth from "\.{1,2}\/auth\.module\.css";/,
      `${file}: 공용 모듈(auth.module.css)을 가져오지 않는다`,
    );
    assert.doesNotMatch(
      source,
      /widget\.module\.css/,
      `${file}: auth 클래스를 위젯 모듈에서 가져오면 안 된다`,
    );
    // 문자열 className은 Tailwind 유틸리티의 흔적이다 — 빈 값(LogoutButton 기본 모양 끄기)만 허용.
    assert.doesNotMatch(source, /className="[^"]+"/, `${file}: 문자열 className이 남아 있다`);
    for (const token of [
      "rounded-2xl",
      "rounded-lg",
      "shadow-sm",
      "text-zinc",
      "bg-foreground",
      "dark:",
      "max-w-sm",
    ]) {
      assert.ok(!source.includes(token), `${file}: Tailwind 토큰 ${token}이 남아 있다`);
    }
  }

  // 세 화면 모두 위젯 분기와 웹 분기가 같은 카드 클래스를 쓰고, 웹은 밤 무대(.screen)+큰 카드(.page)다.
  for (const file of ENTRY_FILES.slice(0, 3)) {
    const source = await read(file);
    assert.match(source, /<WidgetFrame>[\s\S]*?className=\{auth\.authCard\}/, `${file}: 위젯 카드`);
    assert.match(source, /<main className=\{auth\.screen\}>/, `${file}: 웹 밤 무대`);
    assert.match(
      source,
      /className=\{`\$\{auth\.authCard\} \$\{auth\.page\}`\}/,
      `${file}: 웹 카드는 공용 카드에 .page를 덧댄다`,
    );
  }

  const login = await read("src/app/page.tsx");
  assert.match(login, /className=\{auth\.authPrimary\}/);
  assert.match(login, /className=\{auth\.authDivider\}/);
  assert.match(login, /className=\{auth\.authSecondary\}/);
  // 웹·위젯 두 분기 모두 KeyForm을 .authForm으로 감싼다.
  assert.equal(
    login.match(/<div className=\{auth\.authForm\}>\s*<KeyForm locale=\{locale\} \/>/g)?.length,
    2,
  );
  const join = await read("src/app/join/page.tsx");
  assert.match(
    join,
    /<div className=\{auth\.authForm\}>\s*<JoinCodeForm locale=\{locale\} initialCode=\{code\} \/>/,
  );
  for (const file of ["src/app/join/page.tsx", "src/app/pending/page.tsx"]) {
    const source = await read(file);
    // 웹 분기도 위젯처럼 기본 Tailwind 모양을 끄고 .authFoot이 로그아웃 단추를 그린다.
    assert.equal(
      source.match(/<LogoutButton locale=\{locale\} className="" \/>/g)?.length,
      2,
      `${file}: 로그아웃 단추 두 곳 모두 .authFoot 모양`,
    );
  }

  const keyForm = await read("src/app/KeyForm.tsx");
  assert.match(keyForm, /className=\{auth\.keyForm\}/);
  // 자리표시자만으로는 이름이 사라지므로 입력칸에 접근 가능한 이름을 단다.
  assert.match(keyForm, /aria-label=\{t\("접속 키"\)\}/);
  // 틀린 키 오류는 화면 낭독기가 바로 읽는다.
  assert.match(keyForm, /<p role="alert">\{t\(error\)\}<\/p>/);

  const frame = await read("src/app/widget/WidgetFrame.tsx");
  assert.match(frame, /<main className=\{auth\.authBody\}>/);
});

test("공용 도트 모듈은 Dusk Room 팔레트·2px 프레임·Galmuri이고 위젯 모듈에서 옮겨 왔다 (#6)", async () => {
  const [css, widgetCss, globals] = await Promise.all([
    read("src/app/auth.module.css"),
    read("src/app/widget/widget.module.css"),
    read("src/app/globals.css"),
  ]);

  for (const name of [
    "authBody",
    "authCard",
    "authError",
    "authPrimary",
    "authDivider",
    "authForm",
    "authFoot",
    "keyForm",
    "screen",
    "page",
    "authSection",
    "authSecondary",
  ]) {
    assert.match(css, new RegExp(`[.]${name}[ ,:]`), `auth.module.css에 .${name}이 없다`);
  }
  // 위젯 모듈에 같은 규칙이 남아 있으면 어느 쪽이 이길지 모른다 — 한 곳에만 둔다.
  assert.doesNotMatch(widgetCss, /^\.auth(?:Body|Card|Error|Primary|Divider|Form|Foot)\b[^\n]*\{/m);

  assert.match(css, /background: #f4e7c5;/); // window
  assert.match(css, /border: 2px solid #10172b;/); // night 프레임
  assert.match(css, /inset 2px 2px 0 #fff8e7, inset -2px -2px 0 #9c8c78/); // 2px 빛/어둠
  const screen = css.slice(css.indexOf(".screen {"), css.indexOf("}", css.indexOf(".screen {")));
  assert.match(screen, /background: #10172b;/, "웹 무대는 미설정 안내와 같은 밤 배경");
  assert.match(screen, /font-family: var\(--font-pixel\)/, "웹 무대 글꼴은 Galmuri11");
  // 카드가 쓰는 색 토큰은 웹(data-widget 없음)에서도 읽히는 :root에 있다.
  assert.match(css, /var\(--ink\)/);
  assert.match(css, /var\(--peach\)/);
  const rootBlock = globals.slice(globals.indexOf(":root {"), globals.indexOf("}", globals.indexOf(":root {")));
  assert.match(rootBlock, /--ink: #111629;/);
  assert.match(rootBlock, /--peach: #f2a56f;/);
  // 키보드 포커스 링 — 위젯 틀(.authBody)과 웹 무대(.screen) 모두, 크림 위에서 보이는 청록.
  // 위젯의 .widget amber 링(크림 위 1.16:1)보다 구체적이어야 덮는다.
  assert.match(css, /\.authBody, \.screen\) \.authCard :is\(a, button, input\):focus-visible \{\s*outline: 2px solid #2d5c5b;/);
  // 오류 띠의 밝은 글자는 위젯·웹 공통(.authCard p보다 구체적으로).
  assert.match(css, /\.authCard \.authError \{\s*color: #fff8e7;/);
  assert.doesNotMatch(css, /\.page \.authError/);
});

test("DESIGN.md 글꼴 문장은 입장 화면의 실제 구현(도트 Galmuri11)을 말한다 (#6)", async () => {
  const design = await read("DESIGN.md");
  assert.doesNotMatch(design, /Login\/Admin Body:\*\* Geist Sans/);
  assert.match(design, /\*\*Login\/Join\/Admin:\*\* Galmuri11/);
  assert.match(design, /src\/app\/auth\.module\.css/);
  assert.match(design, /Geist Sans는[^\n]*길게 읽는 본문에만/);
});
