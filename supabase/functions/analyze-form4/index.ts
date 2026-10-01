import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import { createAnalysisHandler } from '../_shared/handler.ts';

function publicKey(){
  const dictionary=Deno.env.get('SUPABASE_PUBLISHABLE_KEYS');
  if(dictionary){const keys=JSON.parse(dictionary);if(typeof keys.default==='string')return keys.default;}
  return Deno.env.get('SUPABASE_ANON_KEY')||'';
}
const handler=createAnalysisHandler({
  authenticate:async request=>{
    const authorization=request.headers.get('Authorization')||'';
    if(!/^Bearer\s+\S+$/i.test(authorization))return null;
    const token=authorization.replace(/^Bearer\s+/i,'');
    const client=createClient(Deno.env.get('SUPABASE_URL')||'',publicKey(),{global:{headers:{Authorization:authorization}},auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
    // Server validation, not a decoded JWT payload or user-supplied role metadata.
    const {data,error}=await client.auth.getUser(token);if(error||!data.user)return null;
    const {data:profile,error:profileError}=await client.from('profiles').select('role').eq('id',data.user.id).single();
    return {id:data.user.id,admin:!profileError&&profile?.role==='admin',rpc:(name,args)=>client.rpc(name,args)};
  },
  apiKey:()=>Deno.env.get('OPENAI_API_KEY')||'',
  model:()=>Deno.env.get('OPENAI_MODEL')||'gpt-4.1-mini',
  origins:()=> (Deno.env.get('APP_ALLOWED_ORIGINS')||'https://moraisdsantos.github.io,http://localhost:4173,http://127.0.0.1:4173').split(',').map(s=>s.trim()).filter(Boolean),
  fetch:globalThis.fetch,
});
Deno.serve(handler);
