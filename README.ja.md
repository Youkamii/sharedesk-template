[English](./README.md) · [한국어](./README.ko.md) · **日本語** · [हिन्दी](./README.hi.md) · [中文](./README.zh.md)

# ShareDesk

ShareDesk は **ひとりの Google Drive の保存容量を、複数の人がそれぞれの Google アカウントで一緒に使う共有ファイルスペース**です。インストールするのはホストが最初に一度だけ。参加者は同じアドレスでログインして招待コードを入力するだけで、同じファイルとフォルダを一緒に使えます。

![ShareDesk デモ](./docs/sharedesk-demo.gif)

## 4つの壁紙

| 夕暮れ | 深い夜 |
| --- | --- |
| ![夕暮れの壁紙](./docs/sharedesk-wallpaper-dusk.png) | ![深い夜の壁紙](./docs/sharedesk-wallpaper-night.png) |
| 夜明け | 夜の海 |
| ![夜明けの壁紙](./docs/sharedesk-wallpaper-dawn.png) | ![夜の海の壁紙](./docs/sharedesk-wallpaper-tide.png) |

## できること

- ファイルやフォルダをデスクトップアイコンのように並べ、フォルダをウィンドウとして開いて一緒に整理できます。
- 役割に応じて、ファイルのアップロード・ダウンロード・名前の変更・フォルダ間の移動・ごみ箱からの復元ができます。
- 写真・動画・音声・PDF・テキストをその場で表示でき、`.txt` ファイルは一緒に編集できます。
- どのフォルダにも共有メモを残せます。
- 招待コードで人を招き、いま誰がオンラインかを確認できます。
- 一人ひとりに管理者・編集可・アップロード可・閲覧のみの4段階の役割を割り当てられ、管理画面からいつでも変更できます。
- インターフェースは英語・韓国語・日本語・ヒンディー語・中国語の5言語。管理者が設定タブでデスクの言語を決め（既定は英語）、個別言語の許可をオンにすれば参加者も自分の言語を選べます。
- 4つの壁紙から好きな雰囲気を選べます。選択は各自のブラウザに保存されます。

## どうやって共有するの？

```text
  ホストひとりの Google Drive
             ↕
    同じ ShareDesk アドレス
   ├─ ホストの Google アカウント
   ├─ 参加者 A の Google アカウント
   └─ 参加者 B の Google アカウント
```

Google Drive に接続するのはホストのアカウントだけです。参加者はそれぞれの Google アカウントでログインしますが、ShareDesk の中では、ホストが選んだひとつの Drive フォルダのファイルと容量をみんなで共有します。ShareDesk が参加者個人の Drive ファイルを読むことはありません。

ユーザー・招待・フォルダメモ・アイコン配置といった共有状態もホストの Drive に保存されます。別のデータベースは必要ありません。

## はじめる

- **設定が難しそうなら：** [AI に構築を任せる](./docs/AI_INSTALL.md)
- **自分で本番サーバーを運用するなら：** [詳細インストールガイド](./docs/INSTALL.md)
- **すでにインストール済みなら：** [アップデートガイド](./docs/UPDATE.md)
- **自分のパソコンでひとりで使うなら：** [ローカル個人利用](./docs/LOCAL.md)

招待された参加者は何もインストールしません。ホストから送られた ShareDesk のアドレスでログインし、招待コードを入力するだけです。

---

<div align="center">
<sub>Licensed under the <a href="LICENSE">MIT License</a> · Galmuri font under the <a href="public/fonts/Galmuri-LICENSE.txt">SIL OFL 1.1</a></sub>
</div>
