import { createClient } from '@supabase/supabase-js';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const BUCKET = 'feeding-photos';
const PAGE = 100;
// Bounds the drain loop against a concurrent upload landing mid-cleanup (the
// account is still technically active until deleteUser succeeds). A
// legitimate deletion request has no reason to keep uploading during its own
// cleanup, so a handful of passes is enough to drain any in-flight uploads
// without ever looping forever.
const MAX_DRAIN_PASSES = 5;

type Storage = ReturnType<ReturnType<typeof createClient>['storage']['from']>;

// Recursive + paginated: Storage's list() marks real objects with a non-null
// id and virtual subfolders (computed from key prefixes, not real objects)
// with id===null. Earlier code trusted list(uid) to be flat and tried to
// remove() the "rescue-cases" folder marker as if it were a file — remove()
// silently no-ops on a non-existent key instead of erroring, so those nested
// files were never found, never deleted, and (because the marker never
// shrinks) the old loop never terminated. This walks every level with
// limit/offset pagination and only ever collects real (id !== null) file
// paths, so any future subfolder under {uid}/ is covered without this
// function needing to know its name.
async function listAllFiles(storage: Storage, prefix: string): Promise<string[]> {
  const files: string[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await storage.list(prefix, { limit: PAGE, offset });
    if (error) throw error;
    if (!data?.length) break;
    for (const entry of data) {
      if (entry.id === null) files.push(...(await listAllFiles(storage, `${prefix}/${entry.name}`)));
      else files.push(`${prefix}/${entry.name}`);
    }
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return files;
}
async function removeAll(storage: Storage, paths: string[]) {
  for (let i = 0; i < paths.length; i += PAGE) {
    const { error } = await storage.remove(paths.slice(i, i + PAGE));
    if (error) throw error;
  }
}

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
    const storage = admin.storage.from(BUCKET);
    // Drain loop: list, delete what's found, list again — repeat until the
    // prefix is truly empty or we give up after MAX_DRAIN_PASSES. The
    // re-list after each delete is the actual proof the batch worked; a
    // remove() call that returns no error is never treated as proof by
    // itself (that assumption is exactly what let rescue-case photos survive
    // silently before).
    let remaining = await listAllFiles(storage, user.id);
    for (let pass = 0; remaining.length && pass < MAX_DRAIN_PASSES; pass++) {
      await removeAll(storage, remaining);
      remaining = await listAllFiles(storage, user.id);
    }
    if (remaining.length)
      throw new Error(`Depolamada ${remaining.length} dosya temizlenemedi.`);
    // Only reached once storage is verified empty — deleteUser (and the DB
    // cascade it triggers) never runs while a real file still exists.
    const deletion = await admin.auth.admin.deleteUser(user.id);
    if (deletion.error) throw deletion.error;
    return respond({ deleted: true });
  } catch {
    return respond({ error: 'Hesap silinemedi. Daha sonra yeniden deneyin.' }, 500);
  }
});
