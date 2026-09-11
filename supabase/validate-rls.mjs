// supabase/validate-rls.mjs
//
// 把 supabase/ownership-rls.sql 拿到一个真实的 Postgres 上跑一遍，逐条验证权限规则。
// PGlite 是编译成 WASM 的 Postgres，所以 RLS / 策略 / 触发器 / plpgsql 都是真的，
// 只是没有 pgcrypto —— 脚本用 Postgres 内置的 sha256() 顶替 digest()，
// 输出和 pgcrypto 的 digest(x,'sha256') 完全一致，因此格式一致性也是真验证过的。
//
// 运行：
//   npm i -D @electric-sql/pglite
//   node supabase/validate-rls.mjs
//
// 改动策略（ownership-rls.sql）之后请跑一遍，避免又把「历史帖子变只读」
// 这类问题带上线 —— 下面好几个用例就是当时真的踩出来的。

// Validates supabase/ownership-rls.sql against a REAL Postgres (PGlite = PG compiled to WASM).
// Simulates PostgREST by setting the `request.headers` GUC and switching to the `anon` role.
import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_FILE = join(HERE, 'ownership-rls.sql');
const ALICE = 'alice-device-0001';
const BOB = 'bob-device-0002';
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

const db = new PGlite();
let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label} ${detail}`); }
};

// RLS 的 USING 不匹配 → 静默 0 行；WITH CHECK 不匹配 → 直接报错。
// 两种情况都算「被拒绝」，所以统一包一层。
async function attempt(fn) {
  try { return { rows: (await fn()).rows.length, error: null }; }
  catch (e) { return { rows: 0, error: e.message }; }
}

async function as(role, device, fn) {
  await db.exec(`set role ${role}`);
  if (device === null) await db.exec(`reset request.headers`);
  else await db.exec(`set request.headers = '{"x-device-id":"${device}"}'`);
  try { return await fn(); }
  finally { await db.exec('reset role'); await db.exec('reset request.headers'); }
}

// PGlite has no pgcrypto, but core Postgres has sha256(bytea) since PG11.
// This shim is byte-for-byte identical to pgcrypto's digest(x,'sha256'),
// so the migration file itself runs unmodified.
const hasPgcrypto = await (async () => {
  try { await db.exec('create extension if not exists pgcrypto with schema extensions;'); return true; }
  catch { return false; }
})();
if (!hasPgcrypto) {
  await db.exec(`
    create schema if not exists extensions;
    create or replace function extensions.digest(data text, algo text)
    returns bytea language sql immutable as $fn$
      select case lower(algo)
        when 'sha256' then sha256(convert_to(data, 'UTF8'))
        else decode(md5(data), 'hex')
      end
    $fn$;
  `);
}
console.log(`pgcrypto available: ${hasPgcrypto} (sha256 shim used: ${!hasPgcrypto})\n`);

// --- realistic pre-migration schema, owned by a superuser (like Supabase's `postgres`)
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;

  create table public.posts (
    id uuid primary key default gen_random_uuid(),
    description text,
    author_name text,
    content text,
    status int default 0,
    is_typing boolean default false,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
  );
  create table public.comments (
    id uuid primary key default gen_random_uuid(),
    post_id uuid references public.posts(id) on delete cascade,
    author_name text,
    content text,
    created_at timestamptz default now()
  );

  grant usage on schema public to anon, authenticated;
  grant select, insert, update, delete on public.posts, public.comments to anon, authenticated;

  -- legacy rows created before the migration
  insert into public.posts (id, description, author_name) values
    ('11111111-1111-4111-8111-111111111111', '旧帖子', '离开吗');
  insert into public.comments (id, post_id, author_name, content) values
    ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', '如果', '历史评论');
`);

// --- run the real migration file
console.log('=== running supabase/ownership-rls.sql ===');
let migration = readFileSync(SQL_FILE, 'utf8');
if (!hasPgcrypto) {
  // Supabase 自带 pgcrypto；PGlite 没有，这里跳过装扩展那一行（digest 已由上面的 shim 提供）
  migration = migration.replace(/create extension if not exists pgcrypto[^\n]*\n/i, '');
}
try {
  await db.exec(migration);
  console.log('migration executed OK\n');
} catch (e) {
  console.log('❌ MIGRATION FAILED:', e.message, '\n');
  process.exit(1);
}

