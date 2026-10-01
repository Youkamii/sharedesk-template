<p align="center">
  <img src="./docs/readme/hero.png" width="100%" alt="ShareDesk —— 把一个人的 Google Drive 变成大家共用的像素风桌面，旁边是可选的桌面小组件" />
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Youkamii/sharedesk-template?style=flat-square&labelColor=10172b&color=f2a56f" alt="MIT 许可证" /></a>
  <img src="https://img.shields.io/badge/Next.js-16-2f4670?style=flat-square&labelColor=10172b&logo=nextdotjs&logoColor=white" alt="Next.js 16" />
  <img src="https://img.shields.io/badge/Vercel-serverless-2f4670?style=flat-square&labelColor=10172b&logo=vercel&logoColor=white" alt="Vercel 无服务器" />
  <img src="https://img.shields.io/badge/Google%20Drive-storage-2f4670?style=flat-square&labelColor=10172b&logo=googledrive&logoColor=white" alt="Google Drive 存储" />
  <a href="#桌面小组件"><img src="https://img.shields.io/badge/Widget-Windows-2f4670?style=flat-square&labelColor=10172b" alt="Windows 桌面小组件" /></a>
</p>

<p align="center">
  <strong>多人共用一个 Google Drive 的像素风桌面。</strong><br />
  站长准备一次，其他人只要打开地址，用自己的 Google 账号登录即可。
</p>

<p align="center">
  <a href="#sharedesk-是什么">简介</a> ·
  <a href="#桌面">桌面</a> ·
  <a href="#分享与空间">分享</a> ·
  <a href="#四种壁纸">壁纸</a> ·
  <a href="#桌面小组件">小组件</a> ·
  <a href="#开始使用">开始使用</a> ·
  <a href="#如何共享">共享方式</a>
</p>

<div align="center">

[English](./README.md) · [한국어](./README.ko.md) · [日本語](./README.ja.md) · [हिन्दी](./README.hi.md) · **中文**

</div>

<br />

## ShareDesk 是什么？

ShareDesk 是**一个共享文件空间：多个人用各自的 Google 账号，一起使用同一个人的 Google Drive 存储空间**。只有站长需要安装一次。其他人打开同一个地址，用 Google 登录，第一次输入邀请码后，就能在浏览器里的像素风桌面上一起使用相同的文件和文件夹。

![ShareDesk 演示](./docs/sharedesk-demo.gif)

<sub>演示使用韩语界面录制。界面支持英语、韩语、日语、印地语和中文五种语言。</sub>

<details>
<summary><strong>一个 Drive 如何变成共享桌面</strong></summary>
<br />

```text
  站长一个人的 Google Drive
             ↕
     同一个 ShareDesk 地址
   ├─ 站长的 Google 账号
   ├─ 参与者 A 的 Google 账号
   └─ 参与者 B 的 Google 账号
```

只有站长的账号会连接 Google Drive。参与者用各自的 Google 账号登录，但在 ShareDesk 里，大家都在站长指定的那一个 Drive 文件夹中工作，并共用它的容量。
</details>

<br />

## 桌面

<p align="center">
  <img src="./docs/readme/desk.png" width="100%" alt="浏览器中的 ShareDesk 桌面：带颜色的文件夹图标、在侧边预览中显示照片的 Photos 文件夹窗口，以及当前在线成员列表" />
</p>

