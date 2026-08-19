[English](./AI_INSTALL.md) · [한국어](./AI_INSTALL.ko.md) · **日本語** · [हिन्दी](./AI_INSTALL.hi.md) · [中文](./AI_INSTALL.zh.md)

# AIにShareDeskの構築を任せる

Google CloudやVercelに慣れていない場合は、コーディングAIに構築を任せることができます。AIがリポジトリとターミナルを確認し、ユーザーご自身が操作する必要がある画面だけを1ステップずつ案内するように作った文書です。

このガイドは、**自分のGoogle Driveの保存容量を、複数の人がそれぞれのGoogleアカウントで一緒に使うShareDeskを新しく立ち上げるホスト**のためのものです。すでに作られたShareDeskに招待された参加者は、インストールを行いません。

**AIへ:** ユーザーが長い依頼文なしでリポジトリのアドレスだけを渡した場合でも、この文書を読むことになったなら、下の依頼文にある作業の原則と進め方をそのまま守ってください。依頼文を受け取っていないという理由で、原則を省略しないでください。

## 使い方

1. リポジトリとターミナルを扱えるコーディングAIで、自分のShareDeskリポジトリを開きます。
2. 下の依頼文をそのまま送ります。
3. Google CloudやVercelの画面でユーザーご自身が行う作業が出てきたら、AIが案内する1ステップだけを処理して`完了`と答えます。
4. Client secret、refresh token、callback URLのような秘密の値は、チャットに貼りません。AIが示したローカルのファイルやサービスの画面に、ユーザーご自身が入力します。

## そのままコピーする依頼文

