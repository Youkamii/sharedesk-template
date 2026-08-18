**English** · [한국어](./UPDATE.ko.md) · [日本語](./UPDATE.ja.md) · [हिन्दी](./UPDATE.hi.md) · [中文](./UPDATE.zh.md)

# ShareDesk Update

ShareDesk applies a new version by updating **your own GitHub repository** — the one created when you installed it — and letting the Vercel project connected to that repository redeploy. Files, users, invitations, and notes in Google Drive, and your Vercel environment variables, are not part of a code update.

## Using the update button

ShareDesk never applies a new version on its own. When you sign in as an admin it checks the latest stable version once, and puts a star on `Update` in the taskbar only when a new version exists.

Once you have finished [Prepare one-click updates (one time)](#prepare-one-click-updates-one-time) below, the update finishes inside ShareDesk without sending you to GitHub.

1. Press the starred `Update` to see the current version and the latest stable version inside ShareDesk. Even without a star you can press the button and check for yourself.
2. If a new version exists, press `Update now` in that window.
3. ShareDesk runs the update workflow in your install repository for you and shows the progress in the same window. It goes from `Applying the update` to `Deploying the new version`, and ends with `The update is finished`, or `The update failed` if something went wrong. This can take a few minutes.
4. If every check passes, an update commit lands on `main` in your install repository, and the Vercel project connected to it deploys the new commit to Production.
5. When `The update is finished` appears, press `Refresh` to switch to the new version.

If a check or the build fails, nothing is committed to `main`, so your current production deployment stays as it is. If you edited ShareDesk code files in your install, they are not overwritten either — the job stops and shows the names of the conflicting files. When a failure appears, `View detailed logs` takes you to the GitHub Actions record.

### Prepare one-click updates (one time)

To update straight from the app, create a GitHub token once and put it in Vercel so ShareDesk can run the workflow in your install repository. It is a least-privilege token that only holds Actions permission on that one install repository.

1. Sign in to GitHub, then open your profile picture at the top right → `Settings`.
2. At the bottom of the left menu, open `Developer settings` → `Personal access tokens` → `Fine-grained tokens`.
3. Press `Generate new token`.
4. Give the token a name you will recognize. For example `sharedesk-update`
5. Set `Expiration`. Once the token expires, one-click updates stop and only the fallback path is left, so choose a long expiry and note the date, or create the token again with this procedure after it expires.
6. Under `Repository access`, choose `Only select repositories` and select **only your one ShareDesk install repository**.
7. Under `Permissions` → `Repository permissions`, set `Actions` to `Read and write`. Leave every other permission alone.
8. Press `Generate token` and copy the token value. You cannot see it again once you leave the screen.
9. In your Vercel project, go to `Settings` → `Environment Variables` and add the value below to the `Production` environment.

```dotenv
SHAREDESK_GITHUB_TOKEN=the-token-value-you-copied
```

10. Redeploy Production. Environment variable changes do not reach an existing deployment on their own.

The token is a secret. Never paste it into a public repository, a chat, an issue, or a screenshot.

### The fallback path without a token

An install without `SHAREDESK_GITHUB_TOKEN` can update too. In that case pressing `Update now` opens the GitHub page as before.

1. On the GitHub Actions page that opens, press `Run workflow`.
2. If every check passes, an update commit lands on `main` in your install repository.
3. The Vercel project connected to the repository deploys the new commit to Production.

Failures and conflicts behave exactly as with one-click. If a check fails, nothing is committed to `main`.

GitHub's default permissions do not allow a running workflow to change the workflow file itself. If a later release changes how ShareDesk updates work, the job stops instead of quietly keeping the old workflow, and points you to a one-time migration like `Migrating an install older than 0.2.0 once` below. Apart from that case, the app and the regular update code only change when an admin starts the procedure above (one-click or fallback).

If the update button says the repository is not connected, add the value below to your Vercel Production environment variables and redeploy.

```dotenv
SHAREDESK_GITHUB_REPOSITORY=my-github-account/my-sharedesk-repository
```

A project created with Deploy with Vercel picks up Vercel's Git repository information automatically, so you do not need to add this value. If GitHub Actions succeeded but no Vercel deployment started, open `Settings` → `Git` in the Vercel project and check that `main` of the same install repository is connected as the Production Branch.

## What changes in 0.5.0

From 0.5.0 every user has a role. After the update:

- Every existing user carries over with the `Can edit` role. Nothing about the way they work changes.
- In a production (`STORAGE_DRIVER=drive`) install, guests who enter with an `ACCESS_KEYS` access key become `View only`. Uploading or editing files with an access key no longer works after the update. Access keys in local mode stay `Can edit`.
- You can adjust a role anytime in the `Role` column of the user table on the admin screen.

## Migrating an install older than 0.2.0 once

An older install that has no update button and no workflow needs the migration below **once**. First open `main` of your install repository locally and check that `git status` shows no changes.

Windows PowerShell:

```powershell
$shareDeskBootstrap = Join-Path $env:TEMP 'sharedesk-bootstrap.mjs'
Invoke-WebRequest 'https://github.com/Youkamii/sharedesk-template/releases/latest/download/sharedesk-bootstrap.mjs' -OutFile $shareDeskBootstrap
node $shareDeskBootstrap --apply
Remove-Item -LiteralPath $shareDeskBootstrap
```

macOS or Linux:

```bash
sharedesk_bootstrap="$(mktemp)"
curl -fL 'https://github.com/Youkamii/sharedesk-template/releases/latest/download/sharedesk-bootstrap.mjs' -o "$sharedesk_bootstrap"
node "$sharedesk_bootstrap" --apply
rm -f "$sharedesk_bootstrap"
```

The script verifies the file hashes in the release and then applies the app code and the update files to your local working folder. It leaves `.env.local`, `.vercel`, `.git`, and any file ShareDesk does not manage untouched. If your existing code differs from the official 0.1.0, it shows the conflicting paths instead of overwriting anything.

After applying it, run the following.

```powershell
npm ci
npm test
npm run lint
npx tsc --noEmit --incremental false
npm run build
git status --short
```

Review the changes, then commit and push to `main` in your install repository. When the Vercel deployment finishes, check the admin sign-in and the file list at your production address. From the next version on, use the `Update` button on screen.

## Letting AI update an existing install

Open your install repository in a coding AI and send the request below as it is.

```text
Update this ShareDesk install to the latest stable version.

First read docs/UPDATE.md and check the current repository, branch, git status, origin, and Vercel connection. If an update workflow already exists, use the same GitHub Actions flow as the on-screen button; if there is none, use the one-time bootstrap in docs/UPDATE.md.

Do not change or print .env.local, OAuth values, Drive IDs, or the files, users, invitations, and notes inside Drive. If the updater reports a conflict because a file differs from the official code, do not overwrite it — explain the paths and the options, then stop.

If changes are needed, first create a GitHub issue for the update in this install repository, and only after npm test, npm run lint, npx tsc --noEmit --incremental false, and npm run build all pass, make a single commit that carries that issue number. Push only to the permitted install repository, and verify the connected Vercel Production deployment and the production address. Report automated checks and real production verification separately.
```

## Local personal use

An install used only locally, without Vercel, can check for a new version from its working folder.

```powershell
node scripts/sharedesk-update.mjs --check
```

To actually apply it, first make sure the Git working folder is clean, run `node scripts/sharedesk-update.mjs --apply`, and then run the check commands above again. Your local files live in `LOCAL_STORAGE_ROOT`, so back up that whole folder separately from the code update.
