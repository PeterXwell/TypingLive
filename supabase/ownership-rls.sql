-- ============================================================================
-- TypingLive：用「浏览器本地随机密钥 + RLS」实现服务端归属校验
-- ============================================================================
--
-- 背景：这个站点没有登录系统，之前「谁能删评论 / 谁能改帖子」完全由前端
-- localStorage 里的昵称决定，服务端没有任何校验 —— 任何人都能用 anon key
-- 直接调 API 删掉别人的评论和帖子。
--
-- 做法：不引入登录，沿用「身份存在浏览器里」的思路，但把身份从「用户自己填
-- 的昵称」升级为「浏览器首次访问时生成的 122 位随机字符串」。它随每个请求以
-- x-device-id 请求头发出，RLS 策略再用 PostgREST 暴露的 request.headers 校验。
--
-- 表里存的是 sha256(设备标识 + ':' + 行id) 而不是设备标识本身 —— 它是哈希、
-- 不是凭证，所以即使 select('*') 或 Realtime 推送把它广播出去也无所谓；
-- 而客户端能算同样的哈希，因此仍然能准确知道自己能删哪几条。
--
-- 运行方式：Supabase 控制台 → SQL Editor → 整段粘贴执行。
-- 可以在正式项目上直接跑；本脚本不删除任何数据，只加列 / 加函数 / 加策略。
--
-- 执行顺序两种都安全（前端查询用 select('*')，多一列少一列都能跑）：
--   推荐：先部署前端（它会给每个请求带上 x-device-id），再跑这个脚本。
--         这样从脚本生效那一刻起，新产生的评论/帖子就已经带上归属了。
--   反过来先跑脚本也不坏，只是在新前端上线前产生的数据归属为空，会落进
--   下面的「过渡条款」，仍然是谁都能改、能删（和现状一样）。
--   本脚本幂等，可以重复执行。
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 第 0 步：先看看现状（可选，但建议跑一下心里有数）
-- ---------------------------------------------------------------------------
-- RLS 是否开启，以及现有的策略有哪些。跑完这一段再跑下面的正式脚本。

-- select relname, relrowsecurity as rls_enabled
--   from pg_class
--  where relnamespace = 'public'::regnamespace
--    and relname in ('posts', 'comments');

-- select tablename, policyname, cmd, roles, qual, with_check
--   from pg_policies
--  where schemaname = 'public' and tablename in ('posts', 'comments');


-- ---------------------------------------------------------------------------
-- 第 1 步：pgcrypto（Supabase 默认已装，装在 extensions schema 里）
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto with schema extensions;


-- ---------------------------------------------------------------------------
-- 第 2 步：归属哈希函数
--   从 PostgREST 注入的 request.headers 里取 x-device-id，算出本行的归属哈希。
--   格式必须和前端 app/lib/ownership.ts 完全一致：sha256(设备标识 + ':' + 行id)
-- ---------------------------------------------------------------------------
create or replace function public.tl_owner_hash(p_id uuid)
returns text
language plpgsql
stable
security definer           -- 以函数属主身份运行，anon 不需要 extensions schema 的权限
set search_path = public, extensions
as $$
declare
  v_headers text;
  v_device  text;
begin
  if p_id is null then
    return null;
  end if;

  v_headers := current_setting('request.headers', true);
  if v_headers is null or btrim(v_headers) = '' then
    return null;   -- 不在 PostgREST 请求里（例如 SQL Editor），无法判断归属
  end if;

  begin
    v_device := nullif(btrim(coalesce((v_headers::json) ->> 'x-device-id', '')), '');
  exception when others then
    return null;   -- 请求头不是合法 JSON，按「无法判断」处理，绝不报错拖垮查询
  end;

  if v_device is null then
    return null;
  end if;

  return encode(digest(v_device || ':' || p_id::text, 'sha256'), 'hex');
end;
$$;

comment on function public.tl_owner_hash(uuid) is
  '由请求头 x-device-id 推导出的行归属哈希；无请求头时返回 NULL。';


