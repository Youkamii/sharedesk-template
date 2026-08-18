**English** · [한국어](./INSTALL.ko.md) · [日本語](./INSTALL.ja.md) · [हिन्दी](./INSTALL.hi.md) · [中文](./INSTALL.zh.md)

# ShareDesk production install guide

This guide walks you through opening a ShareDesk where several people share one host's Google Drive storage, each with their own Google account.

If Google Cloud or Vercel settings are unfamiliar, you do not have to follow all of this yourself. Send the request in [Let AI build it for you](./AI_INSTALL.md) to a coding AI, and it checks which steps are already done and walks you through one step at a time, only on the screens you have to handle yourself.

## First, which one are you?

### Participant

If you were invited to a ShareDesk somebody else created, **do not install anything from this guide.** Sign in with your own Google account at the ShareDesk address your host sent you and enter the invitation code. You need no GitHub account, no Vercel project, and no Google OAuth client.

### Host

Follow the steps below to offer your own Google Drive space, create a new ShareDesk address, and invite people. Only the host installs, once, and the participants then share that address and storage.

Each install connects its own host Git repository, Vercel project, Google OAuth client, and Drive root. That separation describes who owns an install; the first value ShareDesk delivers is several people sharing one Drive storage space. If you already set any of these up, carry on with them instead of creating new ones.

## The quick path for hosts

