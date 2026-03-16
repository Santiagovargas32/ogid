function normalizedValue(value = "") {
  return String(value || "").trim();
}

export function buildStreamPlaybackSignature(item = {}) {
  return [
    normalizedValue(item.id),
    normalizedValue(item.mode),
    normalizedValue(item.embedUrl),
    normalizedValue(item.fallbackUrl)
  ].join("|");
}

export function buildCollectionPlaybackSignature(items = []) {
  return (Array.isArray(items) ? items : []).map((item) => buildStreamPlaybackSignature(item)).join("||");
}

export function resolveVideoStreamSelection(streams = [], preferred = {}) {
  const sourceStreams = Array.isArray(streams) ? streams : [];
  const regions = [...new Set(sourceStreams.map((item) => item.region).filter(Boolean))];
  const preferredId = normalizedValue(preferred.selectedId);
  const preferredRegion = normalizedValue(preferred.selectedRegion);
  const preferredItem = sourceStreams.find((item) => item.id === preferredId) || null;
  const hasPreferredRegion = Boolean(preferredRegion && regions.includes(preferredRegion));
  const selectedRegion =
    (hasPreferredRegion ? preferredRegion : "") ||
    preferredItem?.region ||
    regions[0] ||
    sourceStreams[0]?.region ||
    "";
  const filteredStreams = sourceStreams.filter((item) => item.region === selectedRegion);
  const selected =
    filteredStreams.find((item) => item.id === preferredId) ||
    filteredStreams[0] ||
    (hasPreferredRegion ? null : preferredItem) ||
    sourceStreams[0] ||
    null;
  const effectiveRegion = selected?.region || selectedRegion;

  return {
    regions,
    selectedRegion: effectiveRegion,
    selectedId: selected?.id || "",
    filteredStreams: sourceStreams.filter((item) => item.region === effectiveRegion),
    selected,
    playbackSignature: buildStreamPlaybackSignature(selected)
  };
}
