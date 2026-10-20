# st-fishaudio-tts

SillyTavern 扩展：把 **Fish Audio** 接成一个配音渠道（TTS Provider）。

这是我从自建的 dsh 酒馆里剥离出来的配音能力，做成独立扩展，装到任何 SillyTavern 都能用。
装好后「TTS」设置里的渠道下拉框会多出 **Fish Audio**，选中即可按角色分配声音。

## 安装

SillyTavern → 顶栏「扩展」→ **Install extension**，填：

```
https://github.com/Menkelo/st-fishaudio-tts
```

刷新页面，打开「扩展」→「TTS」，渠道选 **Fish Audio**。

**前置条件**：官方的 **TTS** 扩展必须处于启用状态（本扩展靠它注册渠道）。

## 必须先开 CORS 代理

Fish Audio 的接口**不返回跨域许可头**，浏览器直连会被拦。
扩展统一走 SillyTavern 自带的 `/proxy/` 转发。在 `config.yaml` 里改成：

```yaml
enableCorsProxy: true
```

然后重启 SillyTavern。

## 配置

选中 **Fish Audio** 渠道后，面板里填：

| 项目 | 说明 |
| --- | --- |
| Fish Audio 密钥 | 你的 API Key |
| 模型 | 默认 `s2.1-pro-free`（免费额度对应的模型） |
| 默认声音 ID | `reference_id`，可用「读取我的声音列表」拉取 |
| 走 SillyTavern 代理 | 默认开，关掉会跨域失败 |

点 **读取我的声音列表** 会把账号下的声音拉进下拉框，再在「角色声音」里逐个分配。

## 关键细节：模型名必须走请求头

Fish Audio 的免费模型 `s2.1-pro-free` **必须放在请求头 `model`** 里。
放进请求体会直接返回 `402 余额不足`——这是最容易踩的坑，本扩展已经处理好了。

## 用法

就是 SillyTavern 原生的 TTS 用法：

- 在「TTS」面板打开总开关
- 勾选「自动朗读」或手动点每条消息上的朗读按钮
- 在「角色声音」里给每个角色分配 voice id，旁白也要单独指定，否则旁白不出声

## 实现要点

- 调用 `POST https://api.fish.audio/v1/tts`，body 是 `{ text, reference_id, format, latency }`。
- SillyTavern 的 `/proxy/` **不转发上游的 `Content-Type`**，而 TTS 扩展要求返回的 `blob.type` 以 `audio/` 开头，否则直接抛错。扩展里显式补上了 `audio/mpeg`。
- 通过官方 TTS 扩展导出的 `registerTtsProvider(name, provider)` 注册，实现 `generateTts` / `fetchTtsVoiceObjects` / `previewTtsVoice` / `loadSettings` 等约定方法。

## 排错

| 现象 | 原因 |
| --- | --- |
| 渠道下拉框里没有 Fish Audio | 官方 TTS 扩展没启用；或页面没刷新 |
| 报跨域 / `Failed to fetch` | `enableCorsProxy` 没开 |
| `402 余额不足` | 模型名放错位置，或免费额度用完了 |
| 点朗读没声音 | TTS 总开关没开；或旁白声音没指定 |
| `TTS received HTTP response with invalid data format` | 扩展版本过旧（旧版没补 Content-Type） |

## License

MIT
