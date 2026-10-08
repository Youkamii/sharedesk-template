**English** · [한국어](./CLI.ko.md) · [日本語](./CLI.ja.md) · [हिन्दी](./CLI.hi.md) · [中文](./CLI.zh.md)

# Using the desk from the CLI — terminals and AI agents

The single file `cli/sharedesk.mjs` in your ShareDesk repository lets you list, download, and upload desk files. It needs only Node 20+ and no extra packages. Point a coding AI (Claude Code, Codex, …) at this document and it can work with the desk directly.

## 1. Get a token

1. Sign in to the desk, open the right sidebar (`»`), and press **Connect CLI**.
2. Optionally note where the token will be used, then press **Create token**.
3. The token is shown **only once**. Keep it with **Copy token**.

A token is a device session that acts as you. An admin can revoke it from the device session list in user management (shown as `CLI · …`) — including CLI tokens the admin created themselves — and it expires after 90 days. Each member can hold up to 5; guests who entered with an access key cannot create tokens.

## 2. Connect

```bash
node cli/sharedesk.mjs login https://<your-desk>
Token: (paste — it is not echoed)
```

**Do not pass the token as a command argument**: it would land in shell history and process listings. Paste it when prompted, or provide it in the `SHAREDESK_TOKEN` environment variable (`login` skips the prompt when it is set). Type the address carefully — the token is sent to whatever address you enter. A plain `http://` address (other than localhost) sends it unencrypted and triggers a warning.

The address and token are stored in `~/.sharedesk/config.json` (readable only by you where the OS supports it). The environment variables `SHAREDESK_URL` and `SHAREDESK_TOKEN` take precedence over the file — handy in CI or agent sandboxes with no config file.

`npm run desk -- <command>` runs the same CLI, and after `npm install` so does `npx sharedesk <command>`.

## 3. Commands

| Command | What it does |
| --- | --- |
| `status` | Check that the connection and token work |
| `ls [folder path] [--json]` | Items in a folder (default: the desktop) |
| `get <file path> [destination]` | Download a file. If the destination is a folder, the original name is kept. An existing file is overwritten |
| `put <local file> [folder path] [--name name]` | Upload a file (desktop when the folder path is omitted) |
| `mkdir <folder path>` | Create a folder |

Paths are relative to the desktop and use `/`, e.g. `reports/2026/summary.pdf`. If several items share a name, the CLI stops instead of guessing.

```bash
node cli/sharedesk.mjs ls
node cli/sharedesk.mjs ls "reports/2026" --json
node cli/sharedesk.mjs get "reports/2026/summary.pdf" ./downloads/
node cli/sharedesk.mjs put ./results.csv "reports/2026"
node cli/sharedesk.mjs mkdir "reports/2027"
```

With `--json` the result is a single JSON line that agents can parse; errors come back as `{"ok":false,"error":...}`. Exit codes: 0 success, 1 general error, 2 usage or missing config, 3 token expired or revoked.

## 4. How it works

- Authentication is the same as the browser: the token is sent as the session cookie, so the server has no CLI-only door.
- When the desk runs on Google Drive, uploads go **directly to Drive** just like the browser (8 MiB chunks, resumed after a drop). File bodies never pass through the ShareDesk server (Vercel), so the size limits match the browser. Local-mode desks receive uploads on the server.
- Permissions follow your role. View-only members get `put` and `mkdir` refused.
- Only the default desk is covered. Spaces (`/<slug>/files`) are not supported yet.

## 5. Example prompt for an AI agent

```text
Read docs/CLI.md in this repository and connect to ShareDesk. The token is in the SHAREDESK_TOKEN environment variable.
Download this week's files from the "meeting-notes" folder on the desktop, summarize them, and upload the summary as summary.md to the same folder.
Never print or commit the token.
```
