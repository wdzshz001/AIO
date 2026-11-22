# animeko / ani 代码考古报告（2024-09-04 快照，commit `3b12232`）

> 目标：把 Kotlin Multiplatform 版 ani 的**架构事实与业务逻辑事实**提炼成可直接移植到 TypeScript/Electron 的规格说明。
> 只读分析，未修改 `_ref/ani` 下任何文件。

## 0. 版本、范围与结论速览

### 0.1 快照信息

| 项 | 值 | 依据 |
|---|---|---|
| 仓库 | `open-ani/ani`（后改名 animeko） | `README.md:3` |
| 提交 | `3b1223227ed8dd49b13ab3f87cec8209cd3eb46c`（"run ci"） | `git log -1` |
| 提交时间 | 2024-09-04 00:33:10 +0800 | 同上 |
| 文件数 | 2564（忽略 `.git`），其中 Kotlin/KTS/MD/JSON/YAML 约 1200 | `Get-ChildItem` 统计 |
| 构建版本号 | `version.name=3.0.0-dev`、`package.version=3.0.0`、`android.version.code=30200` | `gradle.properties` |
| 源码行内版本标注 | 代码里存在 `@since 3.5`、`@since 3.7`、`@since 3.8` 注释 | `APP/data/models/preference/MediaSelectionSeetings.kt:39`、`DS/api/.../Media.kt:258`、`DS/api/.../MediaCacheMetadata.kt:110` |

**不确定**：`gradle.properties` 的版本号由 CI 任务 `:ci-helper:updateDevVersionNameFromGit` 覆盖，仓库里的 `3.0.0-dev` 只是占位值；但代码内 `@since 3.8` 的注释说明该树的实际内容已在 3.8 开发线上。因此本报告统一用「本快照」指代，不强行绑定某个发行版本号。

### 0.2 本报告使用的路径简写

| 简写 | 实际路径 |
|---|---|
| `DS/` | `data-sources/` |
| `APP/` | `app/shared/src/commonMain/kotlin/` |
| `VP/` | `app/shared/video-player/src/commonMain/kotlin/` |
| `DM/` | `danmaku/` |

（`app/shared/src/androidMain/kotlin`、`desktopMain/kotlin` 会写全。）

### 0.3 十条最重要的结论（先给答案）

1. **本快照完全没有「订阅文件 / schemaVersion / web-selector / json-api」这一层。** 全仓库 grep `schemaVersion|searchConfig|subjectFormat|channelFormat|json-api|jsonApi` **零命中**。数据源是**硬编码的 Kotlin 类**，通过 Java `ServiceLoader`（SPI）注册，用户只能在「设置 → 数据源」里启用/禁用、填写少量参数、配代理。真正的「JSON 订阅 + CSS Selector + JSONPath」是后来的 animeko（`schemaVersion: 2`、`factoryId: web-selector`）才引入的 —— 详见 §8。
2. **本快照也不存在 `EpisodeRecord` / 本地播放进度表。** grep `EpisodeRecord|EpisodeHistory|playbackProgress|lastPlayed` 零命中。Room 数据库只有 2 张表（`search_history`、`search_tag`），播放进度**只存在 Bangumi 服务器上**，「继续观看」是从 Bangumi 剧集收藏状态推导出来的（`APP/data/models/subject/SubjectProgressInfo.kt:70-149`）。
3. **核心抽象链**：`MediaSource.fetch(MediaFetchRequest) -> SizedSource<MediaMatch>` → `MediaFetcher`（多源并行 + 累计 + 去重）→ `MediaSelector`（过滤 + 排序 + 偏好 + 选择）→ `PlayerLauncher`（把选中的 `Media` 解析成 `VideoSource`）→ `PlayerState`（播放）。这条链在 TS 里可以 1:1 复刻。
4. **`MediaFetchRequest` 是「按单集」查询的**（含 `episodeSort`、`episodeEp`、`episodeName`），所以本快照里**数据源自己负责按集过滤**（web 源内部 `filter { it.definitelyMatches(query) }`）。这一点与最新 animeko（数据源返回整个条目的全部资源、由 MediaSelector 按当前集过滤）**是根本性差异**，移植时务必二选一，不要混。
5. **两种集号 `ep` 与 `sort` 是本项目的核心领域概念**，贯穿模型、请求、匹配、弹幕、种子内文件选择。`ep` = 本季度内序号，`sort` = 系列内序号（第二季第 1 集 sort=26）。`EpisodeSort` 还支持 `.5` 与 `SP/OVA/OP/ED` 等特殊集。
6. **web 数据源是「三段式」**：搜索页 → 条目页（剧集列表，可能带线路 channel）→ 播放页（`ResourceLocation.WebVideo`）。真正的视频直链由平台 WebView/Selenium **在播放时**拦截获得，不在数据源阶段产生。每段都是 `retry(3)` + 失败返回空。
7. **Bangumi 只做「条目数据 + 收藏/进度」**，从不提供视频。条目搜索有**新旧两套 API**（`/search/subject/{keyword}` 与 `POST /v0/search/subjects`），剧集列表来自 `/v0/episodes` 或 `/v0/users/-/collections/{subjectId}/episodes`（后者带用户观看状态，需登录）。
8. **选源算法是可完整移植的确定性 DFS**：分辨率 → 字幕语言 → 字幕组 → 数据源，四层循环，见 `APP/data/source/media/selector/MediaSelector.kt:474-539`，注释里明确写了设计意图（`#174`）。偏好会按 subject 持久化，下次播放自动沿用（`APP/data/repository/EpisodePreferencesRepository.kt:36-58`）。
9. **「自动下一集」「90% 自动标记看过」「自动跳过 OP/ED」都是 ViewModel 里的几个协程**，不是播放器内建能力：`APP/ui/subject/episode/EpisodeViewModel.kt:603-679`。
10. **播放器本身不含「清晰度切换」**：多清晰度 = 多个 `Media`（`MediaProperties.resolution`），换线路 = 换 `Media` 或换 `Ep` 的 channel；文件内部的音轨/字幕轨才是 `TrackGroup`。见 §5.2。

---

## 1. 核心数据模型

### 1.0 三个模型层次（先建立心智模型）

ani 里同名概念分三层，移植时如果不分开会写乱：

| 层 | 包 | 代表类型 | 作用 |
|---|---|---|---|
| **数据源层**（与 App 无关，可独立发布） | `me.him188.ani.datasources.api` | `MediaSource`、`Media`、`MediaFetchRequest`、`EpisodeSort`、`EpisodeRange`、`Topic`、`ResourceLocation` | 定义「怎么查资源」，不含 UI/账号概念 |
| **Bangumi 层** | `me.him188.ani.datasources.bangumi` | `BangumiClient`、`BangumiSubject`、`BangumiEpisode`、`BangumiUserSubjectCollection` | OpenAPI 自动生成的 DTO + 手写客户端 |
| **App 领域层** | `me.him188.ani.app.data.models` | `SubjectInfo`、`EpisodeInfo`、`EpisodeCollection`、`SubjectCollection`、`SubjectProgressInfo` | UI/ViewModel 唯一使用的结构，外部数据都转到这里 |

数据流：`BangumiEpisode -> EpisodeInfo`（`APP/data/repository/BangumiEpisodeRepository.kt:154-169`）、`BangumiSubject -> SubjectInfo`（`APP/data/repository/BangumiSubjectRepository.kt:178-206`）、`SubjectInfo+EpisodeInfo -> MediaFetchRequest`（`APP/data/source/media/fetch/MediaFetcher.kt:97-110`）、`Topic -> DefaultMedia`（`DS/api/src/commonMain/kotlin/source/TopicMediaSource.kt:60-80`）。

> **移植建议**：在 TS 里也应保持这三层。数据源层写成纯函数 + 接口（不 import 任何 UI/账号代码），Bangumi 层写成 DTO + mapper，领域层写成 zustand/类的 state。

---

### 1.1 数据源与配置模型

#### `MediaSource`（`DS/api/src/commonMain/kotlin/source/MediaSource.kt:72`）

```kotlin
interface MediaSource : AutoCloseable {
    val mediaSourceId: String                 // 全局唯一 ID, 如 "dmhy"、"nyafun"、"local-file-system"
    val location: MediaSourceLocation         // 默认 Online
    val kind: MediaSourceKind                  // WEB / BitTorrent / LocalCache
    val info: MediaSourceInfo
    suspend fun checkConnection(): ConnectionStatus
    suspend fun fetch(query: MediaFetchRequest): SizedSource<MediaMatch>
    override fun close() {}
}
```

关键契约（原注释，`MediaSource.kt:102-122`）：

- `fetch` 要「尽可能多地」返回结果，但必须精准：
  - 100% 确定匹配 → `MatchKind.EXACT`
  - 100% 确定不匹配 → **剔除**
  - 无法判定 → 返回并标 `MatchKind.FUZZY`
- **注释明确说明：数据源返回的错误剧集不会被后续流程剔除。** 若请求 `episodeSort="01"` 而源返回 `"02"`，它会被原样展示给用户（除非用户在设置里开了过滤）。这一点对本快照成立，因为 `MediaSelector` 不按集过滤（只按 alliance/resolution/subtitle/mediaSource 过滤，见 `MediaSelector.kt:161-185`）。
- 数据源**不提供条目数据**，依赖 Bangumi 提供的条目信息（`MediaSource.kt:29-31`）。
- `mediaSourceId` 用于保存用户偏好、识别缓存来源。

`MediaSourceInfo`（`MediaSource.kt:127-133`）：

```kotlin
class MediaSourceInfo(
    val displayName: String,
    val description: String? = null,
    val websiteUrl: String? = null,
    val iconUrl: String? = null,
    val iconResourceId: String? = null,
)
```

#### `MediaSourceFactory`（`DS/api/src/commonMain/kotlin/source/MediaSourceFactory.kt:28-60`）

```kotlin
interface MediaSourceFactory {            // SPI service load
    val factoryId: FactoryId              // 数据源「类型」，不等于 mediaSourceId
    val allowMultipleInstances: Boolean get() = false
    val parameters: MediaSourceParameters get() = MediaSourceParameters.Empty
    val info: MediaSourceInfo
    fun create(mediaSourceId: String, config: MediaSourceConfig): MediaSource
}
```

`FactoryId` 是 `@JvmInline value class`，注释写明是「强制类型检查，防止跟 mediaSourceId 弄混（历史遗留问题，有太多的 mediaSourceId 了）」（`MediaSourceFactory.kt:12-19`）。**这个坑值得在 TS 里用 branded type 复刻**：`type FactoryId = string & {__brand:'FactoryId'}`。

`allowMultipleInstances`：允许同一类型建多个实例（不同配置），典型是 `RssMediaSource`（`APP/data/source/media/source/RssMediaSource.kt:90`）。

#### `MediaSourceConfig`（`DS/api/src/commonMain/kotlin/source/MediaSourceFactory.kt:62-84`）

```kotlin
@Serializable
data class MediaSourceConfig(
    val proxy: ClientProxyConfig? = null,
    val userAgent: String? = null,
    /** 用户为数据源配置的参数列表. 一定包含 parameters 中的所有参数 */
    val arguments: Map<String, String?> = mapOf(),
) {
    companion object { val Default = MediaSourceConfig() }
}

operator fun <T> MediaSourceConfig.get(parameter: MediaSourceParameter<T>): T =
    arguments[parameter.name]?.let { parameter.parseFromString(it) } ?: parameter.default()

fun HttpClientConfig<*>.applyMediaSourceConfig(config: MediaSourceConfig) {
    config.proxy?.let { proxy(it) }
    config.userAgent?.let { userAgent(it) }
}
```

**这是本快照里「数据源配置」的全部**：代理 + UA + 一个 `Map<String,String?>`。没有 JSON schema、没有版本号、没有站点选择器。

#### 参数 schema（`DS/api/src/commonMain/kotlin/source/parameter/`）

```kotlin
sealed interface MediaSourceParameter<T> {
    val name: String
    val description: String?
    val default: () -> T
    fun parseFromString(value: String): T
}
class StringParameter(override val name, description, default, val placeholder: String?, val isRequired: Boolean,
                      validate: (String)->Boolean, val sanitize: (String)->String) : ...
data class BooleanParameter(name, description, default) : ...
data class SimpleEnumParameter(name, val oneOf: List<String>, description, default) : ...
```

构造 DSL：`MediaSourceParametersBuilder.string/boolean/simpleEnum/add`（`DS/api/src/commonMain/kotlin/source/parameter/MediaSourceParameters.kt:20-84`）。注意 `string(...)` 不传 `defaultProvider` 时自动 `isRequired = true`（同文件 `:31-37`）。

UI 侧：`APP/ui/settings/tabs/media/source/EditMediaSourceLayout.kt`、`MediaSourceGroup.kt`、`MediaSourceGroupState.kt` 渲染这些参数并做连接测试（`ConnectionTester.kt`）。

#### `MediaSourceInstance` / `MediaSourceSave`（`APP/data/source/media/instance/MediaSourceInstance.kt:16-52`）

```kotlin
@Stable
class MediaSourceInstance(
    val instanceId: String,   // uuid, 持久化用
    val factoryId: FactoryId,
    val isEnabled: Boolean,
    val config: MediaSourceConfig,
    val source: MediaSource,
) : AutoCloseable

@Serializable
data class MediaSourceSave(           // 持久化在文件里
    val instanceId: String,
    val mediaSourceId: String,
    val factoryId: FactoryId = FactoryId(mediaSourceId),
    val isEnabled: Boolean,
    val config: MediaSourceConfig,
)
```

`MediaSourceSave` 就是本快照的「订阅条目」等价物（详见 §2.3）。

---

### 1.2 `Media`：一个可播放资源

#### 接口（`DS/api/src/commonMain/kotlin/Media.kt:37-115`）

```kotlin
@Serializable
sealed interface Media {
    val mediaId: String          // 全局唯一, 通常包含 mediaSourceId, 如 "dmhy.1"
    val mediaSourceId: String    // e.g. "dmhy"
    val originalUrl: String      // 数据源上的原始链接, 一般 HTTP URL
    val download: ResourceLocation
    val episodeRange: EpisodeRange?  // null = 解析失败 (会被 MediaMatch.matches 过滤掉)
    val originalTitle: String    // 字幕组发布的原标题; "" = 数据源不支持
    val publishedTime: Long      // 毫秒; 0 = 不支持
    val properties: MediaProperties
    val extraFiles: MediaExtraFiles
    val location: MediaSourceLocation
    val kind: MediaSourceKind
}
```

`mediaId` 注释原文：「该资源的全局唯一 id，通常需要包含 mediaSourceId，例如 "dmhy.1"，以防多数据源查询到同一个资源会容易 crash UI。」（`Media.kt:40-41`）

`episodeRange` 注释（`Media.kt:61-74`）说明：单集 → `EpisodeRange.single`；季度全集 → 12 个元素或 `range(1..12)` 或 `season(S1)`。**`null` 会导致 `MediaMatch.matches` 一定过滤掉**。另有一条重要行为：

> 如果剧集为单集且 `kind == BitTorrent`，很可能因为默认启用的「完结番隐藏单集资源」被过滤掉；若想一直显示，可把 `kind` 改成 `WEB`。

#### `DefaultMedia`（一手资源，`Media.kt:130-174`）

```kotlin
@Serializable
data class DefaultMedia @SerializationOnly constructor(
    override val mediaId: String,
    override val mediaSourceId: String,
    override val originalUrl: String,
    override val download: ResourceLocation,
    override val originalTitle: String,
    override val publishedTime: Long,
    override val properties: MediaProperties,
    override val episodeRange: EpisodeRange? = null,
    override val extraFiles: MediaExtraFiles = MediaExtraFiles.Empty,
    override val location: MediaSourceLocation = MediaSourceLocation.Online,
    override val kind: MediaSourceKind = MediaSourceKind.BitTorrent,
)
```

（`@SerializationOnly` + private `_primaryConstructorMarker` 是一种「禁止业务代码用主构造器」的技巧，对 TS 无意义，可去掉。）

#### `CachedMedia`（本地缓存包装，`Media.kt:181-193`）

```kotlin
class CachedMedia(
    val origin: Media,                 // 不能是 CachedMedia
    cacheMediaSourceId: String,
    override val download: ResourceLocation,
    override val location: MediaSourceLocation = MediaSourceLocation.Local,
    override val kind: MediaSourceKind = MediaSourceKind.LocalCache,
) : Media by origin {
    override val mediaId: String = "${cacheMediaSourceId}:${origin.mediaId}"
    override val mediaSourceId: String = cacheMediaSourceId
}
```

注意 `mediaId` 前缀 `"<cacheSourceId>:"`，所以**同一资源被缓存后 mediaId 会变**（避免 UI key 冲突）。`unwrapCached()`（`Media.kt:120-123`）用于取回原始 `DefaultMedia`。

#### `MediaProperties`（`Media.kt:199-279`）

```kotlin
@Serializable
class MediaProperties private constructor(
    val subtitleLanguageIds: List<String>,  // "CHS","CHT","JPY"(原文如此),"ENG"; 空 = 无字幕
    val resolution: String,                 // "720P","1080P","2K","4K"; 大写; 空 = 未知
    val alliance: String,                   // 字幕组名, 如 "桜都字幕组"; 空可能导致被忽略
    val size: FileSize = 0.bytes,
    val subtitleKind: SubtitleKind? = null, // null = 未知 (不等于没字幕)
)
```

注释里的硬性约定（对移植很重要）：

- `subtitleLanguageIds` 建议值 `"CHS","CHT","JPY","ENG"` 才能保证 UI 显示本地化名称（`Media.kt:203-213`）。
- `resolution` 总是大写，建议只用 4 个值；其它值会导致前端匹配不上、选择器 UI 混乱（`Media.kt:214-227`）。
- `alliance` **必须稳定**：用户选中后会存成偏好，下次自动套用；不稳定就选不中（`Media.kt:228-237`）。
- `subtitleKind` 的 `null` 表示未知（`Media.kt:246`）。

#### `SubtitleKind`（`Media.kt:285-311`）

```kotlin
@Serializable
enum class SubtitleKind {
    EMBEDDED,                        // 硬字幕(内嵌), 无法关闭
    CLOSED,                          // 内封(可关闭的字幕轨)
    EXTERNAL_PROVIDED,               // 通过 Media.extraFiles 提供的外挂字幕
    EXTERNAL_DISCOVER,               // 播放器自行在目录里找
    CLOSED_OR_EXTERNAL_DISCOVER,
}
```

平台缺陷表（`Media.kt:250-257`，来自 issue #615）：

| 平台 | 缺陷 |
|---|---|
| macOS | 完全不能播内封，只能播内嵌 |
| Android | 播双语内封可能有问题 → 低优先 |
| 所有平台 | 都不能播外挂资源 |

移植到 Electron（mpv/chromium 内核）时这张表要重写，但**「每个平台有一张 `SubtitleKind -> {NORMAL, LOW_PRIORITY, HIDE}` 表」这个机制非常值得抄**（见 §1.9 `MediaSelectorSubtitlePreferences`）。

#### `MediaExtraFiles` / `Subtitle`（`DS/api/src/commonMain/kotlin/MediaExtraFiles.kt:8-25`）

```kotlin
@Serializable
class MediaExtraFiles(val subtitles: List<Subtitle> = emptyList())
@Serializable
data class Subtitle(val uri: String, val mimeType: String? = null, val language: String? = null)
```

---

### 1.3 查询请求与匹配

#### `MediaFetchRequest`（`DS/api/src/commonMain/kotlin/source/MediaFetchRequest.kt:12-61`）

```kotlin
@Serializable
class MediaFetchRequest(
    val subjectId: String,               // Bangumi 条目 ID (可能为 null/"" 表示未知 —— 实际是 String, 注释说可能 null)
    val episodeId: String,               // Bangumi 剧集 ID
    val subjectNameCN: String? = null,   // 条目主简体中文名
    val subjectNames: Set<String>,       // 所有已知名称 (简中/别名/简称/日文原名), 含季度信息
    val episodeSort: EpisodeSort,        // 系列内集数, 如 "49","01"
    val episodeName: String,             // 剧集名 (不含 "第 x 集"), 可能空
    val episodeEp: EpisodeSort? = episodeSort, // 季度内集数
)
```

构造点（`APP/data/source/media/fetch/MediaFetcher.kt:97-110`）：

```kotlin
fun MediaFetchRequest.Companion.create(subject: SubjectInfo, episode: EpisodeInfo) = MediaFetchRequest(
    subjectId = subject.id.toString(),
    episodeId = episode.id.toString(),
    subjectNameCN = subject.nameCnOrName,
    subjectNames = subject.allNames.toSet(),
    episodeSort = episode.sort,
    episodeName = episode.displayName,
    episodeEp = episode.ep,
)
```

`subjectNames` 来自 `SubjectInfo.allNames`（`APP/data/models/subject/SubjectInfo.kt:73-84`）：`nameCn` + `name` + infobox 里的所有别名。`allNames` 用 `lazy(PUBLICATION)` 缓存，并在计算时打日志。

#### `MediaMatch` 与匹配规则（`DS/api/src/commonMain/kotlin/source/MediaMatch.kt`）

```kotlin
data class MediaMatch(val media: Media, val kind: MatchKind)

fun MediaMatch.matches(request: MediaFetchRequest): Boolean? {
    val actualEpRange = this.media.episodeRange ?: return null
    val expectedEp = request.episodeEp
    return !(request.episodeSort !in actualEpRange && (expectedEp == null || expectedEp !in actualEpRange))
}
fun MediaMatch.definitelyMatches(request: MediaFetchRequest): Boolean = matches(request) == true

enum class MatchKind { EXACT, FUZZY }
```

- 返回 `null` = 条件不足（`episodeRange == null`）。
- `EXACT` 的语义（`MediaMatch.kt:34-38`）在本版本被注释写成「与 cache 精确匹配，通常因为 episode id 相同」—— 那是从缓存匹配逻辑抄来的注释，实际数据源里 `EXACT` 仅用于 Mikan 的「索引命中」路径（`DS/bt/mikan/src/commonMain/kotlin/MikanMediaSource.kt:204`）和缓存匹配（`MediaFetchRequest.kt:77-105` 的 `infix fun MediaFetchRequest.matches(cache)`）。

`MediaFetchRequest.matches(cache: MediaCacheMetadata)`（`MediaFetchRequest.kt:77-105`）是**缓存命中的唯一判定**，很值得抄：

```
if (episodeId != "" && cache.episodeId != "") {
    return if (cache.episodeId == episodeId) EXACT else null   // 双方都有 id 时不做模糊, 否则必然误报
}
// 否则模糊:
if (episodeName 非空 && cache.episodeName == episodeName) return FUZZY
if (subjectNames 有交集) {
    return if (episodeSort == cache.episodeSort || episodeEp == cache.episodeSort) FUZZY else null
}
return null
```

---

### 1.4 集数：`EpisodeSort` / `EpisodeType` / `EpisodeRange`

这套类型是整个项目最值得原样移植的领域模型。

#### `EpisodeType`（`DS/api/src/commonMain/kotlin/EpisodeType.kt:5-15`）

```kotlin
@Serializable
enum class EpisodeType(val value: String) {
    MainStory("MainStory"), SP("SP"), OP("OP"), ED("ED"), PV("PV"), MAD("MAD"), OVA("OVA"), OAD("OAD")
}
```

注意 `MainStory.value == "MainStory"`（不是 "0"），而 Bangumi 的 `type` 字段是 `Int`（0..5），映射在 `APP/data/repository/BangumiEpisodeRepository.kt:171-181`：

```kotlin
0 -> MainStory; 1 -> SP; 2 -> OP; 3 -> ED; 4 -> PV; 5 -> MAD; else -> null
```

