# AI 适配层依据

核验日期：2026-10-15。此文档记录实现依据；不构成已连接模型或模型效果验证。

| 来源 | 已核实的接口约定 | 对应实现 |
| --- | --- | --- |
| [OpenAI Chat Completions API reference](https://developers.openai.com/api/reference/resources/chat) | `POST /chat/completions`；请求使用 `model`、`messages`；文字结果位于 `choices[].message.content`；多模态内容包含 `text` 和 `image_url`。 | 服务端以原生 `fetch` 调用兼容接口，并校验响应结构。 |
| [OpenAI Images and vision guide](https://developers.openai.com/api/docs/guides/images-vision) | Chat Completions 可在用户消息的内容数组中同时传文字和图片；图片可以用包含 MIME 类型的 base64 data URL。示例采用 `Authorization: Bearer`。 | 报事分析传文字与已授权上传图片；回执核对仅传文字。 |
| [Alibaba Cloud OpenAI-compatible Chat](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions) | Qwen 多模态兼容接口支持 `image_url` 的图片 URL 或 base64 data URL，HTTP 路径为 `/compatible-mode/v1/chat/completions`。当前文档推荐工作空间专属域名，也说明既有 DashScope 域名继续有效。 | `baseUrl` 完全由服务端配置，追加 `/chat/completions`，不内置账号或地域。 |
| [Alibaba Cloud structured output](https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output) | 支持模型可使用 `response_format:{type:"json_object"}`，并在提示中要求 JSON；视觉示例采用 Qwen3-VL-Plus 的非思考模式。多模态输入不宜依赖服务端 JSON Schema 强约束。 | 传输层要求 JSON 对象，业务层仍以 Zod 检查字段、来源和边界。 |
| [OpenAI official Node SDK source](https://github.com/openai/openai-node/blob/master/src/resources/chat/completions/completions.ts) | 官方客户端声明了消息、图片内容及 completion 响应类型；可作为 HTTP 格式的实现侧佐证。 | 项目不依赖 SDK，仅参考其接口契约。 |

OpenAI 文档与阿里云兼容接口文档在 HTTP 路径、消息数组、图片 data URL、JSON 内容返回上相互印证。官方格式文档能证明约定存在，不能证明某个账户、地域和具体模型已经可用；模型字段支持、图片能力、数据保留与真实输出仍须配置后单独验证。测试使用内存响应，不发生付费模型调用。

产品规则来自本项目最新 V1.3 需求原文（父目录 `.work/prd_content.json`）：最多三条事实、来源逐条关联、保留否定/时间/范围、昼夜差异不自动视为冲突、补问限定维护方冻结模板、回执只核对文字是否回应事项、不判定修复质量。

来源引用有效只能证明编号或原话片段存在，不能证明模型的图像理解或文字推断正确；最终事实仍需居民核对，回执由工作人员负责。
