# Submitted discussions

Submitted discussions are delivered by default. A watcher started without
`--events` reads `discussion_protocol` from the snapshot and binds for
discussions when the server advertises `1`, so the reviewer's comments reach the
originating conversation without anyone turning them on. A server without that
capability binds for final decisions only; the default degrades, it never fails
and never switches to polling.

`--events decisions` opts out and keeps final decisions only. The historical
`--events feedback` alias is the same opt-out. `--events discussions` still
requests discussions explicitly and, unlike the default, fails on a server that
cannot deliver them. The shared runtime registers discussions the same way;
`--no-discussions` is its opt-out. Do not silently replace a different binding
or start another AI process.

Before binding, confirm that this conversation exposes acknowledge_discussion,
reply_comment and the append_blocks supplement input. If absent, reload its MCP
connection without replacing the conversation, then continue. Do not bind a
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

## Linked answers (3.4)

An app advertising `discussion_response_protocol: 1` additionally stores the
relationship between a submitted discussion and its answers. Reload MCP in this
same conversation if the new optional inputs are missing. Include `discussion_id`
in `reply_comment`, or `supplement.discussion_id` in `append_blocks`, with the exact
submitted discussion ID. For a whole-report note, `reply_comment` accepts
`discussion_id` and `body` without a parent comment. Continue to pass
`parent_comment_id` when answering a specific block comment.

After saving, `get_session_review.discussions[].responses` identifies the persisted
reply comments and supplement blocks. Only those saved links justify “answer
available”; ACK proves receipt, not completion or current activity. An unlinked
reply on an older app stays a reply without claiming tracked completion. Do not
send the new optional fields when that app lacks the capability.

Delivery history preserves known stage timestamps and past rounds. A final
decision, new round, or owner closure ends pending discussion work; do not ACK or
answer the superseded event. A failed or ambiguous send is not permission to
replay it. Check the pinned original conversation. Later exact ACK can confirm
receipt while the round is still current. Saved drafts remain silent, and default
final-decision monitoring is unchanged.

## Publish the completed response (response_cycle_protocol: 1)

On servers advertising `response_cycle_protocol: 1`, the first saved AI reply or
supplement starts preparation in the SAME round. Further replies/supplements are
allowed while that response is preparing. Finish all content and uploads, read
`response_version` from `get_session_review`, then call
`publish_session(session_id, round, response_version)` with those exact values.
This returns the response to review waiting without creating a new round.
Reuse the exact version on an uncertain retry; if it is stale, re-read the work
before publishing. Do not publish another writer's unfinished response blindly.
Verify `response_pending=false` and `review_status=in_review` after publication.
An ACK ends the delivery track only; it never starts preparation by itself.
A saved answer link is evidence of a saved reply, not proof the response was
published. On older servers without this capability, retain the prior atomic
supplement behavior and do not send `response_version`.
