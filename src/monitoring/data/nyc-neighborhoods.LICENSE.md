# NYC neighborhood terms

`nyc-neighborhoods.ts` is a local lookup list of New York City
neighborhood phrases used so name-shaped places survive a weak `with X`
cue.

## Source

NYC Open Data, **2020 Neighborhood Tabulation Areas (NTAs)**, dataset
`9nt8-h7nd`, published by the NYC Department of City Planning.

- https://data.cityofnewyork.us/City-Government/2020-Neighborhood-Tabulation-Areas-NTAs-/9nt8-h7nd
- API used to compile this extract: `https://data.cityofnewyork.us/resource/9nt8-h7nd.json?$select=ntaname`

Retrieved 2026-10-10. 262 official `ntaname` values. Airports are omitted.

## How hyphenated labels were handled

Hyphenated official labels were **split** into constituent 1–4 word
phrases only when at least one hyphen-separated part already contained a
space. Examples:

- `Hamilton Heights-Sugar Hill` → `Hamilton Heights`, `Sugar Hill`
- `Howard Beach-Lindenwood` → `Howard Beach`, `Lindenwood`
- `Upper West Side-Lincoln Square` → `Upper West Side`, `Lincoln Square`
- `SoHo-Little Italy-Hudson Square` → `SoHo`, `Little Italy`, `Hudson Square`

Hyphenated labels whose parts were **all single words** were **kept
whole**, with a space-normalized variant added. Examples:
`Bedford-Stuyvesant` (from the East/West NTAs after stripping
parentheticals), `Co-op City`, `Green-Wood Cemetery`.

Internal hyphens in `Co-op` and `Green-Wood` were protected so those
words were not split. Parenthetical compass tags such as `(West)` were
stripped before splitting.

## Official NTA names that look hand-added

These come from the official `ntaname` field, not from a private list:

- **Hell's Kitchen** (official NTA). An apostrophe-stripped form
  (`hells kitchen`) was added so tokenization matches.
- **Co-op City** (official NTA). Kept whole as above.
- **Randall's Island** (official NTA). An apostrophe-stripped form
  (`randalls island`) was added so tokenization matches.

## Hand-added entries (not an official `ntaname` as a whole string)

- **Little Island** — Hudson River Park civic site; not an NTA.
- **Bed Stuy** — common alias for Bedford-Stuyvesant.

Other short phrases in the file (Sugar Hill, Hudson Square, Lincoln
Square, Flatiron, Times Square, and similar) are split products of
compound official NTA labels, not separately invented names.

## License

NYC Open Data Terms of Use: https://www.nyc.gov/home/terms-of-use.page

NTA names are public geographic facts published by the City of New York.
This extract is redistributed for local, offline lookup only.
