/**
 * Regression corpus for PII redaction.
 *
 * MISS: the name must be fully gone.
 * FP: the text must stay unchanged.
 * Every case is also checked for idempotence: redact(redact(x)) === redact(x).
 */

export interface TestCase {
  readonly id: string;
  readonly input: string;
  readonly expected: string;
  readonly description: string;
  /** If set, the case is registered with it.todo instead of asserted. */
  readonly todo?: string;
}

/** Cases where names MUST be fully redacted (a-series). */
export const nameCases: TestCase[] = [
  {
    id: "a1",
    input: "Plan a date in the West Village for me and Priya, under $150, walkable",
    expected: "Plan a date in the West Village for me and [NAME], under $150, walkable",
    description: "for me and X; West Village and $150 kept",
  },
  {
    id: "a2",
    input: "dinner for me and Priya",
    expected: "dinner for me and [NAME]",
    description: "for me and X",
  },
  {
    id: "a3",
    input: "Alex's birthday",
    expected: "[NAME]'s birthday",
    description: "X's birthday",
  },
  {
    id: "a4",
    input: "Sarah went there last time",
    expected: "[NAME] went there last time",
    description: "context-free given name",
    todo: "Context-free given names are unsafe without an NER model; they collide with venues.",
  },
  {
    id: "a5",
    input: "date with my girlfriend Mei",
    expected: "date with my girlfriend [NAME]",
    description: "relation + name",
  },
  {
    id: "a6",
    input: "plan something for jake and me",
    expected: "plan something for [NAME] and me",
    description: "lowercase name after strong for/and me cue",
  },
  {
    id: "a7",
    input: "DINNER WITH MY GIRLFRIEND PRIYA IN CHELSEA",
    expected: "DINNER WITH MY GIRLFRIEND [NAME] IN CHELSEA",
    description: "all-caps strong cue; Chelsea kept",
  },
  {
    id: "a8",
    input: "dinner with Priya, Sam, and Jordan",
    expected: "dinner with [NAME]",
    description: "Oxford comma list after with",
  },
  {
    id: "a8b",
    input: "Priya, Sam, and Jordan are coming",
    expected: "[NAME], [NAME], and [NAME] are coming",
    description: "Oxford comma list at start",
  },
  {
    id: "a9",
    input: "drinks with Dr. Patel",
    expected: "drinks with [NAME]",
    description: "title + surname",
  },
  {
    id: "a10",
    input: "date with my wife Zoë",
    expected: "date with my wife [NAME]",
    description: "Unicode diacritic ë",
  },
  {
    id: "a11",
    input: "dinner with José",
    expected: "dinner with [NAME]",
    description: "Unicode diacritic é",
  },
  {
    id: "a12",
    input: "with my friend Björk",
    expected: "with my friend [NAME]",
    description: "Unicode diacritic ö",
  },
  {
    id: "a13",
    input: "date with Mary-Kate",
    expected: "date with [NAME]",
    description: "hyphenated given name",
  },
  {
    id: "a14",
    input: "dinner with my boyfriend O'Brien",
    expected: "dinner with my boyfriend [NAME]",
    description: "apostrophe surname",
  },
  {
    id: "a15",
    input: "Priya and I want ramen",
    expected: "[NAME] and I want ramen",
    description: "X and I",
  },
  {
    id: "a16",
    input: "Anniversary dinner with my wife",
    expected: "Anniversary dinner with my wife",
    description: "relation with no name",
  },
  {
    id: "a17",
    input: "email priya.sharma@gmail.com the plan",
    expected: "email [EMAIL] the plan",
    description: "email",
  },
  {
    id: "a18",
    input: "with John Smith",
    expected: "with [NAME]",
    description: "first + last after with",
  },
  {
    id: "a19",
    input: "with my girlfriend Sarah Jones",
    expected: "with my girlfriend [NAME]",
    description: "relation + first + last",
  },
  {
    id: "a20",
    input: "my fiancée Ana and I",
    expected: "my fiancée [NAME] and I",
    description: "fiancée cue",
  },
  {
    id: "a21",
    input: "Taking Priya out Friday",
    expected: "Taking [NAME] out Friday",
    description: "taking X; Friday kept",
  },
  {
    id: "a22",
    input: "with my girlfriend, Mei",
    expected: "with my girlfriend, [NAME]",
    description: "relation + comma + name",
  },
  {
    id: "a23",
    input: "with McKenzie",
    expected: "with [NAME]",
    description: "Mc- compound name",
  },
  {
    id: "a24",
    input: "my partner DeShawn",
    expected: "my partner [NAME]",
    description: "De- compound name",
  },
  {
    id: "a25",
    input: "with my girlfriend Priya and her sister Ana",
    expected: "with my girlfriend [NAME] and her sister [NAME]",
    description: "second person after her sister",
  },
];

