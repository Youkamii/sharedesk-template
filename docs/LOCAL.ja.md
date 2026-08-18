[English](./LOCAL.md) · [한국어](./LOCAL.ko.md) · **日本語** · [हिन्दी](./LOCAL.hi.md) · [中文](./LOCAL.zh.md)

# ShareDesk ローカル個人利用

Google OAuthやVercelを使わずに、自分のパソコンでShareDeskの画面とファイル機能を使う方法です。ファイルはGoogle Driveではなく、このパソコンのローカルフォルダに保存されます。

この方法は、個人での利用と開発時の確認に向いています。複数の人がそれぞれのGoogleアカウントで一緒に使う本番環境を作るには、[本番インストールガイド](./INSTALL.ja.md)に従ってください。インストールが難しい場合は、[AIに構築を任せる](./AI_INSTALL.ja.md)を利用できます。

すでに取得したローカルのインストールを新しいバージョンに入れ替える方法は、[アップデートガイド](./UPDATE.ja.md#ローカル個人利用)に別途まとめてあります。

## 必要なもの

- [Node.js](https://nodejs.org/) 20.9以上
- Git
- ターミナルを開けるWindows、macOSまたはLinuxのパソコン

まずバージョンを確認してください。

```powershell
node --version
npm --version
git --version
```

## インストール

すでにこのリポジトリをローカルで開いている場合は、`git clone`と`cd`は飛ばします。

```powershell
git clone https://github.com/Youkamii/sharedesk-template.git
cd sharedesk-template
npm ci
npm run setup -- --prepare-env
```

最後のコマンドは`.env.local`を準備します。ファイルがすでにある場合は、内容を上書きせずアクセス権限だけを確認します。

## ローカル環境の設定

プロジェクトのルートにある`.env.local`で、下の4つの値を埋めます。

```dotenv
STORAGE_DRIVER=local
LOCAL_STORAGE_ROOT=.devstorage
SESSION_SECRET=ローカルでのみ使う十六文字以上の長いランダムな文字列
ACCESS_KEYS=自分が入力するローカルのアクセスキー
```

- `STORAGE_DRIVER=local`は、Google Driveの代わりにローカルフォルダを使います。
- `LOCAL_STORAGE_ROOT=.devstorage`は、プロジェクト内の`.devstorage`フォルダにファイルと状態を保存します。
- `SESSION_SECRET`は16文字以上である必要があります。ログインのcookieの署名に使います。
- `ACCESS_KEYS`は、最初の画面で入力するアクセスキーです。複数使うにはカンマで区切ります。

ランダムな文字列が必要なときは、ローカルのターミナルで下のコマンドを実行できます。出力された値はチャットやIssueに載せず、`.env.local`に直接入れてください。

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

`.env.local`のGoogle関連の値は、localモードでは空のままでかまいません。`.env.local`はGitから除外されており、公開リポジトリにアップロードしてはいけません。

## 実行

```powershell
npm run dev
```

ブラウザで`http://localhost:3000`を開き、`.env.local`に書いた`ACCESS_KEYS`の値のいずれかを入力します。

localモードのアクセスキーは`編集可能`の権限で入るため、個人での利用に必要なファイルの作成と編集をそのまま使えます。

このモードでは、Googleログイン、招待コードでの参加、実際のDrive共有は確認できません。

次の項目まで確認できれば、ローカルでの実行ができています。

1. `/files`のデスクトップが開きます。
2. フォルダを作り、ファイルをアップロードできます。
3. 再読み込みしてもフォルダとファイルが残ります。
4. ファイルをごみ箱に入れ、画面の右下のごみ箱から復元できます。
5. `.txt`ファイルとフォルダメモを作り、編集できます。

サーバーを止めるには、実行中のターミナルで`Ctrl+C`を押します。

本番ビルドを自分のパソコンで確認するには、次のように実行します。

```powershell
npm run build
npm start
```

## ファイルの保存とバックアップ

`LOCAL_STORAGE_ROOT`が相対パスの場合は、ShareDeskを実行したプロジェクトフォルダを基準に計算します。既定の設定では、実際のファイルと状態がすべて`.devstorage/`の下にあります。

```text
.devstorage/
├── 自分が作ったファイルとフォルダ
└── .sharedesk/
    ├── ユーザー・招待・接続の状態
    ├── フォルダメモとアイコンの配置
    └── ごみ箱とローカル共有の状態
```

`.sharedesk`はShareDeskが使う内部のフォルダなので、ファイル画面には表示されません。一部だけを取り出してバックアップすると、メモ、アイコンの位置、ごみ箱といった状態が失われることがあるため、**`LOCAL_STORAGE_ROOT`の全体をバックアップ**してください。

バックアップの手順は次のとおりです。

1. 実行中のサーバーを`Ctrl+C`で止めます。
2. `.devstorage`、またはご自身で決めた`LOCAL_STORAGE_ROOT`のフォルダ全体を、別のドライブやバックアップ用のフォルダにコピーします。
3. 同じアクセスキーとログインの署名を保ちたい場合は、`.env.local`も公開されない別の場所に保管します。

Windows PowerShellでは、コピー先のパスをご自身の環境に合わせて変えたうえで、次のようにコピーできます。

```powershell
New-Item -ItemType Directory -Force -Path 'D:\ShareDesk-Backup'
Copy-Item -Recurse -Force -LiteralPath '.devstorage' -Destination 'D:\ShareDesk-Backup\devstorage'
```

復元するときも、サーバーを止めてから、既存の`LOCAL_STORAGE_ROOT`の代わりにバックアップしたフォルダ全体を置いて、もう一度実行します。サーバーがファイルを書き込んでいる最中にコピーしたバックアップは、状態の時点が互いにずれていることがあります。

## localモードでの違い

- Googleログインと招待コードでの参加は使いません。`ACCESS_KEYS`で入ります。
- ファイルはGoogle Driveの容量ではなく、ShareDeskを実行したパソコンのディスクを使います。
- **Google Driveで共有**の動作は、実際のGoogleの権限を作りません。localモードでの状態確認用の動作にすぎません。
- Googleドキュメント・スプレッドシート・スライド・図形描画のPDF変換プレビューは使えません。
- HTMLやSVGのようにスクリプトを実行できる形式は、そのまま開かず安全なダウンロードとして提供します。
- 同じフォルダに同じ名前の項目を作ったり、その名前に変更したりすると、上書きせずに拒否します。
- ごみ箱の項目は、30日を過ぎたあと、次にごみ箱を開いたときに完全に削除されます。
- `LOCAL_STORAGE_ROOT`の外のパスと、内部の`.sharedesk`フォルダは、ファイル画面から開けません。
- Vercelの本番デプロイにlocalモードを使わないでください。複数の人が一緒に使う本番環境は`STORAGE_DRIVER=drive`で構成します。

## トラブルシューティング

| 症状 | 確認する内容 |
|---|---|
| `npm ci`がNodeのバージョンを拒否する | `node --version`が20.9以上か確認し、Node.jsを更新します。 |
| `SESSION_SECRETがないか短すぎます` | `.env.local`の`SESSION_SECRET`を16文字以上の文字列に変えて、サーバーを再起動します。 |
| アクセスキーが拒否される | `.env.local`の`ACCESS_KEYS`のつづりとカンマ区切りを確認し、サーバーを再起動します。 |
| ファイルが思っていたフォルダにない | リポジトリのルートでサーバーを実行したかと、`LOCAL_STORAGE_ROOT`の値を確認します。相対パスは現在のプロジェクトフォルダが基準です。 |
| `.env.local`の変更が反映されない | 実行中の開発サーバーを止めてから、`npm run dev`をもう一度実行します。 |
| 3000番ポートを使用中というエラー | 先に実行したShareDeskの開発サーバーや別のプログラムを止めてから、もう一度実行します。 |
| `.devstorage`を削除したらファイルが消えた | localモードの実際の保存フォルダです。サーバーを止めて、全体のバックアップを同じ場所に復元します。 |
| `STORAGE_DRIVERの値が正しくありません` | 値は小文字の`local`または`drive`だけが許可されます。個人のローカル利用は`local`に直します。 |

## 開発者向け情報

### npmコマンド

| コマンド | 用途 |
|---|---|
| `npm run dev` | Next.jsの開発サーバーを実行します。 |
| `npm run build` | 本番ビルドが作られるか確認します。 |
| `npm start` | `npm run build`で作った本番ビルドを実行します。 |
| `npm run lint` | ESLintのチェックを実行します。 |
| `npm test` | リポジトリの自動テストを実行します。 |
| `npm run setup -- --prepare-env` | `.env.local`を準備します。既存の内容は上書きしません。 |
| `npm run setup` | ホストのGoogle認証を始めます。`.env.local`がなければ先に準備します。 |
| `npm run setup -- --finish` | ユーザーがローカルのターミナルにcallback URLを貼り付けて、ホストのDrive接続を完了します。URLをコマンドの引数として付けません。 |
| `npm run setup -- --check` | Client IDとsecretを読み込み、認証URLを作れるか確認します。 |
| `npm run test:drive-operations` | 実際のDriveで、作成・アップロード・ダウンロード・名前の変更・移動・削除・復元をテストします。 |
| `npm run test:drive-preview` | 実際のDriveで、GoogleドキュメントのPDF変換と動画のRangeレスポンスをテストします。 |
| `npm run test:drive-sharing` | 実際のDriveで、閲覧・編集権限の作成・変更・解除をテストします。 |

TypeScriptだけを個別に確認するには、次のコマンドを使います。

```powershell
npx tsc --noEmit --incremental false
```

### 環境変数

| 変数 | 使う場所 | 説明 |
|---|---|---|
| `ADMIN_EMAILS` | Drive本番 | 管理者のGoogleメールです。複数人ならカンマで区切ります。setupがホストのメールを入れます。 |
| `ACCESS_KEYS` | 任意、localで推奨 | カンマで区切った一時的なゲスト用のアクセスキーです。localの個人利用ではこのキーで`編集可能`の権限で入り、本番（drive）でアクセスキーで入ったゲストは`閲覧のみ`です。 |
| `SESSION_SECRET` | 必須 | ログインのcookieの署名に使う秘密です。16文字以上である必要があります。 |
| `STORAGE_DRIVER` | 必須推奨 | `local`または`drive`です。空にするとrefresh tokenの有無で決まりますが、明示して使うほうが安全です。 |
| `LOCAL_STORAGE_ROOT` | local専用 | ローカルのファイルと状態を保存するパスです。既定値は`.devstorage`です。 |
| `PUBLIC_BASE_URL` | Drive本番で条件付き | カスタムドメインや固定の本番アドレスのoriginです。パスと末尾のスラッシュは入れません。 |
| `GOOGLE_CLIENT_ID` | Drive本番 | Web applicationタイプのOAuth Client IDです。 |
| `GOOGLE_CLIENT_SECRET` | Drive本番 | OAuthのClient secretです。 |
| `GOOGLE_REFRESH_TOKEN` | Drive本番 | setupが受け取ったホストのオフライントークンです。 |
| `DRIVE_ROOT_FOLDER_ID` | Drive本番 | ShareDeskが管理するホストのDriveルートのIDです。 |
| `DRIVE_STATE_FOLDER_ID` | Drive本番 | ルート内の`.sharedesk`状態フォルダのIDです。 |
| `SHAREDESK_GITHUB_TOKEN` | 任意 | ワンクリックアップデート用のfine-grained PATです。ローカルでワンクリックアップデートをテストするには、`SHAREDESK_GITHUB_REPOSITORY`（下記）も一緒に入れる必要があります。 |
| `SHAREDESK_GITHUB_REPOSITORY` | 任意 | アップデート対象のインストールリポジトリ（`owner/repository`）です。Vercelの外（ローカル）にはリポジトリの情報がないため、ワンクリックのテスト時にご自身で指定します。 |
| `SHAREDESK_SHARE_TEST_EMAIL` | 実際のDriveテスト専用 | 共有テストを受ける、別の承認済みGoogleアカウントです。本番のVercel環境には入れません。 |
| `SHAREDESK_TRACE` | 開発時の確認 | 空でなければ、一部のDrive呼び出しとアイコン配置の保存時間をサーバーログに残します。 |

Vercelの既定のドメインを使いながら`PUBLIC_BASE_URL`を空にすると、アプリはVercelが提供する`VERCEL_PROJECT_PRODUCTION_URL`を使います。ご自身で入れる値ではなく、Vercelのシステム環境変数です。本番に必要な値とcallbackのアドレスは、[本番インストールガイド](./INSTALL.ja.md)にまとめてあります。

### 実際のDriveテスト

下の3つのコマンドは、localモードのテストではありません。`.env.local`の実際のGoogle Driveの設定を使って、テスト用のファイルを作ったり権限を変更したりします。個人の作業ファイルと分けて検証できるShareDeskのルートで実行してください。

基本的なファイル操作をテストします。

```powershell
npm run test:drive-operations
```

このテストは、フォルダの作成、サーバー経由のアップロード、全体のダウンロード、名前の変更、フォルダ間の移動、ブラウザからの直接アップロード、ごみ箱への削除・復元・完全削除を確認し、自分が作った項目を片づけます。片づけに失敗した場合は、Driveの`sharedesk-operations-test-*`フォルダをご自身で確認します。

プレビューをテストします。

```powershell
npm run test:drive-preview
```

このテストは、Googleドキュメント・スプレッドシート・スライド・図形描画がPDFとしてダウンロードされるかと、動画の一部リクエストがHTTP 206で動作するかを確認したあと、テスト用のDriveの項目を片づけます。

共有権限をテストするには、まず別のGoogleアカウントをShareDeskの招待で承認し、`.env.local`にそのメールアドレスを入れます。

```dotenv
SHAREDESK_SHARE_TEST_EMAIL=recipient@example.com
```

```powershell
npm run test:drive-sharing
```

共有のテストは、閲覧権限の作成、編集権限への変更、権限の解除、ShareDeskの共有台帳への反映を確認し、テスト用のファイルと権限を片づけます。

自動テストが通っても、相手のアカウントのGoogle Driveの`共有アイテム（Shared with me）`に項目が実際に表示されるか、閲覧権限では編集が拒否され編集権限では許可されるかは、別のアカウントでご自身で確認する必要があります。

### 状態の保存と同時変更

Driveモードは`ShareDesk/.sharedesk/`に、localモードは`LOCAL_STORAGE_ROOT/.sharedesk/`に、ユーザー・招待、接続の状態、Driveの共有台帳、フォルダメモ、アイコンの配置とごみ箱の状態を保存します。通常のファイル一覧では、このフォルダを隠し、直接開けないようにします。

状態ファイルやフォルダの移動のように、最後に見たバージョンが重要な変更では、同時に行われた場合に先に保存された結果を維持します。遅れたリクエストは衝突として終了させ、最新の状態を読み直します。

### 現在の制限

- ShareDeskが扱う範囲は、設定したDriveまたはlocalのルートの中だけです。
- 同じフォルダでの同じ名前は許可しません。
- HTMLとSVGは、そのままプレビューせずダウンロードします。
- Googleドキュメント・スプレッドシート・スライド・図形描画だけがPDF変換プレビューに対応します。
- Driveの容量とDriveのごみ箱の保管期間は、ホストのGoogleアカウントのポリシーに従います。
- localのごみ箱は、30日を過ぎた項目を、次にごみ箱を開いたときに完全に削除します。

変更する前には、`npm test`、`npm run lint`、`npx tsc --noEmit --incremental false`、`npm run build`を実行してください。バグを報告するときは、再現の手順とブラウザ・Node.jsのバージョンを書き、`.env.local`、OAuthのcallback URL、トークン、Client secretは添付しないでください。