```text
このリポジトリにShareDeskの本番環境を構築してほしい。

目標は、ホスト1人のGoogle Driveの保存容量を、複数の人がそれぞれのGoogleアカウントで一緒に使うShareDeskを作ることだ。招待された人は、GitHub、Vercel、Google OAuthを設定せずに、本番アドレスでログインしたあと招待コードを入力するだけで済むようにすること。

作業の原則:
1. まずこのリポジトリのdocs/AI_INSTALL.ja.mdとdocs/INSTALL.ja.mdを最初から最後まで読み、docs/INSTALL.ja.mdをインストール手順の基準とせよ。
2. 作業の前に現在の状態を確認せよ。現在のリポジトリ・ブランチ・git status・origin、接続されたGitHubリポジトリとVercelプロジェクト、固定のProductionアドレス、.env.localの必要な項目が埋まっているか、既存のOAuth・Driveの接続の痕跡を、値を露出させずに確認せよ。
3. すでに終わっている手順を繰り返すな。既存のリポジトリとVercelプロジェクトを作り直さず、既存のOAuthクライアント、Audienceの状態、refresh token、Drive IDを推測で変更したり破棄したりするな。
4. ユーザーがGoogle CloudやVercelの画面で自分で行う作業が出てきたら、一度に1ステップだけ説明して止まれ。ユーザーが完了したと答えたら、結果を確認したうえで次の1ステップに進め。
5. Client secret、SESSION_SECRET、refresh token、callback URL、招待コードのような秘密の値を、チャット・Issue・コミット・スクリーンショットで要求したり出力したりするな。ユーザーが.env.local、ローカルのターミナル入力、Google Cloud、Vercelの画面に直接入れるよう案内せよ。callback URLは、npm run setup:finishが尋ねるローカルのターミナルにだけ、ユーザーが自分で貼り付けるようにせよ。
6. リポジトリのファイルを変更する必要があるなら、異なる機能や修正ごとにGitHub Issueを先に作り、検証したあとに該当のファイルだけを個別にコミットしてIssue番号を残せ。.env.localと秘密の値は絶対にコミットするな。追跡対象ファイルの変更がないなら、空のIssueや空のコミットを作るな。
7. この依頼は、いま作業中の自分のShareDeskリポジトリへの必要な変更、機能ごとのGitHub Issueとローカルコミット、現在の作業ブランチのpush、接続された自分のVercelプロジェクトのProductionデプロイを許可する。作業の前に実際の対象リポジトリ・ブランチ・Vercelプロジェクト・Productionアドレスを確認し、元のテンプレートや他人のリポジトリ・プロジェクトには触れるな。
8. 自動チェックの通過と実際の本番確認を区別せよ。確認していない内容を完了したと報告するな。リポジトリを変更したなら、チェックと機能ごとのコミットを終えたあとにだけpush・デプロイせよ。

進め方:
1. 現在の状態を表にまとめ、完了・未完了・要確認に分けよ。
2. 自分のGitHubリポジトリとVercelプロジェクトがないときだけ作成または接続し、変わることのないProductionアドレスを記録せよ。
3. Google Cloudで、同じプロジェクトのDrive API、Branding、Audience、Data Access、Web applicationのOAuthクライアントを確認せよ。docs/INSTALL.ja.mdのredirect URI 3つとscope 4つが正確に合っているか確認させよ。
4. リポジトリでnpm ciを実行し、.env.localを安全に準備せよ。Google Client IDとClient secretは、ユーザーがファイルに直接入れるようにせよ。
5. npm run setupを実行してホストのGoogleの同意を始めよ。同意のあとのcallback URLは、ユーザーがnpm run setup:finishの質問に自分で貼り付けるようにし、AIはその値を読んだり再出力したりするな。
6. setupが作ったADMIN_EMAILS、SESSION_SECRET、STORAGE_DRIVER=drive、GOOGLE_REFRESH_TOKEN、DRIVE_ROOT_FOLDER_ID、DRIVE_STATE_FOLDER_IDが存在するかだけを、値を露出させずに確認せよ。
7. npm run devでローカルでのホストログイン、フォルダの作成、再読み込み後も残ること、ごみ箱からの復元、/adminへのアクセスを確認せよ。
8. npm test、npm run lint、npx tsc --noEmit --incremental false、npm run buildを実行し、結果を記録せよ。変更があるなら、機能ごとのコミットを終えたあとに、許可された現在のブランチだけをpushせよ。
9. 必要な値をVercelのProduction環境変数に移し、Productionを再デプロイせよ。PUBLIC_BASE_URLは固定のProduction originに合わせ、LOCAL_STORAGE_ROOTとSHAREDESK_SHARE_TEST_EMAILは本番環境に入れるな。
10. 本番アドレスで、ホストのログイン、ファイルの保存、再読み込み、ごみ箱からの復元、/adminと招待コードの作成を実際に確認せよ。
11. 別のGoogleアカウントを1人招待し、その人自身のアカウントでログインしてコードを入力してもらえ。ホストと参加者の2つのアカウントで同じファイルが見えてダウンロードできるかを、実際に確認せよ。この確認の前に、共同利用の検証が完了したと言うな。
12. 中心となる機能がすべて動いたあとにだけ、docs/INSTALL.ja.mdのVercel Firewallのルールを追加し、429の動作を確認せよ。

完了報告は下の形式を使え。

状態: 完了 / 一部完了 / 行き詰まり
本番アドレス: <確認した固定のProductionアドレス>

確認済み:
- GitHubリポジトリとブランチ:
- Vercelプロジェクトと最新のProductionデプロイ:
- Google OAuthのcallbackとDriveの接続:
- ローカルでのログイン・ファイル保存・ごみ箱・管理画面:
- 本番でのログイン・ファイル保存・ごみ箱・管理画面:
- 2つのGoogleアカウントで同じファイルの表示・ダウンロード:
- 自動チェック:

機能ごとの変更:
- Issue #番号 -> コミットハッシュ -> 検証結果

まだ確認できていないこと:
- 実際に確認できなかった項目とその理由

ユーザーが次に行う1つの手順:
- 残っている作業があるときだけ1つ書く
```

上の依頼文には、**現在の作業ブランチのpushと自分のVercel Productionデプロイまで任せる文**が含まれています。デプロイまでは任せたくない場合は、送る前に作業の原則7番を次のように変えてください。

```text
現在のリポジトリの調査と、ローカルでの変更・機能ごとのIssue・ローカルコミットまでだけを許可する。私がチャットでpushまたはデプロイを別途許可するまでは、リモートへのpushとVercelのデプロイをするな。
```

## ステップ0: ツールの点検

AIはほかの作業より先に、下のツールがあるかを確認し、ないものだけをインストールします。

