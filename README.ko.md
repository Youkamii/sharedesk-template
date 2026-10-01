<p align="center">
  <img src="./docs/readme/hero.png" width="100%" alt="ShareDesk — 한 사람의 Google Drive를 모두가 함께 쓰는 픽셀 바탕화면으로 바꾼 모습과 선택 설치인 데스크톱 위젯" />
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Youkamii/sharedesk-template?style=flat-square&labelColor=10172b&color=f2a56f" alt="MIT 라이선스" /></a>
  <img src="https://img.shields.io/badge/Next.js-16-2f4670?style=flat-square&labelColor=10172b&logo=nextdotjs&logoColor=white" alt="Next.js 16" />
  <img src="https://img.shields.io/badge/Vercel-serverless-2f4670?style=flat-square&labelColor=10172b&logo=vercel&logoColor=white" alt="Vercel 서버리스" />
  <img src="https://img.shields.io/badge/Google%20Drive-storage-2f4670?style=flat-square&labelColor=10172b&logo=googledrive&logoColor=white" alt="Google Drive 저장 공간" />
  <a href="#데스크톱-위젯"><img src="https://img.shields.io/badge/Widget-Windows-2f4670?style=flat-square&labelColor=10172b" alt="Windows용 데스크톱 위젯" /></a>
</p>

<p align="center">
  <strong>Google Drive 하나를 여럿이 나눠 쓰는 픽셀 바탕화면.</strong><br />
  호스트가 한 번 준비해 두면, 나머지는 주소를 열고 자기 Google 계정으로 로그인하면 됩니다.
</p>

<p align="center">
  <a href="#sharedesk란">소개</a> ·
  <a href="#데스크">데스크</a> ·
  <a href="#공유와-스페이스">공유</a> ·
  <a href="#네-가지-바탕화면">바탕화면</a> ·
  <a href="#데스크톱-위젯">위젯</a> ·
  <a href="#시작하기">시작하기</a> ·
  <a href="#어떻게-함께-쓰나요">함께 쓰는 방식</a>
</p>

<div align="center">

[English](./README.md) · **한국어** · [日本語](./README.ja.md) · [हिन्दी](./README.hi.md) · [中文](./README.zh.md)

</div>

<br />

## ShareDesk란?

ShareDesk는 **한 사람의 Google Drive 저장 공간을 여러 사람이 각자의 Google 계정으로 함께 쓰는 공유 파일 공간**입니다. 호스트만 처음에 한 번 설치합니다. 나머지 사람은 같은 주소를 열어 Google로 로그인하고 처음 한 번 초대 코드를 넣으면, 브라우저 속 픽셀 바탕화면에서 같은 파일과 폴더를 함께 씁니다.

![ShareDesk 시연](./docs/sharedesk-demo.gif)

<sub>시연은 한국어 화면으로 녹화했습니다. 화면 언어는 영어·한국어·일본어·힌디어·중국어 다섯 가지입니다.</sub>

<details>
<summary><strong>Drive 하나가 공유 데스크가 되는 구조</strong></summary>
<br />

```text
호스트 한 사람의 Google Drive
             ↕
       같은 ShareDesk 주소
       ├─ 호스트의 Google 계정
       ├─ 참여자 A의 Google 계정
       └─ 참여자 B의 Google 계정
```

Google Drive에 연결하는 계정은 호스트 한 명입니다. 참여자는 각자의 Google 계정으로 로그인하지만, ShareDesk 안에서는 호스트가 정한 Drive 폴더 하나에서 함께 일하고 그 용량을 나눠 씁니다.
</details>

<br />

## 데스크

<p align="center">
  <img src="./docs/readme/desk.png" width="100%" alt="브라우저 속 ShareDesk 데스크: 색을 입힌 폴더 아이콘, 옆 미리보기에 사진을 띄운 Photos 폴더 창, 현재 접속 인원 목록" />
</p>

- **아이콘과 창** — 파일과 폴더를 바탕화면 아이콘처럼 놓고, 폴더에는 일곱 가지 색 중 하나를 입히고, 여러 폴더를 창으로 열어 최소화·최대화할 수 있습니다. 휴지통은 오른쪽 아래 구석에 있고 지운 항목을 30일 동안 보관합니다.
- **미리보기와 함께 고치기** — 사진·영상·오디오·PDF·텍스트를 그 자리에서 열고, `.txt` 파일은 여럿이 함께 고칩니다. 폴더마다 공유 메모를 남길 수 있습니다.
- **찾기** — 데스크 전체나 폴더 하나(하위 폴더 포함)를 검색하고, **속성**을 열면 누가 올렸는지와 몇 번 내려받았는지 보입니다.
- **편한 방법으로 올리기** — 파일이나 폴더를 통째로 끌어다 놓습니다. 새로고침으로 업로드가 끊겼다면 작업표시줄의 **이어받을 업로드** 칩을 열고 그 창에 같은 파일을 놓거나 **파일 다시 선택**을 눌러 이어서 올립니다. 데스크에 바로 놓으면 새 업로드가 됩니다.
- **사람** — 지금 누가 접속해 있는지 보고, 오른쪽 아래 버튼으로 채팅합니다(최소화해 두면 새 메시지에 버튼이 반짝이고 읽지 않은 수가 뜹니다). 다른 사람에게 보일 닉네임도 정할 수 있습니다.
- **역할** — 관리자는 `ADMIN_EMAILS`로 정하고, 나머지는 수정 가능·올리기 가능·보기 전용 가운데 하나로 관리자 화면에서 사람마다 바꿉니다.
- **관리자 화면** — 초대 코드(1회용, 또는 기간 내 무제한), 사용자와 로그인 기기, 활동 기록, 공개 폴더, 데스크 언어, 옛날 디스크 느낌의 도넛 표시가 붙은 저장 용량 제한, 바탕화면, 업데이트를 다룹니다.
- **휴대폰에서** — 좁은 화면에서는 데스크가 간단한 목록으로 바뀌고, 여기서 올리기·사진 찍기·새 폴더를 쓸 수 있습니다.

