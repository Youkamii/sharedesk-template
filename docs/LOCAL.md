**English** · [한국어](./LOCAL.ko.md) · [日本語](./LOCAL.ja.md) · [हिन्दी](./LOCAL.hi.md) · [中文](./LOCAL.zh.md)

# ShareDesk local personal use

This is how to use the ShareDesk screen and file features on your own computer, without Google OAuth or Vercel. Files are stored in a local folder on this computer instead of Google Drive.

This way of running it suits personal use and development checks. To build a production environment where several people join with their own Google accounts, follow the [production install guide](./INSTALL.md). If the install feels hard, you can use [Let AI build it for you](./AI_INSTALL.md).

Replacing a local install you already have with a new version is covered separately in the [update guide](./UPDATE.md#local-personal-use).

## What you need

- [Node.js](https://nodejs.org/) 20.9 or later
- Git
- A Windows, macOS, or Linux computer where you can open a terminal

Check the versions first.

```powershell
node --version
npm --version
git --version
```

## Install

If you already have this repository open locally, skip `git clone` and `cd`.

```powershell
git clone https://github.com/Youkamii/sharedesk-template.git
cd sharedesk-template
npm ci
npm run setup -- --prepare-env
```

The last command prepares `.env.local`. If the file already exists, it checks the access permissions without overwriting the contents.

## Local environment settings

Fill in these four values in `.env.local` at the project root.

```dotenv
STORAGE_DRIVER=local
LOCAL_STORAGE_ROOT=.devstorage
SESSION_SECRET=a-long-random-string-of-sixteen-or-more-characters-for-local-use-only
ACCESS_KEYS=my-local-access-key-to-type-in
```

- `STORAGE_DRIVER=local` uses a local folder instead of Google Drive.
- `LOCAL_STORAGE_ROOT=.devstorage` stores files and state in the `.devstorage` folder inside the project.
- `SESSION_SECRET` has to be 16 characters or longer. It signs the sign-in cookie.
- `ACCESS_KEYS` is the access key you type on the first screen. To use several, separate them with commas.

If you need a random string, you can run the command below in a local terminal. Do not post the output in a chat or an issue — put it straight into `.env.local`.

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

The Google-related values in `.env.local` can stay empty in local mode. `.env.local` is excluded from Git and must never be pushed to a public repository.

## Running it

```powershell
npm run dev
```

Open `http://localhost:3000` in your browser and enter one of the `ACCESS_KEYS` values you wrote in `.env.local`.

An access key in local mode grants `Can edit` permission, so you can create and edit the files you need for personal use.

In this mode you cannot check Google sign-in, joining with an invitation code, or real Drive sharing.

Once you can do all of the following, the local run is working.

1. The `/files` desktop opens.
2. You can create a folder and upload a file.
3. Folders and files are still there after a refresh.
4. You can throw a file in the trash and restore it from the trash at the bottom right of the screen.
5. You can create and edit `.txt` files and folder notes.

To stop the server, press `Ctrl+C` in the terminal where it is running.

To check the production build on your own computer, run it like this.

```powershell
npm run build
npm start
```

## File storage and backup

If `LOCAL_STORAGE_ROOT` is a relative path, it is resolved from the project folder where you started ShareDesk. With the default settings, both the real files and the state sit under `.devstorage/`.

```text
.devstorage/
├── the files and folders you create
└── .sharedesk/
    ├── users, invitations, and presence state
    ├── folder notes and icon layout
    └── trash and local sharing state
```

`.sharedesk` is an internal folder ShareDesk uses, so it does not appear on the files screen. If you back up only part of that folder, you can lose state such as notes, icon positions, and the trash, so **back up the whole `LOCAL_STORAGE_ROOT`**.

The backup order is as follows.

1. Stop the running server with `Ctrl+C`.
2. Copy the whole `.devstorage` folder — or the `LOCAL_STORAGE_ROOT` you chose — to another drive or a backup folder.
3. If you need to keep the same access keys and sign-in signature, keep `.env.local` too, in a separate place that is not public.

In Windows PowerShell you can copy it like this, after changing the destination path to suit your setup.

```powershell
New-Item -ItemType Directory -Force -Path 'D:\ShareDesk-Backup'
Copy-Item -Recurse -Force -LiteralPath '.devstorage' -Destination 'D:\ShareDesk-Backup\devstorage'
```

When restoring, stop the server first as well, put the whole backed-up folder in place of the existing `LOCAL_STORAGE_ROOT`, and start again. A backup copied while the server was writing files can hold state from mismatched points in time.

## What is different in local mode

- Google sign-in and joining with an invitation code are not used. You come in with `ACCESS_KEYS`.
- Files use the disk of the computer running ShareDesk, not Google Drive storage.
- **Share via Google Drive** does not create a real Google permission. It only exists to check the state in local mode.
- PDF conversion previews for Google Docs, Sheets, Slides, and Drawings are unavailable.
- Formats that can run scripts, such as HTML and SVG, are not opened directly but offered as a safe download.
- Creating or renaming an item to a name that already exists in the same folder is rejected instead of overwriting.
- Trash items older than 30 days are deleted completely the next time the trash is opened.
- Paths outside `LOCAL_STORAGE_ROOT` and the internal `.sharedesk` folder cannot be opened from the files screen.
- Do not use local mode for a Vercel production deployment. Use `STORAGE_DRIVER=drive` to configure a production environment that several people share.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `npm ci` rejects the Node version | Check that `node --version` is 20.9 or later, and upgrade Node.js. |
| The server reports that `SESSION_SECRET` is missing or too short | Change `SESSION_SECRET` in `.env.local` to a string of 16 characters or more and restart the server. |
| The access key is rejected | Check the spelling and comma separation of `ACCESS_KEYS` in `.env.local` and restart the server. |
| Files are not in the folder you expected | Check that you started the server from the repository root, and check the `LOCAL_STORAGE_ROOT` value. A relative path is resolved from the current project folder. |
| Changes to `.env.local` have no effect | Stop the running dev server and run `npm run dev` again. |
| An error saying port 3000 is in use | Stop the ShareDesk dev server you started earlier, or another program, and run it again. |
| Files disappeared after deleting `.devstorage` | That is the real storage folder in local mode. Stop the server and restore the full backup to the same place. |
| The server reports that the `STORAGE_DRIVER` value is not valid | Only lowercase `local` or `drive` is allowed. For personal local use, set it to `local`. |

## Developer reference

### npm commands

| Command | What it does |
|---|---|
| `npm run dev` | Runs the Next.js development server. |
| `npm run build` | Checks that the production build is produced. |
| `npm start` | Runs the production build made by `npm run build`. |
| `npm run lint` | Runs the ESLint checks. |
| `npm test` | Runs the repository's automated tests. |
| `npm run setup -- --prepare-env` | Prepares `.env.local`. Existing contents are not overwritten. |
| `npm run setup` | Starts the host Google authorization. If `.env.local` is missing, it prepares it first. |
| `npm run setup:finish` | Completes the host Drive connection with a callback URL the user pastes into the local terminal. The URL is not attached as a command argument. |
| `npm run setup -- --check` | Checks that the Client ID and secret can be read and an authorization URL can be built. |
| `npm run test:drive-operations` | Checks create, upload, download, rename, move, delete, and restore on a real Drive. |
| `npm run test:drive-preview` | Checks Google Docs PDF conversion and video Range responses on a real Drive. |
| `npm run test:drive-sharing` | Checks creating, changing, and revoking view and edit permissions on a real Drive. |

To check TypeScript on its own, use this command.

```powershell
npx tsc --noEmit --incremental false
```

### Environment variables

| Variable | Where it is used | Description |
|---|---|---|
| `ADMIN_EMAILS` | Drive production | Admin Google emails. Separate several with commas. Setup puts the host email in. |
| `ACCESS_KEYS` | Optional, recommended for local | Comma-separated access keys for temporary guests. In local personal use this key grants `Can edit` permission, while a guest who uses an access key in production (drive) is `View only`. |
| `SESSION_SECRET` | Required | The secret that signs the sign-in cookie. It has to be 16 characters or longer. |
| `STORAGE_DRIVER` | Required in practice | `local` or `drive`. If left empty, it is decided by whether a refresh token exists, but stating it explicitly is safer. |
| `LOCAL_STORAGE_ROOT` | local only | The path where local files and state are stored. The default is `.devstorage`. |
| `PUBLIC_BASE_URL` | Conditional, Drive production | The origin of a custom domain or the fixed production address. No path and no trailing slash. |
| `GOOGLE_CLIENT_ID` | Drive production | The OAuth Client ID of the Web application type. |
| `GOOGLE_CLIENT_SECRET` | Drive production | The OAuth Client secret. |
| `GOOGLE_REFRESH_TOKEN` | Drive production | The host offline token setup received. |
| `DRIVE_ROOT_FOLDER_ID` | Drive production | The ID of the host Drive root ShareDesk manages. |
| `DRIVE_STATE_FOLDER_ID` | Drive production | The ID of the `.sharedesk` state folder inside the root. |
| `SHAREDESK_DEFAULT_LOCALE` | Optional | The default desk language (en/ko/ja/hi/zh). Starts in English when unset. |
| `SHAREDESK_GITHUB_TOKEN` | Optional | The fine-grained PAT for one-click updates. To test one-click updates locally, you also need `SHAREDESK_GITHUB_REPOSITORY` (below). |
| `SHAREDESK_GITHUB_REPOSITORY` | Optional | The install repository to update (`owner/repository`). Outside Vercel (locally) there is no repository information, so set it yourself for a one-click test. |
| `SHAREDESK_SHARE_TEST_EMAIL` | Real checks only | A separate approved Google account that receives the sharing checks. Do not put it in the production Vercel environment. |
| `SHAREDESK_TRACE` | Development checks | When it is not empty, some Drive calls and icon layout save times are written to the server log. |

If you use the default Vercel domain and leave `PUBLIC_BASE_URL` empty, the app uses `VERCEL_PROJECT_PRODUCTION_URL`, which Vercel provides. That is a Vercel system environment variable, not a value you enter. The values and callback addresses production needs are collected in the [production install guide](./INSTALL.md).

### Real Drive checks

The three commands below are not local mode checks. They use the real Google Drive settings in `.env.local` to create test files and change permissions. Run them on a ShareDesk root you can verify separately from your personal working files.

This checks the basic file operations.

```powershell
npm run test:drive-operations
```

The check covers creating a folder, uploading through the server, downloading whole files, renaming, moving between folders, uploading directly from the browser, and moving to the trash, restoring, and deleting permanently. It then cleans up the items it created. If cleanup fails, check the `sharedesk-operations-test-*` folders in Drive yourself.

This checks previews.

```powershell
npm run test:drive-preview
```

The check confirms that Google Docs, Sheets, Slides, and Drawings download as PDF and that a partial video request returns HTTP 206, then cleans up the Drive items it used.

To check sharing permissions, first approve a separate Google account through a ShareDesk invitation and put that email in `.env.local`.

```dotenv
SHAREDESK_SHARE_TEST_EMAIL=recipient@example.com
```

```powershell
npm run test:drive-sharing
```

The sharing check confirms creating view permission, changing it to edit permission, revoking it, and updating the ShareDesk sharing ledger, then cleans up the files and permissions it used.

Even when the automated checks pass, you still have to confirm with a separate account whether the item really shows up in the recipient's `Shared with me` in Google Drive, and whether editing is refused with view permission and allowed with edit permission.

### State storage and concurrent changes

Drive mode stores users and invitations, presence state, the Drive sharing ledger, folder notes, icon layout, and trash state in `ShareDesk/.sharedesk/`, and local mode in `LOCAL_STORAGE_ROOT/.sharedesk/`. The folder is hidden from the normal file list and cannot be opened directly.

For changes where the last version seen matters, such as state files and folder moves, the first of two simultaneous saves is kept. The later request ends as a conflict and reads the latest state again.

### Current limits

- ShareDesk works inside the configured Drive or local root.
- The same name in the same folder is not allowed.
- HTML and SVG are downloaded instead of being previewed directly.
- Only Google Docs, Sheets, Slides, and Drawings support PDF conversion previews.
- Drive storage and the Drive trash retention period follow the host Google account's policy.
- The local trash deletes items older than 30 days completely the next time the trash is opened.

Before making changes, run `npm test`, `npm run lint`, `npx tsc --noEmit --incremental false`, and `npm run build`. When reporting a bug, write down the steps to reproduce and your browser and Node.js versions, but do not attach `.env.local`, the OAuth callback URL, tokens, or the Client secret.
