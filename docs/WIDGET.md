**English** · [한국어](./WIDGET.ko.md) · [日本語](./WIDGET.ja.md) · [हिन्दी](./WIDGET.hi.md) · [中文](./WIDGET.zh.md)

# ShareDesk desktop widget

The ShareDesk widget is an optional small window that keeps your desk in a corner of your desktop. Nothing requires it: every ShareDesk feature keeps working in the browser. The widget is not a separate app but **a dedicated window that opens the same desk address**, and the desk server draws the screen. When the host updates ShareDesk, the widget screen changes right away.

Four things set the widget apart from a browser tab:

- It is always on screen. Drag files from Explorer or Finder onto it and they land on the desk.
- It floats above other windows (default) or hides in the tray.
- A **Window** mode shows who is online and the most recent uploads at a glance.
- You can run several widgets, each signed in to a different desk with a different account.

Chat is not part of the widget. Bigger jobs such as previews, renaming and the trash open in the browser through the widget's `↗` button.

## Install

1. Download the installer for your operating system from the [widget downloads](https://github.com/Youkamii/sharedesk-template/releases/tag/widget). On Windows it is [`sharedesk-widget-windows-x64-setup.exe`](https://github.com/Youkamii/sharedesk-template/releases/download/widget/sharedesk-widget-windows-x64-setup.exe), a fixed address that always points at the latest version. The macOS file appears once it has been built and uploaded from a Mac. Members can also get it from inside the desk: open the `«` handle on the right edge and look under **Desktop widget**.
2. Run the installer. No administrator rights are needed.
3. On first launch the widget asks for the **desk address**. Paste the ShareDesk address your host gave you (for example `https://desk.example.com`) and press `Open desk`.
4. Sign in exactly as you would in a browser. Google sign-in and the invite code happen inside the widget window.

If Windows shows an "unknown publisher" warning, continue with `More info → Run anyway`. The installer is not code-signed, but the widget's automatic updates are verified with a separate signing key.

## Use

- Drag the top band to move the window and drag its edges to resize it.
- **Drawer**: the desk's files and folders in a grid. Drop files to upload them into the folder you are looking at. Double-click a folder to enter it and use `← Back` to leave. Double-clicking a file downloads it. The right-click menu offers download, a 1-hour link and file upload.
- **Window**: who is online now, the five most recent uploads, and the desk storage for admins. Click a file to download it.
- `↗` opens the desk in your default browser. `–` hides the widget in the tray; click the tray icon to bring it back.
- **Wall**: press `Wall` on the top band and the widget tucks into the nearer screen edge, leaving only a small handle (press it again to turn it off). Point at the handle to bring the widget out; it slides back a moment after the pointer leaves. Drag a file onto the handle to open the widget, then drop it into the Drawer to upload it. Drag the band to the other side to stick the widget to that edge.
- Tray icon right-click menu: show/hide widget, always on top, start at login, change desk address, open desk in browser, check for updates, quit.

The widget checks the desk at the same pace as a browser tab. While hidden in the tray it checks far less often to spare the host's server.

## Several desks, several accounts

One widget holds one desk address. To keep another desk beside it, launch a second widget with a separate **profile**. Each profile stores its own sign-in and desk address, so the same Google account can be signed in to desk A and desk B at the same time.

Append the profile name to the shortcut target:

```text
"C:\Users\me\AppData\Local\ShareDesk Widget\sharedesk-widget.exe" --profile work
```

Profile names may use letters, digits, `-` and `_`. Without one, the profile is `default`. Add `--desk https://desk.example.com` to skip the first-run screen and open that address directly.

## Automatic updates

Shortly after launch, and whenever you choose `Check for updates` in the tray menu, the widget looks for a new shell version. If there is one, `Install update` appears in the tray menu; choosing it downloads, installs and relaunches. The widget never restarts on its own.

The desk screen itself comes from the server, so it is always current regardless of shell updates.

## Data location and removal

Profiles (cookies, desk address, window position) live under your user folder.

- Windows: `%APPDATA%\com.youkamii.sharedesk-widget\profiles\<profile>`
- macOS: `~/Library/Application Support/com.youkamii.sharedesk-widget/profiles/<profile>`

Uninstalling leaves this folder behind, so delete it as well for a full removal. The widget talks only to the desk server, to Google when you sign in, and to the public GitHub release when it checks for and downloads updates. That is the same traffic the desk screen makes in a browser.

## Publishing (for hosts)

The widget shell lives in this repository's `widget/` folder and is published to the fixed `widget` release (prerelease) of the public template repository. The publishing machine needs Rust, Node, a signed-in `gh` and the signing key (`~/.tauri/sharedesk-widget.key`).

```powershell
node scripts/widget-release.mjs --dry-run   # build, sign and inspect latest.json
node scripts/widget-release.mjs             # upload to the release
```

When bumping the version, change it in `widget/src-tauri/tauri.conf.json`, `widget/src-tauri/Cargo.toml` and `widget/package.json` together. Running the same command on a Mac adds the macOS file to the same release.