console.log('=== hash format: SQL vs client ===');
const post = await as('anon', ALICE, async () =>
  (await db.query(`insert into public.posts (description, author_name, content) values ('A 的帖子','A','') returning id, device_hash`)).rows[0]
);
check('新帖子 device_hash 被触发器写入', !!post.device_hash, JSON.stringify(post));
check('device_hash == sha256(device + ":" + id)（与前端 ownerHash 一致）',
  post.device_hash === sha(`${ALICE}:${post.id}`), `\n     got ${post.device_hash}\n     want ${sha(`${ALICE}:${post.id}`)}`);

const aliceComment = await as('anon', ALICE, async () =>
  (await db.query(`insert into public.comments (post_id, author_name, content) values ('${post.id}','A','A 的评论') returning id, author_hash`)).rows[0]
);
check('新评论 author_hash 被触发器写入', !!aliceComment.author_hash);
check('author_hash == sha256(device + ":" + id)',
  aliceComment.author_hash === sha(`${ALICE}:${aliceComment.id}`));

console.log('\n=== 评论删除权限 ===');
const bobComment = await as('anon', BOB, async () =>
  (await db.query(`insert into public.comments (post_id, author_name, content) values ('${post.id}','B','B 的评论') returning id, author_hash`)).rows[0]
);

let n = (await attempt(() => as('anon', BOB, () => db.query(`delete from public.comments where id='${aliceComment.id}' returning id`)))).rows;
check('B 删 A 的评论 → 被拒（0 行）', n === 0, `deleted ${n}`);

n = (await attempt(() => as('anon', ALICE, () => db.query(`delete from public.comments where id='${bobComment.id}' returning id`)))).rows;
check('A 删 B 的评论 → 被拒（0 行）', n === 0, `deleted ${n}`);

n = (await attempt(() => as('anon', ALICE, () => db.query(`delete from public.comments where id='${aliceComment.id}' returning id`)))).rows;
check('A 删自己的评论 → 成功', n === 1, `deleted ${n}`);

n = (await attempt(() => as('anon', null, () => db.query(`delete from public.comments where id='${bobComment.id}' returning id`)))).rows;
check('不带 x-device-id 头删评论 → 被拒', n === 0, `deleted ${n}`);

n = (await attempt(() => as('anon', 'attacker-claiming-empty', () => db.query(`delete from public.comments where id='${bobComment.id}' returning id`)))).rows;
check('换个设备标识删别人的评论 → 被拒', n === 0, `deleted ${n}`);

console.log('\n=== 帖子删除 / 修改权限 ===');
n = (await attempt(() => as('anon', BOB, () => db.query(`delete from public.posts where id='${post.id}' returning id`)))).rows;
check('B 删 A 的帖子 → 被拒', n === 0, `deleted ${n}`);

n = (await attempt(() => as('anon', BOB, () => db.query(`update public.posts set content='被篡改' where id='${post.id}' returning id`)))).rows;
check('B 改 A 的帖子内容 → 被拒', n === 0, `updated ${n}`);

n = (await attempt(() => as('anon', ALICE, () => db.query(`update public.posts set content='继续写' where id='${post.id}' returning id`)))).rows;
check('A 改自己的帖子 → 成功', n === 1, `updated ${n}`);

n = (await attempt(() => as('anon', ALICE, () => db.query(`update public.posts set device_hash=null where id='${post.id}' returning id`)))).rows;
check('A 把 device_hash 清空（解锁给所有人）→ 被拒', n === 0, `updated ${n}`);

n = (await attempt(() => as('anon', BOB, () => db.query(`update public.posts set device_hash='${sha('bob:x')}' where id='${post.id}' returning id`)))).rows;
check('B 抢占 A 的帖子归属 → 被拒', n === 0, `updated ${n}`);

