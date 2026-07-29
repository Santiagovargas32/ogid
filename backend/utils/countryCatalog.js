const COUNTRY_ROWS = [
  {
    iso2: "US",
    name: "United States",
    lat: 38.9072,
    lng: -77.0369,
    aliases: ["usa", "u.s.", "america", "united states of america", "washington"]
  },
  {
    iso2: "RU",
    name: "Russia",
    lat: 55.7558,
    lng: 37.6173,
    aliases: ["russian federation", "moscow"]
  },
  {
    iso2: "CN",
    name: "China",
    lat: 39.9042,
    lng: 116.4074,
    aliases: ["prc", "beijing", "chinese"]
  },
  {
    iso2: "UA",
    name: "Ukraine",
    lat: 50.4501,
    lng: 30.5234,
    aliases: ["kyiv", "kiev", "ukrainian"]
  },
  {
    iso2: "IL",
    name: "Israel",
    lat: 31.7683,
    lng: 35.2137,
    aliases: ["israeli", "jerusalem", "tel aviv"]
  },
  {
    iso2: "IR",
    name: "Iran",
    lat: 35.6892,
    lng: 51.389,
    aliases: ["iranian", "tehran"]
  },
  {
    iso2: "SY",
    name: "Syria",
    lat: 33.5138,
    lng: 36.2765,
    aliases: ["syrian", "damascus"]
  },
  {
    iso2: "IQ",
    name: "Iraq",
    lat: 33.3152,
    lng: 44.3661,
    aliases: ["iraqi", "baghdad"]
  },
  {
    iso2: "AF",
    name: "Afghanistan",
    lat: 34.5553,
    lng: 69.2075,
    aliases: ["afghan", "kabul"]
  },
  {
    iso2: "KP",
    name: "North Korea",
    lat: 39.0392,
    lng: 125.7625,
    aliases: ["dprk", "pyongyang", "north korean"]
  },
  {
    iso2: "KR",
    name: "South Korea",
    lat: 37.5665,
    lng: 126.978,
    aliases: ["republic of korea", "seoul", "south korean"]
  },
  {
    iso2: "TW",
    name: "Taiwan",
    lat: 25.033,
    lng: 121.5654,
    aliases: ["taipei"]
  },
  {
    iso2: "IN",
    name: "India",
    lat: 28.6139,
    lng: 77.209,
    aliases: ["indian", "new delhi"]
  },
  {
    iso2: "PK",
    name: "Pakistan",
    lat: 33.6844,
    lng: 73.0479,
    aliases: ["pakistani", "islamabad"]
  },
  {
    iso2: "TR",
    name: "Turkey",
    lat: 39.9334,
    lng: 32.8597,
    aliases: ["turkiye", "turkish", "ankara"]
  },
  {
    iso2: "YE",
    name: "Yemen",
    lat: 15.3694,
    lng: 44.191,
    aliases: ["yemeni", "sanaa", "houthi"]
  },
  {
    iso2: "SD",
    name: "Sudan",
    lat: 15.5007,
    lng: 32.5599,
    aliases: ["khartoum", "sudanese"]
  },
  {
    iso2: "ET",
    name: "Ethiopia",
    lat: 8.9806,
    lng: 38.7578,
    aliases: ["ethiopian", "addis ababa"]
  },
  {
    iso2: "VE",
    name: "Venezuela",
    lat: 10.4806,
    lng: -66.9036,
    aliases: ["venezuelan", "caracas"]
  },
  {
    iso2: "CO",
    name: "Colombia",
    lat: 4.711,
    lng: -74.0721,
    aliases: ["colombian", "bogota"]
  },
  {
    iso2: "MM",
    name: "Myanmar",
    lat: 19.7633,
    lng: 96.0785,
    aliases: ["burma", "naypyidaw", "myanmarese"]
  },
  {
    iso2: "AE",
    name: "United Arab Emirates",
    lat: 24.4539,
    lng: 54.3773,
    aliases: ["uae", "u.a.e.", "emirati", "abu dhabi", "dubai", "jebel ali"]
  },
  {
    iso2: "NL",
    name: "Netherlands",
    lat: 52.3676,
    lng: 4.9041,
    aliases: ["dutch", "holland", "amsterdam", "rotterdam"]
  },
  {
    iso2: "GB",
    name: "United Kingdom",
    lat: 51.5072,
    lng: -0.1276,
    aliases: ["uk", "u.k.", "britain", "great britain", "british", "england", "london", "heathrow"]
  },
  {
    iso2: "SA",
    name: "Saudi Arabia",
    lat: 24.7136,
    lng: 46.6753,
    aliases: ["saudi", "saudi arabian", "riyadh", "ras tanura"]
  },
  {
    iso2: "CD",
    name: "Democratic Republic of the Congo",
    lat: -4.4419,
    lng: 15.2663,
    aliases: ["democratic republic of congo", "dr congo", "drc", "congolese", "kinshasa", "katanga"]
  },
  {
    iso2: "AR",
    name: "Argentina",
    lat: -34.6037,
    lng: -58.3816,
    aliases: ["argentine", "argentinian", "buenos aires", "lithium triangle"]
  },
  {
    iso2: "BO",
    name: "Bolivia",
    lat: -16.4897,
    lng: -68.1193,
    aliases: ["bolivian", "la paz", "lithium triangle"]
  },
  {
    iso2: "CL",
    name: "Chile",
    lat: -33.4489,
    lng: -70.6693,
    aliases: ["chilean", "lithium triangle"]
  },
  {
    iso2: "EG",
    name: "Egypt",
    lat: 30.0444,
    lng: 31.2357,
    aliases: ["egyptian", "cairo", "suez"]
  },
  {
    iso2: "DE",
    name: "Germany",
    lat: 52.52,
    lng: 13.405,
    aliases: ["german", "berlin", "frankfurt"]
  },
  {
    iso2: "SG",
    name: "Singapore",
    lat: 1.3521,
    lng: 103.8198,
    aliases: ["singaporean"]
  },
  {
    iso2: "JO",
    name: "Jordan",
    lat: 31.9539,
    lng: 35.9106,
    aliases: ["jordanian", "amman"]
  },
  {
    iso2: "KW",
    name: "Kuwait",
    lat: 29.3759,
    lng: 47.9774,
    aliases: ["kuwaiti", "kuwait city"]
  },
  {
    iso2: "BH",
    name: "Bahrain",
    lat: 26.2235,
    lng: 50.5876,
    aliases: ["bahraini", "manama"]
  },
  {
    iso2: "OM",
    name: "Oman",
    lat: 23.588,
    lng: 58.3829,
    aliases: ["omani", "muscat", "masirah", "thumrait"]
  },
  {
    iso2: "DJ",
    name: "Djibouti",
    lat: 11.5721,
    lng: 43.1456,
    aliases: ["djiboutian", "camp lemonnier"]
  },
  {
    iso2: "IT",
    name: "Italy",
    lat: 41.9028,
    lng: 12.4964,
    aliases: ["italian", "rome", "naples"]
  },
  {
    iso2: "MY",
    name: "Malaysia",
    lat: 3.139,
    lng: 101.6869,
    aliases: ["malaysian", "kuala lumpur", "malacca"]
  },
  {
    iso2: "ID",
    name: "Indonesia",
    lat: -6.2088,
    lng: 106.8456,
    aliases: ["indonesian", "jakarta", "malacca strait"]
  },
  {
    iso2: "PA",
    name: "Panama",
    lat: 8.9824,
    lng: -79.5199,
    aliases: ["panamanian", "panama city", "panama canal"]
  },
  {
    iso2: "KZ",
    name: "Kazakhstan",
    lat: 51.1694,
    lng: 71.4491,
    aliases: ["kazakh", "kazakhstani", "astana", "baikonur"]
  }
];

