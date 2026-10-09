// ICU formatter construction is expensive in candle/session loops.
// Keep the cache bounded; formatting itself retains Intl's DST semantics.
const formatters=new Map();
export function dateTimeFormatter(locale,options={}) {
  const key=JSON.stringify([locale,Object.entries(options).sort(([a],[b])=>a.localeCompare(b))]);
  if(formatters.has(key)){const formatter=formatters.get(key);formatters.delete(key);formatters.set(key,formatter);return formatter;}
  const formatter=new Intl.DateTimeFormat(locale,options);
  formatters.set(key,formatter);if(formatters.size>32)formatters.delete(formatters.keys().next().value);
  return formatter;
}
