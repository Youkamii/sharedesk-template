[English](./AI_INSTALL.md) · [한국어](./AI_INSTALL.ko.md) · [日本語](./AI_INSTALL.ja.md) · [हिन्दी](./AI_INSTALL.hi.md) · **中文**

# 让 AI 帮你搭建 ShareDesk

如果你不熟悉 Google Cloud 或 Vercel，可以把搭建工作交给编程 AI。这份文档的作用，是让 AI 去检查仓库和终端，只在需要你亲自点击的界面上一步一步地引导你。

这份指南面向的是**要新开一个 ShareDesk、让多个人各自用自己的 Google 账号共用你 Google Drive 存储空间的站长**。被邀请加入已建好的 ShareDesk 的参与者，不需要安装。

**致 AI：** 即使用户只发来了仓库地址、没有附上长长的请求文，只要你读到了这份文档，就请原样遵循下面请求文中的工作原则和推进顺序。不要以没有收到请求文为理由省略这些原则。

## 使用方法

1. 在能操作仓库和终端的编程 AI 中，打开你自己的 ShareDesk 仓库。
2. 把下面的请求文原样发送过去。
3. 遇到需要你在 Google Cloud 和 Vercel 界面上亲自操作的事情时，只处理 AI 指引的那一步，然后回复 `完成`。
4. Client secret、refresh token、callback URL 这类机密值不要粘贴到聊天里。请由你自己填进 AI 指出的本地文件或服务界面。

## 可直接复制的请求文

