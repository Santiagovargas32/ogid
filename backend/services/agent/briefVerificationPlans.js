// Versioned verification methods, not factual findings or model-authored
// explanations. The model selects one focus for each exact source quotation.
export const BRIEF_VERIFICATION_PLANS = Object.freeze(Object.fromEntries(Object.entries({
 policy_scope: {
  description:'¿Qué sujetos y conductas abarca exactamente la medida descrita y desde cuándo sería aplicable?',
  mechanism:'Distinguir destinatarios, alcance y condiciones permitiría separar el anuncio de su aplicación; el titular no acredita efectos ya materializados.',
  confirmation:'El instrumento oficial y sus anexos, con destinatarios, conductas, vigencia y posibles excepciones. No basta con repetir el anuncio.',
  invalidation:'Un texto oficial verificable cuyo alcance, destinatarios o condiciones sean incompatibles con la interpretación inicial.'
 },
 reported_event: {
  description:'¿Qué pruebas permiten establecer por separado el lugar, el momento y la atribución del episodio relatado?',
  mechanism:'Contrastar esos elementos permitiría distinguir la declaración de una parte de la ocurrencia y autoría acreditadas.',
  confirmation:'Material original con procedencia verificable, localización y cronología compatibles, y respaldo pertinente a la atribución.',
  invalidation:'Pruebas autenticadas que sitúen el material en otro lugar o momento, o contradigan la atribución propuesta.'
 },
 delivery_status: {
  description:'¿El relato describe una solicitud, un compromiso o una entrega documentada, y qué alcance tiene esa fase?',
  mechanism:'Distinguir esas fases evitaría equiparar una intención o un pago con disponibilidad operativa.',
  confirmation:'La solicitud o acuerdo original y, si se afirma una entrega, registros verificables de recepción, condiciones y estado de ejecución.',
  invalidation:'Documentación primaria que muestre condiciones distintas o una fase de ejecución incompatible con la interpretación inicial.'
 },
 capability_status: {
  description:'¿Qué pruebas distinguen una capacidad anunciada de un uso operativo verificable y qué alcance permiten acreditar?',
  mechanism:'Una declaración o demostración no basta para atribuir despliegue ni resultados; distinguir esas fases cambia el alcance de la interpretación.',
  confirmation:'Material original verificable y documentación técnica o registros de uso que diferencien pruebas y operación.',
  invalidation:'Pruebas autenticadas incompatibles con el uso o alcance atribuidos, o documentación que lo sitúe sólo en fase experimental.'
 },
 negotiation_process: {
  description:'¿Qué fase documentada ha alcanzado el proceso y qué participantes, agenda y compromisos están confirmados?',
  mechanism:'Distinguir propuesta, convocatoria y acuerdo evitaría tratar una intención como participación, compromiso o aplicación acreditados.',
  confirmation:'La convocatoria o comunicación original y, si existe un acuerdo, su texto publicado, diferenciando participantes, agenda y compromisos.',
  invalidation:'Documentación verificable que contradiga la fase, participación o términos atribuidos al proceso.'
 },
 policy_disagreement: {
  description:'¿A qué decisión concreta se refiere la discrepancia relatada y qué posiciones constan en fuentes primarias?',
  mechanism:'Delimitar el punto de desacuerdo permitiría distinguir una divergencia declarada de un cambio efectivo de política.',
  confirmation:'Las declaraciones completas y su contexto, y el texto de la decisión si se afirma que existe una medida acordada.',
  invalidation:'Documentación primaria que contradiga el desacuerdo atribuido o muestre un alcance distinto de la divergencia relatada.'
 },
 forecast_or_opinion: {
  description:'¿Qué supuestos, método y horizonte sostienen la interpretación o previsión atribuida?',
  mechanism:'Conocerlos permitiría distinguir opinión, escenario y observación, sin tratar resultados futuros como hechos ya observados.',
  confirmation:'El texto completo y sus supuestos o metodología, contrastados con observaciones elegibles del mismo ámbito y momento.',
  invalidation:'Supuestos documentados incompatibles con la interpretación, o observaciones pertinentes que contradigan el escenario sin seleccionar datos a posteriori.'
 },
 election_result: {
  description:'¿Qué circunscripciones, fecha y resultados oficiales respaldan el resultado electoral relatado?',
  mechanism:'Distinguir proyección, resultado provisional y proclamación impediría presentar una fase como definitiva o extrapolar una elección parcial a un resultado más amplio.',
  confirmation:'Actas y publicación verificable de la autoridad electoral competente, con circunscripción, fecha y estado provisional o definitivo del resultado.',
  invalidation:'Actas autenticadas o una corrección oficial incompatibles con el resultado o alcance atribuidos; una ausencia de información no demuestra que el resultado sea falso.'
 },
 source_verification: {
  description:'¿Qué afirmación exacta respalda el documento original y qué elementos siguen sin comprobarse?',
  mechanism:'Distinguir declaración, documento y comprobación independiente delimitaría lo que permite concluir el relato sin ampliar el titular.',
  confirmation:'El documento o declaración originales, su fecha y atribución, y pruebas pertinentes a la afirmación concreta; rastrear la cadena de origen antes de asumir independencia.',
  invalidation:'Una corrección documentada o prueba verificable incompatible con la afirmación original; una ausencia de noticias o negación sin pruebas no bastan.'
 }
}).map(([key,value])=>[key,Object.freeze(value)])));