function normalizeText(value = "") {
  return ` ${value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()} `;
}

function buildAliases(country) {
  const values = [country.name, ...(country.aliases ?? [])];
  return [...new Set(values.map((value) => normalizeText(value).trim()).filter(Boolean))];
}

const BASELINE_ISO2 = new Set([
  "US", "RU", "CN", "UA", "IL", "IR", "SY", "IQ", "AF", "KP", "KR", "TW", "IN", "PK", "TR", "YE", "SD", "ET", "VE", "CO", "MM"
]);

const AMBIGUOUS_DETECTION_ALIASES = Object.freeze({
  JO: new Set(["jordan"]),
  CD: new Set(["congolese"])
});

export const COUNTRY_CATALOG = Object.freeze(
  COUNTRY_ROWS.map((country) => Object.freeze({ ...country, aliases: Object.freeze([...country.aliases]) }))
);

export const BASELINE_COUNTRIES = Object.freeze(COUNTRY_CATALOG.filter((country) => BASELINE_ISO2.has(country.iso2)));

const COUNTRY_ALIASES = COUNTRY_CATALOG.map((country) => ({
  iso2: country.iso2,
  aliases: buildAliases(country).filter((alias) => !AMBIGUOUS_DETECTION_ALIASES[country.iso2]?.has(alias))
}));

export function getCountryByIso2(iso2) {
  return COUNTRY_CATALOG.find((country) => country.iso2 === String(iso2 || "").toUpperCase()) ?? null;
}

function buildCountryMap(countries) {
  return Object.fromEntries(
    countries.map((country) => [
      country.iso2,
      {
        iso2: country.iso2,
        country: country.name,
        lat: country.lat,
        lng: country.lng
      }
    ])
  );
}

export function buildBaselineCountryMap() {
  return buildCountryMap(BASELINE_COUNTRIES);
}

export function buildCountryCatalogMap() {
  return buildCountryMap(COUNTRY_CATALOG);
}

export function detectCountryMentions(text = "") {
  const normalized = normalizeText(text);
  const matches = new Set();

  for (const country of COUNTRY_ALIASES) {
    if (country.aliases.some((alias) => normalized.includes(` ${alias} `))) {
      matches.add(country.iso2);
    }
  }

  return [...matches];
}