/** Venue, neighborhood, number, and day preservation (b-series). */
export const preservationCases: TestCase[] = [
  {
    id: "b1",
    input: "something near 10001",
    expected: "something near 10001",
    description: "bare neighborhood ZIP kept",
  },
  {
    id: "b2",
    input: "drinks in Murray Hill",
    expected: "drinks in Murray Hill",
    description: "neighborhood",
  },
  {
    id: "b3",
    input: "dinner with Chelsea vibes",
    expected: "dinner with Chelsea vibes",
    description: "with + neighborhood",
  },
  {
    id: "b4",
    input: "with Jackson Heights food",
    expected: "with Jackson Heights food",
    description: "with + neighborhood + noun",
  },
  {
    id: "b5",
    input: "picnic with Washington Square Park views",
    expected: "picnic with Washington Square Park views",
    description: "with + landmark",
  },
  {
    id: "b6",
    input: "after the show with Madison Square Garden nearby",
    expected: "after the show with Madison Square Garden nearby",
    description: "with + arena",
  },
  {
    id: "b7",
    input: "start with Joe's Pizza then drinks",
    expected: "start with Joe's Pizza then drinks",
    description: "possessive venue",
  },
  {
    id: "b8",
    input: "dinner with Carmine's family style",
    expected: "dinner with Carmine's family style",
    description: "possessive venue + descriptor",
  },
  {
    id: "b9",
    input: "with Katz's after",
    expected: "with Katz's after",
    description: "possessive venue",
  },
  {
    id: "b10b",
    input: "dinner with Via Carota vibes",
    expected: "dinner with Via Carota vibes",
    description: "with + multi-word venue",
  },
  {
    id: "b12",
    input: "date with Sunday brunch",
    expected: "date with Sunday brunch",
    description: "with + weekday + noun",
  },
  {
    id: "b14",
    input: "my girlfriend June",
    expected: "my girlfriend [NAME]",
    description: "month after relation is a name",
  },
  {
    id: "b15",
    input: "my wife May",
    expected: "my wife [NAME]",
    description: "month after relation is a name",
  },
  {
    id: "b16",
    input: "my friend August",
    expected: "my friend [NAME]",
    description: "month after relation is a name",
  },
  {
    id: "b17",
    input: "bars on the Bowery then Houston St",
    expected: "bars on the Bowery then Houston St",
    description: "street names as landmarks",
  },
  {
    id: "b18",
    input: "for 2 at 7pm, under $150",
    expected: "for 2 at 7pm, under $150",
    description: "party size and currency",
  },
  {
    id: "b19",
    input: "call 212-555-1234",
    expected: "call [PHONE]",
    description: "US phone",
  },
  {
    id: "b20",
    input: "under 10001 steps",
    expected: "under 10001 steps",
    description: "5-digit count is not a ZIP",
  },
  {
    id: "b21",
    input: "budget 1500000 total lol",
    expected: "budget 1500000 total lol",
    description: "large number kept",
  },
  {
    id: "b22",
    input: "with SoHo House",
    expected: "with SoHo House",
    description: "with + venue",
  },
  {
    id: "b23",
    input: "with Little Italy and Nolita",
    expected: "with Little Italy and Nolita",
    description: "with + neighborhood list",
  },
  {
    id: "b25",
    input: "dinner with Lower East Side cocktails",
    expected: "dinner with Lower East Side cocktails",
    description: "with + multi-word neighborhood",
  },
  {
    id: "b26",
    input: "from 7pm till 1130pm, 4 people",
    expected: "from 7pm till 1130pm, 4 people",
    description: "times and party size",
  },
  {
    id: "b27",
    input: "dinner with Hi-Collar then bar",
    expected: "dinner with Hi-Collar then bar",
    description: "with + hyphenated venue",
  },
  {
    id: "b28",
    input: "hey can you find a place called Dante",
    expected: "hey can you find a place called Dante",
    description: "place called + venue",
  },
  {
    id: "b29",
    input: "between 2023 and 2024 we went",
    expected: "between 2023 and 2024 we went",
    description: "years kept",
  },
];

export const falsePositiveCases: TestCase[] = [
  {
    id: "fp1",
    input: "$150 for dinner and drinks",
    expected: "$150 for dinner and drinks",
    description: "currency must not become [ADDRESS]inks",
  },
  {
    id: "fp2",
    input: "dinner for 2 then drinks",
    expected: "dinner for 2 then drinks",
    description: "for 2 then drinks must not become [ADDRESS]inks",
  },
  {
    id: "fp3",
    input: "my partner is vegetarian",
    expected: "my partner is vegetarian",
    description: "relation without a name must not eat the next word",
  },
];

