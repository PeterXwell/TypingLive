'use client';
import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../supabaseClient';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { checkSensitiveWord, preloadSensitiveWords } from '@/app/lib/sensitive';

const formatDate = (dateStr: string) => {
  if (!dateStr) return '无记录';
  const d = new Date(dateStr);
  return `${d.getFullYear()} ${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export default function ProfilePage() {
  const router = useRouter();
  const [userName, setUserName] = useState('无名氏');
  const [isEditingName, setIsEditingName] = useState(false);
  const [newName, setNewName] = useState('无名氏');
  const [activeTab, setActiveTab] = useState<'mine' | 'fav'>('mine');
  const [posts, setPosts] = useState<any[]>([]);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  const loadData = useCallback(async (currentName: string) => {
    if (activeTab === 'mine') {
      let myIds: string[] = [];
      try {
        myIds = JSON.parse(localStorage.getItem('my_typing_live_posts') || '[]');
      } catch {
        myIds = [];
      }
      if (myIds.length > 0) {
        const { data } = await supabase.from('posts').select('*').in('id', myIds).order('updated_at', { ascending: false });
        if (data) setPosts(data);
      } else { setPosts([]); }
    } else {
      const { data: favs } = await supabase.from('favorites').select('post_id').eq('user_name', currentName);
      if (favs && favs.length > 0) {
        const { data } = await supabase.from('posts').select('*').in('id', favs.map(f => f.post_id)).order('updated_at', { ascending: false });
        if (data) setPosts(data);
      } else { setPosts([]); }
    }
  }, [activeTab]);

  useEffect(() => {
    let name = '无名氏';
    try {
      name = localStorage.getItem('tl_user_name') || '无名氏';
    } catch {
      name = '无名氏';
    }
    setUserName(name);
    setNewName(name);
    loadData(name);
    preloadSensitiveWords();
  }, [loadData]);

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setNewName(e.target.value);
  };

  const saveName = async () => {
    if (!newName.trim() || newName === userName || isSyncing) {
      setIsEditingName(false);
      return;
    }

    if (await checkSensitiveWord(newName)) {
      alert('姓名包含敏感内容，无法保存！');
      return;
    }

    setIsSyncing(true);
    let myIds: string[] = [];
    try {
      myIds = JSON.parse(localStorage.getItem('my_typing_live_posts') || '[]');
    } catch {
      myIds = [];
    }

    try {
      // 核心修复：更名时，同步更新数据库中属于我的所有帖子的作者名
      if (myIds.length > 0) {
        await supabase.from('posts').update({ author_name: newName }).in('id', myIds);
      }
      // 同时也需要同步收藏表中的名字，否则收藏列表会丢失
      await supabase.from('favorites').update({ user_name: newName }).eq('user_name', userName);

      try {
        localStorage.setItem('tl_user_name', newName);
      } catch {
        /* private mode */
      }
      setUserName(newName);
      setIsEditingName(false);
      loadData(newName);
    } catch (e) {
      alert("同步失败，请检查网络");
    } finally {
      setIsSyncing(false);
    }
  };

  const executeDelete = async () => {
    if (!deleteId) return;
    await supabase.from('posts').delete().eq('id', deleteId);
    setPosts(prev => prev.filter(p => p.id !== deleteId));
    setDeleteId(null);
  };

  return (
    <div className="min-h-screen bg-[#313131] text-white font-mono p-8 select-none">
      <div className="max-w-4xl mx-auto">
        <header className="flex justify-between items-end border-b-8 border-[#54a02a] pb-4 mb-12">
          <div>
            <span className="bg-[#795548] text-[#F8D030] px-2 text-xs font-bold border-2 border-black">档案库_</span>
            {isEditingName ? (
              <div className="flex flex-wrap gap-2 mt-2">
                <input 
                  className="bg-[#c6c6c6] text-[#313131] border-4 border-black px-2 text-xl sm:text-2xl font-bold outline-none min-w-0 flex-1" 
                  value={newName} 
                  onChange={handleNameChange}
                  onKeyDown={(e) => e.key === 'Enter' && saveName()}
                />
                <button type="button" onClick={saveName} className="mc-btn-small bg-[#54a02a]">{isSyncing ? '...' : '保存'}</button>
              </div>
            ) : (
              <h1 className="text-3xl sm:text-5xl font-bold uppercase mt-2 cursor-pointer hover:text-[#54a02a] break-all" onClick={() => setIsEditingName(true)}>@{userName} ✎</h1>
            )}
          </div>
          <Link href="/" className="mc-btn bg-[#8e8e8e]">返回广场</Link>
        </header>

        <div className="flex gap-2 mb-8">
          <button onClick={() => setActiveTab('mine')} className={`mc-btn flex-1 ${activeTab === 'mine' ? 'bg-[#54a02a]' : 'bg-[#4e4e4e]'}`}>我的资料</button>
          <button onClick={() => setActiveTab('fav')} className={`mc-btn flex-1 ${activeTab === 'fav' ? 'bg-[#F8D030]' : 'bg-[#4e4e4e]'}`}>我的收藏</button>
        </div>

        <div className="space-y-6">
          {posts.map(post => (
            <div key={post.id} className="bg-[#c6c6c6] border-4 border-black p-4 flex justify-between items-center shadow-[6px_6px_0_rgba(0,0,0,0.3)]">
              <Link href={`/post/${post.id}`} className="flex-1">
                <h3 className="text-xl text-[#313131] font-bold uppercase hover:underline">{post.description}</h3>
                <div className="text-[9px] text-black/40 font-bold space-x-4">
                  <span>创: {formatDate(post.created_at)}</span>
                  <span className="text-[#795548]">更: {formatDate(post.updated_at)}</span>
                </div>
              </Link>
              {activeTab === 'mine' && (
                <button onClick={() => setDeleteId(post.id)} className="mc-btn-small bg-[#A31F34]">销毁</button>
              )}
            </div>
          ))}
          {posts.length === 0 && <div className="text-center py-20 opacity-20 text-4xl font-bold uppercase tracking-widest">Empty Slot</div>}
        </div>
      </div>

      {deleteId && (
        <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-50">
          <div className="bg-[#c6c6c6] border-8 border-[#313131] p-6 max-w-xs text-center shadow-[16px_16px_0_rgba(0,0,0,0.5)]">
            <p className="text-[#313131] font-bold mb-6 text-sm">确定要永久抹除这段记录吗？一旦销毁，将不可复原。</p>
            <div className="flex flex-col gap-3">
              <button onClick={executeDelete} className="mc-btn bg-[#A31F34]">确认销毁</button>
              <button onClick={() => setDeleteId(null)} className="mc-btn bg-[#8e8e8e]">保留记录</button>
            </div>
          </div>
        </div>
      )}
      <style jsx global>{`
        button, a { touch-action: manipulation; -webkit-tap-highlight-color: rgba(84, 160, 42, 0.35); }
        .mc-btn { padding: 12px 16px; color: white; font-weight: bold; border-b-4 border-r-4 border-black; cursor: pointer; text-shadow: 2px 2px 0 rgba(0,0,0,0.5); min-height: 44px; display: inline-flex; align-items: center; justify-content: center; }
        .mc-btn-small { padding: 8px 12px; color: white; font-weight: bold; border-b-2 border-r-2 border-black; min-height: 36px; }
      `}</style>
    </div>
  );
}