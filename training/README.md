# Origin-Coder 学習基盤 — Phase 1 / Phase 2 / Phase 3

既存の TypeScript Agent・Provider・Memory・Tools・Evaluation を維持し、評価履歴を Python 側で学習資産へ変換する。Phase 1 は標準ライブラリだけで動くデータ基盤、Phase 2 は実際の LoRA 学習・ローカル推論・同一 Agent でのモデル比較。

## 編集失敗からの復帰を学習する

`recovery-curriculum.ts` は、ファイルの読み取り後に別の操作で同等の実装へ更新され、古い置換文字列での編集が拒否された状況を作る。その後の「現在のファイルを読む → 実物に合う編集 → テスト → 完了」の4応答を、実際の Agent・Tools と同じ Provider 入力で記録する。最初の読み取りと拒否された編集は固定の前提で、学習の正解ターゲットには含めない。失敗の履歴は文脈として保持し、損失は最後の正しい応答だけに掛ける。

通常の一次式修正6課題・24応答と、復帰4課題・16応答を混ぜて学習する。検証は別の通常2課題・復帰2課題の全16応答。全教材で固定テストの通過、隣の関数・テストファイルの保持、Agent によるテスト実行、正常終了を確認してから保存する。既存の tune / holdout は教材として参照しない。

```bash
# リポジトリのルート。基盤の環境構築・固定ベースモデル取得は Phase 2 と共通。
node scripts/recovery-curriculum.ts generate training/data/recovery
training/.venv/bin/python training/scripts/train-lora.py --config training/configs/recovery.yaml --check
training/.venv/bin/python training/scripts/train-lora.py --config training/configs/recovery.yaml

# 別のターミナル。取得済みモデルを使用し、構文制約は付けない。
training/.venv/bin/python training/scripts/serve-model.py --adapter training/models/Origin-Coder-recovery-experiment --threads 2 --generation-timeout 90

# 同じベースモデルで、LoRA 無効の baseline と有効の candidate を比較。
training/.venv/bin/python training/scripts/evaluate-model.py --curriculum recovery --tasks 2 --output training/experiments/recovery-tune
training/.venv/bin/python training/scripts/evaluate-model.py --curriculum affine --tasks 2 --output training/experiments/recovery-affine
```

Windows は `training/.venv/bin/python` を `training/.venv/Scripts/python.exe` に置き換える。既存の保存先は上書きしない。再学習時は教材の新しい保存先を指定し、設定ファイルの入力・出力も更新する。学習済みモデルを使う場合はサーバー起動後に `npm start -- --provider origin --model candidate --mode code --root <作業フォルダー>` を実行する。

復帰の評価は、両モデルに同じ固定の失敗前提2ステップを渡してからモデルに続きを生成させる。予定した正しい置換先の式は失敗操作に含まれているため、この評価だけで式を推理する能力の改善とは判断しない。更新後のファイルを読み直さなかった場合、テストを実行しなかった場合、修正が不正確な場合、未完了の場合は失敗とする。これは編集失敗後の継続能力を測る小規模な tune 評価で、最初からの自律的な作業全体や未使用 holdout の評価とは区別する。課題ごとの履歴・モデルとコードのハッシュ・生成条件は比較レポートに保存する。

この設定は既存の Phase 2 / 3 アダプターを上書きせず、ベースモデルから別の実験として学習する。過去の学習済みアダプターとの優劣を示す比較ではない。

`recovery.yaml` は CPU 2スレッド・bfloat16 で48ステップ学習する。bfloat16 の演算に対応した CPU では学習時間とメモリを抑えられる。推論サーバーは既定で候補の学習記録から数値形式を読み、比較対象と候補の両方に同じ形式を使う。既存の設定・学習記録は float32 を維持する。`--dtype float32` で明示的に変更した場合は別条件の測定として扱う。

### 2026-10-11 の実機結果

同じベースモデルで LoRA の無効・有効を切り替え、構文制約なしの greedy 生成で比較した。復帰2課題は0/2 → 2/2、最初から取り組む通常編集2課題も0/2 → 2/2。全16検証応答の平均損失は0.915314 → 0.068698。48ステップで40種類のターゲットすべてを使用した。これは前述の小規模な tune 評価で、未使用 holdout と広いリポジトリ修正の成績は未確認。

設定・データ・重みのハッシュ、学習環境、両評価の生成条件と集計は [比較記録](../results/2026-10-11-recovery-training.json) に保存した。Node 192件、Python 31件、型チェックが通過した。