<br />

## 공유와 스페이스

<img align="right" width="300" src="./docs/readme/sharing.png" alt="오른쪽 가장자리에서 연 사이드바: 간이 링크 만들기, 생성된 링크, 다른 데스크에서 받기, 공개 폴더 입장, 데스크톱 위젯" />

데스크 오른쪽 가장자리의 `«` 손잡이를 누르면 사이드바가 열립니다. 링크, 받기, 공개 폴더, 위젯 내려받기가 여기 모여 있습니다.

- **공유 링크** — 수정 가능 역할과 관리자는 파일이나 폴더를 우클릭해 1시간 링크를 바로 복사하거나, **공유 링크 관리…** 창에서 1시간·24시간·7일·30일(기본 7일) 가운데 골라 만듭니다. 링크는 로그인 없이 열립니다.
- **간이 링크** — 파일을 놓으면 업로드가 끝나는 대로 파일마다 1시간 링크가 생깁니다. 창이 맨 앞에 있을 때 복사한 스크린샷을 Ctrl+V로 붙여 넣어도 같은 방식으로 올라갑니다. 체크된 파일은 1시간이 지나면 지워지고, 체크를 풀면 데스크에 남습니다.
- **생성된 링크** — 열려 있는 링크를 한 목록에서 보고 다시 복사하거나 공유를 멈춥니다. 일반 참여자는 자기 링크만, 관리자는 모든 링크를 봅니다.
- **QR 코드** — 공유 링크·간이 링크·초대 코드·공개 폴더 주소를 브라우저 안에서 그린 QR 코드로 띄울 수 있어, 화면에 뜬 것을 휴대폰으로 바로 찍어 가져갑니다.
- **다른 데스크에서 받기** — 다른 ShareDesk에서 만든 공유 링크를 붙여 넣으면 그 파일이나 폴더를 이 데스크로 복사합니다.
- **공개 폴더** — 관리자가 폴더 하나를 공개 폴더로 열어 두면, 주소를 아는 사람은 로그인 없이 내려받고 올릴 수 있습니다. 크기·파일 개수·공개 시간 제한은 서버가 지킵니다. 참여자는 **공개 폴더 입장**에서 찾습니다.
- **스페이스** — 관리자는 한 설치 안에 데스크를 더 열 수 있고, 각 데스크는 `/team/files` 같은 자기 주소와 따로 된 구성원·역할·파일·채팅을 가집니다. 사람들은 추가된 스페이스만 봅니다. 링크와 공개 폴더는 아직 기본 데스크에서만 씁니다.
- **다운로드 우선** — 작업표시줄의 체크 상자를 켜면 파일을 열 때 미리보기 대신 바로 내려받습니다.

<br clear="all" />

## 네 가지 바탕화면

바탕화면은 사람마다 자기 화면에 고르고, 고른 것은 그 브라우저에 저장됩니다.

| 해 질 녘 | 깊은 밤 |
| :---: | :---: |
| ![해 질 녘 바탕화면](./docs/sharedesk-wallpaper-dusk.png) | ![깊은 밤 바탕화면](./docs/sharedesk-wallpaper-night.png) |
| **여명** | **밤바다** |
| ![여명 바탕화면](./docs/sharedesk-wallpaper-dawn.png) | ![밤바다 바탕화면](./docs/sharedesk-wallpaper-tide.png) |

<br />

## 데스크톱 위젯

<p align="center">
  <img src="./docs/readme/widget.png" width="100%" alt="위젯의 네 장면: 서랍과 창가 모드, 손잡이로 접혔다가 펼쳐지는 벽 붙임, 다른 창 뒤에 있는 압정, 차오르는 손잡이 전송 게이지" />
</p>

<p align="center">
  <a href="https://github.com/Youkamii/sharedesk-template/releases/download/widget/sharedesk-widget-windows-x64-setup.exe"><img src="https://img.shields.io/badge/Windows%20x64-위젯%20내려받기-f2a56f?style=for-the-badge&labelColor=10172b" alt="Windows x64용 위젯 내려받기" /></a>
