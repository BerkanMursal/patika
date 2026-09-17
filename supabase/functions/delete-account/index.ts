import { createClient } from '@supabase/supabase-js';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  if (req.method !== 'POST') return respond({ error: 'Method not allowed' }, 405);
  const authorization = req.headers.get('authorization') ?? '';
  const token = authorization.replace(/^Bearer\s+/i, '');
  if (!token) return respond({ error: 'Oturum gerekli.' }, 401);
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const {
    data: { user },
    error,
  } = await admin.auth.getUser(token);
  if (error || !user) return respond({ error: 'Geçersiz oturum.' }, 401);
  try {
    const body = await req.json();
    if (body.confirm !== 'DELETE') return respond({ error: 'Silme onayı gerekli.' }, 400);
    // Flat, owner-prefixed keys. Delete every page; removing page 1 advances the next batch.
    for (;;) {
      const { data, error } = await admin.storage
        .from('feeding-photos')
        .list(user.id, { limit: 100 });
      if (error) throw error;
      if (!data?.length) break;
      const removal = await admin.storage
        .from('feeding-photos')
        .remove(data.map((f) => `${user.id}/${f.name}`));
      if (removal.error) throw removal.error;
    }
    const deletion = await admin.auth.admin.deleteUser(user.id);
    if (deletion.error) throw deletion.error;
    return respond({ deleted: true });
  } catch {
    return respond({ error: 'Hesap silinemedi. Daha sonra yeniden deneyin.' }, 500);
  }
});
