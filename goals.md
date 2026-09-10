# 目标
1. 支持多个es索引的导出和导入，支持串行和并行
2. 支持 postgresql的数据导出和导入，支持串行和并行
3. 导出和导入都使用golang实现的导出导入引擎来实现，支持高并发（内网环境）
4. 支持导出到文件和从文件导入
5. 支持直接从一个到另一个环境
6. 支持记录导出记录，并且下一次，通过配置即可在此批量导出/导入多个索引/postgreslq表
7. 新增一个tab页，用于agentic功能，agentic的引擎使用golang实现，支持用户配置llm，包括ollama，authropic，openai的配置，支持配置embedding模型
8. 支持用户使用token的方式来调用引擎和已有的配置来导出/导入数据，需要有单独的tab页面来支持用户通过token in的方式来使用工具
9. 参考`/Users/paul/projects/AIIP`项目来实现agentic功能