-- ---------------------------------------------------------------------------
-- 第 3 步：加列
-- ---------------------------------------------------------------------------
alter table public.comments add column if not exists author_hash text;
alter table public.posts    add column if not exists device_hash text;

create index if not exists comments_author_hash_idx on public.comments (author_hash);
create index if not exists posts_device_hash_idx    on public.posts    (device_hash);


-- ---------------------------------------------------------------------------
-- 第 4 步：插入时自动盖章（客户端无法伪造归属）
--   列默认值在 BEFORE INSERT 触发器之前就已生成，所以此时 new.id 一定有值。
--   这里总是覆盖 new.*_hash：即使客户端自己传了值也会被丢弃。
-- ---------------------------------------------------------------------------
create or replace function public.tl_stamp_comment_owner()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  new.author_hash := public.tl_owner_hash(new.id);
  return new;
end;
$$;

create or replace function public.tl_stamp_post_owner()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  new.device_hash := public.tl_owner_hash(new.id);
  return new;
end;
$$;

-- 保护归属不被清空。
-- 为什么用触发器而不是策略的 WITH CHECK：WITH CHECK 只能看到新行、看不到旧行，
-- 没法表达「原来有归属就不许变回空」。USING 已经限制住「能改哪一行」（只有归属
-- 为空、或归属等于你自己的行能被 UPDATE），这里只补最后一道：防止经 API 把已有
-- 归属抹掉、从而把内容重新解锁给所有人。
create or replace function public.tl_guard_post_owner()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_owner    name;
  v_is_admin boolean;
begin
  -- 表属主 / 超级用户（即 Supabase SQL Editor）不受限制，
  -- 否则事后想重置归属、重新认领就没法做了。
  select pg_get_userbyid(c.relowner) into v_owner from pg_class c where c.oid = tg_relid;
  select r.rolsuper into v_is_admin from pg_roles r where r.rolname = current_user;
  if current_user = v_owner or coalesce(v_is_admin, false) then
    return new;
  end if;

  if old.device_hash is not null and new.device_hash is null then
    raise exception '不允许清空帖子的归属（device_hash）';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_comments_stamp_owner on public.comments;
create trigger trg_comments_stamp_owner
  before insert on public.comments
  for each row execute function public.tl_stamp_comment_owner();

drop trigger if exists trg_posts_stamp_owner on public.posts;
create trigger trg_posts_stamp_owner
  before insert on public.posts
  for each row execute function public.tl_stamp_post_owner();

drop trigger if exists trg_posts_guard_owner on public.posts;
create trigger trg_posts_guard_owner
  before update on public.posts
  for each row execute function public.tl_guard_post_owner();

-- anon / authenticated 需要有权调用这几个函数（Supabase 默认可能已收回 PUBLIC 的
-- EXECUTE，所以显式给一遍；触发器函数也一样）
grant execute on function public.tl_owner_hash(uuid) to anon, authenticated;
grant execute on function public.tl_stamp_comment_owner() to anon, authenticated;
grant execute on function public.tl_stamp_post_owner() to anon, authenticated;
grant execute on function public.tl_guard_post_owner() to anon, authenticated;


-- ---------------------------------------------------------------------------
-- 第 5 步：重建策略
--   先动态清掉这两张表上现有的全部策略，避免旧的宽松策略和新策略按 OR 叠在
--   一起（Postgres 的 permissive 策略是「任一通过即通过」，不清掉等于白写）。
-- ---------------------------------------------------------------------------
do $$
declare
  p record;
begin
  for p in
    select tablename, policyname
      from pg_policies
     where schemaname = 'public'
       and tablename in ('posts', 'comments')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

alter table public.comments enable row level security;
alter table public.posts    enable row level security;

-- 评论：所有人可读、可发；只有作者本人能删
create policy comments_select_public on public.comments
  for select to anon, authenticated using (true);

create policy comments_insert_public on public.comments
  for insert to anon, authenticated with check (true);

