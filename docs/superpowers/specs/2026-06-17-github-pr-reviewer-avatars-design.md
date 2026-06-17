# github-pr-reviewer-avatars 設計書

- 日付: 2026-06-17
- ステータス: 設計確定（実装前）

## 1. 概要 / 目的

GitHub の PR 一覧ページ（`https://github.com/{owner}/{repo}/pulls`）に、各 PR の **Reviewer のアバターを表示する** Chrome 拡張。

GitHub 標準では PR 一覧に Reviewer が表示されず、DOM にも Reviewer 情報は含まれない（長年のコミュニティ要望）。本拡張は GitHub API から Reviewer 情報を取得し、一覧の各行にアバターを注入してこのギャップを埋める。

公開 OSS（public な GitHub リポジトリ）として配布する汎用拡張。特定リポジトリに限定せず、ユーザーが自分の Personal Access Token（PAT）を設定すれば任意のリポジトリで動作する。「素性のわからない拡張は信用できない」という課題に対し、**コードを公開して誰でも監査できる**ことで応える。

## 2. ゴール / 非ゴール

### ゴール（MVP）
- PR 一覧の各行に Reviewer のアバターを表示する
- private リポジトリでも、ユーザー設定の PAT を使って動作する
- GraphQL を 1 リクエストにまとめ、レート制限消費を最小化する
- ビルド工程なしの最小構成（Vanilla JS + MV3）で、誰でもコードを読んで監査できる
- 後から「レビュー状態の色分け」を足しやすい構造にしておく

### 非ゴール（今回は作らない）
- レビュー状態（approved / changes requested / pending）の色分け・バッジ表示 → 次イテレーション
- グローバルダッシュボード（`/pulls`、`/pulls/assigned`）対応 → 将来
- GitHub Enterprise Server 対応（カスタムホスト）→ 将来
- OAuth / GitHub App 認証 → PAT で十分。採用しない
- Chrome Web Store への公開 → 当面は GitHub リポジトリ公開 + load unpacked。将来検討

## 3. 採用アプローチ

**Vanilla JS + Manifest V3 + GraphQL**

- **Vanilla JS（ビルドなし）**: 「最小構成」「監査しやすさ」に最も合致する。TypeScript + バンドラは型安全だがビルド工程が増えるため、公開後に育てる段階で検討する。
- **GraphQL**: 一覧 1 ページ分の全 PR の Reviewer を **1 リクエスト**で取得できる（PR 番号を alias 展開）。REST は PR ごとにリクエストが必要でレート制限に弱いため不採用。

## 4. アーキテクチャ（ファイル構成と責務）

| ファイル | 責務 |
|---|---|
| `manifest.json` | MV3 マニフェスト。`host_permissions` は `https://github.com/*` と `https://api.github.com/*` のみ。content script を PR 一覧に注入 |
| `src/content.js` | PR 一覧ページで動作。行から owner/repo・PR 番号を抽出 → background に問い合わせ → 返却された Reviewer アバターを DOM 注入。SPA 遷移時の再注入も担当 |
| `src/background.js` | service worker。`chrome.storage.local` の PAT を使って GraphQL を叩く**唯一の場所**。PAT をページ側に晒さない |
| `src/options.html` + `src/options.js` | PAT の入力・保存・疎通確認（`viewer { login }` で検証）。PAT 作成手順へのリンク提示 |
| `src/styles.css` | 注入するアバターのスタイル |
| `src/lib/parse.js` | （純粋関数）URL から owner/repo 抽出、行から PR 番号抽出。単体テスト対象 |
| `src/lib/query.js` | （純粋関数）PR 番号配列から GraphQL クエリ文字列を生成。単体テスト対象 |
| `src/lib/transform.js` | （純粋関数）GraphQL レスポンス → `{ prNumber → reviewers[] }` の表示用データに変換。単体テスト対象 |

