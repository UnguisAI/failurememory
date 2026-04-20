# FailureMemory

FailureMemory is a deterministic, local-first GitHub Action MVP for spotting recurring GitHub Actions failures from either saved plain-text logs or the GitHub Actions API.

## What this MVP does

- Reads one plain-text GitHub Actions log file from disk in `file` mode
- Or fetches the newest failed workflow run and its failed job logs from GitHub in `github` mode
- Extracts and normalizes noisy failure lines into a stable excerpt
- Derives a SHA-256 fingerprint from that normalized excerpt
- Merges the current failure into a rolling local JSON history file
- Renders a markdown summary with recurrence details
- Exposes action outputs for downstream workflow steps

## Inputs

- `fetch_mode`: `file` (default) or `github`
- `log_path`: path to the plain-text log file to analyze when `fetch_mode` is `file`
- `github_repository`: repository to inspect in `owner/repo` form when `fetch_mode` is `github`; defaults to `GITHUB_REPOSITORY`
- `github_token`: token for GitHub API requests in `github` mode; defaults to `GITHUB_TOKEN`, then `GH_TOKEN`
- `github_run_id`: optional workflow run id to inspect in `github` mode; otherwise FailureMemory paginates completed workflow runs and chooses the newest failed run
- `history_file`: path to the rolling JSON history file
- `max_runs`: maximum recent runs to retain per fingerprint
- `summary_file`: path to write the markdown summary

## Outputs

- `fingerprint`: stable fingerprint for the current normalized failure
- `seen_count`: number of times the fingerprint has been observed locally
- `history_path`: updated history file path
- `summary_path`: generated summary file path

## Usage

### File mode

```yaml
- name: Fingerprint an exported log file
  uses: ./.
  with:
    fetch_mode: file
    log_path: logs/latest-failure.log
```

### GitHub API mode

```yaml
- name: Fingerprint the latest failed run in this repository
  uses: ./.
  with:
    fetch_mode: github
    github_token: ${{ secrets.GITHUB_TOKEN }}
```

You can also pin a specific run:

```yaml
- name: Fingerprint one failed run by id
  uses: ./.
  with:
    fetch_mode: github
    github_repository: octo-org/octo-repo
    github_token: ${{ secrets.GITHUB_TOKEN }}
    github_run_id: '123456789'
```

GitHub mode needs a token with `actions: read` permission so the workflow can list runs/jobs and download job logs.

In GitHub mode, FailureMemory stores a synthetic source reference like `github://owner/repo/actions/runs/123456789#jobs=111,222` in history instead of a workspace file path.

## Local development

```bash
npm install
npm test
npm run lint
npm run build
```

The build emits `dist/index.js` with `ncc` for GitHub Actions consumption.

## MVP constraints

This slice is intentionally deterministic and still small in scope:

- GitHub API mode paginates completed workflow runs until it finds the newest failed run
- Only failed jobs from the selected run are fetched and combined
- No issue or comment posting
- No hosted AI calls
- No cross-repo aggregation

## Next steps

- Add richer workflow/job filtering in GitHub API mode
- Group related fingerprints by workflow or job metadata
- Add issue/comment workflows for repeated failures
- Explore broader aggregation once the local core proves useful
