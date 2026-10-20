# st-fishaudio-tts

SillyTavern 扩展：把 **Fish Audio** 接成一个配音渠道（TTS Provider）。

这是我从自建的 dsh 酒馆里剥离出来的配音能力，做成独立扩展，装到任何 SillyTavern 都能用。
装好后「TTS」设置里的渠道下拉框会多出 **Fish Audio**，选中即可按角色分配声音。

## 安装

SillyTavern → 顶栏「扩展」→ **Install extension**，填：

```
https://github.com/Menkelo/st-fishaudio-tts
```

刷新页面后，打开顶栏「扩展设置」，会多出一个 **Fish Audio TTS（配音）** 面板——配置和自检都在这个面板里，不用去翻 TTS 的子设置。

**前置条件**：官方的 **TTS** 扩展必须处于启用状态（本扩展靠它注册渠道）。

## 必须先开 CORS 代理

Fish Audio 的接口**不返回跨域许可头**，浏览器直连会被拦。
扩展统一走 SillyTavern 自带的 `/proxy/` 转发。在 `config.yaml` 里改成：

```yaml
enableCorsProxy: true
```

然后重启 SillyTavern。

## 配置

在 **Fish Audio TTS（配音）** 面板里填：

| 项目 | 说明 |
| --- | --- |
| Fish Audio 密钥 | 你的 API Key |
| 模型 | 默认 `s2.1-pro-free`（免费额度对应的模型） |
| 默认声音 ID | `reference_id`，可用「读取我的声音列表」拉取 |
| 走 SillyTavern 代理 | 默认开，关掉会跨域失败 |

填完点 **启用配音**：它会自动把 TTS 渠道切到 Fish Audio 并打开总开关，省得自己去翻。
想先确认链路通不通，点 **测试配音**，面板里会直接播一段合成语音并显示大小。

点 **读取声音列表** 会把账号下的声音拉进下拉框，再在「扩展」→「TTS」→「角色声音」里逐个分配。

## 关键细节：模型名必须走请求头

Fish Audio 的免费模型 `s2.1-pro-free` **必须放在请求头 `model`** 里。
放进请求体会直接返回 `402 余额不足`——这是最容易踩的坑，本扩展已经处理好了。

## 用法

就是 SillyTavern 原生的 TTS 用法：

- 点面板里的 **启用配音**（或自己在「TTS」面板选 Fish Audio 并打开总开关）
- 勾选「自动朗读」或手动点每条消息上的朗读按钮
- 在「角色声音」里给每个角色分配 voice id，旁白也要单独指定，否则旁白不出声

## 点引号句直接朗读

开启面板里的 **「点引号句直接朗读」**（默认开）后，聊天里被引号包住的台词会显示一条淡淡的虚线下划线：

> “坐吧。”  ← 鼠标移上去会高亮，点一下就念这一句

支持的引号：`“”` `「」` `『』` `«»` `‘’` `""`。点哪句念哪句，动作描写和旁白不会被念。

这条路径**不经过** SillyTavern 的朗读队列，自己合成、自己播放。所以它不受朗读键隐藏、声音映射缺失、自动播放开关影响，是「只念某一句台词」最省事的方式。

## 手机 / TauriTavern 必须填中转地址

**Fish Audio 的 `/v1/tts` 不返回 `Access-Control-Allow-Origin`**，而 `/wallet`、`/model` 这两个接口却返回。所以浏览器（含 TauriTavern 的 webview）拿到音频后仍然会拒收。

这不是网络问题，**开代理软件（梯子）解决不了**：代理管的是数据包能不能到，CORS 是服务器回包里的许可声明。

网页版 SillyTavern 靠自带的 `/proxy/` 绕过去了。TauriTavern 没有这个路由，所以要在面板里填 **中转地址**：

```
http://<NAS的局域网IP>:8090
```

中转服务会代替浏览器请求 Fish Audio，回来时补上跨域许可头。

## 逐句朗读 / 只念台词

面板里有 **点击播放** 和 **逐句朗读** 两个开关。

**点击播放**（默认不开）：只有你点消息上的朗读键才念，新回复不自动开口。想要自动朗读就关掉它。

**逐句朗读**：每条回复按行拆开，对话 / 动作 / 旁白分开念，而不是整段一口气念完。

再往下是 **每个角色念什么**，每个角色三个选项：

| 选项 | 效果 |
| --- | --- |
| 全部朗读 | 对话、动作、旁白都念 |
| 只念引号句 | 只念这个角色说出口的话（`"..."` 里的内容），动作和旁白跳过 |
| 不朗读 | 这个角色完全不出声 |

选「只念引号句」会自动打开逐句朗读——关着的话这些分轨设置根本不会被查。

实测一条五个段落的回复，在「只念引号句」下只有三句引号台词发出了合成请求，动作描写和旁白一句都没发。

### 不该念的段落不会发请求

SillyTavern 在多数情况下自己就会跳过标记为 `disabled` 的段落。但这个判断发生在 ST 内部，不同版本/配置下未必走到那一步，可能仍把文字交给渠道去合成。

