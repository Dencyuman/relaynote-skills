# Write a report

## Contents

- When a report is worth it
- Structure: one section, one block
- Block types and when to use each
- Images
- Forms and tables: asking the human
- Project label
- Before publishing

## When a report is worth it

Use Relaynote when the user benefits from inspecting a durable report on their
phone: UI changes, implementation review, document review, or collecting
answers only they know. A one-line status does not need a session.

Lead with what changed and what to inspect. Include the outcome, before/after
behavior, the checks you actually ran, material limitations, and a clear
request: what needs a decision or a correction.

## Structure: one section, one block

- One section = one block = one comment target. Put the section name in
  `title`; keep the body free of Markdown headings.
- Split topics (changes, validation, questions), not sentences.
- For a multi-section report, leave `create_session.markdown` empty and send
  all sections in one `append_blocks` call. Blocks render in call order; images
  are blocks too, so build top-down: prose, evidence, checklist, questions.
- Reviewers read on phones: short sections, tables of at most 3 columns.
- Markdown only. Never emit HTML.

`assets/example-report.json` is a complete `append_blocks` payload to copy from.

## Block types and when to use each

| Block | Use for |
| --- | --- |
| `markdown` | Prose sections. The default. |
| `image` | A screenshot placed exactly where the prose refers to it. Always set `title`, `alt`, `description`. |
| `comparison` | Before/after of the same view: `{before:{asset_id,label}, after:{asset_id,label}}`. Prefer it over two `image` blocks. |
| `callout` | One caveat, risk, or question the reviewer must not miss. `tone`: `info`, `success`, `warning`. Not for general prose. |
| `checklist` | What you verified, `checked: true` only for items you actually ran. Unverified items stay unchecked. |
| `link` | 1–10 destinations to open (PRs, previews, docs). One block per purpose; do not repeat a URL that is already inline. |
| `form` | Facts or choices only the human knows, as typed blanks in a Markdown template. See below. |
| `table` | A dataset you build together when the row count is unknown. See below. |
| `file`, `diff`, `mermaid`, `chart` | Rendered artifacts. Read [artifacts.md](artifacts.md) first. |
| `email`, `calendar` | Drafts the human sends or registers. Read [handoff.md](handoff.md) first. |

Exact schemas are in the `append_blocks` tool definition; do not copy field
names from memory.

## Images

Upload with the CLI so the bytes never pass through your context:

```
node CLI upload ./shot.png --session SESSION_ID
→ {"asset_id": "..."}
```

The CLI downsizes (longest side 1600px, WebP q76) and prints the id. Place it
in the same `append_blocks` call as the surrounding prose. `--keep` skips
downsizing; `--max-side` and `--quality` override. A 403 means the stored login
predates the upload scope: run `login` again. `upload_image` (inline Base64) is
the fallback only when the CLI cannot run; downscale first.

Capture the relevant region, not the desktop. Upload mobile and desktop when
they differ. Never attach secrets, unrelated tabs, or fabricated evidence.

## Forms and tables: asking the human

- `form`: write the document yourself and leave typed blanks
  (`{{field_id}}`) for what you cannot know. Field types: text, textarea,
  select, multiselect, date, number, checkbox, image. Prefill likely answers
  with `value`; `required: true` blocks the decision until filled. Put
  textarea and multiselect placeholders on their own line. Answers come back in
  `get_session_review.forms[].values`, keyed by id; check `complete` before
  trusting required fields. An empty multiselect array means "none of these".
- `table`: define typed columns and prefill the rows you know; the reviewer
  adds, edits, and removes rows. Required columns must be filled in every row.
  Read the full result with `get_table_data` (JSON or CSV).

## Project label

`create_session.project` comes from `.relaynoterc` (`{"project": "name"}`) at
the workspace root. If it is missing, use the repository name; create the file
only when workspace changes are already in scope.

## Before publishing

Await every upload. Then `publish_session(session_id, round)` with the exact
round `create_session` or `begin_revision` returned. Retries reuse the same
round. Published blocks are immutable; changes need `begin_revision`.
