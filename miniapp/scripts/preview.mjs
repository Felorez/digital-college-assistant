import http from 'node:http';
import worker from '../worker/index.js';
http.createServer(async(req,res)=>{try{
 const bytes=[];for await(const chunk of req)bytes.push(chunk);
 const body=Buffer.concat(bytes);const request=new Request('http://localhost:4173'+req.url,{method:req.method,headers:req.headers,body:body.length?body:undefined});
 const r=await worker.fetch(request,{});res.writeHead(r.status,Object.fromEntries(r.headers));res.end(Buffer.from(await r.arrayBuffer()));
}catch(e){res.writeHead(500);res.end(e.message)}}).listen(4173,'127.0.0.1',()=>console.log('Local: http://localhost:4173'));