#### `EpisodeSort`（`DS/api/src/commonMain/kotlin/EpisodeSort.kt:31-149`）

```kotlin
@Serializable                       // do not change package name!
sealed class EpisodeSort : Comparable<EpisodeSort> {
    abstract val number: Float?     // 普通剧集返回序号, 否则 null
    internal abstract val raw: String   // "1","1.5","SP"; 小于 10 不带前导 0
    abstract override fun toString(): String  // 人类可读: 1 -> "01", 1.5 -> "1.5", SP -> "SP"

    @Serializable class Normal internal constructor(override val number: Float) : EpisodeSort() {
        val isPartial: Boolean get() = number % 1f == 0.5f
    }
    @Serializable class Special internal constructor(val type: EpisodeType, override val number: Float?) : EpisodeSort()
    @Serializable class Unknown internal constructor(override val raw: String) : EpisodeSort()
}
```

解析函数（`EpisodeSort.kt:151-191`）：

```kotlin
fun EpisodeSort(raw: String): EpisodeSort {
    val float = raw.toFloatOrNull() ?: return getSpecialByRaw(raw)
    if (float < 0) return EpisodeSort.Unknown(raw)
    return if (float.toInt().toFloat() == float || float % 0.5f == 0f) Normal(float) else Unknown(raw)
}
// getSpecialByRaw: 按 EpisodeType 前缀(忽略大小写)匹配, 后缀须能解析为 >=0 且整数或 .5
fun EpisodeSort(int: Int, type: EpisodeType = MainStory): EpisodeSort
fun EpisodeSort(int: BigNum, type: EpisodeType? = MainStory): EpisodeSort
```

**规则总结（可直接写成 TS）**：

- 只有「整数」或「x.5」算 `Normal`；`1.25` → `Unknown`。
- `Special` 需要 `EpisodeType` 前缀 + 合法数字，如 `SP01`、`OVA2`、`SP`（无数字 → `number=null`）。
- 比较顺序：`Normal < Special < Unknown`；`Special` 之间先比 `type` 的枚举序，再比 `number`（null 最小），最后比 `raw`。
- `equals` 是「number 相同 + raw 相同」，`hashCode` 也是这个组合 —— 因此 `Normal(1)` 与 `Special(SP,1)` 不等。
- **有隐藏陷阱**：`toString()` 会对 <10 的普通集补零（`01`），而 `raw` 不补零。移植时必须区分「显示值」和「规范值」，本项目的 `mediaId` 用的是 `toString()`（`DS/web/nyafun/src/NyafunMediaSource.kt:129`），所以 mediaId 里是 `01`。

#### `EpisodeRange`（`DS/api/src/commonMain/kotlin/topic/EpisodeRange.kt:38-234`）

```kotlin
@Serializable
sealed class EpisodeRange {
    open val isKnown: Boolean get() = true
    abstract val knownSorts: Sequence<EpisodeSort>

    // 私有: Empty
    internal class Single(val value: EpisodeSort) : EpisodeRange()
    internal class Range(val start: EpisodeSort, val end: EpisodeSort) : EpisodeRange()  // 枚举 .5 也支持
    class Combined internal constructor(val first: EpisodeRange, val second: EpisodeRange) : EpisodeRange()
    data class Season(val rawNumber: Int) : EpisodeRange() {   // -1 = 未知季度
        val numberOrZero: Int get() = if (rawNumber == -1) 0 else rawNumber
        override val isKnown: Boolean get() = false
        override fun toString() = if (rawNumber != -1) "S$rawNumber" else "S?"
    }
    companion object {
        fun empty(); fun single(raw: EpisodeSort); fun single(raw: String)
        fun range(start,end) / range(String,String) / range(Int,Int) / range(Iterable<EpisodeSort>)
        fun combined(first, second) / combined(list)
        fun season(number: Int) / season(number: Int?) / unknownSeason()
    }
}

operator fun EpisodeRange.contains(expected: EpisodeSort): Boolean = contains(expected, allowSeason = true)
fun EpisodeRange.contains(expected: EpisodeSort, allowSeason: Boolean = true): Boolean {
    if (allowSeason && this is Season) return true
    return knownSorts.any { it == expected }
}
fun EpisodeRange.isSingleEpisode(): Boolean    // Single, 或 Range(start==end), 或 Combined(first==second)
fun EpisodeRange.hasSeason(): Boolean          // Season 才算; Range(1..12) 返回 false
```

`Range.knownSorts` 的枚举逻辑（`:84-101`）：非 Normal 端点时只 yield 两端；`start.isPartial`（x.5）时先 yield start 再 +0.5 步进；之后按 1.0 步进到 `end.number` 并 yield end。

`Alliance`（`EpisodeRange.kt:277-281`）：`data class Alliance(val id: String, val name: String)` —— 定义在 EpisodeRange 文件里，实际很少用。

---

### 1.5 `ResourceLocation`：怎么拿到字节

`DS/api/src/commonMain/kotlin/topic/ResourceLocation.kt:6-81`

```kotlin
@Serializable
sealed class ResourceLocation {
    abstract val uri: String

    data class MagnetLink(override val uri: String)        // 必须 "magnet:" 开头
    data class HttpTorrentFile(override val uri: String)    // http(s):// 的 .torrent
    data class HttpStreamingFile(override val uri: String)  // 可直接流式播放: mp4/mkv/m3u8
    data class WebVideo(override val uri: String)           // 需要 WebView 去页面里解析视频链接
    data class LocalFile(val filePath: String) {            // 绝对路径; uri = "file://$filePath"
        override val uri: String by lazy { "file://${filePath}" }
    }
}
```

每个子类构造函数都有 `require(...)` 校验前缀（`LocalFile` 除外）。**这是路由到 resolver 的唯一键**：`VideoSourceResolver.supports()` 全部用 `media.download is X` 判断。

> 最新 animeko 给 `WebVideo` 加了 `apiParameters` 字段（用于 JSON API 源），并明确因为「反序列化遇未知子类会丢弃整个列表」而**不新增子类**。本快照没有这个字段。见 §8。

---

### 1.6 `Topic`：BT 源的中间模型

`DS/api/src/commonMain/kotlin/topic/Topic.kt:29-74`

```kotlin
@Serializable
class Topic(
    val topicId: String,                  // 数据源内部 ID
    val publishedTimeMillis: Long?,
    val category: TopicCategory,          // 只有 ANIME
    val rawTitle: String,
    val commentsCount: Int,
    val downloadLink: ResourceLocation,
    val size: FileSize,
    val alliance: String,
    val author: Author?,
    val details: TopicDetails?,           // 解析后的标题信息
    val originalLink: String,
)

@Serializable
class TopicDetails(
    val tags: List<String>,
    val chineseTitle: String?,
    val otherTitles: List<String>,
    val episodeRange: EpisodeRange?,
    val resolution: Resolution?,
    val frameRate: FrameRate?,
    val mediaOrigin: MediaOrigin?,
    val subtitleLanguages: List<SubtitleLanguage>,
    val subtitleKind: SubtitleKind?,
)

@Serializable enum class TopicCategory { ANIME }
```

`TopicCriteria`（`DS/api/src/commonMain/kotlin/topic/TopicCriteria.kt:6-45`）：

```kotlin
class TopicCriteria(val episodeSort: EpisodeSort?, val episodeEp: EpisodeSort?, val fallback: Boolean = false) {
    companion object { val ANY = TopicCriteria(null, null, fallback = true) }
}
fun TopicCriteria.matches(topic: Topic, allowEpMatch: Boolean): Boolean {
    val details = topic.details ?: return fallback
    if (isEpisodeSortMatch(details)) return true
    if (allowEpMatch && isEpisodeEpMatch(details)) return true
    return fallback
}
fun MediaFetchRequest.toTopicCriteria(): TopicCriteria  // 注意: fallback 默认 false
```

`allowEpMatch` 的用法差异是本快照的一个细节：**Mikan 的索引搜索用 `allowEpMatch = true`，关键字搜索用 `false`**（`MikanMediaSource.kt:171, 202`），而 `RssMediaSource` 一直用 `false`（`RssMediaSource.kt:170`）。

`Topic -> DefaultMedia`（`TopicMediaSource.kt:60-80`）：

```kotlin
fun Topic.toOnlineMedia(mediaSourceId: String) = DefaultMedia(
    mediaId = "$mediaSourceId.${topicId}",
    mediaSourceId = mediaSourceId,
    originalUrl = originalLink,
    download = downloadLink,
    originalTitle = rawTitle,
    publishedTime = publishedTimeMillis ?: 0,
    episodeRange = details?.episodeRange,
    properties = MediaProperties(
        subtitleLanguageIds = details?.subtitleLanguages?.map { it.id } ?: emptyList(),
        resolution = details?.resolution?.toString() ?: Resolution.R1080P.toString(),  // 未知时兜底 1080P
        alliance = alliance,
        size = size,
        subtitleKind = details?.subtitleKind,
    ),
    kind = MediaSourceKind.BitTorrent,
    location = MediaSourceLocation.Online,
)
```

**注意那个兜底 `?: Resolution.R1080P.toString()`**：解析不到分辨率就谎报 1080P。移植时可以改成空字符串以诚实（但会改变选择器行为）。

#### 标题解析器（`DS/api/src/commonMain/kotlin/topic/titles/`）

`RawTitleParser`（`:32-52`）默认实现是 **`LabelFirstRawTitleParser`**（不是 PatternBased！）：

```kotlin
companion object {
    private val default by lazy(LazyThreadSafetyMode.PUBLICATION) { LabelFirstRawTitleParser() }
    fun getDefault(): RawTitleParser = default
}
```

`ParsedTopicTitle`（`RawTitleParser.kt:54-90`）字段与 `TopicDetails` 一一对应。

`LabelFirstRawTitleParser`（`LabelFirstRawTitleParser.kt:32-240`）的算法：

1. `splitWords()`：按 `[] () {} 【】（）「」『』` 把标题切词，括号内容单独成词（`:264-265, 295-327`）。
2. 过滤 `★N月新番` 之类（进 `tags`），去掉「招募/招新」（`:40-48`）。
3. 第一遍逐词 `parseWord`：字幕语言 → 分辨率 → 帧率 → 集数 → 来源（`BDRip/WEB-DL`…）（`:85-94`）。
4. 第二遍：若仍没有集数，但出现 `BD`/`Blu-Ray` → 判为 `EpisodeRange.unknownSeason()`（`:56-64`）。
5. 字幕类型判定（`:66-77`）：含「内嵌/內嵌」→ EMBEDDED；「内封/內封」→ CLOSED；「外挂/外掛」→ EXTERNAL_DISCOVER；否则若非日语字幕计数 ≥2 → CLOSED；否则 null。
6. 集数解析（`:130-237`）：先剔除 `第/完/END/(完)/话/集/話/v2/版`，再依次尝试「纯浮点」「`start-end` 区间」「`S1+S2` 季」「SP/OVA/小剧场/特别篇/番外篇/OAD」。

`PatternBasedRawTitleParser`（389 行）是**另一套手写规则**（A 类/B 类/C 类标题），当前**不是默认**，仅测试用（`DS/api/src/commonTest/kotlin/title/...` 里每个番剧一个生成测试）。

#### 分辨率/字幕语言（`Resolution.kt`, `SubtitleLanguage.kt`）

```kotlin
class Resolution private constructor(val id: String, val size: Int, private val otherNames: List<String>, val displayName: String = id)
// 240P/360P/480P/560P/720P/1080P/1440P(2K)/2160P(4K)
fun tryParse(text: String): Resolution?  // 依次 contains(id 或 otherNames, ignoreCase)
```

`SubtitleLanguage`（`SubtitleLanguage.kt:28-137`）是 sealed class + 每个语言一组 token：

```kotlin
object ChineseSimplified : Chinese("CHS", "简中")   // tokens: 简中, GB, GBK, 简体中文, 中文, 中字, 簡, 简, CHS, Zh-Hans, Zh_Hans, zh_cn, zh
object ChineseTraditional : Chinese("CHT", "繁中")  // 繁中, BIG5, BIG 5, 繁, Chinese, CHT, TC
object ChineseCantonese  : Chinese("CHC", "粤语")
object Japanese : SubtitleLanguage("JPN", "日语")
object English  : SubtitleLanguage("ENG", "英语")
```

注意 `ChineseSimplified.matches` 里有一句 `if (text.contains("繁體中文")) return false`（`:64`）—— 因为 token `"中文"` 会误命中。这类补丁在移植时要保留。

---

### 1.7 App 领域模型

#### `SubjectInfo`（`APP/data/models/subject/SubjectInfo.kt:16-96`）

```kotlin
@Immutable @Serializable
data class SubjectInfo(
    val id: Int = 0,
    val name: String = "",            // 原文名(日文)
    val nameCn: String = "",
    val summary: String = "",
    val nsfw: Boolean = false,
    val locked: Boolean = false,
    val platform: String = "",        // TV/Web/欧美剧/PS4...
    val volumes: Int = 0,             // 书籍册数
    val eps: Int = 0,                 // 旧服务端从 wiki 解析; 书籍为话数
    val totalEpisodes: Int = 0,       // 数据库中的章节数量
    val tags: List<Tag> = emptyList(),// must be sorted by count
    val airDateString: String? = null,// "YYYY-MM-DD"
    val infobox: List<InfoboxItem> = emptyList(),
    val imageCommon: String = "",
    val imageLarge: String,
    val collection: SubjectCollectionStats = SubjectCollectionStats.Zero,
    val ratingInfo: RatingInfo,
) {
    val airDate: PackedDate                    // 解析 airDateString
    val completeDate: PackedDate               // 从 infobox「播放结束/放送结束」解析
    val displayName: String get() = nameCn.takeIf { it.isNotBlank() } ?: name
    val allNames: List<String>                 // nameCn, name, 以及 infobox 别名 (lazy)
}
```

派生函数：`findInfoboxValue(key)`（`:99`）、`nameCnOrName`（`:102`）、`totalEpisodesOrEps`（`:104-110`）。

`Tag(name, count)`、`InfoboxItem(name, values: List<String>)`（`valueOrNull` = 第一个）。

> **移植要点**：`allNames` 是「数据源搜索的输入」，中文名 + 日文名 + 全部别名。别名来自 Bangumi infobox，这是「站点标题对齐」的第一层武器。

#### `EpisodeInfo`（`APP/data/models/episode/EpisodeInfo.kt:15-38`）

```kotlin
@Immutable @Serializable
data class EpisodeInfo(
    val id: Int,
    val type: EpisodeType? = EpisodeType.MainStory,  // Bangumi: 0 本篇 1 SP 2 OP 3 ED
    val name: String = "",
    val nameCn: String = "",
    val airDate: PackedDate = PackedDate.Invalid,
    val comment: Int = 0,
    val duration: String = "",        // 维基人填的原始时长(字符串!)
    val desc: String = "",
    val disc: Int = 0,
    val sort: EpisodeSort = EpisodeSort(""),  // 系列内序号
    val ep: EpisodeSort? = null,              // 条目内序号, 从 1 开始
)
val EpisodeInfo.displayName get() = nameCn.ifBlank { name }
val EpisodeInfo.isKnownCompleted: Boolean get() = airDate.isValid && airDate <= PackedDate.now()
val EpisodeInfo.isKnownOnAir: Boolean get() = airDate.isValid && airDate > PackedDate.now()
```

Bangumi DTO → `EpisodeInfo`（`APP/data/repository/BangumiEpisodeRepository.kt:154-169`）：

```kotlin
EpisodeInfo(
    id = this.id,
    type = getEpisodeTypeByBangumiCode(this.type),
    name = this.name, nameCn = this.nameCn,
    airDate = PackedDate.parseFromDate(this.airdate),
    comment = this.comment, duration = this.duration, desc = this.desc, disc = this.disc,
    sort = EpisodeSort(this.sort),                 // BigNum -> EpisodeSort
    ep = EpisodeSort(this.ep ?: BigNum.ONE),       // 缺失时兜底 1
)
```

> 注意 `EpisodeSort(this.sort)` 用的是 **String 重载**？不是 —— `this.sort` 是 `BigNum`，所以走 `EpisodeSort(int: BigNum, type: EpisodeType? = MainStory)`。而 `toEpisodeInfo` 在 **Detail** 版本（`:183-197`）里改用了 `EpisodeSort(this.sort, getEpisodeTypeByBangumiCode(this.type))`，两个 mapper 行为**不一致**（列表版忽略 type，详情版把 type 写进 Special）。这是一个值得注意的「疑似 bug / 历史遗留」，移植时统一成一种。

#### `EpisodeCollection`（`APP/data/models/episode/EpisodeCollection.kt:12-18`）

```kotlin
@Serializable @Immutable
data class EpisodeCollection(val episodeInfo: EpisodeInfo, val collectionType: UnifiedCollectionType)
inline val EpisodeCollection.episode get() = episodeInfo
inline val EpisodeCollection.type get() = collectionType
```

#### `UnifiedCollectionType`（`DS/api/src/commonMain/kotlin/topic/UnifiedCollectionType.kt:9-31`）

```kotlin
@Serializable          // so don't change field names
enum class UnifiedCollectionType { WISH, DOING, DONE, ON_HOLD, DROPPED, NOT_COLLECTED }
fun UnifiedCollectionType.isDoneOrDropped(): Boolean = this == DONE || this == DROPPED
```

Bangumi 映射（`DS/bangumi/src/commonMain/kotlin/processing/SubjectCollectionTypes.kt:8-48`）：

| Unified | Bangumi SubjectCollectionType | Bangumi EpisodeCollectionType |
|---|---|---|
| WISH | Wish | WATCHLIST |
| DOING | Doing | WATCHLIST |
| DONE | Done | WATCHED |
| ON_HOLD | OnHold | WATCHLIST |
| DROPPED | Dropped | DISCARDED |
| NOT_COLLECTED | null（走 delete） | NOT_COLLECTED |

#### `SubjectCollection`（`APP/data/models/subject/SubjectCollection.kt:16-49`）

```kotlin
@Immutable @Serializable
data class SubjectCollection(
    val info: SubjectInfo,
    val episodes: List<EpisodeCollection>,   // must be sorted by sort
    val collectionType: UnifiedCollectionType,
    val selfRatingInfo: SelfRatingInfo,      // 未收藏时 SelfRatingInfo.Empty
) {
    val displayName: String get() = info.displayName
    val subjectId: Int get() = info.id
    val date get() = renderSubjectSeason(info.airDate)
    @Transient val airingInfo: SubjectAiringInfo = computeFromEpisodeList(episodes.map { it.episode }, info.airDate)
    @Transient val progressInfo: SubjectProgressInfo = SubjectProgressInfo.calculate(this)
}
```

源码注释自带吐槽：`// TODO: this is very shit, do not store them all together`（`:17`）。**但它确实被整体 JSON 序列化持久化了**（见 §6）。

> `episodes` 注释写「must be sorted by sort」，但**代码里没有任何排序**：`fetchEpisodeCollections` 直接按 API 返回顺序 map（`APP/data/models/subject/SubjectManager.kt:560-572`）。Bangumi 的 `/v0/episodes` 默认按 `sort` 升序返回，所以通常没问题。移植时建议显式 `sort` 排序，否则「下一集」在某些条目上会错。

#### `SubjectProgressInfo`（`APP/data/models/subject/SubjectProgressInfo.kt:20-189`）

```kotlin
@Immutable
data class SubjectProgressInfo(
    val continueWatchingStatus: ContinueWatchingStatus,
    val nextEpisodeIdToPlay: Int?,     // 供 UI 点击跳转
)
sealed class ContinueWatchingStatus {
    data object Start
    data class NotOnAir(val airDate: PackedDate)
    data class Continue(val episodeIndex: Int, val episodeSort: EpisodeSort?, val watchedEpisodeSort: EpisodeSort)
    data class Watched(val episodeIndex: Int, val episodeSort: EpisodeSort?, val nextEpisodeAirDate: PackedDate)
    data object Done
}
```

计算逻辑（`:70-149`）：

```
lastWatchedEpIndex = episodes.indexOfLast { type == DONE || type == DROPPED }
latestEp = episodes.lastOrNull { isKnownCompleted }
actualSubjectStarted = latestEp != null || subjectStarted
when (lastWatchedEpIndex) {
    -1 -> if (actualSubjectStarted) Start else NotOnAir(subjectAirDate 或第一集 airDate)
    in 0..size-2 -> if (lastWatched < latestEp 且已开播) Continue(lastWatched+1, next.sort, watched.sort)
                    else Watched(lastWatched, watched.sort, next.airDate)
    else -> Done          // 看了最后一集
}
nextEpisodeIdToPlay =
    if (status is Watched) episodes[status.episodeIndex]
    else lastWatched+1 ?: lastWatched ?: firstOrNull
```

UI 文案映射在 `APP/ui/subject/collection/progress/SubjectProgressState.kt:112-139`：「继续观看 02」/「已看完」/「周三开播」/「开始观看」/「周三更新」。

**这就是本快照的「继续观看」：完全由 Bangumi 的每集 DONE 状态推导，没有「看到 12:34」这种秒级进度。**

#### `SubjectAiringInfo`（`APP/data/models/subject/SubjectAiringInfo.kt:21-151`）

```kotlin
@Immutable
data class SubjectAiringInfo(
    val kind: SubjectAiringKind,      // UPCOMING / ON_AIR / COMPLETED
    val episodeCount: Int,
    val airDate: PackedDate,
    val firstSort: EpisodeSort?,
    val latestSort: EpisodeSort?,     // 已播出的最新一集
    val upcomingSort: EpisodeSort?,
)
```

`computeFromEpisodeList`（`:61-89`）的判定顺序：

```
if (list.isEmpty()) UPCOMING
else if (all isKnownCompleted) COMPLETED
else if (all isKnownOnAir) UPCOMING
else if (any isKnownCompleted) ON_AIR
else if (airDate.isValid) {
    if (airDate <= now) COMPLETED
    if (now - airDate > 10年) COMPLETED   // 一些老番缺失信息
    else UPCOMING
}
else UPCOMING
```

「完结」判定还有一层（`APP/data/models/episode/EpisodeCollections.kt:9-21`）：所有集都 `isKnownCompleted` **且** 最后一集 airDate 距今 ≥ **14 天**。这个 14 天阈值直接影响「完结番隐藏单集资源」的开关，值得照抄。

#### `EpisodeProgressInfo`（`APP/data/models/episode/EpisodeProgressInfo.kt:6-10`）

```kotlin
class EpisodeProgressInfo(
    val episode: EpisodeInfo,
    val collectionType: UnifiedCollectionType,
    val cacheStatus: EpisodeCacheStatus,
)
```

由 `SubjectManager.subjectProgressFlow` 组装（`SubjectManager.kt:344-371`）：对每个 episode 并发 `cacheManager.cacheStatusForEpisode(...)`，`onStart { emit(NotCached) }`。

---

### 1.8 偏好与选择器设置

#### `MediaPreference`（`APP/ui/subject/episode/mediaFetch/MediaPreference.kt:16-94`）

```kotlin
@Immutable @Serializable
data class MediaPreference @SerializationOnly constructor(
    val alliance: String? = null,                 // 精确匹配字幕组
    val alliancePatterns: List<String>? = null,    // 精确失败则用正则, 选首个匹配
    val resolution: String? = null,
    val fallbackResolutions: List<String>? = listOf("2160P","1440P","1080P","720P"),
    val subtitleLanguageId: String? = null,
    val fallbackSubtitleLanguageIds: List<String>? = listOf("CHS","CHT"),
    val showWithoutSubtitle: Boolean = false,
    val mediaSourceId: String? = null,
    @Deprecated("Only for migration") val fallbackMediaSourceIds: List<String>? = null,
) {
    companion object {
        val PlatformDefault = MediaPreference()
        val Empty = MediaPreference(mediaSourceId = null, fallbackSubtitleLanguageIds = null, fallbackResolutions = null)
    }
    fun merge(other: MediaPreference): MediaPreference   // other 优先, Empty 视为「无」
}
```

