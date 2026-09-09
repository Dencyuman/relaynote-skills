# Rich report artifacts

This source version adds `preflight` and `upload-artifact`. It requires a local
Relaynote renderer checkout (`--renderer-project`) with its pinned npm dependencies
installed, Node 22.13+ and Chrome. It does not install a browser, start an AI, or
run a permanent conversion service. A missing dependency is an explicit failure.

```
node CLI preflight report.pdf --type pdf --renderer-project RELAYNOTE_CHECKOUT --out NEW_DIRECTORY
node CLI upload-artifact NEW_DIRECTORY/manifest.json --file report.pdf --session SESSION_ID
```

Supported types: `pdf`, `csv`, `json`, `mermaid`, `diff`, `chart`.
Chart input is the bounded structured JSON schema from get_reporting_guide.
CSV chart input uses `--type chart --x COLUMN --y COLUMN[,COLUMN] --kind bar|line`;
the CLI validates and normalizes it once, without guessing types or dropping rows.
`preflight git --type diff` captures a working-tree diff, `--staged` captures the
index, or `--base REF --head REF` captures two verified commits; optional `--path`
restricts it. No shell, external diff or text conversion executes.

The original and generated SVG hashes are verified again before upload. Copy the
returned `block` into append_blocks. Await all uploads, then publish_session with
the exact draft round. Failure means correct the source and render again into a
new output directory; it does not notify the reviewer. For same-round supplements,
use the current content_version and upload all assets before a single append.

CSV: UTF-8, quoted newlines/BOM, 1 MiB, 1–1000 rows, 1–50 unique nonempty headers.
JSON: 1 MiB, 32 levels, 20,000 values; finite numbers. PDF: 10 MB transport limit,
1–100 unencrypted readable pages. No Office files. Diff: 200 KB, 3000 lines,
20 text files; binary and unsupported patches fail without truncation. Charts:
bar/line, 1000 categories, 1–5 finite numeric series; null values are gaps.

Mermaid: flowchart/sequence only, fixed strict/classic configuration, no HTML,
directives or links. The generated SVG is independently checked before upload.
Source/renderer hashes are authenticated-author quality receipts, not cryptographic
proof that an arbitrary malicious client actually rendered its own report.

Use PDF page/region, CSV 1-based data-row/column, JSON RFC6901 pointer and diff
file/side/line anchors from get_session_review exactly as returned.