## Phase 3: ローカル Teacher による応答蒸留

導入済みの `qwen2.5-coder:7b` を教師にし、範囲制限（clamp）と境界判定（threshold）の編集案を作る。教師への入力は新しく作る train / validation の課題と実ファイルの内容。Teacher は編集の JSON 引数を生成し、固定テストと隣の関数の保持を確認できた `edit_file` 応答だけを蒸留ターゲットにする。読み込み・テスト・完了回答は固定手順で実行する。教師の推論過程は収集しない。

学生は Phase 2 の LoRA から初期化し、教師由来のターゲットと Phase 2 の教材を混ぜて学習する。最初の3:1の候補は通常生成で従来課題が退行したため採用せず、1:1・学習率0.0002・48ステップの別候補を学習した。教師24回・従来24回を更新し、従来24応答すべてを再学習した。検証10応答の平均損失は0.074087から0.001078へ低下。通常生成の従来課題は2/2を保持し、新しい tune は1/2から2/2に改善した。これは応答を使った SFT 蒸留で、教師の logits は使わない。最終モデルの推論は取得済みのベースモデルとアダプターだけで動く。

```powershell
# 新しい保存先を指定する。Ollama の既存モデルを使い、自動ダウンロードしない。
node scripts/distill-curriculum.ts generate training/data/distillation/my-teacher-run
training/.venv/Scripts/python.exe training/scripts/prepare-distillation.py --teacher training/data/distillation/my-teacher-run --output training/data/sft/phase3-mixed
training/.venv/Scripts/python.exe training/scripts/train-lora.py --config training/configs/distillation-balanced.yaml --check
training/.venv/Scripts/python.exe training/scripts/train-lora.py --config training/configs/distillation-balanced.yaml

# 追加学習前・後のアダプターを、同じベースモデル上で比較する。
training/.venv/Scripts/python.exe training/scripts/serve-model.py --adapter training/models/Origin-Coder-v2-balanced-experiment --baseline-adapter training/models/Origin-Coder-v1-experiment --generation-timeout 90
training/.venv/Scripts/python.exe training/scripts/evaluate-distillation.py --split tune --output training/experiments/my-distill-tune

# 学習・設定・コードを確定してから実行する最終評価。
training/.venv/Scripts/python.exe training/scripts/evaluate-distillation.py --split holdout --output training/experiments/my-distill-final
```

既存のデータやモデルがある場合は `distillation-balanced.yaml` の入力・出力を新しい保存先へ変更する。Teacher 接続先は `ORIGIN_TEACHER_HOST`（既定 `http://127.0.0.1:11434`）、モデル名は `ORIGIN_TEACHER_MODEL`。ローカル HTTP 接続先だけを許し、リダイレクトは拒否する。Ollama 7B の digest、生成条件、入力・応答の SHA-256、元の JSON 応答を保存する。教材の公開前に教師の識別子を再照合する。

教材の編集範囲は対象の `return value;` だけ。式は数値、`value`、`Math.min/max`、算術・比較・真偽値・三項演算に限定して実行し、任意コードの実行を防ぐ。モデルは編集前に対象ファイルを読む必要がある。生成失敗は試行記録に残し、学習用 JSONL は予定した全課題のテストが通った後に公開する。準備段階で分割・出所・応答ハッシュ・実際の教師パッチと SFT ターゲットの一致を確認する。マスクで内容が変わる例は拒否する。

