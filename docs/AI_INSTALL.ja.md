[English](./AI_INSTALL.md) · [한국어](./AI_INSTALL.ko.md) · **日本語** · [हिन्दी](./AI_INSTALL.hi.md) · [中文](./AI_INSTALL.zh.md)

# AIにShareDeskの構築を任せる

Google CloudやVercelに慣れていない場合は、コーディングAIに構築を任せることができます。AIがリポジトリとターミナルを確認し、ユーザーがご自身で操作する必要がある画面だけを1手順ずつ案内するように作った文書です。

このガイドは、**自分のGoogle Driveの保存領域を、複数の人がそれぞれのGoogleアカウントで一緒に使うShareDeskを新しく立ち上げるホスト**のためのものです。すでに作られたShareDeskに招待された参加者は、インストールを行いません。

## 使い方

1. リポジトリとターミナルを扱えるコーディングAIで、自分のShareDeskリポジトリを開きます。
2. 下の依頼文をそのまま送ります。
3. Google CloudやVercelの画面でユーザーがご自身で行う作業が出てきたら、AIが案内する1手順だけを処理して`完了`と答えます。
4. Client secret、refresh token、callback URLのような秘密の値は、チャットに貼りません。AIが示したローカルのファイルやサービスの画面に、ユーザーがご自身で入力します。

## そのままコピーする依頼文

```text
このリポジトリにShareDeskの本番環境を構築してほしい。

目標は、ホスト1人のGoogle Driveの保存領域を、複数の人がそれぞれのGoogleアカウントで一緒に使うShareDeskを作ることだ。招待された人は、GitHub、Vercel、Google OAuthを設定せずに、本番アドレスでログインしたあと招待コードを入力するだけで済むようにすること。

作業の原則:
1. まずこのリポジトリのdocs/AI_INSTALL.ja.mdとdocs/INSTALL.ja.mdを最初から最後まで読み、docs/INSTALL.ja.mdをインストール手順の基準とせよ。
2. 作業の前に現在の状態を確認せよ。現在のリポジトリ・ブランチ・git status・origin、接続されたGitHubリポジトリとVercelプロジェクト、固定のProductionアドレス、.env.localの必要な項目が埋まっているか、既存のOAuth・Driveの接続の痕跡を、値を露出させずに確認せよ。
3. すでに終わっている手順を繰り返すな。既存のリポジトリとVercelプロジェクトを作り直さず、既存のOAuthクライアント、Audienceの状態、refresh token、Drive IDを推測で変更したり破棄したりするな。
4. ユーザーがGoogle CloudやVercelの画面でご自身で行う作業が出てきたら、一度に1手順だけ説明して止まれ。ユーザーが完了したと答えたら、結果を確認したうえで次の1手順に進め。
5. Client secret、SESSION_SECRET、refresh token、callback URL、招待コードのような秘密の値を、チャット・Issue・コミット・スクリーンショットで要求したり出力したりするな。ユーザーが.env.local、ローカルのターミナル入力、Google Cloud、Vercelの画面に直接入れるよう案内せよ。callback URLは、npm run setup -- --finishが尋ねるローカルのターミナルにだけ、ユーザーが自分で貼り付けるようにせよ。
6. リポジトリのファイルを変更する必要があるなら、異なる機能や修正ごとにGitHub Issueを先に作り、検証したあとに該当のファイルだけを個別にコミットしてIssue番号を残せ。.env.localと秘密の値は絶対にコミットするな。追跡対象ファイルの変更がないなら、空のIssueや空のコミットを作るな。
7. この依頼は、いま作業中の自分のShareDeskリポジトリへの必要な変更、機能ごとのGitHub Issueとローカルコミット、現在の作業ブランチのpush、接続された自分のVercelプロジェクトのProductionデプロイを許可する。作業の前に実際の対象リポジトリ・ブランチ・Vercelプロジェクト・Productionアドレスを確認し、元のテンプレートや他人のリポジトリ・プロジェクトには触れるな。
8. 自動チェックの通過と実際の本番確認を区別せよ。確認していない内容を完了したと報告するな。リポジトリを変更したなら、チェックと機能ごとのコミットを終えたあとにだけpush・デプロイせよ。

進め方:
1. 現在の状態を表にまとめ、完了・未完了・要確認に分けよ。
2. 自分のGitHubリポジトリとVercelプロジェクトがないときだけ作成または接続し、変わることのないProductionアドレスを記録せよ。
3. Google Cloudで、同じプロジェクトのDrive API、Branding、Audience、Data Access、Web applicationのOAuthクライアントを確認せよ。docs/INSTALL.ja.mdのredirect URI 3つとscope 4つが正確に合っているか確認させよ。
4. リポジトリでnpm ciを実行し、.env.localを安全に準備せよ。Google Client IDとClient secretは、ユーザーがファイルに直接入れるようにせよ。
5. npm run setupを実行してホストのGoogleの同意を始めよ。同意のあとのcallback URLは、ユーザーがnpm run setup -- --finishの質問に自分で貼り付けるようにし、AIはその値を読んだり再出力したりするな。
6. setupが作ったADMIN_EMAILS、SESSION_SECRET、STORAGE_DRIVER=drive、GOOGLE_REFRESH_TOKEN、DRIVE_ROOT_FOLDER_ID、DRIVE_STATE_FOLDER_IDが存在するかだけを、値を露出させずに確認せよ。
7. npm run devでローカルでのホストログイン、フォルダの作成、再読み込み後も残ること、ごみ箱からの復元、/adminへのアクセスを確認せよ。
8. npm test、npm run lint、npx tsc --noEmit --incremental false、npm run buildを実行し、結果を記録せよ。変更があるなら、機能ごとのコミットを終えたあとに、許可された現在のブランチだけをpushせよ。
9. 必要な値をVercelのProduction環境変数に移し、Productionを再デプロイせよ。PUBLIC_BASE_URLは固定のProduction originに合わせ、LOCAL_STORAGE_ROOTとSHAREDESK_SHARE_TEST_EMAILは本番環境に入れるな。
10. 本番アドレスで、ホストのログイン、ファイルの保存、再読み込み、ごみ箱からの復元、/adminと招待コードの作成を実際に確認せよ。
11. 別のGoogleアカウントを1人招待し、自分のアカウントでログインしてコードを入力してもらえ。ホストと参加者の2つのアカウントで同じファイルが見えてダウンロードできるかを、実際に確認せよ。この確認の前に、共同利用の検証が完了したと言うな。
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

## AIが必ず止まるべき場面

次の値と画面は、ユーザーがご自身で扱う必要があります。AIは1手順だけ案内したあと待ちます。

| 場面 | ユーザーがご自身で行うこと | AIが確認する結果 |
|---|---|---|
| Google CloudのOAuth設定 | Drive API、Audience、scope、redirect URIを画面で確認・保存 | 設定項目とアドレスが[本番インストールガイド](./INSTALL.ja.md)と一致しているか |
| Client IDとsecretの入力 | ローカルの`.env.local`に直接入力 | 値は出力せず、2つの項目が空でないかだけを確認 |
| ホストのGoogleの同意 | ブラウザでホストのアカウントを選んで同意 | setupが次の手順に進むか |
| callback URLの入力 | `npm run setup -- --finish`が尋ねるローカルのターミナルに直接貼り付け | setupが成功したかだけを確認 |
| Vercelの秘密の値の入力 | VercelのProduction環境変数の画面に直接入力 | 必要な変数の名前とデプロイへの反映 |
| 参加者アカウントの確認 | 別のGoogleアカウントでログインして招待コードを入力 | 2つのアカウントで同じファイルが見えてダウンロードできるか |

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
