[English](./UPDATE.md) · [한국어](./UPDATE.ko.md) · **日本語** · [हिन्दी](./UPDATE.hi.md) · [中文](./UPDATE.zh.md)

# ShareDeskのアップデート

ShareDeskは、インストール時に作られた**ご自身のGitHubリポジトリ**を更新し、そのリポジトリに接続されたVercelが再デプロイすることで新しいバージョンを適用します。Google Drive内のファイル・ユーザー・招待・メモと、Vercelの環境変数はコードアップデートの対象ではありません。

## アップデートボタンを使う

ShareDeskは新しいバージョンを自動では適用しません。管理者としてログインすると最新の安定版を一度だけ確認し、新しいバージョンがあるときだけタスクバーの`アップデート`に星印を表示します。

下の[ワンクリックアップデートの準備](#ワンクリックアップデートの準備初回のみ)を一度済ませたインストールでは、GitHubの画面に移動せず、ShareDeskの中でアップデートが完了します。

1. 星印が付いた`アップデート`を押して、ShareDeskの中で現在のバージョンと最新の安定版を確認します。星印がなくても、ボタンを押してご自身で確認できます。
2. 新しいバージョンがあれば、そのウィンドウの`今すぐアップデート`を押します。
3. ShareDeskがインストールリポジトリのアップデートworkflowを代わりに実行し、同じウィンドウに進行状況を表示します。`アップデートを適用しています` → `新バージョンをデプロイしています`を経て、終わると`アップデートが完了しました`、問題があれば`アップデートに失敗しました`と表示されます。数分かかることがあります。
4. チェックがすべて通ると、インストールリポジトリの`main`にアップデートのコミットが作られ、リポジトリに接続されたVercelが新しいコミットをProductionにデプロイします。
5. `アップデートが完了しました`と表示されたら、`再読み込み`を押して新しいバージョンを適用します。

チェックやビルドが失敗した場合は`main`にコミットしないため、現在の本番デプロイはそのまま残ります。ご自身のインストールでShareDeskのコードファイルを直接変更していた場合も、上書きはせず、衝突したファイル名を表示して停止します。失敗が表示されたときは`詳細ログを見る`を押すとGitHub Actionsの記録を確認できます。

### ワンクリックアップデートの準備（初回のみ）

アプリの中からそのままアップデートするには、ShareDeskがご自身のインストールリポジトリのworkflowを実行できるよう、GitHubトークンを一度だけ作ってVercelに登録します。このトークンは、ご自身のインストールリポジトリ1つのActions権限だけを持つ最小権限のトークンです。

1. GitHubにログインしたあと、右上のプロフィール画像 → `Settings`を開きます。
2. 左メニューの一番下にある`Developer settings` → `Personal access tokens` → `Fine-grained tokens`を開きます。
3. `Generate new token`を押します。
4. トークンの名前を分かりやすく付けます。例）`sharedesk-update`
5. `Expiration`（有効期限）を決めます。有効期限が切れるとワンクリックは止まり、フォールバック経路だけが残ります。長めの有効期限を選んで期限を覚えておくか、期限切れのあとにこの手順でトークンを作り直してください。
6. `Repository access`で`Only select repositories`を選び、**ご自身のShareDeskインストールリポジトリ1つだけ**を選択します。
7. `Permissions` → `Repository permissions`で`Actions`を`Read and write`に変更します。
8. 同じ画面の`Account permissions`で`Starring`を`Read and write`に変更します。アップデートを始めるときに、ShareDeskのリポジトリへ星を付けるために使います。ほかの権限は変更しません。
9. `Generate token`を押し、作成されたトークンの値をコピーします。この値は画面を離れると二度と表示できません。
10. Vercelプロジェクトの`Settings` → `Environment Variables`で、`Production`環境に次の値を追加します。

```dotenv
SHAREDESK_GITHUB_TOKEN=コピーしたトークンの値
```

11. Productionを再デプロイします。環境変数の変更は、既存のデプロイには自動で反映されません。

トークンは秘密の値です。公開リポジトリ、チャット、Issue、スクリーンショットには貼らないでください。

### トークンなしで使うフォールバック経路

`SHAREDESK_GITHUB_TOKEN`を登録していないインストールでもアップデートできます。この場合、`今すぐアップデート`を押すと、これまでどおりGitHubの画面が開きます。

1. 開いたGitHub Actionsの画面で`Run workflow`を押します。
2. チェックがすべて通ると、インストールリポジトリの`main`にアップデートのコミットが作られます。
3. リポジトリに接続されたVercelが新しいコミットをProductionにデプロイします。

失敗したときや衝突したときの動作はワンクリックと同じです。チェックが失敗した場合は`main`にコミットしません。

GitHubの既定の権限では、実行中のworkflowファイル自体を変更することは許可されていません。今後、ShareDeskのアップデート処理の方式が変わったリリースでは、古いworkflowを黙って使い続けることはせず処理を停止し、下の`0.2.0より古いインストールを一度だけ移行する`のような1回限りの移行を案内します。アプリと通常のアップデートのコードは、その場合を除き、管理者が上記の手順（ワンクリックまたはフォールバック）をご自身で開始したときにのみ更新されます。

アップデートボタンに、インストールリポジトリが接続されていないと表示される場合は、VercelのProduction環境変数に次の値を追加してから再デプロイしてください。

```dotenv
SHAREDESK_GITHUB_REPOSITORY=自分のGitHubアカウント/自分のShareDeskリポジトリ
```

Deploy with Vercelで作ったプロジェクトは、VercelのGitリポジトリ情報が自動で読み取られるため、この値を別途入れる必要はありません。GitHub Actionsが成功したのにVercelのデプロイが始まらない場合は、Vercelプロジェクトの`Settings` → `Git`で、同じインストールリポジトリの`main`がProduction Branchとして接続されているか確認します。

## 自動アップデート

管理者画面 → 設定 → アップデートで`自動アップデート`をオンにすると、オンにしたパソコンのタイムゾーンの午前0時に新しいバージョンが自動的に適用されます。キーは必要ありません。オンの間はタスクバーのアップデートボタンが隠れ、アップデート内容は同じ設定画面で確認できます。オンにするには、GitHubでShareDeskのリポジトリに星を付ける必要があります。

この機能はリポジトリの`.github/workflows/sharedesk-auto-update.yml`ワークフローが担当し、新しくインストールしたリポジトリには最初から入っています。以前にインストールしたリポジトリにこのファイルがない場合は、元のリポジトリの同じパスから内容をコピーして、ご自身のリポジトリの同じ場所に一度だけ追加してください。

知っておくこと: 自動アップデートは人の確認なしに新しいリリースをそのまま適用します。元のリポジトリを信頼できる場合にのみオンにしてください — 元のアカウントが乗っ取られると、そのコードが自動的に入ってきます。

参考: GitHubはリポジトリに60日間活動がないと予約実行を一時停止します。その場合は、リポジトリのActions画面で`ShareDesk Auto Update`ワークフローを再度有効にしてください。

## 0.5.0で変わる動作

0.5.0からユーザーごとに役割が設定されます。アップデート後は次のとおりになります。

- 既存のユーザーはすべて`編集可能`の役割に引き継がれます。これまでの使い方は変わりません。
- 本番（`STORAGE_DRIVER=drive`）のインストールで`ACCESS_KEYS`で入るアクセスキーのゲストは`閲覧のみ`に変わります。アクセスキーでファイルをアップロードしたり編集したりする使い方は、アップデート後は動作しません。localモードのアクセスキーはこれまでどおり`編集可能`です。
- 役割は管理者画面のユーザー表の役割列で、いつでも調整できます。

## 0.2.0より古いインストールを一度だけ移行する

アップデートボタンとworkflowがない既存のインストールは、下の移行を**一度だけ**行います。まずインストールリポジトリの`main`をローカルに開き、`git status`に変更がないことを確認してください。

Windows PowerShell:

```powershell
$shareDeskBootstrap = Join-Path $env:TEMP 'sharedesk-bootstrap.mjs'
Invoke-WebRequest 'https://github.com/Youkamii/sharedesk-template/releases/latest/download/sharedesk-bootstrap.mjs' -OutFile $shareDeskBootstrap
node $shareDeskBootstrap --apply
Remove-Item -LiteralPath $shareDeskBootstrap
```

macOSまたはLinux:

```bash
sharedesk_bootstrap="$(mktemp)"
curl -fL 'https://github.com/Youkamii/sharedesk-template/releases/latest/download/sharedesk-bootstrap.mjs' -o "$sharedesk_bootstrap"
node "$sharedesk_bootstrap" --apply
rm -f "$sharedesk_bootstrap"
```

スクリプトはリリースのファイルハッシュを確認したうえで、アプリのコードとアップデート用のファイルをローカルの作業フォルダに適用します。`.env.local`、`.vercel`、`.git`と、ShareDeskが管理していないファイルには手を触れません。既存のコードが公式の0.1.0と異なる場合は、勝手に上書きせず、衝突したパスを表示します。

適用したあとは次を実行します。

```powershell
npm ci
npm test
npm run lint
npx tsc --noEmit --incremental false
npm run build
git status --short
```

変更内容を確認し、インストールリポジトリの`main`にコミット・pushします。Vercelのデプロイが終わったら、本番アドレスで管理者ログインとファイル一覧を確認します。以降のバージョンからは、画面の`アップデート`ボタンを使います。

## AIに既存インストールのアップデートを任せる

コーディングAIでインストールリポジトリを開いたあと、下の依頼文をそのまま送ることができます。

```text
このShareDeskのインストールを最新の安定版にアップデートしてほしい。

まずdocs/UPDATE.ja.mdを読み、現在のリポジトリ・ブランチ・git status・origin・Vercelの接続を確認せよ。既存のアップデートworkflowがあれば画面のボタンと同じGitHub Actionsの流れを使い、なければdocs/UPDATE.ja.mdの1回限りのbootstrapを使え。

.env.local、OAuthの値、Drive IDとDrive内のファイル・ユーザー・招待・メモは変更も出力もするな。公式のコードと異なるファイルがあり、updaterが衝突を報告した場合は、上書きせずにパスと選択肢を説明したうえで止まれ。

変更が必要な場合は、まずこのインストールリポジトリにアップデート用のGitHub Issueを作り、npm test、npm run lint、npx tsc --noEmit --incremental false、npm run buildがすべて通ったあとに、そのIssue番号を入れて1つのコミットにまとめよ。許可されたインストールリポジトリだけにpushし、接続されたVercelのProductionデプロイと本番アドレスを確認せよ。自動チェックと実際の本番確認は区別して報告せよ。
```

## ローカル個人利用

Vercelを使わずローカルだけで使うインストールでは、作業フォルダで次のコマンドを使って新しいバージョンの有無を確認できます。

```powershell
node scripts/sharedesk-update.mjs --check
```

実際に適用するときは、まずGitの作業フォルダに変更がないことを確認してから`node scripts/sharedesk-update.mjs --apply`を実行し、上のチェックコマンドをもう一度実行します。ローカルのファイルは`LOCAL_STORAGE_ROOT`にあるため、コードのアップデートとは別に、そのフォルダ全体をバックアップしてください。
