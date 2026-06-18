#!/usr/bin/env node
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';

// repo root の .env を読む。__dirname は dist/ もしくは src/ なので 2 階層上がリポジトリ直下。
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { parseClientTokens, assertServerAuthConfigured } from './auth';
import { RemoteEntrySource } from './entry-source';
import { startServer } from './server';
import { AggregateStore } from './store';
import { loadClientConfig, startUplink } from './uplink';

type Mode = 'local' | 'client' | 'server';
const MODES: readonly Mode[] = ['local', 'client', 'server'];

interface Options {
  port: number;
  host: string;
  mode: Mode;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { port: 8181, host: '127.0.0.1', mode: 'local' };
  const setMode = (v: string | undefined): void => {
    if (!v || !MODES.includes(v as Mode)) {
      throw new Error(`--mode が不正です: ${v} (local|client|server)`);
    }
    opts.mode = v as Mode;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') {
      setMode(argv[++i]);
    } else if (a.startsWith('--mode=')) {
      setMode(a.slice('--mode='.length));
    } else if (a === '--port') {
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
  --mode <m>     local | client | server (デフォルト: local)
  --port <n>     バインドするポート (デフォルト: 8181)
  --host <addr>  バインドするホスト (デフォルト: 127.0.0.1)
  --help, -h     このヘルプを表示

モード:
  local   ローカル FS を pull して loopback 配信 (現行どおり)
  client  ローカル FS を pull しつつ公開サーバへ push (Phase 4 で実装)
  server  公開アグリゲータ。端末別 Bearer で push を受け集約する
`);
}

try {
  const opts = parseArgs(process.argv.slice(2));
  if (process.env.ANTHROPIC_API_KEY) {
    console.log('[ai-monitor] ANTHROPIC_API_KEY: 検出 (要約機能 有効)');
  } else {
    console.warn('[ai-monitor] ANTHROPIC_API_KEY: 未設定 (要約機能 無効)');
  }

  if (opts.mode === 'server') {
    // 端末別トークンを fail-fast 検証してから startServer に渡す (photorans 流儀)。
    const clientTokens = parseClientTokens(process.env.CCM_CLIENT_TOKENS);
    assertServerAuthConfigured(clientTokens);
    const corsOrigins = parseClientTokens(process.env.CCM_CORS_ORIGIN);
    console.log(`[ai-monitor] mode: server (ingest tokens: ${clientTokens.length}, CORS origins: ${corsOrigins.length})`);
    // 集約ストアを生成し、ingest (opts.store) と描画 (RemoteEntrySource) で同一インスタンスを共有する。
    const store = new AggregateStore();
    startServer({ ...opts, clientTokens, corsOrigins, store }, new RemoteEntrySource(store));
  } else if (opts.mode === 'client') {
    // client: ローカルダッシュボード (loopback・local と同挙動) に加えて公開サーバへ uplink push。
    // 送信設定の検証 (fail-fast) は startServer より先に行い、不正なら exit 1 させる。
    const config = loadClientConfig(process.env, os.hostname());
    console.log('[ai-monitor] mode: client');
    startServer(opts);
    startUplink(config);
  } else {
    console.log(`[ai-monitor] mode: ${opts.mode}`);
    startServer(opts);
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[ai-monitor] 起動に失敗しました: ${msg}`);
  process.exit(1);
}
