---
name: arp-invoice-export
description: 从中科院「新一代ARP系统」批量导出报销单的原始票据（发票 PDF）。在已登录 ARP 的浏览器 DevTools 控制台运行一个无依赖脚本，读取「核算账号预算执行明细」页列出的全部报销单，调用 ARP 内部接口下载每张单据「附件信息-原始票据」里的所有文件，打包为一个 ZIP（含清单 CSV），再用 Python 脚本校验。Use when the user wants to batch download or export invoices / 发票 / 原始票据 / 报销附件 from ARP 报销单 or 业务单号 lists, or asks how ARP bill attachments and download APIs work.
compatibility: 需要能访问 ARP 内网（如 http://172.31.112.30）且已登录的桌面浏览器（Chrome / Edge / Firefox 均可，无需任何扩展）；校验步骤需要 Python 3，可选 pypdf。
metadata:
  author: hcy2206
  version: "1.0.0"
  verified-on: "ARP V3.8.6, 2026-10-03"
  created: "2026-10-03"
  created-with: "Claude Code (desktop app)"
  created-by-model: "Claude Opus 5.5 (claude-opus-5-5)"
---

# ARP 报销单原始票据批量导出

在 ARP 里，每张报销单的发票都要「点业务单号 → 附件信息 → 原始票据 → 下载」，还要逐个确认弹窗。
这个 skill 跳过页面点击，直接调用页面本身使用的接口，一次把某个预算科目下所有报销单的原始票据导出成一个 ZIP。

## 文件

- `scripts/arp-invoice-export.js`：在 ARP 页面控制台运行的导出脚本，零依赖，自带 ZIP 打包。
- `scripts/verify_zip.py`：校验导出的 ZIP，包括完整性、清单对账、PDF 有效性、多附件单据和发票张数核对。
- `references/arp-api.md`：页面结构、接口、返回字段、已知坑，以及接口变化后如何重新逆向。脚本报错或系统升级后先读这份。

## 操作步骤

1. **打开执行明细页**：登录 ARP，进入 项目经费 → 核算账号 → 核算账号预算执行跟踪 → 点某个预算科目，进入
   「核算账号预算执行明细」。地址栏应形如
   `http://172.31.112.30/arp/index.html#/pm/prjbudget/budgetItemExecutionDetail/ACC/<bizId>/<budgetId>/<budgetItemId>/SUM`。
   不需要调整页面上的分页，脚本会自己用接口取全量数据。
2. **打开控制台**：按 F12（macOS 上是 ⌥⌘I），切到 Console。Chrome 第一次粘贴时会要求先输入 `allow pasting` 并回车。
3. **（可选）先试运行**：粘贴下面这行，只扫描、不下载，结果在控制台用表格展示：
   ```js
   window.ARP_EXPORT_CONFIG = { dryRun: true };
   ```
   然后粘贴 `scripts/arp-invoice-export.js` 的全部内容并回车。看完结果后执行 `window.ARP_EXPORT_CONFIG = {}`，恢复正式模式。
4. **正式运行**：粘贴 `scripts/arp-invoice-export.js` 的全部内容并回车。页面右下角会出现进度面板，依次显示
   读取列表 → 查询附件 → 下载 → 打包。120 张单据约需 1～2 分钟。
5. **保存**：完成后点面板里的红色按钮「保存 …zip」。必须由用户亲手点击，否则 Chrome 可能把它当成多文件自动下载拦掉。
6. **校验**：
   ```bash
   python3 scripts/verify_zip.py ~/Downloads/<核算账号>_<预算科目>_原始票据.zip
   ```
   如需统计 PDF 页数，先运行 `pip install pypdf`。

### 配置项（`window.ARP_EXPORT_CONFIG`）

| 键 | 默认 | 说明 |
|---|---|---|
| `dryRun` | `false` | 只扫描并报告，不下载 |
| `fileTypes` | `['原始票据']` | 要导出的附件类型；`null` 表示全部 |
| `billNoPrefixes` | `null` | 只导出指定前缀的单号，如 `['BPT']` |
| `concurrency` | `4` | 并发数，内网较慢，不建议超过 6 |
| `timeoutMs` / `retries` | `60000` / `3` | 单个请求的超时时间和尝试次数 |
| `zipName` | 自动 | 默认 `<核算账号>_<预算科目>_原始票据.zip` |

## 输出

ZIP 内是平铺的文件，按申请日期倒序排列：

- `日期_业务单号_摘要(前40字)_原文件名.pdf`；单据有多个附件时，原文件名前加 `01of20_` 这样的序号。
- `清单.csv`（UTF-8 BOM，Excel 可以直接打开）：每个文件一行，包含单号、经办人、摘要、金额、该单附件数、附件序号、
  原文件名、大小、是否 PDF、系统登记发票张数和发票号。
- `未导出单据.csv`：仅在有单据没有附件或下载失败时生成。

解压时用 Finder 双击，或者 `ditto -x -k <zip> <目录>`。macOS 自带的 `unzip` 不识别 UTF-8 文件名标记，中文会显示成乱码。

## 必须知道的坑

完整说明见 `references/arp-api.md`。

1. **业务单号没法直接打开**：详情页的路由数据是从列表行对象内存传过去的（URL 里是 `row=[object Object]`），
   所以脚本不走页面跳转，而是直接用 `billId` 调接口。
2. **一条附件记录可能对应多个文件**：`arFile[].fileId`、`fullName` 可能用逗号拼接了多个值，必须拆开逐个下载，
   否则会 404。实际数据里 120 张单子中有 9 张是这种情况，最多的一张有 20 个文件。
3. **一张单子不一定只有一张发票**：看 `data.gwHomeIdList` 的登记张数；附件里也可能混有验收单、入库单等非发票文件。
   `verify_zip.py` 会列出「登记发票张数 ≠ 附件数」的单据，需要人工核对。
4. **详情接口返回 `{msg, flag, data}`**，附件在 `data.arFile` 里，不在顶层。
5. **部分单据的详情接口会一直挂起**（多见于费用分摊单 BFT），所以脚本设了超时和重试；失败的单据会写进 `未导出单据.csv`。
6. **Chrome 会拦截多文件自动下载**，所以脚本只生成一个 ZIP，并由用户点击触发保存。
   也不要试图把数据 POST 到 `127.0.0.1` 再落盘，会被 Chrome 的本地网络访问限制挡住。
7. 脚本必须在 ARP 页面自身的源上运行，依赖同源 Cookie。在其他页面运行或用外部工具直接请求，都会遇到 CORS 或鉴权问题。

## 给 Agent 的执行指引

- 默认流程是**指导用户**完成上面的操作步骤，把 `scripts/arp-invoice-export.js` 的路径或内容交给用户粘贴。
  不要假设自己能控制用户的浏览器。
- 如果当前环境恰好有能在页面上下文里执行 JS 的浏览器自动化工具（Playwright、CDP、某个浏览器扩展等），可以把同一脚本注入
  执行明细页运行，再读取 `window.__arpExport`（含 `bills`、`files`、`failures`、`multi`、`empty`、`blob`）汇报结果。
  最后保存 ZIP 时仍然需要一次真实点击：可以让用户点，也可以用工具对面板按钮做真实点击。
- 下载附件属于需要用户确认的操作：正式运行前，先用 `dryRun` 把单据数、附件数、多附件单据汇报给用户，确认后再下载。
- 不要读取、打印或外传 `document.cookie` 和会话凭据，脚本也不需要它们。
- 如果脚本在某一步报错（比如字段缺失或 404），按 `references/arp-api.md` 末尾的「重新逆向」步骤核对接口，再改脚本。
