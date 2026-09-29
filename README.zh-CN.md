# OpenChamber 队列

[English](./README.md) · 简体中文

给 [OpenChamber](https://openchamber.dev) 的**按项目任务队列**扩展。往项目里添加任务、打开开关，
当该项目**没有正在运行的会话**时，OpenChamber 会自动用下一个任务创建会话并发送内容。
每个项目同时只跑一个队列任务。

任务只有一个字段：**内容**，也就是提示词。模型、agent 等使用项目自身的默认选择。

> 这是一个 OpenChamber **扩展**（面板 + 本地服务），不是 OpenCode 插件。

## 功能

- **每个项目一条队列** —— 切换项目即切换队列。
- **自动下发** —— 项目一空闲就自动建会话、发内容，无需逐个点击。
- **自动清理** —— 任务完成后自动删除并计入「已完成」；队列空了会自动关闭开关。
- **询问不阻塞** —— 智能体停下来提问时，该任务回到队列，下一个任务继续跑。
- **停止时可编辑** —— 点击任务卡片即可就地编辑；队列运行中会拒绝修改。
- **关页面也能工作** —— 由服务器端本地服务驱动，不依赖浏览器标签页。
- **面板多语言** —— 跟随 OpenChamber 语言（英文、简体中文、繁體中文）。

## 工作原理

### 调度规则

对每个项目，每次检查：

1. 队列未启用或为空 → 不动作。
2. 队列自己启动的会话仍在**执行** → 等待。
   - 若它停在**提问** → 该任务回到队列末尾，并继续下发下一个任务。
3. 项目里**其它**会话真正在执行 → 等待。
4. 否则取队首待执行任务 → 创建会话 → 发送内容。
5. 该会话转为空闲后 → 删除该任务、已完成 +1、继续下一个；队列清空后自动关闭开关。

「真正在执行」指 `running`、`retrying`、`waiting-permission`；`waiting-question`
**不算占用**。所以智能体提问不会卡住队列，而你自己开的会话会让队列排队等待。

### 后台 / 前台

| 模式 | 何时生效 | 关页面后是否工作 |
| --- | --- | --- |
| **后台调度**（推荐） | 扩展的本地服务已获批且可用 | 是 |
| **前台调度** | 未授予本地服务，或服务不可用 | 否 |

后台模式由宿主为 `contributes.service` 启动的 Node 进程处理，它调用本机 OpenChamber
控制 API（与自带 `openchamber` CLI 同一条路）读取会话状态、创建会话、发送提示词。
前台模式回退到宿主 API，仅在面板打开时运行，面板会显示提示横幅。

## 安装

需要 OpenChamber **2.0.0 或更高**（网页版或桌面版）。

1. **设置 → 扩展**。
2. 在 **文件夹、ZIP 或 URL** 中粘贴以下之一并点击 **添加**：
   - 本地克隆的 `dist/` 目录（先执行一次 `npm run build`）；
   - 最新 **Releases** 页面上的 `.zip`；
   - `release` 分支的 git 地址 ——
     `https://github.com/<owner>/openchamber-queue.git#release`
     （git 安装可在 设置 → 扩展 中 **更新**，依据 `package.json` 版本号升高；
     zip 安装不支持应用内更新，需手动重新添加更新的 zip）。
3. 在权限对话框中点击 **允许并启用**。它会列出 `prompt`、`sessions`、`service`；
   本地服务以你的完整用户权限运行。

## 使用

在侧栏扩展区打开 **队列** 面板：

1. 在输入框里填写任务 → **加入队列**。
2. 打开 **启用队列** 开关。
3. 之后无需干预。项目空闲时队首任务开跑，跑完自动接下一个。

顶栏显示当前模式，右上角是三个计数：**待执行 / 运行中 / 已完成**。每行有 *会话*、
*置顶*、*重试*（仅失败时）、*删除*。队列停止时，点击某一行会展开为编辑器，带
**保存** / **取消**。

其它入队方式：

- 消息菜单 → **加入队列**（把该条消息内容入队）；
- 聊天框斜杠命令 → `/queue <内容>`。

## 存储与持久化

| 数据 | 位置 |
| --- | --- |
| 队列数据（后台模式） | `<OpenChamber 数据目录>/openchamber-queue/state.json` |
| 队列数据（前台模式） | 宿主存储 `<OpenChamber 数据目录>/guest-storage/queue.json` |
| 安装记录与权限 | `<OpenChamber 数据目录>/extensions.json` |

数据目录默认为 `~/.config/openchamber`（Windows 为 `%APPDATA%\openchamber`；桌面端
设置时可能在 `~/Library/Application Support/openchamber`），可通过
`OPENCHAMBER_DATA_DIR` 覆盖。

数据是普通 JSON 文件，**重启、升级、卸载都不会丢**。但**后台 worker 不会自动启动**：
OpenChamber 只在有请求时才拉起扩展服务，因此 OpenChamber 进程重启后，队列会暂停，
直到你打开一次面板（或触发一次消息动作 / `/queue` 命令）。之后它会常驻，原先已启用的
队列会从断点继续。

卸载扩展会删除宿主托管的前台存储；要一并清空后台队列，请手动删除
`<数据目录>/openchamber-queue/`。

## 权限

| 权限 | 用途 |
| --- | --- |
| `sessions` | 列出项目与会话、创建会话 |
| `prompt` | 把任务内容发送到新会话 |
| `service` | 随本地服务一并授予；该进程以你的完整用户权限运行 |

## 已知限制

- **冷启动** —— 见上文：每次 OpenChamber 进程启动后，需要一次打开面板（或动作）
  才能把后台 worker 唤醒。
- **非公开接口** —— 服务使用产品自身的控制 API 与代理的 OpenCode 会话路由。这些接口
  自带的 CLI 也在用，但不是面向扩展的公开契约，版本升级可能变动。
- **失败的回合仍算完成** —— 队列只能判断会话是否转为空闲，无法判断智能体是否满意结果；
  请点开会话链接确认。
- **清单字符串无法本地化** —— 扩展 API 的面板名、命令描述、动作标签是固定字符串，
  它们保持声明语言；面板内部则跟随 OpenChamber 语言。
- 扩展不会在 VS Code 与移动端加载，队列同样不可用。

## 开发

```bash
npm install
npm run build       # 组装可安装包到 dist/
npm run typecheck
npm test            # 先构建，再针对 stub OpenChamber 跑隔离端到端测试
```

`npm run build` 会把整个可安装包写入 `dist/`：`dist/package.json`、`dist/icon.svg`、
`dist/panel/{index,background}.html`，以及两个产物 `dist/panel/main.js`（浏览器 IIFE）
与 `dist/service/main.js`（Node ESM）。宿主按包内路径直接加载已构建的 `.js`，因此页面与
其 bundle 必须位于同一目录。`dist/` 是生成物，**不提交**；CI 在每次推送到 `main` 时构建它。

开发时把 `dist/` 作为文件夹安装（设置 → 扩展）：它直接读取你的目录，改完重建即可刷新。
`npm test` 覆盖后台服务。

宿主不会编译扩展：只发布已构建文件。新增语言只需改 `src/i18n.ts` 并重新构建。这里只使用
`devDependencies`，仓库不包含 `node_modules`。

## 目录结构

```
package.json            扩展清单与脚本
icon.svg                侧栏图标
scripts/build.mjs       组装 dist/（可安装包）
.github/workflows/      CI：构建 dist/，发布 release 分支与 zip
src/core.ts             队列模型与纯函数 planTick 规则（面板与服务共用）
src/i18n.ts             各语言的面板文案
panel/main.ts           面板 + 背景帧      -> dist/panel/main.js
panel/index.html        侧栏面板页
panel/background.html   动作与 /queue 的按需页
service/main.ts         后台 worker        -> dist/service/main.js
dist/                   构建出的可安装包（生成物，不提交）
PROPOSAL.md             最初的设计规划
README.md               英文说明
_temp/                  本地测试脚本（不随包发布）
```

## 语言

面板跟随 OpenChamber 语言，找不到时回退英文。面板文案已内置 `en`、`zh-cn`、`zh-tw`；
在 `src/i18n.ts` 的 `DICTIONARIES` 中新增一份即可，字典类型会让缺失的键在编译期报错。
文档提供英文（[README.md](./README.md)）与简体中文（本文件）。

## 许可证

[MIT](./LICENSE)。