三级来源：**本次会话覆盖** > **该 subject 保存的偏好**（`preferredAllianceStore`）> **全局默认**（`preferencesStore` 的 `defaultMediaPreference`）。

#### `MediaSelectorSettings`（`APP/data/models/preference/MediaSelectionSeetings.kt:16-52`）

```kotlin
@Serializable @Immutable
data class MediaSelectorSettings(
    val showDisabled: Boolean = true,                 // 禁用的源在选择器里灰显
    val hideSingleEpisodeForCompleted: Boolean = true,// 完结后隐藏单集资源
    val preferSeasons: Boolean = true,                // 优先季度全集
    val autoEnableLastSelected: Boolean = true,       // @since 3.2.0-beta04
    val preferKind: MediaSourceKind? = null,          // @since 3.5, 优先在线源
) { companion object { val Default = MediaSelectorSettings(preferKind = MediaSourceKind.WEB) } }
```

注意：**新用户默认 `preferKind = WEB`（优先在线源），老用户为 null**。这个「按安装时间给不同默认值」的迁移策略值得记下。

#### `MediaSelectorContext`（`APP/data/source/media/selector/MediaSelectorContext.kt:10-39`）

```kotlin
data class MediaSelectorContext(
    val subjectFinished: Boolean?,                          // null = 还在查
    val mediaSourcePrecedence: List<String>?,               // 自动选择时的数据源顺序; null = 无偏好
    val subtitlePreferences: MediaSelectorSubtitlePreferences?,
) {
    fun allFieldsLoaded() = subjectFinished != null && mediaSourcePrecedence != null && subtitlePreferences != null
    companion object { val Initial = MediaSelectorContext(null, null, null) }
}
```

`createFlow` 会 `onStart { emit(Initial) }`，注释：「否则如果一直没获取到剧集信息，就无法选集，#385」（`:56-58`）。**这是一个真实的坑：如果等所有字段加载完再 emit，选集会卡死。**

#### `MediaSelectorSubtitlePreferences`（`APP/data/source/media/selector/MediaSelectorSubtitlePreferences.kt:19-105`）

```kotlin
value class MediaSelectorSubtitlePreferences(val values: EnumMap<SubtitleKind, SubtitleKindPreference>)
enum class SubtitleKindPreference { NORMAL, LOW_PRIORITY, HIDE }

fun forPlatform(platform): MediaSelectorSubtitlePreferences = when (platform) {
    MacOS   -> EMBEDDED=NORMAL, CLOSED=HIDE, EXTERNAL_PROVIDED=NORMAL, EXTERNAL_DISCOVER=HIDE, CLOSED_OR_EXTERNAL_DISCOVER=HIDE
    Windows -> EMBEDDED=NORMAL, CLOSED=NORMAL, EXTERNAL_PROVIDED=NORMAL, EXTERNAL_DISCOVER=HIDE, CLOSED_OR_EXTERNAL_DISCOVER=NORMAL
    Android -> EMBEDDED=NORMAL, CLOSED=LOW_PRIORITY, EXTERNAL_PROVIDED=NORMAL, EXTERNAL_DISCOVER=HIDE, CLOSED_OR_EXTERNAL_DISCOVER=NORMAL
    Ios     -> 全 NORMAL
}
```

#### `VideoScaffoldConfig`（`APP/data/models/preference/VideoScaffoldConfig.kt:28-67`）

```kotlin
@Serializable @Immutable
data class VideoScaffoldConfig(
    val fullscreenSwitchMode: FullscreenSwitchMode = AUTO_HIDE_FLOATING,
    val pauseVideoOnEditDanmaku: Boolean = currentPlatform.isMobile(),
    val autoMarkDone: Boolean = true,             // 看到 90% 自动标记看过
    val hideSelectorOnSelect: Boolean = false,
    val autoFullscreenOnLandscapeMode: Boolean = false,
    val autoPlayNext: Boolean = false,            // 自动连播 —— 默认关!
    val autoSkipOpEdExperimental: Boolean = false,
)
```

---

### 1.9 缓存元数据

#### `MediaCacheMetadata`（`DS/api/src/commonMain/kotlin/MediaCacheMetadata.kt:19-145`）

```kotlin
@Serializable
data class MediaCacheMetadata(
    @SerialName("subjectId") private val _subjectId: String? = null,
    @SerialName("episodeId") private val _episodeId: String? = null,
    val subjectNameCN: String? = null,
    val subjectNames: Set<String>,
    val episodeSort: EpisodeSort,
    val episodeEp: EpisodeSort? = episodeSort,
    val episodeName: String,
    val extra: Map<MetadataKey, String> = emptyMap(),   // 引擎自定义, 例如磁力链
) {
    val subjectId get() = _subjectId ?: "0"    // 兼容旧版(<3.8)缓存
    val episodeId get() = _episodeId ?: "0"
    companion object { val KEY_CREATION_TIME = MetadataKey("creationTime") /* @since 3.8 */ }
}
```

**为什么用私有 `_subjectId` + `@SerialName`**：为了在老版本数据缺字段时返回 `"0"` 而不是抛异常。这是典型的「前向/后向兼容」手法，TS 里对应「optional 字段 + getter 兜底」。

#### `MediaCache`（`APP/data/source/media/cache/MediaCache.kt:30-275`）

```kotlin
interface MediaCache {
    val cacheId: String get() = calculateCacheId(origin.mediaId, metadata)
    val origin: Media
    val metadata: MediaCacheMetadata
    val state: StateFlow<MediaCacheState>
    suspend fun getCachedMedia(): CachedMedia
    fun isValid(): Boolean
    val fileStats: Flow<FileStats>
    data class FileStats(val totalSize: FileSize, val downloadedBytes: FileSize, val downloadProgress: Progress)
    data class SessionStats(...)   // 含上传
}
```

缓存目录：`<dataDir>/media-cache/<engineId>/`（`APP/platform/CommonKoinModule.kt:167-168`），元数据是 JSON 文件，存储实现 `DirectoryMediaCacheStorage`。local cache 数据源的 id 是 **`"local-file-system"`**（`APP/data/source/media/cache/MediaCacheManager.kt:118`），debug 版还会加一个 `"test-in-memory"`。

---

## 2. 数据源体系

### 2.1 从 SPI 到运行时实例

#### 注册方式（无配置文件，纯编译期）

在**每个数据源模块**的 `resources/META-INF/services/` 下放一个文件，文件名是接口全限定名，内容是工厂类全限定名：

```
data-sources/bt/dmhy/resources/META-INF/services/me.him188.ani.datasources.api.source.MediaSourceFactory
→ me.him188.ani.datasources.dmhy.DmhyMediaSource$Factory
```

现有的 SPI 文件清单（`Get-ChildItem` 实测）：

| 接口 | 模块 |
|---|---|
| `...source.MediaSourceFactory` | `bt/acg.rip`、`bt/dmhy`、`bt/mikan`、`ikaros`、`jellyfin`、`web/gugufan`、`web/mxdongman`、`web/ntdm`、`web/nyafun`、`web/xfdm` |
| `...matcher.WebVideoMatcher` | `web/gugufan`、`web/mxdongman`、`web/ntdm`、`web/nyafun`、`web/xfdm` |
| `...subject.SubjectProvider` | `bangumi` |

加载代码（`APP/data/source/media/fetch/MediaSourceManager.kt:141-146`）：

```kotlin
private val factories: List<MediaSourceFactory> = buildSet {
    addAll(ServiceLoader.loadServices(MediaSourceFactory::class))
    add(MikanMediaSource.Factory())       // Kotlin bug, MPP 加载不了 resources
    add(MikanCNMediaSource.Factory())
    add(RssMediaSource.Factory())
}.toList()
```

注释坦白说明：Mikan 与 RSS 是**手动补注册**的（MPP 资源加载有 bug）。移植到 TS 就是「一个 `registry.ts` 显式 import 所有工厂」。

#### 实例的生命周期（`MediaSourceManagerImpl`，`MediaSourceManager.kt:121-247`）

```kotlin
override val allInstances =
    combine(instances.flow, proxyConfig.map { it.default }.distinctUntilChanged()) { saves, config ->
        // 一定要 additionalSources 在前面, local sources 需要优先使用
        this.additionalSources + saves.mapNotNull { createInstance(it, config) }
    }.onReplacement { list -> list.forEach { it.close() } }   // 旧实例自动 close
     .flowOn(flowCoroutineContext).shareIn(scope, replay = 1, started = SharingStarted.Lazily)
```

要点：

- `additionalSources` = 本地缓存源（`MediaCacheManager.storagesIncludingDisabled.map { it.cacheMediaSource }`），**永远排在最前**，因为本地缓存要优先。
- **代理设置变化会重建所有实例**（`proxyConfig` 参与 `combine`），旧实例 `close()`。
- `factory.create(config, mediaSourceId, config)` 在 `MediaSourceFactory.create(mediaSourceId, config)` 外面多包了一层：注入全局代理 + `getAniUserAgent()`（`MediaSourceManager.kt:228-242`）。
- UA 是 `open-ani/ani/<version> (<platform>) (https://github.com/open-ani/ani)`（`APP/platform/CommonKoinModule.kt:296-299`）。

#### 默认启用的数据源（`APP/data/repository/MediaSourceInstanceRepository.kt:36-62`）

```kotlin
val Default: MediaSourceSaves by lazy {
    val enabledWebSources = listOf("nyafun", "mxdongman", "ntdm", "gugufan", "xfdm")
    val enabledBtSources  = listOf(MikanCNMediaSource.ID /* "mikan-mikanime-tv" */, "dmhy")
    val disabledBtSources = listOf()
    MediaSourceSaves(buildList {
        enabledWebSources.forEach { add(createSave(it, FactoryId(it), isEnabled = true)) }
        enabledBtSources.forEach { add(...isEnabled = true) }
        disabledBtSources.forEach { add(...isEnabled = false) }
    })
}
```

**注意 `mikan`（mikanani.me）默认没启用，启用的是 `mikan-mikanime-tv`（中国大陆镜像）。** 这是很实用的运营细节。

每个 save 的 `instanceId = Uuid.randomString()`（不是 mediaSourceId），所以删除/重建会换 id。

#### 数据源类型枚举（`DS/api/src/commonMain/kotlin/source/MediaSourceKind.kt:13-44`）

```kotlin
@Serializable
enum class MediaSourceKind {
    WEB,          // 资源为 WebVideo 或 HttpStreamingFile; 完结番的单集不会被过滤
    BitTorrent,   // 资源为 HttpTorrentFile 或 MagnetLink; 完结番单集会因默认设置被过滤
    LocalCache;   // 总是显示, 忽略一切过滤
    companion object { val selectableEntries = listOf(WEB, BitTorrent) }
}
```

`MediaSourceLocation`（`MediaSourceLocation.kt:14-61`）：`Online` / `Lan` / `Local`，带自定义字符串序列化（`"ONLINE"|"LAN"|"LOCAL"`）与 `isLowEffort()`（Lan/Local）。`Lan` 用于 NAS。

---

### 2.2 三类数据源的实现骨架

#### (a) BT 型：`TopicMediaSource`（`DS/api/src/commonMain/kotlin/source/TopicMediaSource.kt:17-39`）

```kotlin
abstract class TopicMediaSource : HttpMediaSource() {
    override val location = MediaSourceLocation.Online
    override val kind = MediaSourceKind.BitTorrent

    protected abstract suspend fun startSearch(query: DownloadSearchQuery): SizedSource<Topic>

    final override suspend fun fetch(query: MediaFetchRequest): SizedSource<MediaMatch> {
        return query.subjectNames.map { name ->
            startSearch(DownloadSearchQuery(
                keywords = name,
                category = TopicCategory.ANIME,
                episodeSort = query.episodeSort,
                episodeEp = query.episodeEp,
            )).map { MediaMatch(it.toOnlineMedia(mediaSourceId), MatchKind.FUZZY) }
        }.merge()
    }
}

data class DownloadSearchQuery(
    val keywords: String,
    val category: TopicCategory? = null,
    val alliance: Alliance? = null,
    val ordering: SearchOrdering? = null,
    val episodeSort: EpisodeSort? = null,
    val episodeEp: EpisodeSort? = null,
    val allowAny: Boolean = false,      // 覆盖设置, 直接返回全部结果不做集匹配
)
```

**关键设计：`fetch` 对 `subjectNames` 里的每个名字各查一次，然后 `merge()` 多个 `SizedSource`。** 这意味着一次播放会对同一个 BT 站点发 N 次请求（N = 别名数量，通常 2~4）。这是「宁多勿少」的召回策略，代价是请求量。

#### (b) Web 型：`ThreeStepWebMediaSource`（`DS/web/web-base/src/TreeStepWebMediaSource.kt:27-140`）

```kotlin
abstract class ThreeStepWebMediaSource : WebMediaSource() {   // WebMediaSource 只是 kind = WEB
    data class Bangumi(val internalId: String, val name: String, val url: String)
    data class Ep(val name: String, val url: String, val channel: String? = null)  // channel = 线路

    abstract val baseUrl: String                                   // 无结尾 '/'
    abstract fun parseBangumiSearch(document: Document): List<Bangumi>
    abstract suspend fun search(name: String, query: MediaFetchRequest): List<Bangumi>
    abstract fun parseEpisodeList(document: Document): List<Ep>
    protected abstract val client: HttpClient

    fun createMediaMatch(bangumi: Bangumi, ep: Ep): MediaMatch
    private fun isPossiblyMovie(title: String): Boolean
    override suspend fun checkConnection(): ConnectionStatus
    final override suspend fun fetch(query: MediaFetchRequest): SizedSource<MediaMatch>
}
```

**这就是「web-selector 的前身」**：三个抽象方法对应未来的三个 selector 段（`subjectFormat` / `channelFormat` / `matchVideo`）。继承它的有 **4 个**类：`gugufan`、`mxdongman`、`ntdm`、`xfdm`；只有 `nyafun` 是独立实现（直接 `HttpMediaSource`），把同样的三段逻辑全内联在自己身上。

`createMediaMatch`（`:54-92`）是 web 源资源对象的唯一标准构造方式：

```kotlin
fun createMediaMatch(bangumi: Bangumi, ep: Ep): MediaMatch {
    val sort = EpisodeSort(ep.name.removePrefix("第").removeSuffix("集"))
    val suffixChannel = ep.channel?.let { "-$it" }
    return MediaMatch(
        DefaultMedia(
            mediaId = "$mediaSourceId.${bangumi.internalId}-${sort}$suffixChannel",
            mediaSourceId = mediaSourceId,
            originalUrl = bangumi.url,
            download = ResourceLocation.WebVideo(ep.url),
            originalTitle = """${bangumi.name} ${ep.name} ${ep.channel.orEmpty()}""".trim(),
            publishedTime = 0L,
            properties = MediaProperties(
                subtitleLanguageIds = subtitleLanguages,   // 固定 listOf("CHS")
                resolution = "1080P",                      // 固定谎报 1080P
                alliance = mediaSourceId,                  // 字幕组 = 数据源 id
                size = FileSize.Unspecified,
                subtitleKind = SubtitleKind.EMBEDDED,      // 固定内嵌
            ),
            episodeRange = EpisodeRange.single(
                if (isPossiblyMovie(ep.name) && sort is EpisodeSort.Special) EpisodeSort(1) else sort
            ),
            location = MediaSourceLocation.Online,
            kind = MediaSourceKind.WEB,
        ),
        MatchKind.FUZZY,
    )
}
```

`isPossiblyMovie`（`:89-92`）是个 hack：标题含「简/繁」**且**含某个分辨率字符串 → 当电影处理，强制集号 01。因为它假设剧场版的名字里常带分辨率标注。

#### (c) 播放地址解析器（平台层，不在数据源里）

见 §2.5 与 §5。

---

### 2.3 「订阅文件结构」在本版本的真实形态

> **结论：本快照不存在 `schemaVersion`/`mediaSources`/`searchConfig` 这类订阅 JSON。** 下面给出它当时的等价物，因为这是移植时必须先决定「用哪种」的地方。

#### (a) 本地数据源配置存储 = `MediaSourceSaves`

持久化位置：DataStore 文件 **`mediaSourceSaves`**（`APP/data/persistent/SettingsStore.kt:54-63`），序列化器 `MediaSourceSaves.serializer()`，损坏时回退 `MediaSourceSaves.Default`。

磁盘 JSON 结构（由 `@Serializable` 派生，字段名即属性名）：

```json
{
  "instances": [
    {
      "instanceId": "0f3c…uuid",
      "mediaSourceId": "nyafun",
      "factoryId": "nyafun",
      "isEnabled": true,
      "config": {
        "proxy": null,
        "userAgent": null,
        "arguments": { }
      }
    }
  ]
}
```

对应类型（`APP/data/repository/MediaSourceInstanceRepository.kt:30-64` + `APP/data/source/media/instance/MediaSourceInstance.kt:35-52`）：

```kotlin
@Serializable data class MediaSourceSaves(val instances: List<MediaSourceSave> = emptyList())
@Serializable data class MediaSourceSave(
    val instanceId: String,
    val mediaSourceId: String,
    val factoryId: FactoryId = FactoryId(mediaSourceId),
    val isEnabled: Boolean,
    val config: MediaSourceConfig,
)
```

**没有 `schemaVersion`、没有 `version`、没有 `tags`、没有 `tier`、没有选择器。** 升级兼容靠 `ignoreUnknownKeys = true`（`SettingsRepository.kt:81-83` 的 `Json { ignoreUnknownKeys = true }`）与 Kotlin 默认值。

#### (b) 工厂参数 schema = `MediaSourceParameters`

以 `RssMediaSource` 为例（`APP/data/source/media/source/RssMediaSource.kt:48-94`）：

```kotlin
object Parameters : MediaSourceParametersBuilder() {
    val name        = string("name", defaultProvider = { "RSS" }, description = "设置显示在列表中的名称")
    val description = string("description", defaultProvider = { "" }, description = "可留空")
    val searchUrl   = string("searchUrl", description = """
        替换规则:
        {keyword} 替换为条目 (番剧) 名称
        {page} 替换为页码, 如果不需要分页则忽略
    """.trimIndent(), placeholder = "例如  https://acg.rip/page/{page}.xml?term={keyword}")
    val iconUrl     = string("iconUrl")
}
class Factory : MediaSourceFactory {
    override val factoryId = FactoryId("rss")
    override val allowMultipleInstances get() = true
    override val parameters = Parameters.build()
}
```

`fetch` 时把 `{keyword}`/`{page}` 替换成真实值（`:126-135`），`usePaging = searchUrl.contains("{page}")`（`:76`）。

**这就是「URL 模板 + 参数」的订阅雏形**，只是模板写在一个 `string` 参数里，而不是结构化的 JSON。移植时把它升级成完整 JSON 是最自然的一步。

#### (c) 其它持久化 store（同一个 `PlatformDataStoreManager`）

`APP/data/persistent/SettingsStore.kt:44-82` 列出了全部 DataStore：

| 属性 | 文件名 | 序列化类型 | 损坏回退 |
|---|---|---|---|
| `mikanIndexStore` | `mikanIndexes` | `MikanIndexes` | `Empty` |
| `mediaSourceSaveStore` | `mediaSourceSaves` | `MediaSourceSaves` | `Default` |
| `danmakuFilterStore` | `danmakuFilter` | `List<DanmakuRegexFilter>` | `emptyList()` |
| `tokenStore` | 平台实现 | `Preferences` | — |
| `preferencesStore` | 平台实现 | `Preferences` | — |
| `preferredAllianceStore` | 平台实现（`preferredAlliances` / `preferredAllianceStore.preferences_pb`） | `Preferences` | — |

---

### 2.4 web 数据源：三段式的真实实现

以 **nyafun** 为例（`DS/web/nyafun/src/NyafunMediaSource.kt`，231 行）。它是五个 web 源里**唯一没有使用 `ThreeStepWebMediaSource` 基类**的，把三段逻辑全部内联，因此最能看清「三段式」的原始形态。

#### 第一段：搜索

```kotlin
// https://www.nyafun.net/search.html?wd=girls%20band%20cry
fun parseBangumiSearch(document: Document): List<NyafunBangumi> =
    document.getElementsByClass("public-list-box").map { element ->
        val a = element.select(".thumb-txt.cor4.hide").select("a")
        val name = a.text()
        val url = a.attr("href")
        val id = url.substringBeforeLast(".html").substringAfterLast("/")
        NyafunBangumi(id = id, name = name, url = BASE_URL + url)
    }
// :95-106
```

请求：`getDocument("$BASE_URL/search.html") { parameter("wd", name) }`（`:186-189`）。

#### 第二段：条目页 → 剧集列表

```kotlin
// https://www.nyafun.net/bangumi/7168.html
fun parseEpisodeList(document: Document): List<NyafunEp> =
    document.getElementsByClass("anthology-list-play").flatMap { element ->
        element.select("a").map { a ->
            val name = a.text()   // "第1集"
            val url = a.attr("href") // "/play/7168-1-1.html"
            NyafunEp(name, BASE_URL + url)
        }
    }
// :109-117
```

**nyafun 没有线路概念**（`Ep.channel` 恒为 null），但 `GugufanMediaSource.parseEpisodeList`（`DS/web/gugufan/src/GugufanMediaSource.kt:95-121`）演示了线路的解析方式：

```kotlin
val channelElements = resourceList.select("div.anthology-tab.nav-swiper.b-b.br div.swiper-wrapper a.swiper-slide")
val channelNames = channelElements.map { e -> e.text().trim().dropLastWhile { it.isDigit() } }  // "线路1" -> "线路"
val episodeElements = resourceList.getElementsByTag("a")
    .filterNot { e -> e.text().dropLastWhile { it.isDigit() } in channelNames }
for ((index, element) in episodeElements.withIndex()) {
    val channel = if (channelNames.isNotEmpty())
        channelNames.getOrNull(index / episodeElements.size * channelNames.size) else null
    ...
}
```

> 最后那行 `index / episodeElements.size * channelNames.size` 是**整数除法**，`index < size` 时恒为 `0`，所以**永远只会用到第一条线路名**。这是一个明显的 bug（本快照的 gugufan 源多线路支持实际是坏的）。移植时不要照抄，应按「每 N 条一组」划分。

#### 第三段：播放页 → `ResourceLocation.WebVideo`

`download = ResourceLocation.WebVideo(ep.url)`，即**只存播放页 URL**，不解析直链（`:65`）。真正解析在播放时由平台 resolver 用 WebView/Selenium 拦截。

#### 三段式的通用编排（`TreeStepWebMediaSource.fetch`，`:105-139`）

```kotlin
override suspend fun fetch(query: MediaFetchRequest): SizedSource<MediaMatch> = SinglePagePagedSource {
    query.subjectNames.asFlow().flatMapMerge { name ->                      // ① 每个别名并发
        val bangumiList = flow { emit(search(name, query)) }
            .retry(3) { e -> logger.warn(e) { "Failed to search using name '$name'" }; true }
            .firstOrNull() ?: return@flatMapMerge emptyFlow()
        bangumiList.asFlow().flatMapMerge { bangumi ->                       // ② 每个条目并发
            flow { emit(client.get(bangumi.url).bodyAsDocument()) }
                .map { parseEpisodeList(it) }
                .retry(3) { e -> logger.warn(e) { "Failed to get episodes using name '$name'" }; true }
                .firstOrNull().orEmpty()
                .asSequence().map { ep -> createMediaMatch(bangumi, ep) }
                .filter { it.definitelyMatches(query) || isPossiblyMovie(it.media.originalTitle) }
                .toList()
                .asFlow()
        }
    }
}
```