| ツール | 確認コマンド | ないときのインストール |
|---|---|---|
| Git | `git --version` | `winget install Git.Git` |
| GitHub CLI（任意） | `gh --version` | `winget install GitHub.cli` |
| Vercel CLI | `vercel --version` | `npm i -g vercel` |
| Node.js 20.9以上 | `node --version` | [nodejs.org](https://nodejs.org/)からインストール |

Windowsでは、インストールした直後の**同じシェルは新しいツールを見つけられません。** PATHはシェルの起動時に一度だけ読み込まれるからです。`spawn git ENOENT`のようなエラーが、まさにこの症状です。新しいウィンドウを開かず、同じシェルでPATHを組み直してから続けてください。

```powershell
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
```

## 元のテンプレートを直接cloneした場合

元のテンプレートリポジトリを直接cloneして始めた場合は、pushの前に必ず自分のGitHubリポジトリを新しく作り、`origin`を自分のリポジトリに差し替える必要があります。元のリポジトリを`origin`にしたままpushしてはいけません。

```powershell
git remote set-url origin https://github.com/<自分のGitHubアカウント>/my-sharedesk.git
```

## Google Cloudで迷いやすい画面

メニュー名は日本語の画面を基準に書き、括弧に英語を併記します。

- **まったく新しいGoogleアカウントの場合:** プロジェクトが0個のため、最初の画面がインストールガイドと違って見えます。上部の`プロジェクトを選択（Select a project）` → `新しいプロジェクト（New project）`から始めてください。`$300の無料トライアル`のバナーは、支払い情報を入れずに無視してもインストールに支障はありません。
- **新しいプロジェクトの認証設定:** `ブランディング（Branding）`・`対象（Audience）`のメニューの代わりに、`Google Auth Platformの開始（Get started）`という4画面のウィザード（アプリ情報 → 対象 → 連絡先情報 → 完了）が先に表示されます。ウィザードの`アプリ情報（App Information）`がBranding、`対象（Audience）`がAudienceに当たります。ウィザードを終えると、インストールガイドのメニューがそのまま現れます。
- **データアクセス（Data Access）の保存:** scope 4種を追加したあと、スコープの選択ウィンドウの`更新（Update）`と画面下部の`保存（Save）`を**それぞれ**押してはじめて保存されます。4種はすべて`機密性の低いスコープ（Non-sensitive scopes）`なので、アプリの審査手続きや100人のユーザー上限とは関係ありません。
- **クライアントの作成が失敗するとき:** OAuthクライアントの`作成（Create）`で`この操作は一時的に実行できません`と出たら、新しいプロジェクトの反映の遅延です。入力値を直さず、5〜10分後に同じ値でもう一度試してください。

## ホストのGoogleの同意画面で

同意画面のGoogle Drive権限の**チェックボックスは、デフォルトでオフになっています。** 必ずチェックしてから続行を押す必要があります。チェックしないまま受け取ったcallback URLの認証コードは無効なのでsetupが失敗し、同意を最初からやり直すことになります。

## setupを仕上げるコマンド

同意のあと、認証を仕上げる標準のコマンドは次のとおりです。

```powershell
npm run setup:finish
```

PowerShellでは、`npm run setup -- --finish`は`--finish`がnpmに吸収されて動かない落とし穴があります。`npm run setup:finish`を使ってください。

## Vercelの環境変数の入力（新しい画面）

- 場所: Vercelプロジェクトの`Settings` → `Environments` → `Production`を押して入った詳細画面の中に、環境変数の入力欄があります。
- 複数行を一度に貼り付けると、**Key欄が1行目（`ADMIN_EMAILS`）を丸ごと飲み込む落とし穴**があります。貼り付けたあと、変数の数が9個かを必ず数えてください。
- 値はデフォルトで`Sensitive`として保存され、保存後は二度と見られません。正常な動作なので、値が消えたと思ってもう一度入れないでください。

## 環境変数を保存したあとの再デプロイ

環境変数は、既存のデプロイには自動で反映されません。`Deployments`タブで最新のデプロイの行にマウスを載せると出てくる`⋯`メニュー → `Redeploy`を押してください。画面の`Create Deployment`ボタンはPreviewデプロイ専用なので、使ってはいけません。

## ダッシュボードで道に迷ったら: Vercel CLIの道

Vercelのダッシュボードが難しい場合は、下のCLIの道が公式の第一の代替手段です。

```powershell
vercel login
vercel link
vercel env add ADMIN_EMAILS production
# 残りの変数も同じ方法で: vercel env add <名前> production
vercel --prod
```

## デプロイが成功したかを見分ける

- 環境変数がまだない場合、本番アドレスには**インストールの案内画面**が表示されます。この状態でのデプロイの成功は正常です。
- 設定が終わっていれば、**Googleログインの画面**が表示されます。
- 実際のDriveの接続まで検査するには、ローカルで`npm run test:drive-operations`を実行します。

## Windowsで注意すること

- **PowerShell 5.1の`Set-Content`は、UTF-8で保存するときにBOMを付けます。** `.env.local`をこの方法で作ると、見えない文字がファイルの先頭に付いて最初の変数名（例: `ADMIN_EMAILS`）が汚染され、認識されなくなります。環境ファイルはsetupに作らせ、直すときはエディタで`UTF-8（BOMなし）`として保存してください。
- **会社のPCの文書セキュリティソフト（FasooなどのDRM）** が、リポジトリの中の`.txt`ファイルを勝手に暗号化してgitの状態を汚すことがあります。触っていない`.txt`ファイルが変更済みと表示され、diffが壊れた文字で出るなら、この症状です。DRMが適用されないフォルダや個人のPCでの作業をおすすめします。

## AIが必ず止まるべき場面

次の値と画面は、ユーザーご自身が扱う必要があります。AIは1ステップだけ案内したあと待ちます。

| 場面 | ユーザーご自身が行うこと | AIが確認する結果 |
|---|---|---|
| Google CloudのOAuth設定 | Drive API、Audience、scope、redirect URIを画面で確認・保存 | 設定項目とアドレスが[本番インストールガイド](./INSTALL.ja.md)と一致しているか |
| Client IDとsecretの入力 | ローカルの`.env.local`に直接入力 | 値は出力せず、2つの項目が空でないかだけを確認 |
| ホストのGoogleの同意 | ブラウザでホストのアカウントを選んで同意 | setupが次の手順に進むか |
| callback URLの入力 | `npm run setup:finish`が尋ねるローカルのターミナルに直接貼り付け | setupが成功したかだけを確認 |
| Vercelの秘密の値の入力 | VercelのProduction環境変数の画面に直接入力 | 必要な変数の名前とデプロイへの反映 |
| 参加者アカウントの確認 | 別のGoogleアカウントでログインして招待コードを入力 | 2つのアカウントで同じファイルが見えてダウンロードできるか |

実際のユーザーは、callback URLをついチャットに貼ってしまいがちです。そうなった場合、AIは受け取った値をすぐにsetupの入力に使って消費し、露出した認証コードは使い捨てのうえPKCEと組み合わされているため危険が低いことをユーザーに伝えつつ、安心のために再発行（同意からのやり直し）をすすめてください。その値をもう一度出力したり、記録に残したりはしないでください。

## インストールが終わったと言える基準

コードのチェックとデプロイの成功だけでは、終わったことになりません。次まで実際に確認する必要があります。

- 固定のProductionアドレスでホストのGoogleログインができます。
- フォルダとファイルが再読み込みのあとも残り、ごみ箱に入れた項目を復元できます。
- `/admin`で招待コードを作れます。
- 別のGoogleアカウントが招待コードで入れます。
- ホストと参加者の2つのアカウントで、同じファイルが見えてダウンロードできます。
- リポジトリの変更があるなら、機能ごとのIssueとコミットが互いに対応しており、許可された場合にだけpush・デプロイされています。

インストールの画面とエラーごとの詳しい説明は、[ShareDesk 本番インストールガイド](./INSTALL.ja.md)に従ってください。

すでに運用中のインストールを新しいバージョンに入れ替える場合は、新しく構築せず、[ShareDeskのアップデートガイド](./UPDATE.ja.md)のAI依頼文を使ってください。