- **图标与窗口** —— 像桌面图标一样摆放文件和文件夹，给文件夹设置七种颜色之一，并把多个文件夹作为窗口打开，可以最小化或最大化。回收站在右下角，删除的项目会保留 30 天。
- **预览与协同编辑** —— 照片、视频、音频、PDF 和文本可以直接打开，`.txt` 文件可以多人一起编辑。每个文件夹都可以留一条共享备注。
- **查找** —— 搜索整个桌面，或搜索某个文件夹及其子文件夹；打开**属性**可以看到是谁上传的、被下载了几次。
- **随心上传** —— 拖入文件或整个文件夹。如果刷新打断了上传，打开任务栏上的待续传上传提示，把同一个文件拖到那个面板里或重新选择该文件，即可继续上传；直接拖到桌面上则会开始新的上传。
- **成员** —— 查看谁在线，用右下角的按钮聊天（最小化时有新消息，按钮会闪烁并显示未读数），还可以设置别人看到的昵称。
- **角色** —— 管理员通过 `ADMIN_EMAILS` 指定，其他人在管理页面中逐个设为可编辑、可上传或仅查看。
- **管理页面** —— 管理邀请码（一次性，或限期不限次）、用户及其登录设备、动态记录、公开文件夹、桌面语言、带复古磁盘风格圆环图的存储容量限制、壁纸和更新。
- **在手机上** —— 屏幕较窄时，桌面会变成简单的列表，可以在这里上传、拍照或新建文件夹。

<br />

## 分享与空间

<img align="right" width="300" src="./docs/readme/sharing.png" alt="从右侧边缘打开的侧边栏：创建临时链接、已生成链接、从其他桌面接收、进入公开文件夹、桌面小组件" />

点击桌面右侧边缘的 `«` 把手即可打开侧边栏，链接、接收、公开文件夹和小组件下载都集中在这里。

- **分享链接** —— 可编辑者和管理员右键单击文件或文件夹，可以立即复制一个 1 小时链接，也可以在分享链接管理中选择 1 小时、24 小时、7 天或 30 天（默认 7 天）。链接无需登录即可打开。
- **临时链接** —— 拖入文件后，每个文件一上传完成就会得到一个 1 小时链接。窗口在最前面时，用 Ctrl+V 粘贴复制的截图也会这样上传。勾选的文件在 1 小时后删除，取消勾选则保留在桌面上。
- **已生成链接** —— 在一个列表中查看有效链接，可以再次复制或停止分享。普通成员只看到自己的链接，管理员能看到全部链接。
- **二维码** —— 分享链接、临时链接、邀请码和公开文件夹地址都可以显示为在浏览器中绘制的二维码，用手机直接扫屏幕即可带走。
- **从其他桌面接收** —— 粘贴在另一个 ShareDesk 中创建的分享链接，就能把那个文件或文件夹复制到这个桌面。
- **公开文件夹** —— 管理员把某个文件夹设为公开文件夹后，知道地址的人无需登录就能下载和上传。大小、文件数量和开放时间的上限由服务器把关。成员可以在**进入公开文件夹**中找到它们。
- **空间** —— 管理员可以在同一次安装中开设更多桌面，每个桌面都有 `/team/files` 这样的独立地址，以及各自的成员、角色、文件和聊天。成员只能看到自己被加入的空间。链接和公开文件夹目前只在主桌面中使用。
- **下载优先** —— 勾选任务栏中的复选框后，打开文件时会直接下载，而不是预览。

<br clear="all" />

## 四种壁纸

每个人为自己的屏幕挑选壁纸，选择保存在各自的浏览器里。

| 黄昏 | 深夜 |
| :---: | :---: |
| ![黄昏壁纸](./docs/sharedesk-wallpaper-dusk.png) | ![深夜壁纸](./docs/sharedesk-wallpaper-night.png) |
| **黎明** | **夜海** |
| ![黎明壁纸](./docs/sharedesk-wallpaper-dawn.png) | ![夜海壁纸](./docs/sharedesk-wallpaper-tide.png) |

<br />

## 桌面小组件

<p align="center">
  <img src="./docs/readme/widget.png" width="100%" alt="小组件的四个场景：抽屉与窗边模式、折叠成把手再展开的贴边、位于其他窗口后面的图钉，以及把手上逐渐填满的传输进度条" />
</p>

<p align="center">
  <a href="https://github.com/Youkamii/sharedesk-template/releases/download/widget/sharedesk-widget-windows-x64-setup.exe"><img src="https://img.shields.io/badge/Windows%20x64-下载小组件-f2a56f?style=for-the-badge&labelColor=10172b" alt="下载 Windows x64 小组件" /></a>