/** Phones must become [PHONE] with nothing left over. */
export const contactCases: TestCase[] = [
  {
    id: "c1",
    input: "+1 (212) 555-1234",
    expected: "[PHONE]",
    description: "US +1 with parentheses",
  },
  {
    id: "c2",
    input: "212.555.1234",
    expected: "[PHONE]",
    description: "dotted US phone",
  },
  {
    id: "c3",
    input: "+44 20 7946 0958",
    expected: "[PHONE]",
    description: "UK international",
  },
  {
    id: "c4",
    input: "+33 6 12 34 56 78",
    expected: "[PHONE]",
    description: "French international",
  },
  {
    id: "c5",
    input: "I live at 123 W 4th St Apt 5B",
    expected: "I live at [ADDRESS]",
    description: "address + apartment",
  },
  {
    id: "c6",
    input: "1 Main Street",
    expected: "[ADDRESS]",
    description: "short street address",
  },
  {
    id: "c7",
    input: "ZIP 10014-1234",
    expected: "ZIP [ZIP]",
    description: "ZIP cue + ZIP+4",
  },
  {
    id: "c8",
    input: "pick me up at 350 5th Ave",
    expected: "pick me up at [ADDRESS]",
    description: "numbered avenue",
  },
  {
    id: "c9",
    input: "I'm at 200 E 10th St",
    expected: "I'm at [ADDRESS]",
    description: "directional + numbered street",
  },
  {
    id: "c10",
    input: "meet at 45 Rockefeller Plaza",
    expected: "meet at [ADDRESS]",
    description: "Plaza address",
  },
  {
    id: "c11",
    input: "212 555 1234 ext 5",
    expected: "[PHONE]",
    description: "phone + extension consumed",
  },
  {
    id: "c12",
    input: "2125551234",
    expected: "[PHONE]",
    description: "unformatted 10-digit",
  },
  {
    id: "c13",
    input: "PRIYA@EXAMPLE.COM",
    expected: "[EMAIL]",
    description: "all-caps email",
  },
  {
    id: "c14",
    input: "a@b.co",
    expected: "[EMAIL]",
    description: "short email",
  },
  {
    id: "c15",
    input: "call me at 555-1234",
    expected: "call me at [PHONE]",
    description: "7-digit local phone",
  },
];

export const edgeCases: TestCase[] = [
  {
    id: "d1",
    input: "",
    expected: "",
    description: "empty string",
  },
  {
    id: "d2",
    input: "[NAME] and [EMAIL] at [PHONE] [ADDRESS] [ZIP]",
    expected: "[NAME] and [EMAIL] at [PHONE] [ADDRESS] [ZIP]",
    description: "already-redacted markers unchanged",
  },
  {
    id: "d3",
    input: "with my friend [NAME]",
    expected: "with my friend [NAME]",
    description: "already-redacted name after relation",
  },
  {
    id: "d4",
    input: "Dinner with 李明",
    expected: "Dinner with [NAME]",
    description: "CJK name after with",
    todo: "CJK letters have no uppercase; the name-token rule is Latin/cased scripts only.",
  },
  {
    id: "d5",
    input: "with Ольга",
    expected: "with Ольга",
    description: "Cyrillic after weak with is not in the Latin SSA list",
  },
];

