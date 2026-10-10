import {createHash} from 'node:crypto';
import {canonicalizeArticleUrl} from '../ai/canonicalArticleService.js';
export {canonicalizeArticleUrl};
export function articleIdentity(article={}) {
  const url=canonicalizeArticleUrl(article.url);
  // Sin URL: publisher + título normalizado + fecha fuente válida; nunca posición ni fetchedAt.
  const normalize=v=>String(v||'').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
  const seed=url?`url:${url}`:JSON.stringify([normalize(article.publisher||article.sourceName||article.source?.name||article.provider),normalize(article.title),publicationDate(article.publishedAt).publishedAt?.slice(0,10)||null]);
  return `news-${createHash('sha256').update(seed).digest('hex').slice(0,32)}`;
}
export function publicationDate(value, now=Date.now()) {
  if(!value)return {publishedAt:null,publishedAtQuality:'missing'};
  const time=Date.parse(value);
  if(!Number.isFinite(time))return {publishedAt:null,publishedAtQuality:'invalid'};
  if(time>now+300_000)return {publishedAt:null,publishedAtQuality:'future'};
  return {publishedAt:new Date(time).toISOString(),publishedAtQuality:'source'};
}
