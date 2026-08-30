'use client';
import { useEffect, useState, use } from 'react';
import { supabase } from '../../supabaseClient';
import Link from 'next/link';
const formatDate = (dateStr: string) => {
  if (!dateStr) return '无记录';
  const d = new Date(dateStr);
  return `${d.getFullYear()} ${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export default function UserPublicPage({ params }: { params: Promise<{ name: string }> }) {
  const resolvedParams = use(params);
  const name = decodeURIComponent(resolvedParams.name);
  const [posts, setPosts] = useState<any[]>([]);

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase.from('posts').select('*').eq('author_name', name).order('updated_at', { ascending: false });
      if (data) setPosts(data);
    };
    load();
  }, [name]);

  return (
    <div className="min-h-screen bg-[#313131] text-white font-mono p-8">
      <div className="max-w-4xl mx-auto">
        <header className="border-b-8 border-[#54a02a] pb-4 mb-12 flex justify-between items-end">
          <div>
            <span className="bg-[#795548] text-[#F8D030] px-2 text-xs font-bold border-2 border-black">写者资料_</span>
            <h1 className="text-5xl font-bold uppercase mt-2">@{name}</h1>
          </div>
          <Link href="/" className="mc-btn bg-[#8e8e8e]">返回广场</Link>
        </header>
        <div className="grid gap-6">
          {posts.map(post => (
            <div key={post.id} className="bg-[#c6c6c6] border-4 border-black p-4 shadow-[6px_6px_0_rgba(0,0,0,0.3)]">
              <Link href={`/post/${post.id}`}>
                <h3 className="text-xl text-[#313131] font-bold uppercase hover:underline">{post.description}</h3>
                <p className="text-[10px] text-black/40 font-bold mt-1">最近更新: {formatDate(post.updated_at)}</p>
              </Link>
            </div>
          ))}
        </div>
      </div>
      <style jsx>{` .mc-btn { padding: 10px; color: white; font-weight: bold; border-b-4 border-r-4 border-black; } `}</style>
    </div>
  );
}