要点：

1. `flatMapMerge` 默认并发 16（Kotlin Flow 的 `DEFAULT_CONCURRENCY`）。
2. 每段 `retry(3)`，永久返回 `true`（**无限重试到 3 次**），失败后返回空而不是抛出。
3. **注意 `.firstOrNull()` 在 `retry` 之后**：`retry` 是无限重试的写法这里其实是 3 次。
4. **过滤在源内部完成**：`definitelyMatches(query)`（集号匹配）或「像电影」。这与 §0.3 结论 4 一致。
5. 日志里记录了 fetch 到的集数（`:135`）。

---

### 2.5 `WebVideoMatcher`：`matchVideo` 的前身

`DS/api/src/commonMain/kotlin/matcher/WebVideoMatcher.kt`：

```kotlin
interface WebVideoMatcher {           // SPI service load
    fun match(url: String, context: WebVideoMatcherContext): WebVideo?
}
class WebVideoMatcherContext(val media: Media)

data class WebVideo(
    val m3u8Url: String,
    val headers: Map<String, String>,   // 建议提供 User-Agent, Referer
)
```

每个 web 源模块提供一个实现，只处理自己源的 URL。nyafun 版（`NyafunMediaSource.kt:59-81`）：

```kotlin
class NyafunWebVideoMatcher : WebVideoMatcher {
    override fun match(url: String, context: WebVideoMatcherContext): WebVideo? {
        if (context.media.mediaSourceId != NyafunMediaSource.ID) return null
        // https://vod.2bdm.cc/2024/04/gs8h/01.mp4?verify=1716675316-...
        if ((url.contains(".mp4") || url.contains(".mkv") || url.contains(".m3u8")) && url.contains("verify=")) {
            return WebVideo(url, mapOf(
                "User-Agent" to """Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/58.0.3029.110 Safari/537.3""",
                "Referer" to "https://play.nyafun.net/",
                "Sec-Ch-Ua-Mobile" to "?0", "Sec-Ch-Ua-Platform" to "macOS",
                "Sec-Fetch-Dest" to "video", "Sec-Fetch-Mode" to "no-cors", "Sec-Fetch-Site" to "cross-site",
            ))
        }
        return null
    }
}
```

Gugufan 版（`DS/web/gugufan/src/GugufanMediaSource.kt:21-41`）用的是 `url.startsWith("https://fuckjapan.cindiwhite.com") && url.contains("index.m3u8")` + `Origin`。

**这是「URL 正则 + 必需请求头」的硬编码版 `matchVideo`。** 最新 animeko 把它抽象成配置里的 `matchVideoUrl` 正则（见 §8）。

---

### 2.6 搜索 → 详情 → 播放地址：两条完整调用链

#### 链 A：Web 源

```
① UI 需要资源
   EpisodeViewModel.mediaFetchSession = episodeInfo.flatMapLatest { ... mediaSourceManager.createFetchFetchSessionFlow(requestFlow) }
        └ APP/ui/subject/episode/EpisodeViewModel.kt:229-239
② 会话
   MediaSourceManager.createFetchFetchSessionFlow = mediaFetcher.map { it.newSession(requestLazy) }
        └ MediaSourceManager.kt:118-119   /   CommonKoinModule 注入
③ 每源一个 MediaSourceResultImpl
   MediaSourceMediaFetcher.MediaFetchSessionImpl(mediaSourceResults = mediaSources.map { instance -> ... })
        └ MediaFetcher.kt:291-307
   pagedSources = request.map { instance.source.fetch(it) }
④ 源实现: NyafunMediaSource.fetch
   subjectNames -> 搜索页 -> parseBangumiSearch -> 条目页 -> parseEpisodeList
                -> createMediaMatch -> filter(definitelyMatches || isMovie)
        └ NyafunMediaSource.kt:182-221
⑤ 累计 + 全局去重
   combine(所有 results) -> flatten -> distinctBy { it.mediaId }
        └ MediaFetcher.kt:309-314
⑥ 选择器过滤/排序/自动选择
   DefaultMediaSelector.mediaList / filteredCandidates / trySelectDefault
        └ MediaSelector.kt:196-256, 375-539
⑦ 播放: 解析
   PlayerLauncher: mediaSelector.selected -> videoSourceResolver.resolve(media, EpisodeMetadata)
        └ PlayerLauncher.kt:70-136
⑧ Web resolver: Selenium/WebView 打开 WebVideo.uri, 拦截网络请求
   matchers.firstNotNullOfOrNull { it.match(url, WebVideoMatcherContext(media)) }
        └ app/shared/src/desktopMain/kotlin/data/source/media/resolver/DesktopWebVideoSourceResolver.kt:57-80
⑨ HttpStreamingVideoSource(m3u8Url, originalTitle, webVideo, extraFiles) -> PlayerState.setVideoSource
```

#### 链 B：BT 源（Mikan 作为最复杂示例）

```
① 同上 ①~③
② AbstractMikanMediaSource.fetch  (DS/bt/mikan/src/commonMain/kotlin/MikanMediaSource.kt:154-163)
   try { searchByIndexOrNull(query) } catch { null } ?: searchByKeyword(query)
③ 索引路径（精确）: searchByIndexOrNull  (:184-206)
   a. indexCacheProvider.getMikanSubjectId(bangumiSubjectId)     ← 本地缓存
   b. 否则对每个 subjectName: GET /Home/Search?searchstr=<name去空格前19字>
   c. 解析候选 mikanId, 并发(4)打开 /Home/Bangumi/<id>, 从页面找「Bangumi番组计划链接：」
      -> 得到该 mikan 条目的 bangumi subjectId, 与我们的 subjectId 比对; 命中即用
      -> 写入 indexCacheProvider
   d. GET /RSS/Bangumi?bangumiId=<id> -> parseRssTopicList(allowEpMatch = true) -> MatchKind.EXACT
④ 关键字路径（模糊）: searchByKeyword  (:165-175)
   GET /RSS/Search?searchstr=<subjectNameCN 前10字> -> parseRssTopicList(allowEpMatch = false) -> FUZZY
⑤ 解析 RSS: parseDocument (:246-280)
   <item> -> title / pubDate(HTTP 日期, +08:00) / guid / enclosure@url -> HttpTorrentFile / contentLength -> FileSize
   alliance = title 按 "]" "】" 切第一段
   details = RawTitleParser.getDefault().parse(title, null).toTopicDetails()
⑥ TopicCriteria 过滤 (matches) -> Map<MediaMatch(FUZZY|EXACT)>
⑦ 聚合/选择同链 A ⑤⑥
⑧ 播放解析 TorrentVideoSourceResolver.resolve
   downloader.fetchTorrent(location.uri)  // magnet 或 .torrent URL
   -> TorrentVideoSource(engine, encodedTorrentInfo, episodeMetadata, extraFiles)
        └ APP/data/source/media/resolver/TorrentVideoSourceResolver.kt:37-70
⑨ open(): startDownload(...).getFiles() -> selectVideoFileEntry(...) -> createHandle().resume(HIGH)
        └ 同上 :179-214
```

**Mikan 的「索引对齐」是这套系统里唯一真正的「站点条目 ↔ Bangumi 条目」双向对齐**，非常值得移植（见 §3.3）。

#### 失败处理总表

| 阶段 | 失败形态 | 处理 | 依据 |
|---|---|---|---|
| web 搜索 / 条目页 | 任意异常 | `retry(3)`，3 次后 `firstOrNull()` 返回 null → 该别名贡献空结果 | `TreeStepWebMediaSource.kt:109-124` |
| web 源 | 集号不匹配 | 源内部 `filter` 丢弃（除非像电影） | `:129-132` |
| 任意源 `fetch` 抛错 | `ServerResponseException` / 其他 | `state = Failed(e, restartCount)`，日志分级；**不影响其它源** | `MediaFetcher.kt:190-205` |
| 整个会话 | 下游 collector 取消 | `state = Abandoned(e, id)` | `MediaFetcher.kt:213-224` |
| 源被禁用 | — | `state = Disabled`，首次查询直接返回空列表，需 `restart()`/`enable()` 才查 | `MediaFetcher.kt:169-170, 272-278` |
| 无可用资源 | `trySelectDefault()` 返回 null | UI 显示「筛选到 0/N 条资源」+ 提供「放宽筛选」 | `MediaSelector.kt:548-557`、`MediaSelectorView.kt:94-99` |
| resolver 不支持 | `UnsupportedMediaException` | `VideoLoadingState.UnsupportedMedia` | `PlayerLauncher.kt:96-99` |
| resolver 超时 | `VideoSourceResolutionException(FETCH_TIMEOUT)` | `ResolutionTimedOut`（"解析超时"） | `PlayerLauncher.kt:120-121` |
| 网络错误 | `NETWORK_ERROR` | `NetworkError`（"网络错误，请检查网络连接状况"） | 同上 |
| 引擎错误 | `ENGINE_ERROR` | `UnknownError(cause)`（可点开看堆栈、可复制） | 同上 + `VideoLoadingState.kt:117-163` |
| 种子内找不到视频文件 | `VideoSourceOpenException(NO_MATCHING_FILE)` | `NoMatchingFile`（"未匹配到文件"） | `TorrentVideoSourceResolver.kt:205-211` |
| 用户换源 | `CancellationException` | `Cancelled`（"已取消"），并 rethrow | `PlayerLauncher.kt:126-128` |

---

### 2.7 分页与并发原语

`DS/api/src/commonMain/kotlin/paging/` 下 5 个文件：

| 类型 / 函数 | 作用 |
|---|---|
| `SizedSource<T>`（`SizedSource.kt:18`） | 资源源接口，`results: Flow<T>` |
| `PagedSource<T> : SizedSource<T>`（`PagedSource.kt:33`） | 可分页的资源源 |
| `SinglePagePagedSource { ... }`（`PageBasedPagedSource.kt:31`，**工厂函数**） | 只有一页（web/BT 源全用它） |
| `PageBasedPagedSource { page -> ... }`（`:71`，**工厂函数**） | 按页拉取，自动翻页 |
| `AbstractPageBasedPagedSource<T>`（`:105`，抽象类） | 上面两个函数的基类，处理页码/`noMorePages()` |
| `Paged<T>` | `total`, `hasMore`, `page: List<T>` |
| `Iterable<SizedSource<T>>.merge()`（`SizedSource.kt:71`） | 合并多个源的结果（`TopicMediaSource.fetch` 用它） |

BT/web 源几乎全部返回 `SinglePagePagedSource { ... }`，即「一次查询完」。这意味着**本快照的 `fetch` 既不真分页也不增量**，全部结果一次返回（Kotlin Flow 里边算边 emit）。

`MediaFetcher` 的流式累积（`MediaFetcher.kt:225-230`）：

```kotlin
runningFold(emptyList<Media>()) { acc, list -> acc + list }
    .map { list -> list.distinctBy { it.mediaId } }
```

所以 UI 会**看到结果逐步出现**（每个源完成一次就 emit 一次），这就是「数据源正在查询 3/7」那种体验的来源。

---

## 3. Bangumi 集成

### 3.1 主机与端点

三个 host（`DS/bangumi/src/commonMain/kotlin/BangumiClient.kt:149-151`）：

```kotlin
private const val BANGUMI_API_HOST = "https://api.bgm.tv"
private const val BANGUMI_NEXT_API_HOST = "https://next.bgm.tv" // dev.bgm38.com for testing
private const val BANGUMI_HOST = "https://bgm.tv"               // 仅用于浏览器打开
```

另外还有一个 **Ani 自建的 OAuth 中转服务**（`currentAniBuildConfig.aniAuthServerUrl`），用于「不把 Bangumi client_secret 放进客户端」的 OAuth 流程（`APP/data/source/AniAuthClient.kt:55-74`）。

#### 实际用到的端点（按功能）

| 功能 | 方法 + 路径 | 代码位置 |
|---|---|---|
| 条目详情 | `GET /v0/subjects/{subject_id}` | `BangumiClientSubjects` / `DefaultApi.getSubjectById`（`gen/.../DefaultApi.kt:1137`） |
| 条目图片 | `GET /v0/subjects/{id}/image?type=large` | `BangumiClient.kt:346-349` |
| 新搜索 | `POST /v0/search/subjects?limit&offset`（body: keyword/sort/filter{type,rank,tag,air_date,rating,nsfw}） | `BangumiClient.kt:253-291` |
| 旧搜索 | `GET /search/subject/{keyword}?type&responseGroup&start&max_results` | `BangumiClient.kt:300-331` |
| 剧集列表 | `GET /v0/episodes?subject_id&type&offset&limit` | `DefaultApi.getEpisodes`（`:524`）、`BangumiEpisodeRepository.kt:80` |
| 剧集详情 | `GET /v0/episodes/{episode_id}` | `DefaultApi.getEpisodeById`（`:413`） |
| 我的收藏（列表） | `GET /v0/users/{username}/collections?subject_type&type&offset&limit` | `getUserCollectionsByUsername`（`:1388`）、`BangumiSubjectRepository.kt:106-111` |
| 我的收藏（单个） | `GET /v0/users/{username}/collections/{subject_id}` | `getUserCollection`（`:1347`）、`BangumiSubjectRepository.kt:128` |
| 我的剧集收藏 | `GET /v0/users/-/collections/{subject_id}/episodes?episode_type&offset&limit` | `getUserSubjectEpisodeCollection`（`:1467`）、`BangumiEpisodeRepository.kt:94-119` |
| 单集收藏 | `GET /v0/users/-/collections/-/episodes/{episode_id}` | `getUserEpisodeCollection`（`:1431`） |
| 改条目收藏 | `POST/PATCH /v0/users/-/collections/{subject_id}` | `postUserCollection`（`:1612`）/`patchUserCollection`（`:1540`） |
| 批量改剧集收藏 | `PATCH /v0/users/-/collections/{subject_id}/episodes` | `patchUserSubjectEpisodeCollection`（`:1576`） |
| 单个剧集收藏 | `PUT /v0/users/-/collections/-/episodes/{episode_id}` | `putUserEpisodeCollection`（`:1648`） |
| 我的信息 | `GET /v0/me` | `BangumiClient.kt:176` |
| 相关人物/角色/关联条目 | `/v0/subjects/{id}/persons`、`/characters`、`/subjects` | `getRelatedPersonsBySubjectId`（`:954`）等 |
| GraphQL | `POST /v0/graphql`（body `{"query": ...}`） | `BangumiClient.kt:162-173`；**实际用于批量取角色/人物的中文名**：`BangumiRelatedCharactersRepository.kt:103-147` 用 `c1: character(id:1) {...}` 之类的**别名批量查询**，一次请求拿 N 个 id 的 infobox |
| next.bgm.tv | `SubjectBangumiNextApi`（剧集评论、吐槽等） | `gen/.../next/apis/SubjectBangumiNextApi.kt`，用于 `CommentRepository` |

`v0.yaml`（OpenAPI 3 描述）是生成 `DefaultApi.kt` 的输入，`p1.yaml` 是另一份（next API）。生成的 `DefaultApi.kt` 有 ~1700 行，方法签名形如：

```kotlin
open suspend fun getEpisodes(subjectId: Int, type: BangumiEpType? = null, offset: Int? = null, limit: Int? = null): HttpResponse<BangumiPagedEpisode>
```

#### 几个必须知道的 API 语义

1. `/v0/episodes` 的 `type` 参数是 `BangumiEpType`（0 本篇 / 1 SP / 2 OP / 3 ED / 4 PV / 5 MAD）。**不传 = 全部类型**。
2. `/v0/users/-/collections/{subjectId}/episodes` 需要登录，未收藏该条目时返回 **404**（代码里显式用 404/401 作为「没有收藏」信号，`BangumiEpisodeRepository.kt:100-107`）。
3. `/v0/users/{username}/collections` 的 `username` 在「查看自己」时也要传，代码里用 `sessionManager.username.first() ?: "-"`，`"-"` 是 Bangumi 的「当前用户」占位符（`BangumiSubjectRepository.kt:128, 145`）。这个用法被标了 `@OptIn(OpaqueSession::class)`，因为它把所有失败都归一化了（`SessionManager.kt:123-129` 的注释专门警告这点）。
4. 收藏列表 `pageSize = 10`（`BangumiSubjectRepository.kt:104`）—— 比 episode 的 100 小得多，是因为「我的追番」并发 5 个类型 × 10 条。
5. `BangumiUserSubjectCollection.updatedAt` 的文档注释警告：「本时间并不代表条目的收藏时间……请不要依赖此特性」（`gen/.../BangumiUserSubjectCollection.kt:32`）。所以**不能按 updatedAt 排序做「最近观看」**。

### 3.2 鉴权与客户端生命周期

```kotlin
interface BangumiClient : Closeable {
    suspend fun executeGraphQL(query: String): JsonObject
    suspend fun getSelfInfoByToken(accessToken: String?): BangumiUser
    suspend fun deleteSubjectCollection(subjectId: Int)      // 未实现
    suspend fun testConnection(): ConnectionStatus
    suspend fun getApi(): DefaultApi
    suspend fun getNextApi(): SubjectBangumiNextApi
    suspend fun getSubjects(): BangumiClientSubjects
}
// BangumiClient.kt:70-123
```

关键实现细节：

- **token 是 `Flow<String?>`**，每次请求前 `bearerToken.first()` 取最新值（`BangumiClient.kt:154, 213-218`）。
- **自动重试一次**：`HttpSend.intercept` 里如果首次响应状态不在 100..399，**再执行一次同样的请求**（`BangumiClient.kt:219-224`）。这是一个简单粗暴的「token 过期重试」补丁。
- `HttpRequestRetry { maxRetries = 3; delayMillis { 2000 } }`（`:202-205`），`expectSuccess = true`。
- `DelegateBangumiClient(Flow<BangumiClient>)`（`:125-147`）：**代理设置变化时整个 client 重建**，业务代码只持有 delegate（`CommonKoinModule.kt:109-124`）。
- `testConnection()` 把 `404` 也算成功（`BangumiClient.kt:188-193`）—— 因为 `api.bgm.tv` 根路径本来就 404。
- `deleteSubjectCollection` 是**空实现**（`BangumiClient.kt:183-185` 与 `BangumiSubjectRepository.kt:93-95` 都是 TODO）→ 所以「取消收藏」在本快照**不生效**，只有 `setSubjectCollectionTypeOrDelete(null)` 会走到它（`BangumiSubjectRepository.kt:69-78`）。

OAuth 流程（`APP/data/source/session/BangumiSessionManager.kt` + `AniAuthClient`）：

```
① 用户在欢迎页点登录 -> navigateBangumiOAuthOrTokenAuth()
② 打开 https://bgm.tv/oauth/authorize?...&redirect_uri=<ani 服务>  (在浏览器里)
③ Ani 服务收到 code, 换取 token, 客户端轮询 GET <aniAuthServer>/.../getBangumiToken?requestId=...
   AniAuthClient.getResult(requestId)  (AniAuthClient.kt:60-70)
④ 拿到 { access_token, refresh_token, expires_in, user_id } -> Session 持久化到 tokenStore
⑤ 后续请求自动带 Bearer; 过期则 refreshAccessToken (AniAuthClient.kt:72-74)
```

也支持**直接粘贴 access token**（`APP/ui/profile/auth/BangumiTokenAuthPage.kt`）。

游客模式：`SessionStatus` 有 `Guest` 状态，`requireAuthorize(skipOnGuest)` 控制是否强制登录（`SessionManager.kt:73-87`）。未登录时：
- 搜索/看番**可用**（Bangumi 的条目 API 无需 token）；
- 收藏/进度**不可用**（写操作会 401）；
- 「我的追番」显示 `GuestTips`「游客模式下请搜索后观看，或登录后使用收藏功能」（`CollectionPage.kt:423-444`）。

### 3.3 把站点标题对齐到 subject（四种手段）

这是整个项目里最「业务」的部分。按可靠性从高到低：

#### 手段 1：用 Bangumi subject id 精确对齐（Mikan）

`MikanMediaSource.findMikanSubjectIdByName`（`MikanMediaSource.kt:208-243`）：

```
GET /Home/Search?searchstr=<name.trim().substringBefore(" ").take(19)>   // 蜜柑限制 19 字
→ 解析 .an-info 父级 a[href] 里的 /Home/Bangumi/<id>
→ 并发(4) 打开候选 /Home/Bangumi/<id>, 在页面里找文本含「Bangumi番组计划链接：」的元素,
  取其 <a href> 的 /subject/<bgmId>
→ 与我们要的 bgm subjectId 字符串比对, 命中即返回
→ 结果写入 MikanIndexCacheProvider (DataStore "mikanIndexes"), 以 bangumiSubjectId 为 key
```

命中后走 `GET /RSS/Bangumi?bangumiId=<mikanId>`，`allowEpMatch = true`，标记 `MatchKind.EXACT`。
**代价**：首次对齐要 1 次搜索 + N 次条目页请求；命中后永久缓存。

#### 手段 2：`subjectNames` 多别名召回（所有源）

`SubjectInfo.allNames` = `nameCn` + `name` + infobox 全部别名。每个源用自己的搜索接口逐个名字查。
这一步召回率高但**不判断「这个条目是不是我要的那个」**——判断交给下游的集号匹配（`definitelyMatches`）与用户。

> 这正是最新 animeko 增加 `searchConfig` 里「条目名过滤 / 别名选择 / 相似度」的原因：本快照的 web 源**完全不做条目名比对**，只要搜索结果里有集号匹配的资源就会返回。所以搜「日常」会带出「坂本日常」的资源。见 §8。

#### 手段 3：集号匹配（`definitelyMatches`）

`MediaMatch.matches(request)`：`episodeSort ∈ episodeRange || episodeEp ∈ episodeRange`（`MediaMatch.kt:22-26`）。
这是 web 源内部过滤的唯一依据（`TreeStepWebMediaSource.kt:130`）。**因此源只要返回集号对的资源，就会被认为匹配，不管条目是不是对的。**

#### 手段 4：字幕组/来源名称

对 BT 源，`alliance` 就是从标题第一段切出来的字幕组名（`MikanMediaSource.kt:266`）；对 web 源，`alliance = mediaSourceId`（`TreeStepWebMediaSource.kt:71`）。它是用户偏好的键，不是对齐手段。

### 3.4 剧集列表从哪来

**只有一个来源：Bangumi**（`/v0/episodes` 或 `/v0/users/-/collections/{subjectId}/episodes`）。数据源不提供剧集列表，只提供「某集对应的资源」。

核心函数（`APP/data/models/subject/SubjectManager.kt:560-572`）：

```kotlin
private suspend fun fetchEpisodeCollections(subjectId: Int): List<EpisodeCollection> {
    val type: BangumiEpType? = if (showAllEpisodes.first()) null else BangumiEpType.MainStory
    return bangumiEpisodeRepository.getSubjectEpisodeCollections(subjectId, type)
        .let { collections ->
            collections?.toList()?.map { it.toEpisodeCollection() }
                ?: bangumiEpisodeRepository.getEpisodesBySubjectId(subjectId, type)
                    .toList()
                    .map { EpisodeCollection(it.toEpisodeInfo(), UnifiedCollectionType.NOT_COLLECTED) }
        }
}
```

逻辑：

1. `showAllEpisodes` 是 **debug 设置**（`DebugSettings.showAllEpisodes`，`SubjectManager.kt:250`）。默认 `false` → 只要 `MainStory`；开启后连 SP/OP/ED 一起显示。
2. 先尝试「带观看状态的剧集列表」（需要登录且已收藏）；返回 `null`（404/401）时降级到「纯剧集列表」，全部标 `NOT_COLLECTED`。
3. **没有任何本地剧集表**。剧集随 `SubjectCollection` 一起被 `LazyDataCache` 持久化（见 §6）。

