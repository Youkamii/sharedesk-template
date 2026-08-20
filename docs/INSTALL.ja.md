[English](./INSTALL.md) · [한국어](./INSTALL.ko.md) · **日本語** · [हिन्दी](./INSTALL.hi.md) · [中文](./INSTALL.zh.md)

# ShareDesk 本番インストールガイド

ホスト1人のGoogle Driveの保存容量を、複数の人がそれぞれのGoogleアカウントで一緒に使えるように、ShareDeskを立ち上げるための文書です。

Google CloudやVercelの設定に慣れていない場合は、すべてをご自身で進める必要はありません。[AIに構築を任せる](./AI_INSTALL.ja.md)の依頼文をコーディングAIに送ると、AIが終わっている手順をまず確認し、ご自身で操作が必要な画面だけを1ステップずつ案内します。

## まず、自分の役割は何でしょうか？

### 参加者

誰かが作ったShareDeskに招待された場合は、**この文書に従ってインストールしないでください。** ホストから届いたShareDeskのアドレスで自分のGoogleアカウントでログインし、招待コードを入力するだけです。GitHubアカウント、Vercelプロジェクト、Google OAuthクライアントは必要ありません。

### ホスト

自分のGoogle Driveの容量を提供して新しいShareDeskのアドレスを作り、人を招待したい場合は、以下に従ってください。インストールはホストが一度だけ行い、参加者はそのアドレスと保存容量を一緒に使います。

インストール1つごとに、ホストのGitリポジトリ、Vercelプロジェクト、Google OAuthクライアント、Driveのルートがそれぞれ別に紐づきます。この分離の仕組みはホストがインストールを所有していることの説明であり、ShareDeskの最初の価値は、1つのDriveの保存容量を複数の人で一緒に使えることにあります。すでに作ってある設定があれば、新しく作らずそのまま使い続けてください。

## ホスト向けクイックガイド

