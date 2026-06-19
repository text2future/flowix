export {
  openNoteByMemoId,
  openNoteByPhysicalPath,
  resolveMemoById,
  resolveMemoByPath,
} from '../../../../lib/openByTarget';

// 鐗╃悊璺緞绮樿创 鈫?noteReference 鍗＄墖銆?//
// 鐢ㄦ埛浠?Finder / 缁堢澶嶅埗涓€浠?`~/Documents/flowix/<notebook>/<title>.md`
// 杩欑绗旇鏈唴鐨勭粷瀵硅矾寰勭矘璐村埌缂栬緫鍣? 杩欓噷璐熻矗:
//   1. 瑙ｆ瀽璺緞鏂囦欢鍚?鈹€鈹€ v3 鍚?filename 宸茬粡鏄鐩樻枃浠跺悕 (鍚?.md),
//      涓嶅啀甯?`#<id>` 鍚庣紑, 鎵€浠?memoId 蹇呴』浠?index.json 鍙嶆煡銆?//   2. 鎸?notebook.path 鍋氬墠缂€姣斿, 鍛戒腑鍚庣敤璇?notebook 涓?index.json
//      `filename` 瀛楁鍖归厤 鈹€鈹€ 鍛戒腑鍚庣粰鍑?attrs 璁╀笂娓告瀯閫?noteReference 鑺傜偣
//
// 璁捐瑕佺偣:
// - **涓嶅厑璁稿瓙鐩綍**: 鏂囦欢蹇呴』鐩存帴鍦?notebook 鏍圭洰褰曚笅 (`path === notebook.path + filename`),
//   璺熷悗绔?`reconcile_with_disk` 鍙壂鏍圭洰褰曠殑琛屼负瀵归綈, 閬垮厤鍑虹幇鏍规湰涓嶄細琚储寮曠殑寮曠敤銆?// - **鍓嶇紑鎸夐暱搴﹀€掑簭姣?*: 闃叉 `/a/b/c-notebook/` 鎶婃洿鐭殑 `/a/b/` notebook 璇懡涓€?// - **notebook 鍒楄〃 + 姣忎釜 notebook 鐨?filename鈫抜d 鏄犲皠閮借蛋妯″潡绾х紦瀛?*:
//   绮樿创灞炰簬楂橀閿洏浜嬩欢, 涓嶈兘姣忔璧?IPC銆侫pp.tsx 鍚姩鏃?//   `prewarmNotebookCache()`, notebook 鍙樻洿鏃?`invalidateNotebookCache()`銆?//   鍐峰惎鍔ㄦ湭鍒颁綅鏃惰繑鍥?null, 璧版櫘閫氭枃鏈矾寰?鈥?涓嶉樆濉炵矘璐淬€?//
// v3 鏀归€? 涓嶅啀瑙ｆ瀽 filename 鏈熬鐨?`#<id>`, 鏀规垚 IPC 鎷?index.json
// 鍚庢寜 filename 鍙嶆煡 memoId銆?
import { notebooks } from '../../../../lib/tauri/client';

// 鈹€鈹€鈹€ Types 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

interface NotebookLite {
  id: string;
  name: string;
  path: string;
}

export interface NoteReferenceAttrs {
  memoId: string | null;
  notebookId: string;
  notebookName: string;
  title: string;
  originalPath: string;
  /** 娓叉煋鎬佹爣璁?鈥?涓嶅啓鍏?markdown */
  stale: boolean;
}

// 鈹€鈹€鈹€ Notebook + filename 鈫?id cache 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

interface CacheEntry {
  notebook: NotebookLite;
}

let cached: CacheEntry[] | null = null;
let cachePromise: Promise<CacheEntry[]> | null = null;

function fetchNotebooks(): Promise<CacheEntry[]> {
  return notebooks.getAll().then(async (list) => {
    const arr = Array.isArray(list) ? list : [];
    const lite: NotebookLite[] = arr
      .map((n: any) => ({
        id: String(n?.id ?? ''),
        name: String(n?.name ?? ''),
        path: String(n?.path ?? ''),
      }))
      .filter((n) => n.id && n.path);

    return lite.map((notebook) => ({ notebook }));
  });
}

