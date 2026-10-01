import { createClient } from '@supabase/supabase-js';
import { projectSupabase } from './supabase-config';
const url=import.meta.env.VITE_SUPABASE_URL || projectSupabase.url;
const key=import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY || projectSupabase.publishableKey;
export const supabase = url && key && !url.includes('YOUR_PROJECT') ? createClient(url,key) : null;