1. **Create the ShareDesk address:** use [Deploy with Vercel](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FYoukamii%2Fsharedesk-template&project-name=my-sharedesk&repository-name=my-sharedesk) to create your GitHub repository and Vercel project, and write down the Production address.
2. **Create the Google connection:** turn on the Drive API in Google Cloud and create a Web application OAuth client. Copy the exact scopes and callback addresses from [step 2](#2-google-cloud-setup).
3. **Connect the host Drive:** get the repository and run `npm ci` and `npm run setup`. If `.env.local` is missing, setup creates it for you. Enter the Client ID and secret, run it again, and the authorization page opens in your browser automatically. After you consent, finish with `npm run setup -- --finish`.
4. **Connect it to production:** move the required values setup filled in to your Vercel Production environment variables and redeploy.
5. **Check it with one other person:** confirm production sign-in and file saving first, then create an invitation code in `/admin`. Invite one person and check that both accounts see the same file — that finishes the core install. The Vercel Firewall comes afterwards, in the production hardening step.

ShareDesk never applies a new version on its own. After installation, the admin-only `Update` button in the taskbar shows a star only when a new version exists. Connecting an older install for the first time is covered in the [Update guide](./UPDATE.md).

Each step is described in detail below. Feel free to look up only the Google Cloud screen or the error you ran into.

## What counts as a finished install

The production install is finished once all of the following are true.

- Your Git repository and your Vercel project are connected.
- You have a Production address that does not change.
- The production callback is registered exactly in the Google OAuth client.
- The required production values are in the Vercel Production environment.
- Host Google sign-in works at the production address.
- A folder created in `/files` is still there after a refresh.
- The trash icon sits at the bottom right of the screen, separate from the taskbar, and pressing it lets you restore a deleted item.
- `/admin` opens and lets you choose an invitation code's `Valid for` and `Usage type`.
- One person joined with their own Google account using an invitation code.
- The host and the participant can see and download the same file from both accounts.

## What you need

- [Node.js](https://nodejs.org/) 20.9 or later
- Git
- A GitHub account
- A Vercel account
- A Google account and permission to create a Google Cloud project

## 1. Prepare the repository and a fixed production address

If the current repository's `origin` is already yours and already connected to a Vercel project, do not repeat this step. Check `git remote -v` and the Vercel project settings, then use the existing project.

If you have no repository and no Vercel project yet, create both with the button below.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FYoukamii%2Fsharedesk-template&project-name=my-sharedesk&repository-name=my-sharedesk)

To create only the repository first, without Vercel, use [Use this template](https://github.com/Youkamii/sharedesk-template/generate).

The first deployment can run with empty environment variables. Seeing the install notice instead of a sign-in button is normal. Write down these two addresses at this step.

- Your Git repository: for example `https://github.com/my-account/my-sharedesk`
- Your fixed Production address: for example `https://my-sharedesk.vercel.app`

Use the Production address that stays attached to the project, not a Preview address or a long deployment address that changes with every commit.

## 2. Google Cloud setup

### 2-1. The project and the Drive API

1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Select the project you want to use, or create a new one.
3. In `APIs & Services` → `Library`, enable the `Google Drive API`.

Keep the OAuth client and the Drive API in the same Cloud project.

### 2-2. Branding

Enter the following in `Google Auth Platform` → `Branding`.

- App name: for example `Our team ShareDesk`
- User support email
- Developer contact email

If your Google Cloud console is set to another language, `Branding`, `Audience`, `Data Access`, and `Clients` may appear translated.

### 2-3. Audience

Choose who may use the app in `Google Auth Platform` → `Audience`.

- `External` to invite personal Google accounts or people outside your organization
- `Internal` if you use it inside one Google Workspace organization only, depending on your organization's policy

For a production External app, press `Publish app` to switch to `In production` before running setup. If it is already `In production`, leave it as it is.

You can install from `Testing` too, but the ShareDesk host connection asks for `drive.file` together with offline access. A refresh token issued in that state usually expires after 7 days. If you already ran setup while in Testing, switch to In production first and then redo the host connection. Without good reason, do not discard a working token from an app that is already In production.

`In production` is a publishing status, separate from the token expiry policy for testing. It does not mean the app has been verified; depending on your Branding and the number of users, Google warnings or extra verification steps may still apply.

For the full status descriptions, see the [Google OAuth Audience guide](https://support.google.com/cloud/answer/15549945?hl=en).

### 2-4. Data Access

Add these four scopes in `Google Auth Platform` → `Data Access` → `Add or remove scopes`.

```text
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
https://www.googleapis.com/auth/drive.file
```

### 2-5. The Web application OAuth client

Check for an existing Web application client in `Google Auth Platform` → `Clients` first. If there is one you can use, do not create another — just add the missing addresses.

If you are creating a new one, set it up like this.

1. Application type: `Web application`
2. Name: for example `ShareDesk web`
3. `Authorized JavaScript origins`: leave empty
4. `Authorized redirect URIs`: register the three addresses below

```text
http://127.0.0.1:53682/callback
http://localhost:3000/api/auth/google/callback
https://my-sharedesk.vercel.app/api/auth/google/callback
```

Replace the domain in the last address with the real Production domain from step 1.

Do not put the production callback in `Authorized JavaScript origins`. A JavaScript origin cannot contain a path, and ShareDesk does not use that field. All three addresses go in `Authorized redirect URIs`.

A redirect address has to match exactly — `http`/`https`, host, port, path, and trailing slash. Google's [OAuth web server guide](https://developers.google.com/identity/protocols/oauth2/web-server#uri-validation) requires an exact match too.

Once the client is created, record the Client ID and Client secret somewhere safe. You need them in the next step. Never paste them into a public repository, a chat, an issue, or a screenshot.

## 3. Prepare the local environment file

If this repository is already open locally, start in that folder instead of cloning it again.

If you do not have it yet, clone the repository you created in step 1.

```powershell
git clone https://github.com/<your-github-account>/my-sharedesk.git
cd my-sharedesk
```

Install the dependencies and run setup once.

```powershell
npm ci
npm run setup
```

If `.env.local` is missing, a bare `npm run setup` creates the file with owner-only permissions and fills it with the contents of `.env.example`. A message saying the Client ID and secret are empty is normal. If `.env.local` already exists, setup checks its permissions without overwriting the contents.

To prepare only the environment file without starting setup, you can still use the older command `npm run setup -- --prepare-env`, which is kept for compatibility.

Enter these two values in `.env.local` yourself.

```dotenv
GOOGLE_CLIENT_ID=the-client-id-you-received
GOOGLE_CLIENT_SECRET=the-client-secret-you-received
```

Do not pass these values through a coding agent's chat or as command-line arguments.

## 4. Connect the host Drive

If your existing `.env.local` already has a valid `GOOGLE_REFRESH_TOKEN`, `DRIVE_ROOT_FOLDER_ID`, and `DRIVE_STATE_FOLDER_ID`, and they actually work, there is no need to run setup again. Follow the steps below only for a new install or when the connection has to be issued again.

### 4-1. Start the authorization

```powershell
npm run setup
```

1. Setup opens the Google authorization page in your default browser. If it does not open by itself, open the URL printed in the terminal yourself.
2. Sign in with the Google account that will host ShareDesk, and consent.
3. The browser goes to `http://127.0.0.1:53682/callback?...`.
4. A connection error in the browser is normal. Copy the whole address from the address bar.

The callback URL contains a single-use authorization code that is valid for a short time. Paste it only into the terminal on the same computer, and do not share it in a chat, an issue, or a screenshot.

### 4-2. Finish the authorization

```powershell
npm run setup -- --finish
```

When it asks, paste the whole callback URL you just copied. The URL is not written as a command argument, so the authorization code does not stay in your shell history.

If you are working with a coding agent, you type this yourself. The agent should not ask for the callback URL in the chat or read it back from the terminal output — it waits until you are done.

When setup finishes, these values are ready in `.env.local`.

- `ADMIN_EMAILS`
- `SESSION_SECRET`
- `STORAGE_DRIVER=drive`
- `GOOGLE_REFRESH_TOKEN`
- `DRIVE_ROOT_FOLDER_ID`
- `DRIVE_STATE_FOLDER_ID`

It also creates a `ShareDesk` root and a `.sharedesk` state folder in the host Drive. Existing state files are never overwritten arbitrarily.

## 5. Local check

```powershell
npm run dev
```

1. Open `http://localhost:3000`.
2. Sign in with the host Google account.
3. Create a folder in `/files` and check that it is still there after a refresh.
4. Check that `/admin` opens.

Everything so far is a local check. It does not mean the production deployment that other people can use is finished.

## 6. Vercel Production environment variables and redeploy

Open the existing Vercel project you created in step 1. In `Settings` → `Environment Variables`, put the values below into the Production environment.

| Name | Value |
|---|---|
| `ADMIN_EMAILS` | Admin Google email. Separate several with commas |
| `SESSION_SECRET` | The long random value setup generated |
| `STORAGE_DRIVER` | `drive` |
| `GOOGLE_CLIENT_ID` | The Web application Client ID |
| `GOOGLE_CLIENT_SECRET` | The Client secret |
| `GOOGLE_REFRESH_TOKEN` | The host refresh token setup received |
| `DRIVE_ROOT_FOLDER_ID` | The ID of the ShareDesk folder setup created |
| `DRIVE_STATE_FOLDER_ID` | The ID of the state folder setup created |
| `PUBLIC_BASE_URL` | The fixed Production origin. For example: `https://my-sharedesk.vercel.app` |
| `SHAREDESK_GITHUB_TOKEN` | (Optional) fine-grained PAT for one-click updates — see the [Update guide](./UPDATE.md) |

To reduce install mistakes, set `PUBLIC_BASE_URL=https://your-real-production-domain` explicitly in Vercel Production. Do not put this value in your local `.env.local`, because local app sign-in has to come back to `http://localhost:3000`.

If you leave `PUBLIC_BASE_URL` out, ShareDesk uses `VERCEL_PROJECT_PRODUCTION_URL` instead. If you rely on that, check that system environment variable exposure is turned on in the Vercel project.

`PUBLIC_BASE_URL` takes the origin only. No path, no trailing slash, no callback path, no Preview URL.

Add `ACCESS_KEYS` only when you use temporary guest keys. In drive mode, a guest who comes in with an access key is `View only`. Do not put `LOCAL_STORAGE_ROOT` or `SHAREDESK_SHARE_TEST_EMAIL` in the production environment. Never give any secret the `NEXT_PUBLIC_` prefix.

Redeploy Production after entering or changing environment variables. Environment variable changes do not reach an existing deployment on their own. For the details, see the [Vercel environment variables guide](https://vercel.com/docs/environment-variables).

## 7. Production check

Check these yourself at the fixed Production address.

1. Sign in with the host Google account.
2. Create a test folder in `/files` and check that it is still there after a refresh.
3. Delete the test folder, then press the trash icon at the bottom right to open the trash window and restore the folder. Check as well that the icon sits outside the taskbar and slips behind an open window when the two overlap.
4. Check that `/admin` opens.
5. On the invitation code screen, check that you can choose `Valid for` — `1 hour`, `24 hours`, `7 days`, `30 days` — and `Usage type` — `Single-use` or `Unlimited until expiry`. Check as well that you can choose the role a new member starts with: `Can edit` (default), `Can upload`, or `View only`.
6. Sign out and sign in again to confirm the production callback works.
7. Create one invitation code in `/admin`, and send the production address and the code to the one person you will share it with.
8. The participant signs in with their own Google account and enters the invitation code. Participants need no OAuth client and no Vercel project.
9. The host uploads one test file, and you check that the host and the participant can see and download the same file from both accounts.

In Drive mode, an item you move to the trash is permanently deleted after 30 days under [Google Drive's 30-day trash policy](https://support.google.com/drive/answer/14933051?hl=en), unless you delete it permanently yourself first. In `local` mode, which has no OAuth, ShareDesk permanently deletes items older than 30 days the next time the trash is opened.

An invited person is not installing a new ShareDesk — they are joining the shared file space the host has already created.

## 8. Protect production once it works

Once step 7 has confirmed sign-in, file saving, and one real invitation, protect the invitation code submission requests. The Firewall setting is a production hardening step, not an install step that makes ShareDesk work.

In your Vercel project's Firewall, create the Rate Limit rule below and press `Publish`.

If a Rate Limit rule already exists, check its conditions and purpose first. Do not overwrite another rule — check whether you can add a new one.

- Condition: `Request Path` equals `/api/invitations/code`
- Condition: `Method` equals `POST`
- Condition: Cookie `sharedesk_session` exists
- Action: `Rate Limit`
- Type: `Fixed Window`
- Key: `IP`
- Limit: `10` requests per `60 seconds`, `429` beyond that

All three conditions are needed so the limit applies to invitation code submissions only. Check the usage and pricing notes Vercel shows while you create the rule. For the setup screen, see the [Vercel WAF Rate Limiting guide](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting).

## Inviting and managing people

1. The host opens `/admin` at the production address.
2. Choose the invitation code's `Valid for`: `1 hour`, `24 hours`, `7 days`, or `30 days`.
3. Choose the `Usage type`: `Single-use` or `Unlimited until expiry`.
4. Choose the role the new member starts with: `Can edit` (default), `Can upload`, or `View only`.
5. Pass the code you created and the production address to the participant.
6. The participant signs in with their own Google account and enters the code. Whoever joins starts with the role chosen on the code.

An invitation code is not tied to a particular email in advance. The name and email come from the Google sign-in of whoever actually enters the code.

- **Single-use:** spent as soon as one person joins successfully.
- **Unlimited until expiry:** several people can share it until it expires or the host turns it off.

### The four roles

| Role | What they can do |
|---|---|
| Admin | Every file operation and user management. An account listed in `ADMIN_EMAILS` is always an admin, whatever role is stored. |
| Can edit | Upload, download, delete, move, rename; edit notepads and folder notes; work with the trash; create new notepads |
| Can upload | Upload, download, create folders, move icon positions |
| View only | Viewing and downloading only |

A role is not a value that gets fixed once at sign-up. You can change it anytime in the `Role` column of the user table in `/admin`.

The admin screen lets you block a user or move them back to pending, and sign out one device or every session of that user. If you changed `ADMIN_EMAILS`, edit the Vercel environment variable and redeploy.

## Updating after installation

ShareDesk never applies a new version on its own. When a new version is found, it puts a star on the admin-only `Update` button in the taskbar. Pressing the button shows the current and latest versions inside ShareDesk first. In an install that has `SHAREDESK_GITHUB_TOKEN` in Vercel, an admin who presses `Update now` starts the update right inside the app and sees the progress there. An install without the token opens the GitHub Actions page as before, where you press `Run workflow` to start. Either way, the commit lands on `main` only when the checks pass, and the connected Vercel redeploys.

Drive files and shared state, `.env.local`, and Vercel environment variables are not part of a code update. For the one-time migration of an install created before the update feature arrived, and for resolving conflicts, follow [ShareDesk Update](./UPDATE.md).

## Sharing directly through Google Drive

When an admin right-clicks a file or folder and presses **Share via Google Drive**, they can give an approved user view or edit permission. This does not hide or reveal an item inside ShareDesk — it is a real Drive permission that also appears in the recipient's `Shared with me` in Google Drive.

Folder permissions carry down to child items according to Google Drive's rules. Check the recipient's `Shared with me` listing and the difference between view and edit permission yourself with a separate Google account. For the automated way to check, see [the real Drive checks in the local guide](./LOCAL.md#real-drive-checks).

## Troubleshooting

| Symptom | What to check |
|---|---|
| `redirect_uri_mismatch` | Compare the `redirect_uri` from the error character by character with `Authorized redirect URIs` on the same Client ID in Google Auth Platform. Not JavaScript origins. |
| `Access blocked` | Check that the Audience is External. If you keep Testing, the account you sign in with has to be added as a Test user. |
| `org_internal` | You signed in to an Internal app with an account outside the organization. Switch to External, or use an organization account. |
| `127.0.0.1` connection error after consent | Normal during setup. Copy the whole address bar and paste it into the question from `npm run setup -- --finish`. |
| Setup reports that no `refresh_token` was received | Check the existing connection and the Audience status first. Only when you really need a new token and the existing connection is preventing it, remove the permission in [your Google account's connected apps](https://myaccount.google.com/permissions) and run setup again. |
| The Drive connection drops after about 7 days | Check first whether the Audience was Testing. If the host token came from Testing, switch to In production and run setup again. If it is already In production, do not discard the token first — look for the actual authentication error. |
| The Drive API returns 403 | Check that the Google Drive API is enabled in the same Cloud project where you created the OAuth client. Check as well whether a Workspace admin policy blocks external apps. |
| Sign-in fails on Vercel only | Check the Production environment variables, the fixed production origin, the production redirect URI in Google, and whether you redeployed after changing a variable. |
| The invitation code is rejected | Check the code's expiry, active status, and usage type in `/admin`. A single-use code may already be spent after someone else's first successful sign-up. |
| Only certain Workspace accounts fail | Check the organization admin's third-party app access restrictions, or Google Advanced Protection policies. |
| Admin sign-in asks for an invitation | Check that the signed-in email matches `ADMIN_EMAILS` exactly, and redeploy if you changed the value. |
| Setup stops because several state files share a name | Look at the JSON files in `ShareDesk/.sharedesk/` in Drive, compare their contents, keep only the one you want to preserve, and run setup again. |

### Is it all right to run setup again?

If `.env.local` already has `DRIVE_ROOT_FOLDER_ID` and the state folder ID, setup carries on using that folder and the existing state files. If several core state files share a name, it stops instead of picking one at random, so check their contents in Drive and keep only one.

If you replaced the Client secret, or need to receive the refresh token again, update the Client ID and secret in `.env.local` first and then start setup again. Do not discard a working connection on a guess.

## Storage structure and limits

- ShareDesk works inside the Drive root folder chosen during setup. If the host moves an item out of that root on the Drive website, ShareDesk can no longer reach it.
- Creating or renaming an item to a name that already exists in the same folder is rejected.
- Formats that can run scripts, such as HTML and SVG, are downloaded instead of being shown straight in the browser.
- Google Docs, Sheets, Slides, and Drawings are converted to PDF for preview.
- Free Google Drive storage and the trash retention period follow the Google policy of the host's account.

In Drive mode, `ShareDesk/.sharedesk/` stores users and invitations, who is currently online, Drive share permissions, folder notes, and icon layout. The folder is hidden from the normal file list. When the same state is changed at the same time, the first save is kept and the later request ends as a conflict, so that request reads the latest state again.

To install with a coding AI, use the [AI install guide](./AI_INSTALL.md). Development and check commands, and the full environment variable table, are collected separately in [Local personal use](./LOCAL.md#developer-reference).
