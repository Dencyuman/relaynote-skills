# Write a useful review

Use Relaynote when the user benefits from inspecting a durable report: UI changes,
implementation review, document review, or collecting concrete missing answers.
A one-line status update usually does not need a new session unless requested.

Lead with what changed and what the reviewer should inspect. Include:

- The outcome and relevant before/after behavior.
- Screenshots for visual changes, with meaningful title, alt text, and context.
- The checks actually performed and any material limitations.
- A clear review request: what needs a decision or correction.

One section = one block = one comment target. Put the section name in `title`
and the prose in `markdown`, without Markdown headings. Separate topics such as
changes, validation, and questions into distinct blocks; do not split every
sentence. Omit `create_session.markdown` for multi-section reports and send all
sections in a single `append_blocks` call. If an older server lacks Markdown
`title`, use one leading heading per block, never multiple sections in one block.

Use concise Markdown prose. Use a checklist for parallel validation items,
`form` blocks for specific questions or choices, and `table` blocks when users
need to add or edit an unknown number of rows. Consult `get_reporting_guide`
for exact supported schemas instead of guessing fields or copying stale examples.

Use Markdown links for inline citations or references within prose. Use a `link`
block for destinations the reviewer should open (PRs, previews, deliverables,
related docs): group 1–10 related links in one block, each with a short meaningful
title and an optional description of what to inspect. Do not make one block per
URL or duplicate the same link in prose and cards. Split unrelated purposes into
separate blocks; keep secondary references inline. Read the current server's
schema from `get_reporting_guide` before using the multi-link format.

Read images attached to comments or decisions when image counts are nonzero.
Follow the associated `block_id` and review round so feedback is applied to the
correct content. Re-fetch report blocks if context is missing.

After a change request, verify and acknowledge the exact decision/delivery IDs.
Call begin_revision with the decided round, fix the authorized issues, and append
an explanation and new evidence to the same session. Await every upload, then
call publish_session for the new round; historical rounds remain available. Avoid duplicating sessions for each
revision. If feedback conflicts, identify the specific decision needed rather
than silently choosing one reviewer's instruction.

For browser screenshots, use the tools available in the current environment.
Read local image files only when needed and upload only the intended image. Do
not attach secrets, private unrelated tabs, or fabricated evidence.

Upload images with the CLI, not through your own context:

```
node CLI upload ./shot.png --session SESSION_ID
```

It shrinks the file (longest side 1600px, WebP quality 76, via sharp,
ImageMagick, cwebp or sips - whichever the machine has), sends the bytes straight
to the server, and prints `{"asset_id": ...}`. Place that id with `append_blocks`
as `{"type": "image", "asset_id": "...", "title": "...", "alt": "...",
"description": "..."}` in the same call as the surrounding prose, so the report
keeps its order. `--keep` uploads the file untouched; `--max-side` and
`--quality` override the defaults. Reviewers read on a phone and the lightbox
zooms, so 1x scale is enough, and every image counts against the owner's storage
quota. The upload needs the `relaynote:upload` scope, which the watcher login
requests alongside the read-only events scope; a 403 means the stored login
predates it - run login again. Fall back to `upload_image` (inline Base64) only
when the CLI cannot run, and downscale first.

## Reply where the feedback arrived

Relaynote feedback establishes Relaynote as the response channel until the owner
closes the session or explicitly changes that instruction. Read and acknowledge
the exact decision, then answer its questions or perform its authorized next work.
Publish the substantive response in the same session; a terminal/chat answer alone
is insufficient. Keep any chat response to a brief status and link.

An approved round is not an owner-closed session. If the session is still open and
next work or an answer is due, use `begin_revision(session_id, current_round)`, add
the response as titled blocks, `publish_session`, and keep/rearm the watcher for
this same AI conversation. If no work or question remains, do not manufacture a
new round for an acknowledgement. If the owner closed the session, stop the loop;
do not reopen or create a replacement session without their instruction.
