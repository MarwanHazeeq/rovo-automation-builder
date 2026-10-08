# forge-operator memory

Environment facts observed while operating the Forge CLI. Newest first. Each entry: date, fact, source.
Keep under 200 lines (only the first 200 load); merge or delete stale entries.

## Observations

- 2026-10-08 - Forge CLI 14.0.0 installed (14.1.0 available). `forge --version` hung past 120s; `forge lint` etc. completed normally. Source: CLI output.
- 2026-10-08 - `forge lint` exits 1 when the only finding is the MAJOR_VERSION_RULE approval notice (0 errors, 0 warnings). That is not a failure. Source: lint output.
- 2026-10-08 - Development install: logicalisasia.atlassian.net (Jira), installation 619e16d7-..., version 4 as of this date. Source: `forge install list`.
- 2026-10-08 - `forge variables list` prints values in a third column. Pipe it through sed to redact that column before showing output. Source: CLI output.
- 2026-10-06 - Node v22.23.2 on the dev machine. Node 20 is unsupported by the current Forge CLI and breaks lint inside its `archiver` dependency. Source: README.md, `node --version`.
- 2026-10-06 - Corporate TLS inspection: `NODE_EXTRA_CA_CERTS` is set in the user's environment to a CA chain outside this repo. TLS errors from the CLI likely mean that variable is missing in the shell. Source: environment check.
- 2026-10-06 - README.md previously referenced `scripts/deploy.ps1`; it never existed. Use `forge lint` then `forge deploy` directly. Source: directory listing.
- 2026-10-06 - Runtime credentials (`AUTOMATION_API_EMAIL`, `AUTOMATION_API_TOKEN`, `JIRA_CLOUD_ID`) are encrypted Forge variables, separate from `forge login`. Source: README.md.
