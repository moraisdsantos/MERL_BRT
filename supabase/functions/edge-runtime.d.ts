// Type checking only; Deno supplies these APIs in Supabase Edge Functions.
declare namespace Deno {
  namespace env {function get(name:string):string|undefined;}
  function serve(handler:(request:Request)=>Response|Promise<Response>):unknown;
}
declare module 'npm:@supabase/supabase-js@2.117.2' {
  export const createClient:typeof import('@supabase/supabase-js').createClient;
}
