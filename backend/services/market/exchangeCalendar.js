// Versionado desde fuentes oficiales; reglas recurrentes fuera de 2026 son parciales.
export const CALENDAR_VERSION = "exchange-calendar-2026.2";
export const CALENDAR_SOURCES = Object.freeze({
  US: "https://www.nyse.com/trade/hours-calendars", XNAS: "https://www.nasdaqtrader.com/Trader.aspx?id=Calendar",
  XETR: "https://www.cashmarket.deutsche-boerse.com/cash-en/trading/trading-calendar-and-trading-hours",
  XAMS: "https://www.euronext.com/en/trading/trading-hours-holidays", XMIL: "https://www.euronext.com/en/trading/trading-hours-holidays"
});
const DAY = 86400000;
// Cierres históricos comprobados; no se ocultan otros huecos de proveedor.
const HISTORICAL_CLOSURES = Object.freeze({
  US: Object.freeze({"2025-01-09":Object.freeze({reason:"national-day-of-mourning",sources:["https://www.nasdaqtrader.com/TraderNews.aspx?id=ETA2025-1","https://ir.theice.com/press/news-details/2024/The-New-York-Stock-Exchange-Will-Close-Markets-on-January-9-to-Honor-the-Passing-of-Former-President-Jimmy-Carter-on-National-Day-of-Mourning/default.aspx"]})}),
  XMIL: Object.freeze(Object.fromEntries(["2024-08-15","2025-08-15"].map(date=>[date,Object.freeze({reason:"ferragosto",sources:[CALENDAR_SOURCES.XMIL]})])))
});
export function addDate(date, days) { return new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY).toISOString().slice(0,10); }
export function localDate(value, zone) { return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date(value)); }
export function zonedBoundary(date, minute, zone) {
  const [y,m,d] = date.split("-").map(Number); const wall = Date.UTC(y,m-1,d,Math.floor(minute/60),minute%60); let candidate = wall;
  for(let i=0;i<4;i++) { const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone, hourCycle:"h23", year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" }).formatToParts(new Date(candidate)).map(p=>[p.type,p.value]));
    const actual = Date.UTC(+parts.year,+parts.month-1,+parts.day,+parts.hour%24,+parts.minute); const delta=wall-actual; candidate+=delta; if(!delta) break;
  } return new Date(candidate).toISOString();
}
const weekday = date => new Date(`${date}T12:00:00Z`).getUTCDay();
function nth(y,m,day,n) { const first=`${y}-${String(m).padStart(2,"0")}-01`; return addDate(first,(day-weekday(first)+7)%7+(n-1)*7); }
function last(y,m,day) { const date=new Date(Date.UTC(y,m,0,12)).toISOString().slice(0,10); return addDate(date,-((weekday(date)-day+7)%7)); }
function observed(date) { return addDate(date,weekday(date)===6?-1:weekday(date)===0?1:0); }
function easter(y) { const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),month=Math.floor((h+l-7*m+114)/31),day=(h+l-7*m+114)%31+1; return `${y}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`; }
export function calendarId(instrument={}) {
  const mic=String(instrument.mic || instrument.calendarId || "").toUpperCase(); if(["XNYS","XNAS","ARCX","XASE"].includes(mic)) return mic;
  if(["XETR","XAMS","XMIL"].includes(mic)) return mic;
  const exchange=String(instrument.exchange || "").toLowerCase();
  if(/nasdaq|nms|ngm|ncm/.test(exchange)) return "XNAS";
  if(/nyse|new york/.test(exchange)) return "XNYS";
  if(/xetra|ger/.test(exchange)) return "XETR";
  if(/amsterdam|ams/.test(exchange)) return "XAMS";
  if(/milan|milano/.test(exchange)) return "XMIL";
  return null;
}
export function tradingDay(instrument, date) {
  const id=calendarId(instrument); const us=["XNYS","XNAS","ARCX","XASE"].includes(id); const y=+date.slice(0,4); const e=easter(y);
  const zone=us?"America/New_York":id==="XETR"?"Europe/Berlin":id==="XAMS"?"Europe/Amsterdam":id==="XMIL"?"Europe/Rome":instrument.timezone || "UTC";
  const holidays=us?[observed(`${y}-01-01`),nth(y,1,1,3),nth(y,2,1,3),addDate(e,-2),last(y,5,1),...(y>=2022?[observed(`${y}-06-19`)]:[]),observed(`${y}-07-04`),nth(y,9,1,1),nth(y,11,4,4),observed(`${y}-12-25`)]:[`${y}-01-01`,addDate(e,-2),addDate(e,1),`${y}-05-01`,`${y}-12-25`,`${y}-12-26`,...(["XETR","XMIL"].includes(id)?[`${y}-12-24`,`${y}-12-31`]:[])];
  const openMinute=us||!id?570:540; let closeMinute=us||!id?960:1050;
  const early=us && (date===addDate(nth(y,11,4,4),1) || (date===`${y}-12-24` && weekday(date)>=1 && weekday(date)<=4) || (date===`${y}-07-03` && weekday(date)>=1 && weekday(date)<=4));
  if(early) closeMinute=780;
  const halfDayPending=id==="XAMS" && [`${y}-12-24`,`${y}-12-31`].includes(date) && ![0,6].includes(weekday(date));
  const partial=!id || y!==2026 || halfDayPending;
  const historicalClosure=HISTORICAL_CLOSURES[us?"US":id]?.[date]||null;
  const closed=[0,6].includes(weekday(date)) || holidays.includes(date) || Boolean(historicalClosure);
  return { calendarId:id, methodVersion:CALENDAR_VERSION, date, timezone:zone, closed, earlyClose:Boolean(early), halfDayPending,
    openMinute, closeMinute, openTime:closed||halfDayPending?null:zonedBoundary(date,openMinute,zone), closeTime:closed||halfDayPending?null:zonedBoundary(date,closeMinute,zone),
    premarket:us ? (id==="XNAS"||id==="ARCX"?{openMinute:240,closeMinute:570}:null):null,
    afterHours:us && id!=="XNYS" ? {openMinute:closeMinute,closeMinute:early?1020:1200}:null,
    partial, historicalClosure:historicalClosure?{reason:historicalClosure.reason}:null,sources: id?[CALENDAR_SOURCES[id] || CALENDAR_SOURCES.US,...(historicalClosure?.sources||[])]:[],
    warnings:[...(!id?["Unknown venue; weekday cash approximation."]:[]),...(y!==2026?["Recurring rules plus listed historical exceptions; other exceptional closures not verified."]:[]),...(halfDayPending?["Official half day; closing time pending appendix. No closed candle inferred."]:[])] };
}
export function adjacentTradingDay(instrument,date,direction) { for(let n=1;n<=370;n++) { const day=tradingDay(instrument,addDate(date,n*direction)); if(!day.closed&&!day.halfDayPending) return day; } return null; }
export function expectedDailyGaps(candles,instrument) {
  const gaps=[]; for(let i=1;i<candles.length;i++) { let day=addDate(localDate(candles[i-1].openTime,instrument.timezone),1); const end=localDate(candles[i].openTime,instrument.timezone);
    for(let n=0;day<end&&n<10000;n++,day=addDate(day,1)) { const session=instrument.sessionPolicy==="24x7"?{closed:false}:tradingDay(instrument,day); if(!session.closed&&!session.halfDayPending) gaps.push(day); }
  } return gaps;
}
export function expectedIntradayGapCount(previous,current,instrument,intervalMs) {
  const from=Date.parse(previous.openTime),to=Date.parse(current.openTime);
  if(!(to>from)||!(intervalMs>0))return 0;
  const zone=instrument.timezone||"UTC";const end=localDate(to,zone);let count=0;
  for(let date=localDate(from,zone),n=0;date<=end&&n<10000;date=addDate(date,1),n++) {
    const day=tradingDay(instrument,date);if(!day.openTime||!day.closeTime)continue;
    const open=Date.parse(day.openTime),close=Date.parse(day.closeTime);
    const first=Math.max(0,Math.floor((from-open)/intervalMs)+1);
    const last=Math.min(Math.ceil((close-open)/intervalMs)-1,Math.ceil((to-open)/intervalMs)-1);
    count+=Math.max(0,last-first+1);
  }return count;
}
export function cashCalendarSchedule(instrument,value,intervalMs=300000) {
  const now=+new Date(value); const id=calendarId(instrument); const zone=tradingDay(instrument,new Date(value).toISOString().slice(0,10)).timezone;
  const date=localDate(value,zone); const day=tradingDay(instrument,date); const open=Date.parse(day.openTime),close=Date.parse(day.closeTime); const eligible=now>=open&&now<close;
  const previous=adjacentTradingDay(instrument,date,-1); const next=now<open?day:adjacentTradingDay(instrument,date,1);
  const expected=now>=close?day.closeTime:eligible&&now-open>=intervalMs?new Date(open+Math.floor((now-open)/intervalMs)*intervalMs).toISOString():previous?.closeTime || null;
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en",{timeZone:zone,hourCycle:"h23",hour:"2-digit",minute:"2-digit"}).formatToParts(new Date(now)).map(p=>[p.type,p.value])); const minute=+parts.hour*60 + +parts.minute;
  const trading=!day.closed&&!day.halfDayPending; const phase=eligible?"regular":trading&&day.premarket&&minute>=day.premarket.openMinute&&minute<day.premarket.closeMinute?"premarket":trading&&day.afterHours&&minute>=day.afterHours.openMinute&&minute<day.afterHours.closeMinute?"after-hours":"closed";
  return { eligible,sessionState:eligible?"open":day.halfDayPending?"unknown":"closed",sessionPhase:phase,sessionId:eligible?date:null,minute,sessionOpenMinute:day.openMinute,sessionCloseMinute:day.closeMinute,expectedLatestCandleAt:day.halfDayPending?null:expected,nextEligibleAt:eligible?null:next?.openTime || null,timezone:zone,sessionCalendar:id||"weekday_exchange_hours_approximation",sessionPolicyPartial:day.partial,calendar:day,limitations:day.warnings };
}
