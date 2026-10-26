export function newsEditorialLabels(article = {}) {
  const resolved = article.publisherResolution?.status === 'resolved' && article.publisherId;
  const scope = {headline:'Sólo titular',excerpt:'Titular y extracto','permitted-text':'Texto permitido'}[article.classification?.textScope] || 'Alcance textual desconocido';
  const status = {evaluated:'Reglas editoriales', 'unsupported-language':'Idioma sin soporte', 'unknown-language':'Idioma sin evaluar', 'insufficient-text':'Texto insuficiente'}[article.classification?.status] || 'Clasificación pendiente';
  const modality = {negated:'Negación atribuida',prospective:'Amenaza o posibilidad futura',opinion:'Opinión o análisis',mixed:'Modalidad mixta',reported:'Reporte atribuido'}[article.classification?.modality] || 'Modalidad desconocida';
  return {publisher:resolved ? article.publisher || article.publisherId : 'Editor pendiente',
    provenance:`Descubrimiento: ${article.discoverySourceId || article.sourceName || article.provider || 'desconocido'}`,
    scope,status,modality};
}