/**
 * App.tsx 椤跺眰璋冪敤 鈥?璁?notebook 鍒楄〃鍦ㄩ甯у悗灏卞父椹诲唴瀛? 閬垮厤鐢ㄦ埛棣栨绮樿创
 * 鐗╃悊璺緞鏃剁紦瀛樹负绌哄鑷?miss銆傚け璐ユ椂闈欓粯, 涓嬫绮樿创浼氬啀灏濊瘯鎷夊彇銆? */
export function prewarmNotebookCache(): Promise<void> {
  if (cached) return Promise.resolve();
  if (!cachePromise) {
    cachePromise = fetchNotebooks().then((list) => {
      cached = list;
      return list;
    }).catch((err) => {
      // 鎷夊彇澶辫触璁╀笅娆?prewarm/match 鍐嶈瘯
      // eslint-disable-next-line no-console
      console.warn('[note-reference] prewarmNotebookCache failed:', err);
      cachePromise = null;
      return [];
    });
  }
  return cachePromise.then(() => undefined);
}

/**
 * notebook 澧炲垹鏀?/ memo 澧炲垹鏀瑰悕鏃惰皟 鈥?鎶婄紦瀛樻竻鎺? 涓嬫绮樿创浼氳Е鍙? * 閲嶆柊鎷夊彇銆備笂娓稿彲鎸傚湪 `agent-access-changed` / `memo-event` 浜嬩欢
 * (notebook CRUD 涓?memo CRUD 鏃朵細 emit)銆? */
export function invalidateNotebookCache(): void {
  cached = null;
  cachePromise = null;
}

// 鈹€鈹€鈹€ Path normalization 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/**
 * 鎶婄矘璐存澘鐨?璺緞涓?娲楁垚绾粷瀵硅矾寰?
 *   - 鍘婚灏剧┖鏍? *   - 鍘诲寘瑁圭殑鍗?鍙屽紩鍙? *   - 瑙?`file://` 鍓嶇紑 + percent-decode
 *   - 鎷掔粷鍚崲琛?(澶氳鍓创鏉夸氦杩樼粰 Tiptap 榛樿澶勭悊)
 */
function normalizeFsPath(path: string): string {
  let s = path.trim().replace(/\\/g, '/');
  const uncPrefix = s.startsWith('//') ? '//' : '';
  s = uncPrefix + s.slice(uncPrefix.length).replace(/\/+/g, '/');

  if (/^[A-Za-z]:\/$/.test(s) || s === '/' || s === '//') return s;
  return s.replace(/\/+$/, '');
}

function hasAbsolutePathShape(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path);
}

function hasWindowsDrive(path: string): boolean {
  return /^[A-Za-z]:\//.test(path);
}

function comparePath(path: string, forceCaseInsensitive = false): string {
  return forceCaseInsensitive || hasWindowsDrive(path) ? path.toLowerCase() : path;
}

function decodeFileUrl(raw: string): string | null {
  const driveMatch = raw.match(/^file:\/\/\/?([A-Za-z]:[\\/].*)$/i);
  if (driveMatch) {
    return decodeURIComponent(driveMatch[1]);
  }

  try {
    const url = new URL(raw);
    let pathname = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:[\\/]/.test(pathname)) {
      pathname = pathname.slice(1);
    }
    return pathname;
  } catch {
    return null;
  }
}

function normalizePath(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (/[\r\n]/.test(s)) return null;

  // 鍘婚灏惧寘瑁瑰紩鍙?(Finder "澶嶅埗璺緞" 鍋跺皵鍔犲紩鍙? 缁堢绮樿创甯歌)
  if ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }

  // file:// 鍓嶇紑 鈥?瑙?percent-encoding 鍚庤繕鍘熸垚缁濆璺緞
  if (/^file:/i.test(s)) {
    const decoded = decodeFileUrl(s);
    if (!decoded) return null;
    s = decoded;
  }

  // 蹇呴』鏄粷瀵硅矾寰?(mac/linux 璧?'/'; windows 鐣欎綔鏈潵鎵╁睍)
  s = normalizeFsPath(s);

  if (!hasAbsolutePathShape(s)) return null;
  return s;
}

