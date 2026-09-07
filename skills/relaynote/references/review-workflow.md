# Write a useful review

Use Relaynote when the user benefits from inspecting a durable report: UI changes,
implementation review, document review, or collecting concrete missing answers.
A one-line status update usually does not need a new session unless requested.

Lead with what changed and what the reviewer should inspect. Include:

- The outcome and relevant before/after behavior.
- Screenshots for visual changes, with meaningful title, alt text, and context.
- The checks actually performed and any material limitations.
- A clear review request: what needs a decision or correction.

Use concise Markdown prose. Use a checklist for parallel validation items,
`form` blocks for specific questions or choices, and `table` blocks when users
need to add or edit an unknown number of rows. Consult `get_reporting_guide`
for exact supported schemas instead of guessing fields or copying stale examples.

Read images attached to comments or decisions when image counts are nonzero.
Follow the associated `block_id` and review round so feedback is applied to the
correct content. Re-fetch report blocks if context is missing.

After a change request, fix the authorized issues and append an explanation and
new evidence to the same session. Appending after a decision opens the next
round; historical rounds remain available. Avoid duplicating sessions for each
revision. If feedback conflicts, identify the specific decision needed rather
than silently choosing one reviewer's instruction.

For browser screenshots, use the tools available in the current environment.
Read local image files only when needed and upload only the intended image. Do
not attach secrets, private unrelated tabs, or fabricated evidence.
