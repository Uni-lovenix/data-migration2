#!/bin/bash
set -euo pipefail

if [ ! -d /data/nn/current ]; then
  echo "[hdfs-test] formatting namenode..."
  hdfs namenode -format -force -nonInteractive >/dev/null
fi

echo "[hdfs-test] starting namenode..."
hdfs --daemon start namenode
echo "[hdfs-test] starting datanode..."
hdfs --daemon start datanode

for _ in $(seq 1 60); do
  if curl -sf http://127.0.0.1:9870/webhdfs/v1/?op=GETFILESTATUS >/dev/null 2>&1; then
    echo "[hdfs-test] webhdfs ready on :9870"
    break
  fi
  sleep 2
done

echo "[hdfs-test] hdfs up (namenode :9870, datanode :9864, rpc :9000)"
tail -f /dev/null
