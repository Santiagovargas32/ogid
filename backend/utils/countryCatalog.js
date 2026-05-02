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
  }
];

function normalizeText(value = "") {
  return ` ${value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()} `;
}

function buildAliases(country) {
  const values = [country.name, ...(country.aliases ?? [])];
  return [...new Set(values.map((value) => normalizeText(value).trim()).filter(Boolean))];
}

export const BASELINE_COUNTRIES = Object.freeze(
  COUNTRY_ROWS.map((country) => Object.freeze({ ...country, aliases: [...country.aliases] }))
);

const ISO2_SET = new Set(BASELINE_COUNTRIES.map((country) => country.iso2));

const COUNTRY_ALIASES = BASELINE_COUNTRIES.map((country) => ({
  iso2: country.iso2,
  aliases: buildAliases(country)
}));

export function getCountryByIso2(iso2) {
  return BASELINE_COUNTRIES.find((country) => country.iso2 === String(iso2 || "").toUpperCase()) ?? null;
}

export function buildBaselineCountryMap() {
  return Object.fromEntries(
    BASELINE_COUNTRIES.map((country) => [
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

export function isWatchlistCountry(iso2, watchlist = []) {
  const normalizedIso2 = String(iso2 || "").toUpperCase();
  if (!ISO2_SET.has(normalizedIso2)) {
    return false;
  }
  if (!watchlist.length) {
    return true;
  }
  return watchlist.includes(normalizedIso2);
}

export function getSupportedCountryIso2() {
  return [...ISO2_SET];
}