分页细节（`APP/data/repository/BangumiEpisodeRepository.kt`）：

```kotlin
// 剧集列表: 每页 100
PageBasedPagedSource { page ->
    client.getApi().getEpisodes(subjectId, type, offset = page * 100, limit = 100).body().run {
        Paged(this.total ?: 0, !this.data.isNullOrEmpty(), this.data.orEmpty())
    }
}   // :77-85

// 带状态的剧集: 第一页单独请求以处理 404/401, 之后 offset = page * 100
// 失败重试 1 次: episodes.results.retry(1)   // :109-122
```

### 3.5 Bangumi 无条目时的降级

「无条目」在本快照有三种不同情况，处理方式不同：

#### 情况 A：搜索页有结果，但用户点进去的是「搜索结果」而非完整条目

`SearchViewModel` 的搜索结果转换（`APP/ui/home/search/SearchViewModel.kt:211-222`）：

```kotlin
fun Subject.toSubjectInfo(): SubjectInfo = SubjectInfo(
    id = id, name = originalName, nameCn = chineseName, summary = summary,
    tags = tags.map { Tag(it.first, it.second) }.sortedByDescending { it.count },
    imageCommon = images.landscapeCommon,
    imageLarge = images.largePoster,
    ratingInfo = RatingInfo.Empty.copy(rank = rank),
)
```

注意：`ratingInfo` 只有 `rank`，`score`/`count` 全空；`collection` 是 `Zero`；`infobox` 为空 → **`allNames` 只有 name/nameCn 两个名字**，别名缺失。点进条目页后会重新用 `getSubjectInfo(subjectId)` 拉完整数据（`SubjectDetailsViewModel.kt:57`）。

#### 情况 B：条目存在但用户未收藏

- `subjectCollectionById` 返回 `null`（404）；
- `fetchEpisodeCollections` 降级到 `/v0/episodes`，全部 `NOT_COLLECTED`；
- `SubjectManager.subjectCollectionFlow` 用 `SubjectInfo + episodes + NOT_COLLECTED + SelfRatingInfo.Empty` **本地合成**一个 `SubjectCollection`（`SubjectManager.kt:310-320`）：

```kotlin
emit(SubjectCollection(
    getSubjectInfo(subjectId),
    episodeCollectionsFlow(subjectId).first(),
    UnifiedCollectionType.NOT_COLLECTED,
    SelfRatingInfo.Empty,
))
```

**这个合成对象随后被写入缓存并持久化**，所以「未收藏的条目」也会出现在本地缓存里（但不在任何 `collectionsByType` 中，因为那个缓存只从服务端拉列表）。

#### 情况 C：条目不存在 / 被删除

- `getSubject()` 返回 `ApiResponse.Failure` → `getOrThrow()` 抛异常 → 条目页显示错误（`SubjectManager.kt:394-396`）；
- 没有「用站点数据创建本地条目」的能力，**本快照无法在没有 Bangumi 条目的情况下看番**。这是与「聚合浏览器」类产品最大的产品差异点，如果目标产品要支持「无 Bangumi 也能看」，必须自己补一层 `LocalSubject`。

#### 情况 D：`episodeId` 拿不到

`getEpisodeInfo` 先扫所有缓存里的 episodes（`SubjectManager.kt:399-409`），再 `runUntilSuccess { repo.getEpisodeById(id) }`（无限重试！`.getEpisodeById` 内部 catch 所有异常返回 null → `error("Failed to get episode")` → `runUntilSuccess` 再试）。**这是一个潜在的死循环风险点**，移植时建议加最大次数。

---

## 4. 用户流程（端到端）

### 4.1 路由表

`APP/navigation/AniNavigator.kt:43-100` + `APP/ui/main/AniAppContentPortrait.kt:88-248`：

| 路由 | 参数 | 页面 | ViewModel |
|---|---|---|---|
| `/welcome` | — | `WelcomeScene` | `WelcomeViewModel` |
| `/home` | — | `HomeScene`（内部有 3 个 tab） | 各 tab 自己的 VM |
| `/bangumi-oauth` | — | `BangumiOAuthScene` | `BangumiOAuthViewModel` |
| `/bangumi-token-auth` | — | `BangumiTokenAuthPage` | `BangumiTokenAuthViewModel` |
| `/subjects/{subjectId}` | Int | `SubjectDetailsScene` | `SubjectDetailsViewModel(subjectId)` |
| `/subjects/{subjectId}/episodes/{episodeId}?fullscreen={bool}` | Int, Int, Bool | `EpisodeScene` | `EpisodeViewModel(subjectId, episodeId, fullscreen, context)`，`viewModel(key="$subjectId-$episodeId")` |
| `/settings?tab={tab}&back={bool}` | String, Bool | `SettingsPage` | `SettingsViewModel` |
| `/caches` | — | `CacheManagementPage` | `CacheManagementViewModel` |
| `/caches/{cacheId}` | String | `MediaCacheDetailsPage` | `MediaCacheDetailsPageViewModel(cacheId)` |
| `/subjects/{subjectId}/caches` | Int | `SubjectCacheScene` | `SubjectCacheViewModelImpl(subjectId)`（`remember`，不用 viewModel，注释：「Don't use rememberViewModel to save memory」） |

`/home` 内部是 **Pager**，不是路由（`HomeScene.kt:305-405`）：

- 竖屏：3 页 = `HomePage`（找番）/ `CollectionPage`（追番）/ `ProfilePage`（我的），底部 `NavigationBar`。
- 横屏/宽屏：4 页 = 找番 / 追番 / 缓存管理 / 设置，左侧 `NavigationRail` + `VerticalPager`（`userScrollEnabled = false`）。
- 通过 `OverrideNavigation` **拦截 `navigateSearch`/`navigateSettings`**，把「跳页」变成「切 pager 页」（`HomeScene.kt:154-172, 366-376`）。这是「一个页面内多 tab，但导航 API 统一」的巧妙做法。

关键导航细节（`AniNavigator.kt:51-56`）：

```kotlin
fun navigateEpisodeDetails(subjectId: Int, episodeId: Int, fullscreen: Boolean = false) {
    navigator.popBackStack("/subjects/$subjectId/episodes/$episodeId", inclusive = true)  // 先清掉同 ep
    navigator.navigate("/subjects/$subjectId/episodes/$episodeId?fullscreen=$fullscreen")
}
```

**先 pop 再 push** 是为了实现「切换剧集时不堆栈」。这也意味着从 A 集切到 B 集后，返回键回到条目页而不是 A 集。

### 4.2 搜索页（`/home` 第 0 页）

`HomePage`（`APP/ui/home/HomePage.kt:59-145`）+ `SearchViewModel`（`APP/ui/home/search/SearchViewModel.kt`）。

状态与流程：

```
SearchViewModel.editingQuery  <-- 输入框
       .search(keywords) -> SubjectSearcher.search(SubjectSearchQuery(keywords.trim(),
                                                  useOldSearchApi = !searchSettings.enableNewSearchSubjectApi))
       -> currentQuery.value = query
       -> Ldc = LazyDataCache(createSource = { subjectProvider.startSearch(query).map { it.toSubjectInfo() } })
       -> list / hasMore -> SubjectPreviewListState
```

- 搜索**有防抖吗？** 没有显式 `debounce`；由 `SubjectSearchBar` 的「回车/点搜索」触发（`HomePage.kt:102-108`）。
- 搜索历史：每次「非从历史点击」的搜索会 `pushSearchHistory`（去重后插入 Room），列表按 `sequence desc`（`SearchHistoryDao.kt:17`）。
- 搜索标签（filter chips）：存 Room `search_tag`，按 `useCount desc` 排序（`SearchTagDao.kt:14`），`increaseCountByName` 累加。
- 过滤条件：airDate / rating / nsfw / tags（`SearchViewModel.kt:129-183`）。**注意 `UpdateRatingRight` 有个 bug**：它写的是 `_airDate`（`SearchViewModel.kt:176-177`），右边界评分实际改的是上映日期。
- 新旧搜索 API 开关：`SearchSettings.enableNewSearchSubjectApi`，默认 `false` → **默认走旧 API**（`UISettings.kt:52-61`）。

`SubjectSearcher`（`SearchViewModel.kt:63-91`）复用 `LazyDataCache`，所以搜索结果也会被持久化，`requestMore()` 可翻页。

点击结果 → `navigator.navigateSubjectDetails(id)`。

### 4.3 条目页（`/subjects/{id}`）

`SubjectDetailsViewModel`（183 行）持有 9 个状态对象：

| 状态 | 内容 |
|---|---|
| `subjectInfo` | `SubjectInfo` flow（缓存优先） |
| `subjectCollectionFlow` | `SubjectCollection`（含剧集与收藏状态） |
| `subjectProgressState` | 「继续观看 xx」按钮的状态与点击 |
| `subjectDetailsState` | 封面、标题、airingLabel、staff/character/related |
| `episodeListState` | 剧集进度弹窗（勾选看过） |
| `editableSubjectCollectionTypeState` | 收藏类型切换 + 「全部标记看过」 |
| `editableRatingState` | 评分/评论/私密 |
| `subjectCommentState` | 吐槽列表（分页） |
| `detailsTabLazyListState` / `commentTabLazyListState` | 滚动位置 |

剧集列表渲染（`EpisodeCarousel`，`APP/ui/subject/episode/details/EpisodeCarousel.kt`）：

- `LazyVerticalGrid(GridCells.Adaptive(240.dp))`；
- `LaunchedEffect(state.playingEpisode)` 自动滚到当前集，偏移 `-itemHeight*0.2`（`:66-76, 109-115`）；
- 每个 item 显示：集号（monospace）、标题、观看状态按钮、缓存状态图标、正在播放图标。

「开始观看 / 继续观看 02 / 已看完」按钮 → `SubjectProgressState.onClickButton()` → `episodeIdToPlay` → `navigateEpisodeDetails`（`SubjectProgressState.kt:86-152`）。

### 4.4 选集与选源

#### 4.4.1 进入播放页

`EpisodeViewModel` 构造时一次性建立整条链（`EpisodeViewModel.kt:219-341`）：

```kotlin
private val subjectInfo = subjectManager.subjectInfoFlow(subjectId).shareInBackground()
private val episodeInfo = episodeId.transformLatest { id -> emit(null); emitAll(subjectManager.episodeInfoFlow(id)) }
                                    .stateInBackground(null)

// 换集时重建 fetch session
private val mediaFetchSession = episodeInfo.flatMapLatest { ep ->
    mediaSourceManager.createFetchFetchSessionFlow(
        if (ep == null) emptyFlow()
        else subjectInfo.map { MediaFetchRequest.create(it, ep) },
    )
}.shareInBackground(started = SharingStarted.Lazily)

private val mediaSelector = MediaSelectorFactory.withKoin(getKoin())
    .create(subjectId, mediaFetchSession.flatMapLatest { it.cumulativeResults })
    .apply {
        autoSelect.run {
            launchInBackground { mediaFetchSession.collectLatest { awaitSwitchEpisodeCompleted(); awaitCompletedAndSelectDefault(it) } }
            launchInBackground { mediaFetchSession.collectLatest { awaitSwitchEpisodeCompleted(); selectCached(it) } }
            launchInBackground { mediaFetchSession.collectLatest {
                awaitSwitchEpisodeCompleted()
                if (settingsRepository.mediaSelectorSettings.flow.first().autoEnableLastSelected) autoEnableLastSelected(it)
            } }
        }
        eventHandling.run {
            launchInBackground { savePreferenceOnSelect { episodePreferencesRepository.setMediaPreference(subjectId, it) } }
        }
        launchInBackground { mediaList.collect { switchEpisodeCompleted.value = true } }
    }
```

**三路自动选择并发**：① 等全部完成再按偏好选；② 一旦有缓存立即选缓存；③ 自动启用「上次选过的源」。
`switchEpisodeCompleted` 是一个**竞态补丁**：注释（`:243-267`）详细解释了「切集后 `mediaList` 可能还是旧的」导致自动选中旧集缓存的 bug，并给出「更恰当的解决方法可能是把 mediaSelector 变成 flow」，但因为改动面太大而采用临时方案。**这是移植时必须重新设计的点**：在 TS 里应该「换集 → 新建 session/selector 实例」，而不是复用可变对象。

#### 4.4.2 数据源选择器 UI

不是独立页面，而是**播放页的 side sheet**：`EpisodeVideoMediaSelectorSideSheet`（57 行）里放 `MediaSelectorView`。结构（`MediaSelectorView.kt:52-130`）：

```
Surface
 └ Column
    ├ LazyColumn
    │   ├ item  : MediaSourceResultsView（横排各数据源 chip：WEB 一行、BT 一行，显示 0/1/2 条 + 重试按钮）
    │   ├ stickyHeader:
    │   │     "筛选到 X/Y 条资源"
    │   │     MediaSelectorFilters（分辨率 / 字幕语言 / 字幕组的 chips）
    │   └ items(filteredCandidates, key = mediaId) -> MediaItem + 选中进度条
    └ bottomActions
```

`MediaSourceResultsView` 的分组（`MediaSourceResultPresentation.kt:127-135`）：

```kotlin
val webSources = list.filter { it.kind == MediaSourceKind.WEB }
val btSources  = list.filter { it.kind == MediaSourceKind.BitTorrent }
val enabledSourceCount = list.count { !it.isDisabled && it.kind != LocalCache }
val totalSourceCount   = list.count { it.kind != LocalCache }   // 缓存源"用户应当无感"
```

排序规则（`FilteredMediaSourceResults.kt:38-60`）：按「查到的资源数量降序」，禁用的排最后，数量相同按 `mediaSourceId` 保证稳定。

顶部文案：「正在查询 3/7 数据源」/「已查询 3/7 数据源」（`MediaSourceResultsView.kt:92-94`）。

#### 4.4.3 数据源选择器的算法（本报告最重要的一节）

`DefaultMediaSelector`（`APP/data/source/media/selector/MediaSelector.kt`，619 行）。

**① `mediaList`（经过设置过滤 + 排序）**（`:196-256`）

```kotlin
combine(mediaListNotCached, savedDefaultPreference, mediaSelectorSettings, mediaSelectorContext) { list, pref, settings, context ->
    filterMediaList(pref, settings, context, list)
        .sortedWith(
            compareByDescending<Media> { media ->
                val subtitleKind = media.properties.subtitleKind
                if (context.subtitlePreferences != null && subtitleKind != null) {
                    if (context.subtitlePreferences[subtitleKind] == SubtitleKindPreference.LOW_PRIORITY) return@compareByDescending 0
                }
                1
            }.then(compareBy { it.costForDownload })
             .thenByDescending { it.publishedTime }
        )
}
private val Media.costForDownload
    get() = when (location) { Local -> 0; Lan -> 1; else -> 2 }    // :614-619
```

**排序三级**：字幕类型优先级（LOW_PRIORITY 降到最后）→ 下载代价（Local < Lan < Online）→ 发布时间新优先。**注意本版本没有 tier、没有「条目名相似度」排序。**

`filterMediaList` 的 4 条规则（`:221-256`）：

```
1. 本地缓存永远保留（否则自动选择选不到缓存）
2. hideSingleEpisodeForCompleted && subjectFinished == true && kind == BitTorrent
       && episodeRange?.isSingleEpisode() == true  -> 过滤（完结番隐藏单集）
3. !preference.showWithoutSubtitle
       && subtitleLanguageIds.isEmpty() && extraFiles.subtitles.isEmpty() -> 过滤（无字幕）
4. context.subtitlePreferences[subtitleKind] == HIDE -> 过滤
```

**② `filteredCandidates`（按偏好筛选）**（`:161-185`）

```kotlin
infix fun <Pref : Any> Pref?.matches(prop: Pref): Boolean = this == null || this == prop
infix fun <Pref : Any> Pref?.matches(prop: List<Pref>): Boolean = this == null || this in prop

fun filterCandidate(it: Media): Boolean {
    if (isLocalCache(it)) return true         // 缓存永远显示
    return mergedPreferences.alliance matches it.properties.alliance &&
           mergedPreferences.resolution matches it.properties.resolution &&
           mergedPreferences.subtitleLanguageId matches it.properties.subtitleLanguageIds &&
           mergedPreferences.mediaSourceId matches it.mediaSourceId
}
```

注意 `matches(List)` 用的是 `this in prop`，即「偏好值出现在资源的语言列表里」。

**③ 偏好合成：三级优先**（`:308-328`）

```kotlin
private val newPreferences = combine(
    savedDefaultPreference, alliance.finalSelected, resolution.finalSelected,
    subtitleLanguageId.finalSelected, mediaSourceId.finalSelected,
) { default, alliance, resolution, subtitleLanguage, mediaSourceId ->
    default.copy(alliance = ..., resolution = ..., subtitleLanguageId = ..., mediaSourceId = ...)
}.flowOn(flowCoroutineContext)   // must not cache
```

每个 `MediaPreferenceItem`（`:563-611`）的 `finalSelected = userSelected.orElse { defaultSelected }`，而 `userSelected` = 「本次会话覆盖」`orElse`「持久化的偏好」。`OptionalPreference` 有三态（noPreference / prefer(value) / preferNoValue），所以能区分「没设过」和「显式清空」。

**④ `trySelectDefault()`（`:375-539`）—— 完整的四层 DFS**

```
前置:
  if (selected.value != null) return null              // 用户已手动选
  mergedPreference = newPreferences.first()
  candidates = filteredCandidates.first(); if empty return null
  context = mediaSelectorContext.filter { it.allFieldsLoaded() }.first()
  shouldPreferSeasons = context.subjectFinished == true && settings.preferSeasons
  preferKind = settings.preferKind

候选轴:
  languageIds  = selectedSubtitleLanguageId ?: fallbackSubtitleLanguageIds
  resolutions  = selectedResolution ?: fallbackResolutions
  alliances    = selectedAlliance ?: (alliancePatterns 用正则匹配 availableAlliances 的结果)
                 ?: ["*"]      // 无偏好时用 "*" 匹配任意
  mediaSources = selectedMediaSource ?: context.mediaSourcePrecedence (按序) ?: [null]

selectImpl(candidates):
  for (resolution in resolutions)                      // ① 分辨率最优先
    filteredByResolution = candidates.filter { resolution == it.properties.resolution }
    for (languageId in languageIds)                    // ② 字幕语言
      filteredByLanguage = filter { languageId in it.properties.subtitleLanguageIds }
      for (alliance in alliances)                      // ③ 字幕组
        filteredByAlliance = filter { alliance == it.properties.alliance }
        for (mediaSource in mediaSources)              // ④ 数据源
          return selectAny(first non-empty)
      // 字幕组没匹配到, 但"最好不要换更差语言"
      for (mediaSource in mediaSources) return selectAny(...)
  return null

selectAny(list):
  if (shouldPreferSeasons) selectDefault(list.firstOrNull { it.episodeRange?.hasSeason() == null } ?: list.first())
  else selectDefault(list.first())

主流程:
  if (preferKind != null) { selectImpl(candidates.filter { it.kind == preferKind })?.let { return it } }   // 优先 WEB
  if (shouldPreferSeasons) { selectImpl(candidates.filter { hasSeason })?.let { return it } }               // 优先季度全集
  selectImpl(candidates)?.let { return it }
  return selectAny(candidates)                                                                              // 兜底
```

设计意图（源码注释 `:444-457`）：

```
// 选择顺序: 1.分辨率 2.字幕语言 3.字幕组 4.数据源
// 规则:
// - 分辨率最高优先: 1080P >> 720P, 但不能为了要 4K 而选择不想要的字幕语言
// - 不要为了选择偏好字幕组而放弃其他字幕组的更好的语言
// 例如: 4K (无匹配) -> 2K (无匹配) -> 1080P -> 简中 -> 桜都 -> Mikan
```

**`selectAny` 里的 `hasSeason() == null` 是一处可疑逻辑**：`it.episodeRange?.hasSeason()` 因为安全调用而是 `Boolean?`，只有当 `episodeRange == null`（集号解析失败）时才为 `null`。所以「偏好季度全集」开启时，它会优先选一个**集号未知**的资源，否则退回 `list.first()`。作者意图更可能是 `!= true`（即「优先不是季度全集的那个」），但当前写法把条件写成了 `== null`。**「不确定」**：也可能是刻意为之（集号未知的资源通常是合集），建议移植时改为显式表达。

**⑤ 缓存优先**（`:541-546`）

```kotlin
override suspend fun trySelectCached(): Media? {
    if (selected.value != null) return null
    val cached = filteredCandidates.first().fastFirstOrNull { isLocalCache(it) } ?: return null
    return selectDefault(cached)     // 注意: selectDefault 不更新偏好
}
```

**⑥ 用户手动选择**（`:333-348`）

```kotlin
override suspend fun select(candidate: Media): Boolean {
    if (selected.value == candidate) return false
    selected.value = candidate
    alliance.preferWithoutBroadcast(candidate.properties.alliance)
    resolution.preferWithoutBroadcast(candidate.properties.resolution)
    mediaSourceId.preferWithoutBroadcast(candidate.mediaSourceId)
    candidate.properties.subtitleLanguageIds.singleOrNull()?.let { subtitleLanguageId.preferWithoutBroadcast(it) }
    broadcastChangePreference()                        // 触发保存
    events.onSelect.emit(SelectEvent(candidate, null))
    return true
}
```

**选一个资源 = 同时记住它的 4 个属性**（字幕组/分辨率/源，以及「若只有一种字幕语言也记住」）。这是「记忆偏好」体验的核心。

**⑦ 偏好保存**（`MediaSelectorEventHandlers.kt:16-22`）

```kotlin
suspend fun savePreferenceOnSelect(save: suspend (MediaPreference) -> Unit) {
    mediaSelector.events.onChangePreference.debounce(1000).collect { save(it) }   // 1 秒防抖
}
```

`broadcastChangePreference` 内部有个优化：**没人监听就不计算**（`if (events.onChangePreference.subscriptionCount.value == 0) return`，`MediaSelector.kt:361`）。

**⑧ 自动「放宽筛选」**（`:548-557`）

```kotlin
override suspend fun removePreferencesUntilFirstCandidate() {
    if (filteredCandidates.first().isNotEmpty()) return
    alliance.removePreference();          if (非空) return
    resolution.removePreference();        if (非空) return
    subtitleLanguageId.removePreference();if (非空) return
    mediaSourceId.removePreference()
}
```

按「影响从小到大」依次取消筛选，用于「筛选到 0 条」时的一键恢复。

#### 4.4.4 换集（`switchEpisode`）

```kotlin
fun switchEpisode(episodeId: Int) {
    episodeDetailsState.showEpisodes = false
    mediaSelector.unselect()            // 否则不会自动选择
    playerState.stop()
    switchEpisodeCompleted.value = false // 必须在修改 episodeId 之前
    this.episodeId.value = episodeId     // ep 要在取消选择 media 之后才能变, 否则会用旧的 media
}
// EpisodeViewModel.kt:450-456
```

顺序极其重要：**unselect → stop → 标记未完成 → 改 episodeId**。改 episodeId 会触发 `episodeInfo` 重新加载 → `mediaFetchSession` 重建 → 自动选择重新跑。

### 4.5 播放页（`/subjects/{id}/episodes/{eid}`）

三种布局（`EpisodePage.kt`）：

