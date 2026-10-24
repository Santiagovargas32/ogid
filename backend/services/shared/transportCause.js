export function transportCause(error){
  const code=String(error?.cause?.code||error?.code||'');
  const status=error?.httpStatus??error?.response?.status,httpStatus=Number.isInteger(status)&&status>=100&&status<=599?status:null;
  const category=httpStatus?'http':/ENOTFOUND|EAI_AGAIN/.test(code)?'dns':/CERT|TLS|SSL/.test(code)?'tls':/TIMEOUT|ETIMEDOUT|TimeoutError/.test(code+' '+error?.name)?'timeout':/ECONN|EPIPE|ENET|EHOST/.test(code)?'connection':'unknown';
  return {category,httpStatus,code:/^[A-Z][A-Z0-9_]{1,80}$/.test(code)?code:null,timeoutOrigin:category==='timeout'?(error?.name==='TimeoutError'?'local-deadline':'transport'):null};
}
