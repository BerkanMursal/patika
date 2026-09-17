import { createRequire } from 'node:module';
const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const { createClient } = require('@supabase/supabase-js');
const id = process.argv[2];
if (!/^[0-9a-f-]{36}$/i.test(id ?? ''))
  throw new Error('Provide the verified Auth user UUID as the first argument.');
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
  throw new Error('Private Supabase admin environment required.');
const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const user = await client.auth.admin.getUserById(id);
if (user.error) throw user.error;
const result = await client.auth.admin.updateUserById(id, {
  app_metadata: { ...user.data.user.app_metadata, role: 'moderator' },
});
if (result.error) throw result.error;
console.log('Moderator role assigned. Sign out and back in to refresh the session.');
