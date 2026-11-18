const modes = new Set(['servidor','estado','noticias']);
const official = host => /(?:^|\.)(?:gob\.mx|asf\.gob\.mx|justice\.gov|worldbank\.org|europa\.eu)$/.test(host);
const scrub = value => String(value || '').normalize('NFC').replace(/[^\p{L}\p{N} .'-]/gu,' ').replace(/\s+/g,' ').trim();

module.exports = async (req,res) => {
  res.setHeader('Cache-Control','no-store');
  if (req.method !== 'GET') return res.status(405).json({error:'Método inválido.'});
  const {modo,tema}=req.query;
  const topic=scrub(tema);
  if (!modes.has(modo) || topic.length>90 || (modo!=='noticias' && topic.length<3)) {
    return res.status(400).json({error:'Indica un lugar, tema o nombre público válido.'});
  }
  // Search a fixed news index. The request never retrieves user-supplied URLs.
  const subject=topic?'"'+topic+'" ':'';
  const terms=modo==='servidor'?'(funcionario OR nombramiento OR auditoría OR official)':'(corrupción OR desvío OR auditoría OR corruption OR bribery)';
  const url=new URL('https://api.gdeltproject.org/api/v2/doc/doc');
  for(const [key,value] of Object.entries({query:subject+terms,mode:'ArtList',format:'json',sort:'DateDesc',maxrecords:'25',timespan:'3months'})) url.searchParams.set(key,value);
  try {
    const upstream=await fetch(url,{signal:AbortSignal.timeout(7500),headers:{Accept:'application/json'}});
    if(!upstream.ok) throw new Error('source unavailable');
    const payload=await upstream.json();
    if(!Array.isArray(payload.articles)) throw new Error('invalid response');
    const results=new Map();
    for(const item of payload.articles) {
      let link;
      try { link=new URL(item.url); } catch { continue; }
      if(link.protocol!=='https:' || link.username || link.password || typeof item.title!=='string' || !item.title.trim()) continue;
      link.hash='';
      const date=/^\d{8}T\d{6}Z$/.test(item.seendate) ? item.seendate.replace(/^(\d{4})(\d{2})(\d{2}).*/,'$1-$2-$3') : null;
      results.set(link.href,{title:item.title.trim().slice(0,500),url:link.href,host:link.hostname,date,official:official(link.hostname)});
    }
    return res.status(200).json({sources:[...results.values()].sort((a,b)=>Number(b.official)-Number(a.official)),searchedAt:new Date().toISOString()});
  } catch {
    return res.status(503).json({error:'El índice de noticias no respondió. Puedes consultar los registros oficiales y volver a intentar.'});
  }
};
