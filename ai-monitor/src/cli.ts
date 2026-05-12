#!/usr/bin/env node
import { startServer } from './server';

interface Options {
  port: number;
  host: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { port: 8181, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') {
      const v = argv[++i];
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0 || n > 65535) {
        throw new Error(`--port が不正です: ${v}`);
      }
      opts.port = n;
    } else if (a.startsWith('--port=')) {
      const v = a.slice('--port='.length);
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0 || n > 65535) {
        throw new Error(`--port が不正です: ${v}`);
      }
      opts.port = n;
    } else if (a === '--host') {
      const v = argv[++i];
      if (!v) throw new Error('--host に値がありません');
      opts.host = v;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`未知の引数: ${a}`);
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(`ai-monitor - 稼働中の Claude Code CLI を可視化する vibeboard customTabs プラグイン

使い方:
  ai-monitor [options]

オプション:
  --port <n>     バインドするポート (デフォルト: 8181)
  --host <addr>  バインドするホスト (デフォルト: 127.0.0.1)
  --help, -h     このヘルプを表示
`);
}

try {
  const opts = parseArgs(process.argv.slice(2));
  startServer(opts);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[ai-monitor] 起動に失敗しました: ${msg}`);
  process.exit(1);
}
