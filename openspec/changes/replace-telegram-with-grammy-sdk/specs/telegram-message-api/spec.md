## ADDED Requirements

### Requirement: sendMessage wrapper

The system SHALL expose a `sendMessage(chatId, text, options?)` function that delegates to `bot.api.sendMessage` and returns the SDK's `Message` type.

#### Scenario: Plain text message

- **WHEN** `sendMessage(chatId, "hello")` is called without options
- **THEN** the message is sent with `parse_mode: "HTML"` and the SDK returns the resulting `Message.TextMessage`

#### Scenario: Message with parse mode override

- **WHEN** `sendMessage(chatId, "hello", { parse_mode: "MarkdownV2" })` is called
- **THEN** the SDK sends the message with the override parse mode

#### Scenario: Caller-escaped text passes through

- **WHEN** `sendMessage(chatId, "&lt;b&gt;not bold&lt;/b&gt;")` is called with pre-escaped text
- **THEN** the system sends the escaped text and Telegram renders it as the literal string `<b>not bold</b>` without HTML interpretation

### Requirement: sendPhoto wrapper

The system SHALL expose a `sendPhoto(chatId, photo, caption?, options?)` function that delegates to `bot.api.sendPhoto`.

#### Scenario: Single photo with caption

- **WHEN** `sendPhoto(chatId, "https://...", "caption")` is called
- **THEN** the SDK sends a photo with `parse_mode: "HTML"` and the caption attached

#### Scenario: Photo with caption exceeding 1024 characters

- **WHEN** the caption length exceeds 1024 characters
- **THEN** the system truncates the caption to 1024 characters with trailing `...` via `truncateForCaption` and sends the full text as follow-up messages of up to 4096 characters each

### Requirement: sendMediaGroup wrapper supporting both photos and videos

The system SHALL expose a `sendMediaGroup(chatId, media, caption?, options?)` function that delegates to `bot.api.sendMediaGroup` and supports both photo URLs and video buffers via `InputMediaBuilder`.

#### Scenario: Mixed media group with caption

- **WHEN** `sendMediaGroup(chatId, [{type:"photo", media:"https://..."}, {type:"video", media:Buffer}], "caption")` is called
- **THEN** the SDK constructs an `InputMediaPhoto` for the URL and an `InputMediaVideo` for the buffer via `InputMediaBuilder`, attaches the caption to the first item with `parse_mode: "HTML"`, and dispatches the media group

#### Scenario: Video attachment using InputFile

- **WHEN** a media item has `media` as a `Buffer`
- **THEN** the SDK wraps it in `new InputFile(buffer, "video.mp4")` and `InputMediaBuilder.video(...)` handles multipart upload without requiring manual `FormData` or `attach://` construction

#### Scenario: Caption attached to first item only

- **WHEN** a media group contains more than one item
- **THEN** only the first `InputMedia` object receives the caption; the rest are sent without captions

### Requirement: deleteMessage wrapper

The system SHALL expose a `deleteMessage(chatId, messageId)` function that delegates to `bot.api.deleteMessage` and returns a boolean indicating success.

#### Scenario: Successful deletion

- **WHEN** `deleteMessage(chatId, messageId)` is called with a valid recent message id
- **THEN** the function returns `true` and Telegram deletes the message

#### Scenario: Deletion of a message older than 48 hours

- **WHEN** the message is older than 48 hours
- **THEN** Telegram returns a `GrammyError` and the wrapper returns `false` without rethrowing

#### Scenario: Deletion of a non-existent message

- **WHEN** the message id does not exist
- **THEN** Telegram returns a `GrammyError` and the wrapper returns `false` without rethrowing

### Requirement: HTML escape utility

The system SHALL expose an `escapeHtml(text)` function that escapes `&`, `<`, `>`, `"`, and `'` to their HTML entities, matching the character set recommended by the grammY `entity-parser` `textSanitizer` default implementation.

#### Scenario: Escaping user-provided text

- **WHEN** `escapeHtml("<script>alert(1)</script>")` is called
- **THEN** the function returns `&lt;script&gt;alert(1)&lt;/script&gt;`

#### Scenario: Escaping ampersand and quotes

- **WHEN** `escapeHtml('Tom & "Jerry"')` is called
- **THEN** the function returns `Tom &amp; &quot;Jerry&quot;`

#### Scenario: Text without special characters

- **WHEN** `escapeHtml("hello world")` is called
- **THEN** the function returns the original string unchanged

### Requirement: Caption truncation utility

The system SHALL expose a `truncateForCaption(text, limit = 1024)` function that truncates text to `limit` characters with trailing `...` when the input exceeds the limit.

#### Scenario: Text within limit

- **WHEN** `truncateForCaption("short text", 1024)` is called
- **THEN** the function returns `"short text"` unchanged

#### Scenario: Text exceeding limit

- **WHEN** `truncateForCaption` receives text longer than the limit
- **THEN** the function returns the first `limit - 3` characters followed by `...`

#### Scenario: Text exactly at limit

- **WHEN** `truncateForCaption` receives text whose length equals the limit
- **THEN** the function returns the original string unchanged (no ellipsis added)

### Requirement: Caption utilities order: escape then truncate

The system SHALL apply `escapeHtml` before `truncateForCaption` when processing user-provided caption text, to ensure that HTML entities are not truncated mid-escape.

#### Scenario: HTML entities preserved after truncation

- **WHEN** `escapeHtml` is applied to a 1100-character string containing `<` characters and then `truncateForCaption` is applied
- **THEN** the truncated string ends with `...` and contains no half-escaped entities
