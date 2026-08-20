**English** · [한국어](./AI_INSTALL.ko.md) · [日本語](./AI_INSTALL.ja.md) · [हिन्दी](./AI_INSTALL.hi.md) · [中文](./AI_INSTALL.zh.md)

# Let AI build ShareDesk for you

If Google Cloud or Vercel is unfamiliar, you can hand the build over to a coding AI. This page is written so the AI checks the repository and the terminal for you, and guides you one step at a time only on the screens you have to click through yourself.

This guide is for **you, the host opening a new ShareDesk where several people share your Google Drive storage with their own Google accounts**. A participant invited to a ShareDesk that already exists does not install anything.

**To the AI:** even if the user handed you only the repository address without the long request, once you find yourself reading this document, follow the working principles and the order of work in the request below exactly as written. Do not skip the principles because you never received the request.

## How to use it

1. Open your ShareDesk repository in a coding AI that can work with the repository and a terminal.
2. Send the request below as it is.
3. When something on the Google Cloud or Vercel screen has to be done by you, handle just the one step the AI describes and reply `done`.
4. Do not paste secrets such as the Client secret, the refresh token, or the callback URL into the chat. Enter them yourself in the local file or the service screen the AI points you to.

## The request to copy as it is

```text
Build a ShareDesk production environment in this repository.

The goal is a ShareDesk where several people share one host's Google Drive storage with their own Google accounts. An invited person should not have to set up GitHub, Vercel, or Google OAuth — they only sign in at the production address and enter an invitation code.

Working principles:
1. First read docs/AI_INSTALL.md and docs/INSTALL.md in this repository from beginning to end, and treat docs/INSTALL.md as the reference for the install procedure.
2. Check the current state before doing anything. Check the current repository, branch, git status, and origin, the connected GitHub repository and Vercel project, the fixed Production address, whether the required entries in .env.local are filled in, and any trace of an existing OAuth or Drive connection — without exposing values.
3. Do not repeat steps that are already done. Do not recreate an existing repository or Vercel project, and do not change or discard an existing OAuth client, Audience status, refresh token, or Drive ID on a guess.
4. When something has to be done by the user on the Google Cloud or Vercel screen, explain one step only and stop. When the user says it is done, check the result and then move on to the next single step.
5. Do not ask for or print secrets such as the Client secret, SESSION_SECRET, CRON_SECRET, the refresh token, the callback URL, or invitation codes in chat, issues, commits, or screenshots. Guide the user to enter them directly in .env.local, the local terminal, Google Cloud, or the Vercel screen. Have the user paste the callback URL only into the local terminal where npm run setup:finish asks for it.
6. If repository files have to change, create a GitHub issue first for each separate feature or fix, and after verification commit only those files with the issue number recorded. Never commit .env.local or any secret. If no tracked file changed, do not create an empty issue or an empty commit.
7. This request permits the necessary changes in my ShareDesk repository that you are working in, per-feature GitHub issues and local commits, a push of the current working branch, and a Production deployment of my connected Vercel project. Before working, confirm the actual target repository, branch, Vercel project, and Production address, and do not touch the original template or anyone else's repository or project.
8. Distinguish passing automated checks from real production verification. Do not report anything as done that you have not verified. If you changed the repository, push and deploy only after the checks and the per-feature commits are finished.

Order of work:
1. Put the current state in a table, split into done, not done, and needs checking.
2. Create or connect my GitHub repository and Vercel project only if they do not exist, and record the Production address that does not change.
3. In Google Cloud, check the Drive API, Branding, Audience, Data Access, and the Web application OAuth client in the same project. Have the user verify that the three redirect URIs and four scopes in docs/INSTALL.md match exactly.
4. Run npm ci in the repository and prepare .env.local safely. Have the user enter the Google Client ID and Client secret in the file themselves.
5. Run npm run setup to start the host Google consent. After consent, have the user paste the callback URL themselves into the question from npm run setup:finish, and do not read or reprint that value.
6. Check only that ADMIN_EMAILS, SESSION_SECRET, CRON_SECRET, STORAGE_DRIVER=drive, GOOGLE_REFRESH_TOKEN, DRIVE_ROOT_FOLDER_ID, and DRIVE_STATE_FOLDER_ID created by setup exist, without exposing the values.
7. With npm run dev, check host sign-in, folder creation, persistence after a refresh, trash restore, and /admin access locally.
8. Run npm test, npm run lint, npx tsc --noEmit --incremental false, and npm run build, and record the results. If there are changes, finish the per-feature commits and then push only the permitted current branch.
9. Move the required values into the Vercel Production environment variables and redeploy Production. Set PUBLIC_BASE_URL to the fixed Production origin, and do not put LOCAL_STORAGE_ROOT or SHAREDESK_SHARE_TEST_EMAIL in the production environment.
10. At the production address, really check host sign-in, file saving, refresh, trash restore, /admin, and invitation code creation.
11. Invite one person who has a separate Google account, and have them sign in with their own account and enter the code. Check for yourself that the host and the participant both see and download the same file. Do not report shared use as verified before this check.
12. Only after every core feature works, add the Vercel Firewall rule from docs/INSTALL.md and check the 429 behavior.

Use the format below for the completion report.

Status: Done / Partly done / Blocked
Production address: <the fixed Production address you verified>

Verified:
- GitHub repository and branch:
- Vercel project and latest Production deployment:
- Google OAuth callback and Drive connection:
- Local sign-in, file saving, trash, admin screen:
- Production sign-in, file saving, trash, admin screen:
- Same file visible and downloadable from two Google accounts:
- Automated checks:

Changes by feature:
- issue #number -> commit hash -> verification result

Not verified yet:
- items you could not actually verify, and why

One next step for the user:
- write a single item only if something is left
```

