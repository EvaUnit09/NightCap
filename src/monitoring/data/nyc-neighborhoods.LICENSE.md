# NYC neighborhood terms

`nyc-neighborhoods.ts` is a local lookup list of New York City
neighborhood phrases used so name-shaped places survive a weak `with X`
cue.

## Source

NYC Open Data, **2020 Neighborhood Tabulation Areas (NTAs)**, dataset
`9nt8-h7nd`, published by the NYC Department of City Planning.

- https://data.cityofnewyork.us/City-Government/2020-Neighborhood-Tabulation-Areas-NTAs-/9nt8-h7nd
- API used to compile this extract: `https://data.cityofnewyork.us/resource/9nt8-h7nd.json?$select=ntaname`

Retrieved 2026-10-10. 262 official `ntaname` values. Compound hyphenated
NTA labels are split into constituent 1–4 word phrases. Parenthetical
compass tags such as `(West)` are stripped. `Little Island` is included
as a civic site that is not an NTA; it looks like a personal name after
`with`. Airports are omitted.

## License

NYC Open Data Terms of Use: https://www.nyc.gov/home/terms-of-use.page

NTA names are public geographic facts published by the City of New York.
This extract is redistributed for local, offline lookup only.
