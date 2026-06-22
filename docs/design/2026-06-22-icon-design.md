# 拡張アイコン 設計書

- 日付: 2026-06-22
- ステータス: 設計確定（実装前）
- 関連: [2026-06-17-github-pr-reviewer-avatars-design.md](./2026-06-17-github-pr-reviewer-avatars-design.md) のオープン事項「アイコン素材は実装時に決定」を解決するもの

## 1. 概要 / 目的

Chrome 拡張 "GitHub PR Reviewer Avatars" のアイコン一式を作成し、`manifest.json` から参照できる状態にする。

現状、`manifest.json` には `action.default_title` のみが定義されており、`icons` フィールドと `action.default_icon` は未定義のため、Chrome は灰色のデフォルトプレースホルダを表示する。本作業でこれを解消する。

## 2. ゴール / 非ゴール

### ゴール
- 拡張一覧・ツールバー・Chrome Web Store すべての文脈で適切に表示されるアイコン一式（PNG 16/32/48/128px）を用意する
- アイコンが「GitHub の PR 関連拡張である」ことを一目で示す
- ソース SVG（メインの 24px viewBox 用と、16px 専用の 2 枚）を持ち、PNG はそこから機械的に生成可能にする（auditable / 再現可能）
- 本プロジェクトの「ビルドなし」ポリシーを大きく崩さない（生成スクリプトはオプショナルかつ短く監査可能なものに留める）

### 非ゴール
- アプリ内（PR 行に注入されるアバター）の見た目変更 → スコープ外
- ダーク / ライトテーマ別アイコンの提供 → MVP は単一アイコンで両テーマに耐える設計にする
- 動的バッジ（`chrome.action.setBadgeText` 等）→ 将来検討

## 3. デザイン

### 3.1 モチーフと配色

GitHub Octicons の `git-pull-request` を黒地・白シンボル・緑リングの円形フレームに収める。

| 要素 | 値 | 役割 |
|---|---|---|
| シンボル | Octicons `git-pull-request` (24 / 16 の 2 バリアント) | 「PR 関連の拡張」と一目で識別させる |
| シンボル色 | `#ffffff` | 黒地に対して最大のコントラスト |
| 円の内側 | `#1f2328` (GitHub fg.default) | 黒地でシンボルを引き立てる |
| 円の輪郭（リング） | `#2da44e` (GitHub approved green) | 拡張の主役機能「approved レビュー状態」と意味的に揃える |

「アバター＋状態リング」「PR/マージシンボル＋色」の 2 方向を実機で比較した結果、後者の方が拡張のスコープ（PR 一覧）と直接対応する象徴になるため採用。色は、本拡張がアバター周りに表示する approved リング色 `#2da44e` をそのままアイコンのリングにも転用することで、アイコンとアプリ内 UI に視覚的な一貫性を持たせる。

### 3.2 形状

- 円形フラット（subtle depth / line art は採用しない）
- 16px でも形が破綻しないよう、Octicons の 16px 専用バリアント (`git-pull-request-16.svg`) を 16px アイコンには使い、24/48/128 には 24px バリアント (`git-pull-request-24.svg`) を使う
- リング太さ: 各 SVG の `viewBox` 上で、リング外径に対して 8〜10% の太さになる `stroke-width` を採用する（24px viewBox なら `stroke-width="2"`、16px viewBox なら `stroke-width="1.5"`）。これにより 16/32/48/128 すべてでリングの存在感が同等になる
- シンボルサイズ: 円の **内径**（リング内側の白地部分の直径）に対し、PR シンボルが約 60% を占めるサイズに収める

### 3.3 出力サイズ

Chrome 拡張で要求されるのは MV3 ドキュメントに従い以下 4 サイズ:

| サイズ | 用途 |
|---|---|
| 16px | ツールバー (favicon と同等の小サイズ) |
| 32px | Windows のコンピュータ管理で使われる推奨サイズ |
| 48px | 拡張一覧ページ (`chrome://extensions`) |
| 128px | インストール時のダイアログ、Chrome Web Store |

すべて PNG（Chrome は MV3 でもアイコンに PNG/JPG/BMP/ICO のみサポート、SVG は非対応）。

## 4. ファイル構成

```
icons/
  icon.svg              ソース SVG (24px viewBox、リング込み、PR シンボル付き)
  icon-16.svg           16px 専用ソース (Octicons の 16px バリアントを使用)
  icon-16.png           ↑ から生成
  icon-32.png           icon.svg から生成
  icon-48.png           icon.svg から生成
  icon-128.png          icon.svg から生成
  NOTICE                Octicons MIT ライセンスの著作権表記
scripts/
  make-icons.sh         icons/icon.svg と icons/icon-16.svg から PNG 4 枚を再生成するスクリプト
```

なぜ 16px だけ別 SVG にするのか:
Octicons の 16px と 24px は別途デザイン調整されており、24px の SVG を 16px に縮小すると線が潰れる。Octicons が用意した 16px バリアントを使うのが最も視認性が高い。

