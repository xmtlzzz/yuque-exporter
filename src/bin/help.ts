// The help text is inlined so it survives bundling into a single executable,
// where import.meta.url points inside a virtual filesystem.
export const HELP_TEXT = `yuque-exporter [crawl|build] [owner/book ...] [options]

Export Yuque documents and write export-report.json.
Requires Node.js 20 or newer. Without targets, export all visible Book repositories.

Examples:
  yuque-exporter --config=config.toml
  yuque-exporter owner/book --outputDir=./storage
  yuque-exporter crawl owner/book
  yuque-exporter build owner/book

Use YUQUE_TOKEN for authentication. Priority: explicit CLI option > environment > TOML.
The build command and --help work without a token.

Options:
  --help, -h       Show help
  --config         TOML file (default: config.toml in current directory)
  --token          Yuque token; prefer the YUQUE_TOKEN environment variable
  --host           Yuque host (default: https://www.yuque.com)
  --outputDir      Output directory; CLI paths are relative to current directory
  --concurrency    Parallel document reads (default: 4)
  --retries        Additional HTTP read attempts (default: 3, maximum: 10)
  --timeout        Timeout per request in milliseconds (default: 30000)
  --clean          Refetch every document; preserve existing files on failure

Markdown exports use .md. HTML/Lake and Sheet/Table data retain their original
representations. Empty and uncreated documents are reported without 0-byte files.
Failed or unsupported exports exit with code 1; inspect export-report.json.

See https://github.com/xmtlzzz/yuque-exporter for details.`;
