# Origin Model の保存先

重み・LoRA アダプターはローカルに保存し、Git に追加しない。Phase 2 の実装は `download-model.py` → `train-lora.py` → `serve-model.py`。ベースモデルの manifest は `origin-base.json`、アダプターの学習記録は `origin-training.json`。

モデルごとに、ベースモデルの識別子とリビジョン・ライセンス、データの SHA-256、設定、使用機器、学習日時、独立した評価結果を記録する。Python の推論サーバーで動かし、`origin` Provider から HTTP で接続する。Agent とモデルの実装を密結合させない。