content script / background のうち `chrome.*` API に依存する部分は薄いグルーに留め、ロジックは `src/lib/*` の純粋関数に切り出して単体テスト可能にする。

## 5. データフロー

```
content.js (isolated world)
  ① /{owner}/{repo}/pulls を検知し、行から PR番号[] を抽出
  ② chrome.runtime.sendMessage({ owner, repo, numbers })
        ↓
background.js (service worker)
  ③ chrome.storage.local から PAT を取得
  ④ GraphQL を 1 リクエスト（PR番号を alias 展開して一括取得）
       repository(owner, name) {
         pr_<n>: pullRequest(number: <n>) {
           reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login avatarUrl url } ... on Team { name } } } }
           latestReviews(first: 20)   { nodes { author { login avatarUrl url } state } }
         }
       }
  ⑤ 表示用データ { number → reviewers[] } を返却
        ↓
content.js
  ⑥ 各行に Reviewer アバター <img> を注入（idempotent に）
```

MVP では `latestReviews`（state 含む）も取得するが**色は付けず**、アバター表示のみ。状態拡張時はこの取得済みデータに色/バッジを足すだけで済む。

reviewer の集合は「`reviewRequests`（まだレビューしていない依頼中の人）」と「`latestReviews`（既にレビューを出した人）」の和集合とする。approve すると `reviewRequests` から外れるため、和集合にしないと「承認した人」が一覧から消えてしまう。

## 6. PAT の扱い（セキュリティ）

- 保存先は **`chrome.storage.local`**（`chrome.storage.sync` は使わない → 同期経由で Google にトークンを渡さない）
- PAT を使うのは **background のみ**。content script / ページの world には渡さない（ページの Network タブやスクリプトからトークンが見えない）
- options で PAT 作成手順をリンク提示する
  - classic PAT: `repo` スコープ
  - fine-grained PAT: 対象リポジトリ + Repository permissions の Pull requests: Read-only（README にも明記）
- 公開 OSS なので「コードを読めばトークンの送信先が `api.github.com` だけ」と監査可能。これが本拡張の信頼性の根拠

## 7. SPA 遷移対応

GitHub は Turbo によるソフト遷移を行う（フルリロードされない）。

- `turbo:load` / `pjax:end` イベントを監視して再注入
- フォールバックとして、PR 一覧コンテナに対する `MutationObserver` を併用
- 注入済みの行は `data-*` 属性でマークし、二重注入を防ぐ

## 8. スコープ（対象ページ）

- 対象ページ: **`https://github.com/{owner}/{repo}/pulls` のみ**
- **github.com のみ**（GitHub Enterprise Server は将来）
- **PAT 必須**。未設定時はアバターを表示せず、options への導線のみ控えめに出す

## 9. エラー処理

| ケース | 挙動 |
|---|---|
| PAT 未設定 | 何も壊さず、options への導線のみ表示 |
| 401（無効/期限切れ） | options に「再設定して」と表示。一覧側は静かに無表示 |
| レート制限 / ネットワークエラー | コンソール警告のみ。一覧の表示自体は壊さない |
| Reviewer が Team の場合 | MVP ではチーム名のラベル等でフォールバック表示（アバターは User のみ） |

## 10. 将来の拡張（状態の色分け）

MVP の GraphQL で `latestReviews.state` を既に取得しているため、拡張は表示層のみで完結する。

- approved → 緑チェック
- changes requested → 赤
- pending（reviewRequests のみで未レビュー） → グレー
- commented → 中立色

## 11. テスト方針

- **単体テスト（Node で実行）**: `src/lib/*` の純粋関数（PR 番号抽出 / GraphQL クエリ生成 / レスポンス変換）
- **手動結合確認**: load unpacked → public / private リポジトリの PR 一覧でアバターが表示されることを実機確認（verification skill を使用）

## 12. オープン事項

- 拡張の表示名（manifest の `name`）・アイコン素材は実装時に決定
- README は公開 OSS 向けに英語で用意（実装フェーズ）
