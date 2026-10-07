# 作業状態と再開用メモ — 2026-10-05

## 完了した段階

ユーザーの「次の段階」指示による Phase 3 の応答蒸留を完了した。Phase 1 のデータ基盤と Phase 2 の CPU LoRA 学習・ローカル Provider・モデル比較を維持し、導入済みのローカル7B教師からテスト済みの編集応答を収集して追加学習した。

## 最終候補と測定

- 設定：`training/configs/distillation-balanced.yaml`。
- ベース：Qwen2.5-Coder-0.5B-Instruct、Apache-2.0、固定リビジョン `ea3f2471cf1b1f0db85067f1ef93848e38e88c25`。
- 親：`training/models/Origin-Coder-v1-experiment/`、SHA `2e32b062c9d1e7a45960c4c1f8eeb6480d39e6b0db2fba8dbbefb8fa40806a50`。
- 最終候補：`training/models/Origin-Coder-v2-balanced-experiment/`、SHA `1b8839972ddea56a837473d2fe2a855084a783546367ee57d69bb86522a9735f`。
- CPU4スレッド、float32、LoRa rank8、学習率0.0002、48ステップ完了。
- 教師1:従来1、実際に教師24回・従来24回を更新。従来24応答すべてを再学習した。
- 教材：`training/data/distillation/phase3-teacher-verified/`（train4、validation2の教師編集応答）。
- 混合データ：`training/data/sft/phase3-mixed/`（train28、validation10応答）。
- 検証10応答の平均損失：0.074087 → 0.001078。
- 通常生成の従来課題：2/2 → 2/2。`training/experiments/phase3-balanced-free-retention/comparison.json`。
- 通常生成の新しい tune：1/2 → 2/2。`training/experiments/phase3-balanced-free-tune/comparison.json`。
- 通常生成の未使用 holdout：1/4 → 4/4、成功率差+0.75。`training/experiments/phase3-balanced-final-holdout/comparison.json`。
- Node188件、Python30件、型チェック通過。Nodeログ：`training/experiments/phase3-node-tests.log`。

最終比較は greedy、生成上限90秒、通信待ち120秒、同じベースモデル・Agent・3ツール・最大5ステップ・作業パスで実行した。`--guided-tools` は使用していない。clamp / threshold の未使用パラメーターでの小規模試験であり、広いコード修正能力は未検証。

## 最終評価の扱い

モデル・コード・設定を固定した後に新しい4課題を生成し、一度だけ評価した。`private-holdout/` の課題・個別履歴は開いていない。最終評価後にモデル・評価コードを調整していない。

この候補の最終比較は完了済み。再実行せず、`holdout-lock-<adapter-sha>.json` と全成果物を保持する。以後の改善に個別の holdout 内容を使わない。将来の別候補は別の未使用評価セットで測る。

## 不採用の最初の候補

`training/models/Origin-Coder-v2-distilled-experiment/`（SHA `5ed5c56f2405702b31444d50c5f68254f920242ff005d4ad72bf1c5cfcd1e2bb`）は教師3:従来1、学習率0.0005、32ステップ。構文制約付きでは改善したが、通常生成の従来課題が2/2 → 0/2へ退行したため採用しない。重みと比較記録を保持する。

最初の教師生成 `phase3-teacher/` は比較演算子の検査誤りで未採用。JSONLを公開しておらず学習には使用していない。初期の構文制約試験 `phase3-guided-tune/` は時間切れと busy で比較不成立。能力改善の根拠に使わない。

## 保存と実行状態

学習記録は各モデルの `origin-training.json`、48ステップのログは `training/experiments/phase3-balanced-training.log`。教師は `qwen2.5-coder:7b`、digest `dae161e27b0e90dd1856c8bb3209201fd6736d8eb66298e75ed87571486f4364`。教材の応答・出所・検証記録も保存した。

教師7Bは教材生成後にメモリから解放済み。検査用サーバーと一時的なスリープ補助は終了済み。モデル・データ・実験成果物はGit対象外。ソース変更は未コミットで元のmain作業ツリーに保持する。

必要な場合は取得済みモデルだけでサーバーを再起動する。

```powershell
training/.venv/Scripts/python.exe training/scripts/serve-model.py --adapter training/models/Origin-Coder-v2-balanced-experiment --baseline-adapter training/models/Origin-Coder-v1-experiment --generation-timeout 90
npm start -- --provider origin --model candidate --mode code --root examples/json-practice
```

手順と測定条件は `training/README.md`、結果の要約は `GROWTH.md`。次の段階には、教材・課題群を広げた検証が必要。Phase 4 はまだ開始していない。
