[English](./AI_INSTALL.md) · [한국어](./AI_INSTALL.ko.md) · [日本語](./AI_INSTALL.ja.md) · [हिन्दी](./AI_INSTALL.hi.md) · **中文**

# 让 AI 帮你搭建 ShareDesk

如果你不熟悉 Google Cloud 或 Vercel，可以把搭建工作交给编程 AI。这份文档的作用，是让 AI 去检查仓库和终端，只在需要你亲自点击的界面上一步一步地引导你。

这份指南面向的是**要新开一个 ShareDesk、让多个人各自用自己的 Google 账号共用你 Google Drive 存储空间的站长**。被邀请加入已建好的 ShareDesk 的参与者，不需要安装。

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
5. 不要在聊天、issue、提交、截图中索要或输出 Client secret、SESSION_SECRET、refresh token、callback URL、邀请码这类机密值。请引导用户自己填进 .env.local、本地终端、Google Cloud 和 Vercel 界面。callback URL 只能由用户亲自粘贴到 npm run setup -- --finish 询问的本地终端里。
6. 如果需要改动仓库文件，先为每一个不同的功能或修复创建 GitHub issue，验证之后只单独提交相关文件，并在提交中留下 issue 编号。绝对不要提交 .env.local 和机密值。如果被跟踪的文件没有变化，就不要创建空 issue 或空提交。
7. 本请求允许你对我当前正在处理的 ShareDesk 仓库做必要的改动、按功能创建 GitHub issue 和本地提交、push 当前工作分支，以及部署已连接的我自己的 Vercel 项目的 Production。动手之前请确认实际的目标仓库、分支、Vercel 项目和 Production 地址，不要碰原始模板或其他人的仓库和项目。
8. 请区分自动检查通过和实际生产确认。没有确认过的内容不要报告为已完成。如果改动了仓库，只能在完成检查和按功能提交之后再 push、部署。

推进顺序：
1. 用表格整理当前状态，分成已完成、未完成、需确认三类。
2. 只有在我还没有 GitHub 仓库和 Vercel 项目时才去创建或连接，并记录不会变化的 Production 地址。
3. 在 Google Cloud 中确认同一个项目里的 Drive API、Branding、Audience、Data Access 和 Web application OAuth 客户端。让用户确认 docs/INSTALL.zh.md 中的三个 redirect URI 和四个 scope 完全正确。
4. 在仓库中运行 npm ci，并安全地准备好 .env.local。Google Client ID 和 Client secret 要由用户自己填进文件。
5. 运行 npm run setup 开始站长的 Google 授权。同意授权后的 callback URL 要由用户自己粘贴到 npm run setup -- --finish 的提问中，AI 不要读取或再次输出这个值。
6. 只确认 setup 生成的 ADMIN_EMAILS、SESSION_SECRET、STORAGE_DRIVER=drive、GOOGLE_REFRESH_TOKEN、DRIVE_ROOT_FOLDER_ID、DRIVE_STATE_FOLDER_ID 是否存在，不要暴露具体值。
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

## AI 必须停下来的时刻

下面这些值和界面必须由用户亲自处理。AI 只说明一个步骤，然后等待。

| 时刻 | 用户要亲自做的事 | AI 要确认的结果 |
|---|---|---|
| Google Cloud OAuth 设置 | 在界面上确认并保存 Drive API、Audience、scope、redirect URI | 设置项和地址是否与[生产环境安装指南](./INSTALL.zh.md)一致 |
| 填写 Client ID 和 secret | 亲自填进本地的 `.env.local` | 不输出具体值，只确认这两项是否非空 |
| 站长的 Google 授权 | 在浏览器中选择站长账号并同意 | setup 是否顺利进入下一步 |
| 输入 callback URL | 亲自粘贴到 `npm run setup -- --finish` 询问的本地终端 | 只确认 setup 是否成功 |
| 填写 Vercel 机密值 | 亲自填进 Vercel Production 环境变量界面 | 需要的变量名，以及是否已反映到部署 |
| 确认参与者账号 | 用另一个 Google 账号登录并输入邀请码 | 两个账号是否都能看到并下载同一个文件 |

## 可以说安装已经完成的标准

只有代码检查通过和部署成功，还不算完成。必须实际确认到下面这些。

- 在固定的 Production 地址上，站长的 Google 登录可以成功。
- 文件夹和文件在刷新之后依然存在，扔进回收站的项目可以恢复。
- 可以在 `/admin` 中创建邀请码。
- 另一个 Google 账号可以用邀请码进入。
- 站长和参与者两个账号都能看到并下载同一个文件。
- 如果仓库有改动，按功能创建的 issue 和提交彼此对应，并且只在被允许的情况下才 push、部署。

安装界面和各类错误的详细说明，请按 [ShareDesk 生产环境安装指南](./INSTALL.zh.md)进行。

如果是要把已经在运行的安装本换成新版本，不要重新搭建，请使用 [ShareDesk 更新指南](./UPDATE.zh.md)中的 AI 请求文。
