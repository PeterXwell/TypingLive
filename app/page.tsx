'use client';
import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import './style.css'; 

export default function TypingLive() {
  const [role, setRole] = useState<'writer' | 'viewer'>('writer');
  const [content, setContent] = useState('');
  // 💡 请确保这里是你的真实 UUID
  const [postId, setPostId] = useState('3120fb4a-2d14-4d2d-b65c-46c1287629e6'); 
  
  const [showHammer, setShowHammer] = useState(false);
  const [showApplause, setShowApplause] = useState(false);

  useEffect(() => {
    // 采用你确认正常的订阅逻辑
    const channel = supabase.channel(`room-${postId}`, {
      config: { broadcast: { self: true } }
    });

    channel
      .on('broadcast', { event: 'witness' }, () => {
        setShowHammer(true);
        setTimeout(() => setShowHammer(false), 600); 
      })
      .on('broadcast', { event: 'applause' }, () => {
        setShowApplause(true);
        setTimeout(() => setShowApplause(false), 500);
      })
      .on('postgres_changes', 
        { event: 'UPDATE', schema: 'public', table: 'posts', filter: `id=eq.${postId}` }, 
        (payload) => { 
          // 核心实时显示逻辑
          if (role === 'viewer') {
            setContent(payload.new.content);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [role, postId]); // 保持依赖项简单清晰

  const sendInteraction = (type: 'witness' | 'applause') => {
    supabase.channel(`room-${postId}`).send({
      type: 'broadcast',
      event: type,
      payload: {},
    });
  };

  const handleTyping = async (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setContent(val);
    await supabase.from('posts').update({ content: val }).eq('id', postId);
  };

  return (
    <div className="p-6 md:p-10 max-w-2xl mx-auto font-sans min-h-screen bg-white">
      {/* 标题部分改为：重述 TypingLive */}
      <header className="flex justify-between items-end mb-10">
        <div>
          <h1 className="text-4xl font-black text-black tracking-tighter uppercase">TypingLive</h1>
          <p className="text-sm font-medium text-gray-500 mt-1">重述 — 每个人都是生活的写者</p>
        </div>
        <div className="flex bg-gray-100 p-1 rounded-xl">
          <button onClick={() => setRole('writer')} className={`px-5 py-2 rounded-lg text-sm font-bold transition-all ${role === 'writer' ? 'bg-black text-white' : 'text-gray-500'}`}>写者</button>
          <button onClick={() => setRole('viewer')} className={`px-5 py-2 rounded-lg text-sm font-bold transition-all ${role === 'viewer' ? 'bg-black text-white' : 'text-gray-500'}`}>读者</button>
        </div>
      </header>
      
      <main className="relative">
        {role === 'writer' ? (
          <textarea 
            className="w-full h-96 p-8 border-4 border-black rounded-3xl shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] text-2xl outline-none focus:ring-4 ring-gray-50 transition-all resize-none leading-relaxed"
            value={content} onChange={handleTyping}
            placeholder="在此处开始重述..."
          />
        ) : (
          <div className="w-full h-96 p-8 bg-stone-50 border-4 border-black rounded-3xl shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] text-2xl whitespace-pre-wrap overflow-y-auto text-black border-dashed leading-relaxed">
            {content || <span className="text-gray-300 italic">等待写者重述...</span>}
            <span className="inline-block w-2 h-7 bg-blue-500 animate-pulse ml-1 align-middle" />
          </div>
        )}

        {/* 互动反馈区：保持在输入框正下方 */}
        <div className="h-28 flex justify-center items-center mt-6">
          <div className="relative w-24 h-24 flex items-center justify-center">
            {showHammer && <div className="text-7xl hammer-animation">🔨</div>}
            {showApplause && <div className="text-7xl applause-animation">👏</div>}
            {!showHammer && !showApplause && (
              <div className="text-gray-300 text-xs italic tracking-widest uppercase opacity-40">Ready</div>
            )}
          </div>
        </div>
      </main>

      {role === 'viewer' && (
        <footer className="grid grid-cols-2 gap-6 mt-2">
          <button onClick={() => sendInteraction('witness')} className="py-5 border-4 border-black rounded-2xl font-black hover:bg-gray-50 active:translate-y-1 transition-all shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] text-xl">🔨 见证</button>
          <button onClick={() => sendInteraction('applause')} className="py-5 border-4 border-black rounded-2xl font-black hover:bg-gray-50 active:translate-y-1 transition-all shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] text-xl">👏 鼓掌</button>
        </footer>
      )}
    </div>
  );
}