# ShareDesk

ShareDesk는 **한 사람의 Google Drive 저장 공간을 여러 사람이 각자의 Google 계정으로 함께 쓰는 공유 파일 공간**입니다. 호스트만 처음에 한 번 설치하고, 참여자는 같은 주소에서 로그인한 뒤 초대 코드만 입력하면 같은 파일과 폴더를 함께 쓸 수 있습니다.

![ShareDesk 시연](./docs/sharedesk-demo.gif)

## 언어

이 문서는 다섯 가지 언어로 준비돼 있고, 앱 화면도 같은 다섯 가지를 지원합니다. 관리자가 **설정**에서 데스크 언어를 정하고, 참여자가 각자 언어를 고르게 열어 둘 수도 있습니다.

[English](./README.md) · **한국어** · [日本語](./README.ja.md) · [हिन्दी](./README.hi.md) · [中文](./README.zh.md)

## 네 가지 바탕화면

| 해 질 녘 | 깊은 밤 |
| :---: | :---: |
| ![해 질 녘 바탕화면](./docs/sharedesk-wallpaper-dusk.png) | ![깊은 밤 바탕화면](./docs/sharedesk-wallpaper-night.png) |
| **여명** | **밤바다** |
| ![여명 바탕화면](./docs/sharedesk-wallpaper-dawn.png) | ![밤바다 바탕화면](./docs/sharedesk-wallpaper-tide.png) |

## 할 수 있는 일

- 파일과 폴더를 바탕화면 아이콘처럼 놓고, 폴더를 창으로 열어 함께 정리합니다.
- 역할에 따라 파일 업로드·다운로드·이름 변경·폴더 이동·휴지통 복원을 지원합니다.
- 사진, 영상, 오디오, PDF와 텍스트를 바로 보고 `.txt` 파일은 함께 고칠 수 있습니다.
- 폴더마다 공유 메모를 남길 수 있습니다.
- 초대 코드로 사람을 받고, 현재 접속 중인 인원을 확인할 수 있습니다.
- 사람마다 관리자·수정 가능·올리기 가능·보기 전용 네 단계 역할을 줄 수 있고, 관리자 화면에서 언제든 바꿉니다.
- 화면 언어는 영어·한국어·일본어·힌디어·중국어 5가지입니다. 관리자가 설정 탭에서 데스크 언어를 정하고(기본 영어), 개별 언어 허용을 켜면 참여자도 각자 언어를 고를 수 있습니다.
- 네 가지 배경 중 원하는 분위기를 고를 수 있으며 선택은 각자의 브라우저에 저장됩니다.

## 어떻게 함께 쓰나요?

```text
호스트 한 사람의 Google Drive
             ↕
       같은 ShareDesk 주소
       ├─ 호스트의 Google 계정
       ├─ 참여자 A의 Google 계정
       └─ 참여자 B의 Google 계정
```

Google Drive에 연결하는 계정은 호스트 한 명입니다. 참여자는 각자의 Google 계정으로 로그인하지만, ShareDesk 안에서는 호스트가 정한 한 Drive 폴더의 파일과 용량을 함께 씁니다. 참여자의 개인 Drive 파일은 읽지 않습니다.

사용자·초대·폴더 메모·아이콘 배치 같은 공유 상태도 호스트의 Drive 안에 저장됩니다. 별도 데이터베이스는 필요하지 않습니다.

## 시작하기

- **설정이 어렵다면:** [AI에게 구축 맡기기](./docs/AI_INSTALL.ko.md)
- **직접 운영 서버를 만들려면:** [상세 구축 안내](./docs/INSTALL.ko.md)
- **이미 설치했다면:** [업데이트 안내](./docs/UPDATE.ko.md)
- **혼자 내 컴퓨터에서 쓰려면:** [로컬 개인 사용](./docs/LOCAL.ko.md)

초대받은 참여자는 어떤 설치도 하지 않습니다. 호스트가 보낸 ShareDesk 주소에서 로그인하고 초대 코드만 입력하면 됩니다.

---

<div align="center">
<sub>Licensed under the <a href="LICENSE">MIT License</a> · Galmuri font under the <a href="public/fonts/Galmuri-LICENSE.txt">SIL OFL 1.1</a></sub>
</div>
