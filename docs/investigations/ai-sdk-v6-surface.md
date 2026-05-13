# Investigation: AI SDK v6 middleware surface

## Meta

- **Date Created:** 2026-05-13
- **Date Updated:** 2026-05-13 (extended with UI helpers section for G1)
- **Status:** Completed
- **Related:** `system_design.md §7.2 A6`, `design/A_ahc-algorithm.md §11.6`,
  `design/G_ui.md §1, §4 G1`, plan
  `~/.claude/plans/rippling-sprouting-jellyfish.md` (Phase A6 Step 0),
  plan `~/.claude/plans/goofy-hopping-octopus.md` (Phase G1+G2 Step 0.5)

## Goal

Verify что фактический AI SDK v6 surface совпадает с предположениями плана A6.
Если разошлось — зафиксировать deviations и поправить остаток A6 (Steps 1–4) до
кодинга, согласно prerequisite в `system_design.md §7.2 A6` ("если v6 surface
поменялся — ревизим scope перед coding").

## Problem Statement

План A6 был написан против §7.2 verbatim, где упоминается:

- `LanguageModelV2Middleware` тип.
- `transformParams` hook для intercept'а params.
- `wrapStream` hook (passthrough в нашем случае).
- `tools` массив в params.

Версия SDK на момент A6 — `ai@6.0.180` (latest). Нужно verify соответствие
ожиданиям плана.

## Scope

- **In scope:**
  - Тип middleware, его поля и сигнатуры.
  - Структура `params` (тип сообщений в prompt).
  - Тип tool definition.
  - Naming snake_case vs camelCase для tool_use_id / toolCallId.
- **Out of scope:**
  - Streaming protocol (Server-Sent Events, transport).
  - Provider-specific bindings (OpenRouter, Anthropic) — A7.
  - UI message types (`UIMessage`) — UI/Track G концерн.
- **Constraints:** investigation должна быть быстрой; решения принимаем по тому
  что найдено в `node_modules/@ai-sdk/provider`.

## Findings

| # | Source | Result | Confidence |
|---|---|---|---|
| 1 | `node_modules/.pnpm/@ai-sdk+provider@3.0.10/.../v3/language-model-v3-middleware.ts` | Middleware type — `LanguageModelV3Middleware`, exported также как `LanguageModelMiddleware` (alias `= LanguageModelV3Middleware`) в `ai`. `specificationVersion: 'v3'` (literal). | high |
| 2 | Same file | Hooks: `overrideProvider?`, `overrideModelId?`, `overrideSupportedUrls?`, `transformParams?`, `wrapGenerate?`, `wrapStream?`. **`transformParams` и `wrapStream` есть** — план подтверждён. **Дополнительно: `wrapGenerate?` (план не упоминал)** — мы можем оставить undefined, AI SDK calls `doGenerate()` directly. | high |
| 3 | `language-model-v3-call-options.ts` | `params: LanguageModelV3CallOptions = { prompt, maxOutputTokens?, temperature?, topP?, ..., tools?: Array<LanguageModelV3FunctionTool \| LanguageModelV3ProviderTool>, toolChoice?, ... }`. | high |
| 4 | `language-model-v3-prompt.ts` | `prompt: LanguageModelV3Message[]`. Message — role-discriminated union: system (content: string), user (content: Array<TextPart \| FilePart>), assistant (content: Array<TextPart \| FilePart \| ReasoningPart \| ToolCallPart \| ToolResultPart>), tool (content: Array<ToolResultPart \| ToolApprovalResponsePart>). | high |
| 5 | Same file | ToolCallPart: `{ type: 'tool-call', toolCallId: string, toolName: string, input: unknown, ... }`. ToolResultPart: `{ type: 'tool-result', toolCallId: string, toolName: string, output: LanguageModelV3ToolResultOutput, ... }`. **Naming: kebab-case `tool-call`/`tool-result`, camelCase `toolCallId`/`toolName`** — отличается от core (`tool_use`/`tool_result`, `tool_use_id`/`name`). | high |
| 6 | Same file | `LanguageModelV3ToolResultOutput` — tagged union: `{type:'text', value}` / `{type:'json', value}` / `{type:'content', value: Array<...>}` / error variants. Core хранит `output: unknown` — при конверсии оборачиваем в `{type:'json', value}` (наиболее общий случай). | high |
| 7 | `wrapLanguageModel` API (`node_modules/ai/dist/index.d.ts`) | `wrapLanguageModel({ model, middleware, modelId?, providerId? })` — middleware может быть single или array. Composition разрешён — несколько middleware'ов чейнятся. | high |
| 8 | `node_modules/ai/dist/index.d.ts` line 131 | `export type LanguageModelMiddleware = LanguageModelV3Middleware` — top-level alias стабилен; можно импортить либо имя. | high |

## Interpretation

**План A6 в основном подтверждён**, но три минорных deviations требуют учёта в Steps
1–4:

1. **Type name**: используем `LanguageModelV3Middleware` (или alias
   `LanguageModelMiddleware` из `ai`). План говорил "V2" — это устаревшее
   именование из design-doc; spec на сегодня — V3. Полностью covered API-wise.

2. **Message conversion необходим**. Core types использует snake_case
   `tool_use_id`/`name` плюс `type: 'tool_use'`/`'tool_result'`. SDK V3 prompt
   использует kebab-case `tool-call`/`tool-result` и camelCase `toolCallId`/
   `toolName`. Также system content — `string`, не array. Конвертация —
   отдельный helper `src/adapters/messageConvert.ts` с парными
   `convertSdkPromptToCore(prompt): Message[]` и `convertCoreMessagesToSdk(messages):
   LanguageModelV3Message[]`. Round-trip соответствие критичен для cache prefix.

3. **`wrapStream` и `wrapGenerate` оба опциональные**. План говорил "wrapStream
   passthrough" — но проще оба оставить undefined (когда middleware пропускает —
   AI SDK сама вызывает `doGenerate()`/`doStream()`). Никаких passthrough функций
   писать не нужно. Compaction вся в `transformParams`.