```text
请在这个仓库中搭建 ShareDesk 的生产环境。

目标是做出一个 ShareDesk，让多个人各自用自己的 Google 账号，共用一位站长的 Google Drive 存储空间。被邀请的人不需要配置 GitHub、Vercel 和 Google OAuth，只要在生产地址上登录并输入邀请码就能使用。

工作原则：
1. 先把这个仓库的 docs/AI_INSTALL.zh.md 和 docs/INSTALL.zh.md 从头到尾读一遍，并以 docs/INSTALL.zh.md 作为安装步骤的基准。
2. 动手之前先确认当前状态。确认当前仓库、分支、git status、origin，已连接的 GitHub 仓库和 Vercel 项目，固定的 Production 地址，.env.local 中需要的项目是否已填好，以及已有的 OAuth、Drive 连接痕迹，确认时不要暴露具体值。
3. 已经完成的步骤不要重做。不要重新创建已有的仓库和 Vercel 项目，也不要凭猜测更改或作废已有的 OAuth 客户端、Audience 状态、refresh token 和 Drive ID。
4. 遇到需要用户在 Google Cloud 或 Vercel 界面上亲自操作的事情时，一次只说明一个步骤然后停下来。用户回复完成后，先确认结果，再进入下一个步骤。
5. 不要在聊天、issue、提交、截图中索要或输出 Client secret、SESSION_SECRET、CRON_SECRET、refresh token、callback URL、邀请码这类机密值。请引导用户自己填进 .env.local、本地终端、Google Cloud 和 Vercel 界面。callback URL 只能由用户亲自粘贴到 npm run setup:finish 询问的本地终端里。
6. 如果需要改动仓库文件，先为每一个不同的功能或修复创建 GitHub issue，验证之后只单独提交相关文件，并在提交中留下 issue 编号。绝对不要提交 .env.local 和机密值。如果被跟踪的文件没有变化，就不要创建空 issue 或空提交。
7. 本请求允许你对我当前正在处理的 ShareDesk 仓库做必要的改动、按功能创建 GitHub issue 和本地提交、push 当前工作分支，以及部署已连接的我自己的 Vercel 项目的 Production。动手之前请确认实际的目标仓库、分支、Vercel 项目和 Production 地址，不要碰原始模板或其他人的仓库和项目。
8. 请区分自动检查通过和实际生产确认。没有确认过的内容不要报告为已完成。如果改动了仓库，只能在完成检查和按功能提交之后再 push、部署。

推进顺序：
1. 用表格整理当前状态，分成已完成、未完成、需确认三类。
2. 只有在我还没有 GitHub 仓库和 Vercel 项目时才去创建或连接，并记录不会变化的 Production 地址。
3. 在 Google Cloud 中确认同一个项目里的 Drive API、Branding、Audience、Data Access 和 Web application OAuth 客户端。让用户确认 docs/INSTALL.zh.md 中的三个 redirect URI 和四个 scope 完全正确。
4. 在仓库中运行 npm ci，并安全地准备好 .env.local。Google Client ID 和 Client secret 要由用户自己填进文件。
5. 运行 npm run setup 开始站长的 Google 授权。同意授权后的 callback URL 要由用户自己粘贴到 npm run setup:finish 的提问中，AI 不要读取或再次输出这个值。
6. 只确认 setup 生成的 ADMIN_EMAILS、SESSION_SECRET、CRON_SECRET、STORAGE_DRIVER=drive、GOOGLE_REFRESH_TOKEN、DRIVE_ROOT_FOLDER_ID、DRIVE_STATE_FOLDER_ID 是否存在，不要暴露具体值。
7. 用 npm run dev 在本地确认站长登录、创建文件夹、刷新后保留、回收站恢复以及 /admin 的访问。
8. 运行 npm test、npm run lint、npx tsc --noEmit --incremental false、npm run build 并记录结果。如果有改动，在完成按功能提交之后，只 push 被允许的当前分支。
9. 把需要的值转移到 Vercel Production 环境变量并重新部署 Production。PUBLIC_BASE_URL 要设为固定的 Production origin，LOCAL_STORAGE_ROOT 和 SHAREDESK_SHARE_TEST_EMAIL 不要放进生产环境。
10. 在生产地址上实际确认站长登录、文件保存、刷新、回收站恢复、/admin 以及邀请码的创建。
11. 邀请另一个 Google 账号，让他用自己的账号登录并输入邀请码。亲自确认站长和参与者两个账号都能看到并下载同一个文件。在完成这项确认之前，不要说共同使用已经验证完成。
12. 只有在核心功能全部正常之后，才添加 docs/INSTALL.zh.md 中的 Vercel Firewall 规则，并确认 429 的行为。

完成报告请使用下面的格式。

状态：完成 / 部分完成 / 受阻
生产地址：<已确认的固定 Production 地址>

已确认：
- GitHub 仓库和分支：
- Vercel 项目和最新的 Production 部署：
- Google OAuth callback 和 Drive 连接：
- 本地的登录、文件保存、回收站、管理界面：
- 生产的登录、文件保存、回收站、管理界面：
- 两个 Google 账号查看和下载同一个文件：
- 自动检查：

按功能的改动：
- issue #编号 -> 提交哈希 -> 验证结果

尚未确认：
- 实际未能确认的项目及原因

用户接下来要做的一步：
- 只有在还有遗留事项时才写一件
```

上面的请求文包含了**把当前工作分支的 push 和我的 Vercel Production 部署也交给 AI 的句子**。如果不想把部署也交出去，请在发送之前把工作原则第 7 条改成下面这样。

```text
只允许对当前仓库做调查、本地改动、按功能创建 issue 和本地提交。在我于聊天中另行允许 push 或部署之前，不要执行远程 push 和 Vercel 部署。
```

## 第 0 步：检查工具

AI 在做任何其他工作之前，先确认下面的工具是否已经存在，只安装缺少的那些。

