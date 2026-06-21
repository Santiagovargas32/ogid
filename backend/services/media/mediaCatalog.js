import { buildLiveStreamCatalog } from "../../config/liveStreams.js";

const WEBCAM_STREAMS = Object.freeze([
  {
    id: "strait-hormuz",
    name: "Strait of Hormuz",
    category: "Shipping Chokepoints",
    provider: "external",
    mode: "external",
    fallbackUrl: "https://www.marinetraffic.com/",
    enabled: true
  },
  {
    id: "bab-el-mandeb",
    name: "Bab el-Mandeb",
    category: "Shipping Chokepoints",
    provider: "external",
    mode: "external",
    fallbackUrl: "https://www.marinetraffic.com/",
    enabled: true
  },
  {
    id: "suez",
    name: "Suez Canal",
    category: "Shipping Chokepoints",
    provider: "external",
    mode: "external",
    fallbackUrl: "https://www.earthcam.com/",
    enabled: true
  },
  {
    id: "panama",
    name: "Panama Canal",
    category: "Shipping Chokepoints",
    provider: "external",
    mode: "external",
    fallbackUrl: "https://www.pancanal.com/en/webcams/",
    enabled: true
  },
  {
    id: "gibraltar",
    name: "Gibraltar Strait",
    category: "Shipping Chokepoints",
    provider: "external",
    mode: "external",
    fallbackUrl: "https://www.earthcam.com/",
    enabled: true
  },
  {
    id: "haifa-port",
    name: "Haifa Port",
    category: "Strategic Ports",
    provider: "external",
    mode: "external",
    fallbackUrl: "https://www.youtube.com/results?search_query=Haifa+Port+live",
    enabled: true
  },
  {
    id: "singapore-port",
    name: "Singapore Port",
    category: "Strategic Ports",
    provider: "external",
    mode: "external",
    fallbackUrl: "https://www.youtube.com/results?search_query=Singapore+Port+live",
    enabled: true
  },
  {
    id: "tel-aviv",
    name: "Tel Aviv Coastline",
    category: "Middle East Monitoring",
    provider: "external",
    mode: "external",
    fallbackUrl: "https://www.youtube.com/results?search_query=Tel+Aviv+live+cam",
    enabled: true
  },
  {
    id: "jerusalem",
    name: "Jerusalem Skyline",
    category: "Middle East Monitoring",
    provider: "external",
    mode: "external",
    fallbackUrl: "https://www.youtube.com/results?search_query=Jerusalem+live+cam",
    enabled: true
  },
  {
    id: "beirut",
    name: "Beirut Harbor",
    category: "Middle East Monitoring",
    provider: "external",
    mode: "external",
    fallbackUrl: "https://www.youtube.com/results?search_query=Beirut+live+cam",
    enabled: true
  },
  {
    id: "taipei",
    name: "Taipei Skyline",
    category: "Global Hotspots",
    provider: "external",
    mode: "external",
    fallbackUrl: "https://www.youtube.com/results?search_query=Taipei+live+cam",
    enabled: true
  },
  {
    id: "kyiv",
    name: "Kyiv Center",
    category: "Conflict Zones",
    provider: "external",
    mode: "external",
    fallbackUrl: "https://www.youtube.com/results?search_query=Kyiv+live+cam",
    enabled: true
  }
]);

export function buildDefaultMediaCatalog() {
  return {
    situational: buildLiveStreamCatalog(),
    webcams: structuredClone(WEBCAM_STREAMS)
  };
}
