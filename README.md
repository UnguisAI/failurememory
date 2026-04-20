# FailureMemory

FailureMemory is a deterministic, local-first GitHub Action MVP for spotting recurring GitHub Actions failures from saved plain-text logs.

## What this MVP does

- Reads one plain-text GitHub Actions log file from disk
- Extracts and normalizes noisy failure lines into a stable excerpt
- Derives a SHA-256 fingerprint from that normalized excerpt
- Merges the current failure into a rolling local JSON history file
- Renders a markdown summary with recurrence details
- Exposes action outputs for downstream workflow steps

## Inputs

- `log_path`: path to the plain-text log file to analyze
- `history_file`: path to the rolling JSON history file
- `max_runs`: maximum recent runs to retain per fingerprint
- `summary_file`: path to write the markdown summary

## Outputs

- `fingerprint`: stable fingerprint for the current normalized failure
- `seen_count`: number of times the fingerprint has been observed locally
- `history_path`: updated history file path
- `summary_path`: generated summary file path

## Local development

```bash
npm install
npm test
npm run lint
npm run build
```

The build emits `dist/index.js` with `ncc` for GitHub Actions consumption.

## MVP constraints

This slice is intentionally deterministic and local-only:

- No GitHub API log download
- No issue or comment posting
- No hosted AI calls
- No cross-repo aggregation

## Next steps

- Add GitHub API log fetch mode for failed jobs
- Group related fingerprints by workflow or job metadata
- Add issue/comment workflows for repeated failures
- Explore broader aggregation once the local core proves useful
