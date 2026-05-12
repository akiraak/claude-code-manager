# vibeboard customTabs プラグイン仕様

vibeboard の topbar に外部プロセスを「タブ」として埋め込むための拡張機構。

vibeboard は **タブ表示・サイドバー描画の外殻・SSE 接続** だけを担当し、
右ペインの中身はプラグインが返す HTML を **iframe** に表示する。

## 用語

- **プラグイン**: customTabs に登録される 1 つの HTTP サーバ。
- **vibeboard ホスト**: プラグインを取り込む側の vibeboard サーバ。
- **item**: サイドバーに並ぶ 1 行 = 右ペインの 1 ページ単位。`id` で識別される。

## vibeboard.config.json での登録

```json
{
  "customTabs": [
    {
      "name": "ai-monitor",
      "label": "AI Monitor",
      "baseUrl": "http://127.0.0.1:8181"
    }
  ]
}
```

- `name` (必須): URL セグメント / ハッシュキー。`[A-Za-z0-9][A-Za-z0-9-]*` のみ。
  - 予約名: `todo`、および `categories[].name` と衝突不可。
- `label` (任意): タブ表示名。省略時は `name` を使う。
- `baseUrl` (必須): `http://` または `https://` のみ。query/fragment 不可。
  末尾スラッシュは正規化で除去される。

## プラグインが公開する HTTP エンドポイント

すべて読み取り専用 (`GET` のみ)。書き込み系は本仕様には含まない。

### `GET {baseUrl}/api/sidebar`

サイドバーに並べる項目を返す。

**レスポンス (`200 OK`, `Content-Type: application/json`)**:

```jsonc
{
  "items": [
    {
      "id": "dashboard",           // 必須: URL 安全な文字列
      "label": "Dashboard",         // 必須: サイドバー 1 行目に表示
      "sub": "全 CLI のサマリ",      // 任意: 2 行目（薄文字）
      "group": "dashboard",         // 任意: グループ見出し (連続する同名 group はまとめて表示)
      "badge": "●"                  // 任意: 行右端の小バッジ
    }
  ]
}
```

ホスト側の挙動:

- `id` は URL 安全な文字列にすること。ホスト側は `encodeURIComponent` 経由でハッシュに乗せる。
- `items` が空配列のときは「項目がありません」を表示する。
- 各 `id` の重複チェックはホストでは行わない（プラグイン側の責任）。

### `GET {baseUrl}/view?item=<id>`

右ペインに iframe で表示する HTML を返す。

**レスポンス (`200 OK`, `Content-Type: text/html`)**:

- 任意の HTML を返してよい。iframe 内で完結する body を返すのが推奨。
- 推奨ヘッダ:
  - `Cache-Control: no-store`
  - `Content-Security-Policy: frame-ancestors http://127.0.0.1:*`
- vibeboard ホスト側からのナビゲーション制御は無いため、リンクは `target="_top"` で
  `#<custom-tab-name>/<id>` を指定するか、`parent.postMessage` を使うこと。

### `GET {baseUrl}/api/watch`

サイドバー / 表示中 item の更新を SSE で通知する。

**レスポンス (`200 OK`, `Content-Type: text/event-stream`)**:

イベント種別:

| event           | data                                        | ホストの挙動                                                       |
| --------------- | ------------------------------------------- | ------------------------------------------------------------------ |
| `sidebar`       | 任意 (なくてもよい)                         | `/api/sidebar` を再フェッチして左ペインを描き直す                  |
| `item-changed`  | `{ "id": "<item id>" }` (JSON 文字列)       | 表示中の iframe が同じ `id` ならキャッシュ無効化のため reload する |

keep-alive のため、30 秒ごとに `: ping\n\n` を送ってよい。

ホスト側の挙動:

- アクティブな customTab が 1 つになるよう、タブ切替時に既存接続を必ず close する。
- 接続失敗・切断時は EventSource の自動再接続に任せる（ホスト側からの明示的再接続は行わない）。

## CORS / セキュリティ要件

- プラグインは **`127.0.0.1`** にのみバインドすること（外部公開禁止）。
- 全レスポンスに `Access-Control-Allow-Origin: *` を付ける。
  - ループバック専用前提なので `*` 許容で十分。Credentialed リクエストは想定しない。
- `GET /api/sidebar` / `GET /api/watch` は `Cache-Control: no-store` を付ける。
- 単純 GET のみで preflight は基本不要。将来書き込み API を追加するなら別途定義する。
- `/view` のレスポンスには `Content-Security-Policy: frame-ancestors http://127.0.0.1:*`
  を付けると、ループバック以外への埋め込み事故を防げる（任意）。

## エラーハンドリング

- プラグインの `/api/sidebar` が取得失敗 (HTTP エラー / 接続不能) のとき、ホストは
  サイドバーに「`<label>` に接続できません」を表示する。タブ自体はクラッシュさせない。
- `/view` が 404 等を返した場合、iframe 内に該当のエラーページが表示される。
- `/api/watch` が応答しない / 失敗した場合は EventSource の自動再接続に任せる。
  サイドバーや iframe の描画自体は SSE 失敗とは独立に動く。

## URL ルーティング

ホスト側の hash ルーティング: `#<custom-tab-name>/<id>` 形式。

- hash が `#ai-monitor/dashboard` のとき、`ai-monitor` タブの `dashboard` item を表示。
- hash が `#ai-monitor` のみ（`/` を含まない）の場合は表示なし（empty state）。
- `<id>` 部分は `encodeURIComponent` でエンコードされてハッシュに乗る。

## サンプル

最小実装は `vibeboard/sample-custom-tab/` を参照。
