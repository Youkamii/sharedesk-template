[English](./CLI.md) · [한국어](./CLI.ko.md) · [日本語](./CLI.ja.md) · [हिन्दी](./CLI.hi.md) · **中文**

# 通过 CLI 使用桌面 — 终端与 AI 代理

ShareDesk 仓库中的单个文件 `cli/sharedesk.mjs` 即可查看、下载和上传桌面文件。无需额外包，只要 Node 20 以上。让编码 AI（Claude Code、Codex 等）阅读本文，它就能直接操作桌面。

## 1. 获取令牌

1. 登录桌面，打开右侧边栏（`»`），点击 **连接 CLI**。
2. 可选填写令牌用途，然后点击 **创建令牌**。
3. 令牌 **仅显示一次**。请用 **复制令牌** 保存。

令牌是以你的身份运行的设备会话。管理员可在用户管理的设备会话列表（显示为 `CLI · …`）中撤销——包括管理员自己创建的 CLI 令牌——90 天后自动过期。每人最多 5 个；凭访问密钥进入的访客无法创建。

## 2. 连接

```bash
node cli/sharedesk.mjs login https://<你的桌面地址>
令牌: (粘贴——不会回显)
```

**不要把令牌作为命令参数传入**：它会留在 shell 历史和进程列表中。在提示时粘贴，或通过环境变量 `SHAREDESK_TOKEN` 提供（设置后 `login` 不再询问）。请仔细输入地址——令牌会发送到你输入的任何地址。纯 `http://` 地址（localhost 除外）会明文发送并触发警告。

地址和令牌保存在 `~/.sharedesk/config.json`（在支持的系统上仅本人可读）。环境变量 `SHAREDESK_URL` 和 `SHAREDESK_TOKEN` 优先于该文件——在 CI 或代理沙箱中无需文件即可使用。

`npm run desk -- <命令>` 也能运行同一个 CLI；`npm install` 之后 `npx sharedesk <命令>` 同样可用。

## 3. 命令

| 命令 | 作用 |
| --- | --- |
| `status` | 检查连接和令牌是否有效 |
| `ls [文件夹路径] [--json]` | 文件夹中的项目（默认：桌面） |
| `get <文件路径> [保存位置]` | 下载文件。若保存位置是文件夹，则保留原名。已有文件会被覆盖 |
| `put <本地文件> [文件夹路径] [--name 名称]` | 上传文件（省略文件夹路径则为桌面） |
| `mkdir <文件夹路径>` | 创建文件夹 |

路径相对于桌面，以 `/` 分隔，例如 `reports/2026/summary.pdf`。若有多个同名项目，CLI 会停止而不是猜测。

```bash
node cli/sharedesk.mjs ls
node cli/sharedesk.mjs ls "reports/2026" --json
node cli/sharedesk.mjs get "reports/2026/summary.pdf" ./downloads/
node cli/sharedesk.mjs put ./results.csv "reports/2026"
node cli/sharedesk.mjs mkdir "reports/2027"
```

加上 `--json` 后结果是一行 JSON，便于代理解析；错误也以 `{"ok":false,"error":...}` 返回。退出码：0 成功，1 一般错误，2 用法错误或缺少配置，3 令牌过期或被撤销。

## 4. 工作原理

- 认证与浏览器相同：令牌作为会话 Cookie 发送，服务器没有 CLI 专用入口。
- 桌面运行在 Google Drive 模式时，上传与浏览器一样 **直达 Drive**（8 MiB 分块，中断后续传）。文件内容不经过 ShareDesk 服务器（Vercel），因此大小限制与浏览器一致。本地模式的桌面由服务器接收。
- 权限遵循你的角色。只读成员的 `put` 与 `mkdir` 会被拒绝。
- 仅支持默认桌面。空间（`/<slug>/files`）尚未支持。

## 5. 给 AI 代理的示例提示

```text
阅读本仓库的 docs/CLI.zh.md 并连接 ShareDesk。令牌在环境变量 SHAREDESK_TOKEN 中。
从桌面的"会议记录"文件夹下载本周文件并总结，将总结以 summary.md 上传到同一文件夹。
切勿打印或提交令牌。
```
