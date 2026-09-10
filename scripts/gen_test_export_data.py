#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
向 Elasticsearch 索引 test_export 批量写入测试数据（默认 600 万条，10 个字段，含时间字段）。
用于后续导出/导入性能测试。

用法:
    python scripts/gen_test_export_data.py                       # 600 万条，默认参数
    python scripts/gen_test_export_data.py --total 100000        # 少量数据快速验证
    python scripts/gen_test_export_data.py --workers 8 --bulk-size 5000
    python scripts/gen_test_export_data.py --keep                # 不删除已有索引，追加写入

字段（10 个）:
    id          long        自增主键
    order_no    keyword     订单号
    user_name   keyword     用户名
    email       keyword     邮箱
    status      keyword     状态枚举
    amount      double      金额
    quantity    integer     数量
    is_active   boolean     是否有效
    created_at  date        创建时间 (yyyy-MM-dd HH:mm:ss)
    updated_at  date        更新时间 (epoch_millis / ISO8601)
"""

import argparse
import json
import random
import string
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta

import requests

# Windows 控制台默认 GBK，强制 UTF-8 输出避免中文报错
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

# --------------------------------------------------------------------------- #
# 索引映射
# --------------------------------------------------------------------------- #
MAPPING = {
    "settings": {
        "number_of_shards": 3,
        "number_of_replicas": 0,
        # 导入期间关闭刷新与 translog 频繁落盘，写完再恢复
        "refresh_interval": "-1",
        "translog": {"durability": "async", "sync_interval": "30s"},
    },
    "mappings": {
        "properties": {
            "id": {"type": "long"},
            "order_no": {"type": "keyword"},
            "user_name": {"type": "keyword"},
            "email": {"type": "keyword"},
            "status": {"type": "keyword"},
            "amount": {"type": "double"},
            "quantity": {"type": "integer"},
            "is_active": {"type": "boolean"},
            "created_at": {
                "type": "date",
                "format": "yyyy-MM-dd HH:mm:ss||strict_date_optional_time||epoch_millis",
            },
            "updated_at": {
                "type": "date",
                "format": "strict_date_optional_time||epoch_millis",
            },
        }
    },
}

STATUS_POOL = ["PENDING", "PAID", "SHIPPED", "COMPLETED", "CANCELLED", "REFUNDED"]
SURNAMES = ["赵", "钱", "孙", "李", "周", "吴", "郑", "王", "冯", "陈", "褚", "卫"]
GIVEN = ["伟", "芳", "娜", "敏", "静", "磊", "强", "军", "洋", "勇", "艳", "杰"]
DOMAINS = ["example.com", "test.org", "mail.cn", "corp.net", "demo.io"]

BASE_TIME = datetime(2020, 1, 1, 0, 0, 0)
TIME_SPAN_SECONDS = 6 * 365 * 24 * 3600  # 约 6 年跨度

_print_lock = threading.Lock()


# --------------------------------------------------------------------------- #
# 文档生成
# --------------------------------------------------------------------------- #
def build_bulk_payload(start_id, count, index):
    """生成一个 bulk 请求体（NDJSON 字符串）。

    注意：显式指定 _id = 文档 id，使 bulk 重试幂等。
    若用 ES 自动生成 _id，批次超时或被 429 拒绝后整批重发会产生重复文档。
    """
    rnd = random.Random(start_id)  # 每批固定种子，结果可复现
    lines = []
    append = lines.append

    for i in range(count):
        doc_id = start_id + i
        created = BASE_TIME + timedelta(seconds=rnd.randint(0, TIME_SPAN_SECONDS))
        updated = created + timedelta(seconds=rnd.randint(0, 86400 * 30))
        doc = {
            "id": doc_id,
            "order_no": "ORD{:012d}".format(doc_id),
            "user_name": rnd.choice(SURNAMES) + rnd.choice(GIVEN) + rnd.choice(GIVEN),
            "email": "{}{}@{}".format(
                "".join(rnd.choices(string.ascii_lowercase, k=6)),
                rnd.randint(100, 999),
                rnd.choice(DOMAINS),
            ),
            "status": rnd.choice(STATUS_POOL),
            "amount": round(rnd.uniform(0.01, 99999.99), 2),
            "quantity": rnd.randint(1, 500),
            "is_active": rnd.random() > 0.15,
            "created_at": created.strftime("%Y-%m-%d %H:%M:%S"),
            "updated_at": updated.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        append(json.dumps({"index": {"_index": index, "_id": str(doc_id)}}))
        append(json.dumps(doc, ensure_ascii=False))

    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- #
# ES 操作
# --------------------------------------------------------------------------- #
def prepare_index(session, base_url, index, drop_existing):
    url = "{}/{}".format(base_url, index)
    exists = session.head(url, timeout=30).status_code == 200
    if exists and drop_existing:
        print("[init] 删除已有索引 {}".format(index))
        session.delete(url, timeout=120).raise_for_status()
        exists = False
    if not exists:
        print("[init] 创建索引 {}".format(index))
        resp = session.put(
            url,
            data=json.dumps(MAPPING, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            timeout=120,
        )
        if resp.status_code >= 300:
            raise RuntimeError("创建索引失败: {} {}".format(resp.status_code, resp.text))
    else:
        print("[init] 索引已存在，追加写入")
        session.put(
            "{}/_settings".format(url),
            data=json.dumps({"index": {"refresh_interval": "-1"}}),
            headers={"Content-Type": "application/json"},
            timeout=60,
        )


def send_bulk(session, base_url, index, payload, retries=5):
    """发送一批 bulk。整批重发是安全的：_id 固定，重复写入即覆盖。"""
    url = "{}/{}/_bulk".format(base_url, index)
    body = payload.encode("utf-8")
    last_err = None
    for attempt in range(retries):
        try:
            resp = session.post(
                url,
                data=body,
                headers={"Content-Type": "application/x-ndjson"},
                timeout=300,
            )
            if resp.status_code == 429:
                raise RuntimeError("ES 拒绝写入 (429 too many requests)")
            if resp.status_code >= 300:
                raise RuntimeError("HTTP {}: {}".format(resp.status_code, resp.text[:500]))
            result = resp.json()
            if result.get("errors"):
                first = next(
                    (
                        item["index"]
                        for item in result["items"]
                        if item.get("index", {}).get("error")
                    ),
                    None,
                )
                raise RuntimeError("bulk 部分失败: {}".format(first))
            return
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            time.sleep(min(2 ** attempt, 30))
    raise RuntimeError("bulk 重试 {} 次仍失败: {}".format(retries, last_err))


def restore_index_settings(session, base_url, index, refresh_interval):
    session.put(
        "{}/{}/_settings".format(base_url, index),
        data=json.dumps(
            {
                "index": {
                    "refresh_interval": refresh_interval,
                    "translog": {"durability": "request"},
                }
            }
        ),
        headers={"Content-Type": "application/json"},
        timeout=60,
    )
    session.post("{}/{}/_refresh".format(base_url, index), timeout=300)


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def main():
    parser = argparse.ArgumentParser(description="向 ES 写入 test_export 测试数据")
    parser.add_argument("--host", default="http://127.0.0.1:9200", help="ES 地址")
    parser.add_argument("--index", default="test_export", help="索引名")
    parser.add_argument("--total", type=int, default=6_000_000, help="总文档数")
    parser.add_argument("--bulk-size", type=int, default=5000, help="每批文档数")
    parser.add_argument("--workers", type=int, default=6, help="并发线程数")
    parser.add_argument("--start-id", type=int, default=1, help="起始 id")
    parser.add_argument("--keep", action="store_true", help="保留已有索引（追加写入）")
    parser.add_argument("--user", default=None, help="basic auth 用户名")
    parser.add_argument("--password", default=None, help="basic auth 密码")
    parser.add_argument(
        "--refresh-interval", default="1s", help="写入完成后恢复的 refresh_interval"
    )
    args = parser.parse_args()

    base_url = args.host.rstrip("/")

    session = requests.Session()
    session.headers.update({"Accept": "application/json"})
    if args.user:
        session.auth = (args.user, args.password or "")
    adapter = requests.adapters.HTTPAdapter(
        pool_connections=args.workers * 2, pool_maxsize=args.workers * 2
    )
    session.mount("http://", adapter)
    session.mount("https://", adapter)

    try:
        info = session.get(base_url, timeout=15).json()
        print("[init] 已连接 ES {} ({})".format(info["version"]["number"], base_url))
    except Exception as exc:  # noqa: BLE001
        print("[error] 无法连接 ES: {}".format(exc), file=sys.stderr)
        return 1

    prepare_index(session, base_url, args.index, drop_existing=not args.keep)

    batches = []
    remaining = args.total
    next_id = args.start_id
    while remaining > 0:
        n = min(args.bulk_size, remaining)
        batches.append((next_id, n))
        next_id += n
        remaining -= n

    total_batches = len(batches)
    print(
        "[run] 目标 {:,} 条 / {} 批 / 每批 {} 条 / {} 线程".format(
            args.total, total_batches, args.bulk_size, args.workers
        )
    )

    done_docs = 0
    done_batches = 0
    start_ts = time.time()
    last_report = start_ts

    def task(batch):
        start_id, count = batch
        payload = build_bulk_payload(start_id, count, args.index)
        send_bulk(session, base_url, args.index, payload)
        return count

    try:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = {pool.submit(task, b): b for b in batches}
            for future in as_completed(futures):
                count = future.result()  # 失败则抛出，整体中止
                done_docs += count
                done_batches += 1
                now = time.time()
                if now - last_report >= 5 or done_batches == total_batches:
                    elapsed = now - start_ts
                    rate = done_docs / elapsed if elapsed else 0
                    eta = (args.total - done_docs) / rate if rate else 0
                    with _print_lock:
                        print(
                            "[run] {:>10,}/{:,} ({:5.1f}%)  {:>9,.0f} docs/s  已用 {:.0f}s  预计剩余 {:.0f}s".format(
                                done_docs,
                                args.total,
                                done_docs * 100.0 / args.total,
                                rate,
                                elapsed,
                                eta,
                            )
                        )
                    last_report = now
    except KeyboardInterrupt:
        print("\n[warn] 用户中断，已写入 {:,} 条".format(done_docs), file=sys.stderr)
    finally:
        print("[done] 恢复索引 settings 并 refresh ...")
        restore_index_settings(session, base_url, args.index, args.refresh_interval)

    elapsed = time.time() - start_ts
    count_resp = session.get("{}/{}/_count".format(base_url, args.index), timeout=120).json()
    print(
        "[done] 写入 {:,} 条，耗时 {:.1f}s，平均 {:,.0f} docs/s；索引当前文档数 {:,}".format(
            done_docs, elapsed, done_docs / elapsed if elapsed else 0, count_resp.get("count", -1)
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
