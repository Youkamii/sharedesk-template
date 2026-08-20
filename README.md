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

- Arrange files and folders like desktop icons, and open folders as windows to organize them together.
- Depending on your role, upload, download, and rename files, move them between folders, and restore them from the trash.
- View photos, videos, audio, PDFs, and text right away, and edit `.txt` files together.
- Leave a shared note on every folder.
- Bring people in with invitation codes and see who is currently online.
- Chat with desk members and see how many messages arrived while the chat window was minimized.
- Right-click a file or folder for a sign-in-free 1-hour share link, then stop any active link from the link list.
- Drop files into Quick link to receive 1-hour links immediately. Keep the default check to delete each file after an hour, or clear it to keep the file on the desktop.
- Let an admin limit both one uploaded file and the total storage used by the current desk.
- Give each person one of four roles — Admin, Can edit, Can upload, View only — and change it anytime from the admin screen.
- Five interface languages — English, Korean, Japanese, Hindi, and Chinese. The admin sets the desk language in the Settings tab (English by default), and turning on Allow personal language lets each member pick their own.
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

Shared state such as users, invitations, folder notes, and icon layout is also stored in the host's Drive. No separate database is needed.

One install address is one desk. The same Google account can join several separate ShareDesk addresses, but their members, roles, limits, and chat never mix.

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
