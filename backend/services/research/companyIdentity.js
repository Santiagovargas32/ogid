import { AppError } from "../../utils/error.js";
import { safeUrl } from "../../utils/researchProjection.js";
const companies = new Map();
export function registerCompany(value) {
  if(["__proto__","constructor","prototype"].includes(value.companyId)||!/^[a-zA-Z0-9._:-]{1,128}$/.test(value.companyId||"")||!value.name||!safeUrl(value.metadataSource?.url)||!Number.isFinite(Date.parse(value.metadataSource?.verifiedAt||""))||value.cik&&!/^\d{10}$/.test(value.cik))throw new AppError("Identidad de entidad sin evidencia verificada.",400,"INVALID_COMPANY_IDENTITY");
  const existing=companies.get(value.companyId);if(existing?.cik&&value.cik&&existing.cik!==value.cik)throw new AppError("CIK incompatible.",409,"COMPANY_IDENTITY_CONFLICT");
  if(value.cik&&[...companies.values()].some(c=>c.companyId!==value.companyId&&c.cik===value.cik))throw new AppError("El CIK pertenece a una sola entidad.",409,"COMPANY_IDENTITY_CONFLICT");
  const row=Object.freeze({identityVersion:"company-identity-v1",companyId:value.companyId,name:String(value.name).slice(0,200),cik:value.cik||existing?.cik||null,metadataSource:{url:safeUrl(value.metadataSource.url),verifiedAt:value.metadataSource.verifiedAt},revision:(existing?.revision||0)+1});companies.set(row.companyId,row);return row;
}
export function getCompany(id){return companies.get(id)||null;}
