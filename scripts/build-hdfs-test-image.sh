#!/usr/bin/env bash
# 构建测试用单节点 HDFS 镜像。
#
# Docker Hub 在部分网络环境不可达，因此这里不依赖任何 Hadoop 镜像：
# 从 Apache 镜像下载 JDK 与 Hadoop 发行包，基于本地 python 镜像构建。
set -euo pipefail

MIRROR="${HDFS_TEST_MIRROR:-https://mirrors.tuna.tsinghua.edu.cn}"
WORK_DIR="${HDFS_TEST_BUILD_DIR:-/tmp/dm-hdfs-build}"
IMAGE="${HDFS_TEST_IMAGE:-dm-hdfs-test:1}"
# Hadoop 3.4.1 的 WebHDFS 在 JDK 17 下会出现 JAXB 初始化错误，因此固定用 JDK 11。
JDK_URL="$MIRROR/Adoptium/11/jdk/aarch64/linux/OpenJDK11U-jdk_aarch64_linux_hotspot_11.0.32.1_1.tar.gz"
HADOOP_URL="$MIRROR/apache/hadoop/common/hadoop-3.4.1/hadoop-3.4.1.tar.gz"
BASE_IMAGE="${HDFS_TEST_BASE_IMAGE:-python:3.13.13}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$WORK_DIR"

if [ ! -s "$WORK_DIR/jdk.tar.gz" ]; then
  echo "downloading JDK..."
  curl -fL -o "$WORK_DIR/jdk.tar.gz" "$JDK_URL"
fi
if [ ! -s "$WORK_DIR/hadoop.tar.gz" ]; then
  echo "downloading Hadoop..."
  curl -fL -o "$WORK_DIR/hadoop.tar.gz" "$HADOOP_URL"
fi

cp "$SCRIPT_DIR/hdfs-test-image/Dockerfile" "$WORK_DIR/Dockerfile"
cp "$SCRIPT_DIR/hdfs-test-image/core-site.xml" "$WORK_DIR/core-site.xml"
cp "$SCRIPT_DIR/hdfs-test-image/hdfs-site.xml" "$WORK_DIR/hdfs-site.xml"
cp "$SCRIPT_DIR/hdfs-test-image/entrypoint.sh" "$WORK_DIR/entrypoint.sh"

docker build --platform linux/arm64 --build-arg BASE_IMAGE="$BASE_IMAGE" -t "$IMAGE" "$WORK_DIR"
echo "built $IMAGE"
