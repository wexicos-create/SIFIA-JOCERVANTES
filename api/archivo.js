const {createHash}=require('node:crypto');
const portals=new Set(['www.asf.gob.mx','datos.asf.gob.mx','www.gob.mx','www.dof.gob.mx','www.slp.gob.mx','slp.gob.mx','www.justice.gov','www.oecd.org','www.worldbank.org','www.eca.europa.eu']);
const limit=1_000_000;

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function metadata(headers) {
  const retained=['content-type','content-language','last-modified','etag','cache-control'];
  return Object.fromEntries(retained.flatMap(name=>headers.has(name)?[[name,headers.get(name)]]:[]));
}
function cookieMetadata(headers) {
  return (headers.getSetCookie?.()||[]).slice(0,30).map(header=>{
    const [, ...parts]=header.split(';');
    const attributes=new Map(parts.map(part=>{
      const [key,...value]=part.trim().split('=');
      return [key.toLowerCase(),value.join('=')];
    }));
    const same=attributes.get('samesite')?.toLowerCase();
    const age=attributes.get('max-age');
    return {secure:attributes.has('secure'),httpOnly:attributes.has('httponly'),partitioned:attributes.has('partitioned'),sameSite:['strict','lax','none'].includes(same)?same:null,maxAge:/^-?\d{1,12}$/.test(age)?Number(age):null};
  });
}
async function visualCapture(html) {
  const chromium=require('@sparticuz/chromium');
  const puppeteer=require('puppeteer-core');
  const sanitize=require('sanitize-html');
  const body=sanitize(html,{allowedTags:['main','article','section','header','footer','nav','div','span','h1','h2','h3','h4','h5','p','br','hr','ol','ul','li','blockquote','strong','b','em','i','table','thead','tbody','tr','th','td','caption','dl','dt','dd','pre','code','a'],allowedAttributes:{},nonTextTags:['style','script','textarea','option','template','noscript','head','svg','iframe']});
  const browser=await puppeteer.launch({args:chromium.args,executablePath:await chromium.executablePath(),headless:true,timeout:10000,defaultViewport:{width:1280,height:860}});
  try {
    const page=await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on('request',request=>{void request.abort().catch(()=>{});});
    await page.setContent('<!doctype html><meta charset=utf-8><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>body{margin:36px;color:#163a33;background:#fff;font:18px/1.5 sans-serif}main{max-width:1120px}header,nav{background:#eff6f3;padding:10px}table{border-collapse:collapse}td,th{border:1px solid #a9bdb7;padding:5px}p{margin:8px 0}</style><main>'+body+'</main>',{waitUntil:'domcontentloaded',timeout:5000});
    const bytes=Buffer.from(await page.screenshot({type:'jpeg',quality:65}));
    if(bytes.length>750000) throw Error('Image exceeds response limit');
    return {type:'image/jpeg',kind:'render-html-aislado',width:1280,height:860,sha256:digest(bytes),data:bytes.toString('base64')};
  } finally {await browser.close();}
}
async function crosscheck(sha256,sourceUrl){
  const verifier=new URL('https://intautor.vercel.app/api/verify');
  verifier.searchParams.set('sha256',sha256);
  try {
    const response=await fetch(verifier,{redirect:'error',signal:AbortSignal.timeout(3500)});
    if(!response.ok) throw Error('Verification unavailable');
    const evidence=await response.json();
    const record=evidence.record;
    if(evidence.status==='found'&&record?.sha256===sha256&&record?.url===sourceUrl){
      return {status:'match',link:verifier.href,id:record.id,observedAt:record.observed_utc};
    }
    return {status:evidence.status==='found'?'different-url':'no-match-in-sample',link:verifier.href};
  } catch { return {status:'unavailable',link:verifier.href}; }
}

module.exports=async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET') return res.status(405).json({error:'Método no permitido.'});
  let url;
  try { url=new URL(req.query.url); } catch { return res.status(400).json({error:'Escribe un enlace oficial HTTPS.'}); }
  if(url.protocol!=='https:' || url.port || url.search || url.username || url.password || !portals.has(url.hostname))
    return res.status(400).json({error:'Usa una dirección directa de un portal oficial habilitado, sin parámetros ni credenciales.'});
  url.hash='';
  try {
    const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(7000),headers:{Accept:'text/html'}});
    const type=response.headers.get('content-type')||'';
    if(!response.ok || !/^text\/html\b/i.test(type) || !response.body)
      return res.status(422).json({error:'La página debe entregar HTML directamente. Abre el enlace original si redirige o entrega un PDF.'});
    const reader=response.body.getReader();
    const parts=[];
    let size=0;
    while(true){
      const {value,done}=await reader.read();
      if(done) break;
      size+=value.byteLength;
      if(size>limit){void reader.cancel();return res.status(413).json({error:'La página supera el límite de captura de 1 MB.'});}
      parts.push(Buffer.from(value));
    }
    const bytes=Buffer.concat(parts);
    const capturedAt=new Date().toISOString(),sha256=digest(bytes);
    const headers=metadata(response.headers),cookies=cookieMetadata(response.headers);
    const [visual,intautor]=await Promise.all([
      visualCapture(bytes.toString('utf8')).catch(()=>null),crosscheck(sha256,url.href)
    ]);
    const manifest={schema:2,url:url.href,capturedAt,httpStatus:response.status,type,size,sha256,headers,cookies,visualSha256:visual?.sha256??null,intautor};
    return res.status(200).json({...manifest,manifestSha256:digest(JSON.stringify(manifest)),encoding:'base64',html:bytes.toString('base64'),visual});
  } catch {
    return res.status(502).json({error:'El portal no entregó una captura directa. Verifica la dirección y vuelve a intentarlo.'});
  }
};
