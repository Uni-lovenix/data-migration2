# 测试用单节点 HDFS（WebHDFS）。基于本地已有的 python 基础镜像构建，
# 避免依赖 Docker Hub；JDK 与 Hadoop 由 build-hdfs-test-image.sh 下载到构建上下文。
FROM python:3.13.13

ENV JAVA_HOME=/opt/jdk
ENV HADOOP_HOME=/opt/hadoop
ENV HADOOP_CONF_DIR=/opt/hadoop/etc/hadoop
ENV PATH=/opt/jdk/bin:/opt/hadoop/bin:/opt/hadoop/sbin:$PATH
ENV HDFS_NAMENODE_USER=root
ENV HDFS_DATANODE_USER=root
ENV HDFS_SECONDARYNAMENODE_USER=root

COPY jdk.tar.gz /tmp/jdk.tar.gz
COPY hadoop.tar.gz /tmp/hadoop.tar.gz

RUN mkdir -p /opt/jdk /opt/hadoop \
    && tar -xzf /tmp/jdk.tar.gz -C /opt/jdk --strip-components=1 \
    && tar -xzf /tmp/hadoop.tar.gz -C /opt/hadoop --strip-components=1 \
    && rm -f /tmp/jdk.tar.gz /tmp/hadoop.tar.gz

COPY core-site.xml /opt/hadoop/etc/hadoop/core-site.xml
COPY hdfs-site.xml /opt/hadoop/etc/hadoop/hdfs-site.xml
COPY entrypoint.sh /usr/local/bin/hdfs-entrypoint.sh
RUN chmod +x /usr/local/bin/hdfs-entrypoint.sh

EXPOSE 9870 9864 9000
ENTRYPOINT ["/usr/local/bin/hdfs-entrypoint.sh"]
