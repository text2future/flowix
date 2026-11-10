# Video embeds

One `videoEmbed` node is shared by all video platforms. Platform differences belong in the provider definitions, not in the node view or paste pipeline.

| Layer | Responsibility |
| --- | --- |
| `providers/types.ts` | Common source fields, provider-discriminated video union and pure adapter contract |
| `providers/bilibili.ts` | Bilibili-only type, schema fields, BV/av and localized URLs, 分 P, validated aid/cid metadata and player URL |
| `providers/youtube.ts` | watch/short/share/live/embed URLs, start time, immediate readiness and privacy-enhanced player URL |
| `providers.ts` | Single provider registry, trusted URL parsing, metadata normalization and HTML compatibility |
| `providers/runtime.ts` | Editor-only resolver registry; platforms needing no metadata lookup have no resolver |
| `providers/bilibili-runtime.ts` | Bilibili-specific native service calls and typed resolution |
| `resolve.ts` | Dispatch optional runtime resolution; deduplicate in-flight requests only |
| `markdown.ts` | Portable source link plus Flowix metadata; the one Markdown spec both parse and serialize use |
| `node.ts` | Shared Tiptap schema and HTML persistence |
| `view.ts` | Shared rendering, dynamic source labels, asynchronous update lifecycle |
| `player-loading.ts` | Initialization cover, visible-player timeout, reload and disposal |
| `paste.ts` | Link-first paste, local conversion bubble, clipping and lifecycle handling |

## Adding a platform

1. Implement `VideoProvider` in `providers/<platform>.ts` and register it in `providers.ts`.
2. Always implement URL parsing, a display name, readiness checks and player URL construction.
3. Declare the platform-specific video interface extending `VideoSource`, with a literal `provider` discriminant, then include it in the `VideoInfo` union. Declare persisted fields in the adapter's `attributes`; the node schema aggregates these automatically. Implement `normalize` and `metadata` only for validated extra playback metadata. Never accept an arbitrary iframe URL.
4. Add `<platform>-runtime.ts` and register its resolver in `providers/runtime.ts` only when metadata lookup is required. Keep native imports there, outside the pure provider contract. There is no shared service interface listing platform-specific native commands.
5. Add tests for URLs, invalid hosts/IDs, readiness and mixed-provider Markdown/HTML round trips. The node view, loading UI and paste action should need no changes.

YouTube requires no metadata request. The shared paste/resolve path never queries Bilibili for YouTube links. Its canonical source URL preserves the selected video and start time, dropping playlist, radio and tracking parameters; playlist embedding is not currently supported. YouTube IDs are validated and the iframe is generated on `www.youtube-nocookie.com`, with controls enabled and autoplay disabled. Playback remains subject to YouTube network availability and each video's embedding restrictions.

Bilibili uses `resolve_bilibili_video` in `app/flowix-desktop/src/commands/web.rs`. It respects the system proxy first and retries directly only on HTTP 412. The requested page selects its own `cid`. Never fall back to browser fetch: the API does not permit the editor origin.

Existing Bilibili Markdown attributes are unchanged. New HTML stores platform metadata in `data-video-metadata`; older `data-aid`/`data-cid` HTML remains readable. Identity and start time are derived from the trusted source link, rather than accepting forged metadata or iframe URLs.

Lazy frames start their 15-second timeout on viewport entry. iframe `load` covers document initialization, not cross-origin media buffering. Timers, observers, paste bubbles and late metadata callbacks are cleaned up with their node/editor.

`VideoInfo` is a discriminated union: narrow `provider` before reading platform-only fields. Bilibili owns `page`, `aid`, `cid`; YouTube owns `start`. Legacy YouTube `page: 1` attributes are ignored on normalization. The shared model does not make all platform fields optional on every video.
