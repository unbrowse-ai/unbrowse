# unbrowse-exa — a drop-in for `exa-py`

Same surface as [`exa-py`](https://github.com/exa-labs/exa-py), one import swap:

```python
# from exa_py import Exa
from unbrowse_exa import Exa

exa = Exa(api_key="...")
r = exa.search_and_contents("best AI agent frameworks", num_results=5)
for hit in r.results:
    print(hit.title, hit.url, hit.text[:120])
```

`Exa`, `AsyncExa`, `.search(...)`, `.search_and_contents(...)`, `.get_contents(...)`,
a `SearchResponse` with `.results`, and `Result` objects carrying
`.url/.title/.text/.highlights/.score/.published_date/.summary` — the fields your
code already reads. The results come from the Unbrowse shared route graph plus web
enrichment instead of Exa, so a query that has a cached route is answered for free.

Offline shape mode for tests/CI: set `UNBROWSE_EXA_DRYRUN=1`.

This is a **drop-in replacement**. It is not affiliated with or endorsed by Exa;
`exa-py` is the upstream library this package is a drop-in for, and trademarks
belong to their respective owners.

## Test

```sh
python3 packages/py-exa/tests/test_shape.py
```
