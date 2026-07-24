# Scope Anchor

- Goal: add a `POST /exports` endpoint that renders one report as a PDF and returns a download
  URL. One request, one report, one file.
- Non-goals: no retry infrastructure, no background job queue, no persistent export registry, no
  credential lifecycle changes, no multi-tenant quota system.
- Usage profile: internal tool, single small team, tens of exports per day, one server process.
