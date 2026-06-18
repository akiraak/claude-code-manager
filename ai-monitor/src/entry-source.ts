import { buildEntries, type BuildEntriesOptions, type MonitorEntry } from './state';

/**
 * ダッシュボード描画の唯一のデータソースを抽象化する seam。
 *
 * 現行 (local モード) はローカル FS / `/proc` を pull する {@link LocalEntrySource}。
 * 公開サーバ (server モード) はリモート端末の FS を読めないため、Phase 3 で
 * 集約ストアを読む `RemoteEntrySource` を実装してここに差し替える。
 *
 * `views.ts` / `server.ts` の描画系は `EntrySource.buildEntries()` の返す
 * `MonitorEntry[]` にだけ依存させ、データの出どころ (pull / push) を意識させない。
 */
export interface EntrySource {
  buildEntries(opts?: BuildEntriesOptions): Promise<MonitorEntry[]>;
}

/**
 * 現行どおりローカルの `/proc` + `~/.claude/projects` + marker を pull する実装。
 * 既存の自由関数 {@link buildEntries} に委譲するだけで、挙動は完全に同一。
 */
export class LocalEntrySource implements EntrySource {
  buildEntries(opts: BuildEntriesOptions = {}): Promise<MonitorEntry[]> {
    return buildEntries(opts);
  }
}
