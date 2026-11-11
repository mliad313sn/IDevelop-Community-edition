# Sizing the server

This page explains how to size an IDevelop server for a given population, and how the dashboard model cache behaves at scale.

> **Read this first.** The figures in the worked example below are **invented, for illustration only**. They show the method, not measurements of IDevelop on any hardware. Measure on your own data with the method in [Measuring](#measuring) before you buy or resize a server.

## What drives the load

| Driver                                        | Grows with                                         | Notes                                                                        |
| --------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| Indicator computation (dashboard, board pack) | people × required skills in the reader's clearance | the heaviest read: K1 to K4 read every requirement of every person in scope  |
| Skill matrix                                  | people on the page × skill columns drawn           | one domain of columns at a time by default; « All domains » draws everything |
| Campaign console                              | participants of the campaign                       | filtered and paged on the server                                             |
| Nightly jobs                                  | the whole population                               | snapshots, reminders, digests: outside working hours                         |
| Uploads and imports                           | file size                                          | bounded by the upload limits                                                 |

The number of administrators and managers who open the dashboard at the same moment matters more than the head count: a cold dashboard computes every indicator of the reader's population once.

## The per-reader model cache

The dashboard's first screen, each context tab, the manager's home and the board pack's sections are kept for one reader, for a few minutes (`src/utils/readerCache.js`):

- an entry belongs to one reader and one clearance, never shared;
- any successful write request (a save, an approval, an import) drops every entry, so nobody reads a figure older than their own last change;
- a served model says when it was computed (the board pack prints it);
- entries expire after `DASHBOARD_MODEL_CACHE_TTL_MS` (default 300 000, five minutes), the backstop for changes made outside the web application (nightly jobs, a database console).

| Setting                             | Default                | Effect                                                         |
| ----------------------------------- | ---------------------- | -------------------------------------------------------------- |
| `DASHBOARD_MODEL_CACHE`             | on (off in unit tests) | `0` turns the cache off                                        |
| `DASHBOARD_MODEL_CACHE_TTL_MS`      | `300000`               | the longest a model is kept without a write                    |
| `DASHBOARD_MODEL_CACHE_MAX_ENTRIES` | `600`                  | the most entries kept; the least recently used goes first      |
| `DASHBOARD_CACHE_MAX_ENTRIES`       | `4000`                 | the older per-endpoint JSON cache of the legacy dashboard APIs |

One entry is one model of one reader: a first screen, one tab, the manager's home or the board pack's sections. A reader who opens the dashboard and two tabs uses three entries. The cache is in the server process: it is empty after a restart, and each process of a cluster has its own.

## Method

1. Count the **readers at the busiest moment**: the administrators and managers who open the dashboard or the board pack within the same five minutes (the start of a committee, a Monday morning).
2. Measure the **cold time** of one dashboard open for your largest clearance (a SuperAdmin) on a copy of your data, and the time of a second open (a cache hit).
3. Measure the **size of one entry**: the server's resident memory before and after a few readers open the dashboard, divided by the entries created.
4. Set `DASHBOARD_MODEL_CACHE_MAX_ENTRIES` to at least readers × models each reader opens, and check that entries × entry size fits comfortably in the memory you give Node.js.
5. Writes empty the cache: on a day of heavy data entry most opens are cold. Size the CPU for the cold time, not for the hit time.

## Worked example (invented figures, illustration only)

Suppose, **purely for illustration**, an organisation of 3,000 people where 40 readers open the dashboard in the same five minutes, each opening the first screen and two tabs:

- entries needed: 40 × 3 = 120, well under the default 600;
- if one entry were 200 KB, the cache would hold about 24 MB;
- if a cold open took 3 seconds and a hit 0.2 seconds, the first open of each reader would be slow and the following ones fast, until the next save.

Replace every number above with your own measurements.

## Measuring

- `scripts/loadtest-readiness.js` drives the readiness computation against a database; run it on a copy, never on production.
- Time a page with the browser's developer tools (the document request, « Waiting for server response »).
- `DASHBOARD_MODEL_CACHE=0` lets you compare cold and cached behaviour on the same server.