export function briefVerificationFocuses(job){
 const keys=Object.keys(BRIEF_VERIFICATION_PLANS);
 return job.promptVersion==='ogid-analyst-v1.25'?keys.filter(k=>k!=='election_result'):['source_verification',...keys.filter(k=>k!=='source_verification').map(k=>k==='reported_event'?'incident_evidence':k)];
}
const focusMeaning={
 source_verification:'Atribución y documento original; usa este enfoque general si no encaja otro más específico.',
 policy_scope:'Alcance y aplicación de medidas, sanciones o normas.',
 incident_evidence:'Sólo incidentes físicos: ataques, desastres o siniestros. No lo uses para cualquier noticia, discrepancias políticas, elecciones ni delitos financieros.',
 delivery_status:'Solicitudes, compromisos o entregas de material.',
 capability_status:'Distinguir capacidad anunciada, demostración y uso operativo.',
 negotiation_process:'Convocatorias, conversaciones, reuniones o acuerdos.',
 policy_disagreement:'Discrepancias o divisiones sobre una política; prevalece sobre el tema de esa política, también si trata de sanciones.',
 election_result:'Victorias, derrotas o resultados electorales; comprobar actas y estado del resultado.',
 forecast_or_opinion:'Opiniones, escenarios y previsiones, sin tratarlos como hechos observados.'
};
export function briefVerificationFocusDescription(job){
 return briefVerificationFocuses(job).map(key=>`${key}: ${job.promptVersion==='ogid-analyst-v1.25'?BRIEF_VERIFICATION_PLANS[key].description:focusMeaning[key]}`).join(' ');
}

// Literal topic compatibility is an input contract, not verification of truth
// or an automatic usefulness score. Unrecognized topics keep the general focus.
export const briefFocusCompatibility=[
 {if:{properties:{quote:{pattern:'\\b[Pp]olicy\\s+(?:[Rr]ift|[Dd]isagreement|[Ss]plit)\\b'}}},then:{properties:{verificationFocus:{const:'policy_disagreement'}}}},
 {if:{allOf:[{properties:{quote:{pattern:'\\b[Bb]y[- ][Ee]lections?\\b'}}},{properties:{quote:{pattern:'\\b(?:[Ww]ins?|[Ll]oses?|[Rr]esults?)\\b'}}},{not:{properties:{quote:{pattern:'\\?|\\b(?:[Cc]ould|[Ee]xpected|[Ww]ill|[Mm]ay)\\b'}}}}]},then:{properties:{verificationFocus:{const:'election_result'}}}},
 {if:{properties:{verificationFocus:{const:'incident_evidence'}}},then:{properties:{quote:{allOf:[{pattern:'\\b(?:[Aa]ttacks?|[Aa]irstrikes?|[Bb]ombing|[Ee]xplosion|[Ee]arthquake|[Ff]lood|[Ww]ildfire|[Ss]inks?|[Kk]illed|[Cc]rash)\\b'},{not:{pattern:'\\b(?:[Cc]yber(?:attacks?)?|[Hh]eist|[Hh]acking|[Ff]raud)\\b'}}]}}}}
];

export function renderBriefVerificationPlan(report){
 const key=report.verificationFocus==='incident_evidence'?'reported_event':report.verificationFocus;
 const plan=Object.hasOwn(BRIEF_VERIFICATION_PLANS,key)?BRIEF_VERIFICATION_PLANS[key]:null;
 if(!plan)throw new RangeError('Unknown brief verification focus');
 return {domain:'geopolitical',kind:'verification-plan',...plan,evidenceIds:[report.evidenceId]};
}
