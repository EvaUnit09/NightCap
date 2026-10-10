/**
 * Regression corpus for PII redaction.
 * Each case tests that names are fully redacted while preserving venue/place terms.
 */

export interface TestCase {
  id: string;
  input: string;
  expected: string;
  description: string;
}

/**
 * Cases where names MUST be fully redacted (a-series)
 */
export const nameCases: TestCase[] = [
  {
    id: "a1",
    input: "Plan a date in the West Village for me and Priya, under $150, walkable",
    expected: "Plan a date in the West Village for me and [NAME], under $150, walkable",
    description: "for me and X pattern, preserve West Village and $150",
  },
  {
    id: "a2",
    input: "dinner for me and Priya",
    expected: "dinner for me and [NAME]",
    description: "for me and X pattern",
  },
  {
    id: "a3",
    input: "Alex's birthday",
    expected: "[NAME]'s birthday",
    description: "X's birthday pattern",
  },
  {
    id: "a5",
    input: "date with my girlfriend Mei",
    expected: "date with my girlfriend [NAME]",
    description: "relationship word pattern",
  },
  {
    id: "a6",
    input: "plan something for jake and me",
    expected: "plan something for [NAME] and me",
    description: "lowercase name after 'for' and 'and me'",
  },
  {
    id: "a7",
    input: "DINNER WITH MY GIRLFRIEND PRIYA IN CHELSEA",
    expected: "DINNER WITH MY GIRLFRIEND [NAME] IN CHELSEA",
    description: "all-caps input, preserve Chelsea",
  },
  {
    id: "a8",
    input: "dinner with Priya, Sam, and Jordan",
    expected: "dinner with [NAME]",
    description: "Oxford comma list after 'with'",
  },
  {
    id: "a8b",
    input: "Priya, Sam, and Jordan are coming",
    expected: "[NAME] are coming",
    description: "Oxford comma list at start",
  },
  {
    id: "a9",
    input: "drinks with Dr. Patel",
    expected: "drinks with Dr. [NAME]",
    description: "title + surname",
  },
  {
    id: "a10",
    input: "date with my wife Zoë",
    expected: "date with my wife [NAME]",
    description: "Unicode diacritic (ë)",
  },
  {
    id: "a11",
    input: "dinner with José",
    expected: "dinner with [NAME]",
    description: "Unicode diacritic (é)",
  },
  {
    id: "a12",
    input: "with my friend Björk",
    expected: "with my friend [NAME]",
    description: "Unicode diacritic (ö)",
  },
  {
    id: "a13",
    input: "date with Mary-Kate",
    expected: "date with [NAME]",
    description: "hyphenated name",
  },
  {
    id: "a14",
    input: "dinner with my boyfriend O'Brien",
    expected: "dinner with my boyfriend [NAME]",
    description: "name with apostrophe",
  },
  {
    id: "a15",
    input: "Priya and I want ramen",
    expected: "[NAME] and I want ramen",
    description: "X and I pattern",
  },
  {
    id: "a16",
    input: "Anniversary dinner with my wife",
    expected: "Anniversary dinner with my wife",
    description: "no name to redact",
  },
  {
    id: "a17",
    input: "email priya.sharma@gmail.com the plan",
    expected: "email [EMAIL] the plan",
    description: "email address",
  },
  {
    id: "a18",
    input: "with John Smith",
    expected: "with [NAME]",
    description: "first + last name",
  },
  {
    id: "a19",
    input: "with my girlfriend Sarah Jones",
    expected: "with my girlfriend [NAME]",
    description: "relationship + first + last",
  },
  {
    id: "a20",
    input: "my fiancée Ana and I",
    expected: "my fiancée [NAME] and I",
    description: "fiancée relationship word",
  },
  {
    id: "a21",
    input: "Taking Priya out Friday",
    expected: "Taking [NAME] out Friday",
    description: "taking X pattern, preserve Friday",
  },
  {
    id: "a22",
    input: "with my girlfriend, Mei",
    expected: "with my girlfriend, [NAME]",
    description: "relationship + comma + name",
  },
  {
    id: "a23",
    input: "with McKenzie",
    expected: "with [NAME]",
    description: "compound capitalized name (Mc prefix)",
  },
  {
    id: "a24",
    input: "my partner DeShawn",
    expected: "my partner [NAME]",
    description: "compound capitalized name (De prefix)",
  },
];

/**
 * Cases where terms MUST be preserved (b-series)
 */