</p>

小组件是可选的。它是一个直接打开桌面地址的小窗口，画面由桌面服务器绘制；没有小组件，所有功能在浏览器里照样可用。详情见[桌面小组件](./docs/WIDGET.zh.md)。

- **从哪里下载都是同一个文件** —— 上面的按钮始终指向最新的 Windows 安装程序，成员也可以在桌面侧边栏的**桌面小组件**中下载同一个文件。macOS 版会在 Mac 上构建并上传后提供。
- **抽屉与窗边** —— 抽屉是文件网格，拖入文件就会上传到当前查看的文件夹。窗边显示在线成员和最近上传的五个文件，管理员还能看到桌面容量。
- **贴边** —— 把小组件藏到较近的屏幕边缘，只留下一个小把手。把鼠标移到把手上，或把文件拖到把手上，小组件就会展开；折叠期间点击把手旁边的空白处，点击会落到后面的窗口上。
- **图钉** —— 像图钉一样把小组件钉在桌面上，让它待在其他窗口后面、桌面之上。贴边和图钉不会同时开启。
- **拖出下载** —— 在 Windows 上，把抽屉里的文件图标拖到资源管理器的文件夹中，就会下载到那个文件夹。
- **传输进度条** —— 收发文件时如果小组件折叠了，把手的边框会随进度逐渐变绿；传输失败时会短暂变红。
- **更新与配置文件** —— 小组件会检查新版本并验证签名。在托盘菜单中选择“安装更新”后，它会安装并重新启动；在你选择之前不会自行重启。每个配置文件运行一个小组件，就能并排使用多个桌面或账号。

> [!NOTE]
> 贴边、图钉、拖出下载和传输进度条包含在较新版本的小组件中。在旧版小组件上点击贴边或图钉会显示更新提示；新版本发布后，小组件的更新检查会在托盘菜单中提醒你。

<br />

## 开始使用

受邀的参与者不需要安装任何东西。打开站长发来的 ShareDesk 地址，用自己的 Google 账号登录，第一次输入邀请码即可。

站长从这里开始：

- **如果觉得配置太难：** [让 AI 帮你搭建](./docs/AI_INSTALL.zh.md)
- **想自己运行生产服务器：** [详细安装指南](./docs/INSTALL.zh.md)
- **已经安装过：** [更新指南](./docs/UPDATE.zh.md) —— 有新版本时，任务栏的 `更新` 按钮上会出现星标提醒管理员
- **只想在自己电脑上一个人使用：** [本地个人使用](./docs/LOCAL.zh.md)
- **可选：** [桌面小组件](./docs/WIDGET.zh.md)

<br />

## 如何共享？

- **只有一个 Drive 连接。** 只有站长的 Google 账号会连接 Google Drive。ShareDesk 绝不会读取参与者个人的 Drive 文件。
- **不需要单独的数据库。** 用户、邀请、聊天、文件夹备注、链接记录、设置和图标布局也都保存在站长的 Drive 里。
- **无服务器。** ShareDesk 专为无服务器托管而设计。聊天和在线状态使用轻量轮询，而不是持续保持 WebSocket 连接，因此不需要常驻服务器。
- **桌面之间互不混合。** 同一个 Google 账号可以加入多个 ShareDesk 地址，各个桌面的成员、角色、文件和聊天不会混在一起。

> [!NOTE]
> Windows 小组件安装程序目前还没有代码签名，Windows 可能会提示“未知发布者”。小组件的更新会用单独的签名密钥验证；小组件只会与你的桌面、登录时的 Google，以及提供更新的公开 GitHub 发布页通信。

<br />

---

<div align="center">
<sub>Licensed under the <a href="LICENSE">MIT License</a> · Galmuri font under the <a href="public/fonts/Galmuri-LICENSE.txt">SIL OFL 1.1</a></sub>
</div>