function getDirectChildFilename(path: string, notebookPath: string): string | null {
  const normalizedPath = normalizeFsPath(path);
  const normalizedNotebook = normalizeFsPath(notebookPath);
  if (!normalizedPath || !normalizedNotebook) return null;

  const caseInsensitive = hasWindowsDrive(normalizedPath) || hasWindowsDrive(normalizedNotebook);
  const prefix = `${comparePath(normalizedNotebook, caseInsensitive)}/`;
  if (!comparePath(normalizedPath, caseInsensitive).startsWith(prefix)) return null;

  const remainder = normalizedPath.slice(normalizedNotebook.length + 1);
  if (!remainder || remainder.includes('/')) return null;
  return remainder;
}

// 鈹€鈹€鈹€ Main entry 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/**
 * 灏濊瘯鎶婁竴娈电矘璐存枃鏈В鏋愭垚 noteReference attrs銆? *
 * 杩斿洖 null 鐨勫満鏅竴寰嬬敱 caller 璧?fallthrough (鏅€氭枃鏈?/ markdown 瑙ｆ瀽):
 *   - 鏂囨湰涓嶅儚缁濆璺緞
 *   - 鏂囦欢鍚嶄笉鏄?.md
 *   - 娌℃湁浠讳綍 notebook 鍓嶇紑鍛戒腑
 *   - 鍛戒腑 notebook 浣?index.json 閲屾壘涓嶅埌璇?filename (鏂囦欢琚垹 / 鏀瑰悕鏈储寮?
 *   - notebook 缂撳瓨涓虹┖ (鍐峰惎鍔ㄨ繕娌℃媺鍒?
 *
 * 涓嶅仛寮傛 IPC 鈥?鏁翠釜鍒ゅ畾璧板悓姝ヨ矾寰? 璁?`MarkdownPaste.handlePaste` 鑳界珛鍒诲喅鏂€? */
export function tryMatchPhysicalMemoPath(raw: string): NoteReferenceAttrs | null {
  if (!cached || cached.length === 0) return null;

  const path = normalizePath(raw);
  if (!path) return null;

  const slash = path.lastIndexOf('/');
  if (slash < 0) return null;
  const filename = path.slice(slash + 1);

  // 蹇呴』 .md 缁撳熬 (澶у皬鍐欎笉鏁忔劅, 涓庡悗绔竴鑷?
  if (!/\.md$/i.test(filename)) return null;

  // 鎸?path 闀垮害鍊掑簭, 浼樺厛鍖归厤鏈€闀垮墠缂€
  const sorted = [...cached].sort(
    (a, b) => normalizeFsPath(b.notebook.path).length - normalizeFsPath(a.notebook.path).length,
  );
  for (const entry of sorted) {
    const nb = entry.notebook;
    if (!nb.path) continue;
    const directChildFilename = getDirectChildFilename(path, nb.path);
    if (directChildFilename !== filename) continue;

    // title 璺?filename 鍘诲悗缂€鍚屽舰 (filename 鏄?"Hello.md" 鈫?title "Hello")
    const title = filename.replace(/\.md$/i, '');

    return {
      memoId: null,
      notebookId: nb.id,
      notebookName: nb.name,
      title,
      originalPath: path,
      stale: false,
    };
  }
  return null;
}

// 鈹€鈹€鈹€ Test hooks 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/** 浠呬緵鍗曟祴鐢?鈥?鐩存帴鍠?notebook 鍒楄〃缁曡繃 IPC */
export function __setCacheForTests(list: NotebookLite[] | null): void {
  // 娴嬭瘯閽╁瓙: 璁╂祴璇曟柟鍙敞鍏?notebook, filename 绱㈠紩鐣欑┖ 鈹€鈹€ 娴嬭瘯渚?  // 璧?tryMatch 涔嬪墠鑷鍑嗗銆傜敓浜ц矾寰勮蛋 prewarmNotebookCache 鎷夊叏閲忋€?  cached = list?.map((nb) => ({ notebook: nb })) ?? null;
  cachePromise = list ? Promise.resolve(cached!) : null;
}

/** Test-only path parser hook. */
export function __normalizePhysicalPathForTests(raw: string): string | null {
  return normalizePath(raw);
}

/** 浠呬緵鍗曟祴鐢?鈥?缁欐寚瀹?notebook 娉ㄥ叆 filename鈫抜d 鏄犲皠 */
export function __setFilenameIndexForTests(
  notebookId: string,
  mapping: Record<string, string>,
): void {
  void notebookId;
  void mapping;
}