export const preservationCases: TestCase[] = [
  {
    id: "b1",
    input: "something near 10001",
    expected: "something near 10001",
    description: "neighborhood ZIP should be kept",
  },
  {
    id: "b2",
    input: "drinks in Murray Hill",
    expected: "drinks in Murray Hill",
    description: "neighborhood name",
  },
  {
    id: "b3",
    input: "dinner with Chelsea vibes",
    expected: "dinner with Chelsea vibes",
    description: "'with' + neighborhood, not a person",
  },
  {
    id: "b4",
    input: "with Jackson Heights food",
    expected: "with Jackson Heights food",
    description: "'with' + neighborhood + noun",
  },
  {
    id: "b5",
    input: "picnic with Washington Square Park views",
    expected: "picnic with Washington Square Park views",
    description: "'with' + landmark + noun",
  },
  {
    id: "b6",
    input: "after the show with Madison Square Garden nearby",
    expected: "after the show with Madison Square Garden nearby",
    description: "'with' + landmark + context",
  },
  {
    id: "b7",
    input: "start with Joe's Pizza then drinks",
    expected: "start with Joe's Pizza then drinks",
    description: "possessive venue name",
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
    description: "'with' + multi-word venue",
  },
  {
    id: "b12",
    input: "date with Sunday brunch",
    expected: "date with Sunday brunch",
    description: "'with' + day + noun",
  },
  {
    id: "b14",
    input: "my girlfriend June",
    expected: "my girlfriend [NAME]",
    description: "month as name after relationship word IS redacted",
  },
  {
    id: "b15",
    input: "my wife May",
    expected: "my wife [NAME]",
    description: "month as name after relationship word IS redacted",
  },
  {
    id: "b16",
    input: "my friend August",
    expected: "my friend [NAME]",
    description: "month as name after relationship word IS redacted",
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
    description: "numbers and currency preserved",
  },
  {
    id: "b19",
    input: "call 212-555-1234",
    expected: "call [PHONE]",
    description: "phone number",
  },
  {
    id: "b20",
    input: "under 10001 steps",
    expected: "under 10001 steps",
    description: "5-digit number not a ZIP",
  },
  {
    id: "b21",
    input: "budget 1500000 total lol",
    expected: "budget 1500000 total lol",
    description: "large number preserved",
  },
  {
    id: "b22",
    input: "with SoHo House",
    expected: "with SoHo House",
    description: "'with' + multi-word venue",
  },
  {
    id: "b23",
    input: "with Little Italy and Nolita",
    expected: "with Little Italy and Nolita",
    description: "'with' + neighborhood list",
  },
  {
    id: "b25",
    input: "dinner with Lower East Side cocktails",
    expected: "dinner with Lower East Side cocktails",
    description: "'with' + multi-word neighborhood + noun",
  },
  {
    id: "b26",
    input: "from 7pm till 1130pm, 4 people",
    expected: "from 7pm till 1130pm, 4 people",
    description: "time numbers preserved",
  },
  {
    id: "b27",
    input: "dinner with Hi-Collar then bar",
    expected: "dinner with Hi-Collar then bar",
    description: "'with' + hyphenated venue",
  },
  {
    id: "b28",
    input: "hey can you find a place called Dante",
    expected: "hey can you find a place called Dante",
    description: "'called' + venue, not person",
  },
  {
    id: "b29",
    input: "between 2023 and 2024 we went",
    expected: "between 2023 and 2024 we went",
    description: "years preserved",
  },
];

/**
 * False positive prevention cases
 */
export const falsePositiveCases: TestCase[] = [
  {
    id: "fp1",
    input: "$150 for dinner and drinks",
    expected: "$150 for dinner and drinks",
    description: "currency + 'for' should not trigger address pattern",
  },
  {
    id: "fp2",
    input: "dinner for 2 then drinks",
    expected: "dinner for 2 then drinks",
    description: "'for' + digit + 'then' should not trigger address pattern",
  },
  {
    id: "fp3",
    input: "my partner is vegetarian",
    expected: "my partner is vegetarian",
    description: "'partner' without a name should not redact 'is'",
  },
];

/**
 * Phone and address format cases (c-series)
 */
