# koishi-plugin-foxy-daily

基于 **Foxy Memory** 或 **LivingMemory** 的 QQ 空间每日动态插件：从记忆生成动态、定时或手动发布、读取评论、自动或手动回复评论，并把「发动态、读评论、回复评论」注册成 ChatLuna 工具与 chatluna-character 的 reply 字段。

每日动态与记忆窗口的思路参考了 `koishi-plugin-chatluna-livingdiary`；本插件是独立实现，不修改 `livingdiary` 或 `qzone`。感谢原作者。

## 功能

- 从 Foxy Memory 读取指定 `presetId` 的记忆，生成每日动态。
- 支持定时发布、06:00 前补发前一天、手动指定单日或日期区间。
- 发布失败写入状态文件，指数退避重试；`unknown` 先读回确认，避免重复动态。
- 自动读取并回复机器人自己动态下的评论和楼中楼。
- 可选读取白名单用户动态下的评论，并可选择是否回复楼中楼。
- ChatLuna 工具与 Character reply 字段：`qzone_publish`、`qzone_comments`、`qzone_reply`。
- 即时命令：列出未回复评论、立即回复一轮、立即自动点赞、立即读取空友爱看。
- 自动给好友新动态点赞，支持作者白名单/黑名单。
- 测试功能：NapCat「空友爱看」公开动态，模型判断喜欢后点赞/评论，默认关闭。
- 可选表情包配图：开启后按动态的 `mood` 关键词从 ChatLuna Memes 挑选表情包；未安装该插件时自动跳过。

## 依赖

- Koishi `^4.18`
- `koishi-plugin-chatluna`（生成动态/回复；可选安装，但启用每日动态时需要）
- `koishi-plugin-chatluna-foxy-memory`（新版 Foxy 记忆，读取记忆与人设）
- `koishi-plugin-chatluna-livingmemory`（旧版 LivingMemory，读取记忆与人设）
- 一个能提供 QQ 空间 Cookie 的协议端：OneBot 11 / NapCat（`get_cookies`）或 Milky（`.cookies`）
- `qzone-sdk@^0.3.3`（插件依赖）

## 安装

```powershell
npm install koishi-plugin-foxy-daily
```

安装后在 Koishi 控制台启用，至少填写 `allowUserIds`，并从下拉框选择 `digestModel` 与 `personaPresetId`。

模型下拉来自 ChatLuna 的 `modelSchema`；ChatLuna 预设下拉来自 ChatLuna 的 `preset` schema，Character 预设下拉来自 `chatluna-character` 的 `character-preset` schema。三个列表都由对应插件维护，本插件只引用，不需要手填模型名或预设名。若对应服务未安装，配置会退化为 `preset` / 空模型。

## 配置

### 基础

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `platform` | `auto` | 获取 QQ 空间 Cookie 的协议：`auto` / `onebot` / `milky` |
| `selfId` | 空 | 指定机器人；留空自动选在线机器人 |
| `allowUserIds` | `[]` | 允许使用指令和工具的用户 QQ；**为空时全部拒绝** |
| `watchUserIds` | `[]` | 额外读取动态的白名单 QQ（只读） |
| `stateFile` | `data/foxy-daily/state.json` | 发布/评论/点赞幂等状态 |
| `debug` | `false` | 调试日志 |

### 每日动态

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `enableDailyDigest` | `true` | 开启每日动态 |
| `digestTime` | `23:50` | 每日触发时间，服务器本地时区 |
| `digestMemoryLimit` | `100` | 单次使用的记忆条数上限 |
| `digestPrompt` | 空 | 追加到每日动态提示词后的自定义要求；留空使用内置 |
| `personaKind` | `character` | 使用哪套预设：`character` 用 Character 伪装插件预设，`chatluna` 用 ChatLuna 主插件预设 |
| `personaPresetId` | `preset` | ChatLuna 主插件预设，下拉来自 ChatLuna 的 `preset` schema |
| `characterPresetId` | `preset` | Character 伪装插件预设，下拉来自 `chatluna-character` 的 `character-preset` schema |
| `memoryBackend` | `auto` | 记忆后端：`auto` 优先 Foxy Memory、回退 LivingMemory；也可显式选 `foxy-memory` 或 `livingmemory` |
| `persona` | 空 | 记忆服务不可用时的备用人设 |
| `digestModel` | 空 | 下拉自动列出 ChatLuna 模型；也可手填 `deepseek/deepseek-flash` |
| `catchUpPreviousDay` | `true` | 06:00 前补发前一天 |

