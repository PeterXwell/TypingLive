'use client';

import { useEffect, useState, useCallback } from 'react';
import { supabase } from './supabaseClient';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { checkSensitiveWord, preloadSensitiveWords } from '@/app/lib/sensitive';

const formatDate = (dateStr: string) => {
  if (!dateStr) return '未知';
  const d = new Date(dateStr);
  return `${d.getFullYear()} ${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function readLocalJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function readLocalName(): string {
  try {
    return localStorage.getItem('tl_user_name') || '无名氏';
  } catch {
    return '无名氏';
  }
}

export default function PlazaPage() {
  const router = useRouter();
  const [posts, setPosts] = useState<any[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [userName, setUserName] = useState('无名氏');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('posts')
        .select('*')
        .order('updated_at', { ascending: false });
      if (error) throw error;
      if (data) {
        setPosts(data);
        setLoadError(null);
      }
    } catch {
      setLoadError('记录加载失败，请检查网络后下拉刷新');
    }
  }, []);

  const fetchFavs = useCallback(async (name: string) => {
    if (!name || name === '无名氏') return;
    try {
      const { data } = await supabase.from('favorites').select('post_id').eq('user_name', name);
      if (data) setFavorites(data.map((f) => f.post_id));
    } catch {
      /* ignore fav errors */
    }
  }, []);

  useEffect(() => {
    const name = readLocalName();
    setUserName(name);
    fetchData();
    fetchFavs(name);
    // 后台预热词库，不阻塞首页渲染
    preloadSensitiveWords();

    const channel = supabase
      .channel('plaza-updates')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'posts' }, () => fetchData())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchData, fetchFavs]);

  const toggleFavorite = async (e: React.MouseEvent, postId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (userName === '无名氏') return alert('请先在个人主页设置名字');

    if (favorites.includes(postId)) {
      await supabase.from('favorites').delete().match({ user_name: userName, post_id: postId });
      setFavorites((prev) => prev.filter((id) => id !== postId));
    } else {
      await supabase.from('favorites').insert([{ user_name: userName, post_id: postId }]);
      setFavorites((prev) => [...prev, postId]);
    }
  };

  const openCreateModal = () => {
    setNewTitle('');
    setIsModalOpen(true);
    preloadSensitiveWords();
  };

  const handleCreate = async () => {
    const safeTitle = newTitle.trim();
    if (!safeTitle || isSubmitting) return;

    if (await checkSensitiveWord(safeTitle)) {
      alert('标题包含敏感内容，请修改后再重试');
      return;
    }

    setIsSubmitting(true);
    try {
      const { data, error } = await supabase
        .from('posts')
        .insert([
          {
            description: safeTitle,
            author_name: userName,
            content: '',
            status: 0,
            updated_at: new Date().toISOString(),
          },
        ])
        .select();

      if (error) throw error;
      if (data?.[0]) {
        try {
          const myIds = readLocalJson<string[]>('my_typing_live_posts', []);
          localStorage.setItem('my_typing_live_posts', JSON.stringify([...myIds, data[0].id]));
        } catch {
          /* private mode etc. */
        }
        setIsModalOpen(false);
        router.push(`/post/${data[0].id}`);
      }
    } catch {
      alert('创建失败，请检查网络');
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#313131] text-white font-mono pb-24">
      <nav className="sticky top-0 z-40 bg-[#795548] border-b-8 border-[#54a02a] px-4 py-3 shadow-[0_8px_0_0_#2a1d19]">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col items-start gap-1 min-w-0">
            <div className="flex items-baseline gap-2 flex-wrap">
              <h1 className="text-xl sm:text-2xl font-black text-[#F8D030] drop-shadow-[3px_3px_0_#000] uppercase tracking-tighter italic">
                TypingLive
              </h1>
              <span className="text-xl sm:text-2xl font-black text-white drop-shadow-[3px_3px_0_#000] uppercase tracking-tighter italic">
                重述
              </span>
            </div>
            <div className="bg-[#54a02a] border-2 border-black px-2 py-0.5">
              <p className="text-[10px] text-white font-bold tracking-widest uppercase">
                来开源社区，一起构建平民史观
              </p>
            </div>
          </div>
          <div className="flex gap-3 w-full sm:w-auto">
            <Link href="/profile" className="mc-btn bg-[#8e8e8e] flex-1 sm:flex-none text-center">
              个人档案
            </Link>
            <button
              type="button"
              onClick={openCreateModal}
              className="mc-btn bg-[#54a02a] flex-1 sm:flex-none"
            >
              开启新记录
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 mt-8 sm:mt-16 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 sm:gap-12">
        {loadError && (
          <div className="col-span-full text-center text-[#F8D030] text-sm font-bold py-8">
            {loadError}
            <button type="button" onClick={fetchData} className="mc-btn bg-[#54a02a] mt-4 mx-auto block">
              重新加载
            </button>
          </div>
        )}
        {!loadError && posts.length === 0 && (
          <div className="col-span-full text-center opacity-40 text-2xl font-bold uppercase tracking-widest py-20">
            暂无记录
          </div>
        )}
        {posts.map((post) => (
          <div key={post.id} className="relative">
            <div
              role="link"
              tabIndex={0}
              onClick={() => router.push(`/post/${post.id}`)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') router.push(`/post/${post.id}`);
              }}
              className={`p-1 border-4 border-black ${post.status === 1 ? 'bg-[#4e4e4e]' : 'bg-[#795548]'} shadow-[8px_8px_0_0_rgba(0,0,0,0.4)] cursor-pointer`}
            >
              <div className="bg-[#c6c6c6] border-4 border-white border-b-[#8b8b8b] border-r-[#8b8b8b] p-4 min-h-[160px] flex flex-col justify-between text-[#313131]">
                <div>
                  <div className="flex justify-between items-start mb-2 gap-2">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        router.push(`/user/${encodeURIComponent(post.author_name)}`);
                      }}
                      className="text-[9px] bg-[#313131] text-[#F8D030] px-2 py-0.5 border border-black text-left"
                    >
                      @{post.author_name}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => toggleFavorite(e, post.id)}
                      className="text-xl leading-none px-1"
                      aria-label="收藏"
                    >
                      {favorites.includes(post.id) ? '⭐' : '☆'}
                    </button>
                  </div>
                  <h3 className="text-xl font-bold uppercase leading-tight line-clamp-2">{post.description}</h3>
                  <div className="mt-2 text-[8px] opacity-60 font-bold space-y-0.5">
                    <div>创: {formatDate(post.created_at)}</div>
                    <div className="text-[#795548]">更: {formatDate(post.updated_at)}</div>
                  </div>
                </div>
                <div className="flex justify-between items-end mt-4 text-[9px] font-bold uppercase">
                  <span>字数: {(post.content || '').length}</span>
                  {post.is_typing && <span className="text-red-600 animate-pulse">● 正在输入</span>}
                </div>
              </div>
            </div>
          </div>
        ))}
      </main>

      {isModalOpen && (
        <div
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-6"
          role="dialog"
          aria-modal="true"
          onClick={() => !isSubmitting && setIsModalOpen(false)}
        >
          <div
            className="bg-[#c6c6c6] border-8 border-[#313131] p-6 sm:p-8 w-full max-w-sm shadow-[20px_20px_0_0_rgba(0,0,0,0.5)]"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-2xl font-bold mb-6 text-[#313131] text-center border-b-4 border-[#8b8b8b] pb-2 uppercase">
              新建记录贴
            </h2>
            <input
              className="w-full bg-[#313131] border-4 border-[#8b8b8b] p-3 mb-8 outline-none text-[#54a02a] font-bold"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="输入标题..."
              enterKeyHint="done"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate();
              }}
            />
            <div className="flex gap-4">
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                disabled={isSubmitting}
                className="mc-btn flex-1 bg-[#8e8e8e]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={isSubmitting}
                className="mc-btn flex-1 bg-[#54a02a]"
              >
                {isSubmitting ? '同步中' : '确认'}
              </button>
            </div>
          </div>
        </div>
      )}

      <style jsx global>{`
        button,
        a,
        input,
        [role='button'],
        [role='link'] {
          cursor: pointer;
          touch-action: manipulation;
          -webkit-tap-highlight-color: rgba(84, 160, 42, 0.35);
        }
        .mc-btn {
          padding: 12px 16px;
          color: white;
          font-weight: bold;
          border-b-4 border-r-4 border-black;
          text-shadow: 2px 2px 0 rgba(0, 0, 0, 0.5);
          transition: transform 0.1s, border-width 0.1s;
          text-align: center;
          min-height: 44px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          -webkit-user-select: none;
          user-select: none;
        }
        .mc-btn:active {
          transform: translate(2px, 2px);
          border-bottom-width: 0;
          border-right-width: 0;
        }
      `}</style>
    </div>
  );
}
