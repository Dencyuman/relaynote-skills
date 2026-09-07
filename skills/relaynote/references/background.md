# Background review continuation

The skill includes a dependency-free Node.js CLI at `scripts/relaynote.mjs`.
Resolve the script relative to this installed skill directory. Do not assume a
particular global skills location. Requires Node.js 22+, macOS launchd or Linux
systemd user services, and an installed/authenticated Codex or Claude Code CLI.

## Set up once

Run the bundled script with Node (substitute its resolved absolute path):

```sh
node <skill-dir>/scripts/relaynote.mjs install
node <skill-dir>/scripts/relaynote.mjs login
node <skill-dir>/scripts/relaynote.mjs status
```

`install` copies the runtime to `~/.local/share/relaynote/runtime` and installs a
user service. The service survives the shell that started it and starts again
when the user logs in. It does not prevent computer sleep or run while powered
off. Linux requires a working `systemctl --user`; do not silently replace a
failed service install with a fragile shell background process. Windows service
installation is not supported; the `daemon` command can run under a user-managed
supervisor.

`login` performs its own browser OAuth + PKCE flow and stores tokens with mode
0600. Guide the user through browser authorization. Do not read another MCP
client's token store, print tokens, or paste them into chat. For an alternative
Relaynote environment, use `login --server https://...`. Only change credentials
when no jobs are waiting or running. API-key users may supply a key privately on
stdin with `login --api-key-stdin`; never put it in command arguments or task files.

`status` reports the daemon heartbeat, registered jobs, and outcomes. Verify a
fresh heartbeat and successful login before claiming setup is complete.

## Register the authorized continuation

This starts a NEW background AI conversation after the decision. It does not
inject text into the user's currently open conversation or resume an arbitrary
latest thread. Explain this behavior during setup. Existing configured harness
permissions still apply; the CLI does not enable bypass flags. A stopped or
permission-blocked run needs user attention.

After creating the review, write a short handoff file in the user's local task
area, outside version control unless the task calls for a tracked document.
Include:

- the original request and the exact remaining work already authorized;
- project/worktree directory, relevant files, tests and known constraints;
- what to do on approval and on changes requested;
- the SAME Relaynote session ID and current round;
- where to report results. Do not include secrets.

If no work remains after approval, say to report completion only. Do not turn a
review approval into permission to commit, push, deploy, delete resources, or
make unrelated changes. Ask for missing business decisions through Relaynote.

```sh
node <skill-dir>/scripts/relaynote.mjs watch <session-id> --round <N> --agent codex --cwd <absolute-project-dir> --task-file <handoff-file> --follow
```

For Claude Code use `--agent claude-code`. Use the client actually selected by
the user; do not silently switch harnesses. Capture the returned job ID. The task
content is snapshotted, so subsequent edits to that file do not alter the job.
With `--follow`, if a change request leads to a new review round, the daemon
automatically watches that next round using the same handoff. Approval ends this
chain. Omit `--follow` for a single round. Chains are limited to 10 AI launches
and the original 7-day expiry.
Once the job is registered, share the review URL and job ID and finish the current
turn. Do not also keep calling `wait_for_review` or independently act on the same
decision. That would create two owners for the same continuation.

Cursor and other clients can use `wait SESSION --round N` to obtain the decision,
but automatic background AI launching is currently limited to Codex and Claude
Code. Do not claim automatic resumption for unsupported clients.

## Operation and recovery

- `status`: examine jobs; logs are `~/.local/share/relaynote/jobs/<job-id>.log`.
- `stop <job-id>`: cancel a waiting job; it does not kill an already-running AI.
- `resume <job-id>`: rearm a blocked, stopped, or expired job after fixing its
  connection. Jobs that have already launched an AI cannot be replayed this way.
- `uninstall`: remove the service; credentials/jobs/logs are retained.
- Reinstall after `npx skills update` to copy the new runtime, once active runs
  finish. Do not restart the service over an active run.

The daemon long-polls the existing authenticated MCP `wait_for_review` tool.
There is no public local port, tunnel, inbound webhook, or model call while
waiting. It retries transient transport errors. A changed review round, revoked
authentication, or missing session blocks the job. Waiting jobs expire in 7 days.

Only one registration is accepted per server/session/round. Launch intent is
persisted BEFORE starting the AI. Following a crash, an unfinished run becomes
`interrupted` and is not automatically replayed; inspect its log to avoid doing
work twice. This is not an exactly-once execution guarantee. At most 8 pending
jobs are monitored in one batch and only one AI continuation runs at a time.
AI runs are limited to 20 minutes and receive SIGTERM on timeout.

A background continuation must not register another watcher recursively
(`RELAYNOTE_BACKGROUND_JOB` guards this). On a requested revision, update the
same review and report completion. With `--follow`, the daemon registers the next
round; the background AI must not register it a second time.
