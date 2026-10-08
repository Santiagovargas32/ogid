import test from "node:test";
import assert from "node:assert/strict";
import { generatePredictions } from "../services/market/predictionEngineService.js";

test("generatePredictions builds deterministic sector and ticker outputs", () => {
  const now = new Date().toISOString();
  const articles = [
    {
      id: "a1",
      title: "Defense activity increases in region",
      description: "Military units move near disputed border.",
      content: "Markets monitor defense budget implications.",
      publishedAt: now,
      countryMentions: ["IL"],
      sentiment: { label: "negative" },
      conflict: { totalWeight: 8, tags: [{ tag: "Military", count: 2 }] }
    },
    {
      id: "a2",
      title: "Oil shipping routes face renewed pressure",
      description: "Tanker traffic slowed after security warnings.",
      content: "Oil traders react to route risks.",
      publishedAt: now,
      countryMentions: ["IR"],
      sentiment: { label: "negative" },
      conflict: { totalWeight: 6, tags: [{ tag: "Sanctions", count: 1 }] }
    }
  ];

  const predictions = generatePredictions({
    articles,
    countries: { IL: { level: "Critical" }, IR: { level: "Elevated" } },
    marketQuotes: {
      GD: { changePct: 1.2 },
      BA: { changePct: 0.8 },
      XOM: { changePct: -0.3 },
      SPY: { changePct: 0.1 }
    },
    tickers: ["GD", "BA", "XOM", "SPY"],
    instruments: [
      { canonicalSymbol: "GD", displayName: "General Dynamics", sector: "Aerospace & Defense", assetType: "equity" },
      { canonicalSymbol: "BA", displayName: "Boeing", sector: "Aerospace & Defense", assetType: "equity" },
      { canonicalSymbol: "XOM", displayName: "Exxon Mobil", sector: "Energy", assetType: "equity" },
      { canonicalSymbol: "SPY", displayName: "S&P 500 ETF", assetType: "etf" }
    ],
    inputMode: "mixed"
  });

  assert.equal(Array.isArray(predictions.sectors), true);
  assert.equal(Array.isArray(predictions.tickers), true);
  assert.equal(predictions.inputMode, "mixed");
  assert.ok(predictions.sectors.some((item) => item.sector === "defense"));
  assert.ok(predictions.tickers.some((item) => item.ticker === "GD"));
});

test("negative war headlines do not establish defense benefit; scores remain explicitly heuristic",()=>{
  const input={tickers:["GD"],instruments:[{canonicalSymbol:"GD",displayName:"General Dynamics",sector:"defense",assetType:"equity"}],marketQuotes:{GD:{price:100,changePct:1,dataMode:"observed"}},articles:[{id:"war",title:"Conflict worsens and casualties rise",publishedAt:"2026-10-08T12:00:00Z",sentiment:{label:"negative"},conflict:{totalWeight:10}}]};
  const result=generatePredictions(input);assert.deepEqual(result.sectors[0].basedOnArticles,[]);assert.equal(result.tickers[0].confidence,result.tickers[0].signalStrength);assert.equal(result.tickers[0].confidenceKind,"heuristic-signal-strength");assert.equal(result.tickers[0].probability,null);
  input.articles.push({id:"contract",title:"General Dynamics awarded an official contract",publishedAt:"2026-10-08T13:00:00Z"});assert.deepEqual(generatePredictions(input).sectors[0].basedOnArticles,["contract"]);
  input.marketQuotes.GD.changePct=null;assert.equal(generatePredictions(input).tickers[0].direction,"Unavailable");input.marketQuotes.GD.changePct=1;input.marketQuotes.GD.dataMode="seeded";assert.equal(generatePredictions(input).tickers[0].quality.marketUsable,false);
});