</p>

위젯은 선택입니다. 데스크 주소를 그대로 여는 작은 창이라 화면은 데스크 서버가 그리고, 위젯이 없어도 모든 기능은 브라우저에서 그대로 됩니다. 자세한 내용은 [데스크톱 위젯](./docs/WIDGET.ko.md)에 있습니다.

- **어디서 받아도 같은 파일** — 위 단추는 언제나 최신 Windows 설치 파일을 가리키고, 참여자는 데스크 사이드바의 **데스크톱 위젯**에서도 같은 파일을 받습니다. macOS 파일은 Mac에서 빌드해 올린 뒤 제공됩니다.
- **서랍과 창가** — 서랍은 파일 격자입니다. 파일을 놓으면 지금 보고 있는 폴더로 올라갑니다. 창가는 접속자와 최근 올라온 파일 다섯 개를, 관리자에게는 데스크 용량도 보여 줍니다.
- **벽 붙임** — 위젯을 가까운 화면 가장자리에 손잡이만 남기고 숨깁니다. 손잡이에 마우스를 대거나 파일을 끌어다 대면 펼쳐지고, 접혀 있는 동안 손잡이 옆 빈 자리를 누르면 뒤 창이 눌립니다.
- **압정** — 위젯을 압정처럼 바탕화면에 꽂아 다른 창 뒤, 바탕화면 위에 둡니다. 벽 붙임과 압정은 함께 켜지지 않습니다.
- **끌어내기** — Windows에서는 서랍의 파일 아이콘을 탐색기 폴더로 끌어 놓으면 그 폴더에 내려받아집니다.
- **전송 게이지** — 파일을 주고받는 중에 위젯이 접히면 손잡이 테두리가 진행만큼 초록으로 차오르고, 전송이 실패하면 잠깐 빨갛게 바뀝니다.
- **업데이트와 프로필** — 위젯은 새 버전을 확인해 서명을 검증합니다. 트레이 메뉴에서 **업데이트 설치**를 고르면 설치한 뒤 다시 켜지고, 고르기 전에는 스스로 다시 시작하지 않습니다. 프로필마다 위젯을 하나씩 띄우면 여러 데스크나 계정을 나란히 둘 수 있습니다.

> [!NOTE]
> 벽 붙임·압정·끌어내기·전송 게이지는 새 위젯 버전에 들어 있습니다. 예전 위젯에서 벽이나 압정을 누르면 업데이트 안내가 뜨고, 새 버전이 발행되면 위젯의 업데이트 확인이 트레이 메뉴로 알려 줍니다.

<br />

## 시작하기

초대받은 참여자는 어떤 설치도 하지 않습니다. 호스트가 보낸 ShareDesk 주소를 열고 자기 Google 계정으로 로그인한 뒤, 처음 한 번 초대 코드만 넣으면 됩니다.

호스트는 여기서 시작합니다.

- **설정이 어렵다면:** [AI에게 구축 맡기기](./docs/AI_INSTALL.ko.md)
- **직접 운영 서버를 만들려면:** [상세 구축 안내](./docs/INSTALL.ko.md)
- **이미 설치했다면:** [업데이트 안내](./docs/UPDATE.ko.md) — 새 버전이 나오면 작업표시줄의 `업데이트` 버튼에 별이 붙어 관리자에게 알려 줍니다
- **혼자 내 컴퓨터에서 쓰려면:** [로컬 개인 사용](./docs/LOCAL.ko.md)
- **선택:** [데스크톱 위젯](./docs/WIDGET.ko.md)

<br />

## 어떻게 함께 쓰나요?

- **Drive 연결은 하나.** Google Drive에 연결되는 계정은 호스트 한 명뿐입니다. 참여자의 개인 Drive 파일은 읽지 않습니다.
- **별도 데이터베이스 없음.** 사용자·초대·채팅·폴더 메모·링크 기록·설정·아이콘 배치도 호스트의 Drive에 저장됩니다.
- **서버리스.** ShareDesk는 서버리스 환경에 맞춰져 있습니다. 채팅과 접속 표시는 계속 연결해 두는 WebSocket 대신 가벼운 주기 확인을 써서, 늘 켜 둔 서버가 필요 없습니다.
- **데스크끼리 섞이지 않음.** 같은 Google 계정으로 여러 ShareDesk 주소에 참여할 수 있고, 각 데스크의 구성원·역할·파일·채팅은 서로 섞이지 않습니다.

> [!NOTE]
> Windows 위젯 설치 파일은 아직 코드 서명이 없어 "알 수 없는 게시자" 경고가 뜰 수 있습니다. 위젯 업데이트는 별도 서명 키로 검증하고, 위젯은 내 데스크, 로그인할 때의 Google, 업데이트를 받는 공개 GitHub 릴리스하고만 통신합니다.

<br />

---

<div align="center">
<sub>Licensed under the <a href="LICENSE">MIT License</a> · Galmuri font under the <a href="public/fonts/Galmuri-LICENSE.txt">SIL OFL 1.1</a></sub>
</div>
