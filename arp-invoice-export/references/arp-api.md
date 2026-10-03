# ARP 报销附件相关接口与页面结构（逆向记录）

验证环境：中科院「新一代ARP系统」V3.8.6，`http://172.31.112.30`，2026-10-03。
接口均为内部接口，无公开文档，系统升级后可能变化；变化时按文末「重新逆向」的方法再核对一遍。

## 页面与前端

- Vue 2 + Element UI 单页应用，hash 路由，入口 `/arp/index.html`。
- **执行明细页**：`#/pm/prjbudget/budgetItemExecutionDetail/{budgetType}/{bizId}/{budgetId}/{budgetItemId}/{year}`
  - 例：`.../ACC/eb99d4f0.../722d759b.../a9bff8fa.../SUM`
  - 表格中的「业务单号」是 `<button>`，没有 href；点击后用 `$router.push` 把整行对象塞进路由跳转。
- **单据详情页**：`#/fin/billSearch?row=[object Object]&transferState=3`
  - URL 里**没有单据 ID**（`row` 被字符串化成 `[object Object]`），无法用 URL 直接打开某张单据，刷新后也会丢失。
  - 「附件信息 → 原始票据」区域：每个文件一行，行内「下载」是 `<a>`（无 href），点击后执行组件方法
    `buttonEvent(file)`：先弹 `$confirm('下载文件, 是否继续?')`，确认后
    `window.open(FileInfoApi.getBaseFileUrl() + '/' + file.fileId, '_self')`。
  - 同区域还有「批量下载」「批量打印」按钮（单张单据内的批量操作）。

## 接口

所有接口用同源 Cookie 鉴权，`fetch(url, {credentials: 'include'})` 即可，不需要额外 token 头。
跨域（从其他源）调用会被 CORS 拦截，所以脚本必须在 ARP 页面自身的上下文中运行。

### 1. 执行明细列表

```
GET /pm/prjbudget/budget/getBudgetExecutionDetailNew
    ?budgetType=ACC&bizId=..&budgetId=..&offset=1&limit=500&budgetItemId=..&year=SUM
```

- `offset` 是从 1 开始的页码，页面默认 `limit=5`；`limit=500` 可一次取完。
- 返回（未包在 `data` 里）：
  - `exeBudget.exeBudgetCode`：核算账号编码；`budgetItem.budgetItemName`：预算科目名
  - `budgetExecutionDetailPage`：`{content[], totalElements, totalPages, ...}`
  - `content[]` 每行：`billId`、`billNo`（业务单号）、`billType`（如 `EXP_OUTLAY`）、`billTypeName`、
    `businessDate`、`appName`（经办人）、`depName`、`remark`（摘要）、`money`（元）、`voucherNo`、`detailId`、`type`(FREEZE/…)

### 2. 单据详情（含附件、发票登记）

```
GET /fin/arBill/getArBill/{billId}/baseInfo/detailInfo
```

- 返回 `{msg, flag, data}`，**数据在 `data` 下**。
- `data.arFile[]`：附件记录 `{fileId, fullName, suffixName, fileType, fileCategory, uploadPhase, fileSource, ...}`
  - `fileType`：`原始票据` 等。
  - **坑：一条记录可能包含多个文件**，`fileId`、`fullName`、`suffixName`、`uploadPhase` 都用英文逗号拼接，按位置一一对应。
    例：`fileId: "0a43…,1c1c…"`，`fullName: "增值税发票_A.pdf,增值税发票_B.pdf"`。
    直接拿拼接后的 `fileId` 去下载会 404。
- `data.gwHomeIdList[]`：系统登记的发票（`invoiceNum`、`invoiceDate`、`amount`、`totalAmount`…），可用于核对张数。
- 其他附件列表：`data.mxFileList`、`data.supplementFile`（本次样本中都为空）。
- 另有 `GET /fin/arBill/getArBillById/{billId}`，只返回单据头，不含附件。
- 部分单据（样本中为「费用分摊报销」BFT 单）请求会长时间挂起，必须设超时并重试。

### 3. 附件下载

```
GET /portal/attachments/{fileId}
```

- 直接返回文件二进制（PDF 以 `%PDF` 开头），无查询参数。
- 不存在或 ID 错误时返回 404 + JSON。

## 样本统计（E522715001 / 材料费，126 条执行明细）

- 120 张「普通报销单」（BPT）：111 张各 1 个原始票据 PDF；9 张多附件（2~20 个，共 58 个），
  其中 1 张的第二个附件是「耗材验收_入库_领料单」而非发票。总计 169 个 PDF，约 24 MB。
- 6 张「费用分摊报销」（BFT）：无附件（其中 1 张详情接口反复超时）。

## 浏览器限制

- Chrome 对同一站点的**第二次及以后的自动下载**（非用户手势触发）会拦截，并在地址栏提示「此网站尝试下载多个文件」。
  因此脚本把所有文件打成一个 ZIP，并要求用户点击面板按钮触发保存。
- 从 `http://172.31.112.30` 页面向 `http://127.0.0.1` POST 数据会被 Chrome 的 Private/Local Network Access 拦截，
  不要用本地接收服务的方案落盘。

## 重新逆向（接口变化时）

1. 在执行明细页按 F12 → Network，勾选 Preserve log，点开一张单据，记录 `getArBill…detailInfo` 类请求。
2. 在详情页控制台找到「下载」链接所在组件：从 `<a>` 向上找到带 `__vue__` 的元素，
   用 `vm._vnode` 找到该 `<a>` 的 vnode，读 `data.on.click` 看调用的方法，再读 `vm.$options.methods.<方法>.toString()`。
3. 在控制台 hook `window.open` 后点击「下载」并确认，即可拿到真实下载 URL。