1. **ShareDeskのアドレスを作る:** [Deploy with Vercel](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FYoukamii%2Fsharedesk-template&project-name=my-sharedesk&repository-name=my-sharedesk)で自分のGitHubリポジトリとVercelプロジェクトを作り、Productionのアドレスを記録します。
2. **Googleとの接続を作る:** Google CloudでDrive APIを有効にし、Web applicationのOAuthクライアントを作ります。正確なスコープとcallbackのアドレスは[ステップ2](#2-google-cloudの設定)からコピーしてください。
3. **ホストのDriveを接続する:** リポジトリを取得し、`npm ci`、`npm run setup`を実行します。`.env.local`がなければsetupが自動で作ります。Client IDとsecretを入力してもう一度実行すると、認証ページがブラウザで自動的に開きます。同意したあと`npm run setup:finish`で仕上げます。
4. **本番につなぐ:** setupが埋めた必須の値をVercelのProduction環境変数に移し、再デプロイします。
5. **1人と一緒に確認する:** 本番でのログインとファイル保存をまず確認してから、`/admin`で招待コードを作ります。1人を招待して、2つのアカウントで同じファイルが見えることを確認できれば、中心となるインストールは完了です。Vercel Firewallはそのあとの本番保護の手順で設定します。

ShareDeskは新しいバージョンを自動では適用しません。インストール後、管理者画面の`アップデート`ボタンは、新しいバージョンがあるときだけ星印を表示します。既存のインストールを最初に接続する方法は[アップデートガイド](./UPDATE.ja.md)にあります。

以下は各手順の詳しい説明です。Google Cloudの画面やエラーが出た箇所だけを探して読んでいただいてもかまいません。

## インストール完了の基準

次の項目をすべて確認できて、はじめて本番インストールが完了したことになります。

- 自分のGitリポジトリと自分のVercelプロジェクトが接続されています。
- 変わることのないProductionのアドレスがあります。
- Google OAuthクライアントに本番のcallbackが正確に登録されています。
- VercelのProduction環境に本番で必須の値が入っています。
- 本番アドレスでホストのGoogleログインができます。
- `/files`で作ったフォルダが、再読み込みしたあとも残っています。
- 画面の右下にタスクバーとは別に置かれたごみ箱アイコンが見え、アイコンを押して削除した項目を復元できます。
- `/admin`が開き、招待コードの有効期間と使用タイプを選べます。
- 招待コードで1人が自分のGoogleアカウントで参加しました。
- ホストと参加者の2つのアカウントで、同じファイルを見てダウンロードできます。

## 必要なもの

- [Node.js](https://nodejs.org/) 20.9以上
- Git
- GitHubアカウント
- Vercelアカウント
- GoogleアカウントとGoogle Cloudプロジェクトを作れる権限

### どのアカウントが接続されているかを確認する

パソコンにすでに別のGitHub・Vercelアカウントがログインしていると、意図しないアカウントにリポジトリとプロジェクトが作られます。始める前に確認してください。

```powershell
gh auth status
vercel whoami
git config --global user.email
```

別のアカウントが表示されたら、この順でログインし直します。

1. `gh auth logout`のあと`gh auth login`で、使うGitHubアカウントにログインします。
2. `vercel logout`のあと`vercel login`で、使うVercelアカウントにログインします。
3. `git config --global user.email "使うメールアドレス"`で、コミットのメールを合わせます。

## 1. リポジトリと固定の本番アドレスを準備する

現在のリポジトリの`origin`が自分のリポジトリで、すでにVercelプロジェクトに接続されているなら、この手順を繰り返さないでください。`git remote -v`とVercelプロジェクトの設定を確認したうえで、既存のプロジェクトを使います。

まだリポジトリとVercelプロジェクトがない場合は、下のボタンで両方をまとめて作成してください。

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FYoukamii%2Fsharedesk-template&project-name=my-sharedesk&repository-name=my-sharedesk)

Vercelなしでリポジトリだけを先に作るには、[Use this template](https://github.com/Youkamii/sharedesk-template/generate)を使います。

### 新規アカウントでCreateボタンが押せないとき

Vercelを初めて使うアカウントは`Git Scope`が空のため、`Create`ボタンが無効の状態です。`Select Git Scope`のドロップダウン → `Add GitHub Account`を押してGitHubアプリをインストール（`All repositories`を選択）すると、`Create`が有効になります。この過程でGitHubのウィンドウがポップアップで開くので、ブラウザのポップアップブロックも確認してください。

最初のデプロイは環境変数が空のままでもかまいません。ログインボタンの代わりにインストールの案内が表示されるのが正常です。この手順で次の2つのアドレスを記録してください。

- 自分のGitリポジトリ: 例）`https://github.com/my-account/my-sharedesk`
- 固定のProductionアドレス: 例）`https://my-sharedesk.vercel.app`

コミットごとに変わるPreviewのアドレスや長いデプロイのアドレスではなく、プロジェクトにずっと紐づいているProductionのアドレスを使います。

プロジェクト名をほかの人が先に使っていると、アドレスに`-theta`のような接尾辞が付くことがあります。自分の固定アドレスは、Vercelプロジェクトの`Domains`タブで`.vercel.app`で終わるアドレスとして確認してください。途中にハッシュが付いた長いデプロイのアドレスは使いません。

## 2. Google Cloudの設定

### 2-1. プロジェクトとDrive API

1. [Google Cloud Console](https://console.cloud.google.com/)を開きます。
2. 使うプロジェクトを選ぶか、新しいプロジェクトを作ります。
3. `APIとサービス` → `ライブラリ`で`Google Drive API`を有効にします。

OAuthクライアントとDrive APIは、同じCloudプロジェクトに置いてください。

### 2-2. Branding

`Google Auth Platform` → `Branding`で次の値を入力します。

- アプリ名: 例）`私たちのチームのShareDesk`
- ユーザーサポートメール
- デベロッパーの連絡先メール

Google Cloudの画面の言語によっては、`ブランディング`、`対象`、`データアクセス`、`クライアント`のように翻訳されて表示されることがあります。

### 2-3. Audience

`Google Auth Platform` → `Audience`で対象ユーザーを決めます。

- 個人のGoogleアカウントや組織外の人も招待するなら`External`
- 1つのGoogle Workspace組織の中だけで使うなら、組織のポリシーに従って`Internal`

本番用のExternalアプリは、setupの前に`Publish app`を押して`In production`に切り替えてください。すでに`In production`ならそのままにします。

`Testing`のままでもインストールはできますが、ShareDeskのホスト接続は`drive.file`とオフラインアクセスを合わせて要求します。この状態で受け取ったrefresh tokenは、通常7日後に期限が切れます。すでにTestingの状態でsetupしてしまった場合は、先にIn productionに変えてから、ホストの接続をやり直してください。すでにIn productionのアプリで正常に動いているトークンは、根拠なく破棄しないでください。

`In production`は、テスト用のトークンの期限ポリシーとは区別される公開状態です。アプリの審査完了と同じ意味ではなく、Brandingやユーザー数によっては、Googleの警告や追加の審査手続きが残ることがあります。

状態の詳しい説明は[Google OAuth Audienceのガイド](https://support.google.com/cloud/answer/15549945?hl=ja)を参照してください。

### 2-4. Data Access

`Google Auth Platform` → `Data Access` → `Add or remove scopes`で、下の4つのスコープを追加します。

```text
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
https://www.googleapis.com/auth/drive.file
```

### 2-5. Web application OAuthクライアント

`Google Auth Platform` → `Clients`で、既存のWeb applicationクライアントをまず確認します。使える既存のクライアントがあれば、新しく作らず、足りないアドレスだけを追加します。

新しく作る場合は、次のように設定します。

1. Application type: `Web application`
2. 名前: 例）`ShareDesk web`
3. `Authorized JavaScript origins`: 空のままにする
4. `Authorized redirect URIs`: 下の3つのアドレスを登録

```text
http://127.0.0.1:53682/callback
http://localhost:3000/api/auth/google/callback
https://my-sharedesk.vercel.app/api/auth/google/callback
```

最後のアドレスのドメインは、ステップ1で得た実際のProductionドメインに置き換えてください。

本番のcallbackを`Authorized JavaScript origins`に入れてはいけません。JavaScript originにはパスを入れられず、ShareDeskはその欄を使いません。3つのアドレスはすべて`Authorized redirect URIs`に入れます。

リダイレクトのアドレスは、`http`/`https`、ホスト、ポート、パス、末尾のスラッシュまで正確に一致している必要があります。Googleの[OAuthウェブサーバーのガイド](https://developers.google.com/identity/protocols/oauth2/web-server#uri-validation)でも、完全一致が求められています。

クライアントを作成したら、Client IDとClient secretを安全に控えておいてください。次の手順で必要になります。公開リポジトリ、チャット、Issue、スクリーンショットには貼らないでください。

## 3. ローカルの環境ファイルを準備する

現在のリポジトリがすでにローカルで開かれている場合は、もう一度cloneせず、そのフォルダから始めます。

まだ取得していない場合は、ステップ1で作った自分のリポジトリをcloneします。

```powershell
git clone https://github.com/<自分のGitHubアカウント>/my-sharedesk.git
cd my-sharedesk
```

依存関係をインストールし、setupを一度実行します。

```powershell
npm ci
npm run setup
```

`.env.local`がない場合、オプションなしの`npm run setup`が所有者だけがアクセスできる権限でファイルを自動生成し、`.env.example`の内容を入れます。Client IDとsecretが空だという案内が出るのは正常です。既存の`.env.local`がある場合は、内容を上書きせず権限だけを確認します。

環境ファイルだけを先に準備してsetupを始めたくない場合は、これまでどおり使える`npm run setup -- --prepare-env`を使ってもかまいません。

`.env.local`に次の2つの値をご自身で入力します。

```dotenv
GOOGLE_CLIENT_ID=発行されたclient-id
GOOGLE_CLIENT_SECRET=発行されたclient-secret
```

これらの値を、コーディングエージェントのチャットやコマンドラインの引数に渡さないでください。

## 4. ホストのDriveを接続する

既存の`.env.local`に有効な`GOOGLE_REFRESH_TOKEN`、`DRIVE_ROOT_FOLDER_ID`、`DRIVE_STATE_FOLDER_ID`がすべてあり、実際に動いているなら、setupをもう一度実行する必要はありません。新規インストールのときや、接続を発行し直す必要があるときだけ、下の順で進めます。

### 4-1. 認証を始める

```powershell
npm run setup
```

1. setupがGoogleの認証ページを既定のブラウザで開きます。自動で開かない場合は、ターミナルにそのまま出力されたURLをご自身で開いてください。
2. ShareDeskのホストになるGoogleアカウントでログインし、同意します。
3. ブラウザが`http://127.0.0.1:53682/callback?...`に移動します。
4. ブラウザに接続失敗と表示されても正常です。アドレスバーのアドレス全体をコピーします。

callback URLには、短い時間だけ有効な使い捨ての認証コードが含まれています。同じパソコンのターミナルにだけ貼り付け、チャット、Issue、スクリーンショットで共有しないでください。

### 4-2. 認証を完了する

```powershell
npm run setup:finish
```

質問が表示されたら、いまコピーしたcallback URL全体を貼り付けます。URLをコマンドの引数として書かないため、シェルの履歴に認証コードが残りません。

コーディングエージェントと一緒に進めている場合、この入力はご自身で行います。エージェントはcallback URLをチャットで求めたり、ターミナルの出力から読み直したりせず、入力が終わるまで待ちます。

setupが終わると、`.env.local`に次の値が用意されます。

- `ADMIN_EMAILS`
- `SESSION_SECRET`
- `CRON_SECRET`
- `STORAGE_DRIVER=drive`
- `GOOGLE_REFRESH_TOKEN`
- `DRIVE_ROOT_FOLDER_ID`
- `DRIVE_STATE_FOLDER_ID`

また、ホストのDriveに`ShareDesk`ルートと`.sharedesk`状態フォルダを作ります。既存の状態ファイルを勝手に上書きすることはありません。

## 5. ローカルでの確認

```powershell
npm run dev
```

1. `http://localhost:3000`を開きます。
2. ホストのGoogleアカウントでログインします。
3. `/files`でフォルダを1つ作り、再読み込みしたあとも残るか確認します。
4. `/admin`が開くか確認します。

ここまではローカルでの確認です。ほかの人が使える本番のデプロイが終わったわけではありません。

## 6. VercelのProduction環境変数と再デプロイ

ステップ1で作った既存のVercelプロジェクトを開きます。`Settings` → `Environment Variables`で、下の値をProduction環境に入れます。最近の画面では、`Settings` → `Environments` → `Production`を押して入った詳細画面の中に、環境変数の入力欄があります。

| 名前 | 値 |
|---|---|
| `ADMIN_EMAILS` | 管理者のGoogleメール。複数人ならカンマで区切る |
| `SESSION_SECRET` | setupが作った長いランダムな値 |
| `CRON_SECRET` | setupが作った期限切れファイル整理用のランダムな値 |
| `STORAGE_DRIVER` | `drive` |
| `GOOGLE_CLIENT_ID` | Web applicationのClient ID |
| `GOOGLE_CLIENT_SECRET` | Client secret |
| `GOOGLE_REFRESH_TOKEN` | setupが受け取ったホストのrefresh token |
| `DRIVE_ROOT_FOLDER_ID` | setupが作ったShareDeskフォルダのID |
| `DRIVE_STATE_FOLDER_ID` | setupが作った状態フォルダのID |
| `PUBLIC_BASE_URL` | 固定のProduction origin。例: `https://my-sharedesk.vercel.app` |
| `SHAREDESK_DEFAULT_LOCALE` | （任意）デスクの既定言語（en/ko/ja/hi/zh）。setupで選んだ値 — `.env.local`の値をそのままコピー |
| `SHAREDESK_GITHUB_TOKEN` | （任意）ワンクリックアップデート用のfine-grained PAT — [アップデートガイド](./UPDATE.ja.md)を参照 |

インストールのミスを減らすため、VercelのProductionには`PUBLIC_BASE_URL=https://実際の本番ドメイン`を明示してください。この値はローカルの`.env.local`には入れません。ローカルのアプリのログインは`http://localhost:3000`に戻ってくる必要があるからです。

`PUBLIC_BASE_URL`を省略した場合、ShareDeskは代わりに`VERCEL_PROJECT_PRODUCTION_URL`を使います。この方法を使うなら、Vercelプロジェクトでシステム環境変数の公開が有効になっているか確認してください。

`PUBLIC_BASE_URL`にはoriginだけを入れます。パス、末尾のスラッシュ、callbackのパス、PreviewのURLは付けません。

`ACCESS_KEYS`は、一時的なゲスト用のキーを使うときだけ入れます。driveモードでアクセスキーで入ったゲストは`閲覧のみ`です。`LOCAL_STORAGE_ROOT`と`SHAREDESK_SHARE_TEST_EMAIL`は本番環境に入れません。どの秘密の値にも`NEXT_PUBLIC_`の接頭辞を付けないでください。

複数の値を一度に貼り付けるときは、Key欄が1行目（`ADMIN_EMAILS`）を丸ごと飲み込む落とし穴があります。貼り付けたあと、変数の数が10個（任意の項目を除く）かを必ず確認してください。値はデフォルトで`Sensitive`として保存され、保存後は二度と見られませんが、これは正常です。

環境変数を入力したり変更したりしたあとは、Productionを再デプロイします。環境変数の変更は、既存のデプロイには自動で反映されません。`Deployments`タブで最新のデプロイの行にマウスを載せると出てくる`⋯`メニュー → `Redeploy`を押してください。`Create Deployment`ボタンはPreviewデプロイ専用なので、使わないでください。詳しい動作は[Vercelの環境変数ガイド](https://vercel.com/docs/environment-variables)を参照してください。

## 7. 本番での確認

固定のProductionアドレスで直接確認します。

1. ホストのGoogleアカウントでログインします。
2. `/files`でテスト用のフォルダを作り、再読み込みしたあとも残るか確認します。
3. テスト用のフォルダを削除したあと、画面の右下のごみ箱アイコンを押してごみ箱ウィンドウを開き、フォルダを復元します。アイコンがタスクバーの外にあり、開いたウィンドウと重なったときにウィンドウの後ろに隠れるかも確認します。
4. `/admin`が開くか確認します。
5. 招待コードの作成画面で、有効期間`1時間`、`24時間`、`7日間`、`30日間`と、使用タイプ`1回用`、`期間内無制限`を選べるか確認します。参加した人が最初に持つ役割も、`編集可能`（デフォルト）、`アップロード可能`、`閲覧のみ`から選べるか確認します。
6. ログアウトしてもう一度ログインし、本番のcallbackが正常か確認します。
7. `/admin`で招待コードを1つ作り、一緒に使う1人に本番アドレスとコードを送ります。
8. 参加者が自分のGoogleアカウントでログインしたあと、招待コードを入力します。参加者にはOAuthクライアントやVercelプロジェクトは必要ありません。
9. ホストがテスト用のファイルを1つアップロードし、ホストと参加者の2つのアカウントで同じファイルを見てダウンロードできるか確認します。

Driveモードでごみ箱に入れた項目は、ご自身で完全に削除しないかぎり、[Google Driveの30日間のごみ箱ポリシー](https://support.google.com/drive/answer/14933051?hl=ja)に従って30日を過ぎると完全に削除されます。OAuthを使わない`local`モードでは、30日を過ぎた項目を、次にごみ箱を開いたときにShareDeskが完全に削除します。

招待された人は、新しいShareDeskをインストールするのではなく、ホストがすでに作った共有のファイル空間に参加することになります。

## 8. 動作確認のあとの本番保護

上のステップ7でログイン、ファイル保存、実際に1人を招待するところまで確認したあと、招待コードの送信リクエストを保護します。Firewallの設定は、ShareDeskを動かすためのインストール手順ではなく、本番を保護するための手順です。

VercelプロジェクトのFirewallで、下のRate Limitルールを作り`Publish`します。

既存のRate Limitルールがある場合は、まず条件と用途を確認してください。ほかのルールを上書きせず、新しいルールを追加できるか確認します。

- 条件: `Request Path` equals `/api/invitations/code`
- 条件: `Method` equals `POST`
- 条件: Cookie `sharedesk_session` exists
- 動作: `Rate Limit`
- 方式: `Fixed Window`
- 基準: `IP`
- 制限: `60秒`に`10回`、超過したら`429`

3つの条件をすべて入れてはじめて、招待コードの送信だけに制限がかかります。ルールを作るときは、Vercelが表示する使用量と料金の案内も確認してください。設定画面については[Vercel WAF Rate Limitingのガイド](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting)を参照できます。

## 人を招待して管理する

1. ホストが本番アドレスの`/admin`を開きます。
2. 招待コードの有効期間を`1時間`、`24時間`、`7日間`、`30日間`から選びます。
3. 使用タイプを`1回用`または`期間内無制限`から選びます。
4. 参加した人が最初に持つ役割を`編集可能`（デフォルト）、`アップロード可能`、`閲覧のみ`から選びます。
5. 作ったコードと本番アドレスを参加者に渡します。
6. 参加者は自分のGoogleアカウントでログインしたあと、コードを入力します。参加した人は、コードで選んだ役割で始まります。

招待コードは、特定のメールアドレスにあらかじめ紐づけられるものではありません。名前とメールアドレスは、実際にコードを入力した人のGoogleログインから取得します。

- **1回用:** 1人が参加に成功すると、すぐに使用済みになります。
- **期間内無制限:** 期限が切れるか、ホストが無効にするまで、複数の人で一緒に使えます。

### 4段階の役割

| 役割 | できること |
|---|---|
| 管理者 | すべてのファイル操作とユーザー管理。`ADMIN_EMAILS`に書かれたアカウントは、保存された役割に関わらず常に管理者です。 |
| 編集可能 | アップロード・ダウンロード・削除・移動・名前の変更、メモ帳とフォルダメモの編集、ごみ箱の操作、新しいメモ帳の作成 |
| アップロード可能 | アップロード・ダウンロード・新しいフォルダの作成・アイコンの配置の移動 |
| 閲覧のみ | 閲覧とダウンロードのみ |

役割は、参加するときに一度決まったら終わりという値ではありません。`/admin`のユーザー表の役割列で、いつでも変更できます。

管理画面では、ユーザーをブロックしたり参加待ちに戻したりでき、特定の端末のログインや、そのユーザーのすべてのログインを切断できます。`ADMIN_EMAILS`を変更した場合は、Vercelの環境変数を直したあと、再デプロイする必要があります。

## インストール後のアップデート

ShareDeskは新しいバージョンを自動では適用しません。新しいバージョンが確認されると、管理者のタスクバーの`アップデート`に星印を表示します。ボタンを押すと、ShareDeskの中で現在のバージョンと最新のバージョンをまず表示します。Vercelに`SHAREDESK_GITHUB_TOKEN`を登録しているインストールでは、管理者が`今すぐアップデート`を押すとアプリの中ですぐにアップデートが始まり、進行状況が表示されます。トークンがないインストールでは、これまでどおりGitHub Actionsの画面が開き、`Run workflow`を押して開始します。どちらの場合も、チェックを通過したときにだけ`main`にコミットし、接続されたVercelが再デプロイします。

Driveのファイルと共有の状態、`.env.local`、Vercelの環境変数は、コードのアップデートには含まれません。アップデート機能が入る前に作られたインストールの1回限りの移行と、衝突の解決については[ShareDeskのアップデート](./UPDATE.ja.md)に従ってください。

## Google Driveで直接共有する

管理者がファイルやフォルダを右クリックして**Google Driveで共有**を押すと、承認済みのユーザーに閲覧または編集の権限を与えられます。この機能は、ShareDeskの中で項目を隠したり公開したりする機能ではなく、相手のGoogle Driveの`共有アイテム`にも表示される実際のDriveの権限です。

フォルダの権限は、Google Driveのルールに従って下位の項目にも引き継がれます。相手の`共有アイテム`での表示や、閲覧と編集の権限の違いは、別のGoogleアカウントでご自身で確認してください。自動テストの方法は[ローカル利用の文書の実際のDriveテスト](./LOCAL.ja.md#実際のdriveテスト)を参照します。

## トラブルシューティング

| 症状 | 確認する内容 |
|---|---|
| `redirect_uri_mismatch` | エラーに出た`redirect_uri`を、Google Auth Platformの同じClient IDにある`Authorized redirect URIs`と1文字ずつ比べます。JavaScript originsではありません。 |
| `アプリにアクセスできません` | Audienceが`External`か確認します。`Testing`のままにするなら、ログインするアカウントをTest userに入れる必要があります。 |
| `org_internal` | Internalのアプリに、組織外のアカウントでログインした場合です。Externalに変えるか、組織のアカウントを使います。 |
| 同意のあとに`127.0.0.1`への接続が失敗する | setupでは正常です。アドレスバーの全体をコピーして、`npm run setup:finish`の質問に貼り付けます。 |
| `refresh_tokenを受け取れませんでした` | 既存の接続とAudienceの状態をまず確認します。新しいトークンが本当に必要で、既存の接続のせいで発行されない場合にだけ、[Googleアカウントの連携済みアプリ](https://myaccount.google.com/permissions)で権限を削除し、setupをやり直します。 |
| 約7日後にDriveの接続が切れる | Audienceが`Testing`だったかをまず確認します。Testingで受け取ったホストのトークンなら、In productionに切り替えてからsetupをやり直します。すでにIn productionなら、先にトークンを破棄せず、実際の認証エラーを確認します。 |
| Drive APIが403を返す | OAuthクライアントを作ったのと同じCloudプロジェクトで、Google Drive APIが有効になっているか確認します。Workspaceの管理ポリシーが外部アプリをブロックしていないかも確認します。 |
| Vercelでだけログインに失敗する | Production環境変数、固定の本番origin、Google側の本番redirect URI、環境変数を変更したあとに再デプロイしたかを確認します。 |
| 招待コードが拒否される | `/admin`でコードの有効期限・有効/無効の状態・使用タイプを確認します。1回用は、ほかの人が最初に参加した時点ですでに使用済みになっている可能性があります。 |
| 特定のWorkspaceアカウントだけ失敗する | 組織の管理者によるサードパーティアプリのアクセス制限や、Google Advanced Protectionのポリシーを確認します。 |
| 管理者のログインで招待を求められる | ログインしたメールアドレスが`ADMIN_EMAILS`と完全に同じか確認し、値を変えた場合は再デプロイします。 |
| 同じ名前の状態ファイルが複数あるとsetupが中断する | Driveの`ShareDesk/.sharedesk/`で該当のJSONファイルを確認し、内容を比べて残す1つだけにしてから、もう一度実行します。 |

### setupをもう一度実行してもよいですか？

既存の`DRIVE_ROOT_FOLDER_ID`と状態フォルダのIDが`.env.local`にあれば、setupはそのフォルダと既存の状態ファイルをそのまま使い続けます。同じ名前の中心的な状態ファイルが複数ある場合は、勝手に選ばず中断するので、Driveで内容を確認して1つだけ残す必要があります。

Client secretを入れ替えた場合や、refresh tokenを取り直す必要がある場合は、`.env.local`のClient IDとsecretを先に更新してから、setupをやり直してください。すでに正常に動いている接続を、推測で破棄しないでください。

## 保存の仕組みと制限

- ShareDeskが扱う範囲は、setupで決めたDriveのルートフォルダの中だけです。ホストがDriveのウェブ画面で項目をルートの外に移動すると、ShareDeskからアクセスできなくなります。
- 同じフォルダに同じ名前の項目を作ったり、その名前に変更したりする操作は拒否されます。
- HTMLやSVGのようにスクリプトを実行できる形式は、ブラウザでそのまま表示せずダウンロードします。
- Googleドキュメント・スプレッドシート・スライド・図形描画は、PDFに変換してプレビューします。
- 無料のGoogle Driveの容量とごみ箱の保管期間は、ホストのアカウントのGoogleのポリシーに従います。

Driveモードでは、`ShareDesk/.sharedesk/`にユーザー・招待、現在の接続人数、Driveの共有権限、フォルダメモとアイコンの配置を保存します。通常のファイル一覧では、このフォルダを隠します。同時に同じ状態を変更した場合は、先に保存された結果を維持し、遅れたリクエストは衝突として終了させて、最新の状態を読み直させます。

コーディングAIと一緒にインストールするには、[AIインストールガイド](./AI_INSTALL.ja.md)を使ってください。開発・テストのコマンドと環境変数の一覧表は、[ローカル個人利用](./LOCAL.ja.md#開発者向け情報)に別途まとめてあります。
