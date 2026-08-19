[English](./LOCAL.md) · [한국어](./LOCAL.ko.md) · [日本語](./LOCAL.ja.md) · [हिन्दी](./LOCAL.hi.md) · **中文**

# ShareDesk 本地个人使用

这是在不使用 Google OAuth 和 Vercel 的情况下，在自己电脑上使用 ShareDesk 界面和文件功能的方法。文件不保存在 Google Drive，而是保存在这台电脑的本地文件夹里。

这种方式适合个人使用和开发验证。如果要搭建多个人各自用自己的 Google 账号共同使用的生产环境，请按[生产环境安装指南](./INSTALL.zh.md)进行。觉得安装麻烦的话，可以使用[让 AI 帮你搭建](./AI_INSTALL.zh.md)。

把已经取回的本地安装本换成新版本的方法，另外整理在[更新指南](./UPDATE.zh.md#本地个人使用)里。

## 准备条件

- [Node.js](https://nodejs.org/) 20.9 或更高版本
- Git
- 能打开终端的 Windows、macOS 或 Linux 电脑

请先确认版本。

```powershell
node --version
npm --version
git --version
```

## 安装

如果已经在本地打开了这个仓库，就跳过 `git clone` 和 `cd`。

```powershell
git clone https://github.com/Youkamii/sharedesk-template.git
cd sharedesk-template
npm ci
npm run setup -- --prepare-env
```

最后一条命令会准备好 `.env.local`。如果这个文件已经存在，不会覆盖内容，只检查访问权限。

## 本地环境设置

在项目根目录的 `.env.local` 中填写下面四个值。

```dotenv
STORAGE_DRIVER=local
LOCAL_STORAGE_ROOT=.devstorage
SESSION_SECRET=只在本地使用的-十六位以上的长随机字符串
ACCESS_KEYS=我要输入的本地访问密钥
```

- `STORAGE_DRIVER=local` 表示用本地文件夹代替 Google Drive。
- `LOCAL_STORAGE_ROOT=.devstorage` 会把文件和状态保存到项目内的 `.devstorage` 文件夹。
- `SESSION_SECRET` 必须是 16 个字符以上，用于给登录 cookie 签名。
- `ACCESS_KEYS` 是在首屏输入的访问密钥。想用多个时，用逗号分隔。

需要随机字符串时，可以在本地终端运行下面的命令。输出的值不要发到聊天或 issue 里，请直接填进 `.env.local`。

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

在 local 模式下，`.env.local` 中与 Google 相关的值可以留空。`.env.local` 已被 Git 排除，不能上传到公开仓库。

## 运行

```powershell
npm run dev
```

在浏览器中打开 `http://localhost:3000`，输入你写在 `.env.local` 里的 `ACCESS_KEYS` 值之一。

local 模式的访问密钥会以 `可编辑` 权限进入，因此个人使用所需的创建文件和修改功能都可以照常使用。

在这个模式下，无法验证 Google 登录、用邀请码加入以及真实的 Drive 共享。

确认到下面这些项目，就说明本地运行成功了。

1. `/files` 桌面能打开。
2. 可以创建文件夹并上传文件。
3. 刷新之后文件夹和文件依然存在。
4. 可以把文件扔进回收站，并从界面右下角的 `回收站` 中恢复。
5. 可以创建和修改 `.txt` 文件与文件夹备注。

要关闭服务器，在运行中的终端里按 `Ctrl+C`。

想在自己电脑上验证生产构建，可以这样运行。

```powershell
npm run build
npm start
```

## 文件保存与备份

如果 `LOCAL_STORAGE_ROOT` 是相对路径，会以运行 ShareDesk 的项目文件夹为基准来计算。在默认设置下，实际文件和状态都在 `.devstorage/` 下面。

```text
.devstorage/
├── 我创建的文件和文件夹
└── .sharedesk/
    ├── 用户、邀请、在线状态
    ├── 文件夹备注和图标布局
    └── 回收站和本地共享状态
```

`.sharedesk` 是 ShareDesk 内部使用的文件夹，不会出现在文件界面上。只挑一部分出来备份，可能会丢掉备注、图标位置、回收站这些状态，所以请**备份整个 `LOCAL_STORAGE_ROOT`**。

备份步骤如下。

1. 用 `Ctrl+C` 关闭正在运行的服务器。
2. 把 `.devstorage`，或者你自己指定的 `LOCAL_STORAGE_ROOT` 文件夹整个复制到另一个磁盘或备份文件夹。
3. 如果需要保持相同的访问密钥和登录签名，也请把 `.env.local` 保存到另一个不会公开的位置。

在 Windows PowerShell 中，把目标路径改成适合你环境的路径后，可以这样复制。

```powershell
New-Item -ItemType Directory -Force -Path 'D:\ShareDesk-Backup'
Copy-Item -Recurse -Force -LiteralPath '.devstorage' -Destination 'D:\ShareDesk-Backup\devstorage'
```

恢复时同样先关闭服务器，用备份的整个文件夹替换原来的 `LOCAL_STORAGE_ROOT`，然后重新运行。在服务器正在写文件的时候复制的备份，各部分状态的时间点可能对不上。

## local 模式下的不同之处

- 不使用 Google 登录和邀请码加入，通过 `ACCESS_KEYS` 进入。
- 文件占用的不是 Google Drive 容量，而是运行 ShareDesk 那台电脑的磁盘。
- **通过 Google Drive 共享** 这个操作不会创建真实的 Google 权限。它在 local 模式下只是用来查看状态的动作。
- Google 文档、表格、幻灯片、绘图的 PDF 转换预览无法使用。
- HTML 和 SVG 这类可以执行脚本的格式不会直接打开，而是以安全下载的方式提供。
- 在同一个文件夹里创建同名项目或改成同名时，不会覆盖，而是直接拒绝。
- 回收站中的项目超过 30 天后，会在下一次查看回收站时被彻底删除。
- `LOCAL_STORAGE_ROOT` 之外的路径和内部的 `.sharedesk` 文件夹，无法在文件界面中打开。
- 不要在 Vercel 的生产部署中使用 local 模式。多人共同使用的生产环境要用 `STORAGE_DRIVER=drive` 来搭建。

## 问题排查

| 症状 | 需要确认的内容 |
|---|---|
| `npm ci` 拒绝当前的 Node 版本 | 确认 `node --version` 是否在 20.9 以上，并升级 Node.js。 |
| `SESSION_SECRET 缺失或过短` | 把 `.env.local` 中的 `SESSION_SECRET` 改成 16 个字符以上的字符串，然后重启服务器。 |
| 访问密钥被拒绝 | 确认 `.env.local` 中 `ACCESS_KEYS` 的拼写和逗号分隔，然后重启服务器。 |
| 文件不在预期的文件夹里 | 确认是否在仓库根目录运行了服务器，以及 `LOCAL_STORAGE_ROOT` 的值。相对路径以当前项目文件夹为基准。 |
| `.env.local` 的改动没有生效 | 关掉正在运行的开发服务器，重新执行 `npm run dev`。 |
| 提示 3000 端口已被占用 | 关掉先前启动的 ShareDesk 开发服务器或其他程序，然后重新运行。 |
| 删掉 `.devstorage` 之后文件消失 | 这是 local 模式的实际存储文件夹。请关闭服务器，把完整备份恢复到同一位置。 |
| `STORAGE_DRIVER 的值不正确` | 值只允许小写的 `local` 或 `drive`。个人本地使用请改成 `local`。 |

## 开发者参考

### npm 命令

| 命令 | 用途 |
|---|---|
| `npm run dev` | 运行 Next.js 开发服务器。 |
| `npm run build` | 确认能否生成生产构建。 |
| `npm start` | 运行由 `npm run build` 生成的生产构建。 |
| `npm run lint` | 运行 ESLint 检查。 |
| `npm test` | 运行仓库中的自动化测试。 |
| `npm run setup -- --prepare-env` | 准备 `.env.local`。不会覆盖已有内容。 |
| `npm run setup` | 开始站长的 Google 认证。没有 `.env.local` 时会先准备好这个文件。 |
| `npm run setup:finish` | 由用户在本地终端粘贴 callback URL，完成站长 Drive 的连接。不会把 URL 作为命令参数。 |
| `npm run setup -- --check` | 确认能否读取 Client ID 和 secret 并生成认证 URL。 |
| `npm run test:drive-operations` | 在真实 Drive 上检查创建、上传、下载、重命名、移动、删除和恢复。 |
| `npm run test:drive-preview` | 在真实 Drive 上检查 Google 文档的 PDF 转换和视频的 Range 响应。 |
| `npm run test:drive-sharing` | 检查真实 Drive 上查看和编辑权限的创建、更改与收回。 |

只想单独检查 TypeScript 时，使用下面的命令。

```powershell
npx tsc --noEmit --incremental false
```

### 环境变量

| 变量 | 使用位置 | 说明 |
|---|---|---|
| `ADMIN_EMAILS` | Drive 生产 | 管理员的 Google 邮箱。多个人时用逗号分隔。setup 会填入站长的邮箱。 |
| `ACCESS_KEYS` | 可选，local 推荐 | 用逗号分隔的临时访客访问密钥。local 个人使用时用这个密钥以 `可编辑` 权限进入；在生产（drive）环境中用访问密钥进入的访客是 `仅查看`。 |
| `SESSION_SECRET` | 必需 | 给登录 cookie 签名的密钥，必须是 16 个字符以上。 |
| `STORAGE_DRIVER` | 建议必填 | `local` 或 `drive`。留空时会根据有没有 refresh token 来判断，但明确写出来更安全。 |
| `LOCAL_STORAGE_ROOT` | 仅 local | 保存本地文件和状态的路径。默认值是 `.devstorage`。 |
| `PUBLIC_BASE_URL` | Drive 生产，视情况 | 自定义域名或固定生产地址的 origin。不要加路径和结尾斜杠。 |
| `GOOGLE_CLIENT_ID` | Drive 生产 | Web application 类型的 OAuth Client ID。 |
| `GOOGLE_CLIENT_SECRET` | Drive 生产 | OAuth Client secret。 |
| `GOOGLE_REFRESH_TOKEN` | Drive 生产 | setup 拿到的站长离线令牌。 |
| `DRIVE_ROOT_FOLDER_ID` | Drive 生产 | ShareDesk 要管理的站长 Drive 根目录 ID。 |
| `DRIVE_STATE_FOLDER_ID` | Drive 生产 | 根目录内 `.sharedesk` 状态文件夹的 ID。 |
| `SHAREDESK_DEFAULT_LOCALE` | 可选 | 桌面默认语言（en/ko/ja/hi/zh）。未设置时以英语开始。 |
| `SHAREDESK_GITHUB_TOKEN` | 可选 | 用于一键更新的 fine-grained PAT。想在本地测试一键更新，还要一并填上下面的 `SHAREDESK_GITHUB_REPOSITORY`。 |
| `SHAREDESK_GITHUB_REPOSITORY` | 可选 | 更新目标的安装仓库（`owner/repository`）。Vercel 之外（本地）没有仓库信息，所以做一键测试时要自己指定。 |
| `SHAREDESK_SHARE_TEST_EMAIL` | 仅真实检查用 | 用来接收共享检查的另一个已批准 Google 账号。不要放进生产 Vercel 环境。 |
| `SHAREDESK_TRACE` | 开发验证 | 不为空时，会把部分 Drive 调用和图标布局的保存耗时记录到服务器日志里。 |

使用 Vercel 默认域名并且把 `PUBLIC_BASE_URL` 留空时，应用会使用 Vercel 提供的 `VERCEL_PROJECT_PRODUCTION_URL`。这不是你自己填的值，而是 Vercel 的系统环境变量。生产环境需要的值和 callback 地址，整理在[生产环境安装指南](./INSTALL.zh.md)中。

### 真实 Drive 检查

下面三条命令不是 local 模式的检查。它们会使用 `.env.local` 中真实的 Google Drive 设置来创建测试文件或修改权限。请在与个人工作文件分开、可以放心验证的 ShareDesk 根目录下运行。

检查基本的文件操作。

```powershell
npm run test:drive-operations
```

这项检查会确认文件夹创建、服务器上传、完整下载、重命名、跨文件夹移动、浏览器直传，以及回收站的删除、恢复和彻底删除，并清理它自己创建的项目。如果清理失败，请到 Drive 中直接查看 `sharedesk-operations-test-*` 文件夹。

检查预览功能。

```powershell
npm run test:drive-preview
```

这项检查会确认 Google 文档、表格、幻灯片、绘图能否以 PDF 形式下载，以及视频的分段请求是否以 HTTP 206 返回，然后清理检查用的 Drive 项目。

要检查共享权限，先用 ShareDesk 的邀请批准另一个 Google 账号，再把那个邮箱填进 `.env.local`。

```dotenv
SHAREDESK_SHARE_TEST_EMAIL=recipient@example.com
```

```powershell
npm run test:drive-sharing
```

共享检查会确认查看权限的创建、改为编辑权限、权限的收回，以及 ShareDesk 共享台账的同步情况，然后清理检查用的文件和权限。

即使自动检查通过了，接收者账号的 Google Drive `与我共享（Shared with me）` 中是否真的能看到项目、查看权限下修改是否被拒绝、编辑权限下是否被允许，仍然需要用另一个账号亲自确认。

### 状态保存与并发修改

Drive 模式保存在 `ShareDesk/.sharedesk/`，local 模式保存在 `LOCAL_STORAGE_ROOT/.sharedesk/`，其中存放用户和邀请、在线状态、Drive 共享台账、文件夹备注、图标布局和回收站状态。普通文件列表里会隐藏这个文件夹，也不允许直接打开。

对于状态文件和文件夹移动这类“最后看到的版本”很重要的改动，并发时会保留先保存的结果。较晚的请求以冲突结束，并重新读取最新状态。

### 当前的限制

- ShareDesk 的处理范围只在所设置的 Drive 或 local 根目录内部。
- 同一个文件夹里不允许出现同名。
- HTML 和 SVG 不会直接预览，而是下载。
- 只有 Google 文档、表格、幻灯片、绘图支持 PDF 转换预览。
- Drive 容量和 Drive 回收站的保留期限，遵循站长 Google 账号的策略。
- local 回收站会在下一次查看回收站时，彻底删除超过 30 天的项目。

改动之前请运行 `npm test`、`npm run lint`、`npx tsc --noEmit --incremental false`、`npm run build`。报告 bug 时，请写清复现步骤和浏览器、Node.js 版本，但不要附上 `.env.local`、OAuth callback URL、令牌和 Client secret。
