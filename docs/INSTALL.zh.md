[English](./INSTALL.md) · [한국어](./INSTALL.ko.md) · [日本語](./INSTALL.ja.md) · [हिन्दी](./INSTALL.hi.md) · **中文**

# ShareDesk 生产环境安装指南

这份文档帮你开设一个 ShareDesk，让多个人各自用自己的 Google 账号，共用一位站长的 Google Drive 存储空间。

如果你不熟悉 Google Cloud 或 Vercel 的设置，不必自己把每一步都做完。把[让 AI 帮你搭建](./AI_INSTALL.zh.md)里的请求文发给编程 AI，AI 会先确认已经完成的步骤，只在需要你亲自操作的界面上一步一步地引导你。

## 首先，我是哪一方？

### 参与者

如果你是被邀请加入别人建好的 ShareDesk，**请不要按这份文档安装。** 只要在站长发来的 ShareDesk 地址上用自己的 Google 账号登录，并输入邀请码就可以了。你不需要 GitHub 账号、Vercel 项目或 Google OAuth 客户端。

### 站长

如果你想拿出自己的 Google Drive 容量，建立一个新的 ShareDesk 地址并邀请其他人，请按下面的步骤操作。安装只由站长做一次，参与者共用这个地址和存储空间。

每一个安装都会分别连接站长自己的 Git 仓库、Vercel 项目、Google OAuth 客户端和 Drive 根目录。这种分离结构说明的是站长对安装的所有权；而 ShareDesk 最核心的使用价值，是多个人共用同一个 Drive 存储空间。如果你已经建好了这些配置，请不要重新创建，直接沿用即可。

## 站长的快速路径

