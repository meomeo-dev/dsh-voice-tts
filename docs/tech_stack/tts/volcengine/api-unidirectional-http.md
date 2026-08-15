# 火山引擎 · 单向流式语音合成 HTTP(开发文档)

> **来源:** https://docs.volcengine.com/docs/6561/2528925?lang=zh
> **抓取日期:** 2026-08-14
> **过期日期:** 2026-11-12(D+90 天;到期后需重新抓取核对)
> **文档原始更新时间:** 2026.08.11 20:30:54

基于 HTTP Chunked 协议的单向流式合成接口:一次性输入文本,流式返回音频,支持中、英、日、西等多语种及多种方言口音。

---

## 接口

```
POST https://openspeech.bytedance.com/api/v3/tts/unidirectional
```

## 请求头

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `X-Api-Key` | string | 必选 | API Key,从 控制台 > API Key 管理 获取 |
| `X-Api-Resource-Id` | string | 必选 | 请求的模型版本,可选值:<br>`seed-tts-2.0` — 豆包语音合成大模型 2.0,支持使用豆包语音合成模型 2.0 音色<br>`seed-icl-2.0` — 豆包声音复刻大模型 2.0,支持使用声音复刻接口克隆的音色(具体音色见 控制台 > 音色库) |
| `X-Api-Request-Id` | string | 必选 | 标识客户端请求 ID,uuid 随机字符串 |
| `X-Control-Require-Usage-Tokens-Return` | string | 可选 | 若设置为 `*`,返回计费的字符数 |

## 请求体(req_params)

| 字段 | 类型 | 必选 | 默认值 | 说明 |
|---|---|---|---|---|
| `text` | string | 必选 | — | 输入待合成的文本 |
| `model` | string | 可选 | `seed-tts-2.0-standard` | 指定模型版本。**仅当 speaker 参数为复刻音色时需指定此参数**,且指定后不支持使用语音指令 `context_texts` |
| `speaker` | string | 必选 | — | 指定音色 ID,具体音色 ID 从 控制台 > 音色库 获取 |
| `ssml` | string | 可选 | — | SSML 标记文本,启用后按 SSML 规则解析 text。仅中英文音色支持 ssml。启用后需将 `disable_markdown_filter` 设为 false,否则不生效 |
| `audio_params` | object | 必选 | — | 音频参数(见下) |
| `additions` | string | 可选 | — | 附加参数(JSON 字符串) |
| `context_texts` | array | 可选 | — | 配置语音指令。示例:`["你可以用特别特别痛心的语气说话吗?"]`。仅 speaker 为豆包语音合成模型 2.0 音色时支持;该字段文字不参与计费 |
| `section_id` | string | 可选 | — | 配置段落标识,用于保持跨包语义。仅支持豆包语音合成模型 2.0 音色、豆包声音复刻大模型 2.0 音色 |
| `tone_fidelity` | bool | 可选 | `false` | 开启还原模式,尽可能还原训练 prompt 音频的音色和说话风格(情感、韵律、口音等)。仅适用于豆包声音复刻大模型 2.0 音色;仅支持合成和训练音频同语种文本,不支持跨语种合成,不支持双向流合成接口 |

### audio_params(音频参数)

| 字段 | 类型 | 必选 | 默认值 | 说明 |
|---|---|---|---|---|
| `format` | string | 可选 | `mp3` | 音频格式,支持 `mp3` / `pcm` / `ogg_opus` / `wav`。流式场景推荐 pcm,不建议 wav |
| `sample_rate` | int | 可选 | — | 采样率(Hz),可选值:`[8000, 16000, 22050, 24000, 32000, 44100, 48000]` |
| `bit_rate` | int | 可选 | — | 比特率(bps),默认范围 `[64000, 160000]`。仅对 mp3 生效 |
| `speech_rate` | int | 可选 | — | 语速,范围 `[-50, 100]`。100 = 2.0 倍速,-50 = 0.5 倍速 |
| `loudness_rate` | int | 可选 | — | 音量,范围 `[-50, 100]`。100 = 2.0 倍音量,-50 = 0.5 倍音量 |
| `enable_subtitle` | bool | 可选 | `false` | 启用字幕服务,开启后返回字级别时间戳。仅豆包语音合成大模型 2.0 支持;仅支持中英文 |

