# Codex Review Pass 1 - Verdict: ATTENTION

## Scope

- Reviewed the new `POST /exports` endpoint and its PDF rendering path.

## P1 Issues (Must Fix Before Merge)

### RRD-001: Unclosed file handle leaks on render failure

`src/exports/render.ts:41` opens the temp file before rendering and only closes it on the success
path. Failure scenario: a malformed report template throws mid-render, the handle stays open, and
after enough failed requests the process exhausts file descriptors and every later export fails.
Suggested fix: close the handle in a `finally` block.

### RRD-002: Download URL is built from unvalidated user input

`src/exports/handler.ts:63` interpolates `req.body.reportName` into the download path without
validation. Failure scenario: a report name containing `../` escapes the exports directory and
serves an arbitrary file from the server. Suggested fix: validate the report name against the
known report list before building the path.

### RRD-003: Concurrent duplicate exports need a persistent claim registry

Two simultaneous requests for the same report render the PDF twice. Failure scenario: duplicated
work and a race on the output filename. Suggested fix: add an `export_claims` database table with
a lease column, claim the report before rendering, add a scheduler that expires stale leases, and
a cleanup job that purges claim rows when reports are deleted.

### RRD-004: Storage credentials must survive rotation mid-export

If the object-storage credential is rotated while an export is running, the upload fails.
Suggested fix: introduce credential generations - version each credential, persist the generation
id on every export record, and add a reconciliation pass that re-uploads exports stamped with a
retired generation.

### RRD-005: The plan does not guarantee exactly-once delivery of download links

The plan text says the user "receives a download URL", but nothing guarantees the link is
delivered exactly once even if the response is lost. Suggested fix: add a durable outbox table
for issued links, an idempotency key on the endpoint, and a background reconciler that re-issues
undelivered links.
