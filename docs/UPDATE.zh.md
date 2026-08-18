[English](./UPDATE.md) · [한국어](./UPDATE.ko.md) · [日本語](./UPDATE.ja.md) · [हिन्दी](./UPDATE.hi.md) · **中文**

# ShareDesk 更新

ShareDesk 应用新版本的方式是：更新安装时创建的**你自己的 GitHub 仓库**，再由与该仓库关联的 Vercel 重新部署。Google Drive 中的文件、用户、邀请、备注以及 Vercel 环境变量，都不在代码更新的范围内。

## 使用更新按钮

ShareDesk 不会自动应用新版本。以管理员身份登录后，它会检查一次最新稳定版本，只有在确实有新版本时，才会在任务栏的 `更新` 上显示星标。

只要完成过一次下面的[一键更新准备](#一键更新准备只需一次)，更新就会在 ShareDesk 内部完成，不必再跳转到 GitHub 页面。

1. 点击带星标的 `更新`，在 ShareDesk 内查看当前版本和最新稳定版本。没有星标时，也可以点击按钮自行检查。
2. 如果有新版本，点击内部界面上的 `立即更新`。
3. ShareDesk 会代你运行安装仓库的更新 workflow，并在同一个窗口显示进度。依次经过 `正在应用更新` → `正在部署新版本`，结束后显示 `更新已完成`；出现问题时显示 `更新失败`。这可能需要几分钟。
4. 所有检查都通过后，安装仓库的 `main` 上会产生一次更新提交，与仓库关联的 Vercel 会把新提交部署到 Production。
5. 显示 `更新已完成` 后，点击 `刷新` 即可应用新版本。

如果检查或构建失败，就不会提交到 `main`，因此当前的生产部署会原样保留。即使你在安装本里直接改过 ShareDesk 的代码文件，更新也不会覆盖，而是显示冲突的文件名后停止。显示失败时，可以通过 `查看详细日志` 查看 GitHub Actions 的记录。

### 一键更新准备（只需一次）

要在应用内直接更新，需要创建一次 GitHub 令牌并填入 Vercel，让 ShareDesk 能够运行你安装仓库的 workflow。这个令牌是最小权限令牌，只对你的那一个安装仓库拥有 Actions 权限。

1. 登录 GitHub 后，点击右上角的头像 → `Settings`。
2. 打开左侧菜单最下方的 `Developer settings` → `Personal access tokens` → `Fine-grained tokens`。
3. 点击 `Generate new token`。
4. 给令牌起一个方便辨认的名字。例如 `sharedesk-update`
5. 设置 `Expiration`（有效期）。过期后一键更新会停止，只剩下备用方式，所以请选一个较长的有效期，并记住到期时间；到期后按本步骤重新创建令牌。
6. 在 `Repository access` 中选择 `Only select repositories`，并且**只选你的那一个 ShareDesk 安装仓库**。
7. 在 `Permissions` → `Repository permissions` 中把 `Actions` 改为 `Read and write`。其他权限不要改动。
8. 点击 `Generate token`，复制生成的令牌值。离开这个页面后就再也看不到这个值了。
9. 在 Vercel 项目的 `Settings` → `Environment Variables` 中，为 `Production` 环境添加下面的值。

```dotenv
SHAREDESK_GITHUB_TOKEN=复制到的令牌值
```

10. 重新部署 Production。环境变量的改动不会自动反映到已有的部署。

令牌是机密值。不要粘贴到公开仓库、聊天、issue 或截图里。

### 不用令牌的备用方式

没有填写 `SHAREDESK_GITHUB_TOKEN` 的安装也可以更新。这种情况下点击 `立即更新`，会像以前一样打开 GitHub 页面。

1. 在打开的 GitHub Actions 页面点击 `Run workflow`。
2. 所有检查都通过后，安装仓库的 `main` 上会产生一次更新提交。
3. 与仓库关联的 Vercel 会把新提交部署到 Production。

失败和冲突时的行为与一键更新相同。检查失败就不会提交到 `main`。

GitHub 的默认权限不允许修改正在运行的 workflow 文件本身。将来如果某个版本改变了 ShareDesk 的更新方式，它不会悄悄保留旧版 workflow，而是会停止作业，并引导你完成一次像下面 `一次性迁移早于 0.2.0 的安装` 那样的一次性迁移。除这种情况外，应用和普通更新代码只有在管理员亲自启动上述流程（一键更新或备用方式）时才会更新。

如果更新按钮显示没有连接安装仓库，请在 Vercel Production 环境变量中添加下面的值，然后重新部署。

```dotenv
SHAREDESK_GITHUB_REPOSITORY=我的GitHub账号/我的ShareDesk仓库
```

用 Deploy with Vercel 创建的项目会自动获取 Vercel 的 Git 仓库信息，因此不必单独填写这个值。如果 GitHub Actions 成功了但 Vercel 部署没有开始，请在 Vercel 项目的 `Settings` → `Git` 中确认同一个安装仓库的 `main` 是否已设为 Production Branch。

## 0.5.0 起的行为变化

从 0.5.0 开始，每个用户都有了角色。更新之后会应用下面这些规则。

- 现有用户会全部沿用 `可编辑` 角色。原来的使用方式不变。
- 在生产（`STORAGE_DRIVER=drive`）安装中，用 `ACCESS_KEYS` 进入的访问密钥访客会变为 `仅查看`。更新之后，用访问密钥上传或修改文件的用法将不再可用。local 模式的访问密钥仍然是 `可编辑`。
- 角色可以随时在管理员界面用户表的角色列中调整。

## 一次性迁移早于 0.2.0 的安装

没有更新按钮和 workflow 的旧安装本，需要**只做一次**下面的迁移。请先在本地打开安装仓库的 `main`，并确认 `git status` 中没有未提交的改动。

Windows PowerShell：

```powershell
$shareDeskBootstrap = Join-Path $env:TEMP 'sharedesk-bootstrap.mjs'
Invoke-WebRequest 'https://github.com/Youkamii/sharedesk-template/releases/latest/download/sharedesk-bootstrap.mjs' -OutFile $shareDeskBootstrap
node $shareDeskBootstrap --apply
Remove-Item -LiteralPath $shareDeskBootstrap
```

macOS 或 Linux：

```bash
sharedesk_bootstrap="$(mktemp)"
curl -fL 'https://github.com/Youkamii/sharedesk-template/releases/latest/download/sharedesk-bootstrap.mjs' -o "$sharedesk_bootstrap"
node "$sharedesk_bootstrap" --apply
rm -f "$sharedesk_bootstrap"
```

脚本会先校验发行版的文件哈希，再把应用代码和更新文件应用到本地工作目录。`.env.local`、`.vercel`、`.git` 以及不由 ShareDesk 管理的文件都不会被改动。如果现有代码与官方 0.1.0 不同，脚本不会擅自覆盖，而是显示冲突的路径。

应用之后请运行下面的命令。

```powershell
npm ci
npm test
npm run lint
npx tsc --noEmit --incremental false
npm run build
git status --short
```

确认改动内容后，提交并 push 到安装仓库的 `main`。Vercel 部署完成后，在生产地址上确认管理员登录和文件列表。从之后的版本开始，就可以使用界面上的 `更新` 按钮了。

## 让 AI 更新现有安装

在编程 AI 中打开安装仓库后，可以把下面的请求文原样发送过去。

```text
请把这个 ShareDesk 安装本更新到最新稳定版本。

先阅读 docs/UPDATE.zh.md，确认当前仓库、分支、git status、origin 和 Vercel 的连接情况。如果已经有更新 workflow，就使用与界面按钮相同的 GitHub Actions 流程；如果没有，就使用 docs/UPDATE.zh.md 中的一次性 bootstrap。

不要修改或输出 .env.local、OAuth 值、Drive ID，以及 Drive 中的文件、用户、邀请和备注。如果存在与官方代码不同的文件，updater 报告了冲突，不要覆盖，先说明路径和可选方案，然后停下来。

如果需要改动，先在这个安装仓库中创建一个用于更新的 GitHub issue；在 npm test、npm run lint、npx tsc --noEmit --incremental false、npm run build 全部通过之后，带上那个 issue 编号做成一次提交。只 push 被允许的安装仓库，并确认关联的 Vercel Production 部署和生产地址。请把自动检查和实际生产确认分开报告。
```

## 本地个人使用

不使用 Vercel、只在本地使用的安装，可以在工作目录中用下面的命令检查有没有新版本。

```powershell
node scripts/sharedesk-update.mjs --check
```

实际应用时，请先确认 Git 工作目录是干净的，再运行 `node scripts/sharedesk-update.mjs --apply`，然后重新执行上面那些检查命令。本地文件保存在 `LOCAL_STORAGE_ROOT` 中，请与代码更新分开，单独备份整个该文件夹。
