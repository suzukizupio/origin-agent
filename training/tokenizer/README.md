# Tokenizer 研究用

Phase 2 の SFT ではベースモデルの Tokenizer を使う。独自 Tokenizer と Transformer は Phase 5 の研究対象とし、実装はその段階で追加する。

語彙・学習データ・生成物はローカルに保存し、Git に追加しない。日本語、コードの空白・改行、既存 `<tool>` 構文の往復変換とトークン数を確認する。
