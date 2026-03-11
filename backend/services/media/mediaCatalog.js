const SITUATIONAL_STREAMS = Object.freeze([
  {
    id: "bloomberg",
    name: "Bloomberg",
    region: "Global",
    kind: "youtube",
    channelId: "UCIALMKvObZNtJ6AmdCLP7Lg",
    fallbackUrl: "https://www.youtube.com/@BloombergTV/streams"
  },
  {
    id: "reuters",
    name: "Reuters",
    region: "Global",
    kind: "youtube",
    channelId: "UChqUTb7kYRX8-EiaN3XFrSQ",
    fallbackUrl: "https://www.youtube.com/@Reuters/streams"
  },
  {
    id: "bbc-news",
    name: "BBC News",
    region: "Global",
    kind: "youtube",
    channelHandle: "BBCNews",
    fallbackUrl: "https://www.youtube.com/@BBCNews/streams"
  },
  {
    id: "sky-news",
    name: "Sky News",
    region: "Europe",
    kind: "youtube",
    channelId: "UCoMdktPbSTixAyNGwb-UYkQ",
    fallbackUrl: "https://www.youtube.com/@SkyNews/streams"
  },
  {
    id: "france24",
    name: "France 24",
    region: "Europe",
    kind: "youtube",
    channelId: "UCE9-RvWlHixPLyGQk9TRj3Q",
    fallbackUrl: "https://www.youtube.com/@FRANCE24/streams"
  },
  {
    id: "dw",
    name: "DW News",
    region: "Europe",
    kind: "youtube",
    channelId: "UCknLrEdhRCp1aegoMqRaCZg",
    fallbackUrl: "https://www.youtube.com/@dwnews/streams"
  },
  {
    id: "al-jazeera",
    name: "Al Jazeera English",
    region: "MENA",
    kind: "youtube",
    channelId: "UCR0DUmNzPhLyX6wnmvvEgKA",
    fallbackUrl: "https://www.youtube.com/@aljazeeraenglish/streams"
  },
  {
    id: "i24",
    name: "i24NEWS",
    region: "MENA",
    kind: "youtube",
    channelHandle: "i24NEWS",
    fallbackUrl: "https://www.youtube.com/@i24NEWS/streams"
  },
  {
    id: "abc-news",
    name: "ABC News",
    region: "Americas",
    kind: "youtube",
    channelId: "UCBi2mrWuNuyYy4gbM6fU18Q",
    fallbackUrl: "https://www.youtube.com/@ABCNews/streams"
  },
  {
    id: "cbs-news",
    name: "CBS News",
    region: "Americas",
    kind: "youtube",
    channelId: "UC8p1vwvWtl6T73JiExfWs1g",
    fallbackUrl: "https://www.youtube.com/@CBSNews/streams"
  },
  {
    id: "nbc-news",
    name: "NBC News",
    region: "Americas",
    kind: "youtube",
    channelId: "UCeY0bbntWzzVIaj2z3QigXg",
    fallbackUrl: "https://www.youtube.com/@NBCNews/streams"
  },
  {
    id: "cbc-news",
    name: "CBC News",
    region: "Americas",
    kind: "youtube",
    channelHandle: "CBCNews",
    fallbackUrl: "https://www.youtube.com/@CBCNews/streams"
  },
  {
    id: "euronews",
    name: "Euronews",
    region: "Europe",
    kind: "youtube",
    channelId: "UCSrZ3UV4jOidv8ppoVuvW9Q",
    fallbackUrl: "https://www.youtube.com/@euronews/streams"
  },
  {
    id: "ndtv",
    name: "NDTV",
    region: "Asia",
    kind: "youtube",
    channelHandle: "NDTV",
    fallbackUrl: "https://www.youtube.com/@NDTV/streams"
  },
  {
    id: "wion",
    name: "WION",
    region: "Asia",
    kind: "youtube",
    channelHandle: "WION",
    fallbackUrl: "https://www.youtube.com/@WION/streams"
  },
  {
    id: "cna",
    name: "CNA",
    region: "Asia",
    kind: "youtube",
    channelHandle: "ChannelNewsAsia",
    fallbackUrl: "https://www.youtube.com/@ChannelNewsAsia/streams"
  },
  {
    id: "africa-news",
    name: "Africanews",
    region: "Africa",
    kind: "youtube",
    channelHandle: "africanews",
    fallbackUrl: "https://www.youtube.com/@africanews/streams"
  },
  {
    id: "sky-aus",
    name: "Sky News Australia",
    region: "Oceania",
    kind: "youtube",
    channelHandle: "SkyNewsAustralia",
    fallbackUrl: "https://www.youtube.com/@SkyNewsAustralia/streams"
  }
]);

const WEBCAM_STREAMS = Object.freeze([
  {
    id: "strait-hormuz",
    name: "Strait of Hormuz",
    category: "Shipping Chokepoints",
    kind: "external",
    fallbackUrl: "https://www.marinetraffic.com/"
  },
  {
    id: "bab-el-mandeb",
    name: "Bab el-Mandeb",
    category: "Shipping Chokepoints",
    kind: "external",
    fallbackUrl: "https://www.marinetraffic.com/"
  },
  {
    id: "suez",
    name: "Suez Canal",
    category: "Shipping Chokepoints",
    kind: "external",
    fallbackUrl: "https://www.earthcam.com/"
  },
  {
    id: "panama",
    name: "Panama Canal",
    category: "Shipping Chokepoints",
    kind: "external",
    fallbackUrl: "https://www.pancanal.com/en/webcams/"
  },
  {
    id: "gibraltar",
    name: "Gibraltar Strait",
    category: "Shipping Chokepoints",
    kind: "external",
    fallbackUrl: "https://www.earthcam.com/"
  },
  {
    id: "haifa-port",
    name: "Haifa Port",
    category: "Strategic Ports",
    kind: "external",
    fallbackUrl: "https://www.youtube.com/results?search_query=Haifa+Port+live"
  },
  {
    id: "singapore-port",
    name: "Singapore Port",
    category: "Strategic Ports",
    kind: "external",
    fallbackUrl: "https://www.youtube.com/results?search_query=Singapore+Port+live"
  },
  {
    id: "tel-aviv",
    name: "Tel Aviv Coastline",
    category: "Middle East Monitoring",
    kind: "external",
    fallbackUrl: "https://www.youtube.com/results?search_query=Tel+Aviv+live+cam"
  },
  {
    id: "jerusalem",
    name: "Jerusalem Skyline",
    category: "Middle East Monitoring",
    kind: "external",
    fallbackUrl: "https://www.youtube.com/results?search_query=Jerusalem+live+cam"
  },
  {
    id: "beirut",
    name: "Beirut Harbor",
    category: "Middle East Monitoring",
    kind: "external",
    fallbackUrl: "https://www.youtube.com/results?search_query=Beirut+live+cam"
  },
  {
    id: "taipei",
    name: "Taipei Skyline",
    category: "Global Hotspots",
    kind: "external",
    fallbackUrl: "https://www.youtube.com/results?search_query=Taipei+live+cam"
  },
  {
    id: "kyiv",
    name: "Kyiv Center",
    category: "Conflict Zones",
    kind: "external",
    fallbackUrl: "https://www.youtube.com/results?search_query=Kyiv+live+cam"
  }
]);

export function buildDefaultMediaCatalog() {
  return {
    situational: structuredClone(SITUATIONAL_STREAMS),
    webcams: structuredClone(WEBCAM_STREAMS)
  };
}

