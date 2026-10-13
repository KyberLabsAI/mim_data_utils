# Files to ignore when committing

- `captured/` — camera frame captures (jpg/png) and centroid data, not source

# Files explicitly tracked


# Decisions 2026-10-08 (/commit-ws)

- `js/markdown_log.js` — tracked (new JS source: markdown message store + "m" panel for Logger.log_md).
  JavaScript under `js/` is source, although outside the command's default source globs.

# Decisions 2026-10-13 (/commit-ws)

- `js/overlay_store.js`, `python/mim_data_utils/overlay.py`, `test/test_overlay.py` — tracked (new sources: server-rendered image overlays).
