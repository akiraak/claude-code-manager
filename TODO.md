# TODO

## ダッシュボード
- [ ] 動作中のプロセスが「停止中」と表示される。ステータスが分からないのでどのような状態で何が出るのか整理 ([plan](docs/plans/dashboard-state-clarify.md))
    - [x] Phase 1: デバッグ API / `?debug=1` で判定根拠を表に出し、停止表示になる入力値を採取
    - [x] Phase 2: 突合キーを cwd → projectDir に変更し、cd 後も 1 セッションが 1 カードにまとまるよう dedup
    - [ ] Phase 3: バッジ色 / tooltip / state 定義表を README, CLAUDE.md に追記
- [ ] カードをタップするとdashboaerdが全体表示される。プロセスごとの詳細ページに飛ばして
- [ ] /clear などコマンドを打つと xml が表示されるので コマンドが表示されるように

- [ ] プロセスの表示はtool_useとtool_resultがほとんどなので、それはグループ化する。ユーザー入力と最終的な出力が見やすくなるようにする