create policy comments_delete_own on public.comments
  for delete to anon, authenticated
  using (
    -- 过渡条款：迁移之前产生的历史评论 author_hash 为空，保持和现在一样的
    -- 可删状态，方便你清理。想彻底锁死历史评论，见文件末尾的「可选收尾」。
    author_hash is null
    or author_hash = public.tl_owner_hash(id)
  );

-- 帖子：所有人可读、可发；只有作者本人能改和删
create policy posts_select_public on public.posts
  for select to anon, authenticated using (true);

create policy posts_insert_public on public.posts
  for insert to anon, authenticated with check (true);

create policy posts_update_own on public.posts
  for update to anon, authenticated
  using (
    -- 同上：历史帖子（device_hash 为空）暂时保持可写，否则你现有的 21 篇
    -- 会立刻变成只读。跑完「可选收尾」把它们认领之后可以删掉这个分支。
    device_hash is null
    or device_hash = public.tl_owner_hash(id)
  )
  with check (
    -- 只要「改完之后这一行仍然归你」即可：
    --   * device_hash 仍为空 → 历史数据的内容更新。不能要求它非空，否则你现有的
    --     21 篇会立刻变成只读 —— 这个坑是拿真实 Postgres 跑出来的。
    --   * 否则必须等于你自己的哈希（含「把无归属的历史帖子认领给自己」）
    device_hash is null
    or device_hash = public.tl_owner_hash(id)
  );

create policy posts_delete_own on public.posts
  for delete to anon, authenticated
  using (
    device_hash is null
    or device_hash = public.tl_owner_hash(id)
  );


-- ---------------------------------------------------------------------------
-- 第 6 步：确认结果
-- ---------------------------------------------------------------------------
select tablename, policyname, cmd, roles::text, qual, with_check
  from pg_policies
 where schemaname = 'public' and tablename in ('posts', 'comments')
 order by tablename, cmd, policyname;


-- ============================================================================
-- 可选收尾：处理历史数据
-- ============================================================================
-- 跑完上面的脚本后：
--   * 新发的评论 / 新开的帖子：立刻受保护。
--   * 历史评论（author_hash 为空）：仍然任何人都能删。
--   * 历史帖子（device_hash 为空）：仍然任何人都能改、能删 —— 包括你自己那 21 篇。
--
-- 建议先部署前端，然后在「个人档案」页复制你的「本机标识」，再执行下面两段，
-- 把历史数据认领到你自己这台设备上。注意：SQL Editor 里没有 x-device-id
-- 请求头，所以必须把设备标识硬编码进去。

-- ① 认领历史帖子（把 PASTE_YOUR_DEVICE_ID 换成你的本机标识）
-- update public.posts
--    set device_hash = encode(extensions.digest('PASTE_YOUR_DEVICE_ID' || ':' || id::text, 'sha256'), 'hex')
--  where device_hash is null;

-- ② 认领历史评论（同上；如果历史评论不是你发的，就别认领，改用下面的 ③）
-- update public.comments
--    set author_hash = encode(extensions.digest('PASTE_YOUR_DEVICE_ID' || ':' || id::text, 'sha256'), 'hex')
--  where author_hash is null;

-- ③ 或者干脆把历史数据锁死：给它们盖一个谁也猜不到的随机哈希，
--    结果是「谁都删不了、改不了」，包括你自己。
-- update public.posts    set device_hash = encode(extensions.digest(gen_random_uuid()::text, 'sha256'), 'hex') where device_hash is null;
-- update public.comments set author_hash  = encode(extensions.digest(gen_random_uuid()::text, 'sha256'), 'hex') where author_hash is null;

-- ④ 历史数据都处理完之后，把第 5 步里两个策略中的过渡条款删掉，变成完全严格：
--    comments_delete_own:      去掉 "author_hash is null or"
--    posts_delete_own:         去掉 "device_hash is null or"
--    posts_update_own (using): 去掉 "device_hash is null or"
--    改完记得再跑一次这一步的 create policy。