n = (await attempt(() => as('anon', ALICE, () => db.query(`delete from public.posts where id='${post.id}' returning id`)))).rows;
check('A 删自己的帖子 → 成功', n === 1, `deleted ${n}`);

console.log('\n=== 历史数据（迁移前，哈希为空）===');
const LEGACY_POST = '11111111-1111-4111-8111-111111111111';
const LEGACY_COMMENT = '22222222-2222-4222-8222-222222222222';

check('历史行哈希为空（未受影响）', (await db.query(`select device_hash from public.posts where id='${LEGACY_POST}'`)).rows[0].device_hash === null);

n = (await attempt(() => as('anon', BOB, () => db.query(`delete from public.comments where id='${LEGACY_COMMENT}' returning id`)))).rows;
check('历史评论在过渡期内仍可删（和迁移前一致）', n === 1, `deleted ${n}`);

n = (await attempt(() => as('anon', BOB, () => db.query(`update public.posts set content='B 抢走了' where id='${LEGACY_POST}' returning id`)))).rows;
check('历史帖子在过渡期内仍可写（否则你现有 21 篇会变只读）', n === 1, `updated ${n}`);

// 认领：通过 API 把无归属的历史帖子划到自己名下
n = (await attempt(() => as('anon', BOB, () => db.query(`update public.posts set device_hash='${sha(`${BOB}:${LEGACY_POST}`)}' where id='${LEGACY_POST}' returning id`)))).rows;
check('可以把无归属的历史帖子认领到自己名下（API 路径）', n === 1, `updated ${n}`);

n = (await attempt(() => as('anon', ALICE, () => db.query(`update public.posts set content='A 想改' where id='${LEGACY_POST}' returning id`)))).rows;
check('认领之后别人就改不动了', n === 0, `updated ${n}`);

// SQL Editor 里跑的是表属主，RLS 直接绕过（Supabase 就是这样），所以认领/锁定 SQL 一定能执行
const owned = await db.query(`update public.posts set device_hash = encode(extensions.digest('OWNER|' || id::text,'sha256'),'hex') where id='${LEGACY_POST}' returning id`);
check('SQL Editor（表属主）可无视 RLS 改写归属', owned.rows.length === 1, JSON.stringify(owned.rows));

console.log('\n=== 锁死历史数据（可选收尾 ③）===');
// 造两条真正的「迁移前」评论：不带 x-device-id 头 → author_hash 为空
const legacyA = await as('anon', null, async () =>
  (await db.query(`insert into public.comments (post_id, author_name, content) values ('${LEGACY_POST}','老','old A') returning id, author_hash`)).rows[0]
);
const legacyB = await as('anon', null, async () =>
  (await db.query(`insert into public.comments (post_id, author_name, content) values ('${LEGACY_POST}','老','old B') returning id, author_hash`)).rows[0]
);
check('无请求头插入的评论归属为空（等同迁移前数据）', legacyA.author_hash === null && legacyB.author_hash === null,
  `${legacyA.author_hash} / ${legacyB.author_hash}`);

n = (await attempt(() => as('anon', ALICE, () => db.query(`delete from public.comments where id='${legacyA.id}' returning id`)))).rows;
check('过渡期内历史评论仍可删（和迁移前一致）', n === 1, `deleted ${n}`);

// 执行「锁死」收尾 ③
await db.exec(`update public.comments set author_hash = encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex') where author_hash is null;`);
n = (await attempt(() => as('anon', ALICE, () => db.query(`delete from public.comments where id='${legacyB.id}' returning id`)))).rows;
check('锁死后谁都删不掉（包括贴主自己）', n === 0, `deleted ${n}`);

console.log('\n=== 公开可读可发（没被 RLS 误伤）===');
n = (await attempt(() => as('anon', ALICE, () => db.query(`insert into public.comments (post_id, author_name, content) values ('${LEGACY_POST}','A','still writable') returning id`)))).rows;
check('匿名可以发评论', n === 1, `inserted ${n}`);
const readCount = await as('anon', null, async () => (await db.query('select id from public.comments')).rows.length);
check('匿名可以读评论', readCount >= 1, `rows ${readCount}`);

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail === 0 ? 0 : 1);
