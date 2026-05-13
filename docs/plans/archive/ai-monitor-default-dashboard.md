# AI Monitor を開いたら Dashboard が表示されるようにする

## 目的・背景

現在、トップバーの **AI Monitor** タブを初めて開く / リロードする / 他タブから戻ると、右ペインが空 (`サイドバーからドキュメントを選択してください。`) のまま表示される。
ユーザーは毎回サイドバー先頭の `Dashboard` を手動でクリックする必要があり、初手の体験が悪い。

期待値: AI Monitor タブをアクティブにしたら、ペイン中央に **Dashboard** ビュー (`/view?item=dashboard`) が自動で表示される。

## 対応方針

vibeboard 側の customTab 共通処理として「item 未指定で customTab に入ったらサイドバー先頭の項目に自動遷移する」を実装する。`dashboard` という ID を vibeboard 側にハードコードしない (他 customTab 実装の汎用性を保つため)。

- AI Monitor の `/api/sidebar` は既に `Dashboard` を items の **先頭** で返している (`ai-monitor/src/server.ts:37`)
- 「先頭が初期表示」というのは customTab プラグインの自然な約束ごとと位置付ける

### 変更箇所

- `vibeboard/src/web/app.js`
  - `renderCustomTabSidebar(name)`: サイドバー描画完了後、`activeCategory === name` かつ現在の location.hash がそのタブの item を指していないなら、先頭 item へ `location.replace('#<name>/<firstId>')` で遷移する
  - hash 同期は `replace` を使い、戻る履歴に空状態を残さない
  - 既にユーザーが別の item を選んでいる場合は何もしない
  - サイドバーが空 / fetch エラーのときは従来通り `showEmpty()` のまま

副作用が出ない理由:
- 通常のドキュメントタブ (specs/plans/editable) には影響しない (`renderCustomTabSidebar` は customTab のときだけ呼ばれる)
- AI Monitor 以外の customTab を後から追加しても、先頭 item に飛ぶだけなので破綻しない

## 影響範囲

- `vibeboard/src/web/app.js` のみ。サーバ側 (`vibeboard/src/server.ts`, `ai-monitor/*`) の変更は不要
- `vibeboard` の TypeScript ビルドは `web/app.js` を含めて静的配信しているだけなので、`vibeboard/` ディレクトリで `npm run build` を実行して dist に反映する

## テスト方針

手動検証のみ:

1. `./run-ai-monitor.sh` で 8180/8181 を再起動
2. ブラウザで `http://localhost:8180` を開き、**AI Monitor** タブをクリック → Dashboard ビューが即座に表示されること
3. リロードしても Dashboard が表示されること
4. サイドバーで個別プロセスを選択 → URL hash が `#ai-monitor/proc:...` に変わり、そのビューが表示されること
5. AI Monitor タブから TODO や specs タブに切り替え、再度 AI Monitor タブに戻る → 再度 Dashboard が表示されること (前回選択した item を覚えていなくても OK の判断)
6. 他タブ (TODO / specs / plans) の挙動が変わっていないこと