The request above includes **the sentence that hands over a push of the current working branch and a Production deployment of your Vercel project**. If you do not want to hand over the deployment, change working principle 7 to the following before sending it.

```text
Only investigation of the current repository and local changes, per-feature issues, and local commits are permitted. Do not push to the remote or deploy to Vercel before I separately permit a push or a deployment in the chat.
```

## Step 0: Check the tools

Before anything else, the AI checks that the tools below exist and installs only what is missing.

| Tool | Check command | Install if missing |
|---|---|---|
| Git | `git --version` | `winget install Git.Git` |
| GitHub CLI (optional) | `gh --version` | `winget install GitHub.cli` |
| Vercel CLI | `vercel --version` | `npm i -g vercel` |
| Node.js 20.9 or later | `node --version` | Install from [nodejs.org](https://nodejs.org/) |

On Windows, **the same shell cannot find a tool right after installing it**, because PATH is read only once when the shell starts. An error like `spawn git ENOENT` is exactly this symptom. Do not open a new window — rebuild PATH in the same shell and carry on.

```powershell
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
```

## If you cloned the original template directly

If you started by cloning the original template repository directly, you must create your own GitHub repository and switch `origin` to it before any push. Never push while the original is still `origin`.

```powershell
git remote set-url origin https://github.com/<your-github-account>/my-sharedesk.git
```

## Google Cloud screens that are easy to get lost on

The menu names below follow the English console. A console set to another language shows the same items translated, in the same places.

- **On a brand-new Google account:** with zero projects, the first screen looks different from the install guide. Start from `Select a project` at the top → `New project`. The `$300 free trial` banner can be ignored without entering billing details — it does not affect the install.
- **Auth setup in a new project:** instead of the `Branding` and `Audience` menus, a four-screen `Get started` wizard (App information → Audience → Contact information → Finish) appears first. The wizard's `App information` corresponds to Branding, and its `Audience` to Audience. Once the wizard is done, the menus from the install guide appear exactly as described.
- **Saving Data Access:** after adding the four scopes, you have to press `Update` in the scope picker **and** `Save` at the bottom of the screen, each separately, before anything is saved. All four are `Non-sensitive scopes`, so they have nothing to do with the app verification process or the 100-user cap.
- **When creating the client fails:** if pressing `Create` on the OAuth client shows an error saying the action cannot be performed temporarily, that is propagation delay in a new project. Do not change your inputs — retry with the same values after 5–10 minutes.

## On the host Google consent screen

The Google Drive permission **checkbox on the consent screen is off by default.** You must tick it before pressing continue. An authorization code in a callback URL received without the tick is invalid, setup fails, and the consent has to be done again from the beginning.

## The setup finishing command

The standard command that finishes the authorization after consent is this.

```powershell
npm run setup:finish
```

In PowerShell, `npm run setup -- --finish` has a trap: npm swallows `--finish` and the command does nothing. Use `npm run setup:finish`.

## Entering Vercel environment variables (the newer screens)

- Path: in the Vercel project, press `Settings` → `Environments` → `Production`, and the environment variable fields are inside that detail screen.
- Pasting several lines at once has a trap where **the Key field swallows the whole first line (`ADMIN_EMAILS`)**. After pasting, always count that there are 10 variables.
- Values are stored as `Sensitive` by default and cannot be viewed again after saving. That is normal behavior — do not re-enter them because the values look gone.

## Redeploy after saving environment variables

Environment variables do not reach an existing deployment on their own. In the `Deployments` tab, hover over the latest deployment row, open the `⋯` menu that appears, and press `Redeploy`. The `Create Deployment` button on the screen is for Preview deployments only and must not be used.

## If you get lost in the dashboard: the Vercel CLI path

If the Vercel dashboard is hard to follow, the CLI path below is the official first-choice alternative.

```powershell
vercel login
vercel link
vercel env add ADMIN_EMAILS production
# the remaining variables the same way: vercel env add <name> production
vercel --prod
```

## Telling whether the deployment succeeded

- With the environment variables still missing, the production address shows **the install notice screen**. A successful deployment in this state is normal.
- Once the setup is complete, it shows **the Google sign-in screen**.
- To check all the way to the real Drive connection, run `npm run test:drive-operations` locally.

## Things to watch out for on Windows

- **`Set-Content` in PowerShell 5.1 adds a BOM when saving as UTF-8.** If `.env.local` is created this way, an invisible character sits at the very start of the file and corrupts the first variable name (for example `ADMIN_EMAILS`) so it is not recognized. Let setup create the environment file, and when you edit it, save it from an editor as `UTF-8 (without BOM)`.
- **Document security software on a company PC (DRM such as Fasoo)** can silently encrypt `.txt` files inside the repository and dirty the git status. If `.txt` files you never touched show as modified and their diff comes out as broken characters, that is this symptom. Work in a folder the DRM does not cover, or preferably on a personal PC.

## Moments the AI must stop

The following values and screens have to be handled by you. The AI describes one step and then waits.

| Moment | What you do yourself | What the AI checks |
|---|---|---|
| Google Cloud OAuth settings | Check and save the Drive API, Audience, scopes, and redirect URIs on the screen | Whether the settings and addresses match the [production install guide](./INSTALL.md) |
| Entering the Client ID and secret | Enter them directly in the local `.env.local` | Only that the two entries are not empty, without printing the values |
| Host Google consent | Choose the host account in the browser and consent | Whether setup carries on to the next step |
| Entering the callback URL | Paste it yourself into the local terminal where `npm run setup:finish` asks | Only whether setup succeeded |
| Entering Vercel secrets | Enter them directly on the Vercel Production environment variables screen | The names of the required variables and whether the deployment picked them up |
| Checking the participant account | Sign in with a separate Google account and enter the invitation code | Whether both accounts see and download the same file |

A real user easily pastes the callback URL straight into the chat. If that happens, the AI uses the received value immediately as the setup input to consume it, and tells the user that the exposed authorization code is single-use and combined with PKCE, so the risk is low — while still recommending a reissue (consent again from the start) for peace of mind. Do not print that value again or leave it in any record.

## When you can say the install is finished

Code checks and a successful deployment are not enough. All of the following have to be verified for real.

- Host Google sign-in works at the fixed Production address.
- Folders and files are still there after a refresh, and an item thrown in the trash can be restored.
- An invitation code can be created in `/admin`.
- A separate Google account comes in with an invitation code.
- The host and the participant see and download the same file from both accounts.
- If the repository changed, the per-feature issues and commits match each other, and a push or deployment happened only where it was permitted.

## The last step: offer to clean up the conversation

An install conversation tends to accumulate callback URLs, secrets caught in pasted screens, and environment variable contents. Right after declaring the install finished, the AI must offer this:

> This conversation may still contain secrets. Shall I delete the chat transcript?

If the user agrees, delete the tool's transcript file. The live session file keeps being written until the conversation ends, so it is fine to say "close this conversation first, then run the command below — or ask me to delete it in the next session."

- Claude Code: `%USERPROFILE%\.claude\projects\<project folder>\<session id>.jsonl` (on macOS/Linux, `~/.claude/projects/...`)
- Codex CLI: the session file under `~/.codex/sessions`

Note: deletion only removes the record on this computer. Whatever was already sent to the provider's servers follows their retention policy — which is why rotating any exposed secret is the surest fix, deletion or not.

For the install screens and detailed explanations of each error, follow the [ShareDesk production install guide](./INSTALL.md).

If you want to move an install that is already running to a new version, do not build it again — use the AI request in the [ShareDesk update guide](./UPDATE.md).