export const contactCases: TestCase[] = [
  {
    id: "c1",
    input: "+1 (212) 555-1234",
    expected: "+1 [PHONE]",
    description: "international US phone with country code",
  },
  {
    id: "c2",
    input: "212.555.1234",
    expected: "[PHONE]",
    description: "phone with dots",
  },
  {
    id: "c3",
    input: "+44 20 7946 0958",
    expected: "+44 [PHONE]",
    description: "UK international phone",
  },
  {
    id: "c4",
    input: "+33 6 12 34 56 78",
    expected: "+33 [PHONE]",
    description: "French international phone",
  },
  {
    id: "c5",
    input: "I live at 123 W 4th St Apt 5B",
    expected: "I live at [ADDRESS]",
    description: "address with apartment",
  },
  {
    id: "c6",
    input: "1 Main Street",
    expected: "[ADDRESS]",
    description: "simple address",
  },
  {
    id: "c7",
    input: "ZIP 10014-1234",
    expected: "ZIP [ZIP]",
    description: "extended ZIP with context",
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
    description: "address with directional and numbered street",
  },
  {
    id: "c10",
    input: "meet at 45 Rockefeller Plaza",
    expected: "meet at [ADDRESS]",
    description: "address with Plaza",
  },
  {
    id: "c11",
    input: "212 555 1234 ext 5",
    expected: "[PHONE] ext 5",
    description: "phone with extension",
  },
  {
    id: "c12",
    input: "2125551234",
    expected: "[PHONE]",
    description: "phone without formatting",
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
];

/**
 * Edge cases (d-series)
 */
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
    description: "already redacted text unchanged",
  },
  {
    id: "d3",
    input: "with my friend [NAME]",
    expected: "with my friend [NAME]",
    description: "already redacted name",
  },
];

/**
 * Additional realistic NYC date/night-out requests
 */
export const additionalCases: TestCase[] = [
  {
    id: "extra1",
    input: "surprise dinner for Maya's 30th in East Village",
    expected: "surprise dinner for [NAME]'s 30th in East Village",
    description: "surprise X pattern",
  },
  {
    id: "extra2",
    input: "treat Sarah to cocktails in Williamsburg",
    expected: "treat [NAME] to cocktails in Williamsburg",
    description: "treat X pattern",
  },
  {
    id: "extra3",
    input: "Liam and I need quiet bars under $100",
    expected: "[NAME] and I need quiet bars under $100",
    description: "X and I at start",
  },
  {
    id: "extra4",
    input: "anniversary for my bf Marcus",
    expected: "anniversary for my bf [NAME]",
    description: "abbreviated boyfriend",
  },
  {
    id: "extra5",
    input: "my gf Aaliyah loves wine bars",
    expected: "my gf [NAME] loves wine bars",
    description: "abbreviated girlfriend",
  },
  {
    id: "extra6",
    input: "date night for my fiancé and me in Tribeca",
    expected: "date night for my fiancé and me in Tribeca",
    description: "fiancé without name",
  },
  {
    id: "extra7",
    input: "with my date tonight, somewhere cozy",
    expected: "with my date tonight, somewhere cozy",
    description: "'date' as relationship word without name",
  },
  {
    id: "extra8",
    input: "looking for spots near Union Square for Mr. Chen",
    expected: "looking for spots near Union Square for Mr. [NAME]",
    description: "Mr. title + surname",
  },
  {
    id: "extra9",
    input: "party for Mrs. Rodriguez in Brooklyn",
    expected: "party for Mrs. [NAME] in Brooklyn",
    description: "Mrs. title + surname",
  },
  {
    id: "extra10",
    input: "drinks for Ms. Taylor and me",
    expected: "drinks for Ms. [NAME] and me",
    description: "Ms. title + surname",
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
    description: "X and me at start",
  },
  {
    id: "extra13",
    input: "cocktails for my husband and I",
    expected: "cocktails for my husband and I",
    description: "husband without name",
  },
  {
    id: "extra14",
    input: "taking my colleague out after work",
    expected: "taking my colleague out after work",
    description: "colleague without name",
  },
  {
    id: "extra15",
    input: "romantic dinner for Diego and me near Little Italy",
    expected: "romantic dinner for [NAME] and me near Little Italy",
    description: "for X and me, preserve Little Italy",
  },
  {
    id: "extra16",
    input: "my cousin Raj visiting from London",
    expected: "my cousin [NAME] visiting from London",
    description: "cousin relationship word",
  },
  {
    id: "extra17",
    input: "Need recs for my mom birthday",
    expected: "Need recs for my mom birthday",
    description: "mom without name",
  },
  {
    id: "extra18",
    input: "Elena's engagement party",
    expected: "[NAME]'s engagement party",
    description: "X's party pattern",
  },
  {
    id: "extra19",
    input: "date with my partner in Greenwich Village, vegetarian",
    expected: "date with my partner in Greenwich Village, vegetarian",
    description: "partner without name, preserve Greenwich Village and vegetarian",
  },
  {
    id: "extra20",
    input: "something lowkey for Christopher and his wife",
    expected: "something lowkey for [NAME] and his wife",
    description: "X and his/her pattern",
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
