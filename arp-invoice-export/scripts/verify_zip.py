#!/usr/bin/env python3
"""校验 arp-invoice-export.js 导出的 ZIP。

用法:
    python3 verify_zip.py <导出的.zip>

检查项:
  1. ZIP 完整性（CRC）；
  2. 清单.csv 中每一行都能在 ZIP 中找到对应文件，且大小一致；
  3. 每个文件是否为 PDF；安装了 pypdf 时还会统计页数、发现无法解析的 PDF；
  4. 列出多附件单据，以及「系统登记发票张数」与附件数不一致的单据（提示人工核对）；
  5. 打印 未导出单据.csv（若有）。
发现硬性问题（缺文件 / 大小不符 / CRC 错误 / PDF 损坏）时以退出码 1 结束。
"""

from __future__ import annotations

import collections
import csv
import io
import sys
import zipfile

try:
    from pypdf import PdfReader
except ImportError:  # pypdf 可选
    PdfReader = None


def read_csv(z: zipfile.ZipFile, name: str) -> list[dict[str, str]]:
    with z.open(name) as f:
        return list(csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")))


def main(path: str) -> int:
    errors: list[str] = []
    z = zipfile.ZipFile(path)
    bad_crc = z.testzip()
    if bad_crc:
        errors.append(f"CRC 校验失败: {bad_crc}")

    names = set(z.namelist())
    rows = read_csv(z, "清单.csv")
    n_bills = len({r["业务单号"] for r in rows})
    print(f"ZIP 条目 {len(names)} 个；清单 {len(rows)} 行；单据 {n_bills} 张")

    pages = collections.Counter()
    per_bill: dict[str, dict] = {}
    for r in rows:
        fn = r["ZIP内文件名"]
        if fn not in names:
            errors.append(f"缺文件: {fn}")
            continue
        data = z.read(fn)
        if str(len(data)) != r["大小(字节)"]:
            errors.append(f"大小不符: {fn}")
        bill = per_bill.setdefault(r["业务单号"], {
            "files": 0, "pages": 0, "inv": int(r["系统登记发票张数"] or 0), "remark": r["摘要"],
        })
        bill["files"] += 1
        if not data.startswith(b"%PDF"):
            print(f"  ⚠ 非 PDF: {fn}")
            continue
        if PdfReader is not None:
            try:
                n = len(PdfReader(io.BytesIO(data)).pages)
            except Exception as e:  # noqa: BLE001
                errors.append(f"PDF 无法解析: {fn} ({str(e)[:60]})")
                continue
            pages[n] += 1
            bill["pages"] += n

    if PdfReader is None:
        print("（未安装 pypdf，跳过页数统计：pip install pypdf）")
    else:
        print("每个 PDF 的页数分布:", dict(sorted(pages.items())))

    multi = {k: v for k, v in per_bill.items() if v["files"] > 1}
    if multi:
        print(f"\n多附件单据 {len(multi)} 张:")
        for k, v in sorted(multi.items()):
            print(f"  {k}: 附件 {v['files']} 个，登记发票 {v['inv']} 张  {v['remark']}")

    mismatch = {k: v for k, v in per_bill.items() if v["inv"] != v["files"]}
    if mismatch:
        print(f"\n登记发票张数 ≠ 附件数 的单据 {len(mismatch)} 张"
              "（可能含验收单等非发票附件，或多张发票合并为一个 PDF，请人工核对）:")
        for k, v in sorted(mismatch.items()):
            extra = f"，PDF 共 {v['pages']} 页" if PdfReader is not None else ""
            print(f"  {k}: 附件 {v['files']} 个，登记发票 {v['inv']} 张{extra}  {v['remark']}")

    if "未导出单据.csv" in names:
        miss = read_csv(z, "未导出单据.csv")
        print(f"\n未导出单据 {len(miss)} 张:")
        for r in miss:
            print(f"  {r['业务单号']} {r['业务类型']} {r['原因']}")

    if errors:
        print(f"\n✗ 发现 {len(errors)} 个问题:")
        for e in errors:
            print("  " + e)
        return 1
    print("\n✓ 校验通过")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
