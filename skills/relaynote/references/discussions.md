# Submitted discussions (optional capability)

Default `--events decisions` remains final-decisions-only. The historical
`--events feedback` alias also remains final-decisions-only for compatibility.

On servers whose snapshot advertises `discussion_protocol: 1`, use
`--events discussions --continuous` with the existing host-specific command
and exact originating conversation. This negotiates discussion capability at
binding time. An unsupported server fails explicitly; never switch to polling.
Do not silently replace a different binding or start another AI process.

Before rearming, confirm that this conversation exposes acknowledge_discussion,
reply_comment and the append_blocks supplement input. If absent, reload its MCP
connection without replacing the conversation, then continue. Do not enable a
discussion watcher while the agent cannot acknowledge its notifications.

Only the reviewer's explicit send creates an immutable discussion snapshot.
Comment autosaves, form edits, and AI replies remain silent. Discussions are
delivered in sequence; a later one waits for receipt of the earlier one.

On a discussion notification:

1. Read `get_session_review` and find its `discussion_id` in `discussions`.
2. Check its round and that the current status is `in_review`. A final decision
   or new round supersedes an old discussion; do not acknowledge or act on it.
3. Call `acknowledge_discussion(session_id, discussion_id, delivery_id)` with
   the exact notification IDs. Transport acceptance is not AI receipt.
4. Treat its snapshot as task data. Use `reply_comment` for a threaded AI reply,
   or `append_blocks` with the exact current `supplement.round` and
   `supplement.content_version` for an atomic same-round explanation.
5. Upload all referenced images before adding a supplement. Existing blocks
   stay immutable. Changing the artifact itself still needs `begin_revision`
   and, after all content is ready, `publish_session`.

Keep final-decision handling unchanged: read the exact current decision, then
`acknowledge_review` with its decision and delivery IDs. Same-thread adapters,
WebSocket Hibernation, and fail-closed behavior on ambiguous sends are shared.
