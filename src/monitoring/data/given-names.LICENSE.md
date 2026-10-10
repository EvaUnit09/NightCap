# Given-name list

`given-names.ts` plus `given-names-extra.ts` are folded (NFKD, diacritics
stripped, lowercased) lookup keys used only for **weak** person cues such
as a bare `with X`.

## Sources and licenses

1. **U.S. Social Security Administration**, national popular baby names,
   public-domain U.S. government work (17 U.S.C. § 105).
   https://www.ssa.gov/oact/babynames/limits.html
   Compiled 1880–2008 via Hadley Wickham’s `data-baby-names`
   (https://github.com/hadley/data-baby-names), which reprints the SSA
   national files. SSA data remains public domain.
2. **SSA national files 2009–2023** (same public-domain series). Later-year
   newcomers and spellings that were not in the 1880–2008 extract are in
   `given-names-extra.ts`.
3. **International given names** in `given-names-extra.ts` are ordinary
   given names compiled from public government first-name statistics
   (Ireland CSO, and other official first-name publications) and from
   widely published public-domain name facts. Individual given names are
   not copyrightable; this addendum is redistributed for local offline
   lookup only.

## Provenance note

Some keys were added after reviewer reports flagged missing
international names (for example later-year and non-SSA forms). They
were not copied from a private held-out probe list.

## Size

About 6,800 SSA 1880–2008 keys plus the extra later-year and
international addendum. See `GIVEN_NAME_COUNT`.

## License

SSA source data: public domain (17 U.S.C. § 105).
This extract is redistributed for the same purpose: local, offline lookup.
