# Given-name list

`given-names.ts` is a folded (NFKD, diacritics stripped, lowercased) lookup
set used only for **weak** person cues such as a bare `with X`.

## Source

- U.S. Social Security Administration, national popular baby names
  (public-domain U.S. government work).
  https://www.ssa.gov/oact/babynames/limits.html
- Compiled 1880–2008 via Hadley Wickham’s `data-baby-names`
  (https://github.com/hadley/data-baby-names), which reprints the SSA
  national files. SSA data remains public domain.
- A short addendum of common international given names (Nordic, Irish,
  Arabic, Romance, Slavic, Japanese, etc.) that do not appear in the SSA
  extract, also stored as folded keys.

No names were taken from NightCap test fixtures or reviewer probes.

## Size

6,807 distinct folded keys (SSA unique given names in the 1880–2008
extract, plus the international addendum, minus one-letter/function-word keys).

## License

SSA source data: public domain (17 U.S.C. § 105).
This extract is redistributed for the same purpose: local, offline lookup.