### 评论

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `enableCommentAutoReply` | `true` | 自动回复机器人自己动态下的新评论 |
| `commentPollIntervalMinutes` | `5` | 评论轮询间隔（m） |
| `commentMaxAgeHours` | `72` | 只回复这个时间内的评论（h） |
| `commentMaxRepliesPerRound` | `3` | 每轮最多自动回复条数 |
| `commentMaxAttempts` | `3` | 单条评论最大尝试次数 |
| `autoReplyAllCommenters` | `true` | 自己动态下：关闭后只回复 `allowUserIds` 中的评论者 |
| `replyOwnNested` | `true` | 自己动态下：也回复楼中楼 |
| `nestedReplyOnlyToBot` | `true` | 楼中楼只回复明确回复机器人自己的那条 |
| `enableOtherPostComments` | `false` | 允许读取/回复白名单用户动态下的评论 |
| `otherPostCommentUserIds` | `[]` | 允许评论其动态的 QQ；为空时使用 `watchUserIds` |
| `replyOtherNested` | `false` | 别人动态下：也回复楼中楼 |
| `otherPostReplyAllCommenters` | `true` | 别人动态下：关闭后只回复 `allowUserIds` |
| `monitorPostLimit` | `10` | 每轮检查的最近动态数 |
| `checkOnQzoneNotice` | `true` | 收到空间评论 notice 时立即检查；协议端需支持 `qzone_comment` |

### 自动点赞

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `enableAutoLike` | `false` | 给好友新动态自动点赞 |
| `autoLikeIntervalMinutes` | `10` | 轮询间隔 |
| `autoLikeFeedLimit` | `20` | 每轮读取的好友动态数 |
| `autoLikeMaxPerRound` | `5` | 每轮最多点赞条数 |
| `autoLikeUserIds` | `[]` | 只点赞这些作者；为空表示所有好友 |
| `autoLikeBlockUserIds` | `[]` | 永不点赞这些作者，优先级高于白名单 |

### 空友爱看（测试）

需要 **NapCat 4.18.42+** 的公共动态扩展 action；其他协议端会降级为“不支持”，不影响每日动态和评论。

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `enablePublicFeed` | `false` | 开启空友爱看 |
| `publicFeedLike` | `true` | 遇到喜欢的内容自动点赞 |
| `publicFeedReply` | `false` | 遇到喜欢的内容自动评论（实验性） |
| `publicFeedMaxPerRound` | `3` | 每轮最多处理条数 |
| `publicFeedModel` | 空 | 判断“喜欢”的模型；留空使用 `digestModel` |
| `publicFeedNotifyUserId` | 空 | 把互动推送到这个 QQ；留空不推送 |
| `publicFeedPollIntervalMinutes` | `30` | 轮询间隔 |

### 工具与配图

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `toolEnabled` | `true` | 注册 ChatLuna 工具 |
| `characterToolEnabled` | `true` | 注册 chatluna-character reply 字段 |
| `enableMemeImage` | `false` | 是否附带 chatlunamemes 表情包；需安装 `koishi-plugin-chatluna-memes`，未安装时自动跳过 |
| `maxImages` | `9` | 单条动态最多图片数 |

## 指令

| 指令 | 说明 |
| --- | --- |
| `daily` | 列出全部指令、功能与示例 |
| `daily.status` | 查看状态、待重试任务、QQ 空间登录态 |
| `daily.publish [from] [to]` | 手动发布；示例 `daily.publish 2026-11-03`、`daily.publish 2026-11-01 2026-11-03` |
| `daily.comments [postId]` | 读取自己及白名单动态的评论；示例 `daily.comments 1234567890` |
| `daily.reply <postId> <commentId> <content>` | 手动回复一条评论；示例 `daily.reply 1234567890 9876543210 谢谢你的评论` |
| `daily.unreplied` | 列出尚未回复的评论 |
| `daily.replynow` | 立即读取并回复一轮 |
| `daily.like` | 立即执行一轮自动点赞（需开启 `enableAutoLike`） |
| `daily.public` | 立即读取空友爱看（需开启 `enablePublicFeed`） |
| `daily.retry` | 立即重试待发布任务 |

所有指令都要求 `session.userId` 在 `allowUserIds` 中。

## ChatLuna / Character 工具

- `qzone_publish`：`{ content?, date? }`；`content` 为空时从 Foxy Memory 生成。
- `qzone_comments`：`{ post_id? }`；读取评论。
- `qzone_reply`：`{ post_id, comment_id, content }`；回复评论。

chatluna-character 的 reply 字段同名，均为数组；模型填数组，插件执行并渲染 `<qzone_* ... />`。工具授权同样使用 `allowUserIds`。