1. **创建 ShareDesk 地址：** 用 [Deploy with Vercel](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FYoukamii%2Fsharedesk-template&project-name=my-sharedesk&repository-name=my-sharedesk) 创建你自己的 GitHub 仓库和 Vercel 项目，并记下 Production 地址。
2. **建立 Google 连接：** 在 Google Cloud 中启用 Drive API，并创建 Web application 类型的 OAuth 客户端。准确的权限范围和 callback 地址请从[第 2 步](#2-google-cloud-设置)复制。
3. **连接站长的 Drive：** 取回仓库后运行 `npm ci` 和 `npm run setup`。如果没有 `.env.local`，setup 会自动创建。填入 Client ID 和 secret 后再运行一次，认证页面就会自动在浏览器中打开。同意授权后用 `npm run setup:finish` 收尾。
4. **接入生产环境：** 把 setup 填好的必需值转移到 Vercel Production 环境变量中，然后重新部署。
5. **和一个人一起确认：** 先确认生产环境的登录和文件保存，再在 `/admin` 中创建邀请码。邀请一个人进来，确认两个账号能看到同一个文件，核心安装就完成了。Vercel Firewall 在之后的生产防护阶段再设置。

ShareDesk 不会自动应用新版本。安装之后，任务栏上的 `更新` 按钮（只有管理员能看到）只在有新版本时才显示星标。把已有安装本首次接上更新的方法，写在[更新指南](./UPDATE.zh.md)里。

下面是每个步骤的详细说明。你也可以只看 Google Cloud 界面或出错的那一部分。

## 安装完成的判定标准

下面这些项目全部确认无误，生产环境安装才算完成。

- 你自己的 Git 仓库和你自己的 Vercel 项目已经连接。
- 有一个不会变化的 Production 地址。
- 生产环境的 callback 已经准确登记在 Google OAuth 客户端中。
- Vercel Production 环境中已填入生产所需的必需值。
- 在生产地址上可以用站长的 Google 账号登录。
- 在 `/files` 中创建的文件夹刷新之后依然存在。
- 界面右下角能看到与任务栏分开放置的 `回收站` 图标，点击图标可以恢复已删除的项目。
- `/admin` 能打开，并且可以选择邀请码的有效期和使用方式。
- 已经有一个人用邀请码、以自己的 Google 账号加入。
- 站长和参与者两个账号都能看到并下载同一个文件。

## 准备条件

- [Node.js](https://nodejs.org/) 20.9 或更高版本
- Git
- GitHub 账号
- Vercel 账号
- Google 账号，以及创建 Google Cloud 项目的权限

### 确认当前连接的是哪个账号

如果电脑上已经登录了其他 GitHub、Vercel 账号，仓库和项目就会被创建到错误的账号下。开始之前先确认。

```powershell
gh auth status
vercel whoami
git config --global user.email
```

如果显示的是别的账号，按下面的顺序重新登录。

1. 先 `gh auth logout`，再用 `gh auth login` 登录要使用的 GitHub 账号。
2. 先 `vercel logout`，再用 `vercel login` 登录要使用的 Vercel 账号。
3. 用 `git config --global user.email "要使用的邮箱"` 对齐提交邮箱。

## 1. 准备仓库和固定的生产地址

如果当前仓库的 `origin` 已经是你自己的仓库，并且已经连上了 Vercel 项目，就不要重复这一步。先用 `git remote -v` 和 Vercel 项目设置确认，然后继续使用现有项目。

如果还没有仓库和 Vercel 项目，请用下面的按钮把两者一起创建出来。

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FYoukamii%2Fsharedesk-template&project-name=my-sharedesk&repository-name=my-sharedesk)

如果想先只创建仓库、暂时不用 Vercel，请使用 [Use this template](https://github.com/Youkamii/sharedesk-template/generate)。

### 新账号点不动 Create 按钮时

第一次使用 Vercel 的账号，`Git Scope` 是空的，所以 `Create` 按钮处于不可用状态。点开 `Select Git Scope` 下拉框 → 点击 `Add GitHub Account` 安装 GitHub 应用（选择 `All repositories`），`Create` 就会变为可用。这个过程中 GitHub 会以弹窗形式打开，请同时检查浏览器的弹窗拦截设置。

第一次部署时环境变量为空也没关系。看到的不是登录按钮而是安装指引，这是正常的。在这一步请记下下面两个地址。

- 你自己的 Git 仓库：例如 `https://github.com/my-account/my-sharedesk`
- 固定的 Production 地址：例如 `https://my-sharedesk.vercel.app`

要使用一直绑定在项目上的 Production 地址，而不是每次提交都会变的 Preview 地址或很长的部署地址。

如果项目名称已经被别人先用了，地址上可能会带上 `-theta` 之类的后缀。你的固定地址请在 Vercel 项目的 `Domains` 标签页里，确认那个以 `.vercel.app` 结尾的地址。中间带哈希的长部署地址不要使用。

## 2. Google Cloud 设置

### 2-1. 项目与 Drive API

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)。
2. 选择要使用的项目，或者新建一个项目。
3. 在 `API 和服务` → `库` 中启用 `Google Drive API`。

请把 OAuth 客户端和 Drive API 放在同一个 Cloud 项目里。

### 2-2. Branding

在 `Google Auth Platform` → `Branding` 中填写下面的内容。

- 应用名称：例如 `我们团队的 ShareDesk`
- 用户支持邮箱
- 开发者联系邮箱

根据 Google Cloud 的界面语言，这些名称可能会显示成翻译后的 `品牌塑造`、`目标对象`、`数据访问`、`客户端`。

### 2-3. Audience

在 `Google Auth Platform` → `Audience` 中确定使用对象。

- 想邀请个人 Google 账号或组织外的人，选 `External`
- 只在一个 Google Workspace 组织内部使用时，可以按组织策略选 `Internal`

用于生产的 External 应用，请在执行 setup 之前点击 `Publish app`，切换到 `In production`。如果已经是 `In production`，保持原样即可。

在 `Testing` 状态下也能安装，但 ShareDesk 的站长连接会同时申请 `drive.file` 和离线访问权限。在这个状态下拿到的 refresh token 通常 7 天后就会过期。如果你已经在 Testing 状态下做过 setup，请先切换到 In production，然后重新进行站长连接。对于已经是 In production 的应用，不要在没有依据的情况下作废正常的令牌。

`In production` 是一种与测试令牌过期策略相区分的发布状态。它并不等同于应用审核已完成；根据 Branding 的内容和用户数量，Google 仍可能显示警告或要求额外的验证流程。

各状态的详细说明请参考 [Google OAuth Audience 指南](https://support.google.com/cloud/answer/15549945?hl=zh-CN)。

### 2-4. Data Access

在 `Google Auth Platform` → `Data Access` → `Add or remove scopes` 中添加下面四个权限范围。

```text
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
https://www.googleapis.com/auth/drive.file
```

### 2-5. Web application 类型的 OAuth 客户端

先在 `Google Auth Platform` → `Clients` 中查看已有的 Web application 客户端。如果有可以复用的客户端，就不要新建，只补上缺少的地址。

如果要新建，请按下面的方式设置。

1. Application type：`Web application`
2. 名称：例如 `ShareDesk web`
3. `Authorized JavaScript origins`：留空
4. `Authorized redirect URIs`：登记下面三个地址

```text
http://127.0.0.1:53682/callback
http://localhost:3000/api/auth/google/callback
https://my-sharedesk.vercel.app/api/auth/google/callback
```

请把最后一个地址的域名换成第 1 步中拿到的真实 Production 域名。

不要把生产环境的 callback 填进 `Authorized JavaScript origins`。JavaScript origin 里不能写路径，而且 ShareDesk 不使用这一栏。三个地址全部填进 `Authorized redirect URIs`。

重定向地址必须在 `http`/`https`、主机、端口、路径乃至结尾的斜杠上完全一致。Google 的 [OAuth 网页服务器指南](https://developers.google.com/identity/protocols/oauth2/web-server#uri-validation)也要求完全匹配。

创建客户端后，请把 Client ID 和 Client secret 安全地记录下来，下一步会用到。不要粘贴到公开仓库、聊天、issue 或截图里。

## 3. 准备本地环境文件

如果当前仓库已经在本地打开，就不要重新 clone，直接从那个文件夹开始。

如果还没有取回，请 clone 第 1 步中创建的你自己的仓库。

```powershell
git clone https://github.com/<我的GitHub账号>/my-sharedesk.git
cd my-sharedesk
```

安装依赖，并运行一次 setup。

```powershell
npm ci
npm run setup
```

如果没有 `.env.local`，不带参数的 `npm run setup` 会以仅所有者可访问的权限自动创建这个文件，并写入 `.env.example` 的内容。看到提示说 Client ID 和 secret 为空，这是正常的。如果已经有 `.env.local`，setup 不会覆盖内容，只检查权限。

如果只想先准备好环境文件、暂时不开始 setup，也可以使用保持兼容的旧命令 `npm run setup -- --prepare-env`。

请在 `.env.local` 中亲自填入下面两个值。

```dotenv
GOOGLE_CLIENT_ID=你拿到的-client-id
GOOGLE_CLIENT_SECRET=你拿到的-client-secret
```

不要把这些值通过编程代理的聊天或命令行参数传出去。

## 4. 连接站长的 Drive

如果现有的 `.env.local` 中已经有有效的 `GOOGLE_REFRESH_TOKEN`、`DRIVE_ROOT_FOLDER_ID`、`DRIVE_STATE_FOLDER_ID`，并且确实能正常工作，就不需要重新运行 setup。只有在全新安装、或者需要重新签发连接时，才按下面的顺序进行。

### 4-1. 开始认证

```powershell
npm run setup
```

1. setup 会在默认浏览器中打开 Google 认证页面。如果没有自动打开，请手动打开终端里原样输出的那个 URL。
2. 用要作为 ShareDesk 站长的 Google 账号登录并同意授权。
3. 浏览器会跳转到 `http://127.0.0.1:53682/callback?...`。
4. 浏览器显示连接失败也是正常的。请复制地址栏里的完整地址。

callback URL 中包含短时间内有效的一次性认证码。只能粘贴到同一台电脑的终端里，不要通过聊天、issue 或截图分享出去。

### 4-2. 完成认证

```powershell
npm run setup:finish
```

出现提问时，把刚才复制的完整 callback URL 粘贴进去。因为不会把 URL 写成命令参数，所以认证码不会留在 shell 历史记录里。

如果你正在和编程代理一起操作，这一步的输入由你本人完成。代理不要在聊天中索要 callback URL，也不要从终端输出中再次读取，只需等到输入结束为止。

setup 结束后，`.env.local` 中会准备好下面这些值。

- `ADMIN_EMAILS`
- `SESSION_SECRET`
- `CRON_SECRET`
- `STORAGE_DRIVER=drive`
- `GOOGLE_REFRESH_TOKEN`
- `DRIVE_ROOT_FOLDER_ID`
- `DRIVE_STATE_FOLDER_ID`

同时还会在站长的 Drive 中创建 `ShareDesk` 根目录和 `.sharedesk` 状态文件夹。已有的状态文件不会被擅自覆盖。

## 5. 本地确认

```powershell
npm run dev
```

1. 打开 `http://localhost:3000`。
2. 用站长的 Google 账号登录。
3. 在 `/files` 中创建一个文件夹，确认刷新之后依然存在。
4. 确认 `/admin` 能打开。

到这里为止只是本地确认，还不等于面向其他人的生产部署已经完成。

## 6. Vercel Production 环境变量与重新部署

打开第 1 步中创建的那个 Vercel 项目。在 `Settings` → `Environment Variables` 中，把下面的值填入 Production 环境。在最近的新版界面中，需要进入 `Settings` → `Environments` → 点击 `Production` 打开的详情页面里，才有环境变量的填写栏。

| 名称 | 值 |
|---|---|
| `ADMIN_EMAILS` | 管理员的 Google 邮箱。多个人时用逗号分隔 |
| `SESSION_SECRET` | setup 生成的长随机值 |
| `CRON_SECRET` | setup 生成的过期文件清理随机值 |
| `STORAGE_DRIVER` | `drive` |
| `GOOGLE_CLIENT_ID` | Web application 的 Client ID |
| `GOOGLE_CLIENT_SECRET` | Client secret |
| `GOOGLE_REFRESH_TOKEN` | setup 拿到的站长 refresh token |
| `DRIVE_ROOT_FOLDER_ID` | setup 创建的 ShareDesk 文件夹 ID |
| `DRIVE_STATE_FOLDER_ID` | setup 创建的状态文件夹 ID |
| `PUBLIC_BASE_URL` | 固定的 Production origin。例如：`https://my-sharedesk.vercel.app` |
| `SHAREDESK_DEFAULT_LOCALE` | （可选）桌面默认语言（en/ko/ja/hi/zh），即安装时在 setup 中选择的值 — 直接复制 `.env.local` 中的值 |
| `SHAREDESK_GITHUB_TOKEN` | （可选）用于一键更新的 fine-grained PAT — 参见[更新指南](./UPDATE.zh.md) |

为了减少安装失误，请在 Vercel Production 中明确写上 `PUBLIC_BASE_URL=https://你的真实生产域名`。这个值不要放进本地的 `.env.local`，因为本地应用的登录需要回到 `http://localhost:3000`。

如果省略了 `PUBLIC_BASE_URL`，ShareDesk 会改用 `VERCEL_PROJECT_PRODUCTION_URL`。采用这种方式时，请确认 Vercel 项目中已经开启了系统环境变量的暴露选项。

`PUBLIC_BASE_URL` 中只填 origin。不要加路径、结尾斜杠、callback 路径或 Preview URL。

`ACCESS_KEYS` 只在要使用临时访客密钥时才填。在 drive 模式下，用访问密钥进入的访客是 `仅查看`。`LOCAL_STORAGE_ROOT` 和 `SHAREDESK_SHARE_TEST_EMAIL` 不要放进生产环境。任何机密值都不要加 `NEXT_PUBLIC_` 前缀。

一次粘贴多个值时，存在 Key 栏把第一行（`ADMIN_EMAILS`）整个吞进去的陷阱。粘贴之后请务必确认变量是不是 10 个（不含可选项）。值默认以 `Sensitive` 保存，保存之后无法再次查看，这是正常的。

填写或修改环境变量之后，请重新部署 Production。环境变量的改动不会自动反映到已有的部署。在 `Deployments` 标签页中，把鼠标悬停在最新的部署行上，点击出现的 `⋯` 菜单 → `Redeploy`。`Create Deployment` 按钮只用于 Preview 部署，不要使用。详细行为请参考 [Vercel 环境变量指南](https://vercel.com/docs/environment-variables)。

## 7. 生产环境确认

请在固定的 Production 地址上亲自确认。

1. 用站长的 Google 账号登录。
2. 在 `/files` 中创建一个测试文件夹，确认刷新之后依然存在。
3. 删除测试文件夹后，点击界面右下角的 `回收站` 图标打开回收站窗口，把文件夹恢复回来。同时确认这个图标位于任务栏之外，并且在与打开的窗口重叠时会被挡到窗口后面。
4. 确认 `/admin` 能打开。
5. 在邀请码创建界面上，确认可以选择有效期 `1 小时`、`24 小时`、`7 天`、`30 天`，以及使用方式 `一次性`、`限期不限次`。还要确认可以为加入者选择初始角色 `可编辑`（默认）、`可上传`、`仅查看`。
6. 退出登录后重新登录，确认生产环境的 callback 正常。
7. 在 `/admin` 中创建一个邀请码，把生产地址和邀请码发给要一起使用的那个人。
8. 参与者用自己的 Google 账号登录后输入邀请码。参与者不需要 OAuth 客户端或 Vercel 项目。
9. 站长上传一个测试文件，确认站长和参与者两个账号都能看到并下载同一个文件。

在 Drive 模式下，移入回收站的项目只要没有被手动彻底删除，就会按照 [Google Drive 的 30 天回收站策略](https://support.google.com/drive/answer/14933051?hl=zh-CN)在 30 天后永久删除。在没有 OAuth 的 `local` 模式下，超过 30 天的项目会在下一次查看回收站时由 ShareDesk 永久删除。

被邀请的人不是要安装一个新的 ShareDesk，而是加入站长已经建好的共享文件空间。

## 8. 确认可用之后的生产防护

在上面第 7 步中确认了登录、文件保存以及实际邀请一个人之后，再为邀请码的提交请求加上防护。Firewall 设置不属于让 ShareDesk 跑起来的安装步骤，而属于生产防护步骤。

在 Vercel 项目的 Firewall 中创建下面的 Rate Limit 规则并 `Publish`。

如果已经有 Rate Limit 规则，请先确认它的条件和用途。不要覆盖别的规则，先确认能不能新增一条规则。

- 条件：`Request Path` equals `/api/invitations/code`
- 条件：`Method` equals `POST`
- 条件：Cookie `sharedesk_session` exists
- 动作：`Rate Limit`
- 方式：`Fixed Window`
- 依据：`IP`
- 限制：`60 秒` 内 `10 次`，超出时返回 `429`

三个条件都填上，限制才只作用于邀请码的提交。创建规则时，也请留意 Vercel 显示的用量和费用说明。设置界面可以参考 [Vercel WAF Rate Limiting 指南](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting)。

## 邀请与管理成员

1. 站长打开生产地址的 `/admin`。
2. 在 `1 小时`、`24 小时`、`7 天`、`30 天` 中选择邀请码的有效期。
3. 把使用方式选为 `一次性` 或 `限期不限次`。
4. 在 `可编辑`（默认）、`可上传`、`仅查看` 中选择加入者的初始角色。
5. 把创建好的邀请码和生产地址发给参与者。
6. 参与者用自己的 Google 账号登录后输入邀请码。加入的人会以邀请码上选定的角色开始使用。

邀请码不会预先绑定到特定邮箱。姓名和邮箱取自实际输入邀请码那个人的 Google 登录信息。

- **一次性：** 有一个人成功加入后就立即失效。
- **限期不限次：** 在过期或站长停用之前，可以供多人一起使用。

### 四级角色

| 角色 | 可以做的事 |
|---|---|
| 管理员 | 所有文件操作和用户管理。写在 `ADMIN_EMAILS` 中的账号，无论保存的角色是什么，始终是管理员。 |
| 可编辑 | 上传、下载、删除、移动、重命名，编辑记事本和文件夹备注，操作回收站，创建新记事本 |
| 可上传 | 上传、下载、新建文件夹、移动图标位置 |
| 仅查看 | 只能查看和下载 |

角色不是加入时定一次就固定不变的值。可以随时在 `/admin` 用户表的角色列中修改。

在管理界面上，可以封禁用户或把用户改回等待加入状态，也可以断开某台设备的登录，或者断开该用户的所有登录。如果改了 `ADMIN_EMAILS`，需要改完 Vercel 环境变量后重新部署。

## 安装之后的更新

ShareDesk 不会自动应用新版本。发现新版本时，会在管理员任务栏的 `更新` 上显示星标。点击按钮后，会先在 ShareDesk 内显示当前版本和最新版本。在 Vercel 中填好了 `SHAREDESK_GITHUB_TOKEN` 的安装，管理员点击 `立即更新` 就会在应用内直接开始更新并显示进度。没有令牌的安装，则会像以前一样打开 GitHub Actions 页面，点击 `Run workflow` 开始。无论哪一种，都只有在检查通过时才会提交到 `main`，再由关联的 Vercel 重新部署。

Drive 中的文件和共享状态、`.env.local`、Vercel 环境变量都不包含在代码更新里。更新功能出现之前建立的安装本，其一次性迁移和冲突处理请按 [ShareDesk 更新](./UPDATE.zh.md)进行。

## 直接通过 Google Drive 共享

管理员右键点击文件或文件夹，选择 **通过 Google Drive 共享**，就可以给已批准的用户 `查看` 或 `编辑` 权限。这个功能不是在 ShareDesk 内部隐藏或公开项目，而是真实的 Drive 权限，会出现在接收者 Google Drive 的 `与我共享` 中。

文件夹权限会按 Google Drive 的规则继承到下级项目。接收者 `与我共享` 中的显示情况，以及查看权限和编辑权限的差别，请用另一个 Google 账号亲自确认。自动检查的方法请参考[本地使用文档的真实 Drive 检查](./LOCAL.zh.md#真实-drive-检查)。

## 问题排查

| 症状 | 需要确认的内容 |
|---|---|
| `redirect_uri_mismatch` | 把错误里显示的 `redirect_uri` 和 Google Auth Platform 上同一个 Client ID 的 `Authorized redirect URIs` 逐字比对。注意不是 JavaScript origins。 |
| `无法访问此应用` | 确认 Audience 是不是 External。如果要保持 Testing，就必须把登录用的账号加入 Test user。 |
| `org_internal` | 这是用组织外的账号登录了 Internal 应用。请改成 External，或者使用组织内的账号。 |
| 同意授权后 `127.0.0.1` 连接失败 | 在 setup 阶段这是正常的。复制地址栏的完整地址，粘贴到 `npm run setup:finish` 的提问中。 |
| `未能获取 refresh_token` | 先确认已有的连接和 Audience 状态。只有在确实需要新令牌、并且因为已有连接而签发不出来时，才到 [Google 账号的已关联应用](https://myaccount.google.com/permissions)中移除权限，再重新执行 setup。 |
| 大约 7 天后 Drive 连接断开 | 先确认 Audience 之前是不是 Testing。如果是在 Testing 状态下拿到的站长令牌，请切换到 In production 后重新执行 setup。如果已经是 In production，不要先作废令牌，而要先查清实际的认证错误。 |
| Drive API 返回 403 | 确认创建 OAuth 客户端的那个 Cloud 项目里是否启用了 Google Drive API。同时确认 Workspace 的管理策略是否阻止了外部应用。 |
| 只有在 Vercel 上登录失败 | 确认 Production 环境变量、固定的生产 origin、Google 上的生产 redirect URI，以及改完环境变量后有没有重新部署。 |
| 邀请码被拒绝 | 在 `/admin` 中确认邀请码的到期日、启用状态和使用方式。`一次性` 邀请码可能已经在别人首次成功加入后失效了。 |
| 只有某些 Workspace 账号失败 | 确认组织管理员对第三方应用的访问限制，或者 Google 高级保护计划的策略。 |
| 管理员登录却被要求输入邀请码 | 确认登录邮箱是否与 `ADMIN_EMAILS` 完全一致；如果改过值，请重新部署。 |
| setup 因为存在多个同名状态文件而中断 | 到 Drive 的 `ShareDesk/.sharedesk/` 中查看对应的 JSON 文件，比较内容，只保留要留下的那一个，然后重新执行。 |

### 可以重新运行 setup 吗？

如果 `.env.local` 中已经有 `DRIVE_ROOT_FOLDER_ID` 和状态文件夹 ID，setup 会继续使用那个文件夹和已有的状态文件。如果关键状态文件出现多个同名副本，setup 不会擅自挑一个，而是会中断，所以你需要先在 Drive 中确认内容，只保留一个。

如果换过 Client secret，或者需要重新拿一次 refresh token，请先更新 `.env.local` 中的 Client ID 和 secret，再重新开始 setup。已经正常工作的连接，不要凭猜测作废。

## 存储结构与限制

- ShareDesk 的处理范围只在 setup 指定的 Drive 根文件夹内部。如果站长在 Drive 网页版把项目移到根目录之外，ShareDesk 就访问不到了。
- 在同一个文件夹里创建同名项目，或者改成同名，都会被拒绝。
- HTML、SVG 这类可以执行脚本的格式，不会在浏览器里直接查看，而是下载下来。
- Google 文档、表格、幻灯片、绘图会转换成 PDF 后预览。
- 免费的 Google Drive 容量和回收站保留期限，遵循站长账号的 Google 策略。

在 Drive 模式下，用户和邀请、当前在线人数、Drive 共享权限、文件夹备注和图标布局都保存在 `ShareDesk/.sharedesk/` 中。普通文件列表里会隐藏这个文件夹。如果同时修改同一份状态，会保留先保存的结果，较晚的请求以冲突结束，并重新读取最新状态。

想和编程 AI 一起安装，请使用 [AI 安装指南](./AI_INSTALL.zh.md)。开发和检查命令以及完整的环境变量表，另外整理在[本地个人使用](./LOCAL.zh.md#开发者参考)中。
