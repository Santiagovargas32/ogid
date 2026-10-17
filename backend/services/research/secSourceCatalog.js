import { readFileSync } from "node:fs";
import { RUNTIME_POLICY } from "../../config/runtimePolicy.js";
import { registerCompany } from "./companyIdentity.js";

const catalog=JSON.parse(readFileSync(new URL("../../config/secCompanies.json",import.meta.url),"utf8"));
const policy=RUNTIME_POLICY.research.sec;
const concepts={
  gaap:["Assets","Liabilities","StockholdersEquity","NetIncomeLoss","RevenueFromContractWithCustomerExcludingAssessedTax","NetCashProvidedByUsedInOperatingActivities"].map(key=>`us-gaap:${key}`),
  ifrs:["Assets","Liabilities","Equity","ProfitLoss","Revenue","CashFlowsFromUsedInOperatingActivities"].map(key=>`ifrs-full:${key}`)
};

export function loadSecSources() {
  return catalog.companies.flatMap(company=>{
    registerCompany(company);
    return ["submissions","companyfacts"].map(kind=>Object.freeze({
      sourceId:`${company.sourcePrefix}-${kind}`,adapter:`sec-${kind}`,companyId:company.companyId,
      name:`${company.name} — SEC ${kind}`,symbols:[...company.symbols],enabled:true,
      verifiedAt:company.metadataSource.verifiedAt,metadataSource:company.metadataSource,
      url:kind === "submissions"?`https://data.sec.gov/submissions/CIK${company.cik}.json`:`https://data.sec.gov/api/xbrl/companyfacts/CIK${company.cik}.json`,
      minPollIntervalMs:kind === "submissions"?policy.submissionsIntervalMs:policy.companyFactsIntervalMs,
      maxBytes:policy.maxResponseBytes,
      ...(kind === "companyfacts"?{concepts:[...concepts.gaap,...concepts.ifrs]}:{})
    }));
  });
}

export const SEC_CATALOG_VERSION=catalog.schemaVersion;