## 记忆窗口与幂等

- 每日默认窗口：当天 00:00 到当前时间；06:00 前自动改为前一天。
- 手动单日取该日 00:00–23:59；手动区间会合并两天的记忆。
- 只读取 `personaPresetId` 下 `status=active` 的记忆，按 `createdAt` 过滤；`personaKind=character` 时会自动拼成 `preset（Character）`，不会误读主插件记忆。不会改 Foxy Memory 的向量索引。
- 发布成功后 `published[date]` 阻止重复发布；模型跳过时写 `skipped[date]`。
- 发布失败写 `pending`，5 分钟起指数退避，封顶 6 小时；进程重启后继续。
- `unknown` 结果先读自己的最近动态，按正文精确匹配；确认存在则记为已发布，不直接重发。

## 评论

- 自己动态：默认回复一级评论和楼中楼；`nestedReplyOnlyToBot` 控制楼中楼是否只回复“回复机器人”的那条。
- 别人动态：默认不读；开启 `enableOtherPostComments` 并配置 `otherPostCommentUserIds`（或 `watchUserIds`）后，可读取/回复其动态下的评论；`replyOtherNested` 控制楼中楼。
- 跳过：自己发的评论、已处理/处理中/unknown/skipped、超过 `commentMaxAgeHours` 的评论。
- 每条评论在 `state.comments[postId][commentId]` 记录状态，避免重复回复。
- 空间评论没有统一的原生推送；若协议端支持 `qzone_comment` notice，`checkOnQzoneNotice` 会立即触发一次检查，否则仍按 `commentPollIntervalMinutes` 轮询。

## 自动点赞

- 读取好友动态流，按 `autoLikeUserIds` / `autoLikeBlockUserIds` 过滤。
- 跳过自己、已处理、超出 `autoLikeMaxPerRound` 的动态。
- 点赞结果写入 `state.likes`，失败不会自动重试同一轮，下一轮会重新检查。

## 空友爱看（测试）

- 通过 `bot.internal._request` 调用 NapCat 的 `get_qzone_public_feeds`、`set_qzone_public_like`、`comment_qzone_public_feed`。
- **空友爱看是推荐流，不是发布目标**：NapCat 目前没有“把一条自己的新动态发布到空友爱看”的 action；本插件只能读取推荐流并点赞/评论/转发，不能把机器人的新动态塞进推荐流。
- 模型输出 `{ like, reply }`；只有开启对应开关才执行。
- `feedKey` 优先取 `cell_common.union_id.feed_id`，否则用内容哈希；每条状态写入 `state.publicFeeds`。
- 这是测试功能：接口和字段可能随 NapCat 版本变化；失败只记日志，不影响其他功能。

## 配图

配图强绑定 `koishi-plugin-chatluna-memes`，只需要开一个开关：

```yaml
enableMemeImage: true
maxImages: 9
```

每日动态的 `publish_daily_digest` 工具会给出可选 `mood` 字段（1-3 个关键词）。插件用 `mood` 在 ChatLuna Memes 的全部表情包里搜索；找不到就随机取一张。不需要选择表情包名、路径或 provider。未安装 `koishi-plugin-chatluna-memes`、服务不可用或取图失败时只记日志，不影响文字发布。

## 限制

- QQ 空间 Cookie 会过期；过期后需要协议端重新登录，插件会尝试重新获取。
- 自动回复的“实时”取决于协议端是否发 `qzone_comment` notice；没有 notice 时只能轮询。
- `qzone-sdk` 的发布结果可能是 `accepted`（已接受未读回），插件按成功记录；若需要严格读回，可自行改为等待。
- 空友爱看需要 NapCat 4.18.42+；其他协议端不支持时只记日志。
- 动态生成质量取决于模型与记忆质量；`digestModel` 建议使用支持 tool calling 的模型。
- 插件使用服务器本地时区计算“今天/昨天/区间”；跨时区部署需自行调整。
- 未在真实 QQ 空间账号上做发布测试（需要有效 Cookie）；测试覆盖窗口、状态、评论筛选、点赞、空友爱看和工具注册。

## 测试

```powershell
npm test
```

当前 22 个用例通过：窗口计算、日期区间、记忆过滤、状态持久化、Cookie 解析、评论筛选/楼中楼/他人动态、点赞白黑名单、空友爱看、Character 预设后缀、chatlunamemes 配图、摘要工具校验、配图归一化、发布成功/失败/unknown、动态配置默认值、daily 指令注册与帮助列表，以及重复评论 id/旧状态归属。

## License

MIT
