# Contributing

- Open a pull request against `main`. Direct pushes are disabled.
- CI must pass: `node --test test/*.test.mjs` and `skills-ref validate`.
- Bump `metadata.version` in `SKILL.md`, `VERSION` in `scripts/lib/state.mjs`,
  and add a `CHANGELOG.md` entry in the same PR when behavior changes.
- Releases are tags `vX.Y.Z` on `main`. The Relaynote app pins the released
  commit; never rewrite a released tag.
- Write instructions for the weakest model you expect to run them: exact
  commands, one default, no explanations the agent does not need.
