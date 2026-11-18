const {createHash}=require('node:crypto');
const portals=new Set(['www.asf.gob.mx','datos.asf.gob.mx','www.gob.mx','www.dof.gob.mx','www.slp.gob.mx','slp.gob.mx','www.justice.gov','www.oecd.org','www.worldbank.org','www.eca.europa.eu']);
const limit=1_000_000;

module.exports=async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET') return res.status(405).json({error:'Método no permitido.'});
  let url;
  try { url=new URL(req.query.url); } catch { return res.status(400).json({error:'Escribe un enlace oficial HTTPS.'}); }
  if(url.protocol!=='https:' || url.port || url.username || url.password || !portals.has(url.hostname))
    return res.status(400).json({error:'La captura admite enlaces directos de los portales oficiales habilitados.'});
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
    return res.status(200).json({url:url.href,capturedAt:new Date().toISOString(),type,size,sha256:createHash('sha256').update(bytes).digest('hex'),encoding:'base64',html:bytes.toString('base64')});
  } catch {
    return res.status(502).json({error:'El portal no entregó una captura directa. Verifica la dirección y vuelve a intentarlo.'});
  }
};
