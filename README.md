# yuque-exporter

将语雀知识库导出到本地。基于 [atian25/yuque-exporter](https://github.com/atian25/yuque-exporter)，补充当前正文格式、分页、缓存和导出完整性处理。

## 桌面应用（推荐）

普通用户可以直接使用打包好的桌面程序，无需安装 Node.js。

```powershell
npm run build:desktop      # 产出可执行文件（不含安装包）
npm run build:installer    # 产出 NSIS 安装包
```

产物在 `src-tauri/target/release/`。第一次构建需要 Rust 工具链（rustup + MSVC Build Tools）和 WebView2 运行时（Windows 11 已内置）。

应用由两部分组成：

| 文件 | 作用 |
| --- | --- |
| `yuque-exporter.exe` | 原生外壳（约 4 MB），负责窗口与生命周期 |
| `yuque-exporter-core.exe` | 导出核心（sidecar），本地 HTTP 服务 |

两个文件必须放在同一目录。关闭窗口时 sidecar 会一并退出。

**token 配置**：桌面版读取环境变量 `YUQUE_TOKEN`。在 PowerShell 里执行一次即可持久生效：

```powershell
[Environment]::SetEnvironmentVariable('YUQUE_TOKEN','你的token','User')
```

设置后需要重新打开应用。

## 安装与使用

需要 Node.js 20.6 或更新版本，建议使用 Node.js 24。


```powershell
npm ci
npm run build
Copy-Item config.toml.example config.toml

# 在本机设置 token，不要把真实 token 提交到仓库。
$env:YUQUE_TOKEN = '<你的语雀 token>'
npm run start:prod
```

编辑 config.toml 中的 `[yuque.target].repos`。例如文档链接为 `https://www.yuque.com/owner/book/slug`，填写 `owner/book`。未指定知识库时，会导出当前 token 可见的全部 Book 类型知识库。

也可以直接调用 CLI：

```powershell
node dist/bin/cli.js owner/book --outputDir ./storage
node dist/bin/cli.js --config ./config.toml
node dist/bin/cli.js crawl owner/book
node dist/bin/cli.js build owner/book
node dist/bin/cli.js --help
```

`crawl` 仅抓取元数据与正文；`build` 从已有缓存导出，允许离线运行且无需 token。指定知识库时仅处理这些知识库；传入单独的 owner 会处理其知识库。`npm run start:dev` 使用同一配置入口。

配置优先级为：显式 CLI 参数 > 环境变量 `YUQUE_TOKEN` > TOML > 默认值。TOML 的相对 outputDir 相对于 TOML 文件所在目录；CLI 的相对路径相对于当前工作目录。CLI 不打印参数对象或 token。

## 导出格式与结果

工具将正文按实际字段和格式分派，不会把缺失正文转换成空 Markdown：

| 内容 | 导出结果 |
| --- | --- |
| 普通 Markdown / 转换后的普通 Doc | `.md`，保留 GFM 表格、任务列表和转义含义 |
| 未发布文档 | 优先使用 `body_draft` / `body_draft_lake`，避免旧发布快照覆盖草稿 |
| legacy 正文缺失或仅有原生富文本的已发布普通 Doc | 尝试数字 doc_id 的 YFM 接口；不可用时保留可用的 legacy 格式并记录警告 |
| 原生 HTML / Lake | `.html` / `.lake` 原样保存 |
| Sheet / Table | `.sheet.json` / `.table.json`，保留原始结构；Table 的 records 分页合并，缓存同时保留每页原始正文 |
| Board / Thread 等未支持类型、缺失或无法验证的正文 | `.raw.json` 保存完整详情，标记 unsupported |
| 确认的空文档 / UNCREATED_DOC 目录占位 | 记录 empty / uncreated，不生成 0 字节文件 |

Sheet/Table 的原始 JSON 与 Lake 备份并不等于已经转换为离线可编辑的表格或完全离线可浏览的页面。HTML/Lake 内嵌资源、语雀组件等可能仍依赖语雀。所有格式的原始详情保存在 `.meta/`。

每次导出生成 `outputDir/export-report.json`，列出 namespace、slug、title、status、files、source、warnings、message 以及 preserved（旧有效输出是否保留）。统计区分 exported、empty、uncreated、unsupported、failed。失败或 unsupported 时进程退出码为 1，其他文档继续导出；资源警告会保留远程链接并记录在报告中。

图片与可直接访问的附件仅在完整下载成功后改写为本地路径。403、登录 HTML、空文件或网络中断不会留下虚假的本地链接；需要登录才能访问的资源仍需人工处理。

## 缓存与重新导出

缓存使用 `cache-manifest.json`（schemaVersion 2），比较 content_updated_at、updated_at、draft_version、published_at、status 等元数据，并验证缓存正文文件的内容哈希。详情成功原子保存后才提交对应缓存记录。空坏缓存、文件缺失、版本变化和失败抓取都会在后续运行重新处理；旧 `docs-published-at.json` 不作为成功依据。

旧缓存可用于离线 build；首次在线抓取会重新验证并迁移。新详情的缓存文件名为 `doc-<编码后的slug>.json`，以支持特殊字符且避免路径穿越。

`--clean` / `clean = true` 表示强制重新抓取全部文档，保留原有文件。正文失败、无法验证或变空时不会覆盖以前的非空导出；报告会列出保留的文件。此前版本留下且路径能够对应的 0 字节占位文件会清理。不会删除被移除或改名文档的旧非空文件。

列表按 offset/limit 完整分页，Table 按 page/page_size 读取；重复页、截断、跨页版本变化等会报错。429 / 502 / 503 / 504 与暂时网络错误进行有界重试；鉴权失败不重试。超过 60 秒的 API Retry-After 会报错并等待下次运行。默认并发 4，每个请求超时 30 秒。

## 验证

```powershell
npm run lint
npm test
```

`npm test` 先构建当前源码，再执行正文、SDK、本地 HTTP 导出、源代码 CLI 与编译后 CLI 的回归测试。测试使用临时目录和合成 token，不依赖真实语雀账号。CI 配置覆盖 Windows / Ubuntu 与 Node.js 20 / 24；本地执行结果以本次修复测试报告为准。

兼容性依据为语雀官方公开 [CLI 规格](https://github.com/yuque/yuque-open-cli/blob/ec06cfa5fd24a2ee7a9339d178586c52beaf0068/spec/yuque-openapi.yaml)及 [MCP 文档读取实现](https://github.com/yuque/yuque-mcp-server/blob/757a408c29cb21ba493a22de2ac99126d2460f75/src/tools/doc.ts)。它们不替代真实账号对失败文档、token 权限和受保护附件的验证。
