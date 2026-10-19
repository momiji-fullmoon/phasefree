# 熊本2026 インフラ初動AI：データソース・設計・実装仕様書

| 項目 | 内容 |
|---|---|
| 文書基準日 | 2026-10-19 |
| 対象 | 現行の `index.html`、取得・前処理スクリプト、P0/P1の計画・業務機能 |
| 位置付け | 実装コード・保存済みmanifest・ブラウザ実行結果に基づく現状仕様 |
| 用途 | 提案内容の説明、実装の引継ぎ、データ来歴の確認、追加開発・検証 |
| 関連文書 | [統合方針](phase-free-plan-integration.md)、[P1操作・実装ノート](phase-free-p1.md)、[README](../README.md) |

## 目次

1. [目的・対象・実装範囲](#overview)
2. [全体設計とファイル構成](#architecture)
3. [データソース・取得状況・利用箇所](#data-sources)
4. [画面・機能仕様](#functions)
5. [計算・計画生成の仕様](#algorithms)
6. [P1データモデル・ID・状態](#schema)
7. [時点制御と記録の採用](#time)
8. [保存・復元・JSON入出力](#storage)
9. [AIツール仕様](#ai)
10. [取得・前処理・ビルド・実行](#operation)
11. [検証方法と確認結果](#tests)
12. [制約・仕様差異・拡張箇所](#limitations)

<a id="overview"></a>
## 1. 目的・対象・実装範囲

平時の巡回・点検、事前対策、災害後の点検・復旧、実施記録からの業務見直しを、共通資産IDでつなぐフェーズフリー型の自治体向け提案用デモである。

- 対象範囲：熊本県南部、緯度 `32.17–32.90`、経度 `130.33–130.92`。
- 地震シナリオの設定：2026-07-28 16:27、JMA M7.1、最大震度7。
- 平時の初期判断時点：2026-07-27 08:00 JST。
- 災害対応の初期判断時点：最初の震度情報の投入時点。`EVENTS[0].dt = 8` のため、初期案件の表示時刻は2026-07-28 16:35 JSTとなる。
- 実証自治体・正式な担当組織・管轄範囲は未確定。画面上の班・業務手順はデモ設定。

### 1.1 実装段階

| 段階 | 実装状況 |
|---|---|
| 既存機能 | 地図、優先順位、点検経路、予算配分・事前対策、復旧工程、土地・公共施設・用地、廃棄物、AI操作、分析の検査 |
| P0 | 「計画・業務」画面、仮要旨・未確認状態付きの資料、業務・施設・訪問先・根拠の往復 |
| P1 | 案件別の実行・実施記録、平時所見の計算反映、時点制御、IndexedDB保存・JSON復元、未割当理由、見直し候補 |
| P2以降 | 正式PDFの取込み、章節・原文の確認、文書間照合、改定案の高度化、追加AIツール |
| 実証・運用 | 自治体の正式資料・管理資産・資源、共同利用、バックエンド、業務効果の評価は拡張対象 |

### 1.2 現行データの規模

次の件数は、本仕様書の作成時に独立したブラウザコンテキストで現行HTMLを起動して確認した。

| 項目 | 件数・内容 |
|---|---|
| 共通施設台帳 `AS` | 232施設 |
| 種別別 | 橋梁79、トンネル9、道路法面・盛土45、カルバート32、堤防・樋門9、岸壁8、下水25、上水25 |
| 実台帳を適用した橋梁 | 71施設。公表被害との対応用の8橋は合成資産を保持 |
| 解析用道路網 | 27ノード・38エッジ、手作成の概略ネットワーク |
| 土地の管理単位 `LU` | 67件、合成 |
| 公共施設 `FAC` | 18件、合成 |
| 公園・空地等 `SPACE` | 12件、合成 |
| 地盤・地質属性 `GROUND` | 232資産ID分 |
| 強震記録派生データ `KSTA` | 61観測点、うち本震記録あり60観測点。観測点コードの重複なし |
| HTML内のxROAD候補 `XROADBR` | 360件 |
| HTML内の造成地 `XKT` | 380地物 |
| 発災後情報 `EVENTS` | 18段階 |
| AIツール | 16機能 |

<a id="architecture"></a>
## 2. 全体設計とファイル構成

### 2.1 構成図

```text
公開API・公開ファイル・提供データ
  ├─ fetch_kumamoto_real.py → kumamoto_real_data.zip
  ├─ fetch_kumamoto_event.py → kumamoto_event_data/ + manifest.json
  └─ 提供波形・ラスタ → tools/preprocess/ の前処理
                          ↓
      地図・台帳・観測点値・ラスタ等の埋込み定数
                          ↓
index.html：地図・画面・既存計算・AI_TOOLS
  ├─ S：現在の表示、優先順位、経路、計画案、AI操作等
  ├─ PlanCore：案件・実行・記録・時点・見直し・JSON整合性
  ├─ PlanStorage：IndexedDBの読込み・トランザクション保存
  └─ plan-ui：計算への接続、入力画面、保存状態、JSON入出力
                          ↓
  IndexedDB（ブラウザ保存）／JSON（持出し・復元）

HTTP配信時のデータ基盤タブ
  └─ kumamoto_event_data/manifest.json → 出典索引の表示を更新
```

通常のアプリ処理はブラウザ内で完結する。PythonのHTTPサーバーは静的ファイル配信に用いる。アプリ用のRESTサーバーやサーバーDBは実装していない。

### 2.2 ソースの責務

| ファイル | 責務・主な識別子 |
|---|---|
| [index.html](../index.html) | HTML/CSS、初期データ、`S`、`compute`、`planRoutes`、画面、AIツール、P1埋込み領域 |
| [js/plan-core.js](../js/plan-core.js) | `createCase`、`ensureRuns`、`addObservation`、`baseline`、`reconcile`、`deriveRevisions`、`validateBundle` |
| [js/plan-storage.js](../js/plan-storage.js) | `PlanStorage.open`、IndexedDBの`load`／`save` |
| [js/plan-ui.js](../js/plan-ui.js) | `OPS`、`planPrepare`、`planPrior`、`planFinish`、入力・保存・復元・画面の接続 |
| [tools/build_phase_free_demo.py](../tools/build_phase_free_demo.py) | P1の3モジュールをHTMLへ埋込み。`--check`でソースと配布物の一致を確認 |
| [tools/fetch_kumamoto_real.py](../tools/fetch_kumamoto_real.py) | DPF、xROAD、不動産情報ライブラリの応答を取得・ZIP保存 |
| [tools/fetch_kumamoto_event.py](../tools/fetch_kumamoto_event.py) | 発災後の公開ファイル取得、検証、キャッシュ、来歴・集計 |
| [tools/preprocess/](../tools/preprocess/) | 波形、地盤、橋梁台帳、造成地、背景地図、提供画像の加工 |
| [vendor/](../vendor/) | Leaflet等の配布資材 |

配布するHTMLはP1のJSも内蔵する。`js/`は編集・テスト用のソースであり、ブラウザがそれらを別途読み込む構成ではない。

### 2.3 状態の分担

| 領域 | 内容 | 再読込み時の扱い |
|---|---|---|
| HTMLの定数 | 初期台帳、地図、波形派生値、仮の文献・業務、出典索引 | HTMLから再構築 |
| `S` | モード、画面、計算中の施設属性、計画案、AIトレース、操作ログ等 | 必要な表示条件を復元し、計画を再計算 |
| `OPS.state` | 案件、業務実行、実施記録、見直し候補、計画入力スナップショット | IndexedDB／JSONから復元 |
| `Case.view` | 情報投入段階、班数、稼働時間、拠点、必須・除外、点検計画の確認状態 | 案件切替時に`S`へ適用 |
| `session` | 表示フェーズ、タブ、選択資産ID、計画・業務のビュー | 起動時・JSON読込み時に使用 |

`S`全体の永続化ではない。AIの自由文履歴・全操作ログ・事前対策や復旧計画の計算結果そのものは、P1の保存パッケージの独立した永続レコードにはしていない。復元時は新しい計画版を生成する。

<a id="data-sources"></a>
## 3. データソース・取得状況・利用箇所

### 3.1 区分の定義

| 区分 | 意味 |
|---|---|
| 実データ | 公開API・資料・提供ファイルに由来する属性・観測値・画像等 |
| 公表資料の登録値 | 人が資料から読み取った値・対象対応。判読や対応付けの不確かさを伴う |
| 派生データ | 波形からの計測震度、画像の色からの指標等、加工を加えた値 |
| 合成・概略 | 固定乱数、仮定、手作成の道路網・断層・施設・被害等 |
| 職員入力 | P1の入力画面で追加した実施記録。入力した事実と、モデルの推定・合成投入を区別 |
| 未確認・未提供 | 正式本文・適用版・管轄・手順等の確認が済んでいない状態 |

「取得済み」「HTMLへ組込み済み」「被害推定に数値として利用中」は別の状態で管理する。

### 3.2 HTMLに組み込まれた主なデータ

| データ・提供元 | 主な取得元 | 保存・加工・HTML識別子 | 利用と留意点 |
|---|---|---|---|
| 地球地図日本 v2.2／国土地理院 | [地球地図日本](https://www.gsi.go.jp/kankyochiri/gm_japan_e.html)、npm `jpn-atlas`経由 | `gm.py` → `GM`、`MUNI`等 | 背景地図、行政区、人口。縮尺1:100万、人口は2010年頃 |
| K-NET／KiK-net／防災科研 | [強震観測網](https://www.kyoshin.bosai.go.jp/)・提供波形 | `20260728162700_ascii.zip`、`knet.py` → `KSTA`、`AFT_META` | 本震＋余震3回の観測点派生値。現行`KSTA`は61点、本震60点。地震一覧からの最大値等の登録情報と、3成分波形の算出値は定義を区別 |
| JMA震度・発震機構 | [気象庁](https://www.data.jma.go.jp/eew/data/mech/)・公表資料 | `STATIONS`、`ST`、`EVENTS`、`SRC.JMA` | 震度代表値による距離減衰モデルの補正。JMAの取得済み78CSVをブラウザが再解析する実装ではない |
| 提供の宇城市付近ラスタ | 提供画像。`SRC.UKI`に作成元未確認と記録 | `uki.py` → `UKI`、`UKI_G`、`UKI_BB` | 色から抽出した代理指標と画像重畳。原画像の色を直接の被害確率とは扱わない |
| EOS-RS DPM | [EOS-RSイベントページ](https://sf.earthobservatory.sg/event/EOSRS_2026_009_JPN_EQ_202607_Kumamoto_Earthquake) | `SRC.S1`、衛星情報のシナリオ | 地表変化の参照。施設別の尤度・検出結果には合成処理を含む |
| 橋梁台帳／xROAD | [無料API](https://road-structures-db.mlit.go.jp/xROAD/) | ZIP内`xroad_bridges_pref43.json` → `xroad.py` → `XROADBR`／`a.x` | 全20,291件取得、360件を候補として内蔵、71橋へ名称・位置・建設年・点検年・判定等を適用。液状化・重要度・被害等は別の合成・モデル値 |
| 大規模盛土造成地／不動産情報ライブラリ | [XKT020](https://www.reinfolib.mlit.go.jp/help/apiManual/xkt020/) | ZIP内GeoJSON → `xkt020.py` → `XKT` | 取得430地物、内蔵380地物。外周リングのみ、概略表示・管理単位との結合 |
| 地盤／J-SHIS | [J-SHIS API](https://www.j-shis.bosai.go.jp/api-list) | `ground.py` → `GROUND` | 表層地盤V4、微地形、AVS・ARV、2024年版T30確率、地すべり地形の照会。地盤属性の表示・参照に使用 |
| 地質／産総研 | [シームレス地質図API 1.3.1](https://gbank.gsj.jp/seamless/v2/api/1.3.1/) | `legend.json?point=緯度,経度` → `GROUND` | 岩相・形成時代・大区分。1:20万分の1の凡例であり、個別ボーリングではない |
| 被害状況／国交省・県・内閣府等 | `SRC.MLIT2`、`SRC.MLITR`、`SRC.CAO`等の登録URL | `REPORTS`、`WATER`、`HOUSE_0809`、`HOUSE_1005` | 施設・市町村の公表被害を人が登録。一部は近傍の同種施設へ対応付け |
| 7/31被害調査速報／JSCE掲載資料等 | [調査資料の索引](https://committees.jsce.or.jp/eec205/node/69) | `REPORTS`の`FS1`〜`FS7`、`SRC.FS` | 7橋への対応。被害程度・位置対応は暫定判読。P1では`public_report`として追加調査状態を保存 |
| 災害廃棄物の参考式／環境省 | [推計精度向上の検討資料](https://www.env.go.jp/content/900536530.pdf) | `WP`、廃棄物の計算処理 | 全壊原単位117t等の参考。住家棟数推計・被害関数・仮置場条件はアプリ側の仮定を含む |
| 仮置場／八代市 | [設置情報](https://www.city.yatsushiro.lg.jp/kiji00324627/index.html) | `YARDS` | 公表された名称・所在地・開設期間の参照 |
| 合成の業務用データ | 固定乱数・仮の部局・資源設定 | `AS`の残余属性、`LU`、`FAC`、`SPACE`、`RAIN`等 | SNS、現地確認シナリオ、降水、写真判読・応答解析等の結果も合成を含む |

補足：`GROUND`を表示していることと、液状化指標をその観測値から算出していることは同義ではない。現行`a.liq`は海岸・河川からの距離等による代理値で、`ground.py`のAPI取得値とは別である。

### 3.3 基盤データ取得ZIPの現物

`kumamoto_real_data.zip`内の`manifest.json`を参照。取得開始は2026-10-16T19:12:26Z、終了は同日23:43:01Z。ZIP内エントリは2,746件。

| 系統 | 現物で確認した取得結果 | アプリでの接続 |
|---|---|---|
| DPF | カタログ38件、`rsdb_bridge`応答10,000件・対象枠内6,060件 | 主に索引・取得計画の情報。橋梁の置換元はxROAD |
| DPF航空写真等の索引 | `dimaps_20260728`は総数4,415件のうち上限3,000件を取得、枠内2,608件 | 原画像全件の取得・画像判読完了を意味しない |
| xROAD橋梁 | 20,291件、3ページ取得 | 360候補を埋込み、71施設に適用 |
| xROADトンネル | 315件、1ページ取得 | 台帳の実置換には未接続 |
| 不動産情報ライブラリ | 14 APIを対象にタイル取得。XKT020は430地物、111タイル、z13 | XKT020の380地物を内蔵。ほかの取得APIは現行画面の合成施設への全面置換には未接続 |
| 取得エラー等 | 14 APIの記録上のタイルエラー計11件。XKT027は取得地物0件 | 「0地物」と「取得失敗」を区別してmanifestに記録 |

タイルの`features`は取得応答に含まれた地物の集計であり、API間で同じ単位・重複排除済みの施設数とは限らない。DPFの`cals_construction`／`cals_design`／`cals_pointcloud`は、設定したIDで取得0件と記録されている。

### 3.4 発災後アーカイブ

基準：[kumamoto_event_data/manifest.json](../kumamoto_event_data/manifest.json)。`schema_version = 2`、更新日時は `2026-10-18T06:42:39Z`。

- 取得済み：**209ファイル、229,156,944バイト**。MBは10進表記。
- 未取得の記録：`manual` 7件。容量方針で除外：`skipped_size` 7件。
- 索引登録は計223件。データファイルにmanifestを加えた現物は210ファイル。

| 保存グループ | 取得済み数 | バイト | 内容・主な出典 |
|---|---:|---:|---|
| `gsi` | 3 | 55,177,338 | [国土地理院InSAR](https://insarmap.gsi.go.jp/)のEW／NS／UD GeoTIFF |
| `jishin_honbu` | 2 | 27,536,829 | [地震調査委員会評価PDF](https://www.static.jishin.go.jp/resource/monthly/2026/20260728_kumamoto_1.pdf)等 |
| `jma_kyoshin` | 79 | 47,441,137 | [JMA強震記録](https://www.data.jma.go.jp/eqev/data/kyoshin/jishin/2607281627_kumamoto/index.html)：78 CSV＋掲載ページ |
| `jma_reports` | 7 | 5,862,380 | JMA報道・活動状況PDF等とadep震度一覧 |
| `kyoshin_topics` | 2 | 33,569 | [防災科研topics](https://www.kyoshin.bosai.go.jp/ja/topics/20260728162700)の公開HTML |
| `reports_cabnet` | 5 | 12,725,128 | [内閣府公表PDF](https://www.bousai.go.jp/updates/r8kumamoto_jishin/) |
| `reports_expert` | 7 | 14,037,795 | JSCE・大学等の調査・強震解析速報 |
| `reports_fdma` | 3 | 362,708 | [消防庁報告PDF](https://www.fdma.go.jp/disaster/info/items/20260728kumamotojishin61.pdf)等 |
| `reports_mlit` | 3 | 148,023 | [国交省](https://www.mlit.go.jp/saigai/saigai_260728.html)・九州地方整備局・JSCE索引のHTML |
| `reports_pref` | 2 | 130,839 | [熊本県被災状況](https://www.pref.kumamoto.jp/soshiki/32/274465.html)、PDF |
| `sentinel_asia` | 94 | 65,534,725 | [Sentinel Asia](https://sentinel-asia.org/EO/2026/article20260728JP.html)：画像87、KMZ/PDF/ZIP成果物4、HTML3 |
| `usgs` | 2 | 166,473 | [USGS GeoJSON](https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/us6000tgb9.geojson)、ShakeMap掲載HTML |
| **計** | **209** | **229,156,944** | `stored`のみを集計 |

重要な定義・形式：

- JMAの78波形CSVはすべて**100Hz**、加速度単位はgal。
- USGS保存値は**Mww 6.8**。シナリオのJMA M7.1とは出典・マグニチュード種別を区別する。
- InSAR GeoTIFFは幅2,322×高さ3,209、float32。保存済みであり、ブラウザの施設推定へ自動サンプリングする処理は未接続。
- `CHIBA/Uki.kmz`は内蔵画像のGroundOverlay。EOS-RSのDPM KMZは外部KMLタイルへのNetworkLinkで、完全なオフラインタイル複製ではない。
- 公開Uki KMZの取得と、従来の提供画像から作った`UKI`定数の来歴の同一性は別の確認事項。
- `reports_mlit`の3件は索引HTMLの保存件数で、そこに掲載された全報告PDFの件数ではない。
- 未取得7件は、GSIの索引・斜面崩壊・変動PDF2・活断層図の5件、防災科研補足ページ1件、PASCO候補ページ1件。詳細はmanifestの`note`を参照。
- 容量除外はEOS-4元画像6件とR2元画像1件。縮小版を保存する。

### 3.5 取得時の検証・来歴

`fetch_kumamoto_event.py`の仕様：

| 項目 | 実装 |
|---|---|
| 保存名 | 元URLのシーン階層を保持。必要時はURLハッシュで同名衝突を回避 |
| キャッシュ | 実サイズ・形式・SHA-256を検証して利用 |
| 取得上限 | 原則64,000,000バイト、画像7,000,000バイト、DPM MAIN PNGのみ20,000,000バイト |
| 受信制御 | Content-Lengthの事前確認＋チャンク読込み中の上限検査 |
| 保存 | 一時ファイルから原子的に置換、manifestも原子的に更新 |
| 部分実行 | 指定外のグループの記録・出典URLを保持 |
| 検証形式 | JPEG、PNG、PDF、CSV、TIFF、ZIP/KMZ、JSON、HTML等。KMZではKML・内蔵参照先・外部参照も確認 |
| 状態 | `stored`、`manual`、`skipped_size`、`error`、`invalid`、`missing`、`unattributed` |

主なmanifest項目は`file`、`url`、`group`、`status`、`bytes`、`sha256`、`format`、`metadata`、`verified_utc`、`note`。個別の`fetched_utc`は存在する項目に記録され、検証日時とは区別する。`--audit`はネットワーク取得をせず、ファイル検証とmanifestの更新・集計を行う。

### 3.6 防災計画・手順の資料

| 内部ID | 資料の登録名 | 現在の状態 |
|---|---|---|
| `DK` | 国土交通省防災業務計画 第16編「地域防災計画の作成の基準」 | 掲載先URLを登録。適用版・原文・ページ未確認、仮要旨 |
| `KP` | 熊本県地域防災計画（地震災害への対応） | この業務用の本文未提供 |
| `MK` | 対象市町村地域防災計画 | 自治体未選定・本文未提供 |
| `MG` | 対象市町村道路巡回・点検実施要領 | 未提供 |
| `MA` | 災害時応援協定 | 未提供 |

`DK-1`等は仮要旨の**アプリ内部ID**であり、原資料の正式な章節番号ではない。`versionId`の`@p0-unverified-v1`は内部パッケージの版で、行政文書の正式改定版を確認済みという意味ではない。参照には`verified: false`、`textKind: "demo_summary"`、`page: null`を保持する。

国交省資料の掲載先は [防災業務計画](https://www.mlit.go.jp/saigai/bousaigyoumukeikaku.html)。資料未提供・本文未確認・適用対象外・記載不足候補を区別するための状態ラベルを用意している。全文の自動照合はP2の対象である。

<a id="functions"></a>
## 4. 画面・機能仕様

### 4.1 画面一覧

| タブID | 表示名 | 利用フェーズ | 主な入出力 |
|---|---|---|---|
| `ai` | AIに指示 | 共通 | 自然言語→ツール実行手順、結果、報告文、確認待ち |
| `list` | 優先順位 | 共通 | フィルター・必須・除外→候補順と施設選択 |
| `plan` | 点検計画 | 共通 | 班・時間・拠点→訪問先・到着時刻・業務・実施記録・未割当理由 |
| `dplan` | 防災計画 | 平時 | 想定地震・予算・年数→事前対策・年度配分・拠点比較 |
| `why` | 根拠追跡 | 共通 | 資産ID→優先度・確率の寄与、採用所見、固定した業務根拠 |
| `ana` | 解析 | 発災後 | 投入情報→解析の方法・施設への適用状況 |
| `recov` | 復旧計画 | 発災後 | 被害所見・推定・工事班・降雨条件→応急／本復旧工程・費用・回復見通し |
| `lf` | 土地・施設 | 共通 | 盛土・施設依存・敷地用途→次の確認行動、用途競合、配分案 |
| `waste` | 災害廃棄物 | 共通 | 震度・原単位→推計量・仮置場面積、公表住家被害からの算出値との比較 |
| `rplan` | 計画・業務 | 共通 | 根拠・業務・案件・実施記録→履歴・未割当・見直し候補 |
| `data` | データ基盤 | 共通 | レイヤ、A/B/C取得区分、統合レコード、出典索引 |
| `ga` | 分析の検査 | 共通 | 検査種別→判断・設定・検証結果 |
| `agent` | AI構成 | 共通 | 専門機能・人の確認点・参考文献の説明 |
| `metrics` | 評価指標・ログ | 共通 | 計画指標、記録件数、見直しへの反映、操作ログ |

現行`dplan`の表示名は「防災計画」である。統合方針の「事前対策」への表示名の整理は、現在の名称と区別して読む。

### 4.2 P1の機能要件

| ID | 機能 | 実装する振る舞い |
|---|---|---|
| F-01 | 案件切替 | 平時・発災後の案件を選択し、それぞれの時点・班・条件を適用する |
| F-02 | 別案件 | 同じシナリオ・フェーズ用の別案件を作り、旧案件を保持する |
| F-03 | 再点検 | 同一案件に新しい開始事象を作り、別の実行IDを生成する |
| F-04 | 記録入力 | 記録者、日時、確認項目、所見、損傷、健全度、未実施理由を追記する |
| F-05 | 完了条件 | 完了には定義内の全確認項目が必要。未実施・追加調査も記録できる |
| F-06 | 基準状態 | 採用条件を満たす職員入力から健全度・点検年を再取得し、計算に反映する |
| F-07 | 履歴保持 | モード切替・再計画・時系列巻戻しでも実施記録を消さない |
| F-08 | 未割当 | 担当班・到達性・時間・候補数・必要情報等の理由を残す |
| F-09 | 見直し | 記録・計画入力と参照文献を根拠に候補をまとめ、確認・反映状況を記録する |
| F-10 | 保存・復元 | 保存状態を表示し、IndexedDB復元・JSON入出力を提供する |
| F-11 | 根拠追跡 | 訪問先・実施記録・候補から実行時に固定した文献版・参照記載へ戻る |
| F-12 | 不正入力 | 記録の必須項目・時点・参照整合性を検証し、読込み失敗では現在の状態を置換しない |

### 4.3 情報投入の仕様

`collect_data`や「次の情報を投入」は、保存済みのシナリオ情報を順に有効化する。ブラウザが新たに地震・SNS・交通データを収集する処理ではない。

投入順：`JMA → SNS_T → SNS_I → GNSS → MLIT2 → F1 → KNET → S1 → AER → WX → AFT → TRAF → ALOS → MLITR → F2 → FS → HOUSE → HOUSE2`。

- `F1`／`F2`：各班の先頭3訪問先を対象とした合成の点検記録。
- `FS`：公表速報に対応付けた施設への暫定判読記録。
- `Case.ingested`と`sourceEventKey`で同じ投入の二重登録を防ぐ。
- 巻戻し後は将来の記録を残し、判断への採用だけを時点で制御する。

<a id="algorithms"></a>
## 5. 計算・計画生成の仕様

### 5.1 座標・空間結合

- 外部API・観測点の位置は緯度・経度で扱う。
- 内部近似座標は `x = (lon − 130.28) × 843`、`y = (32.92 − lat) × 1000`。
- 内部距離に `KM = 0.111` を掛けてkmへ換算する。正式な平面直角座標系の座標ではない。
- Leafletへの表示では逆変換して緯度・経度を渡す。
- xROAD候補は表示枠・属性の充足で抽出し、市区町村ごとにseed `20260407`で並替えて交互に360件を選ぶ。適用対象の橋梁に近い未使用レコードを割り当てる。
- XKT020は外周のみを内蔵し、土地管理単位との内包・近接関係に利用する。

施設の管理自治体コードや管理権限を、最寄りの町の代表点だけで確定する仕様ではない。P1は台帳管理者の有無と管轄未確認を保持する。

### 5.2 平時の点検優先度

```text
score = 0.35 × condition_score
      + 0.25 × elapsed_score
      + 0.25 × latest_watch_score
      + 0.15 × importance

condition_score = [0, 0.33, 0.67, 1][健全度0〜3]
elapsed_score   = clamp((判断年 − 点検年) / 点検周期, 0, 1.2) / 1.2
```

健全度・点検年は`planBaseline()`で取得する。監視スコア・重要度には初期合成値が含まれる。

### 5.3 地震動・事前確率・根拠統合

```text
modelI = 7.3 − 1.25 × log10(断層距離km + 3) + 盆地補正
I      = clamp(modelI + 観測震度の残差補正 + 施設別増幅, 3.5, 7.2)
p0     = clamp(Φ((I − θ) / 0.4), 0.005, 0.97)
```

観測残差は距離に対する `1 / (d + 3)^2` の重みで補正する。耐力`θ`は種別・補強・状態・建設年・液状化の代理値・法面の急峻さ・断層距離で調整する。

P1の状態更新では、初期健全度と採用健全度のペナルティ差を使う。

```text
penalty = [0, 0.1, 0.35, 0.7]
θ採用   = θ初期 + penalty[初期健全度] − penalty[採用健全度]
```

追加の根拠は、検出率`tp`・誤検出率`fp`の仮定から得る対数尤度比を加算する。

```text
陽性根拠 = log(tp / fp)
陰性根拠 = log((1 − tp) / (1 − fp))
事後確率 = sigmoid(logit(p0) + 各根拠の対数尤度比)
優先度   = 事後確率 × (0.5 + importance)
```

根拠の独立を仮定する。採用した実施記録に損傷所見がある場合、現行デモの確認値は損傷あり1／異常なし0として扱う。`unknown`はこの置換を行わない。入力された記録の出所は別途表示する。

### 5.4 点検経路

1. 完了・未実施・除外・未到来事象等を考慮して候補を作る。発災後の通常候補閾値は `p >= 0.12`。
2. 道路班、上下水道班、河川・港湾班のそれぞれで上位30候補を探索対象にする。
3. 通行止めエッジを除いた道路網にFloyd–Warshallを適用する。
4. 各班の種別対応、移動時間、作業時間、拠点への帰着、稼働時間を満たす挿入を探索する。
5. 優先度／追加所要時間が大きい候補を貪欲に挿入する。厳密最適解を保証する手法ではない。
6. 訪問先へ実行ID・到着時刻・作業時間を接続し、未割当にも理由を残す。

| 種別 | 災害時作業時間・分 | 点検周期・年（デモ設定） |
|---|---:|---:|
| BR 橋梁 | 20 | 5 |
| TN トンネル | 40 | 5 |
| SL 法面・盛土 | 20 | 5 |
| CV カルバート | 15 | 5 |
| LV 堤防・樋門 | 30 | 1 |
| PT 岸壁 | 40 | 5 |
| SW 下水 | 15 | 5 |
| WS 上水 | 20 | 3 |

平時の作業時間は上表の1.5倍。発災後の走行速度は平時の0.75倍。必須指定は優先度への加点で、時間内の割当を保証する制約ではない。

### 5.5 事前対策・復旧・その他の計算

| 機能 | 計算仕様 |
|---|---|
| 事前対策 | 日奈久断層帯等の5シナリオまたは平均。耐力の上積みを仮定したリスク低減／費用の順に、年ごとの予算へ配分。拠点は概略経路で比較 |
| 復旧計画 | 損傷確認施設と未確認で`p >= 0.5`の施設が対象。種別×程度の仮の工法・日数・費用、先行作業、工事班、降雨中止条件で応急・本復旧を割当 |
| 着工条件 | 未確認施設は翌日以後、緊急の本復旧は概ね7日以後、通常の本復旧は概ね60日以後という仮定 |
| 降雨 | 合成の`RAIN`を使用。既定では日30mm以上で屋外作業を中止 |
| 廃棄物 | `全壊棟数 × 117 + 半壊棟数 × 117 × b` t。既定`b=0.2`、棟数／人口0.42、かさ密度0.8t/m³、積上高5m、作業空間係数1.0 |
| 洪水 | 河川からの距離と種別による概略想定。レベル1／2／3の帯幅は0.6／1.2／2.0km。標高・流量を使った氾濫計算ではない |
| 避難所アクセスの検査 | 0/1重みの2SFCA、到達圏15／30／45分の比較 |

復旧の終了予定日は見通しである。予定日到来だけで資産の形状・健全度・復旧完了を台帳へ書き戻す処理は実装していない。

廃棄物の主な推計行は`wasteCurrent()`の震度ベース計算であり、公表住家被害からの算出量は別の列・指標として比較表示する。

<a id="schema"></a>
## 6. P1データモデル・ID・状態

### 6.1 永続状態の構造

`OPS.state`の`schemaVersion`は1。

| 配列・項目 | 主な属性 | 関係・用途 |
|---|---|---|
| `sequence` | 整数の連番 | CASE／OBS／SNAP／RECHECK生成用 |
| `activeCases` | `normal`、`post`→案件ID | フェーズごとに選択中の案件 |
| `cases[]` | `id, name, phase, judgmentAt, events, activeEventId, earthquakeAt, definitions, documents, scope, ingested, view, planVersion` | 採用定義・文献をコピーして固定 |
| `runs[]` | `id, caseId, eventId, assetId, assetType, taskId, definitionVersion, definition, documents, eventAt, assetReference, status, assignment, reason` | 業務の実行、割当と保留理由 |
| `observations[]` | `id, order, runId, caseId, assetId, taskId, definitionVersion, observedAt, availableAt, registeredAt, actor, source, sourceEventKey, status, damage, condition, checked, notes, reason, updatesBaseline, attachments` | 実施記録を追記して履歴化 |
| `snapshots[]` | `id, caseId, eventId, judgmentAt, version, createdAt, documents, model, context, inputs, rows` | 計画生成時の入力と割当結果 |
| `revisions[]` | `id, caseId, taskId, reason, evidence, runIds, assetIds, references, before, proposal, status, reviewNote, reviewedEvidence, reviewedBy, reviewedAt` | 根拠付きの見直し候補・確認状況 |

文書版・章節・要件の基礎情報は`PLAN_DOCS`／`PLAN_REQS`で定義し、P1では定義内の`references`へ必要項目を写す。計画文書全体を取り込んだ独立した全文検索DBではない。

### 6.2 共通業務

| 実行の業務ID | 定義版 | 対象種別 | 内容 |
|---|---|---|---|
| `T-ROAD-01` | `demo-inspection-v1` | BR／TN／SL／CV | 平時・災害時共通の道路施設状態確認 |
| `T-SERVICE-01` | `demo-inspection-v1` | LV／PT／SW／WS | 河川・ライフライン状態確認のデモ定義 |
| `T-COOP-01` | `demo-coordination-v1` | 全8種別 | 管理者・管理範囲・連絡先・資料・応援条件の照会 |

画面の`T-OPEN-01`／`T-EMG-01`は、共通道路業務を平時・地震後として説明する表示名。実行の一意性には`T-ROAD-01`を使用する。

### 6.3 ID・重複防止

```text
資産ID     NT-BR-001 等（ASの安定キー）
初期案件   C-NORM / C-EMG
追加案件   CASE-<連番>
追加事象   RECHECK-<連番>
実行ID     RUN:<案件ID>|<事象ID>|<業務ID>|<定義版>|<資産ID>
実施記録   OBS-<連番>
計画入力   SNAP-<連番>
見直し候補 REV:<案件ID>|<業務ID>|<理由>
```

`RUN`／`REV`の各構成要素には`encodeURIComponent`を適用する。同一案件・事象・定義版・施設の再計画は同じ実行を再利用する。別案件・再点検事象では別実行になる。`a.i`は表示・配列アクセス用で、永続的な施設参照には`a.id`を使う。

### 6.4 状態と所見

| 項目 | 値 |
|---|---|
| 実行状態 | `pending` 未割当、`planned` 予定に割当、`unassigned` 未割当・保留、`completed` 完了、`followup` 追加調査、`deferred` 未実施 |
| 入力できる実施状態 | `completed`／`followup`／`deferred` |
| 損傷所見 | `unknown`／`no_damage`／`damaged` |
| 健全度 | `null`または0〜3。表示はI／II／III／IV |
| 記録の出所 | `staff`／`public_report`／`synthetic` |
| 見直し状態 | `proposed`／`reviewed`／`reflected`／`dismissed` |
| 保存状態 | `pending`／`saved`／`error` |

**予定への割当、業務の完了、損傷の有無は別属性。** 未確認を異常なしへ変換しない。未実施にした実行は、同じ事象の自動再計画では候補から外れ、再点検事象を開始して次の実行へ進められる。

未割当等の理由は`no_team`、`unreachable`、`time_limit`、`candidate_limit`、`information_missing`、`below_threshold`、`excluded`、`awaiting_time`等を使用する。

### 6.5 記録入力の検証

- 記録者・所見は必須。フォームでは記録者100文字、所見4,000文字まで。
- 実施日時は実行の開始事象以後。利用可能日時は実施日時以後。
- 確認項目は実行に固定した定義内の項目に限定する。
- 完了には全確認項目が必要。
- 基準状態へ採用するには、`source=staff`、`status=completed`、健全度あり、`updatesBaseline=true`が必要。
- 写真は参照先の文字列として保持し、画像本体は保存JSONへ取り込まない。

### 6.6 計画入力と見直し

計画入力には、採用所見ID、健全度、点検年、震度、耐力、事前確率、重要度、液状化代理値、断層距離、採用期限、管理者未確認状態等を保存する。`context`に班数、時間、拠点、通行止め、必須・除外、候補上限、モデルパラメータを含む。モデル識別子は`demo-prior-condition-v1`。

見直し候補は、未実施・追加調査・健全度III以上・損傷未確認等の記録と、最新の計画入力の班・時間・到達性・情報不足から集約する。確認者・確認内容を保存し、確認後に新たな根拠が加わった場合は再確認対象として表示する。`reflected`はアプリ内の反映記録で、法定計画の改定・公表を実施した状態ではない。

<a id="time"></a>
## 7. 時点制御と記録の採用

### 7.1 日時属性

| 属性 | 意味 |
|---|---|
| `observedAt` | 点検・観測を実施した時刻 |
| `availableAt` | その所見を判断に利用できるようになった時刻 |
| `registeredAt` | アプリに登録した実際の時刻 |
| `judgmentAt` | 案件の判断時点 |
| `earthquakeAt` | 災害案件の発災時点 |
| `fetched_utc`／`verified_utc` | アーカイブの取得・検証時刻。案件の利用可能時刻とは別 |

フォームはJSTで入力し、保存日時にはタイムゾーンを持たせる。発災後の判断時点は情報投入段階に連動する。平時の判断時点は画面から変更できる。

### 7.2 実施状態に採用する記録

実施日時・利用可能日時の両方が判断時点以前の記録を対象とする。同じ実行に複数ある場合、現行の優先順は次のとおり。

1. `staff`を`public_report`より優先し、`public_report`を`synthetic`より優先。
2. 同じ出所の中では利用可能日時が新しいものを優先。
3. 次に実施日時、登録順で比較。

したがって単純な最終登録順の採用ではない。

### 7.3 基準状態に採用する記録

`assetId`で案件を横断し、採用指定のある健全度付き完了記録を対象にする。実施日時、利用可能日時、登録順で新しい記録を選ぶ。

- 平時：実施・利用可能の両時刻が判断時点以前。
- 災害時：両時刻が `min(判断時点, 発災時点−1ms)` 以前。
- 該当する職員入力がなければ、初期台帳の健全度・点検年を用いる。
- 発災後の採用指定付き記録は、その利用可能日時以後の平時判断では基準状態として使用できる。

別案件も同じ資産の基準状態を参照する仕様である。案件を分けることと、所見の共有範囲を完全に分離することは同義ではない。

<a id="storage"></a>
## 8. 保存・復元・JSON入出力

### 8.1 IndexedDB

| 項目 | 値・仕様 |
|---|---|
| DB名／版 | `kumamoto-phase-free-p1`／1 |
| Object Store | `workspace` |
| 保存キー | `current` |
| 保存単位 | 案件・実行・観測・見直し・計画入力・表示条件のパッケージ |
| 保存完了 | IndexedDBトランザクションの`oncomplete`で判定 |
| 書込み順 | Promiseキューで直列化し、最新世代の保存完了を表示 |
| 保存不能 | 未保存状態と理由を表示。メモリ内の操作・JSON書出しを利用可能 |
| 復元失敗 | エラー表示。既存の不正な保存内容を初期状態で自動上書きしない |

保存領域はオリジンごとに分かれる。`file://`、`http://localhost:8000`、`http://127.0.0.1:8000`間の移動にはJSON入出力を使用する。

### 8.2 保存パッケージ

| ルート項目 | 内容 |
|---|---|
| `format` | `kumamoto-phase-free-plan` |
| `version` | 1 |
| `exportedAt` | 書出し時刻 |
| `state` | 第6章の状態、`schemaVersion=1` |
| `session` | `phase, tab, selectedAssetId, rplanView` |

読込み上限は64,000,000バイト。検証対象は形式・版、ID重複、案件・施設・事象参照、定義・文献版の一致、日時、確認項目、完了条件、健全度、出所、計画入力・見直しの参照、連番等。

検証を通過したパッケージで案件一式を復元し、現在の計画を再計算する。既存状態との自動マージではない。保存した業務実行・実施記録は保持する一方、再計算で計画入力スナップショットと計画版は増える。

### 8.3 起動・更新フロー

```text
起動
  → IndexedDBを開く → 保存パッケージを検証・復元
  → 初期状態ならC-NORM／C-EMGを作成
  → 案件の表示条件を適用
  → planPrepare → compute → planFinish
  → 画面表示 → 保存

実施記録の入力
  → 必須・時点・確認項目を検証 → OBSを追記
  → 基準状態／事前確率／実施状態を再構成
  → 再計画 → SNAP保存 → 見直し候補更新 → IndexedDB保存
```

入力・時点が変わると、事前対策・復旧計画のキャッシュも無効化する。

<a id="ai"></a>
## 9. AIツール仕様

### 9.1 実行方式

- ローカルの既定は`ruleSteps()`によるキーワード判定。学習済みLLMをローカルで動かす構成ではない。
- 対応するArtifact環境では`window.claude.use("sample")`を検出し、同じツールを公開する。
- `aiRunTool()`は非同期ツールも`await`し、引数・結果・失敗をトレースへ残す。
- Claude経路は環境のツール数上限に従い、現行では`AI_TOOLS.slice()`で先頭から公開する。
- 人の確認・承認は画面の操作で行う。ツールは計画案・確認依頼・判断材料を返す。

### 9.2 ツール一覧

| 名前 | 主な入力 | 主な出力・処理 |
|---|---|---|
| `get_status` | なし | 案件・時点・投入情報・計画版・記録件数・保存状態 |
| `set_phase` | `phase` | 平時／発災後の既存案件へ切替、履歴を保持 |
| `collect_data` | `count`／`until` | シナリオ情報の段階投入・再計画 |
| `data_sources` | `hazard` | 地震・洪水・平時のA/B/C取得計画 |
| `event_data_index` | `group, status, n` | 保存済みアーカイブの索引・集計・出典 |
| `inspection_plan` | 班数、`hours, depot` | 点検経路、実行ID、未割当理由、計画入力ID |
| `top_assets` | `n, type, town` | 優先施設の抽出 |
| `explain_asset` | 資産`id` | 採用基準状態、業務実行、確率・根拠 |
| `prevention_plan` | `scenario, budget` | 平時の事前対策・年度配分・拠点比較 |
| `recovery_plan` | なし | 発災後の応急・本復旧工程・費用・未確認対象 |
| `land_facility_space` | `view, town, n` | 土地・公共施設・用地の確認材料 |
| `flood_scenario` | `river, level` | 洪水の概略影響・確認先 |
| `waste_estimate` | `town` | 廃棄物量・仮置場面積 |
| `show_tab` | `tab` | 結果を見る画面への遷移ボタン。`rplan`にも対応 |
| `run_audit` | `kind` | 座標、較正、観測偏り、品質、頑健性、アクセス、主題図の検査 |
| `request_approval` | `target, note` | 担当者の確認待ちへ追加 |

報告文は「問い・結論・データ・方法・確かめていないこと」等の枠で作成する。`checkReport()`は枠の順序・版や時点の記載・結論の数字とツール結果の対応を検査する。引用内容の正しさ・行政手順への適合を自動認定する検査ではない。

`plan_search`／`plan_review`／`operational_tasks`／`revision_draft`は統合方針にある拡張予定名であり、現行16ツールには含まれない。

<a id="operation"></a>
## 10. 取得・前処理・ビルド・実行

### 10.1 実行

リポジトリのルートを作業ディレクトリとして実行する。

```sh
open index.html
# または静的HTTP配信
python3 -m http.server 8000 --bind 127.0.0.1
# http://127.0.0.1:8000/index.html
```

ブラウザはHTML内のJSとLeafletで動く。Leafletは埋込み／同梱資材を利用し、予備読込み先も持つ。通常の業務機能にデータ取得用APIキーは不要。

### 10.2 データ取得

```sh
# APIキーは環境変数で設定する。出力へキーを含めない設計
python3 tools/fetch_kumamoto_real.py
python3 tools/fetch_kumamoto_real.py xroad

python3 tools/fetch_kumamoto_event.py
python3 tools/fetch_kumamoto_event.py jma sat_asia
python3 tools/fetch_kumamoto_event.py --audit
```

基盤取得は`DPF_KEY`／`REINFOLIB_KEY`を必要に応じて使用する。イベント取得は既定タイムアウト30秒、試行回数2、`--output`／`--timeout`／`--attempts`で変更可能。

代表的な接続先：

| 系統 | API・URLパターン |
|---|---|
| DPF | `https://data-platform.mlit.go.jp/api/v1/`へGraphQL POST、ヘッダー`apikey` |
| xROAD | `https://road-structures-db.mlit.go.jp/xROAD/api/v1/{bridges,tunnels}?pref=43&limit=10000&offset=...` |
| 不動産情報ライブラリ | `https://www.reinfolib.mlit.go.jp/ex-api/external/{API}?response_format=geojson&z=...&x=...&y=...` |
| J-SHIS | `https://www.j-shis.bosai.go.jp/map/api/`、照会位置は経度・緯度順 |
| シームレス地質図 | `https://gbank.gsj.jp/seamless/v2/api/1.3.1/legend.json?point=緯度,経度` |

個々の公表ファイルのURL・取得状態の正本はmanifest。過去のURLが現在も取得可能であることは、ファイル保存の有無と分けて確認する。

### 10.3 前処理と埋込み

| 処理 | 入力→出力、依存 |
|---|---|
| `knet.py` | 展開した本震・余震ディレクトリ→観測点別PGA・計測震度JSON。NumPy |
| `uki.py` | 提供のRGB画像→色指標の格子・縮小透過PNG・位置情報JSON。NumPy、Pillow |
| `gm.py` | 地球地図のShapefile→背景地図JSON。pyshp |
| `xroad.py` | 基盤ZIP→`xroadbr.min.json`。Python標準ライブラリ |
| `xkt020.py` | 基盤ZIPのXKT020→`xkt020.min.json`。Python標準ライブラリ |
| `ground.py` | 資産ID・緯度経度JSON→地盤・地質JSON。Python標準ライブラリ、外部API |

波形処理はスケール係数・サンプリング周波数をヘッダーから読み、平均除去・周波数フィルター・3成分合成から計測震度を算出する。対象観測点の範囲は緯度31.9–33.3、経度130.1–131.2で、地図の表示枠より広い。

提供画像の色指標は`clip(1−G/255, 0, 1)`等で作り、白背景・方位記号を除外して5×5画素平均を行う。画素色由来の派生値である。

```sh
python3 tools/preprocess/xroad.py kumamoto_real_data.zip tools/preprocess/xroadbr.min.json
python3 tools/preprocess/xkt020.py kumamoto_real_data.zip tools/preprocess/xkt020.min.json
python3 tools/preprocess/ground.py tools/preprocess/facilities_latlon.json ground.json
```

前処理出力をHTML定数へ反映する工程と、P1モジュールのビルドは別である。`build_phase_free_demo.py`は地図・波形・台帳・`EV_DATA`全体の再生成器ではない。

波形の再生成には各地震の展開ディレクトリ、画像処理には元RGB画像、背景地図には元Shapefileが必要となる。これらの入力と生成済みのHTML定数を区別して管理する。

### 10.4 P1のビルド

```sh
python3 tools/build_phase_free_demo.py
python3 tools/build_phase_free_demo.py --check
```

順序は`plan-core.js → plan-storage.js → plan-ui.js`。HTMLの`BEGIN PLAN_P1_BUNDLE`〜`END PLAN_P1_BUNDLE`を更新する。マーカーが一意でない場合や、JS中に不正なscript終了タグを含む場合はエラーになる。

### 10.5 出典索引の同期

`EV_DATA`は223件の埋込み索引。HTTP/HTTPSでデータ基盤タブを開くと、同じ配信元の`kumamoto_event_data/manifest.json`を読み込み、schema 2とsummaryを確認して表示データを置き換える。

`file://`や取得失敗時は埋込み索引を使う。同期成功後の`EV_LIVE`を保持し、常時ポーリングは行わない。同期対象は出典索引であり、施設の被害推定や波形・GeoTIFFの数値解析を自動実行するものではない。

<a id="tests"></a>
## 11. 検証方法と確認結果

### 11.1 実行コマンド

```sh
python3 tools/build_phase_free_demo.py --check
node --test tests/plan_core.test.cjs
node tests/plan_p1.cjs
node tests/smoke.js
python3 -B -m unittest discover -s tests -p 'test_fetch_kumamoto_event.py' -v
```

P1コアテストはNode標準機能を使用する。ブラウザテストはPlaywrightとChromiumが必要。前処理用のNumPy／Pillow／pyshpは、静的HTMLの通常実行には不要。検証時のNodeは22系である。

### 11.2 検証範囲

| 検証 | 内容・確認結果 |
|---|---|
| P1コア | 17テスト。実行ID、版固定、時点、未知の所見、確認項目、投入重複、割当理由、見直し根拠、JSON整合性 |
| P1ブラウザ | file／HTTP双方で平時記録→災害時事前確率、未実施、見直し、再読込み、JSON往復、不正JSON、合成投入の再実行、再点検・別案件を確認 |
| 保存異常 | IndexedDB不使用・保存エラーで、メモリ記録を保持し未保存表示を行うことを確認 |
| 時点の操作 | 将来利用可能の所見を除外し、平時の時点更新で採用・計画再計算、発災前の基準状態には混入しないことを確認 |
| 既存スモーク | 点検、洪水、復旧、実データ索引、P0往復操作。P1実装時に全通過、ページエラー0 |
| 発災後取得 | 21テスト。衝突、破損キャッシュ、容量上限、中断、部分実行、形式、KMZ外部参照等 |
| 取得物の既検証 | 全サイズ・ハッシュ、画像87件、PDF21件、GeoTIFF3件、KMZ/ZIP3件の確認を取得修正時に実施 |
| 本仕様書の棚卸し | コード・基盤ZIPのmanifest・発災後manifest・現行ブラウザの件数を照合 |

テスト成功は実装の動作・整合性の確認である。自治体職員による業務評価や、実被害に対する予測性能の実証とは区別する。READMEのBrier等の例示値は特定シナリオの結果で、固定の性能保証値ではない。

<a id="limitations"></a>
## 12. 制約・仕様差異・拡張箇所

### 12.1 現行モデル・入力の制約

- 施設別被害、SNS、画像判読、交通、降水等には合成値を含む。計画値・リスク低減は仮の損傷関数上の比較。
- 公開資料のアーカイブを取得しても、その全属性が推論へ接続される仕様ではない。
- xROADの判定区分から健全度への対応は`HANTEI_TO_COND={1:3,2:2,3:1,4:0}`で、原定義との対応確認が残る。措置状況は原コードで保持する。
- 台帳上の管理者があっても、実証自治体の管轄へ適用確認済みとはしない。照会業務を別に残す。
- 正式な計画本文・マニュアル・協定を用いた要件照合、引用ページの確認はP2の対象。
- 概略道路網・近似距離・代表点を使うため、実際の走行可能性や個別施設の安全を確定するものではない。
- 共同編集、サーバー保存、正式な改定・報告・公表の実施管理は現行のローカルP1機能とは別の拡張。

### 12.2 コード照合で確認した表示上の差異

| 項目 | 現行の事実・参照箇所 |
|---|---|
| 本震の観測点数 | 従来READMEの59点に対し、現行`KSTA`の本震記録は60点。仕様書とREADMEを現物に合わせて整理 |
| 出典索引の階層表示 | 登録223件に対し、`evDataSection()`のグループ完全一致`r[0]===k`で展開される個別行は45行・12グループ。`jma_kyoshin/wp`や`sentinel_asia/img/...`等の子グループを親の一覧へ含める処理が不足 |
| グループ指定の索引ツール | `event_data_index`も`r[0]===group`で絞るため、親名での指定は子グループを含まない。全件の正本はmanifest |
| 画面名称 | 統合方針での「事前対策」への整理に対し、現行`dplan`タブは「防災計画」表示 |
| 廃棄物の公表値の扱い | `tabWaste()`の説明には公表値への置換とあるが、`wasteCurrent()`の推計行は震度ベースのままで、公表値由来の量は比較列・別指標として表示 |
| 保存される履歴の範囲 | P1の実施記録・計画入力・見直しは永続化するが、`S.log`やAI全文履歴の全体を復元する仕様ではない |
| 再生成範囲 | P1のJS埋込みは自動化。全地理データ・波形・出典索引のHTML再埋込みは独立した工程 |

### 12.3 変更時の確認先

| 変更内容 | 主な変更・確認先 |
|---|---|
| 業務定義・確認項目・作業時間 | `planDefinitions()`、`TYPES`、コアテスト。定義版と旧実行の参照を維持 |
| 平時所見の採用・事前確率 | `PlanCore.baseline()`、`planBaseline()`、`planPrior()`、`scoreNormal()`、`posterior()`、時点テスト |
| 永続モデル・JSON | `createState()`、`validateBundle()`、`PlanStorage`、形式版・移行設計 |
| 未割当・見直し | `planFinish()`、`reconcile()`、`deriveRevisions()`、`reviewRevision()` |
| 文献の原文・版 | `PLAN_DOCS`／`PLAN_REQS`、`references`、固定参照の表示、今後のPDF前処理 |
| 取得先・形式・容量 | `fetch_kumamoto_event.py`、manifest、取得回帰テスト |
| 出典索引の表示・更新 | `EV_DATA`、`syncEvData()`、`evDataSection()`、`event_data_index` |
| 配布HTML | ソース変更後のビルドと`--check`、file／HTTPブラウザテスト |
