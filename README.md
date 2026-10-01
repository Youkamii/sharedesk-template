<p align="center">
  <img src="./docs/readme/hero.png" width="100%" alt="ShareDesk — one person's Google Drive turned into a shared pixel-art desktop, shown with the optional desktop widget" />
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Youkamii/sharedesk-template?style=flat-square&labelColor=10172b&color=f2a56f" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/Next.js-16-2f4670?style=flat-square&labelColor=10172b&logo=nextdotjs&logoColor=white" alt="Next.js 16" />
  <img src="https://img.shields.io/badge/Vercel-serverless-2f4670?style=flat-square&labelColor=10172b&logo=vercel&logoColor=white" alt="Vercel serverless" />
  <img src="https://img.shields.io/badge/Google%20Drive-storage-2f4670?style=flat-square&labelColor=10172b&logo=googledrive&logoColor=white" alt="Google Drive storage" />
  <a href="#desktop-widget"><img src="https://img.shields.io/badge/Widget-Windows-2f4670?style=flat-square&labelColor=10172b" alt="Desktop widget for Windows" /></a>
</p>

<p align="center">
  <strong>A pixel-art desktop where a whole group shares one Google Drive.</strong><br />
  The host sets it up once. Everyone else opens the address and signs in with their own Google account.
</p>

<p align="center">
  <a href="#what-is-sharedesk">What it is</a> ·
  <a href="#the-desk">Desk</a> ·
  <a href="#sharing-and-spaces">Sharing</a> ·
  <a href="#four-wallpapers">Wallpapers</a> ·
  <a href="#desktop-widget">Widget</a> ·
  <a href="#getting-started">Get started</a> ·
  <a href="#how-it-is-shared">How it is shared</a>
</p>

<div align="center">

**English** · [한국어](./README.ko.md) · [日本語](./README.ja.md) · [हिन्दी](./README.hi.md) · [中文](./README.zh.md)

</div>

<br />

## What is ShareDesk?

ShareDesk is **a shared file space where several people use one person's Google Drive storage with their own Google accounts**. Only the host installs it, once. Everyone else opens the same address, signs in with Google, enters an invitation code the first time, and then works on the same files and folders on a pixel-art desktop in the browser.

![ShareDesk demo](./docs/sharedesk-demo.gif)

<sub>The demo was recorded with the Korean interface. ShareDesk speaks English, Korean, Japanese, Hindi and Chinese.</sub>

<details>
<summary><strong>How one Drive becomes a shared desk</strong></summary>
<br />

```text
   One host's Google Drive
             ↕
  The same ShareDesk address
   ├─ Host's Google account
   ├─ Participant A's Google account
   └─ Participant B's Google account
```

Only the host's account is connected to Google Drive. Participants sign in with their own Google accounts, but inside ShareDesk everyone works in the one Drive folder the host chose and shares its storage.
</details>

<br />

## The desk

<p align="center">
  <img src="./docs/readme/desk.png" width="100%" alt="The ShareDesk desk in the browser: colored folder icons, a Photos folder window with a photo in its side preview, and the list of people currently online" />
</p>

- **Icons and windows** — arrange files and folders like icons on a desktop, give folders one of seven colors, and open several folders as windows you can minimize and maximize. The trash sits in the bottom-right corner and keeps deleted items for 30 days.
- **Preview and edit together** — photos, videos, audio, PDFs and text open in place, and `.txt` files can be edited together. Every folder can carry a shared note.
- **Find things** — search the whole desk or one folder with its subfolders, and open **Properties** to see who uploaded a file and how many times it was downloaded.
- **Upload your way** — drag in files or whole folders. If a refresh cuts an upload off, open the **uploads to resume** chip on the taskbar and drop the same file on that panel (or use **Select file again**) to continue; dropping it on the desk starts a new upload.
- **People** — see who is online, chat from the bottom-right button (it flashes and counts unread messages while minimized), and choose the nickname others see.
- **Roles** — admins are set with `ADMIN_EMAILS`; everyone else is Can edit, Can upload or View only, changed per person on the admin screen.
- **Admin screen** — invitation codes (single-use, or unlimited until they expire), users and their signed-in devices, an activity log, public folders, desk language, storage limits with a retro disk-style donut, wallpaper and updates.
- **On a phone** — a narrow screen turns the desk into a simple list where you can upload, take a photo or make a folder.

<br />

## Sharing and spaces

<img align="right" width="300" src="./docs/readme/sharing.png" alt="The sidebar opened from the right edge: Create quick link, Created links, Receive from another desk, Enter public folders and Desktop widget" />

Open the `«` handle on the right edge of the desk. The sidebar holds links, receiving, public folders and the widget download.