`--guided-tools` はこの小規模試験用の任意の構文制約。両アダプターに同じ [LM Format Enforcer](https://github.com/noamgat/lm-format-enforcer) 0.11.3 を適用し、1回のツール呼び出し、JSON の必須項目、`return value;` の置換、許可した識別子での1行の return 式、許可済みテストコマンドを制約する。ツールの選択・パス・式の演算子や数値・最終回答はモデルが生成し、正解の式は与えない。構文制約は意味の正しさを保証しないため固定テストで採点する。最初の32ステップ候補の比較で使用したが、最終48ステップ候補の評価では使わない。実機の比較は生成上限90秒、通信待ち120秒で実行する。通常のサーバー起動ではこの制約を使わず、任意のファイル編集にも適用しない。

`initial_adapter_path` の重みとベースモデルの一致を検査し、前の実験の LoRA 設定を保持して追加学習する。optimizer は新しく作る。`teacher_examples_per_replay` の既定値3は教師3:従来1、値1は1:1の順で分割内をシャッフルして巡回する。設定・分割・サンプリングはモデルを読み込む前に検査する。学習記録に親アダプターの SHA-256、実際の教師・再学習ターゲット数、使ったターゲット ID を残す。学習中にデータや設定が変わったら成果物を公開しない。

通常生成での保持確認は、同じサーバーを `--guided-tools` なしで起動し、`evaluate-model.py --output <新しいフォルダー> --tasks 2` を実行する。新しい課題での改善と従来課題の退行を別々に確認してから最終候補を固定する。`distillation.yaml` は最初の3:1の実験を再現するために保持している。

最終評価では `frozen.json` にモデル・Agent・学習/推論コード・設定を固定してから、新しい holdout の4課題を作る。学習・検証の課題 ID と照合し、両モデルで同じ作業パス・ツール・生成条件を使う。holdout の課題・個別履歴は `private-holdout/` に保存し、表示は合計の成功率だけ。候補アダプターごとに一度だけ実行できる。中断した同じ評価は、コード・モデルを変更せず `--resume` と元の `--output` を指定して続けられる。完了済み評価は再実行しない。

この holdout は同じ2種類の処理の未使用パラメーターを評価する小規模試験。幅広いリポジトリ修正や独立した課題群への汎化は、さらに別の検証が必要。

### Phase 3 の実機結果（2026-10-05）

`Origin-Coder-v2-balanced-experiment` を Phase 2 の親アダプターと比較した。すべて構文制約なしの greedy 生成、同じベースモデル・Agent・3ツール・最大5ステップ・作業パス・時間上限を使用する。

| 測定 | 追加学習前 | 追加学習後 |
| --- | ---: | ---: |
| 検証10応答の平均損失 | 0.074087 | 0.001078 |
| 従来の一次式2課題 | 2/2 | 2/2 |
| 新しい clamp / threshold の tune 2課題 | 1/2 | 2/2 |
| モデル固定後に作った未使用 holdout 4課題 | 1/4 | 4/4 |

最終比較は `experiments/phase3-balanced-final-holdout/comparison.json`、学習条件は `models/Origin-Coder-v2-balanced-experiment/origin-training.json` に保存した。アダプター SHA-256 は `1b8839972ddea56a837473d2fe2a855084a783546367ee57d69bb86522a9735f`。個別の holdout 課題・履歴は参照しておらず、評価後の調整も行っていない。この候補の最終 holdout は完了済みなので再実行しない。Node188件、Python30件、型チェックが通過した。

実装の API は [Ollama Chat](https://docs.ollama.com/api/chat) と [PEFT のモデル読込](https://huggingface.co/docs/peft/v0.17.0/en/package_reference/peft_model) に基づく。

## Phase 2: CPU で学習・推論・比較する

最初の実験は [Qwen2.5-Coder-0.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct)（Apache-2.0）をベースにする。この PC の Intel Core Ultra 5 / 約15 GiB RAM に合わせ、CPU 4 スレッド、float32、LoRA rank 8、バッチ1で実行する。CUDA 対応環境では `sft.yaml` の device を `cuda` に変更できるが、今回の実機検証は CPU。

Phase 2 の Python は 3.11 以上。実機では専用環境の Python 3.12.14 を使用した。

リポジトリのルートから実行する。既存の成果物は上書きしない。

```powershell
# 専用 Python 環境。既存 Agent の Node.js 環境はそのまま使う。
python -m venv training/.venv
training/.venv/Scripts/python.exe -m pip install -r training/requirements.txt
training/.venv/Scripts/python.exe training/scripts/download-model.py

# 新しい、実際にテストが通る小規模課題から学習例を作る。
node scripts/model-curriculum.ts generate training/data
training/.venv/Scripts/python.exe training/scripts/train-lora.py --check
training/.venv/Scripts/python.exe training/scripts/train-lora.py

# 別のターミナルで起動。取得済みファイルだけで推論する。
training/.venv/Scripts/python.exe training/scripts/serve-model.py --adapter training/models/Origin-Coder-v1-experiment

# 同じサーバー・Agent・Tools・課題・生成条件で比較する。
training/.venv/Scripts/python.exe training/scripts/evaluate-model.py --output training/experiments/phase2-pilot --tasks 4 --repeat 1

# 学習後モデルを通常の Agent で使う。
npm start -- --provider origin --model candidate --mode code --root examples/json-practice
# アダプターなしの比較対象。
npm start -- --provider origin --model baseline --mode code --root examples/json-practice
```

Linux/macOS の仮想環境では `training/.venv/bin/python` に置き換える。Python が PATH にない場合は、既存の Python 実行ファイルの絶対パスを使う。Codex 同梱の Python も利用可能。再学習は `train-lora.py --output training/models/<新しい実験名>`、比較の再実行も新しい `--output` を指定する。

実行設定は `configs/sft.yaml`。`lora` ブロックもこのファイルから読み込む。`configs/lora.yaml` と `configs/evaluation.yaml` は将来の設定案で、現行コマンドには読み込まない。実験記録の `actual_steps` に実際の学習回数、`config` に読み込んだ設定を保存する。

モデル取得時に公開モデルのライセンスを確認し、固定コミットと各ファイルの SHA-256 を `origin-base.json` に保存する。学習・サーバー起動時に実ファイルを照合する。重みは safetensors を使い、`trust_remote_code=False`、`local_files_only=True` で読み込む。推論サーバーは `127.0.0.1:18080` で動き、外部 AI API を利用しない。`ORIGIN_MODEL_HOST` と `ORIGIN_MODEL_TIMEOUT_MS` でローカル接続先と待ち時間を指定できる。

学習例は6課題×4応答、検証例は別の2課題×4応答。課題の数値・ファイル・関数名を分割ごとに変え、実際の `read_file` → `edit_file` → `run_shell` → 最終回答を保存する。元のテストを変更していないことと、固定のテストで期待した処理・隣の関数が維持されることも確認する。既存 tune / holdout は流用しない。Teacher AI を呼ばず、手で定めた小さな作業手順を実行する教材。

Phase 2 の SFT は `metadata.representation: provider_messages` の完全なシステム指示・ツール一覧・モデル入力を保存する。学習の target は最後の assistant 応答だけで、ユーザー・システム・過去の会話には損失を掛けない。モデルの chat template と推論時の `originMessages()` を使い、ツール構文を途中で切らない。Phase 1 の `agent_events` は不足した内部 context があるため、そのまま学習器に渡さず、実際の Provider 入力を収集して補う必要がある。

学習後は `adapter_model.safetensors` と `origin-training.json` を保存する。ベースモデル・データ・設定のハッシュ、バージョン、学習ログ、検証損失を記録し、更新パラメーター数は標準出力にも表示する。検証損失の低下だけでコーディング能力の改善とは判断しない。

比較では、同じベースモデルを1回読み込み、LoRA 無効の baseline と有効の candidate を切り替える。生成は greedy、同じ入力・出力トークン上限・スレッド数。新しい tune 課題は学習・検証の両方の ID と照合し、混入したら拒否する。両モデルにはシステム指示内の作業ルートも同じパスを渡す。実際のファイル編集とテスト通過、元テストと隣の関数の維持、Agent によるテスト実行、正常な終了を採点する。教材でのシェル実行は `node --test` だけを許可し、両モデルに同じ制限を適用する。比較中に Agent ソースやモデル設定が変わったら停止する。

`comparison.json` に Task Success Rate と差分を保存し、差が正の場合だけ `pilot_gain_measured`、それ以外は `no_gain_measured` と表示する。小さな同系統の課題での試験であり、広いコーディング能力や未使用 holdout での改善を証明しない。候補を自動採用・公開しない。

`npm run eval -- --provider origin --model candidate --only add-field,add-function --offline --repeat 1` で既存の評価器にも接続できる。従来の Ollama / rule Provider と `auto` の選択動作は継続する。

### 実機の学習・評価結果（2026-10-05）

学習は CPU 4 スレッドで16ステップ、更新した LoRA パラメーターは540,672個。ベースモデルの固定リビジョンは `ea3f2471cf1b1f0db85067f1ef93848e38e88c25`。学習セットは6課題の24応答で、別の2課題の8応答を検証用に保存した。

| 測定 | 学習前 | 学習後 |
| --- | ---: | ---: |
| 検証用の先頭2応答の平均損失 | 0.764574 | 0.027919 |
| 同系統 tune 4課題の成功数（各1回） | 0/4 | 4/4 |

これは数値・ファイル名・関数名を変えた一次式の修正課題での結果。損失は検証用8応答すべての測定ではない。より広いバグ修正・関数追加や未使用 holdout での改善はまだ確認していない。モデルを一から作ったものではなく、既存モデルに実際の追加学習を行った試作版。

学習記録は `models/Origin-Coder-v1-experiment/origin-training.json`、最初の比較結果は `experiments/phase2-pilot/comparison.json` に保存した。接続処理の修正後にも同じ4課題で0/4 → 4/4を再確認し、`experiments/phase2-resumed-pilot/comparison.json` に保存した。これらはローカル成果物として Git 対象外。Phase 2 専用比較レポートの `attempts[].events` は、Phase 1 の `tasks[].attempts[].trace` とは別形式。Phase 1 の収集器へ直接渡さず、既存 `npm run eval` のレポートを使う。

## 実行環境

- 既存 Agent: 現在の Node.js 環境と `npm install`。
- データ処理: Python 3.10 以上、標準ライブラリのみ。以下の `python` は使用する Python 実行ファイルに置き換えられる。
- 出力先: ローカルファイルシステムを推奨。Windows は既存宛先を置き換えない rename、POSIX はハードリンクで完成済みファイルを公開する。

## 構造

```text
training/
  data/
    raw/             評価器から取り出した成功・失敗の履歴
    cleaned/         秘密情報のマスク後の履歴・会話形式データ
    sft/             完了・成功を確認できた train の会話
    validation/      学習中の検証用。train と課題を共有しない
    tune/            見ながら改善してよい評価用
    holdout/         最終評価専用。変換・学習処理への入力は禁止
    preference/      将来の人が確認した優劣ペア用
    distillation/    検証した Teacher のパッチ・出所・応答
  scripts/
    collect-traces.py
    clean-dataset.py
    convert-traces.py
    generate-sft.py
    origin_dataset.py
    download-model.py
    train-lora.py
    origin_training.py
    serve-model.py
    origin_model_server.py
    origin_guided.py
    evaluate-model.py
    prepare-distillation.py
    evaluate-distillation.py
  tests/             データ処理と CLI の回帰テスト
  configs/           実行用 sft.yaml / distillation-balanced.yaml と設定案
  models/            ローカル重み・アダプターの保存先
  tokenizer/         将来のトークナイザー研究用
  experiments/       実験のローカル成果物・記録用
```

`data/` の実データ、モデル、トークナイザー、実験成果物は `.gitignore` で除外する。`train-full.py` と `from_scratch/` は将来のフェーズで追加する。

## まず評価履歴を変換する

コマンドはリポジトリのルートから実行する。出力は上書きしないため、再実行時は新しい名前を指定する。

```powershell
# 既存評価器を使う。既定の課題は tune なので、学習用 train とは分ける。
npm run eval -- --provider ollama --only add-field --offline --repeat 1 --out training/data/tune/eval-demo.json
python training/scripts/collect-traces.py --input training/data/tune/eval-demo.json --output training/data/raw/tune-demo.jsonl
python training/scripts/clean-dataset.py --input training/data/raw/tune-demo.jsonl --output training/data/cleaned/tune-demo.jsonl
python training/scripts/convert-traces.py --input training/data/cleaned/tune-demo.jsonl --output training/data/cleaned/tune-trajectories.jsonl
```

入力は `npm run eval -- --out ...` の JSON、特に `tasks[].attempts[].trace`。`self:evaluate` の隔離評価結果やベンチマーク結果は別形式なので対象外。フォルダー全体を探索せず、入力ファイルを明示する。各段階の標準出力は件数だけで、質問やツール出力を表示しない。

古い評価結果は `completed` がない場合がある。既定では除外するが、`collect-traces.py --allow-legacy` を指定すると調査用に取り込める。`source.report_completion = legacy_unverified` を保存し、**SFT には採用しない**。`completed: false` の途中結果は、このオプションでも取り込まない。trace 自体がない試行は件数として報告し、会話を作り出さない。

## 学習用データを用意する

以下の `new-training-report.json` と `new-validation-report.json` は、別々の課題で作成した完了済み評価結果を指す例。既存の tune / holdout 問題をそのまま train に使うと評価が汚染されるため、学習用の新しい課題・履歴を用意する。

```powershell
python training/scripts/collect-traces.py --input new-training-report.json --split train --output training/data/raw/train-v1.jsonl
python training/scripts/collect-traces.py --input new-validation-report.json --split validation --output training/data/raw/validation-v1.jsonl
# 必ず全分割を一緒に検査する。複数 --input ファイルを指定できる。
python training/scripts/clean-dataset.py --input training/data/raw/train-v1.jsonl training/data/raw/validation-v1.jsonl --output training/data/cleaned/all-v1.jsonl
python training/scripts/convert-traces.py --input training/data/cleaned/all-v1.jsonl --output training/data/cleaned/trajectories-v1.jsonl
python training/scripts/generate-sft.py --input training/data/cleaned/trajectories-v1.jsonl --split train --output training/data/sft/train-v1.jsonl
python training/scripts/generate-sft.py --input training/data/cleaned/trajectories-v1.jsonl --split validation --output training/data/validation/validation-v1.jsonl
```

分割は無作為に会話単位で振り分けない。課題単位で決め、収集時の `--split` と各レコードに保持する。同じ `task_id`、同じユーザー入力の列、または同じ会話が複数分割に現れたらエラーになり、出力を公開しない。回答や ID だけを変えても分割をまたげない。同じ指示テンプレートの課題も保守的に拒否する。元の JSON に `split` がある場合、その指定を上書きできない。

holdout はファイル・親ディレクトリ名、report/task の `holdout`・`split`、旧形式の課題 ID で検出する。混在レポートも全体を除外する。ファイル名で分かるものは開かない。中間 JSONL の holdout も拒否する。名前もメタデータも失われた holdout や、別 ID の言い換え・同じリポジトリ由来の課題までは自動検出できないため、作成時に課題の出自とグループを管理する。

## 保存形式と品質条件

UTF-8 JSONL、`version: 1`。段階は `kind: trace` → `trajectory` → `sft`。

| 段階 | 保存する情報 |
| --- | --- |
| trace | 課題 ID、split、評価器の成功/失敗、失敗分類・理由、全ターンのイベント、元 JSON の SHA-256、Provider、取得できる実行条件 |
| trajectory | `messages` の user / assistant / tool、使用可能なツール名、完了状態、終了理由、失敗操作と後続の復帰候補 |
| sft | 成功・完了した会話、元 trace ID、出自、課題 ID、split、内容の SHA-256 |

ツール呼び出しは既存 `src/protocol.ts` と同じ `<tool name="...">JSON</tool>` を assistant のテキストにする。tool メッセージには `name` を付ける。ストリーミング断片・計測・notice は会話に加えず、assistant の表示済み本文を使う。通常の複数ターンは一つの会話にし、`restart: true` で新しい会話に分ける。

これは **Agent の観測イベントから復元した会話**（`representation: agent_events`）。Agent が自動挿入したツール操作も含む。元モデルの生の出力、内部の指示、完全なツール定義・環境・Agent 内部の検査メッセージは既存 trace にすべて残っているわけではない。推論過程や不足した context を捏造しない。モデル固有の chat template とツール定義の与え方は Phase 2 で整える。

成功は終了イベントだけでは判断しない。評価器の `attempt.ok` が true で、レポートが完了済み、すべてのターンが `answered`、ツール開始・終了が対応し、最後に回答があるものだけを SFT に採用する。失敗試行や途中終了も trace / trajectory には残す。成功した試行中のツール失敗と再試行は、復帰学習のために会話に残す。

`recoveries` には `state`、`bad_action`、`error`、`candidate_action`、`candidate_result`、`reviewed: false` が入る。同名ツールの後続成功を候補として関連付けるだけで、原因を解消した証明や優劣ペアにはしない。後続成功がない場合は候補が null。Preference データに使う前に確認する。

クリーニングは秘密情報らしいフィールド、代表的なキー形式、Bearer 認証、URL 認証、秘密鍵などをマスクし、計測・断片・notice を除いた内容で重複を検出する。成功と失敗は別ラベルとして両方保持する。マスクはパターン検出なので、機密データの除去を保証しない。raw はマスク前の履歴であり、学習・共有前に cleaned の内容も確認する。マスクがコードや引数の意味を変えた例は除外する。

各入力レポートは最大 32 MiB、JSONL の一行は最大 8 MiB。切り捨てて会話を壊さず、超過・不正な JSON・未知のイベントはエラーにする。出力は同じフォルダーの一時ファイルに完成させてから公開し、途中失敗で不完全な出力を残さない。

## 検証

```powershell
npm test
npm run typecheck
npm run test:training
# Python を直接指定する場合
python -m unittest discover -s training/tests -v
```

学習基盤のテストは架空の課題とローカル一時ファイルだけを使う。既存の holdout は読まず、モデル・Web・GPU に接続しない。CLI 全工程、成功/失敗の保持、分割混入、マスク、重複、再起動、復帰候補、途中終了、不正入力、既存出力の保護を確認する。

## 次のフェーズ

Phase 3 の Teacher 教材を実際の作業履歴とより幅広い課題へ拡張し、同条件で比較を続ける。単に学習が終了したことを改善とはしない。Phase 4 は確認済み Preference、Phase 5 は独自 Tokenizer / Transformer の研究。Origin Model の接続口は `origin` Provider。