| 布局 | 条件 | 结构 |
|---|---|---|
| 手机（竖屏） | 默认 | 上视频 + 下 `HorizontalPager(2)`：剧集详情 / 评论（`EpisodeSceneContentPhoneScaffold:462-512`） |
| 平板横屏 | `isShowLandscapeUI()` | 左视频(weight 1) + 右栏 25% 宽（clamp 340–460dp） |
| 超宽 | 更宽 | 视频 + 右栏，切换 fullscreen 时隐藏右栏（`EpisodeSceneTabletVeryWide:188-281`） |

播放页的「剧集详情」区（`EpisodeDetails`）包含：正在播放卡片（`PlayingEpisodeItem`）、剧集网格（`EpisodeCarousel`）、弹幕统计、视频统计、收藏按钮、评论/弹幕 tab。

`PlayerLauncher`（137 行）是「选择器 → 播放器」的桥：

```kotlin
init {
    mediaSelector.selected.transformLatest { media ->
        videoLoadingStateFlow.value = VideoLoadingState.Initial
        playerState.clearVideoSource()              // 只要 media 换了就清空
        if (media == null) return@transformLatest
        try {
            val info = episodeInfo.filterNotNull().first()
            videoLoadingStateFlow.value = ResolvingSource
            val source = videoSourceResolver.resolve(media, EpisodeMetadata(info.displayName, info.ep, info.sort))
            videoLoadingState = DecodingData(isBt = media.kind == BitTorrent)
            playerState.setVideoSource(source)
            videoLoadingState = Succeed(isBt = source is TorrentVideoSource)
        } catch (...) { /* 见 §2.6 失败表 */ }
    }.launchIn(backgroundScope)
}
// PlayerLauncher.kt:70-136
```

`EpisodeMetadata`（`VideoSourceResolver.kt:61-65`）是解析阶段唯一的剧集上下文：

```kotlin
data class EpisodeMetadata(val title: String, val ep: EpisodeSort?, val sort: EpisodeSort)
```

### 4.6 自动下一集 / 自动标记看过 / 跳过 OP-ED

三个独立协程，都受 `VideoScaffoldConfig` 控制（`EpisodeViewModel.kt:603-679`）。

#### ① 90% 自动标记看过（`:603-640`）

```kotlin
settingsRepository.videoScaffoldConfig.flow.map { it.autoMarkDone }.distinctUntilChanged().debounce(1000)
    .collectLatest { enabled ->
        if (!enabled) return@collectLatest
        mediaFetchSession.collectLatest {
            cancellableCoroutineScope {
                combine(
                    playerState.currentPositionMillis.sampleWithInitial(5000),   // 每 5 秒采样
                    playerState.videoProperties.map { it?.durationMillis }.debounce(5000),
                    playerState.state,
                ) { pos, max, playback ->
                    if (max == null || !playback.isPlaying) return@combine
                    if (episodePresentationFlow.first().collectionType == DONE) cancelScope()  // 已经看过
                    if (pos > max.toFloat() * 0.9) {
                        logger.info { "观看到 90%, 标记看过" }
                        runUntilSuccess(maxAttempts = 5) {
                            subjectManager.setEpisodeCollectionType(subjectId, episodeId.value, DONE)
                        }
                        cancelScope()   // 标记成功一次后不再检查
                    }
                }.collect()
            }
        }
    }
```

要点：**90% 阈值、5 秒采样、播放中才判、最多重试 5 次、成功即停、已看过直接跳过。**

#### ② 自动连播（`:642-657`）

```kotlin
settingsRepository.videoScaffoldConfig.flow.map { it.autoPlayNext }.distinctUntilChanged()
    .collectLatest { enabled ->
        if (!enabled) return@collectLatest
        playerState.state.collect { playback ->
            if (playback != PlaybackState.FINISHED) return@collect
            launchInMain { episodeSelectorState.takeIf { it.hasNextEpisode }?.selectNext() }
        }
    }
```

`hasNextEpisode` 的定义（`EpisodeSelectorSideSheet.kt:82-97`）：

```kotlin
val hasNextEpisode by derivedStateOf {
    val currentIndex = currentIndex
    currentIndex != -1 && currentIndex < items.lastIndex && items[currentIndex + 1].isKnownBroadcast
}
fun selectNext() { if (currentIndex != -1 && currentIndex < items.lastIndex) onSelect(items[currentIndex + 1]) }
```

**只按列表顺序 + 下一集已开播**，不判断「下一集是否已看」。`autoPlayNext` 默认 **false**（`VideoScaffoldConfig.kt:56`）。

#### ③ 跳过 OP/ED（实验性，`:659-679` + `PlayerSkipOpEdState`）

```kotlin
combine(playerState.currentPositionMillis.sampleWithInitial(1000), episodeId, episodeCollectionsFlow) { pos, id, collections ->
    // 不止一集并且当前是第一集时不跳过
    if (collections.size > 1 && collections.getOrNull(0)?.episode?.id == id) return@combine
    playerSkipOpEdState.update(pos)
}.collect()
```

`PlayerSkipOpEdState`（89 行）用 **章节时长启发式**猜 OP/ED：

```kotlin
private val Normal = OpEdLength { it in 85.seconds..95.seconds }   // 长番 OP/ED ≈ 90s
private val Short  = OpEdLength { it in 55.seconds..65.seconds }
fun fromVideoLengthOrNull(length) = when { length > 20.minutes -> Normal; length > 10.minutes -> Short; else -> null }

fun update(currentPos: Long) {
    // 提前 5 秒显示"跳过"提示
    opEdChapters.find { it.chapter.offsetMillis in currentPos - 1000..currentPos + 5000 }?.let { if (currentChapter == null) currentChapter = it }
    // 进入章节则跳
    currentChapter?.takeIf { it.chapter.offsetMillis in currentPos - 1000..currentPos }?.run {
        if (skipped) return@run
        onSkip(chapter.offsetMillis + chapter.durationMillis); skipped = true; currentChapter = null
    }
}
```

依赖播放器提供 `chapters`（`PlayerState.chapters: StateFlow<ImmutableList<Chapter>>`，`PlayerState.kt:168-176`）。mpv/VLC 能从容器读章节；如果拿不到章节，这套机制就完全失效 —— 移植到 Electron 时要评估是否值得（最新 animeko 已把它换掉/重做，见 §8）。

### 4.7 收藏 / 历史 / 进度

见 §6（数据存储）与 §4.3（UI）。这里只强调状态机：

```
                        ┌──────────── Bangumi 服务器（唯一真相）
                        │  /v0/users/{u}/collections        (条目收藏)
                        │  /v0/users/-/collections/{sid}/episodes (剧集收藏=进度)
                        └───────┬──────────────────────────────
                                │ GET（分页 10 / 100）
                    ┌───────────▼────────────┐
                    │  LazyDataCache<SubjectCollection> × 5（按类型）│
                    │  持久化到 DataStore 文件 collectionsByType-<TYPE> │
                    └───────────┬────────────┘
                                │ cachedDataFlow / allDataFlow
              ┌─────────────────┼──────────────────┐
              ▼                 ▼                  ▼
     CollectionPage      SubjectDetailsPage    EpisodePage
     （我的追番）         （条目页）            （播放页，标记看过）
                                ▲
                                │ 写：PATCH /v0/users/-/collections/{sid}/episodes
                                └─ SubjectManager.setEpisodeCollectionType / setAllEpisodesWatched
                                   写成功后**本地缓存 mutate**（先网络后本地，失败则不更新本地）
```

`setEpisodeCollectionType`（`SubjectManager.kt:518-540`）的顺序是「**先服务端，再本地**」：

```kotlin
bangumiEpisodeRepository.setEpisodeCollection(subjectId, listOf(episodeId), collectionType.toEpisodeCollectionType())
val cache = findSubjectCacheById(subjectId) ?: return
cache.mutate { setEach({ it.subjectId == subjectId }) { copy(episodes = episodes.replaceAll({ it.episode.id == episodeId }) { copy(collectionType) }) } }
```

而 `setSubjectCollectionType`（`:470-489`）会**跨缓存移动**：从旧类型的 `LazyDataCache` 里 `removeFirstOrNull`，再 `addFirst` 到新类型（`dataTransaction`）。

---

## 5. 播放器

### 5.1 `PlayerState`：接口与状态机

`VP/ui/state/PlayerState.kt:51-169`：

```kotlin
@Stable
interface PlayerState {
    val state: StateFlow<PlaybackState>
    val videoSource: StateFlow<VideoSource<*>?>
    val videoData: Flow<VideoData?>
    val cacheProgress: MediaCacheProgressState
    suspend fun setVideoSource(source: VideoSource<*>)     // @Throws(VideoSourceOpenException)
    suspend fun clearVideoSource()
    val videoProperties: StateFlow<VideoProperties?>
    val isBuffering: Flow<Boolean>
    val currentPositionMillis: StateFlow<Long>
    fun getExactCurrentPositionMillis(): Long              // @UiThread
    val bufferedPercentage: StateFlow<Int>
    val playProgress: Flow<Float>                          // 0f..1f
    fun pause(); fun resume(); fun stop()
    val playbackSpeed: StateFlow<Float>
    fun setPlaybackSpeed(speed: Float)
    fun seekTo(positionMillis: Long)
    val subtitleTracks: TrackGroup<SubtitleTrack>
    val audioTracks: TrackGroup<AudioTrack>
    fun saveScreenshotFile(filename: String)
    val chapters: StateFlow<ImmutableList<Chapter>>
}
```

`PlaybackState`（`:356-380`）：

```kotlin
enum class PlaybackState(val isPlaying: Boolean) {
    READY(false),            // 已加载, 有首帧就播
    PAUSED(false),           // 用户暂停
    PLAYING(true),
    PAUSED_BUFFERING(false), // 播放中但没 buffer, 充好自动恢复
    FINISHED(false),
    ERROR(false),
}
```

`AbstractPlayerState`（`:186-353`）是模板方法实现：

```kotlin
final override suspend fun setVideoSource(source: VideoSource<*>) {
    val previousResource = openResource.value
    if (source == previousResource?.videoSource) return          // 幂等
    openResource.value = null
    previousResource?.releaseResource?.invoke()                  // 先释放上一个
    val opened = openSource(source)                              // 可能抛 VideoSourceOpenException
    state.value = PlaybackState.PAUSED_BUFFERING
    startPlayer(opened)                                          // 平台实现
    this.openResource.value = opened
}

protected abstract suspend fun openSource(source: VideoSource<*>): D
protected abstract suspend fun startPlayer(data: D)
protected abstract suspend fun cleanupPlayer()
```

平台实现：
- Android：`VP/androidMain/.../PlayerState.android.kt`（ExoPlayer/Media3）
- 桌面：`VP/desktopMain/.../VideoPlayer.desktop.kt`（**VLCJ**，`VlcjVideoPlayerState`，`app/desktop/src/main/kotlin/AniDesktop.kt:208-212`）
- iOS：`VP/iosMain/.../VideoPlayer.ios.kt`（占位）

桌面端还有两个"黑科技"：
- `SeekableInputCallbackMedia.kt`：把 `VideoData.createInput()` 的 `SeekableInput` 包装成 VLC 可回调的媒体源 —— **这是「边下边播」的关键**，因为 BT 数据不是文件而是流。
- `SkiaVideoSurface.kt` / `SkiaBitmapVideoSurface.kt`：把 VLC 的帧用 Skia 渲染。
- 注释里保留了历史决策（`AniDesktop.kt:118-123`）：Compose 的 `interop.blending` 在 Windows 上有问题，最终选择 `CallbackMediaPlayerComponent`。

### 5.2 媒体流选择（多线路 / 清晰度）

**必须先说清本快照的边界：「播放器内部没有清晰度切换」。**

| 用户感知 | 实现 |
|---|---|
| 「换清晰度 4K → 1080P」 | 从 `mediaList` 里**换成另一个 `Media`**（`properties.resolution` 不同），走完整的 `resolve → setVideoSource` |
| 「换线路」 | web 源的 `Ep.channel` 写进 `mediaId` 后缀与 `originalTitle`（`TreeStepWebMediaSource.kt:59-66`），本质上也是另一个 `Media` |
| 「换源」 | 同上，选另一个 `Media`；UI 上是「数据源」按钮 → side sheet |
| 「换音轨」 | `playerState.audioTracks.select(track)`（文件内部轨道） |
| 「换字幕」 | `playerState.subtitleTracks.select(track)` |
| 同一 HLS 主播放列表内的变体切换 | **不存在**。`HttpStreamingVideoSource` 只持有一个 URL |

`HttpStreamingVideoSource`（`VP/commonMain/kotlin/torrent/HttpStreamingVideoSource.kt`）：

```kotlin
class HttpStreamingVideoSource(
    override val uri: String,
    val title: String,
    webVideo: WebVideo,           // 含 headers
    override val extraFiles: MediaExtraFiles,
) : VideoSource<HttpStreamingVideoData>
```

`WebVideo.headers`（UA/Referer/Cookie 等）在请求 m3u8/分片时**必须带上**，否则 CDN 会 403。这是 web 源能否播的关键，也是 Electron 版用 `session.webRequest.onBeforeSendHeaders` 或自定义 protocol handler 要处理的事。

### 5.3 字幕

三层字幕来源：

1. **内嵌（EMBEDDED）**：烧在画面里，无需处理。
2. **内封（CLOSED）**：容器里的字幕轨 → `playerState.subtitleTracks`。`TrackGroup` 接口（`VP/ui/state/TrackGroup.kt:11-49`）：

```kotlin
interface TrackGroup<T> {
    val current: StateFlow<T?>
    val candidates: Flow<List<T>>
    fun select(track: T?): Boolean
}
data class SubtitleTrack(val id: String, val internalId: String, val language: String?, val labels: List<Label>) : Track
data class AudioTrack(val id: String, val internalId: String, val name: String?, val labels: List<Label>) : Track
data class Label(val language: String?, val value: String)   // language = 值的语言, value = "CHS"/"简日"
```

UI：`VP/ui/progress/SubtitleSwitcher.kt`、`SubtitleLanguage.kt`、`AudioSwitcher.kt`、`AudioPresentation.kt`。

3. **外挂（EXTERNAL_PROVIDED）**：`Media.extraFiles.subtitles`（`MediaExtraFiles.kt:9-25`），每个 `Subtitle` 有 `uri`/`mimeType`/`language`。`Ikaros` 源就是这种模式的例子：它有 `IkarosVideoSubtitle` 模型与 ASS 文件名解析器（`data-sources/ikaros/src/AssNameParser.kt`、`models/IkarosVideoSubtitle.kt`）。

**平台过滤**：`MediaSelectorSubtitlePreferences` 在**选源阶段**就把平台播不了的类型 HIDE 或降权（§1.8）。这比「播不了再报错」体验好得多，是最值得抄的设计之一。

### 5.4 弹幕

#### 数据模型（`DM/api/src/commonMain/kotlin/DanmakuProvider.kt:18-158`）

```kotlin
interface DanmakuProvider : AutoCloseable {
    val id: String
    suspend fun fetch(request: DanmakuSearchRequest): DanmakuFetchResult
}

class DanmakuSearchRequest(
    val subjectId: Int, val subjectPrimaryName: String, val subjectNames: List<String>,
    val subjectPublishDate: PackedDate,          // 用于按季度缩小范围
    val episodeId: Int, val episodeSort: EpisodeSort, val episodeEp: EpisodeSort?,
    val episodeName: String,
    val filename: String?, val fileHash: String?, val fileSize: Long?, val videoDuration: Duration,
)

class DanmakuFetchResult(val matchInfo: DanmakuMatchInfo, val danmakuCollection: DanmakuCollection?)
class DanmakuMatchInfo(val providerId: String, val count: Int, val method: DanmakuMatchMethod)

sealed class DanmakuMatchMethod {
    data class Exact(subjectTitle, episodeTitle)
    data class ExactSubjectFuzzyEpisode(subjectTitle, episodeTitle)
    data class Fuzzy(subjectTitle, episodeTitle)
    data class ExactId(subjectId, episodeId)
    data object NoMatch
}
```

匹配器（`:117-158`）：`DanmakuMatchers.mostRelevant(targetSubjectName, targetEpisodeName)` 用 **Levenshtein 距离**（subject + episode 距离之和最小）。

#### 两个 provider

`DanmakuProviderLoader`（`APP/data/source/danmaku/DanmakuManager.kt:68-82`）**硬编码**两个：

```kotlin
val factories = listOf(DandanplayDanmakuProvider.Factory(), AniDanmakuProvider.Factory())
```

（注释解释了为什么不用 ServiceLoader：JVM-only MPP 依赖的 `META-INF/services` 会冲突，KT-65362。）

**弹弹play 的匹配算法**（`DM/dandanplay/src/DandanplayDanmakuProvider.kt:57-164`，注释里写了完整流程）：

```
获取剧集:
  1. 用 bangumi 条目名 + 季度 在弹弹"本季度番剧列表"里找 exact name 匹配
  2. 失败则用每个别名调 /api/v2/search/episodes
  3. 精确匹配到番剧 -> 取它的全部剧集
  4. 都不行 -> 最后才用文件名/hash/size/duration 调 /api/v2/match
匹配剧集:
  1. episodeSort (系列内)
  2. episodeEp   (季度内)
  3. episodeName 精确 / "第N话 名字"
  4. Levenshtein 最相近
  5. （兜底）文件名匹配，带 shift 毫秒偏移
```

`createSession(episodeId, shiftMillis, matchMethod)` 会拉 `getDanmakuList` 并用 `TimeBasedDanmakuSession.create(..., shiftMillis)` 构造时间轴会话（`:252-267`）。

**Ani 官方弹幕源**（`APP/data/source/danmaku/AniDanmakuProvider.kt`）：走自建服务，需要登录（`verifiedAccessToken`），发送弹幕用 `AniDanmakuSender`（`DanmakuManager.kt:104-111`）。

#### 合并与容错（`DanmakuManager.kt:119-159`）

```kotlin
val results = combine(providers.map { provider ->
    flow { emit(withTimeout(60.seconds) { provider.fetch(request) }) }
        .retry(1) { ... }
        .catch { emit(DanmakuFetchResult(DanmakuMatchInfo(provider.id, 0, NoMatch), null)) }  // 忽略错误
}) { it.toList() }.first()
return CombinedDanmakuFetchResult(
    results.map { it.matchInfo },
    CombinedDanmakuSession(results.mapNotNull { it.danmakuCollection }),
)
```

**「一个源炸了不能导致所有弹幕都不显示」** —— 每个 provider 自己 catch 成 NoMatch。`CombinedDanmakuSession` 把多个会话 `merge()`（按时间轴合并）。

#### 渲染与过滤

- 弹幕加载容器：`DanmakuLoaderImpl`（`APP/ui/subject/episode/video/` 内），输入 `LoadDanmakuRequest(subjectInfo, episodeInfo, episodeId, filename, fileLength)`（`EpisodeViewModel.kt:467-492`）。
- 发送：`danmakuManager.post(episodeId, DanmakuInfo(positionMillis, text, color, location))`（`EpisodeViewModel.kt:501-503`）。
- 过滤：`DanmakuFilterConfig` + `List<DanmakuRegexFilter>`（存 `danmakuFilter` DataStore），UI 在 `DanmakuRegexFilterGroup.kt`。
- 渲染：Compose 自绘（`DM/ui/commonMain/`），`FloatingDanmakuTrack` / `FixedDanmakuTrack` / `DanmakuTrack`，按宽度测速分配轨道。`DanmakuHostState` 有 `trySend` / `repopulate` / `setPaused`（`EpisodeViewModel.kt:571-601`）。
- 配置：`DanmakuConfig`（字号、速度、透明度、显示区域、防挡）、`DanmakuSettings`（`useGlobal` 等）。

**移植提示**：弹幕「会话」抽象（`DanmakuSession` 按 `progress: Flow<Duration>` 推送）很适合 TS：一个 `AsyncIterable`/RxJS stream + `seek` 时重建窗口即可。

### 5.5 播放进度与「续播」

**本快照没有本地播放进度存储。** 证据：

- 全仓库无 `EpisodeRecord`/`lastPlayed`/`playbackProgress` 等符号；
- `PlayerState` 只有 `currentPositionMillis`（内存），`seekTo` 只在用户拖动/跳过 OP-ED 时调用（`EpisodePage.kt:535-543`、`EpisodeVideo.kt:217-218`、`EpisodeViewModel.kt:555-562`）；
- 没有任何「打开视频时 seek 到上次位置」的代码路径。

所以本快照的「续播」实际上是**集级续播**：

```
上次看到第 3 集（第 3 集被标 DONE）→ 下次进入条目页 → "继续观看 04" → 从第 4 集第 0 秒开始
```

第 3 集如果只看到 60%，下次仍然从第 3 集第 0 秒开始（因为没标 DONE，`SubjectProgressInfo` 会把它当作「未看」，`continueWatchingStatus = Continue(index=2)`，点进去是第 3 集）。

**这是与"聚合浏览器"类产品差距最大的地方之一**：如果要「记住看到 12:34」，必须自己加一张 `episode_progress(subjectId, episodeId, positionMillis, durationMillis, updatedAt)` 表。

### 5.6 换源与错误恢复

用户可触发换源的入口：

1. 播放页顶栏「数据源」按钮（`EpisodeVideo.kt:170-173`，testTag `TAG_SHOW_MEDIA_SELECTOR`）；
2. 剧集详情卡片里的「选择数据源」按钮 / 已选源的按钮（`PlayingEpisodeItem.kt:231-280`）；
3. `VideoLoadingSummary` 显示错误后，用户自己再点数据源（没有自动换源！）。

**没有自动 fallback**：`PlayerLauncher` 出错只是把状态设为 `Failed` 并 `clearVideoSource()`（`PlayerLauncher.kt:96-134`），**不会自动尝试下一个候选**。这与最新 animeko 的「播放失败换源」（`MediaAutoSelector` + 黑名单 + 1 秒截止）差别很大，见 §8。

`clearVideoSource`（`PlayerState.kt:303-308`）：

```kotlin
override suspend fun clearVideoSource() {
    cleanupPlayer()          // 停播+释放
    this.videoSource.value = null
    this.openResource.value = null
}
```

注意 `openResource` 的 `releaseResource` 是 `backgroundScope.launch(NonCancellable) { data.close() }`（`DummyPlayerState.openSource`，`:426-437`；平台实现类似），保证切源时旧资源一定被关闭。

---

## 6. 收藏 / 历史 / 进度：存哪里、字段是什么

### 6.1 存储介质总表

| 介质 | 位置 | 内容 | 代码 |
|---|---|---|---|
| **Room DB** `AniDatabase` v1 | 平台数据库文件 | `search_history`、`search_tag` 两张表 | `APP/data/persistent/database/AniDatabase.kt:10-19` |
| **DataStore\<Preferences\>** `preferencesStore` | `*.preferences_pb` | 全部 `Settings<T>`（见 §6.2） | `APP/data/repository/SettingsRepository.kt:78-224` |
| **DataStore\<Preferences\>** `tokenStore` | 同上 | Bangumi access/refresh token、账号信息 | `APP/data/repository/TokenRepository.kt` |
| **DataStore\<Preferences\>** `preferredAllianceStore` | 同上 | **每个 subject 的 `MediaPreference`**（key = subjectId 字符串） | `APP/data/repository/EpisodePreferencesRepository.kt:36-58` |
| **DataStore\<JSON\>** `mediaSourceSaves` | 文件 | `MediaSourceSaves`（数据源实例配置） | `APP/data/persistent/SettingsStore.kt:54-63` |
| **DataStore\<JSON\>** `danmakuFilter` | 文件 | `List<DanmakuRegexFilter>` | 同上 `:66-75` |
| **DataStore\<JSON\>** `mikanIndexes` | 文件 | `MikanIndexes`（bgmSubjectId ↔ mikanId 映射） | 同上 `:45-52` |
| **DataStore\<JSON\>** `collectionsByType-<TYPE>` × 5 | 文件 | `LazyDataCacheSave<SubjectCollection>`（**含全部剧集与观看状态**） | `APP/data/models/subject/SubjectManager.kt:272-281` |
| **文件目录** `media-cache/<engine>/` | 磁盘 | 缓存视频 + 每条的 JSON 元数据（`MediaCacheMetadata`） | `APP/platform/CommonKoinModule.kt:167-168` |
| **文件目录** `updates/`、`logs/` | 磁盘 | 更新包、日志 | `AniDesktop.kt:139-149` |

