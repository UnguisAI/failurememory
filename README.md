# FailureMemory

FailureMemory is a GitHub Action for recurring CI triage: it fingerprints noisy GitHub Actions failures, keeps a rolling history, and turns the latest failed run into a short recurrence brief.

## Why it exists

Teams keep re-reading the same GitHub Actions failures. FailureMemory tries to answer three questions fast:

- **Is this the same failure again?**
- **How many times have we seen it?**
- **What is the shortest useful excerpt to hand the next engineer?**

It is intentionally deterministic and local-first for the first release: no hosted service, no issue spam, no AI calls required.

## What it does

- Fetches the newest failed workflow run from GitHub or reads a saved plain-text log file
- Extracts and normalizes failure lines while dropping common GitHub Actions noise
- Hashes the normalized excerpt into a stable SHA-256 fingerprint
- Merges the failure into a rolling JSON history file
- Writes a markdown recurrence summary and step outputs for downstream workflow steps

## Real public dogfood

FailureMemory was run against three separate public `pydantic/pydantic` **Upload previews** failures:

- https://github.com/pydantic/pydantic/actions/runs/24561506985
- https://github.com/pydantic/pydantic/actions/runs/24596416169
- https://github.com/pydantic/pydantic/actions/runs/24640374108

All three collapsed to the same fingerprint and the same concise recurrence brief:

```text
Fingerprint: 4778dd84c9cf404265fbff4595c29c6037e1d3d2aa661bf9fd8a0ccb845f853b
Seen count: 3
Normalized excerpt: no matching workflow run found with any artifacts?
```

That is the wedge: repeated failures stop looking like fresh detective work.

## Quick start: follow failed runs in GitHub mode

The cleanest first setup is a separate `workflow_run` triage workflow. Replace `CI` with the workflow names you want to watch.

```yaml
name: failurememory-triage

on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]

jobs:
  fingerprint-failure:
    if: ${{ github.event.workflow_run.conclusion == 'failure' }}
    runs-on: ubuntu-latest
    permissions:
      actions: read
      contents: read
    steps:
      - name: Restore prior FailureMemory history
        uses: actions/cache/restore@v4
        with:
          path: .failurememory
          key: failurememory-${{ github.repository }}-${{ github.event.workflow_run.head_branch }}-${{ github.event.workflow_run.id }}
          restore-keys: |
            failurememory-${{ github.repository }}-${{ github.event.workflow_run.head_branch }}-

      - name: Fingerprint the failing run
        id: failurememory
        uses: goat-ai-claw/failurememory@v0
        with:
          fetch_mode: github
          github_token: ${{ secrets.GITHUB_TOKEN }}
          github_run_id: ${{ github.event.workflow_run.id }}

      - name: Save updated FailureMemory history
        if: ${{ always() }}
        uses: actions/cache/save@v4
        with:
          path: .failurememory
          key: failurememory-${{ github.repository }}-${{ github.event.workflow_run.head_branch }}-${{ github.run_id }}

      - name: Echo recurrence result
        run: |
          echo "fingerprint=${{ steps.failurememory.outputs.fingerprint }}"
          echo "seen_count=${{ steps.failurememory.outputs.seen_count }}"
          cat "${{ steps.failurememory.outputs.summary_path }}"
```

### Why the cache keys look unusual

FailureMemory history changes on each run. A static cache key will not update cleanly after the first save. The pattern above restores the latest branch-scoped history with `restore-keys`, then saves a fresh cache keyed by the current run id.

If cache-based persistence is not a fit, you can also persist `.failurememory/history.json` via artifacts or your own commit/update flow.

## File mode

If you already export a plain-text failure log inside a workflow, you can fingerprint that file directly:

```yaml
- name: Fingerprint one exported log file
  id: failurememory
  uses: goat-ai-claw/failurememory@v0
  with:
    fetch_mode: file
    log_path: logs/latest-failure.log
```

## Inputs

| Input | Required | Default | Notes |
| --- | --- | --- | --- |
| `fetch_mode` | no | `file` | `file` or `github` |
| `log_path` | file mode | — | Plain-text log path inside the workspace |
| `github_repository` | no | `GITHUB_REPOSITORY` | `owner/repo` target when using GitHub mode |
| `github_token` | github mode | `GITHUB_TOKEN` then `GH_TOKEN` | Needs `actions: read` permission |
| `github_run_id` | no | newest failed run | Pin one specific run in GitHub mode |
| `history_file` | no | `.failurememory/history.json` | Rolling local history file |
| `max_runs` | no | `10` | Recent occurrences kept per fingerprint |
| `summary_file` | no | `.failurememory/failurememory-summary.md` | Markdown summary output |

## Outputs

| Output | Meaning |
| --- | --- |
| `fingerprint` | Stable hash for the normalized failure excerpt |
| `seen_count` | Number of local occurrences for this fingerprint |
| `history_path` | Resolved path to the updated history JSON |
| `summary_path` | Resolved path to the generated markdown summary |

## What the summary looks like

````md
# FailureMemory Summary

- Fingerprint: `4778dd84c9cf404265fbff4595c29c6037e1d3d2aa661bf9fd8a0ccb845f853b`
- Seen count: **3**
- First seen: `2026-04-20T06:34:23.949Z`
- Last seen: `2026-04-20T06:34:25.545Z`

## Normalized excerpt

```text
no matching workflow run found with any artifacts?
```
````

## Current MVP limits

- GitHub mode fetches failed jobs from one selected run, not an entire repo history
- History is local to the path you persist; there is no hosted backend yet
- No issue posting, PR commenting, or alert routing in this release
- No cross-repo clustering yet
- No LLM summarization layer yet; the current value is deterministic recurrence memory

## Local development

```bash
npm install
npm test
npm run lint
npm run build
```

The build emits `dist/index.js` with `ncc` for GitHub Actions consumption.

## Example workflows

- [`examples/workflow-run-triage.yml`](examples/workflow-run-triage.yml)
- [`examples/file-mode.yml`](examples/file-mode.yml)

## License

MIT