所以扩展在**真正发 HTTP 之前**又加了一道：`generateTts` 收到段类型后先查一遍，不该念的直接返回一段本地生成的 120ms 静音 WAV，**一个字节的请求都不发**，也不消耗 Fish Audio 的额度。

面板底部会实时显示：

```
本次会话：发出 3 次合成请求，在本地挡掉 2 段不该念的内容
最近：🔊 坐下吧，茶还热着。 ｜ 🚫 窗外的风把她的话吹散了。 ｜ 🔊 你终于来了。
```

如果「挡掉」一直显示 0 而你不该念的段落却在出声，说明是 ST 那一侧的判断按下了，可以据此分清问题在哪一层。

### 关于 "TTS voice for X is disabled" 提示

选了「只念引号句」后，SillyTavern 每跳过一段都会弹一条 `TTS voice for Washa is disabled.`，手动点朗读时是**每段弹一次**，看着像刷屏报错。

这条提示本身没错（确实是我们让它禁用的），只是噪音。扩展会把这一条静音，其它 TTS 提示照常显示。被静音的段数会显示在面板计数里：

```
另有 2 段由 SillyTavern 直接跳过（本来会各弹一条 "voice is disabled"，已静音）
```

配音本身不受影响。

## 实现要点

- 调用 `POST https://api.fish.audio/v1/tts`，body 是 `{ text, reference_id, format, latency }`。
- SillyTavern 的 `/proxy/` **不转发上游的 `Content-Type`**，而 TTS 扩展要求返回的 `blob.type` 以 `audio/` 开头，否则直接抛错。扩展里显式补上了 `audio/mpeg`。
- 通过官方 TTS 扩展导出的 `registerTtsProvider(name, provider)` 注册，实现 `generateTts` / `fetchTtsVoiceObjects` / `previewTtsVoice` / `loadSettings` 等约定方法。
- **渠道选择会自动恢复**：TTS 扩展在页面早期就读 `currentProvider`，那时第三方渠道还没注册，下拉框会回落到第一个选项。扩展在注册完成后会把上次的选择接回去，所以刷新页面不会丢渠道。
- **新的渠道 `[Default Voice]` 默认是 `disabled`**，这是 ST 防止一装完就自动念的设计。面板里的「测试配音」直链接口，不受这个限制，所以会出现"测试有声音、真朗读没声音"的错觉。扩展在启用时会自动把它接回来。
- **分段朗读的键名是硬编码英文**：`${角色} ("Quotes")` / `${角色} (*Text inside asterisks*)` / `${角色} (Other text)`。`SillyTavern System` 在分段这条路上不做默认映射，必须单独有键，否则报 `not in voicemap`。
- **不要用 `initVoiceMap(true)`**：它只建平名的键，反而会冲掉分段的键。要用 `initVoiceMap(false)`。

## 排错

| 现象 | 原因 |
| --- | --- |
| 扩展列表里找不到面板 | 页面没刷新；或扩展目录名不是 `st-fishaudio-tts` |
| 渠道下拉框里没有 Fish Audio | 官方 TTS 扩展没启用；或页面没刷新 |
| 刷新后渠道变回别的 | 装的是旧版本，更新到最新即可（旧版不会自动恢复选择） |
| 报跨域 / `Failed to fetch` | `enableCorsProxy` 没开 |
| `402 余额不足` | 模型名放错位置，或免费额度用完了 |
| 面板「测试配音」有声音，点朗读却没声音 | 装的是旧版本；新版会自动修 `[Default Voice]` 的 disabled |
| 报 `xxx not in voicemap` | 这个角色没有声音映射。点「修复声音映射」补齐 |
| 点朗读没声音 | TTS 总开关没开；或旁白声音没指定 |
| `TTS received HTTP response with invalid data format` | 扩展版本过旧（旧版没补 Content-Type） |
| 只念引号句不生效 | 逐句朗读没开。新版会自动打开；旧版需手动在 TTS 面板勾「多语音」+「按段落」 |
| 点了朗读没反应 | 面板里勾「在消息上显示朗读键」。ST 默认把这几个按钮设为 `display:none`，只在特定条件下放出来 |
| 新回复不自动念 | 开着「点击播放」。关掉它即可恢复自动朗读 |
| 找不到朗读键 | 用它旁边的「朗读最新一条」按钮，或勾上「在消息上显示朗读键」 |

### 为什么朗读键默认看不见

SillyTavern 的样式表里有这么两条：

```css
.mes_translate, .sd_message_gen, .mes_ghost, .mes_narrate { display: none; }
body.tts .mes_narrate { display: inline-block; }
```

再加上朗读键被放在「扩展消息操作」（`extraMesButtons`）折叠区里，而那个区又受 `expandMessageActions` 控制。两层叠起来的结果就是：**按钮存在、能触发，但宽高是 0，根本点不到**。

面板里的「在消息上显示朗读键」会同时处理这两层，并记住你的选择。

## License

MIT
