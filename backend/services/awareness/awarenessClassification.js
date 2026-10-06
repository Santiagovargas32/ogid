export function officialReleaseKind(event) {
  if (event.kind !== "macro_release" || event.source?.official !== true) return event.kind;
  try {
    const url = new URL(event.canonicalUrl);
    if (url.protocol === "https:" && ["www.federalreserve.gov", "federalreserve.gov"].includes(url.hostname) &&
        /^\/newsevents\/pressreleases\/(?:orders|bcreg|enforcement)\d+[a-z]\.htm$/i.test(url.pathname)) return "regulatory_filing";
  } catch { /* Classification never invents a canonical URL. */ }
  return event.kind;
}