> 注意 `collectionsByType-<TYPE>` 是**每个收藏类型一个 DataStore 文件**，`TYPE` 取 `WISH/DOING/DONE/ON_HOLD/DROPPED`（`SubjectManager.kt:252-282`）。这就是「收藏 + 剧集 + 观看进度」在本地的**唯一副本**。

### 6.2 `preferencesStore` 里的 key（`SettingsRepository.kt:143-219`）

| key | 类型 | 默认 |
|---|---|---|
| `danmaku_enabled` | Boolean | `true` |
| `danmaku_config` | `DanmakuConfig`（自定义 serializer） | `Default` |
| `danmaku_filter_config` | `DanmakuFilterConfig` | `Default` |
| `mediaSelectorSettings` | `MediaSelectorSettings` | `Default`（新用户 preferKind=WEB） |
| `defaultMediaPreference` | `MediaPreference` | `PlatformDefault` |
| `profileSettings` | `ProfileSettings` | `Default` |
| `proxyPreferences` | `ProxySettings` | `Default` |
| `cachePreferences` | `MediaCacheSettings` | `Default`（含 `saveDir`） |
| `danmakuSettings` | `DanmakuSettings` | `Default`（含 `useGlobal`） |
| `uiSettings` | `UISettings` | `Default` |
| `updateSettings` | `UpdateSettings` | `Default` |
| `videoScaffoldConfig` | `VideoScaffoldConfig` | `Default` |
| `videoResolverSettings` | `VideoResolverSettings` | `Default`（WebView driver） |
| `anitorrentConfig` | `AnitorrentConfig` | `Default` |
| `oneshotActionConfig` | `OneshotActionConfig` | `Default`（一次性提示的已读状态） |
| `debugSettings` | `DebugSettings` | `Default`（含 `showAllEpisodes`） |

`SerializablePreference` 的实现（`:102-141`）值得抄：**读失败（JSON 损坏/结构变更）→ 记 error 日志 → 返回默认值**，绝不 crash。

```kotlin
override val flow: Flow<T> = preferences.data.map { it[key] }.distinctUntilChanged().map { string ->
    if (string == null) default()
    else try { format.decodeFromString(serializer, string) }
         catch (e: Exception) { logger.error(e) { "Failed to decode preference '$name'. Using default." }; default() }
}
```

### 6.3 Room 表结构

```kotlin
// APP/data/persistent/database/eneity/SearchHistoryEntity.kt:6-10
@Entity(tableName = "search_history")
data class SearchHistoryEntity(
    @PrimaryKey(autoGenerate = true) val sequence: Int = 0,
    val content: String,
)

// APP/data/persistent/database/eneity/SearchTagEntity.kt:6-14
@Entity(tableName = "search_tag")
data class SearchTagEntity(
    @PrimaryKey(autoGenerate = true) val id: Int = 0,
    val content: String,
    val useCount: Int = 1,     // 使用次数，越高排序越前
)
```

DAO：`SearchHistoryDao`（`getFlow` 按 `sequence desc`）、`SearchTagDao`（`getFlow` 按 `useCount desc`，含 `increaseCountByName/Id`、`deleteByName/Id`）。都是 `@Upsert`。

**没有 `subject`、`episode`、`media`、`cache`、`progress` 表。** 这是一个非常"轻"的本地存储策略：所有业务数据都在 Bangumi + 文件缓存里。

### 6.4 「我的」页面如何组织

竖屏第 3 个 tab = `ProfilePage`（`APP/ui/profile/ProfilePage.kt:59-92`）：

```
Scaffold
 ├ topBar: SelfInfo(authState, onClickSettings)
 │    └ 头像 + 用户名 + 设置入口（未登录显示「登录」）
 └ content: DebugInfoView
      ├ "感谢你的支持"
      ├ AniHelpSection：QQ群/TG/GitHub/官网/加群按钮
      └ （PC 上是 NavigationRail 左侧的「设置」入口，没有 ProfilePage）
```

**注意：「我的」页本身非常空**（只有账号 + 帮助），真正的「我的内容」在**第 2 个 tab「追番」= `CollectionPage`**：

```
CollectionPage（APP/ui/subject/collection/CollectionPage.kt:117-307）
 ├ TopAppBar「我的追番」+ 刷新/缓存管理/更新提示
 ├ SecondaryScrollableTabRow: 5 个 tab
 │    COLLECTION_TABS_SORTED = [DROPPED, WISH, DOING, ON_HOLD, DONE]   // :104-110
 │    tab 标题 = displayText() + 总数（"在看 42"）
 ├ HorizontalPager(userScrollEnabled = 仅移动端)
 │    └ 每个 tab: LazyGrid of SubjectCollectionItem
 │         ├ 封面 + 标题 + 收藏类型按钮（EditableSubjectCollectionTypeButton）
 │         ├ 「继续观看 04」/「已看完」/「周三开播」按钮（SubjectProgressButton）
 │         ├ 点击 → 条目页；长按/按钮 → 剧集进度弹窗（EpisodeListDialog）
 │         └ 空态: 「~ 空空如也 ~」+ 搜索按钮，或 GuestTips
 └ 下拉刷新（PC 用按钮触发）
```

tab 顺序被 `@Stable val COLLECTION_TABS_SORTED` 固定为 `DROPPED, WISH, DOING, ON_HOLD, DONE`，但 **Pager 初始页 = `size/2` = 2 → 落在 `DOING`（在看）**（`CollectionPage.kt:126-127`）。这个「排序为了某种历史原因，但初始页补偿」的做法有点绕，移植时直接按「在看 / 想看 / 搁置 / 看过 / 抛弃」排就好。

`MyCollectionsViewModelImpl.init()`（`:138-174`）的加载策略：

```kotlin
// 按实用顺序加载（注释：如果全并行就会导致 "在看" 没有数据）
listOf(DOING, WISH, ON_HOLD, DONE, DROPPED).forEach { type ->
    val cache = collectionsByType(type).cache
    if (cache.getCachedData().isEmpty()) cache.requestMore()   // 只请求第一页（10 条）
}
// 登录/登出时清空所有缓存
sessionManager.events.filter { it is Login || it is Logout }.collectLatest { for (c in collectionsByType) c.cache.invalidate() }
```

**「按实用顺序串行加载」这个细节很重要**：并行会触发 Bangumi 限流，导致"在看"拿不到数据。

---

## 7. 值得移植的 15 条具体设计决策

每条都给出「做什么 / 为什么 / 抄哪一行」。

### 7.1 数据源用「ID + Factory + Instance」三层 ID 分离

