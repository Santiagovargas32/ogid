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
 source_verification: {
  description:'¿Qué afirmación exacta respalda el documento original y qué elementos siguen sin comprobarse?',
  mechanism:'Distinguir declaración, documento y comprobación independiente delimitaría lo que permite concluir el relato sin ampliar el titular.',
  confirmation:'El documento o declaración originales, su fecha y atribución, y pruebas pertinentes a la afirmación concreta; rastrear la cadena de origen antes de asumir independencia.',
  invalidation:'Una corrección documentada o prueba verificable incompatible con la afirmación original; una ausencia de noticias o negación sin pruebas no bastan.'
 }
}).map(([key,value])=>[key,Object.freeze(value)])));

export function renderBriefVerificationPlan(report){
 const plan=Object.hasOwn(BRIEF_VERIFICATION_PLANS,report.verificationFocus)?BRIEF_VERIFICATION_PLANS[report.verificationFocus]:null;
 if(!plan)throw new RangeError('Unknown brief verification focus');
 return {domain:'geopolitical',kind:'verification-plan',...plan,evidenceIds:[report.evidenceId]};
}
