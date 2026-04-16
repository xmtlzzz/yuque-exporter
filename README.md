# yuque-exporter

## 项目目的
因为语雀开始收费了，但是导出文档又麻烦，所以选择迁移

## 项目支持
本项目是基于atian25大佬的项目进行了一些bug的修复

因为项目本身在24年停止维护，所以借助C老师神力进行修复

项目源地址：
https://github.com/atian25/yuque-exporter

## 配置读取
通过config.toml作为项目配置文件：
1. [yuque]：用来配置语雀的url以及保存路径
2. [yuque.target]：传入指定的路径
  - 语雀分享文档存在一个链接如 https://www.yuque.com/xinrimulikaomianjin/xu665a/ywze5f5
  - 这里需要复制的就是xinrimulikaomianjin/xu665a部分传入进去即可

## 工具调用方式
```bash
# 依赖安装
npm install

# 运行
set YUQUE_TOKEN=QBAJjfRfibUgFsdla6EgxRfbwc5SQdFuT7NDRJII&& npm run start:dev 
```