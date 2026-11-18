const modes = new Set(['servidor','estado','noticias']);
const official = host => /(?:^|\.)(?:gob\.mx|asf\.gob\.mx|justice\.gov|worldbank\.org|europa\.eu)$/.test(host);
const scrub = value => String(value || '').normalize('NFC').replace(/[^\p{L}\p{N} .'-]/gu,' ').replace(/\s+/g,' ').trim();

const unescapeXml = value => value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&(amp|lt|gt|quot|apos|#39);/g,(_,key)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",'#39':"'"})[key]);
async function rssFallback(subject,mode) {
  const url=new URL('https://news.google.com/rss/search');
  url.search=new URLSearchParams({q:(subject?subject+' ':'')+(mode==='servidor'?'(funcionario OR nombramiento OR auditoría)':'(corrupción OR auditoría OR desvío)')+' when:90d',hl:'es-419',gl:'MX',ceid:'MX:es-419'});
  const response=await fetch(url,{signal:AbortSignal.timeout(5500)});
  if(!response.ok) throw new Error('RSS unavailable');
  const xml=await response.text();
  if(!/<rss[\s>]/i.test(xml)) throw new Error('Invalid RSS');
  const results=[];
  for(const [,entry] of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)){
    const read=tag=>unescapeXml(entry.match(new RegExp('<'+tag+'(?: [^>]*)?>([\\s\\S]*?)<\/'+tag+'>','i'))?.[1]||'').trim();
    const title=read('title'),url=read('link'),publisher=read('source'),date=new Date(read('pubDate'));
    if(!title || !url.startsWith('https://news.google.com/rss/articles/')) continue;
    results.push({title:title.slice(0,500),url,host:publisher||'Google News',date:Number.isNaN(date.valueOf())?null:date.toISOString().slice(0,10),official:false});
    if(results.length===25) break;
  }
  return results;
}

module.exports = async (req,res) => {
  res.setHeader('Cache-Control','no-store');
  if (req.method !== 'GET') return res.status(405).json({error:'Método inválido.'});
  const {modo,tema,pais,region,ciudad}=req.query;
  const topic=scrub(tema);
  if (!modes.has(modo) || topic.length>90 || (modo!=='noticias' && topic.length<3)) {
    return res.status(400).json({error:'Indica un lugar, tema o nombre público válido.'});
  }
  // Search a fixed news index. The request never retrieves user-supplied URLs.
  const places=[pais,region,ciudad].map(scrub).filter(Boolean);
  if(places.some(value=>value.length>80)) return res.status(400).json({error:'Usa nombres de lugares de hasta 80 caracteres.'});
  const subject=[...places,topic].filter(Boolean).map(value=>'"'+value+'"').join(' ');
  const terms=modo==='servidor'?'(funcionario OR nombramiento OR auditoría OR official)':'(corrupción OR desvío OR auditoría OR corruption OR bribery)';
  const url=new URL('https://api.gdeltproject.org/api/v2/doc/doc');
  for(const [key,value] of Object.entries({query:[subject,terms].filter(Boolean).join(' '),mode:'ArtList',format:'json',sort:'DateDesc',maxrecords:'25',timespan:'3months'})) url.searchParams.set(key,value);
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
    return res.status(200).json({sources:[...results.values()].sort((a,b)=>Number(b.official)-Number(a.official)),searchedAt:new Date().toISOString(),provider:'GDELT'});
  } catch {
    try {
      const sources=await rssFallback(subject,modo);
      return res.status(200).json({sources,searchedAt:new Date().toISOString(),provider:'Google News'});
    } catch {
      return res.status(503).json({error:'Los índices de noticias no respondieron. Puedes consultar los registros oficiales y volver a intentar.'});
    }
  }
};
