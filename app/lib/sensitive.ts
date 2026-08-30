// app/lib/sensitive.ts
// 词库放在 /public/words.json，运行时按需 fetch，避免打进客户端 JS 导致 iOS Safari/Chrome 卡死

const IS_ALNUM = /[A-Za-z0-9]/;

function isAlnumAt(s: string, i: number): boolean {
  if (i < 0 || i >= s.length) return false;
  const c = s.charCodeAt(i);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

let cjkArr: string[] | null = null;
let alphaArr: string[] | null = null;
let loadPromise: Promise<void> | null = null;

function processWords(wordsData: unknown) {
  const RAW_WORDS: string[] = Array.isArray(wordsData)
    ? wordsData
    : (wordsData as { default?: string[] })?.default || [];

  const CJK_ONLY_WORDS: string[] = [];
  const HAS_ALNUM_WORDS: string[] = [];

  for (const raw of RAW_WORDS) {
    if (!raw) continue;
    const w = String(raw).trim().toLowerCase();
    if (!w) continue;
    if (w.length === 1) continue;
    if (/^[A-Za-z0-9]+$/.test(w) && w.length < 3) continue;
    if (IS_ALNUM.test(w)) {
      HAS_ALNUM_WORDS.push(w);
    } else {
      CJK_ONLY_WORDS.push(w);
    }
  }

  cjkArr = Array.from(new Set(CJK_ONLY_WORDS)).sort((a, b) => b.length - a.length);
  alphaArr = Array.from(new Set(HAS_ALNUM_WORDS)).sort((a, b) => b.length - a.length);
}

/** 预加载词库（可在页面挂载时调用，避免首次输入卡顿） */
export function preloadSensitiveWords(): Promise<void> {
  if (cjkArr && alphaArr) return Promise.resolve();
  if (!loadPromise) {
    loadPromise = fetch('/words.json')
      .then((r) => {
        if (!r.ok) throw new Error(`words.json ${r.status}`);
        return r.json();
      })
      .then(processWords)
      .catch((err) => {
        console.error('sensitive words load failed', err);
        loadPromise = null;
        // 失败时用空表，避免整站不可用；提交侧仍可再试
        if (!cjkArr) cjkArr = [];
        if (!alphaArr) alphaArr = [];
      });
  }
  return loadPromise;
}

function matchAlphaBoundaries(lowerText: string, w: string): boolean {
  const n = lowerText.length;
  const wl = w.length;
  if (wl === 0 || n < wl) return false;
  let idx = lowerText.indexOf(w);
  while (idx !== -1) {
    const before = idx - 1;
    const after = idx + wl;
    if (!isAlnumAt(lowerText, before) && !isAlnumAt(lowerText, after)) {
      return true;
    }
    idx = lowerText.indexOf(w, idx + 1);
  }
  return false;
}

/** 同步检测：词库未就绪时返回 false（请先 preload / 用 checkSensitiveWord） */
export function hasSensitiveWord(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  if (!cjkArr || !alphaArr) return false;

  const lowerText = text.toLowerCase();

  for (let i = 0; i < alphaArr.length; i++) {
    if (matchAlphaBoundaries(lowerText, alphaArr[i])) return true;
  }
  for (let i = 0; i < cjkArr.length; i++) {
    if (lowerText.indexOf(cjkArr[i]) !== -1) return true;
  }
  return false;
}

/** 异步检测：确保词库已加载后再判断（用于提交/保存） */
export async function checkSensitiveWord(text: string): Promise<boolean> {
  await preloadSensitiveWords();
  return hasSensitiveWord(text);
}