- **Share links** — editors and admins right-click a file or folder to copy a 1-hour link right away, or open **Manage share links…** to choose 1 hour, 24 hours, 7 days or 30 days (7 days by default). Links open without signing in.
- **Quick link** — drop files and each gets a 1-hour link as soon as its upload finishes. With the window in front, Ctrl+V uploads a copied screenshot the same way. Checked files are deleted when the hour is up; clear the check to keep one on the desk.
- **Created links** — active links in one list, to copy again or stop sharing. Members see their own links; admins see all of them.
- **QR codes** — share links, quick links, invitation codes and public folder addresses can be shown as a QR code drawn in the browser, so a phone can pick them up from the screen.
- **Receive from another desk** — paste a share link made on another ShareDesk to copy that file or folder into this desk.
- **Public folders** — the admin turns a folder into a drop box that anyone with the address can open to download and upload without signing in, within size, file-count and opening-hour limits. Members find them under **Enter public folders**.
- **Spaces** — an admin can open more desks in the same install, each at its own address such as `/team/files`, with its own members, roles, files and chat. People see only the spaces they were added to; links and public folders stay on the main desk for now.
- **Download first** — a taskbar checkbox that makes opening a file download it instead of previewing it.

<br clear="all" />

## Four wallpapers

Everyone picks a wallpaper for their own screen; the choice is saved in that browser.

| Dusk | Deep Night |
| :---: | :---: |
| ![Dusk wallpaper](./docs/sharedesk-wallpaper-dusk.png) | ![Deep Night wallpaper](./docs/sharedesk-wallpaper-night.png) |
| **Dawn** | **Night Tide** |
| ![Dawn wallpaper](./docs/sharedesk-wallpaper-dawn.png) | ![Night Tide wallpaper](./docs/sharedesk-wallpaper-tide.png) |

<br />

## Desktop widget

<p align="center">
  <img src="./docs/readme/widget.png" width="100%" alt="Four widget scenes: the Drawer and Window modes, Wall mode folded into a handle and slid out, Pin mode behind another window, and the handle's transfer gauge filling up" />
</p>

<p align="center">
  <a href="https://github.com/Youkamii/sharedesk-template/releases/download/widget/sharedesk-widget-windows-x64-setup.exe"><img src="https://img.shields.io/badge/Windows%20x64-Download%20the%20widget-f2a56f?style=for-the-badge&labelColor=10172b" alt="Download the widget for Windows x64" /></a>
</p>

The widget is optional: a small window that opens your desk's own address, so the desk server draws it and everything keeps working in the browser without it. Details are in [Desktop widget](./docs/WIDGET.md).

- **Same download everywhere** — the button above always points at the latest Windows installer, and members find the same download in the desk sidebar under **Desktop widget**. macOS will follow once it has been built and uploaded from a Mac.
- **Drawer and Window** — the Drawer is a file grid: drop files to upload them into the folder you are looking at. Window shows who is online and the five latest uploads, plus desk storage for admins.
- **Wall** — tucks the widget into the nearer screen edge as a small handle. Point at the handle, or drag a file onto it, and the widget slides out; while it is folded, clicks beside the handle go to the window behind.
- **Pin** — fixes the widget to the desktop like a pushpin, behind your other windows and above the desktop. Wall and Pin are never on at the same time.
- **Drag out** — on Windows, drag a file icon from the Drawer onto a folder in Explorer to download it there.
- **Transfer gauge** — if the widget folds while files are moving, the handle's border fills green with the progress, and turns red for a moment if a transfer failed.
- **Updates and profiles** — the widget checks for new versions and verifies their signature. Choose **Install update** in the tray menu and it installs and relaunches; it never restarts before you choose. Run one widget per profile to keep several desks or accounts side by side.

> [!NOTE]
> Wall, Pin, drag-out and the transfer gauge arrive with newer widget versions. On an older widget, pressing Wall or Pin shows an update notice, and the widget's update check offers the newer version in the tray menu once it is published.

<br />

## Getting started

Invited participants install nothing. Open the ShareDesk address your host sent you, sign in with your own Google account, and enter the invitation code the first time — that's all.

Hosts start here:

- **If setup feels daunting:** [Let AI build it for you](./docs/AI_INSTALL.md)
- **To run your own production server:** [Detailed install guide](./docs/INSTALL.md)
- **Already installed:** [Update guide](./docs/UPDATE.md) — a star on the taskbar's `Update` button tells the admin a new version is out
- **Just for yourself on your own computer:** [Local personal use](./docs/LOCAL.md)
- **Optional:** [Desktop widget](./docs/WIDGET.md)

<br />

## How it is shared

- **One Drive connection.** Only the host's Google account is connected to Google Drive. ShareDesk never reads a participant's personal Drive files.
- **No separate database.** Users, invitations, chat, folder notes, link records, settings and icon layout are stored in the host's Drive as well.
- **Serverless.** ShareDesk is built for serverless hosting. Chat and presence use light polling instead of a permanent WebSocket connection, so no always-on server is needed.
- **Desks stay apart.** The same Google account can join several ShareDesk addresses, and their members, roles, files and chat never mix.

> [!NOTE]
> The Windows widget installer is not code-signed yet, so Windows may warn about an unknown publisher. Widget updates are checked against a separate signing key, and the widget only talks to your desk, to Google when you sign in, and to the public GitHub release for updates.

<br />

---

<div align="center">
<sub>Licensed under the <a href="LICENSE">MIT License</a> · Galmuri font under the <a href="public/fonts/Galmuri-LICENSE.txt">SIL OFL 1.1</a></sub>
</div>