### 4.1 NOTICE の内容

```
This extension includes icons derived from GitHub Octicons.

Octicons
https://github.com/primer/octicons
Copyright (c) GitHub, Inc.
Licensed under the MIT License.
```

## 5. PNG 生成スクリプト

`scripts/make-icons.sh` の責務は「`icons/*.svg` から `icons/*.png` を再生成する」ことのみ。

採用ツール: `@resvg/resvg-js@2.6.2`（ライブラリ）。

経緯: 当初 `@resvg/resvg-js-cli` の CLI 版を npx で使う想定だったが、npm レジストリには `2.6.2-beta.1` しか公開されておらず stable 版を pin できなかった。ライブラリ本体は `2.6.2` で stable のため、CLI を介さずライブラリ API を直接 Node から呼ぶ形に切り替えた。

スクリプトの流れ:

1. `mktemp -d` でテンポラリディレクトリを作る
2. そこへ `npm install --no-save --prefix <tmp> @resvg/resvg-js@2.6.2` で resvg-js を入れる（リポジトリも `$HOME` の global にも一切干渉しない）
3. 同テンポラリディレクトリに小さな `render.mjs` を書き出し、`createRequire` でテンポラリの `node_modules` を参照させて `@resvg/resvg-js` を require
4. 4 サイズぶん `node render.mjs <src> <size> <out>` を実行
5. `trap` で終了時にテンポラリを削除

設計上のポイント:

- `librsvg` / ImageMagick のような OS パッケージ依存をリポジトリに持ち込まない
- Node と npm がある環境ならどこでも動く
- バージョンは `RESVG_VERSION="2.6.2"` でシェル変数固定 → 再現性を担保
- リポジトリのワーキングツリーには `node_modules/` も `package*.json` も生まれない（auditable / 「ビルドなし」ポリシーと整合）
- スクリプトは 50 行強。誰が見ても「何が起きているか」が読み取れる

採用バージョン `2.6.2` は実装時点で `npm view @resvg/resvg-js version` の出力（stable）を採用。アップデート時はこの 1 か所を書き換えるだけで済む。

### 5.1 PNG はリポジトリに含めるか

含める。理由:
- ユーザーが `load unpacked` するだけで動く（追加コマンド不要）
- スクリプトは「再生成手段の提示」のために置くものであり、初回利用には不要

PNG とソース SVG の同期は人間が `make-icons.sh` を実行して保つ運用。CI で再生成→差分検出までは MVP では入れない（必要なら将来追加）。

## 6. manifest.json への登録

既存の `manifest.json` に以下を追記する。

```json
{
  "icons": {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  },
  "action": {
    "default_icon": {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png"
    },
    "default_title": "GitHub PR Reviewer Avatars — open settings"
  }
}
```

- `top-level icons` → 拡張一覧・Chrome Web Store・インストールダイアログで使われる
- `action.default_icon` → ツールバーアイコン用（既存の `action` ブロックに `default_icon` を追加するだけ）

## 7. テスト方針

- `node --test` の対象ではない（純粋関数ロジックではない）
- 手動検証:
  - `chrome://extensions` で拡張をロードし直し、リスト上で 48px アイコンが正しく表示されること
  - ツールバーのアイコン (16/32px) が緑リング + 黒地 + 白 PR シンボルとして識別できること
  - インストールダイアログ（あるいは "Details" 画面）で 128px アイコンが鮮明に表示されること
- 加えて、`scripts/make-icons.sh` を一度実行し、コミット済みの PNG とバイナリ差分がないことを目視確認

## 8. 将来の拡張

- ダークモード対応: `prefers-color-scheme` に応じた別 PNG を MV3 で切り替える API はないため、現状の単一アイコンで両テーマに耐える設計を採用済み（黒地 + 緑リングは明テーマでも暗テーマでも視認性を確保できる）
- 動的バッジ: 未読 PR 数や approved 待ち PR 数を `chrome.action.setBadgeText` で示す案。アイコン素材の変更は不要
- Chrome Web Store 公開時のストア用画像: アイコンとは別アセット。今回のスコープ外

## 9. リスクと割り切り

- **Octicons の見た目変更リスク**: GitHub が Octicons を将来更新しても、本リポジトリには SVG をコピー済みなので影響を受けない（バージョンは取り込み時点で固定）
- **`npx` のオフライン実行不可**: 初回 PNG 生成時はネット越しに `@resvg/resvg-js-cli` を取得する必要がある。ただし PNG はコミット済みなので、拡張を使うユーザーには影響しない（拡張ビルドにはネット不要）
- **PNG とソース SVG の同期**: 自動化していない。SVG を変更したら必ず `bash scripts/make-icons.sh` を走らせてコミットする運用ルールに依存

## 10. ライセンス

- 本リポジトリは MIT License (© gillax)
- 使用する Octicons は MIT License (© GitHub, Inc.)
- 両ライセンスは互換であり、`icons/NOTICE` に Octicons の著作権表記を含めることで条件を満たす