/** Extra realistic NYC date and night-out requests (named cases). */
export const additionalCases: TestCase[] = [
  {
    id: "extra1",
    input: "surprise dinner for Maya's 30th in East Village",
    expected: "surprise dinner for [NAME]'s 30th in East Village",
    description: "for Name's 30th",
  },
  {
    id: "extra2",
    input: "treat Sarah to cocktails in Williamsburg",
    expected: "treat [NAME] to cocktails in Williamsburg",
    description: "treat X",
  },
  {
    id: "extra3",
    input: "Liam and I need quiet bars under $100",
    expected: "[NAME] and I need quiet bars under $100",
    description: "X and I",
  },
  {
    id: "extra4",
    input: "anniversary for my bf Marcus",
    expected: "anniversary for my bf [NAME]",
    description: "bf abbreviation",
  },
  {
    id: "extra5",
    input: "my gf Aaliyah loves wine bars",
    expected: "my gf [NAME] loves wine bars",
    description: "gf abbreviation",
  },
  {
    id: "extra6",
    input: "date night for my fiancé and me in Tribeca",
    expected: "date night for my fiancé and me in Tribeca",
    description: "fiancé without a name",
  },
  {
    id: "extra7",
    input: "with my date tonight, somewhere cozy",
    expected: "with my date tonight, somewhere cozy",
    description: "date as relation, tonight is not a name",
  },
  {
    id: "extra8",
    input: "looking for spots near Union Square for Mr. Chen",
    expected: "looking for spots near Union Square for [NAME]",
    description: "Mr. title",
  },
  {
    id: "extra9",
    input: "party for Mrs. Rodriguez in Brooklyn",
    expected: "party for [NAME] in Brooklyn",
    description: "Mrs. title",
  },
  {
    id: "extra10",
    input: "drinks for Ms. Taylor and me",
    expected: "drinks for [NAME] and me",
    description: "Ms. title",
  },
  {
    id: "extra11",
    input: "quiet spot for me and Sofia",
    expected: "quiet spot for me and [NAME]",
    description: "for me and X",
  },
  {
    id: "extra12",
    input: "Isabella and me need sushi",
    expected: "[NAME] and me need sushi",
    description: "X and me",
  },
  {
    id: "extra13",
    input: "cocktails for my husband and I",
    expected: "cocktails for my husband and I",
    description: "husband without a name",
  },
  {
    id: "extra14",
    input: "taking my colleague out after work",
    expected: "taking my colleague out after work",
    description: "taking + relation, no given name",
  },
  {
    id: "extra15",
    input: "romantic dinner for Diego and me near Little Italy",
    expected: "romantic dinner for [NAME] and me near Little Italy",
    description: "for X and me; Little Italy kept",
  },
  {
    id: "extra16",
    input: "my cousin Raj visiting from London",
    expected: "my cousin [NAME] visiting from London",
    description: "cousin + name",
  },
  {
    id: "extra17",
    input: "Need recs for my mom birthday",
    expected: "Need recs for my mom birthday",
    description: "mom without a name",
  },
  {
    id: "extra18",
    input: "Elena's engagement party",
    expected: "[NAME]'s engagement party",
    description: "X's engagement party",
  },
  {
    id: "extra19",
    input: "date with my partner in Greenwich Village, vegetarian",
    expected: "date with my partner in Greenwich Village, vegetarian",
    description: "partner without a name",
  },
  {
    id: "extra20",
    input: "something lowkey for Christopher and his wife",
    expected: "something lowkey for [NAME] and his wife",
    description: "X and his wife",
  },
  {
    id: "extra21",
    input: "my husband Kenji wants omakase in East Village",
    expected: "my husband [NAME] wants omakase in East Village",
    description: "husband + name; East Village kept",
  },
  {
    id: "extra22",
    input: "plan something for rohan and me tonight",
    expected: "plan something for [NAME] and me tonight",
    description: "lowercase name after for/and me",
  },
  {
    id: "extra23",
    input: "DATE WITH MY BOYFRIEND ALEX IN WILLIAMSBURG",
    expected: "DATE WITH MY BOYFRIEND [NAME] IN WILLIAMSBURG",
    description: "all-caps boyfriend; Williamsburg kept",
  },
  {
    id: "extra24",
    input: "cocktails for Mx. Rivera after 10",
    expected: "cocktails for [NAME] after 10",
    description: "Mx. title",
  },
  {
    id: "extra25",
    input: "brunch with my gf Priya then a walk on the High Line",
    expected: "brunch with my gf [NAME] then a walk on the High Line",
    description: "gf + name; High Line kept",
  },
  {
    id: "extra26",
    input: "her friend Sam is visiting from Boston",
    expected: "her friend [NAME] is visiting from Boston",
    description: "her friend + name",
  },
  {
    id: "extra27",
    input: "dinner for Tomás and me in Astoria",
    expected: "dinner for [NAME] and me in Astoria",
    description: "for X and me; Astoria kept",
  },
  {
    id: "extra28",
    input: "surprise Mei with a reservation in SoHo",
    expected: "surprise [NAME] with a reservation in SoHo",
    description: "surprise X; SoHo kept",
  },
  {
    id: "extra29",
    input: "taking Ana to a wine bar in the West Village",
    expected: "taking [NAME] to a wine bar in the West Village",
    description: "taking X; West Village kept",
  },
  {
    id: "extra30",
    input: "dinner with John and Priya near Union Square",
    expected: "dinner with [NAME] near Union Square",
    description: "with Name and Name",
  },
];

export const allCases: TestCase[] = [
  ...nameCases,
  ...preservationCases,
  ...falsePositiveCases,
  ...contactCases,
  ...edgeCases,
  ...additionalCases,
];

/** Cases that contain a person name that must disappear (used for pass-rate reporting). */
export const namedMissCases: TestCase[] = allCases.filter(
  (testCase) => testCase.expected.includes("[NAME]") && !testCase.todo,
);

/** Cases that must stay byte-for-byte unchanged. */
export const namedFpCases: TestCase[] = allCases.filter(
  (testCase) => testCase.expected === testCase.input && testCase.input.length > 0 && !testCase.todo,
);
