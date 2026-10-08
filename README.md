# MyDiary · 本地日记

一个极简的本地日记系统。日记以普通 Markdown 文件保存在本机，用你配置的**本地编辑器**书写（Typora、Obsidian、VS Code 等均可），网页只负责**浏览、热力图、统计**。
![](https://p.sda1.dev/35/27e3e284e6d135f54e0a8e4a3ea9d29f/image.png)
![](https://p.sda1.dev/35/c8c925c179926abb253bf248d014f273/image.png)

## 快速开始

运行打包版即可（`npm run dist:win` 构建产物在 `release/`，安装后从开始菜单/桌面打开 MyDiary）。

开发调试：

```bash
npm install
npm run dev
```

## 功能

| 功能           | 说明                                                  |
| -------------- | ----------------------------------------------------- |
| **今日入口**   | 一键创建/打开今天的日记，自动用已配置的本地编辑器打开 |
| **贡献热力图** | GitHub 风格，4 年历史，颜色深浅 = 当天字数            |
| **日记列表**   | 按时间倒序，显示预览和字数                            |
| **阅读视图**   | 网页内直接阅读 Markdown（支持标题/列表/代码/引用）    |
| **统计**       | 已写天数、当前连续、最长连续、累计字数                |
| **定位文件**   | 在文件管理器中高亮对应 md 文件                        |

## 目录结构

```
MyDiary/
├── electron/            ← Electron 主进程
├── server/
│   └── server.js        ← 本地服务（读写加密数据仓 + 启动配置的编辑器）
├── src/                 ← 网页前端
├── data/                ← 加密数据仓（开发模式）
└── package.json
```

## 数据说明

- 日记保存在 **`diaries/`** 文件夹，文件名格式 `YYYY-MM-DD.md`
- **纯 Markdown 文件**，脱离本网页也能用任何编辑器打开
- 不联网、不上传、无账号，数据 100% 在本机

## 配置

网页右上角 **⚙** 可修改：

- **编辑器路径** —— 任意本地编辑器可执行文件（如 `Typora.exe`、`Obsidian.exe`、`Code.exe`），会自动探测 Typora 常见安装位置作为默认值；按钮文案会显示该程序名
- **日记目录** —— 默认项目下的 `diaries/`，可改到任意位置

配置保存在 `config.json`。

## 常见问题

**Q: 为什么需要本地服务，不能纯静态页面？**
浏览器出于安全限制，无法直接读写磁盘文件、也无法启动本地程序（编辑器等）。本地服务只做这两件事，界面本身仍是普通网页。

**Q: 换了电脑怎么迁移？**
拷贝加密数据目录（安装版在 `%APPDATA%\my-diary\data\`，含 `key.oscrypt` 与 `data/`）。**数据目录在，日记就在**；注意 key.oscrypt 与数据要一起拷走。

**Q: 端口被占用？**
修改 `server/server.js` 顶部的 `PORT`（默认 4399），同时改 `vite.config.ts` 里的代理目标。

**Q: 想开机自动启动？**
`Win+R` 输入 `shell:startup`，把 MyDiary 的快捷方式（安装版从开始菜单创建，免安装版用 `release/win-unpacked` 里的 exe）放进去即可。

## 技术栈

- 前端：React + TypeScript + Tailwind CSS + Vite
- 后端：Node.js + Express（约 300 行）
- Markdown 渲染：自研轻量解析器（无需第三方库）
- 数据存储：本地文件系统