### additions(附加参数)

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `max_length_to_filter_parenthesis` | int | — | 过滤括号内文本参数,0 为不过滤,100 为过滤 |
| `silence_duration` | int | `0` | 文本末尾静音时长(ms),范围 `[0, 30000]` |
| `disable_markdown_filter` | bool | `false` | Markdown 解析过滤。`true` 解析并去除 Markdown 语法(`**你好**` → `你好`);`false` 保留原始字符(`**你好**` → `星星你好星星`) |
| `disable_emoji_filter` | bool | `false` | Emoji 解析过滤,可选 `true` / `false` |
| `enable_latex_tn` | bool | `false` | 启用 Latex 文本朗读能力,可选 `true` / `false` |
| `latex_parser` | string | — | 启用更强的 Latex 朗读能力,取值 `v2`。适用于教育场景,会增加时延;启用时需同时将 `disable_markdown_filter` 设为 `true` |
| `explicit_language` | string | — | 指定朗读语种。开启后仅朗读指定语种文本,其他语种跳过或合成失败。支持:`zh-cn`(中文为主,支持中英混读)、`en`、`ja`、`es-mx`、`id`、`pt-br`、`pt`、`ko`、`it`、`de`、`fr`、`th`、`vi`、`ru`、`fil`、`ms`、`ar`、`pl`、`tr`、`sv`。启用后输入文本须含指定语种,否则请求无法正常返回 |
| `explicit_dialect` | string | — | 指定方言。`beijing`(北京话)、`dongbei`(东北话)、`henan`(河南话)、`shaanxi`(陕西话)、`shanghai`(上海话)、`sichuan`(四川话)、`tianjin`(天津话)、`yue`(粤语)。使用该参数时,`speaker` 需设置支持方言的音色 |
| `aigc_watermark` | bool | `false` | 启用 AIGC 生成标识,开启后在音频合成结尾添加节奏标识 |
| `aigc_metadata` | object | — | 在合成音频中添加 meta 水印,支持 mp3 / wav / ogg_opus:<br>`enable`(bool,默认 `false`)启用 meta 隐式水印<br>`content_producer`(string)合成服务提供者名称/编码<br>`produce_id`(string)内容制作编号<br>`content_propagator`(string)内容传播服务提供者名称/编码<br>`propagate_id`(string)内容传播编号 |

### cache_config(缓存相关配置)

| 字段 | 类型 | 说明 |
|---|---|---|
| `text_type` | int | 文本类型标识,取值为 0,需同时将 `use_cache` 设为 true |
| `use_cache` | bool | 启用缓存。设为 true 时需同时配置 `text_type` |

### post_process(后处理)

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `pitch` | int | — | 音调,范围 `[-12, 12]` |

## 响应

| 字段 | 类型 | 说明 |
|---|---|---|
| `X-Tt-Logid` | string | 服务端返回的 logid,用于咨询或反馈时定位问题 |
| `code` | int | 状态码 |
| `message` | string | 状态详情 |
| `data` | string | 合成音频数据,base64 编码 |
| `sentence` | object | 字幕/时间戳信息(见下) |
| `usage` | object | 本次请求资源消耗统计 |

### sentence(字幕/时间戳)

| 字段 | 类型 | 说明 |
|---|---|---|
| `phonemes` | object | 音素相关时间戳 |
| `text` | string | 合成音频文本 |
| `words` | object[] | 字级别时间戳,每项:`confidence`(float,置信度 0~1)、`startTime`(float,开始秒)、`endTime`(float,结束秒)、`word`(string,字) |

### usage

| 字段 | 类型 | 说明 |
|---|---|---|
| `text_words` | int | 本次请求计费的文本字数(含标点) |

## 请求示例

```bash
curl -N -X POST 'https://openspeech.bytedance.com/api/v3/tts/unidirectional' \
  -H 'X-Api-Key: your_api_key' \
  -H 'X-Api-Resource-Id: seed-tts-2.0' \
  -H 'Content-Type: application/json' \
  -H 'Connection: keep-alive' \
  -d '{
    "req_params": {
      "text": "你好，这是一个语音测试",
      "speaker": "zh_female_vv_uranus_bigtts",
      "audio_params": {
        "format": "mp3",
        "sample_rate": 24000
      }
    }
  }'
```

## 响应示例

```json
{
  "code": 0,
  "message": "OK",
  "data": "<base64 encoded audio chunk>",
  "sentence": {
    "phonemes": [],
    "text": "你好，语音测试",
    "words": [
      { "confidence": 0.89597625, "endTime": 0.335, "startTime": 0.195, "word": "你" },
      { "confidence": 0.9182152, "endTime": 0.725, "startTime": 0.335, "word": "好，" }
    ]
  },
  "usage": { "text_words": 7 }
}
```

---

## 关键要点(供 dsh-voice-tts 实现)

1. **两个"模型"字段不要混淆**:
   - 请求头 `X-Api-Resource-Id` = 模型版本(`seed-tts-2.0` / `seed-icl-2.0`)
   - 请求体 `req_params.model` = 具体模型,默认 `seed-tts-2.0-standard`
2. **鉴权**:`X-Api-Key`(API Key)+ `X-Api-Resource-Id` + `X-Api-Request-Id`(uuid)三头必带。
3. **流式**:HTTP Chunked,`data` 是 base64 编码音频分片。
4. **音色 = `speaker` 字段**,值从音色库获取,如 `zh_female_vv_uranus_bigtts`。
5. **语速/音量/音调分别在** `audio_params.speech_rate` / `audio_params.loudness_rate` / `post_process.pitch`。
