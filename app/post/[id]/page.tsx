'use client';
import { useEffect, useState, use, useCallback, useRef } from 'react';
import { supabase } from '../../supabaseClient';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { checkSensitiveWord, hasSensitiveWord, preloadSensitiveWords } from '@/app/lib/sensitive';

const formatDate = (dateStr: string) => {
  if (!dateStr) return '无记录';
  const d = new Date(dateStr);
  return `${d.getFullYear()} ${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function debounce(fn: Function, ms: number) {
  let timeoutId: ReturnType<typeof setTimeout>;
  return function(this: any, ...args: any[]) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(this, args), ms);
  };
}

export default function PostPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const resolvedParams = use(params);
  const postId = resolvedParams.id;

  const [role, setRole] = useState<'writer' | 'viewer' | null>(null);
  const [post, setPost] = useState<any>(null);
  const [content, setContent] = useState('');
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [tempTitle, setTempTitle] = useState('');
  const [showExitModal, setShowExitModal] = useState(false);
  const [comments, setComments] = useState<any[]>([]);
  const [newComment, setNewComment] = useState('');
  const [isSendingComment, setIsSendingComment] = useState(false);
  const [userName, setUserName] = useState('无名氏');

  const contentRef = useRef('');
  const isOwnerRef = useRef(false);

  const fetchComments = useCallback(async () => {
    const { data } = await supabase.from('comments').select('*').eq('post_id', postId).order('created_at', { ascending: true });
    if (data) setComments(data);
  }, [postId]);

  useEffect(() => {
    let name = '无名氏';
    let myIds: string[] = [];
    try {
      name = localStorage.getItem('tl_user_name') || '无名氏';
      myIds = JSON.parse(localStorage.getItem('my_typing_live_posts') || '[]');
    } catch {
      /* private / restricted storage on some iOS modes */
    }
    setUserName(name);
    isOwnerRef.current = myIds.includes(postId);
    setRole(isOwnerRef.current ? 'writer' : 'viewer');

    // 词库按需加载，不阻塞帖子内容渲染
    preloadSensitiveWords();

    const loadData = async () => {
      const { data } = await supabase.from('posts').select('*').eq('id', postId).single();
      if (data) {
        setPost(data);
        setContent(data.content || '');
        setTempTitle(data.description);
        contentRef.current = data.content || '';
        if (isOwnerRef.current) {
          await supabase.from('posts').update({ is_typing: true }).eq('id', postId);
        }
      }
    };

    loadData();
    fetchComments();

    const channel = supabase.channel(`post-${postId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'posts', filter: `id=eq.${postId}` }, (p) => {
        if (p.eventType === 'DELETE') { router.push('/'); return; }
        const updated = p.new as any;
        setPost(updated);
        if (!isOwnerRef.current) setContent(updated.content || '');
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'comments', filter: `post_id=eq.${postId}` }, () => fetchComments())
      .subscribe();

    return () => {
      if (isOwnerRef.current) supabase.from('posts').update({ is_typing: false }).eq('id', postId).then();
      supabase.removeChannel(channel);
    };
  }, [postId, fetchComments, router]);

  const syncToDb = useCallback(debounce(async (val: string) => {
    await supabase.from('posts').update({ content: val }).eq('id', postId);
  }, 400), [postId]);

  // 正文：打字直播场景，要求实时校验（提交前就发现敏感词）
  // 匹配算法已优化：拼音中间态（bi / bei / wei / jin 等）不会被误拦
  const handleTyping = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    if (hasSensitiveWord(val)) {
      alert('正文包含敏感内容，请修改后再继续输入');
      return;
    }
    setContent(val);
    contentRef.current = val;
    syncToDb(val);
  };

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTempTitle(e.target.value);
  };

  const handleCommentChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setNewComment(e.target.value);
  };

  const updateTitle = async () => {
    const safeTitle = tempTitle.trim();
    if (!safeTitle) return;
    if (await checkSensitiveWord(safeTitle)) {
      alert('标题包含敏感内容，请修改后再重试');
      return;
    }
    await supabase.from('posts').update({ description: safeTitle }).eq('id', postId);
    setIsEditingTitle(false);
  };

  // 只能删自己发的评论。默认名字「无名氏」是所有未设置昵称的用户共用的，
  // 不能拿来当身份，所以没设昵称时一律不给删除入口。
  const canDeleteComment = (authorName: string) =>
    userName !== '无名氏' && authorName === userName;

  const deleteComment = async (commentId: string) => {
    const target = comments.find((c) => c.id === commentId);
    if (!target || !canDeleteComment(target.author_name)) return;
    const { error } = await supabase.from('comments').delete().eq('id', commentId);
    if (error) {
      alert('删除失败，请检查网络');
      return;
    }
    setComments(prev => prev.filter(c => c.id !== commentId));
  };

  const submitComment = async () => {
    const text = newComment.trim();
    if (!text || isSendingComment) return;
    if (await checkSensitiveWord(text)) {
      alert('评论包含敏感内容，无法发布！');
      return;
    }
    setIsSendingComment(true);
    try {
      // supabase-js 不会 reject，而是把错误放在返回值的 error 里，必须显式检查，
      // 否则发送失败时也会清空输入框，看起来像「发出去了」。
      const { error } = await supabase
        .from('comments')
        .insert([{ post_id: postId, author_name: userName, content: text }]);
      if (error) throw error;
      setNewComment('');
    } catch {
      alert('发送失败，请检查网络');
    } finally {
      setIsSendingComment(false);
    }
  };

  if (!post) return <div className="min-h-screen bg-[#313131] flex items-center justify-center text-white font-mono uppercase tracking-widest">加载存档中...</div>;

  return (
    <div className="min-h-screen bg-[#313131] text-white font-mono flex flex-col select-none cursor-default">
      {/* 顶部导航 - 居中标题 */}
      <header className="min-h-20 bg-[#c6c6c6] border-b-8 border-[#8b8b8b] flex justify-between items-center gap-2 px-3 sm:px-6 py-3 sticky top-0 z-10 shadow-2xl">
        <button type="button" onClick={() => setShowExitModal(true)} className="mc-btn-small bg-[#8e8e8e] shrink-0">← 返回</button>
        
        <div className="flex flex-col items-center flex-1 min-w-0 px-1">
          {isEditingTitle && role === 'writer' ? (
            <input 
              className="w-full max-w-full bg-[#313131] text-[#54a02a] border-4 border-[#8b8b8b] px-2 py-1 font-bold outline-none text-center text-base sm:text-xl"
              value={tempTitle}
              onChange={handleTitleChange}
              onBlur={updateTitle}
              onKeyDown={(e) => e.key === 'Enter' && updateTitle()}
            />
          ) : (
            <div 
              className={`flex flex-col items-center w-full ${role === 'writer' ? 'cursor-pointer group' : ''}`} 
              onClick={() => role === 'writer' && setIsEditingTitle(true)}
            >
              <h1 className="text-lg sm:text-3xl font-black text-white drop-shadow-[4px_4px_0_#000] uppercase text-center break-words px-1 leading-tight">
                {post.description}
              </h1>
              <div className="flex gap-2 mt-1 items-center flex-wrap justify-center">
                <span className="text-[10px] text-black/40 font-bold uppercase">
                  最后更新: {formatDate(post.updated_at)}
                </span>
                {role === 'writer' && (
                  <span className="text-[9px] text-[#54a02a] font-bold italic sm:opacity-0 sm:group-hover:opacity-100">
                    点击修改 ✎
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        <div className={`px-2 py-1 border-4 border-black font-bold text-[10px] sm:text-xs shrink-0 ${post.is_typing ? 'bg-red-600 animate-pulse' : 'bg-[#54a02a] shadow-[4px_4px_0_0_#2d5516]'}`}>
          {post.is_typing ? '输入中' : '离开'}
        </div>
      </header>

      <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
        <main className="flex-[2] p-4 md:p-8 bg-[#404040]">
          <div
            className="h-full bg-[#c6c6c6] border-t-[6px] border-l-[6px] border-r-[6px] border-b-[6px] p-6 shadow-[inset_8px_8px_0_rgba(0,0,0,0.5)] flex flex-col"
            style={{ borderTopColor: '#fff', borderLeftColor: '#fff', borderRightColor: '#555', borderBottomColor: '#555' }}
          >
            {role === 'writer' ? (
              <textarea 
                autoFocus 
                className="w-full h-full bg-transparent text-[#313131] text-xl md:text-2xl outline-none resize-none font-bold placeholder:opacity-20" 
                value={content} 
                onChange={handleTyping} // 接入拦截
                spellCheck={false} 
                placeholder="点击此处，构建属于你的史观碎片..." 
              />
            ) : (
              <div className="text-[#313131] text-xl md:text-2xl whitespace-pre-wrap font-bold flex-1 overflow-y-auto">{content || "该写者保持了沉默。"}</div>
            )}
            <div className="text-[10px] text-black/30 font-bold self-end mt-4 uppercase flex gap-4">
              <span>写者: @{post.author_name}</span>
              <span>字数统计: {content.length}</span>
            </div>
          </div>
        </main>

        <aside className="flex-1 bg-[#795548] border-l-8 border-[#3d2b24] p-4 flex flex-col gap-4 overflow-y-auto">
          <h2 className="text-[#54a02a] text-lg font-bold border-b-4 border-[#54a02a] uppercase tracking-widest pb-1">时间轴评论</h2>
          <div className="flex-1 space-y-4 overflow-y-auto pr-2">
            {comments.map(msg => (
              <div key={msg.id} className="bg-[#c6c6c6] border-4 border-black p-2 text-[#313131] shadow-[4px_4px_0_rgba(0,0,0,0.3)] relative">
                <div className="flex justify-between items-center gap-2 text-[8px] font-bold border-b border-black/10 mb-1">
                  <span className="opacity-60 truncate">@{msg.author_name} · {formatDate(msg.created_at)}</span>
                  {canDeleteComment(msg.author_name) && (
                    <button
                      type="button"
                      onClick={() => deleteComment(msg.id)}
                      aria-label="删除这条评论"
                      className="mc-btn-danger shrink-0"
                    >
                      销毁
                    </button>
                  )}
                </div>
                <p className="text-sm font-bold leading-tight">{msg.content}</p>
              </div>
            ))}
          </div>
          <div className="bg-[#313131] border-4 border-[#8b8b8b] p-2 flex gap-2 items-center">
            <input 
              className="flex-1 min-w-0 bg-transparent outline-none text-xs text-[#54a02a] font-bold" 
              placeholder="留下你的印记..." 
              value={newComment} 
              onChange={handleCommentChange} // 接入拦截
              enterKeyHint="send"
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitComment();
              }} 
            />
            <button
              type="button"
              onClick={submitComment}
              disabled={isSendingComment || !newComment.trim()}
              className="mc-btn-send shrink-0"
            >
              {isSendingComment ? '发送中' : '发送'}
            </button>
          </div>
        </aside>
      </div>

      {/* 优化后的 Minecraft 风格退出弹窗 */}
      {showExitModal && (
        <div className="fixed inset-0 bg-black/85 flex items-center justify-center z-50 p-4">
          <div
          className="bg-[#c6c6c6] border-t-[6px] border-l-[6px] border-r-[6px] border-b-[6px] p-1 shadow-[12px_12px_0_0_rgba(0,0,0,0.5)] max-w-sm w-full"
          style={{ borderTopColor: '#fff', borderLeftColor: '#fff', borderRightColor: '#555', borderBottomColor: '#555' }}
        >
            <div className="bg-[#c6c6c6] border-4 border-[#313131] p-6 relative">
              <div className="absolute top-0 left-0 w-2 h-2 bg-[#313131]"></div>
              <div className="absolute top-0 right-0 w-2 h-2 bg-[#313131]"></div>
              <div className="absolute bottom-0 left-0 w-2 h-2 bg-[#313131]"></div>
              <div className="absolute bottom-0 right-0 w-2 h-2 bg-[#313131]"></div>
              
              <p className="text-[#313131] font-black mb-8 text-center text-sm leading-relaxed tracking-tight px-2">
                资料已保存<br/>
                确定要退出吗？
              </p>

              <div className="flex flex-col gap-4">
                <button 
                  onClick={async () => { 
                    if (isOwnerRef.current) await supabase.from('posts').update({ is_typing: false }).eq('id', postId);
                    router.push('/'); 
                  }} 
                  className="mc-btn-large bg-[#A31F34] hover:bg-[#C4253D] text-white cursor-pointer"
                >
                  确定退出
                </button>
                <button 
                  onClick={() => setShowExitModal(false)} 
                  className="mc-btn-large bg-[#8e8e8e] hover:bg-[#aaaaaa] text-white cursor-pointer"
                >
                  取消
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <style jsx global>{`
        button, a, .cursor-pointer {
          cursor: pointer !important;
          touch-action: manipulation;
          -webkit-tap-highlight-color: rgba(84, 160, 42, 0.35);
        }
        
        /* 强化版 MC 大按钮 */
        .mc-btn-large {
          position: relative;
          padding: 14px;
          font-weight: 900;
          text-transform: uppercase;
          border-top: 4px solid rgba(255,255,255,0.3);
          border-left: 4px solid rgba(255,255,255,0.3);
          border-right: 4px solid rgba(0,0,0,0.4);
          border-bottom: 4px solid rgba(0,0,0,0.4);
          outline: 4px solid #000;
          margin: 4px;
          text-shadow: 2px 2px 0 rgba(0,0,0,0.8);
          transition: all 0.05s;
        }
        .mc-btn-large:active {
          transform: translate(2px, 2px);
          border-top: 4px solid rgba(0,0,0,0.4);
          border-left: 4px solid rgba(0,0,0,0.4);
          border-right: 4px solid rgba(255,255,255,0.3);
          border-bottom: 4px solid rgba(255,255,255,0.3);
        }

        /* 统一小按钮 */
        .mc-btn-small {
          padding: 6px 12px;
          color: white;
          font-weight: bold;
          background: #8e8e8e;
          border-top: 2px solid rgba(255,255,255,0.5);
          border-left: 2px solid rgba(255,255,255,0.5);
          border-right: 2px solid #000;
          border-bottom: 2px solid #000;
          outline: 2px solid #313131;
          text-shadow: 1px 1px 0 rgba(0,0,0,0.5);
        }
        .mc-btn-small:active {
           transform: translate(1px, 1px);
           border: 0;
        }

        /* 评论区发送按钮：沿用 mc-btn-small 的立体描边，换成主题绿 */
        .mc-btn-send {
          padding: 6px 12px;
          color: white;
          font-weight: bold;
          background: #54a02a;
          border-top: 2px solid rgba(255,255,255,0.5);
          border-left: 2px solid rgba(255,255,255,0.5);
          border-right: 2px solid #000;
          border-bottom: 2px solid #000;
          outline: 2px solid #313131;
          text-shadow: 1px 1px 0 rgba(0,0,0,0.5);
          white-space: nowrap;
          min-height: 32px;
        }
        .mc-btn-send:active:not(:disabled) {
          transform: translate(1px, 1px);
          border: 0;
        }
        .mc-btn-send:disabled {
          opacity: 0.45;
          cursor: not-allowed !important;
        }

        /* 评论「销毁」按钮：始终可见（不再依赖 PC 的 hover），手机上也能直接点 */
        .mc-btn-danger {
          padding: 3px 8px;
          font-size: 10px;
          line-height: 1;
          color: #fff;
          font-weight: bold;
          background: #a31f34;
          border-top: 2px solid rgba(255,255,255,0.45);
          border-left: 2px solid rgba(255,255,255,0.45);
          border-right: 2px solid #000;
          border-bottom: 2px solid #000;
          text-shadow: 1px 1px 0 rgba(0,0,0,0.5);
          white-space: nowrap;
          min-height: 24px;
          display: inline-flex;
          align-items: center;
        }
        .mc-btn-danger:active {
          transform: translate(1px, 1px);
          border: 0;
        }
      `}</style>
    </div>
  );
}