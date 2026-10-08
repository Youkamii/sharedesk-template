**English** · [한국어](./CLI.ko.md)

# Using the desk from the CLI — terminals and AI agents

The single file `cli/sharedesk.mjs` in your ShareDesk repository lets you list, download, and upload desk files. It needs only Node 20+ and no extra packages. Point a coding AI (Claude Code, Codex, …) at this document and it can work with the desk directly.

## 1. Get a token

1. Sign in to the desk, open the right sidebar (`»`), and press **Connect CLI**.
2. Optionally note where the token will be used, then press **Create token**.
3. The token is shown **only once**. **Copy login command** copies the whole command below.

A token is a device session that acts as you. An admin can revoke it from the device sessions in user management, and it expires after 90 days. Guests who entered with an access key cannot create tokens.

## 2. Connect

```bash
node cli/sharedesk.mjs login https://<your-desk> <token>
```

The address and token are stored in `~/.sharedesk/config.json` (readable only by you where the OS supports it). The environment variables `SHAREDESK_URL` and `SHAREDESK_TOKEN` take precedence over the file — handy in CI or agent sandboxes with no config file.

`npm run desk -- <command>` runs the same CLI.

## 3. Commands

| Command | What it does |
| --- | --- |
| `status` | Check that the connection and token work |
| `ls [folder path] [--json]` | Items in a folder (default: the desktop) |
| `get <file path> [destination]` | Download a file. If the destination is a folder, the original name is kept |
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
Read docs/CLI.md in this repository and connect to ShareDesk with the token I give you.
Download this week's files from the "meeting-notes" folder on the desktop, summarize them, and upload the summary as summary.md to the same folder.
Never print or commit the token.
```