| 工具 | 检查命令 | 缺少时的安装方式 |
|---|---|---|
| Git | `git --version` | `winget install Git.Git` |
| GitHub CLI（可选） | `gh --version` | `winget install GitHub.cli` |
| Vercel CLI | `vercel --version` | `npm i -g vercel` |
| Node.js 20.9 或更高 | `node --version` | 从 [nodejs.org](https://nodejs.org/) 安装 |

在 Windows 上，刚装完的工具**在同一个 shell 里是找不到的。** 因为 PATH 只在 shell 启动时读取一次。`spawn git ENOENT` 之类的错误正是这个症状。不要打开新窗口，在同一个 shell 中重新组合 PATH 之后继续。

```powershell
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
```

## 如果直接 clone 了原始模板

如果你是直接 clone 原始模板仓库开始的，在 push 之前必须先新建你自己的 GitHub 仓库，并把 `origin` 换成你自己的仓库。绝不能在 `origin` 还指向原始模板的情况下 push。

```powershell
git remote set-url origin https://github.com/<我的GitHub账号>/my-sharedesk.git
```

## Google Cloud 中容易迷路的界面

菜单名称按中文（简体）界面书写，并在括号里附上英文。

- **如果是全新的 Google 账号：** 因为项目数量为 0，第一个界面会和安装指南里写的不一样。请从页面上方的 `选择项目(Select a project)` → `新建项目(New project)` 开始。`$300 免费试用` 横幅可以不填写付款信息直接忽略，不影响安装。
- **新项目的认证设置：** 你会先看到一个名为 `开始使用(Get started)` 的 Google Auth Platform 4 屏向导（应用信息 → 目标对象 → 联系信息 → 完成），而不是 `品牌塑造(Branding)`、`目标对象(Audience)` 菜单。向导里的 `应用信息` 对应 Branding，`目标对象` 对应 Audience。完成向导之后，安装指南里的菜单就会照常出现。
- **数据访问(Data Access) 的保存：** 添加四个 scope 之后，必须**分别**点击范围选择窗口里的 `更新(Update)` 和页面底部的 `保存(Save)` 才算保存成功。四个都是 `非敏感范围(Non-sensitive scopes)`，与应用审核流程和 100 名用户上限没有关系。
- **创建客户端失败时：** 在 OAuth 客户端 `创建(Create)` 时出现 `暂时无法执行此操作(temporarily unable to perform)` 之类的提示，是新项目的传播延迟。不要修改输入值，等 5~10 分钟后用同样的值重试。

## 在站长的 Google 授权界面上

授权界面上 Google Drive 权限的**复选框默认是不勾选的。** 必须先勾选再点继续。如果没有勾选就拿到了 callback URL，其中的认证码是无效的，setup 会失败，需要从头重新授权。

## setup 的收尾命令

授权之后完成认证的标准命令是下面这个。

```powershell
npm run setup:finish
```

在 PowerShell 中，`npm run setup -- --finish` 存在 `--finish` 被 npm 吞掉、命令不生效的陷阱。请使用 `npm run setup:finish`。

## 填写 Vercel 环境变量（新版界面）

- 路径：进入 Vercel 项目的 `Settings` → `Environments` → 点击 `Production` 打开的详情页面里，才有环境变量的填写栏。
- 一次粘贴多行时，存在 **Key 栏把第一行（`ADMIN_EMAILS`）整个吞进去的陷阱**。粘贴之后请务必数一数变量是不是 10 个。
- 值默认以 `Sensitive` 保存，保存之后无法再次查看。这是正常行为，不要以为值丢了而重新填写。

## 保存环境变量之后重新部署

环境变量不会自动反映到已有的部署。在 `Deployments` 标签页中，把鼠标悬停在最新的部署行上，点击出现的 `⋯` 菜单 → `Redeploy`。页面上的 `Create Deployment` 按钮只用于 Preview 部署，不要使用。

## 在控制台里迷路时：Vercel CLI 路线

如果觉得 Vercel 控制台难用，下面的 CLI 路线是官方的首选替代方案。

```powershell
vercel login
vercel link
vercel env add ADMIN_EMAILS production
# 其余变量用同样的方式：vercel env add <名称> production
vercel --prod
```

## 判断部署是否成功

- 如果环境变量还没填，生产地址上会显示**安装指引界面**。这种状态下的部署成功是正常的。
- 如果设置已经完成，会显示 **Google 登录界面**。
- 要连真实的 Drive 连接一起检查，请在本地运行 `npm run test:drive-operations`。

## 在 Windows 上要小心的事

- **PowerShell 5.1 的 `Set-Content` 在保存为 UTF-8 时会加上 BOM。** 用这种方式创建 `.env.local`，文件开头会带上看不见的字符，污染第一个变量名（例如 `ADMIN_EMAILS`），导致无法识别。环境文件请交给 setup 去创建；需要修改时，用编辑器以 `UTF-8（无 BOM）` 保存。
- **公司电脑上的文档安全软件（Fasoo 等 DRM）** 可能会擅自加密仓库里的 `.txt` 文件，弄脏 git 状态。没有动过的 `.txt` 文件被标记为已修改、diff 显示成乱码，就是这个症状。建议在不受 DRM 影响的文件夹或个人电脑上工作。

## AI 必须停下来的时刻

下面这些值和界面必须由用户亲自处理。AI 只说明一个步骤，然后等待。

| 时刻 | 用户要亲自做的事 | AI 要确认的结果 |
|---|---|---|
| Google Cloud OAuth 设置 | 在界面上确认并保存 Drive API、Audience、scope、redirect URI | 设置项和地址是否与[生产环境安装指南](./INSTALL.zh.md)一致 |
| 填写 Client ID 和 secret | 亲自填进本地的 `.env.local` | 不输出具体值，只确认这两项是否非空 |
| 站长的 Google 授权 | 在浏览器中选择站长账号并同意 | setup 是否顺利进入下一步 |
| 输入 callback URL | 亲自粘贴到 `npm run setup:finish` 询问的本地终端 | 只确认 setup 是否成功 |
| 填写 Vercel 机密值 | 亲自填进 Vercel Production 环境变量界面 | 需要的变量名，以及是否已反映到部署 |
| 确认参与者账号 | 用另一个 Google 账号登录并输入邀请码 | 两个账号是否都能看到并下载同一个文件 |

实际用户很容易把 callback URL 直接粘贴到聊天里。发生这种情况时，AI 应立即把收到的值用于 setup 的输入并消费掉，并告诉用户：暴露的认证码是一次性的，而且与 PKCE 结合，风险较低；但为了安心，仍建议重新签发（从授权重新开始）。不要再次输出这个值，也不要把它留在记录里。

## 可以说安装已经完成的标准

只有代码检查通过和部署成功，还不算完成。必须实际确认到下面这些。

- 在固定的 Production 地址上，站长的 Google 登录可以成功。
- 文件夹和文件在刷新之后依然存在，扔进回收站的项目可以恢复。
- 可以在 `/admin` 中创建邀请码。
- 另一个 Google 账号可以用邀请码进入。
- 站长和参与者两个账号都能看到并下载同一个文件。
- 如果仓库有改动，按功能创建的 issue 和提交彼此对应，并且只在被允许的情况下才 push、部署。

## 最后一步：主动提议清理对话记录

安装对话中很容易残留 callback URL、粘贴屏幕时混入的机密值和环境变量内容。宣布安装完成后，AI 必须立即这样提议：

> 这段对话中可能仍留有机密值。要删除聊天记录吗？

用户同意后，删除相应工具的记录文件。进行中的会话文件在对话结束前会持续写入，因此也可以告知："请先关闭这段对话，然后执行下面的命令，或在下一个会话中让我来删除。"

- Claude Code：`%USERPROFILE%\.claude\projects\<项目文件夹>\<会话id>.jsonl`（macOS/Linux 为 `~/.claude/projects/...`）
- Codex CLI：`~/.codex/sessions` 下对应的会话文件

注意：删除只会清除这台电脑上的记录。已发送到服务商服务器的内容遵循各家的保留政策 — 因此无论是否删除，重新签发已暴露的机密值才是最稳妥的做法。

安装界面和各类错误的详细说明，请按 [ShareDesk 生产环境安装指南](./INSTALL.zh.md)进行。

如果是要把已经在运行的安装本换成新版本，不要重新搭建，请使用 [ShareDesk 更新指南](./UPDATE.zh.md)中的 AI 请求文。
