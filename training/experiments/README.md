# 学習・評価の実験記録

実験ごとにフォルダーを作り、次を記録する。成果物はローカル保存で、Git には追加しない。

- 実験 ID、日付、目的、仮説。
- Agent のコミットと未コミット変更の有無、モデルの識別子・リビジョン。
- train / validation / tune のデータファイルと SHA-256、課題の分割方針。
- 設定、seed、使用機器、依存パッケージ、実行コマンド。
- 同じ Agent・Tools・課題・マシン・タイムアウトでの baseline / candidate 評価。
- Task Success Rate、所要時間、失敗分類、採用判断とその根拠。

holdout は学習・調整中に参照しない。最終評価の合計だけを記録する。失敗の詳細を見て改善した問題は tune に移し、新しい holdout を用意する。

## Phase 2 のローカル成果物（2026-10-05）

- `phase2-pilot/comparison.json`: 最初の同系統 tune 比較。baseline 0/4、candidate 4/4。
- `phase2-pilot/baseline-1.json` / `candidate-1.json`: 各課題の採点と Agent イベント。
- `phase2-resumed-pilot/comparison.json`: 接続処理修正後の再比較。同じ4課題で再び baseline 0/4、candidate 4/4。
- `phase2-python-environment.txt`: 専用 Python 環境の依存パッケージ一覧。
- `phase2-node-tests.log`: Node テスト184件の最終検査出力。
- `../models/Origin-Coder-v1-experiment/origin-training.json`: 16ステップの学習条件・損失・データとモデルのハッシュ。

比較は greedy 生成で4課題を各1回。学習セットと同じ一次式修正の課題群なので、広い汎化はまだ確認していない。再測定は既存成果物を上書きせず、新しいフォルダーに保存する。

## Phase 3 の成果物

- `phase3-teacher-verified.log`: 教師の6課題のテスト通過。
- `../data/distillation/phase3-teacher-verified/teacher-attempts.json`: 教師の識別子・応答・検証履歴。
- `phase3-training.log`: 学習済み LoRA からの追加学習の進捗。
- `phase3-node-tests.log`: Node テスト188件。
- `phase3-tune/comparison.json`: 構文制約なしの最初の比較。baseline 0/2、candidate 0/2。
- `phase3-guided-tune/`: 同じ構文制約を両モデルに付けた tune 比較。
- `phase3-final-tune/comparison.json`: 編集ガードと同じ識別子制約での比較。baseline 0/2、candidate 2/2。
- `phase3-guided-fast-tune/comparison.json`: 最初の高速化後の比較。0/2 → 2/2だが、baseline の生成時間切れを含む。

`phase3-guided-tune/` の初期結果は通信時間切れの後に busy が続いたため比較不成立。元の出力は保存し、能力改善の根拠には使わない。

- `phase3-retention/comparison.json`: 構文制約付きの従来2課題。0/2 → 2/2。親モデルはテストを繰り返し終了できなかった。
- `phase3-free-retention/comparison.json`: 通常生成の従来2課題。2/2 → 0/2となり、最初の候補は採用しない。
- `phase3-balanced-training.log`: 1:1・学習率0.0002・48ステップの別候補の学習ログ。
- `phase3-balanced-processes.json`: 学習プロセスと実行中だけのスリープ補助の起動記録。
- `../models/Origin-Coder-v2-balanced-experiment/origin-training.json`: 48ステップ完了。教師24回・従来24回、検証10応答の平均損失0.074087 → 0.001078。従来24応答すべてを再学習。
- `phase3-balanced-free-retention/comparison.json`: 最終候補の通常生成での従来2課題。baseline 2/2、candidate 2/2。
- `phase3-balanced-free-tune/comparison.json`: 最終候補の通常生成での新しい2課題。baseline 1/2、candidate 2/2。
- `phase3-balanced-final-holdout/comparison.json`: モデル・コード・設定固定後に作った未使用4課題を一度だけ比較。通常生成で baseline 1/4、candidate 4/4、成功率差+0.75。課題内容・個別履歴は参照していない。

最終候補のアダプター SHA-256 は `1b8839972ddea56a837473d2fe2a855084a783546367ee57d69bb86522a9735f`。最終検査は Node188件、Python30件、型チェックが通過。通常生成の比較では `--guided-tools` を使わない。

holdout 比較はモデル・コード・設定を固定してから作る課題を使い、`comparison.json` の合計だけを確認する。`private-holdout/` の個別履歴は改善に使わない。候補ごとの `holdout-lock-<adapter-sha>.json` を保持し、完了済み評価を繰り返さない。中断した同一条件の評価は `--resume` で継続する。
