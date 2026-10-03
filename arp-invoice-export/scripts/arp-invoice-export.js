/*
 * ARP 报销单「原始票据」批量导出脚本
 *
 * 用法：在已登录的「新一代ARP系统」中打开
 *   综合财务/项目管理 → 核算账号 → 核算账号预算执行跟踪 → 某预算科目的「核算账号预算执行明细」页
 * （地址形如 #/pm/prjbudget/budgetItemExecutionDetail/ACC/<bizId>/<budgetId>/<budgetItemId>/SUM），
 * 按 F12 打开 Console，粘贴本文件全部内容回车。页面右下角会出现进度面板，完成后点击面板里的按钮保存 ZIP。
 *
 * 可选配置：运行前先执行  window.ARP_EXPORT_CONFIG = { dryRun: true }  等（见 CFG 默认值）。
 * 不依赖任何浏览器扩展或第三方库；所有请求都用当前登录会话（同源 Cookie）。
 */
(async () => {
  'use strict';

  const CFG = Object.assign({
    concurrency: 4,          // 并发请求数，内网接口较慢，不建议超过 6
    timeoutMs: 60000,        // 单个请求超时；部分单据详情接口会挂起，必须有超时
    retries: 3,              // 每个请求的尝试次数
    fileTypes: ['原始票据'], // 导出的附件类型（arFile[].fileType）；设为 null 导出全部类型
    billNoPrefixes: null,    // 只导出这些前缀的单号，如 ['BPT']；null = 全部
    dryRun: false,           // true = 只扫描并在控制台报告，不下载文件
    remarkMaxLen: 40,        // 文件名中摘要的最大长度
    pageSize: 500,           // 列表接口每页条数
    zipName: null,           // 默认 <核算账号>_<预算科目>_原始票据.zip
  }, window.ARP_EXPORT_CONFIG || {});

  const TAG = '[ARP导出]';
  const log = (...a) => console.log('%c' + TAG, 'color:#1976d2;font-weight:bold', ...a);

  // ---------- 进度面板 ----------
  document.getElementById('__arp_export_panel')?.remove();
  const panel = document.createElement('div');
  panel.id = '__arp_export_panel';
  panel.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483647;width:360px;padding:16px;' +
    'background:#fff;border:2px solid #1976d2;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.2);' +
    'font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#222';
  panel.innerHTML = '<div style="font-weight:bold;margin-bottom:6px">ARP 原始票据批量导出</div>' +
    '<div id="__arp_status" style="white-space:pre-wrap">准备中…</div>' +
    '<button id="__arp_btn" style="display:none;margin-top:10px;width:100%;padding:10px;font-size:15px;' +
    'background:#e53935;color:#fff;border:0;border-radius:6px;cursor:pointer"></button>' +
    '<a id="__arp_close" style="position:absolute;top:6px;right:10px;cursor:pointer;color:#999">✕</a>';
  document.body.appendChild(panel);
  panel.querySelector('#__arp_close').onclick = () => panel.remove();
  const statusEl = panel.querySelector('#__arp_status');
  const btn = panel.querySelector('#__arp_btn');
  const setStatus = (t) => { statusEl.textContent = t; };

  // ---------- 工具函数 ----------
  async function req(url, as = 'json') {
    let lastErr;
    for (let t = 0; t < CFG.retries; t++) {
      try {
        const r = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(CFG.timeoutMs) });
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        return as === 'json' ? await r.json() : new Uint8Array(await r.arrayBuffer());
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  async function pool(items, fn, onEach) {
    let i = 0;
    const n = Math.min(CFG.concurrency, items.length);
    await Promise.all(Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        await fn(items[k], k);
        if (onEach) onEach();
      }
    }));
  }

  const san = (s) => String(s ?? '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim();
  const splitList = (v) => (v == null ? [] : String(v).split(',').map((s) => s.trim()));
  const fail = (msg) => { setStatus('✗ ' + msg); console.error(TAG, msg); throw new Error(msg); };

  // ---------- 1. 读取执行明细列表 ----------
  const m = location.hash.match(/^#\/pm\/prjbudget\/budgetItemExecutionDetail\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/?]+)/);
  if (!m) fail('请先打开「核算账号预算执行明细」页面再运行（地址应含 #/pm/prjbudget/budgetItemExecutionDetail/...）');
  const [, budgetType, bizId, budgetId, budgetItemId, year] = m.map(decodeURIComponent);

  setStatus('读取执行明细列表…');
  const rows = [];
  const seenRow = new Set();
  let head = null;
  for (let page = 1; page <= 100; page++) {
    const q = new URLSearchParams({ budgetType, bizId, budgetId, offset: page, limit: CFG.pageSize, budgetItemId, year });
    const j = await req('/pm/prjbudget/budget/getBudgetExecutionDetailNew?' + q);
    head = head || j;
    const pg = j.budgetExecutionDetailPage || {};
    let added = 0;
    for (const r of pg.content || []) {
      const key = r.detailId || r.billId + '|' + r.businessType;
      if (!seenRow.has(key)) { seenRow.add(key); rows.push(r); added++; }
    }
    if (!added || page >= (pg.totalPages || 1) || rows.length >= (pg.totalElements || 0)) break;
  }

  const bills = [];
  const seenBill = new Set();
  for (const r of rows) {
    if (!r.billId || seenBill.has(r.billId)) continue;
    if (CFG.billNoPrefixes && !CFG.billNoPrefixes.some((p) => String(r.billNo).startsWith(p))) continue;
    seenBill.add(r.billId);
    bills.push({
      billId: r.billId, billNo: r.billNo, billTypeName: r.billTypeName, date: String(r.businessDate || '').slice(0, 10),
      appName: r.appName, depName: r.depName, remark: r.remark, money: r.money,
    });
  }
  const acct = head?.exeBudget?.exeBudgetCode || head?.budget?.budgetCode || 'ARP';
  const itemName = head?.budgetItem?.budgetItemName || '';
  log(`执行明细 ${rows.length} 条，待处理单据 ${bills.length} 张（核算账号 ${acct} / ${itemName}）`);

  // ---------- 2. 查询每张单据的附件 ----------
  const files = [];
  const failures = [];
  const billStat = new Map(); // billId -> {inv: [...], n}
  let done = 0;
  await pool(bills, async (b) => {
    try {
      const j = await req(`/fin/arBill/getArBill/${b.billId}/baseInfo/detailInfo`);
      const d = j.data || {};
      const inv = (d.gwHomeIdList || []).map((g) => g.invoiceNum).filter(Boolean);
      let n = 0;
      for (const f of d.arFile || []) {
        if (CFG.fileTypes && !CFG.fileTypes.includes(f.fileType)) continue;
        // 关键：一条 arFile 记录可能用逗号拼接了多个文件（fileId / fullName / suffixName 同序）
        const ids = splitList(f.fileId).filter(Boolean);
        const sfx = splitList(f.suffixName);
        let names = ids.length === 1 ? [String(f.fullName || '')] : splitList(f.fullName);
        if (names.length !== ids.length) names = ids.map((_, k) => `附件${k + 1}.${sfx[k] || 'pdf'}`);
        ids.forEach((id, k) => { files.push({ b, id, fileType: f.fileType, orig: names[k] || `附件${k + 1}` }); n++; });
      }
      billStat.set(b.billId, { inv, n });
    } catch (e) {
      failures.push({ 单号: b.billNo, 类型: b.billTypeName, 摘要: b.remark, 阶段: '查询附件', 错误: String(e.message || e) });
    }
  }, () => setStatus(`查询单据附件 ${++done}/${bills.length}…`));

  // 每张单据内编号
  const perBill = new Map();
  for (const f of files) perBill.set(f.b.billId, (perBill.get(f.b.billId) || 0) + 1);
  const seq = new Map();
  for (const f of files) { const k = (seq.get(f.b.billId) || 0) + 1; seq.set(f.b.billId, k); f.k = k; f.n = perBill.get(f.b.billId); }

  const multi = bills.filter((b) => (perBill.get(b.billId) || 0) > 1)
    .map((b) => ({ 单号: b.billNo, 附件数: perBill.get(b.billId), 登记发票张数: billStat.get(b.billId)?.inv.length, 摘要: b.remark }));
  const empty = bills.filter((b) => billStat.has(b.billId) && !perBill.get(b.billId))
    .map((b) => ({ 单号: b.billNo, 类型: b.billTypeName, 摘要: b.remark }));
  log(`共 ${files.length} 个附件；多附件单据 ${multi.length} 张；无附件 ${empty.length} 张；查询失败 ${failures.length} 张`);
  if (multi.length) { log('多附件单据：'); console.table(multi); }
  if (empty.length) { log('无匹配附件的单据：'); console.table(empty); }
  if (failures.length) { log('查询失败：'); console.table(failures); }

  if (CFG.dryRun) {
    window.__arpExport = { CFG, bills, files, failures, multi, empty };
    setStatus(`扫描完成（dryRun，未下载）\n单据 ${bills.length} 张，附件 ${files.length} 个\n多附件 ${multi.length} 张，无附件 ${empty.length} 张，失败 ${failures.length} 张\n详情见控制台`);
    return;
  }

  // ---------- 3. 下载附件 ----------
  done = 0;
  const got = [];
  await pool(files, async (f) => {
    try {
      f.data = await req('/portal/attachments/' + encodeURIComponent(f.id), 'bytes');
      f.isPdf = f.data[0] === 0x25 && f.data[1] === 0x50 && f.data[2] === 0x44 && f.data[3] === 0x46; // %PDF
      got.push(f);
    } catch (e) {
      failures.push({ 单号: f.b.billNo, 类型: f.b.billTypeName, 摘要: f.b.remark, 阶段: `下载附件 ${f.k}/${f.n}`, 错误: String(e.message || e) });
    }
  }, () => setStatus(`下载附件 ${++done}/${files.length}…`));

  // ---------- 4. 命名 + 清单 ----------
  got.sort((a, c) => (a.b.date !== c.b.date ? (a.b.date < c.b.date ? 1 : -1)
    : a.b.billNo !== c.b.billNo ? (a.b.billNo < c.b.billNo ? 1 : -1) : a.k - c.k));
  const used = new Set();
  for (const f of got) {
    const seqTag = f.n > 1 ? `${String(f.k).padStart(2, '0')}of${f.n}_` : '';
    let name = `${f.b.date}_${f.b.billNo}_${san(f.b.remark).slice(0, CFG.remarkMaxLen)}_${seqTag}${san(f.orig)}`;
    while (used.has(name)) name = name.replace(/(\.\w+)?$/, '_dup$1');
    used.add(name);
    f.name = name;
  }

  const toCsv = (table) => '﻿' + table.map((r) => r.map((v) => {
    v = String(v ?? '');
    return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }).join(',')).join('\r\n');

  const listCsv = [['序号', '申请日期', '业务单号', '业务类型', '经办人', '所属部门', '摘要', '金额(元)', '附件类型',
    '该单附件数', '附件序号', '原文件名', 'ZIP内文件名', '大小(字节)', '是否PDF', '系统登记发票张数', '登记发票号']];
  got.forEach((f, i) => {
    const st = billStat.get(f.b.billId) || { inv: [] };
    listCsv.push([i + 1, f.b.date, f.b.billNo, f.b.billTypeName, f.b.appName, f.b.depName, f.b.remark, f.b.money,
      f.fileType, f.n, f.k, f.orig, f.name, f.data.length, f.isPdf ? '是' : '否', st.inv.length, st.inv.join(' ')]);
  });
  const missCsv = [['业务单号', '业务类型', '摘要', '原因']];
  empty.forEach((e) => missCsv.push([e.单号, e.类型, e.摘要, '无匹配附件']));
  failures.forEach((e) => missCsv.push([e.单号, e.类型, e.摘要, `${e.阶段}失败: ${e.错误}`]));

  const enc = new TextEncoder();
  const entries = got.map((f) => ({ name: f.name, data: f.data }));
  entries.push({ name: '清单.csv', data: enc.encode(toCsv(listCsv)) });
  if (missCsv.length > 1) entries.push({ name: '未导出单据.csv', data: enc.encode(toCsv(missCsv)) });

  // ---------- 5. 打包 ZIP（store 不压缩，UTF-8 文件名，无第三方依赖） ----------
  setStatus('打包 ZIP…');
  const CRC_T = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = (u) => { let c = 0xFFFFFFFF; for (let i = 0; i < u.length; i++) c = CRC_T[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nm = enc.encode(e.name);
    const crc = crc32(e.data);
    const size = e.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, nm.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, nm, e.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true); ch.setUint32(24, size, true); ch.setUint16(28, nm.length, true); ch.setUint32(42, offset, true);
    central.push(ch.buffer, nm);
    offset += 30 + nm.length + size;
  }
  const cdSize = central.reduce((s, p) => s + (p.byteLength ?? p.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const blob = new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  const zipName = CFG.zipName || `${san(acct)}_${san(itemName) || '预算科目'}_原始票据.zip`;

  window.__arpExport = { CFG, bills, files: got, failures, multi, empty, blob, zipName };

  // ---------- 6. 由用户点击触发下载（避免 Chrome「多文件自动下载」拦截） ----------
  const mb = (blob.size / 1048576).toFixed(1);
  const nonPdf = got.filter((f) => !f.isPdf).length;
  setStatus(`完成：单据 ${bills.length} 张，导出附件 ${got.length}/${files.length} 个（${mb} MB）\n` +
    `多附件单据 ${multi.length} 张，无附件 ${empty.length} 张，失败 ${failures.length} 项` +
    (nonPdf ? `\n⚠ 非 PDF 文件 ${nonPdf} 个，见清单.csv「是否PDF」列` : ''));
  btn.textContent = `保存 ${zipName}`;
  btn.style.display = 'block';
  btn.onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = zipName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  };
  log(`ZIP 已就绪：${zipName}（${mb} MB）。点击右下角红色按钮保存。`);
})().catch((e) => console.error('[ARP导出] 中止：', e));