**Tool definition не блокирует.** Tools массив в params — `Array<LanguageModelV3FunctionTool | LanguageModelV3ProviderTool>`. Core's `ToolDefinition`
тип opaque (branded), адаптер при инжекте `recallToolDefinition` строит конкретный
`LanguageModelV3FunctionTool` shape с zod schema (поэтому `zod` peer dep). Core's
`recallToolDefinition` сейчас — frozen object literal — адаптер пере-обернёт его
один раз и зависит от того же объекта дальше (cache prefix preserved).

## Next Actions

- **Step 1 adjustment**: при typecheck-сетапе использовать
  `LanguageModelV3Middleware` / `LanguageModelMiddleware` (import из `ai`).
  План's "V2" — устаревший термин, оставляем для исторической ссылки в
  decisions.md.
- **Step 3 adjustment**: создать `src/adapters/messageConvert.ts` с unit tests
  на round-trip identity (`sdk → core → sdk` byte-stable). Helpers покрывают:
  - system message: `{role:'system', content: string}` ↔
    `{role:'system', content: [{type:'text', text: string}]}`.
  - user/assistant text/file parts — straightforward map.
  - tool_use ↔ tool-call: `tool_use_id ↔ toolCallId`, `name ↔ toolName`.
  - tool_result ↔ tool-result: `output: unknown` →
    `{type:'json', value: output}` (default; адаптер позже может cast'ить text
    отдельно если нужно).
- **Step 3 simplification**: drop `wrapStream` из API surface. Только
  `transformParams` + `specificationVersion: 'v3'` constants.
- **Decision entry**: фиксируем "AI SDK v6 surface — V3 spec, transformParams
  only" с supersede плана's "V2 / wrapStream passthrough" формулировки.
- **No-action**: API в целом такой как ожидали; продолжаем Steps 1–4 с
  поправками выше.

---

## UI helpers (для G1, обновление 2026-05-13)

Эта секция — добавлена при работе над Track G G1. Покрывает `useChat` hook из
`@ai-sdk/react@3.0.182` (AI SDK v6 UI helpers), который Track G использует в
`src/ui/components/Chat.tsx`.

### Findings