**做法**：`FactoryId`（类型）≠ `mediaSourceId`（实例，用于偏好与缓存归属）≠ `instanceId`（持久化主键）。
**为什么**：一个 RSS 类型能建多个实例；同一站点可能有镜像（`mikan` vs `mikan-mikanime-tv`）；用户偏好要按 `mediaSourceId` 记忆，而 UI 列表要按 instance 顺序。
**证据**：[`MediaSourceFactory.kt:12-19`](<_ref/ani/data-sources/api/src/commonMain/kotlin/source/MediaSourceFactory.kt#L12-L19>)（注释直言「防止跟 mediaSourceId 弄混」）、[`MediaSourceInstance.kt:16-29`](<_ref/ani/app/shared/src/commonMain/kotlin/data/source/media/instance/MediaSourceInstance.kt#L16-L29>)、[`MediaSourceSave`](<_ref/ani/app/shared/src/commonMain/kotlin/data/source/media/instance/MediaSourceInstance.kt#L35-L52>)。

### 7.2 `mediaId` 必须全局唯一且稳定，并编码来源

**做法**：`"<mediaSourceId>.<sourceLocalId>"`；web 源再加 `-<集号>[-<线路>]`；缓存用 `"<cacheSourceId>:<originMediaId>"`。
**为什么**：多源并发时 `distinctBy { mediaId }` 去重（[`MediaFetcher.kt:229`](<_ref/ani/app/shared/src/commonMain/kotlin/data/source/media/fetch/MediaFetcher.kt#L229>)）；Compose `key = mediaId` 避免列表错乱；缓存命中要能反查来源。
**证据**：[`Media.kt:40-41`](<_ref/ani/data-sources/api/src/commonMain/kotlin/Media.kt#L40-L41>)、[`NyafunMediaSource.kt:128-129`](<_ref/ani/data-sources/web/nyafun/src/NyafunMediaSource.kt#L128-L129>)、[`Media.kt:191-192`](<_ref/ani/data-sources/api/src/commonMain/kotlin/Media.kt#L191-L192>)。

### 7.3 双集号 `ep` + `sort`，且「精确匹配条目时优先 ep、模糊匹配时优先 sort」

**做法**：请求同时携带两个集号；源的 `episodeRange.contains` 对两者都判；种子内文件选择先 `sort` 后 `ep`。
**为什么**：分割放送（无职转生 第2部分）在不同站点有三种编号方式，单靠一种必错。（最新 animeko 的文档把这个权衡讲得更细，并承认本版本「总是优先 sort」是错的。）
**证据**：[`MediaFetchRequest.kt:38-58`](<_ref/ani/data-sources/api/src/commonMain/kotlin/source/MediaFetchRequest.kt#L38-L58>)、[`TorrentVideoSourceResolver.kt:144-155`](<_ref/ani/app/shared/src/commonMain/kotlin/data/source/media/resolver/TorrentVideoSourceResolver.kt#L144-L155>)。

### 7.4 用「不可变值对象 + 显式解析函数」处理集号，而不是散落的 `Int`

**做法**：`EpisodeSort`（Normal/Special/Unknown）+ `EpisodeRange`（Single/Range/Combined/Season）+ `Comparable` + 自定义 `equals`。
**为什么**：集号会出现 `1.5`、`SP01`、`OVA`、`S1`、`1-12`。用 `Int` 会导致「12.5 变成 12」这类静默错误。
**证据**：[`EpisodeSort.kt:31-191`](<_ref/ani/data-sources/api/src/commonMain/kotlin/EpisodeSort.kt#L31-L191>)、[`EpisodeRange.kt:38-275`](<_ref/ani/data-sources/api/src/commonMain/kotlin/topic/EpisodeRange.kt#L38-L275>)。

### 7.5 `MediaProperties` 的四个字段就是「选源的四根轴」，并且由数据源保证取值受控

**做法**：只允许 `resolution ∈ {720P,1080P,2K,4K}`、`subtitleLanguageIds ⊆ {CHS,CHT,JPN,ENG,CHC}`、`alliance` 稳定、`subtitleKind` 枚举。
**为什么**：用户偏好按这四个值记忆；值不稳定 → 偏好失效；值不受控 → UI chips 爆炸。
**证据**：[`Media.kt:203-260`](<_ref/ani/data-sources/api/src/commonMain/kotlin/Media.kt#L203-L260>)（注释逐条写明「总是使用大写」「不要返回相似的字幕组名」）。

### 7.6 「缓存优先」贯穿全链路：排序 Cost=0、过滤豁免、自动选择第一优先

**做法**：(a) `MediaList` 排序把 `Local` 排最前；(b) `filterMediaList` 第一条规则「本地缓存永远保留」；(c) 单独的 `trySelectCached()` 在资源一出现就选。
**为什么**：用户已经下载的集，绝不应该去网上再拉一遍；而且缓存加载快，能让「点开就播」。
**证据**：[`MediaSelector.kt:172-174`](<_ref/ani/app/shared/src/commonMain/kotlin/data/source/media/selector/MediaSelector.kt#L172-L174>)、[`MediaSelector.kt:614-619`](<_ref/ani/app/shared/src/commonMain/kotlin/data/source/media/selector/MediaSelector.kt#L614-L619>)、[`EpisodeViewModel.kt:287-292`](<_ref/ani/app/shared/src/commonMain/kotlin/ui/subject/episode/EpisodeViewModel.kt#L287-L292>)。

### 7.7 自动选择用「四层 DFS + 逐层回退」，而不是加权打分

**做法**：分辨率 → 字幕语言 → 字幕组 → 数据源，四层嵌套循环，任意一层空就 `continue` 到下一项；外层失败才换分辨率。
**为什么**：加权打分需要调参且难解释；DFS 的行为可以用一句话描述（「尽量保分辨率，但不为 4K 牺牲字幕语言」），用户可预期、可测试。
**证据**：[`MediaSelector.kt:444-539`](<_ref/ani/app/shared/src/commonMain/kotlin/data/source/media/selector/MediaSelector.kt#L444-L539>)（含设计注释 `#174`）。

### 7.8 用户「选一次」= 记住四个属性，且 1 秒防抖落盘

**做法**：`select(media)` 同时 `prefer(alliance/resolution/mediaSourceId/唯一字幕语言)`；`onChangePreference` 经 `debounce(1000)` 写 DataStore。
**为什么**：用户点某条资源，真实意图是「我要这个字幕组+这个清晰度+这个源」；只记 mediaId 下次就失效了（资源会变）。
**证据**：[`MediaSelector.kt:333-348`](<_ref/ani/app/shared/src/commonMain/kotlin/data/source/media/selector/MediaSelector.kt#L333-L348>)、[`MediaSelectorEventHandlers.kt:16-22`](<_ref/ani/app/shared/src/commonMain/kotlin/data/source/media/selector/MediaSelectorEventHandlers.kt#L16-L22>)、[`EpisodePreferencesRepository.kt:52-58`](<_ref/ani/app/shared/src/commonMain/kotlin/data/repository/EpisodePreferencesRepository.kt#L52-L58>)。

### 7.9 偏好三级覆盖：会话 > 该条目 > 全局默认，用三态 `OptionalPreference` 表达「显式清空」

**做法**：`OptionalPreference`（noPreference / prefer(v) / preferNoValue）+ `merge`。
**为什么**：需要区分「用户没设过」与「用户明确取消了这个筛选」。用 `null` 无法区分。
**证据**：[`MediaSelector.kt:559-611`](<_ref/ani/app/shared/src/commonMain/kotlin/data/source/media/selector/MediaSelector.kt#L559-L611>)、[`OptionalPreference.kt`](<_ref/ani/app/shared/src/commonMain/kotlin/data/source/media/selector/OptionalPreference.kt>)、[`MediaSelector.kt:548-557`](<_ref/ani/app/shared/src/commonMain/kotlin/data/source/media/selector/MediaSelector.kt#L548-L557>)（逐级取消筛选）。

### 7.10 平台能力表在「选源阶段」生效，而不是播放阶段

**做法**：`MediaSelectorSubtitlePreferences.forPlatform()` 给出 `SubtitleKind -> {NORMAL, LOW_PRIORITY, HIDE}`，参与过滤与排序。
**为什么**：macOS 播不了内封，如果等到播放失败再提示，用户已经等了 10 秒。选源阶段直接不显示/降权，体验最好。
**证据**：[`MediaSelectorSubtitlePreferences.kt:40-105`](<_ref/ani/app/shared/src/commonMain/kotlin/data/source/media/selector/MediaSelectorSubtitlePreferences.kt#L40-L105>)、[`MediaSelector.kt:230-253`](<_ref/ani/app/shared/src/commonMain/kotlin/data/source/media/selector/MediaSelector.kt#L230-L253>)。

### 7.11 每个数据源一个「惰性 + 可重启 + 有状态」的 `MediaSourceFetchResult`

**做法**：`Idle/Disabled/Working/PendingSuccess/Succeed/Failed/Abandoned` 七态；`restart()` / `enable()`；结果 `shareIn(replay=1, WhileSubscribed)`。
**为什么**：单源失败不能影响全局；禁用的源仍可在 UI 里"临时启用"；`WhileSubscribed` 让「离开页面就停止查询」自然成立。
**证据**：[`MediaSourceFetchState.kt:9-51`](<_ref/ani/app/shared/src/commonMain/kotlin/data/source/media/fetch/MediaSourceFetchState.kt#L9-L51>)、[`MediaFetcher.kt:139-279`](<_ref/ani/app/shared/src/commonMain/kotlin/data/source/media/fetch/MediaFetcher.kt#L139-L279>)、[`MediaSourceFetchResult.kt:77-100`](<_ref/ani/app/shared/src/commonMain/kotlin/data/source/media/fetch/MediaSourceFetchResult.kt#L77-L100>)。

### 7.12 「累计结果流」用 `runningFold` 而不是等全部完成

**做法**：`combine(perSourceResults) ∘ flatten ∘ distinctBy ∘ runningFold(acc + list)`。
**为什么**：用户希望看到结果逐步出现（10 个源里 3 个先回来就能播）；同时 `hasCompleted` 单独提供「全部结束」信号。
**证据**：[`MediaFetcher.kt:225-230`](<_ref/ani/app/shared/src/commonMain/kotlin/data/source/media/fetch/MediaFetcher.kt#L225-L230>)、[`MediaFetcher.kt:309-346`](<_ref/ani/app/shared/src/commonMain/kotlin/data/source/media/fetch/MediaFetcher.kt#L309-L346>)。

### 7.13 播放器的「源」抽象成 `VideoSource`（无状态位置）+ `VideoData`（有状态数据流）

**做法**：`VideoSource.open()` 返回 `VideoData`；`VideoData.createInput()` 返回可 `seek` 的输入流；`VideoData.close()`。
**为什么**：BT 场景下「打开」= 解析磁力/下种子，「读数据」= 边下边播；本地文件与 HTTP 流用同一套接口；`SeekableInput` 直接喂给 VLC/mpv。
**证据**：[`VideoSource.kt:28-44`](<_ref/ani/app/shared/video-player/src/commonMain/kotlin/data/VideoSource.kt#L28-L44>)、[`VideoData.kt:15-68`](<_ref/ani/app/shared/video-player/src/commonMain/kotlin/data/VideoData.kt#L15-L68>)（含 `supportsStreaming`、`computeHash` 用于弹幕匹配）。

### 7.14 解析失败用「枚举原因」而不是异常消息

**做法**：`VideoSourceResolutionException(reason: ResolutionFailures)`，`OpenFailures` 三个值；UI 映射成「解析超时 / 网络错误 / 未匹配到文件 / 不支持的视频类型」，未知错误才给堆栈弹窗。
**为什么**：用户需要可行动的提示；只有真 bug 才展示堆栈。
**证据**：[`VideoSourceResolver.kt:75-96`](<_ref/ani/app/shared/src/commonMain/kotlin/data/source/media/resolver/VideoSourceResolver.kt#L75-L96>)、[`VideoLoadingState.kt:36-77`](<_ref/ani/app/shared/src/commonMain/kotlin/ui/subject/episode/statistics/VideoLoadingState.kt#L36-L77>)、[`VideoLoadingState.kt:117-163`](<_ref/ani/app/shared/src/commonMain/kotlin/ui/subject/episode/statistics/VideoLoadingState.kt#L117-L163>)。

### 7.15 「站点条目 ↔ Bangumi 条目」用「打开候选详情页找 bgm 链接」来做权威对齐，并永久缓存

**做法**：蜜柑搜索 → 候选条目页 → 找「Bangumi番组计划链接」→ 比对 subjectId → 命中写缓存。
**为什么**：站点的标题是自由文本，靠名字匹配必然出错；而**详情页里的外链是站长自己维护的权威映射**。
**证据**：[`MikanMediaSource.kt:208-243`](<_ref/ani/data-sources/bt/mikan/src/commonMain/kotlin/MikanMediaSource.kt#L208-L243>)、[`MikanMediaSource.kt:184-206`](<_ref/ani/data-sources/bt/mikan/src/commonMain/kotlin/MikanMediaSource.kt#L184-L206>)、[`MediaSourceInstanceRepository.kt`](<_ref/ani/app/shared/src/commonMain/kotlin/data/repository/MikanIndexCacheRepository.kt>)（mikanIndexes DataStore）。

### 7.16 「解析标题」用逐词状态机 + 兜底规则，且默认用「保守解析器」

**做法**：`LabelFirstRawTitleParser`（只解析集数/分辨率/字幕/来源，不解析标题）+ 括号切词 + 集数正则 + 「BD 但没集数 → 季度全集」兜底 + 「内嵌/内封/外挂」判字幕类型。
**为什么**：解析标题错误率高但影响小（只影响显示），解析集数错误率高则直接影响能不能播；所以默认解析器**故意不解析标题**，注释写明「只解析剧集, 分辨率等必要信息, 不解析标题. 拥有更高正确率」。
**证据**：[`LabelFirstRawTitleParser.kt:29-80`](<_ref/ani/data-sources/api/src/commonMain/kotlin/topic/titles/LabelFirstRawTitleParser.kt#L29-L80>)、[`RawTitleParser.kt:45-52`](<_ref/ani/data-sources/api/src/commonMain/kotlin/topic/titles/RawTitleParser.kt#L45-L52>)、[`TorrentVideoSourceResolver.kt:101-164`](<_ref/ani/app/shared/src/commonMain/kotlin/data/source/media/resolver/TorrentVideoSourceResolver.kt#L101-L164>)（黑名单 `[SP]/[OVA]/PV/NCOP/NCED/OP\d+/ED\d+/[CM]` 排最后）。

### 7.17 一个数据源的失败绝不能拖垮整次查询（三级容错）

**做法**：① provider 内部 `catch → NoMatch`（弹幕）；② 源内部 `retry(3)` 后返回空；③ fetcher 层 `catch → state=Failed` 但不影响别的源。UI 明确显示「已查询 5/7」并提供单源"重试"。
**为什么**：聚合产品的核心价值是「总有一个源能用」，任何一处 `throw` 到顶层都是产品事故。
**证据**：[`DanmakuManager.kt:138-150`](<_ref/ani/app/shared/src/commonMain/kotlin/data/source/danmaku/DanmakuManager.kt#L138-L150>)、[`TreeStepWebMediaSource.kt:107-124`](<_ref/ani/data-sources/web/web-base/src/TreeStepWebMediaSource.kt#L107-L124>)、[`MediaFetcher.kt:190-205`](<_ref/ani/app/shared/src/commonMain/kotlin/data/source/media/fetch/MediaFetcher.kt#L190-L205>)、[`MediaSourceResultsView.kt:88-94`](<_ref/ani/app/shared/src/commonMain/kotlin/ui/subject/episode/mediaFetch/MediaSourceResultsView.kt#L88-L94>)。

### 7.18 收藏列表用「每类型一个可分页可持久化的 LazyDataCache」

**做法**：`LazyDataCache<T>` = 本地缓存 + 页码 + totalSize + 总持久化；`cachedDataFlow`（不触发网络）与 `allDataFlow`（自动翻页）分离；`mutate` 保证「先写盘再 emit」。
**为什么**：Bangumi 的收藏列表可能有几百条，但用户 90% 只看前 20 条；「打开即有内容、下拉才请求」是移动端基本要求；`mutate` 后立即可见保证「标记看过」后 UI 立即更新。
**证据**：[`LazyDataCache.kt:44-120`](<_ref/ani/app/shared/src/commonMain/kotlin/tools/caching/LazyDataCache.kt#L44-L120>)（类注释把「持久化与可见性」讲得很清楚）、[`SubjectManager.kt:252-282`](<_ref/ani/app/shared/src/commonMain/kotlin/data/models/subject/SubjectManager.kt#L252-L282>)。

### 7.19 「我的」不是一个页面，而是「收藏页 + 账号页」两个 tab

**做法**：`CollectionPage`（追番，5 个收藏类型 tab，含继续观看按钮）与 `ProfilePage`（账号/设置/帮助）分开。
**为什么**：用户最高频的动作是「继续看」，而不是「看账号」。把追番做成一级 tab，账号降级。
**证据**：[`HomeScene.kt:305-405`](<_ref/ani/app/shared/src/commonMain/kotlin/ui/main/HomeScene.kt#L305-L405>)、[`CollectionPage.kt:104-110`](<_ref/ani/app/shared/src/commonMain/kotlin/ui/subject/collection/CollectionPage.kt#L104-L110>)、[`ProfilePage.kt:59-92`](<_ref/ani/app/shared/src/commonMain/kotlin/ui/profile/ProfilePage.kt#L59-L92>)。

### 7.20 用「测试注入点」把领域逻辑与 UI 解耦（`enableCaching`、`EmptyForPreview`、`TestMediaList`）

**做法**：`DefaultMediaSelector(enableCaching = false)` 供测试关闭缓存；`MediaSelectorContext.EmptyForPreview`；`TestMediaList`；`rememberTestMediaSourceResults()`。
**为什么**：选择算法是本项目最复杂的纯逻辑，必须能在没有网络/UI 的情况下测；`enableCaching=false` 是因为 `shareIn` 会让测试的时序断言不稳定。
**证据**：[`MediaSelector.kt:149-157`](<_ref/ani/app/shared/src/commonMain/kotlin/data/source/media/selector/MediaSelector.kt#L149-L157>)、[`MediaSelectorContext.kt:37`](<_ref/ani/app/shared/src/commonMain/kotlin/data/source/media/selector/MediaSelectorContext.kt#L37>)、[`MediaSelectorPresentation.kt:162-181`](<_ref/ani/app/shared/src/commonMain/kotlin/ui/subject/episode/mediaFetch/MediaSelectorPresentation.kt#L162-L181>)。

---

## 8. 与最新 animeko 的已知差异

> 一半来自代码推断（本快照**缺少**什么），一半来自 animeko 官方文档（[media-source.md](https://github.com/open-ani/animeko/blob/main/docs/contributing/code/media/media-source.md)、[media-selector.md](https://github.com/open-ani/animeko/blob/main/docs/contributing/code/media/media-selector.md)，抓取时间 2026-11）。凡属推断或文档未覆盖的，明确标注「不确定」。

### 8.1 数据源订阅：从「硬编码 Kotlin 类」到「JSON 订阅 + 三种通用引擎」

| 维度 | 本快照 | 最新 animeko |
|---|---|---|
| 订阅文件 | **不存在** | `{"schemaVersion": 2, "mediaSources": [{ "id", "tags", "factoryId", "version", "arguments" }]}` |
| 通用 web 源 | 无（每站点一个 Kotlin 类） | `SelectorMediaSource`（`factoryId: "web-selector"`），CSS Selector + 正则 |
| 通用 JSON 源 | 无 | `JsonApiMediaSource`（三阶段请求模板 + JSONPath） |
| 通用 RSS 源 | `RssMediaSource`（URL 模板写在 `arguments.searchUrl`） | `RssMediaSource` 保留 |
| 类阶级 tier | **不存在** | `MediaSourceTier`（0 最高），`channelTiers`（v4.9+） |
| 数据源标签 | 不存在 | `tags`（如 `hls-ads`） |
| 手动浏览（browse） | 不存在（只有"自动匹配 + 列表展示"） | `supportsBrowsing`：搜索条目 → 线路/剧集 → 手动选集 |

**结论（高置信度）**：本快照的 `ThreeStepWebMediaSource`（`parseBangumiSearch` / `parseEpisodeList` / `createMediaMatch`）就是 `searchConfig.subjectFormat` / `channelFormat` / `matchVideo` 的 Kotlin 前身；`MediaSourceParameter` 就是 `arguments` schema 的前身；`WebVideoMatcher` 就是 `matchVideoUrl` 正则 + headers 的前身。

**「不确定」的地方**：`schemaVersion` 具体在哪个版本引入（推测 4.x）、`schemaVersion: 1` 与 `2` 的字段差异、`web-selector` 的完整字段名（`selectorSubjectFormat*` / `selectorChannelFormat*` 只是文档里的**类名前缀**，不是 JSON 字段名）。移植时若要与最新订阅生态兼容，必须直接读 animeko 当前源码，不要用本报告的猜测。

### 8.2 `fetch` 的语义变了（最重要的行为差异）

| 维度 | 本快照 | 最新 animeko |
|---|---|---|
| `MediaFetchRequest` | 携带**单个** `episodeSort`/`episodeEp`/`episodeName` | 携带条目的**全部剧集**；`episodes` 列表 |
| 源的职责 | 自己按集过滤（`definitelyMatches`） | 返回**整个条目**的全部资源，不裁剪 |
| 按集筛选 | 源 + 选择器 | **只在 `MediaSelector` 第 0 条规则** |
| 切集 | 重建整个 fetch session（重发所有请求） | 复用同一次查询结果，只重建 selector |
| 下载复用 | 每集重新查 | 多集复用同一次查询 |

依据：本快照 [`MediaFetchRequest.kt:12-61`](<_ref/ani/data-sources/api/src/commonMain/kotlin/source/MediaFetchRequest.kt#L12-L61>)、[`TreeStepWebMediaSource.kt:129-132`](<_ref/ani/data-sources/web/web-base/src/TreeStepWebMediaSource.kt#L129-L132>) vs 文档「数据源返回该条目在本源能找到的全部资源……不按当前剧集裁剪。按当前剧集筛选由 MediaSelector 完成」。

**移植建议**：直接用新语义（源返回整条目、选择器过滤），因为它的网络开销与切集体验都明显更好。代价是 `MediaSource.fetch` 的入参要改。

### 8.3 选择器：从「四层 DFS」到「过滤 → 排序 → 偏好 → 选择」四阶段 + 计时器分阶段

| 维度 | 本快照 | 最新 animeko |
|---|---|---|
| 结构 | 一个 `DefaultMediaSelector` 类（619 行） | `MediaSelectorFilterSortAlgorithm`（纯函数）+ `MediaAutoSelector`（决策循环） |
| 排序 | 字幕类型 → 下载代价 → 发布时间 | 是否被排除 → 播放器兼容 → 资源类型 → 下载代价 → **tier** → 发布时间 → **名称相似度** |
| 过滤 | 4 条规则 | 第 0 条「当前集匹配」+ 多条，且**携带排除原因** `MediaExclusionReason` |
| 自动选择 | `awaitCompletedAndSelectDefault`（等全部完成）| `MediaAutoSelector.select`：缓存优先 → 记忆源 → **两段截止时间**（0-5s 只选 tier0 精确匹配、5-15s 所有 tier 精确匹配、15s 后允许模糊） |
| 失败换源 | **无自动换源** | `select` 复用同一入口，两个截止时间均为 1 秒，带黑名单 |
| 浏览记忆 | 无 | 命中即完成选择（`BrowseChannel` 位置记忆）|
| 拆分季后半 | 不支持 | 季内序号规则（`EpisodeMatchKind.SEASON`）|

依据：文档 media-selector.md；本快照 [`MediaSelector.kt:196-256, 375-539`](<_ref/ani/app/shared/src/commonMain/kotlin/data/source/media/selector/MediaSelector.kt#L375-L539>)、[`MediaSelectorAutoSelect.kt:31-39`](<_ref/ani/app/shared/src/commonMain/kotlin/data/source/media/selector/MediaSelectorAutoSelect.kt#L31-L39>)。

**值得注意**：最新文档承认自家 4.8.0「总是优先 sort」是错的（[issue #1448](https://github.com/open-ani/animeko/issues/1448)），而这正是本快照的行为（种子内文件选择先 sort 后 ep）。所以**「精确匹配条目时优先 ep」是后来才修的方向**，移植时应实现修正版。

### 8.4 集数/进度：从「无本地进度」到「有本地数据层」

本快照：无 `EpisodeRecord`、无播放位置存储（§5.5、§6.3）。

最新 animeko：文档路径出现 `app/shared/app-data/src/commonMain/kotlin/domain/...`，说明数据层已被重构为独立的 `app-data` 模块，并出现「批量下载」（`media-downloads.md`）、「下载记录反序列化」等概念。**「不确定」**：最新版是否新增了 `EpisodeRecord`/`EpisodeHistory` 表、字段是什么、是否存在秒级续播 —— 本报告无法从这份 2024-09 的代码推断，需要读最新源码确认。

可以确定的是：**本快照的「进度」= Bangumi 的 per-episode WATCHED 布尔值**；若目标产品需要秒级续播，这是必须新增的模块，不属于「移植」。

### 8.5 播放器与弹幕

- VLCJ → **mediamp-mpv**：搜索结果里提到的 `mediamp-mpv` 是 animeko 现用的播放器抽象（`selector_run_step ... probe_video` 部分提到「Animeko 桌面端同款播放器（mediamp-mpv）」）。本快照桌面端是 VLCJ（[`AniDesktop.kt:208-212, 230-237`](<_ref/ani/app/desktop/src/main/kotlin/AniDesktop.kt#L208-L212>)）。**「不确定」**：迁移版本号。
- 弹幕：本快照是 `DanmakuManager` + 2 个 provider（弹弹play + Ani 自建）。最新文档提到弹幕匹配新增了「拆分季」规则（`SplitSeasonDanmakuMatcher`），说明 provider 架构还在，但匹配算法复杂化了很多。
- 跳过 OP/ED：本快照是「章节时长启发式」（§4.6）。最新文档未提此功能，**「不确定」**是否已移除或重做。

### 8.6 其它可推断的架构变化

| 项 | 本快照 | 最新（据文档路径推断，**中等置信度**） |
|---|---|---|
| 模块划分 | `app/shared` 单体（`data/` + `ui/` + `video-player/`） | `app/shared/app-data`、`datasource/api`、`datasource/*` 分离 |
| 数据源包名 | `me.him188.ani.datasources.*`，目录 `data-sources/` | `datasource/`（文档链接 `../../../../datasource/api/src/commonMain/kotlin/Media.kt`） |
| 选择器命名 | `MediaSelector.trySelectDefault()` | `MediaAutoSelector.select` / `trySelectFromMediaSources` / `selectTemporarily` |
| 订阅管理 | 无 | `MediaSourceSubscription` / `MediaSourceSubscriptionUpdater`（含启用状态、事务内应用差异） |
| HLS 广告过滤 | 无 | `hls-ads` tag + `HlsAdFilteringMode` |
| `WebVideo` | `(uri)` | `(uri, apiParameters)` —— 为 JSON API 源传递播放请求变量 |

### 8.7 「本快照独有、最新可能已删除」的东西

- `PatternBasedRawTitleParser`（389 行手写规则，当前非默认）。最新文档未提标题解析器，可能已废弃。
- `ThreeStepWebMediaSource` + 5 个复制粘贴的 web 源类。已被 `SelectorMediaSource` 取代。
- `gugufan`/`nyafun`/`ntdm`/`mxdongman`/`xfdm` 五个硬编码站点。已改为订阅。
- `RssMediaSource` 的 `{keyword}`/`{page}` 模板（已被结构化 RSS 订阅取代，但 RSS 类型仍在）。

---

## 附录 A：关键调用链伪代码（TS 风格，便于移植）

```ts
// ===== 1. 播放页初始化 =====
const episodeInfo = subjectManager.episodeInfoFlow(episodeId)     // Bangumi 缓存 -> DTO -> EpisodeInfo
const request = MediaFetchRequest.create(subjectInfo, episodeInfo)
const session = mediaFetcher.newSession(request)                  // 惰性
const selector = mediaSelectorFactory.create(subjectId, session.cumulativeResults)

// 三路自动选择（并发）
void autoSelect.awaitCompletedAndSelectDefault(session)   // 等全部 -> 按偏好选
void autoSelect.selectCached(session)                     // 有缓存立刻选
void autoSelect.autoEnableLastSelected(session)           // 自动启用上次的源
// 用户选择 -> 保存偏好
selector.events.onChangePreference.debounce(1000).on(savePreference)

// ===== 2. 单个源 =====
class MediaSourceResult {
  state = Idle | Disabled | Working | PendingSuccess | Succeed | Failed | Abandoned
  results = flow {                          // 惰性, shareIn(replay=1)
    state = Working
    for await (const media of source.fetch(request).results) yieldAll(acc.push(media).distinctBy(mediaId))
    state = Succeed
  }.catch(e => state = Failed(e))
  restart() { state = Idle; version++ }     // 触发 flatMapLatest 重跑
}

// ===== 3. 选择 =====
const mediaList = combine(list, defaultPref, settings, context)
  .map(([l, p, s, c]) => filterMediaList(l, p, s, c).sort(bySubtitleKindThenCostThenPublishedTime))

const candidates = mediaList.filter(m =>
  pref.alliance == null || pref.alliance === m.properties.alliance)
  /* 同 resolution / subtitleLanguageId(∈ list) / mediaSourceId */

function trySelectDefault() {
  for (const resolution of [pref.resolution ?? ...pref.fallbackResolutions])
    for (const lang of [pref.subtitleLanguageId ?? ...pref.fallbackSubtitleLanguageIds])
      for (const alliance of [pref.alliance ?? ...matchedPatterns ?? '*'])
        for (const source of [pref.mediaSourceId ?? ...context.mediaSourcePrecedence ?? null])
          if (grouped.length) return pick(grouped)
  return pick(candidates)   // 兜底
}

// ===== 4. 播放 =====
selector.selected.on(async media => {
  player.clearVideoSource()
  try {
    const source = await resolver.resolve(media, { title, ep, sort })
    await player.setVideoSource(source)
  } catch (e) { loadingState = mapError(e) }
})

// ===== 5. 自动行为 =====
player.state.on(FINISHED, () => { if (config.autoPlayNext && hasNextEpisode) switchTo(nextEpisode) })
player.position.sample(5000, () => {
  if (config.autoMarkDone && playing && pos > duration * 0.9) markDone(episodeId)
})
```

## 附录 B：建议的 TS 类型草案（直接对应 Kotlin）

```ts
// ---- 数据源 ----
export type FactoryId = string & { readonly __brand: 'FactoryId' }
export type MediaSourceId = string   // "dmhy" | "nyafun" | "local-file-system"

export interface MediaSourceInfo { displayName: string; description?: string; websiteUrl?: string; iconUrl?: string }
export type MediaSourceKind = 'WEB' | 'BitTorrent' | 'LocalCache'
export type MediaSourceLocation = 'ONLINE' | 'LAN' | 'LOCAL'

export interface MediaSourceConfig {
  proxy?: { url: string; authorization?: string }
  userAgent?: string
  arguments: Record<string, string | null>   // 参数名 -> 字符串值
}

export interface MediaFetchRequest {
  subjectId: string
  episodeId: string
  subjectNameCN?: string | null
  subjectNames: Set<string>
  episodeSort: EpisodeSort
  episodeName: string
  episodeEp: EpisodeSort | null
}

export interface MediaMatch { media: Media; kind: 'EXACT' | 'FUZZY' }

// ---- 集号 ----
export type EpisodeType = 'MainStory' | 'SP' | 'OP' | 'ED' | 'PV' | 'MAD' | 'OVA' | 'OAD'
export type EpisodeSort =
  | { kind: 'normal';  number: number }
  | { kind: 'special'; type: EpisodeType; number: number | null }
  | { kind: 'unknown'; raw: string }

export type EpisodeRange =
  | { kind: 'empty' }
  | { kind: 'single'; value: EpisodeSort }
  | { kind: 'range'; start: EpisodeSort; end: EpisodeSort }
  | { kind: 'combined'; first: EpisodeRange; second: EpisodeRange }
  | { kind: 'season'; rawNumber: number }   // -1 = 未知季度

// ---- 资源 ----
export type ResourceLocation =
  | { kind: 'magnet'; uri: string }
  | { kind: 'httpTorrentFile'; uri: string }
  | { kind: 'httpStreamingFile'; uri: string }
  | { kind: 'webVideo'; uri: string }
  | { kind: 'localFile'; filePath: string; uri: string }

export type SubtitleKind = 'EMBEDDED' | 'CLOSED' | 'EXTERNAL_PROVIDED' | 'EXTERNAL_DISCOVER' | 'CLOSED_OR_EXTERNAL_DISCOVER'

export interface MediaProperties {
  subtitleLanguageIds: string[]   // "CHS" | "CHT" | "JPN" | "ENG" | "CHC"
  resolution: string              // "720P" | "1080P" | "2K" | "4K" | ""
  alliance: string
  size: number                    // bytes; 0 = 未知
  subtitleKind: SubtitleKind | null
}

export interface Media {
  mediaId: string
  mediaSourceId: MediaSourceId
  originalUrl: string
  download: ResourceLocation
  episodeRange: EpisodeRange | null
  originalTitle: string
  publishedTime: number
  properties: MediaProperties
  extraFiles: { subtitles: { uri: string; mimeType?: string; language?: string }[] }
  location: MediaSourceLocation
  kind: MediaSourceKind
}

// ---- 领域 ----
export type UnifiedCollectionType = 'WISH' | 'DOING' | 'DONE' | 'ON_HOLD' | 'DROPPED' | 'NOT_COLLECTED'

export interface EpisodeInfo {
  id: number; type: EpisodeType | null; name: string; nameCn: string
  airDate: string | null; comment: number; duration: string; desc: string; disc: number
  sort: EpisodeSort; ep: EpisodeSort | null
}

export interface SubjectInfo {
  id: number; name: string; nameCn: string; summary: string
  nsfw: boolean; locked: boolean; platform: string
  volumes: number; eps: number; totalEpisodes: number
  tags: { name: string; count: number }[]
  airDateString: string | null
  infobox: { name: string; values: string[] }[]
  imageCommon: string; imageLarge: string
  collection: { wish: number; doing: number; done: number; onHold: number; dropped: number }
  ratingInfo: { rank: number; total: number; score: string; count: number[] }
}

export interface EpisodeCollection { episodeInfo: EpisodeInfo; collectionType: UnifiedCollectionType }
export interface SubjectCollection {
  info: SubjectInfo
  episodes: EpisodeCollection[]   // 按 sort 升序
  collectionType: UnifiedCollectionType
  selfRatingInfo: { score: number; comment: string | null; tags: string[]; isPrivate: boolean }
}

export interface MediaPreference {
  alliance: string | null
  alliancePatterns: string[] | null
  resolution: string | null
  fallbackResolutions: string[] | null
  subtitleLanguageId: string | null
  fallbackSubtitleLanguageIds: string[] | null
  showWithoutSubtitle: boolean
  mediaSourceId: string | null
}
```

## 附录 C：本报告引用的关键文件索引

| 主题 | 文件 | 行数 |
|---|---|---|
| 数据源接口 | `data-sources/api/src/commonMain/kotlin/source/MediaSource.kt` | 133 |
| 数据源工厂/配置 | `data-sources/api/src/commonMain/kotlin/source/MediaSourceFactory.kt` | 84 |
| 资源模型 | `data-sources/api/src/commonMain/kotlin/Media.kt` | 311 |
| 请求/匹配 | `data-sources/api/src/commonMain/kotlin/source/MediaFetchRequest.kt`、`MediaMatch.kt` | 105 / 46 |
| 集号/集范围 | `data-sources/api/src/commonMain/kotlin/EpisodeSort.kt`、`EpisodeType.kt`、`topic/EpisodeRange.kt` | 191 / 16 / 281 |
| 下载位置 | `data-sources/api/src/commonMain/kotlin/topic/ResourceLocation.kt` | 82 |
| BT 中间模型 | `data-sources/api/src/commonMain/kotlin/topic/Topic.kt`、`TopicCriteria.kt`、`TopicMediaSource.kt` | 87 / 45 / 80 |
| 标题解析 | `data-sources/api/src/commonMain/kotlin/topic/titles/*` | 111 / 327 / 389 |
| web 三段式基类 | `data-sources/web/web-base/src/TreeStepWebMediaSource.kt` | 140 |
| web 实例 | `data-sources/web/nyafun/src/NyafunMediaSource.kt`、`gugufan/src/GugufanMediaSource.kt` | 231 / 136 |
| web 视频匹配 | `data-sources/api/src/commonMain/kotlin/matcher/WebVideoMatcher.kt` | 41 |
| Bangumi 客户端 | `data-sources/bangumi/src/commonMain/kotlin/BangumiClient.kt` | 350 |
| Bangumi 搜索分页 | `data-sources/bangumi/src/commonMain/kotlin/BangumiPagedSource.kt` | 134 |
| Bangumi 仓库 | `app/shared/src/commonMain/kotlin/data/repository/BangumiSubjectRepository.kt`、`BangumiEpisodeRepository.kt` | 236 / 197 |
| 领域模型 | `app/shared/src/commonMain/kotlin/data/models/subject/*`、`data/models/episode/*` | 多文件 |
| 收藏/进度中枢 | `app/shared/src/commonMain/kotlin/data/models/subject/SubjectManager.kt` | 585 |
| 多源查询 | `app/shared/src/commonMain/kotlin/data/source/media/fetch/*` | 360+103+100+100+… |
| 选择器 | `app/shared/src/commonMain/kotlin/data/source/media/selector/MediaSelector.kt` | 619 |
| 源实例管理 | `app/shared/src/commonMain/kotlin/data/source/media/fetch/MediaSourceManager.kt` | 264 |
| 源配置持久化 | `app/shared/src/commonMain/kotlin/data/repository/MediaSourceInstanceRepository.kt` | 109 |
| 订阅雏形（RSS） | `app/shared/src/commonMain/kotlin/data/source/media/source/RssMediaSource.kt` | 227 |
| 解析器链 | `app/shared/src/commonMain/kotlin/data/source/media/resolver/*` | 多文件 |
| 播放页 VM | `app/shared/src/commonMain/kotlin/ui/subject/episode/EpisodeViewModel.kt` | 689 |
| 播放器接口 | `app/shared/video-player/src/commonMain/kotlin/ui/state/PlayerState.kt` | 524 |
| 弹幕 | `danmaku/api/src/commonMain/kotlin/*`、`danmaku/dandanplay/src/DandanplayDanmakuProvider.kt` | 178+…/268 |
| 持久化 | `app/shared/src/commonMain/kotlin/data/persistent/SettingsStore.kt`、`data/repository/SettingsRepository.kt` | 83 / 224 |
| DI | `app/shared/src/commonMain/kotlin/platform/CommonKoinModule.kt` | 315 |

---

### 最后：给「聚合浏览器」移植的三条硬建议

1. **不要照搬 `MediaFetchRequest` 的单集语义。** 直接采用 animeko 新语义（源返回整个条目、选择器按集过滤），否则每次切集都会重发 7~10 个网络请求，Electron 端体验会很差，而且无法支持「批量下载」。
2. **一定要新增本地 `episode_progress` 表。** 本快照靠 Bangumi 的布尔值做进度，导致「看到 60% 下次从 0 开始」。目标产品若强调「续播」，这是刚需；字段建议 `(subjectId, episodeId, positionMillis, durationMillis, mediaId, sourceId, updatedAt)` 并 unique(subjectId, episodeId)。
3. **把「选源」做成纯函数 + 可录制回放。** 本快照的 `DefaultMediaSelector` 埋了 `enableCaching`、`EmptyForPreview` 等测试钩子，但它仍然是个大对象。移植时用一个 `(candidates, preference, settings, context) => Media | null` 的纯函数，把「网络/缓存/时序」全部留在外面，这样选源算法才能被单元测试覆盖 —— 这也是 animeko 后来把 `MediaSelectorFilterSortAlgorithm` 抽出去的原因。
