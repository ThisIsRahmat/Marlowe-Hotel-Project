# Murder at the Marlowe Hotel: Case Database

A one-page SQL editor for the "Murder at the Marlowe Hotel" SQL murder mystery. It runs SQLite
in the browser with [sql.js](https://github.com/sql-js/sql.js), so there is no server, no sign-up and
no tracking. Nothing a learner types leaves their browser.

## Using it

Open the page, type a query, then press **Run query** (or <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Enter</kbd>).

- Tables are in the `marlowe` schema, e.g. `SELECT * FROM marlowe.people;`. Plain `people` works too.
- `LIKE` is case-sensitive, as in BigQuery.
- The data is rebuilt every time the page loads. **Reset data** does the same without a refresh.

## Files

| Path | What it is |
| --- | --- |
| `index.html`, `style.css`, `app.js` | The page |
| `data/*.csv` | The case data (the source of truth) |
| `data/marlowe-data.js` | The same data packaged for the page. Generated, don't edit by hand |
| `tools/build_data.py` | Regenerates `data/marlowe-data.js` from the CSVs |

## Running locally

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Learners never need to do this. They just use the GitHub Pages link.

## Changing the data (coaches)

Edit the CSVs in `data/`, then run:

```sh
python3 tools/build_data.py
```

Commit both the CSVs and the regenerated `data/marlowe-data.js`. Column types are set in `app.js`
(`COLUMN_TYPES`). Any column not listed there is `TEXT`.