| # | Source | Result | Confidence |
|---|---|---|---|
| 9 | `node_modules/@ai-sdk/react/dist/index.d.ts` line 39 | `useChat<UI_MESSAGE>({...options}): UseChatHelpers<UI_MESSAGE>`. Import — `from '@ai-sdk/react'` (НЕ `ai/react` как было в v3/v4/v5). | high |
| 10 | Same file line 13–25 | `UseChatHelpers` — `{ id, error, setMessages, ...Pick<AbstractChat, 'sendMessage' \| 'regenerate' \| 'stop' \| 'resumeStream' \| 'addToolResult' \| 'addToolOutput' \| 'addToolApprovalResponse' \| 'status' \| 'messages' \| 'clearError'> }`. **Нет `input`/`handleInputChange`/`handleSubmit`** — breaking change vs v5. UI сам ведёт `useState` для input и вызывает `sendMessage({text})`. | high |
| 11 | `ai/dist/index.d.ts` `ChatInit` interface | Options: `{ id?, messages?, transport?: ChatTransport<UI_MESSAGE>, onError?, onToolCall?, onFinish?, onData?, sendAutomaticallyWhen?, ... }`. **Параметр `api` исчез из top-level** — теперь через `transport: new DefaultChatTransport({ api, headers, body })`. По дефолту `api = '/api/chat'`. | high |
| 12 | `HttpChatTransportInitOptions` | `DefaultChatTransport({ api?, headers?: Resolvable<Record<string,string>\|Headers>, body?: Resolvable<object>, credentials?, fetch?, prepareSendMessagesRequest? })`. Custom request headers (включая `X-Session-Id`) идут именно сюда. `Resolvable` — может быть значение или функция возвращающая значение. | high |
| 13 | `ai/dist/index.d.ts` `UIMessage` line 1568 | `UIMessage = { id, role: 'system'\|'user'\|'assistant', metadata?, parts: UIMessagePart[] }`. **`content: string` исчез** — теперь `parts[]` discriminated union (text/reasoning/file/tool-*/data-*/step-start). При рендере итерируемся по parts и switch'имся по `part.type`. | high |
| 14 | Same file `FileUIPart` line 1654 | `{ type: 'file', mediaType: string, filename?, url: string, providerMetadata? }`. **Image-by-URL: `url` принимает либо http(s) URL, либо data URL** — не нужны blob/file upload helpers. | high |
| 15 | `AbstractChat.sendMessage` line 3886 | `sendMessage({ text?, files?: FileList \| FileUIPart[], metadata?, parts? }, options?)`. Multimodal: передаём `{ text: 'describe this image', files: [{ type:'file', mediaType:'image/png', url:'https://...' }] }`. SDK кладёт это в outgoing `UIMessage.parts`. | high |
| 16 | `AbstractChat.status` getter | `status: 'submitted' \| 'streaming' \| 'ready' \| 'error'`. UI gating отправок: disable submit при `status !== 'ready'`. | high |
| 17 | `ai/dist/index.d.ts` `convertToModelMessages` line ~3941 | Server-side helper: `convertToModelMessages(messages: Omit<UI_MESSAGE,'id'>[], options?): Promise<ModelMessage[]>`. На route handler конвертит `UIMessage[]` из request body в `ModelMessage[]` для `streamText({ messages: ... })`. | high |
| 18 | `streamText().toUIMessageStreamResponse()` line ~2513 | Server возвращает `streamText({...}).toUIMessageStreamResponse(options?)` — это готовый `Response` с правильным content-type/streaming для `DefaultChatTransport` на клиенте. Не используем `toDataStreamResponse` (это v5 имя). | high |

### Interpretation

Для G1 Track G:

1. **Import**: `import { useChat } from '@ai-sdk/react'` (не `from 'ai/react'`).
2. **Headers**: для `X-Session-Id` явно строим transport:
   ```ts
   const chat = useChat({
     transport: new DefaultChatTransport({
       api: '/api/chat',
       headers: () => ({ 'X-Session-Id': sessionIdRef.current }),
     }),
   });
   ```
   Используем функциональную форму потому что `sessionId` мутируется при mount.
3. **Input state — собственный**:
   ```ts
   const [text, setText] = useState('');
   const [imageUrl, setImageUrl] = useState('');
   const onSubmit = () => {
     chat.sendMessage({
       text,
       ...(imageUrl ? { files: [{ type:'file', mediaType: 'image/png', url: imageUrl }] } : {}),
     });
     setText(''); setImageUrl('');
   };
   ```
   Disable submit при `chat.status !== 'ready'`.
4. **Render**: итерируемся по `chat.messages[].parts[]`:
   ```ts
   for (const part of msg.parts) {
     if (part.type === 'text') render(part.text);
     else if (part.type === 'file' && part.mediaType.startsWith('image/')) renderImg(part.url);
     else if (part.type === 'tool-fetch_url') renderToolCall(part);
   }
   ```
5. **localStorage history**: `useEffect(() => localStorage.setItem('chatHistory', JSON.stringify(chat.messages)), [chat.messages])`. Restore через `useChat({ messages: initialFromStorage })`.
6. **Server route (`/api/chat/route.ts`)**:
   ```ts
   const { messages } = await req.json();
   const modelMessages = await convertToModelMessages(messages);
   const result = streamText({ model, system, messages: modelMessages, ... });
   return result.toUIMessageStreamResponse();
   ```
7. **`sendAutomaticallyWhen`** — для client-side tool execution loop. Track G делает tool execution на server (через `tools` в `streamText`), так что НЕ используем.

### Next Actions

- **G1 Step 1**: client `<Chat />` строится по схеме выше (custom input state, transport с headers callback, parts-based render).
- **G1 Step 2**: route handler использует `convertToModelMessages` + `toUIMessageStreamResponse()`.
- **G2 Step 5**: `streamText({ tools: { fetch_url: fetchUrlTool }, ... })` — tool execution на server; client видит `tool-fetch_url` parts в `messages[].parts[]` (для G3 sidebar этого хватит чтобы посчитать tool calls).
- **No surface gap для G1/G2**: всё подтверждено type defs, не нужны WebSearch/docs.
