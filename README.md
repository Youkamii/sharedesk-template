# ShareDesk

### Languages

**English** · [한국어](./README.ko.md) · [日本語](./README.ja.md) · [हिन्दी](./README.hi.md) · [中文](./README.zh.md)

ShareDesk is **a shared file space where several people use one person's Google Drive storage with their own Google accounts**. Only the host installs it, once. Participants simply sign in at the same address, enter an invitation code, and share the same files and folders.

![ShareDesk demo](./docs/sharedesk-demo.gif)

## Four wallpapers

| Dusk | Deep Night |
| :---: | :---: |
| ![Dusk wallpaper](./docs/sharedesk-wallpaper-dusk.png) | ![Deep Night wallpaper](./docs/sharedesk-wallpaper-night.png) |
| **Dawn** | **Night Tide** |
| ![Dawn wallpaper](./docs/sharedesk-wallpaper-dawn.png) | ![Night Tide wallpaper](./docs/sharedesk-wallpaper-tide.png) |

## What you can do

### Desktop and files

- Arrange files and folders like desktop icons, then open several folders as windows.
- Depending on your role, upload, download, rename, move, delete, and restore files.
- View photos, videos, audio, PDFs, and text right away, and edit `.txt` files together.
- Leave a shared note on every folder.
- Minimize or maximize every utility window except chat, which stays compact and only minimizes.

### Work together

- Bring people in with invitation codes and see who is currently online.
- Open chat from its own bottom-right button. While minimized, new messages gently flash the button and add an unread count.
- Set admins through `ADMIN_EMAILS`, then change each participant between Can edit, Can upload, and View only from the admin screen.

### Share and transfer

- Editors and admins can right-click a file or folder to copy a sign-in-free 1-hour link.
- **Additional features** opens Quick link, Generated links, and Download first. Chat remains a separate button.
- **Quick link** turns dropped files into 1-hour links. At expiry, checked files are queued for permanent deletion by cleanup; clear the check to keep one on the desktop.
- **Generated links** lists active links you can manage, so you can copy or stop them at any time.
- **Download first** makes opening a file download it instead of showing the preview when both are available.

### Capacity and personalization

- An admin can limit both one uploaded file and the total storage used by the current desk.
- A retro disk-style donut shows desk usage, uploads in progress, remaining desk capacity, and the host Drive totals beside the limits.
- The admin chooses among English, Korean, Japanese, Hindi, and Chinese, and can let each member choose their own.
- Pick whichever of the four wallpapers suits your mood; your choice is saved in your own browser.

## How is it shared?

```text
   One host's Google Drive
             ↕
  The same ShareDesk address
   ├─ Host's Google account
   ├─ Participant A's Google account
   └─ Participant B's Google account
```

Only the host's account connects to Google Drive. Participants sign in with their own Google accounts, but inside ShareDesk everyone shares the files and storage of the one Drive folder the host chose. ShareDesk never reads a participant's personal Drive files.

Shared state such as users, invitations, chat, folder notes, share-link records, settings, and icon layout is also stored in the host's Drive. No separate database is needed.

ShareDesk is designed for serverless hosting. Chat uses lightweight polling instead of a permanent WebSocket connection, so it works without an always-running server.

One install address is one desk; a single installation does not contain several desks. The same Google account can join several separate ShareDesk addresses, but their members, roles, limits, files, and chat never mix.

## Getting started

- **If setup feels daunting:** [Let AI build it for you](./docs/AI_INSTALL.md)
- **To run your own production server:** [Detailed install guide](./docs/INSTALL.md)
- **Already installed:** [Update guide](./docs/UPDATE.md)
- **Just for yourself on your own computer:** [Local personal use](./docs/LOCAL.md)

Invited participants install nothing. Sign in at the ShareDesk address your host sent you and enter the invitation code — that's all.

---

<div align="center">
<sub>Licensed under the <a href="LICENSE">MIT License</a> · Galmuri font under the <a href="public/fonts/Galmuri-LICENSE.txt">SIL OFL 1.1</a></sub>
</div>
