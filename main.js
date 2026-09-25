'use strict';

/**
 * Comfy 数据表 — Obsidian 插件
 *
 * 功能:
 *   1. 第一列是 ID 的 md 表格: TEXT 类型列超长内容在渲染层用省略号截断(源码不变)
 *   2. 所有列与内容严格单行展示, 超出时横向滚动
 *   3. 完整分页: 每页数量选择 / 首页 / 上一页 / 页码 / 下一页 / 尾页 / 跳转
 *   4. 表格上方搜索过滤
 *   5. ID 列点击切换增序 / 降序
 *   6. 在表格内输入 @ 自动弹窗浏览 ComfyUI output 目录(仅普通文件 + 「数字-」/「数字_」编号目录),
 *      选中文件后确定, 自动插入 @{目录名/文件名} 或 @{文件名}
 *   7. 双击单元格就地编辑: TEXT 弹多行编辑器; IMAGE/VIDEO/AUDIO/MASK 弹同一个文件
 *      浏览器并写入 @{...}; INT/FLOAT 就地换成输入框, 失焦即写回
 *   8. 所有写回都只替换目标单元格那一段字符, 同行其它格与文件其它内容一个字节不动
 *   9. 文件浏览器排序: 接管 FileExplorer 的 getSortedFolderItems, 按「编号分层」重排,
 *      让 00110_万物建模2.1 紧跟 0011_万物建模 之后
 *      (Obsidian 原生是自然排序, 会把 5 位编号当作数值 110 甩到最后)
 *  10. 引用原文还原: `@{表名_编号/行ID_名称}` 里的下划线会被 Markdown 的强调语法
 *      当强调吃掉(中文紧邻下划线时 Obsidian 判定失效, 属其已知问题), 阅读视图与编辑
 *      模式实时渲染的表格单元格都在显示层把原文补回, md 源码一个字节不动
 */

const obsidian = require('obsidian');
const fs = require('fs');
const path = require('path');

const { Plugin, PluginSettingTab, Setting, Modal, Notice, MarkdownRenderChild } = obsidian;

// ─── 常量 ────────────────────────────────────────────────────────────────

/** 图片扩展名 → 弹窗里显示静态缩略图 */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg']);

/** 视频扩展名 → 弹窗里用 <video> 显示首帧 */
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'mkv', 'm4v', 'avi']);

/** 音频扩展名 → 弹窗里用音频图标 + 可播放 */
const AUDIO_EXT = new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus']);

/** 编号目录判据: 数字开头后接连字符或下划线, 例如 0040_文生视频 */
const NUMBERED_DIR_RE = /^\d+[-_]/;

/** 引用型列: 双击弹 output 文件浏览器, 选中后把 `@{...}` 写回该格 */
const REF_TYPES = new Set(['IMAGE', 'VIDEO', 'AUDIO', 'MASK']);

/** 数值型列: 双击就地换成输入框, 失焦时写回该格 */
const NUM_TYPES = new Set(['INT', 'FLOAT']);

/** 引用原文还原判据: `@{表名数字+名字/行ID数字+名字}`, 即两条下划线都被强调吃掉时的形态 */
const REF_TEXT_RE = /^@\{(\d+)([^/}]*)\/(\d+)([^/}]*)\}$/;

/** 默认设置 */
const DEFAULT_SETTINGS = {
  /** ComfyUI output 目录绝对路径; 留空则用 vault 同级的 media/七纹刻印 猜测 */
  outputDir: 'D:\\Comfy\\media\\七纹刻印',
  /** 表格增强总开关 */
  enableTable: true,
  /** @ 弹窗总开关 */
  enableAtSuggest: true,
  /** 每页数量可选项 */
  pageSizes: [20, 50, 100, 200],
  /** 默认每页数量; 0 表示全部 */
  defaultPageSize: 20,
  /** TEXT 列最大宽度(px), 超出用省略号 */
  textColMaxWidth: 420,
  /** 其它列最大宽度(px) */
  otherColMaxWidth: 720,
  /** 缩略图取图方式: app(app://local 协议) | base64(读文件转 data URL) */
  thumbMode: 'app',
  /** 弹窗缩略图尺寸 */
  thumbWidth: 72,
  /** 记住用户手动选的每页数量 */
  lastPageSize: 20,
  /** 文件浏览器排序: off(不接管) | prefix(编号分层) | byte(纯逐字节) */
  explorerSort: 'prefix',
};

// ─── 通用小工具 ──────────────────────────────────────────────────────────

/**
 * 去掉表头里的类型标注, 只留列名。
 *
 * @param {string} header 表头原文, 例如 `主-正词(TEXT)`
 * @returns {string} 列名, 例如 `主-正词`
 */
function stripType(header) {
  return String(header || '').replace(/\([^()]*\)\s*$/, '').trim();
}

/**
 * 取出表头括号里的类型名。
 *
 * @param {string} header 表头原文, 例如 `主-正词(TEXT)`
 * @returns {string} 大写类型名; 没有标注时返回空串
 */
function colType(header) {
  const m = /\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*$/.exec(String(header || ''));
  return m ? m[1].toUpperCase() : '';
}

/**
 * 把一行 markdown 表格切成单元格, 并记下每格在行内的字符区间。
 *
 * 之所以要区间而不只是文本, 是为了保存时只替换目标单元格那一段字符,
 * 同行其它单元格的原始写法(空格/对齐)一个字符都不会被改动。
 * 同时正确跳过 `\|` 这种转义竖线, 不会把一格误切成两格。
 *
 * @param {string} line 表格行原文
 * @returns {Array<{text: string, start: number, end: number}>} 单元格数组;
 *          第 0 项是行首 `|` 之前的内容(通常为空串), 因此第 i 列对应下标 i+1
 */
function splitCells(line) {
  const src = String(line || '');
  const out = [];
  let text = '';
  let start = -1;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\\' && src[i + 1] === '|') {
      if (start < 0) start = i;
      text += '\\|';
      i++;
      continue;
    }
    if (src[i] === '|') {
      const head = start < 0 ? i : start;
      out.push({ text, start: head, end: head + text.length });
      text = '';
      start = -1;
      continue;
    }
    if (start < 0) start = i;
    text += src[i];
  }
  const head = start < 0 ? src.length : start;
  out.push({ text, start: head, end: head + text.length });
  return out;
}

/**
 * 把源文本按字面 `<br>` 切段, 供单元格重建显示时使用。
 *
 * 源码里的 `<br>` 是硬换行, 重建 DOM 时必须还原成 `<br>` 元素(再靠 CSS 隐藏),
 * 这样 DOM 与源码始终一致; `\|` 是表格里的转义竖线, 显示时还原成 `|`。
 *
 * @param {string} text 源文本
 * @returns {Array<{br: boolean, text: string}>} 段数组; br 为 true 表示该段之前有一个换行
 */
function splitBrText(text) {
  const parts = String(text == null ? '' : text).split(/<br\s*\/?>/i);
  return parts.map((seg, i) => ({ br: i > 0, text: seg.replace(/\\\|/g, '|') }));
}

/**
 * 弹窗显示用: 把源码里的 `<br>` 换成**真实换行**, 让编辑框按段落行。
 *
 * 只认 `<br>` 这一个标签(`<br>` / `<br/>` / `<br />` / 大小写混写都算),
 * 写成别的 HTML 一律当普通文字原样显示 —— 单元格里除了 `<br>` 没有别的标签。
 *
 * @param {string} text 单元格源文本
 * @returns {string} 换行已还原成 `\n` 的文本
 */
function brToNewline(text) {
  return String(text == null ? '' : text).replace(/<br\s*\/?>/gi, '\n');
}

/**
 * 保存用: 把真实换行换回源码里的 `<br>`, 保证单元格仍是**单行**、表格形状不变。
 *
 * 先归一 CRLF/CR(粘贴进来的内容可能带 `\r`), 再统一写成小写无斜杠的 `<br>`;
 * 除换行以外一个字符都不动。
 *
 * @param {string} text 编辑框里的文本
 * @returns {string} 可回写进单元格的文本
 */
function newlineToBr(text) {
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/\n/g, '<br>');
}

/**
 * 提取 ID 的排序键: 取开头的数字段。
 *
 * @param {string} text 单元格文本, 例如 `00011-插入项`
 * @returns {number} 数值键; 无数字时排到最后
 */
function idKey(text) {
  const m = /^\s*(\d+)/.exec(String(text || ''));
  return m ? Number.parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

/**
 * 取小写扩展名(不含点)。
 *
 * @param {string} name 文件名
 * @returns {string} 小写扩展名; 无扩展名时为空串
 */
function extOf(name) {
  const i = String(name).lastIndexOf('.');
  return i < 0 ? '' : String(name).slice(i + 1).toLowerCase();
}

/**
 * 去掉扩展名。
 *
 * @param {string} name 文件名
 * @returns {string} 不含扩展名的名字
 */
function stemOf(name) {
  const i = String(name).lastIndexOf('.');
  return i <= 0 ? String(name) : String(name).slice(0, i);
}

/**
 * 判断文件属于图片 / 视频 / 音频 / 其它。
 *
 * @param {string} name 文件名
 * @returns {'image'|'video'|'audio'|'other'} 类别
 */
function kindOf(name) {
  const e = extOf(name);
  if (IMAGE_EXT.has(e)) return 'image';
  if (VIDEO_EXT.has(e)) return 'video';
  if (AUDIO_EXT.has(e)) return 'audio';
  return 'other';
}

/**
 * 人类可读的文件大小。
 *
 * @param {number} n 字节数
 * @returns {string} 例如 `1.3 MB`
 */
function fmtSize(n) {
  if (!Number.isFinite(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${u[i]}`;
}

// ─── @ 文件浏览弹窗 ──────────────────────────────────────────────────────

class ComfyFileModal extends Modal {
  /**
   * @param {import('obsidian').App} app Obsidian app
   * @param {object} opts 选项
   * @param {string} opts.root 根目录绝对路径
   * @param {string} opts.thumbMode `app` 或 `base64`
   * @param {number} opts.thumbWidth 缩略图宽度
   * @param {string} [opts.title] 弹窗标题; 省略时用默认标题
   * @param {(text: string) => void} opts.onPick 确定回调, 收到 `@{...}`
   */
  constructor(app, opts) {
    super(app);
    this.root = opts.root;
    this.thumbMode = opts.thumbMode;
    this.thumbWidth = opts.thumbWidth;
    this.modalTitle = opts.title || '插入 output 资源引用';
    this.onPick = opts.onPick;

    /** 当前所在子目录名; 空串表示根目录 */
    this.sub = '';
    /** 当前高亮的条目 */
    this.picked = null;
    /** 过滤词 */
    this.filter = '';
  }

  /**
   * 打开时构建界面。
   *
   * @returns {void}
   */
  onOpen() {
    this.modalEl.addClass('oc-modal');
    this.titleEl.setText(this.modalTitle);
    this.render();
  }

  /**
   * 关闭时清空。
   *
   * @returns {void}
   */
  onClose() {
    this.contentEl.empty();
  }

  /**
   * 列出当前目录下的条目: 编号子目录 + 普通文件, 均跳过点开头的项。
   *
   * @returns {Array<object>} 条目数组
   */
  listEntries() {
    const dir = this.sub ? path.join(this.root, this.sub) : this.root;
    let raw = [];
    try {
      raw = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const dirs = [];
    const files = [];
    for (const e of raw) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // 只显示「数字-」/「数字_」编号目录(与 ComfyUI 插件侧判据一致)
        if (!this.sub && NUMBERED_DIR_RE.test(e.name)) dirs.push({ name: e.name, isDir: true });
        continue;
      }
      if (!e.isFile()) continue;
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        size = 0;
      }
      files.push({ name: e.name, isDir: false, size });
    }

    dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    return dirs.concat(files);
  }

  /**
   * 过滤条目。
   *
   * @param {Array<object>} entries 全部条目
   * @returns {Array<object>} 命中的条目
   */
  filtered(entries) {
    const q = this.filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((x) => x.name.toLowerCase().includes(q));
  }

  /**
   * 生成 file:// 或 app:// 可用的资源地址。
   *
   * @param {string} abs 绝对路径
   * @returns {string} URL
   */
  resourceUrl(abs) {
    const norm = abs.replace(/\\/g, '/');
    if (this.thumbMode === 'base64') {
      try {
        const buf = fs.readFileSync(abs);
        const ext = extOf(abs);
        const mime = ext === 'png' ? 'image/png'
          : ext === 'webp' ? 'image/webp'
            : ext === 'gif' ? 'image/gif'
              : ext === 'svg' ? 'image/svg+xml'
                : 'image/jpeg';
        return `data:${mime};base64,${buf.toString('base64')}`;
      } catch {
        return '';
      }
    }
    return `app://local/${encodeURI(norm)}`;
  }

  /**
   * 渲染整个弹窗内容(重建 DOM)。
   *
   * @returns {void}
   */
  render() {
    const { contentEl } = this;
    contentEl.empty();

    // 面包屑
    const crumbs = contentEl.createDiv({ cls: 'oc-crumbs' });
    crumbs.createSpan({ text: 'output' });
    if (this.sub) {
      crumbs.createSpan({ text: ' / ' });
      crumbs.createSpan({ text: this.sub });
      const back = crumbs.createEl('a', { text: '  ← 返回根目录' });
      back.onclick = () => {
        this.sub = '';
        this.picked = null;
        this.filter = '';
        this.render();
      };
    }

    // 过滤框
    const filterInput = contentEl.createEl('input', { cls: 'oc-filter', type: 'text' });
    filterInput.placeholder = '过滤文件名…';
    filterInput.value = this.filter;
    filterInput.oninput = () => {
      this.filter = filterInput.value;
      this.renderList();
    };
    window.setTimeout(() => filterInput.focus(), 0);

    // 列表容器
    this.listEl = contentEl.createDiv({ cls: 'oc-list' });
    this.renderList();

    // 结果预览
    this.resultEl = contentEl.createDiv({ cls: 'oc-result' });
    this.updateResult();

    // 按钮行
    const btns = contentEl.createDiv({ cls: 'modal-button-container' });
    const ok = btns.createEl('button', { text: '确定', cls: 'mod-cta' });
    ok.onclick = () => this.confirm();
    const cancel = btns.createEl('button', { text: '取消' });
    cancel.onclick = () => this.close();

    contentEl.createDiv({
      cls: 'oc-hint',
      text: '只列出普通文件与「数字-」/「数字_」编号目录; 目录内选中文件后可再返回上一级。',
    });
  }

  /**
   * 渲染列表区域。
   *
   * @returns {void}
   */
  renderList() {
    if (!this.listEl) return;
    this.listEl.empty();

    if (!this.root) {
      this.listEl.createDiv({ cls: 'oc-empty', text: '未配置 output 目录, 请到插件设置里填写。' });
      return;
    }

    const entries = this.filtered(this.listEntries());
    if (entries.length === 0) {
      this.listEl.createDiv({ cls: 'oc-empty', text: '没有匹配的条目。' });
      return;
    }

    for (const e of entries) {
      const row = this.listEl.createDiv({ cls: 'oc-row' });
      if (this.picked && this.picked.name === e.name && this.picked.isDir === e.isDir) {
        row.addClass('is-selected');
      }

      this.buildThumb(row, e);

      const meta = row.createDiv({ cls: 'oc-meta' });
      meta.createDiv({ cls: 'oc-name', text: e.name });
      if (e.isDir) {
        meta.createDiv({ cls: 'oc-sub', text: '目录 · 点击进入' });
      } else {
        const k = kindOf(e.name);
        const label = k === 'image' ? '图片' : k === 'video' ? '视频' : k === 'audio' ? '音频' : '文件';
        meta.createDiv({ cls: 'oc-sub', text: `${label} · ${fmtSize(e.size)}` });
      }

      if (e.isDir) {
        row.createSpan({ cls: 'oc-kind', text: 'DIR' });
      } else {
        row.createSpan({ cls: 'oc-kind', text: extOf(e.name).toUpperCase() || 'FILE' });
      }

      row.onclick = () => {
        if (e.isDir) {
          this.sub = e.name;
          this.picked = null;
          this.filter = '';
          this.render();
          return;
        }
        this.picked = e;
        this.renderList();
        this.updateResult();
      };

      // 双击直接确定
      row.ondblclick = () => {
        if (e.isDir) return;
        this.picked = e;
        this.confirm();
      };
    }
  }

  /**
   * 构建左侧缩略图: 图片走 <img>, 视频走 <video>, 音频与其它走图标。
   *
   * @param {HTMLElement} row 行元素
   * @param {object} e 条目
   * @returns {void}
   */
  buildThumb(row, e) {
    const box = row.createDiv({ cls: 'oc-thumb' });
    box.style.width = `${this.thumbWidth}px`;

    if (e.isDir) {
      box.createSpan({ cls: 'oc-icon', text: '📁' });
      return;
    }

    const abs = path.join(this.sub ? path.join(this.root, this.sub) : this.root, e.name);
    const k = kindOf(e.name);

    if (k === 'image') {
      const url = this.resourceUrl(abs);
      if (!url) {
        box.createSpan({ cls: 'oc-icon', text: '🖼' });
        return;
      }
      const img = box.createEl('img');
      img.src = url;
      img.loading = 'lazy';
      img.onerror = () => {
        box.empty();
        box.createSpan({ cls: 'oc-icon', text: '🖼' });
      };
      return;
    }

    if (k === 'video') {
      const v = box.createEl('video');
      v.src = `app://local/${encodeURI(abs.replace(/\\/g, '/'))}`;
      v.muted = true;
      v.preload = 'metadata';
      v.ondblclick = (ev) => ev.stopPropagation();
      v.onerror = () => {
        box.empty();
        box.createSpan({ cls: 'oc-icon', text: '🎬' });
      };
      return;
    }

    if (k === 'audio') {
      box.createSpan({ cls: 'oc-icon', text: '🎵' });
      return;
    }

    box.createSpan({ cls: 'oc-icon', text: '📄' });
  }

  /**
   * 计算当前选中项对应的引用文本。
   *
   * @returns {string} 例如 `@{0040_文生视频/video}`; 未选中时为空串
   */
  currentRef() {
    if (!this.picked) return '';
    const stem = stemOf(this.picked.name);
    return this.sub ? `@{${this.sub}/${stem}}` : `@{${stem}}`;
  }

  /**
   * 刷新底部的结果预览。
   *
   * @returns {void}
   */
  updateResult() {
    if (!this.resultEl) return;
    const ref = this.currentRef();
    this.resultEl.setText(ref ? `将插入: ${ref}` : '请选择一个文件');
  }

  /**
   * 确定: 回调插入文本并关闭。
   *
   * @returns {void}
   */
  confirm() {
    const ref = this.currentRef();
    if (!ref) {
      new Notice('请先选择一个文件');
      return;
    }
    this.onPick(ref);
    this.close();
  }
}

// ─── TEXT 单元格编辑器 ──────────────────────────────────────────────────

/**
 * 在文件全文里定位某个 ID 那一行的第 colIdx 个单元格。
 *
 * 返回的是该单元格内容在全文中的**绝对字符区间**, 保存时只替换这一段,
 * 因此同一行其它单元格、表格其它行、文件里任何别的内容都不会被改动。
 * 每次写盘前重新定位一次, 即使弹窗开着时文件被别处改过也不会写错位置。
 *
 * @param {string} data 文件全文
 * @param {string} idText 目标行的 ID 列文本
 * @param {number} colIdx 目标列下标(0 为 ID 列)
 * @returns {{start: number, end: number, text: string}|null} 命中区间; 未命中为 null
 */
function locateCell(data, idText, colIdx) {
  const src = String(data || '');
  const want = String(idText || '').trim();
  if (!want || colIdx < 1) return null;

  const lines = src.split('\n');
  let offset = 0;
  for (const line of lines) {
    if (line.trim().startsWith('|')) {
      const cells = splitCells(line);
      // cells[0] 是行首 `|` 之前的内容, 所以第 i 列是 cells[i + 1]
      if (cells.length > colIdx + 1 && cells[1].text.trim() === want) {
        const cell = cells[colIdx + 1];
        return { start: offset + cell.start, end: offset + cell.end, text: cell.text };
      }
    }
    offset += line.length + 1; // +1 为换行符
  }
  return null;
}

/**
 * 双击 TEXT 单元格弹出的编辑器。
 *
 * 显示与保存走同一套 `<br>` 约定: 源码单元格里的 `<br>` 在编辑框里渲染成
 * **真实换行**(编辑、粘贴都按行来), 保存时再把换行换回 `<br>` 写回源文件。
 * 于是编辑框所见即段落, 而磁盘上的单元格永远是单行、不破坏表格形状。
 *
 * 只负责查看与编辑, 不碰文件; 写回交给回调做区间替换。
 */
class ComfyTextModal extends Modal {
  /**
   * @param {App} app Obsidian App
   * @param {object} opts 配置项
   * @param {string} opts.title 标题(通常是 `ID · 列名`)
   * @param {string} opts.value 单元格原文(带字面 `<br>`)
   * @param {(next: string) => Promise<void>} opts.onSave 保存回调
   */
  constructor(app, opts) {
    super(app);
    this.opts = opts;
    this.saving = false;
    /** 单元格原文, 保存时用来判断内容有没有真的改过 */
    this.raw = String(opts.value == null ? '' : opts.value);
    /** 编辑框初值: `<br>` 已还原成真实换行 */
    this.display = brToNewline(this.raw);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('oc-text-modal');

    contentEl.createEl('div', { cls: 'oc-text-head', text: this.opts.title });
    contentEl.createEl('div', {
      cls: 'oc-text-sub',
      text: '只替换这一个单元格, 不动其它数据。直接回车换行, 保存时自动转成 <br>; Ctrl/Cmd+Enter 保存。',
    });

    const area = contentEl.createEl('textarea', { cls: 'oc-text-area' });
    area.value = this.display;
    area.spellcheck = false;

    const bar = contentEl.createDiv({ cls: 'oc-text-bar' });
    bar.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
    bar.createEl('button', { text: '保存', cls: 'mod-cta' })
      .addEventListener('click', () => this.doSave(area.value));

    area.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        this.doSave(area.value);
      }
    });

    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }

  onClose() {
    this.contentEl.empty();
  }

  /**
   * 保存: 换行转回 `<br>` 后与原文件内容比对, 内容未变则直接关闭, 变了才回调写盘。
   *
   * @param {string} next 编辑框当前内容(真实换行)
   * @returns {Promise<void>}
   */
  async doSave(next) {
    if (this.saving) return;
    const text = newlineToBr(next);
    if (text === this.raw) {
      this.close();
      return;
    }
    this.saving = true;
    try {
      await this.opts.onSave(text);
    } finally {
      this.saving = false;
      this.close();
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ─── 引用原文还原 ────────────────────────────────────────────────────────

/**
 * `@{表名_编号/行ID_名称}` 整格引用天然带两个下划线, 而 Obsidian 的 Markdown 解析会把
 * 它们当成强调字符对: 阅读视图与编辑模式的实时渲染都会输出去掉下划线的文本, 并把中间
 * 那段变成 `<em>` 斜体(它判定「词内下划线」时只认 ASCII 词字符, 下划线紧挨中文就失效,
 * 属其已知问题; md 源码一个字节没动, 坏的只是显示)。
 *
 * 这里按固定约定 `@{(数字)(名字)/(数字)(名字)}` 把下划线补回: 只把那个 `<em>` 换回字面
 * 文本 `_内容_`, 单元格其余子节点一个不动; 已经渲染正确(或下划线本来就在)的格子直接跳过,
 * 因此可重复执行, 也不会误伤真正用 `_` 写的强调文本。
 *
 * @param {HTMLElement} root 后处理器拿到的元素
 * @returns {number} 实际修复的单元格个数
 */
function restoreRefText(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0;

  // 阅读视图: root 是包含整个 table 的块 → 逐个单元格处理;
  // 实时预览: Obsidian 的表格 widget 对每个单元格各跑一次后处理器, root 就是单元格内的
  // `.table-cell-wrapper`(不含 td) → root 本身即目标
  const cells = Array.from(root.querySelectorAll('td, th'));
  const targets = cells.length > 0 ? cells : [root];

  let fixed = 0;
  for (const cell of targets) {
    const flat = (cell.textContent || '').trim();
    const m = REF_TEXT_RE.exec(flat);
    // 两侧都必须「有名字、但下划线不见了」才是被强调吃掉; 否则保持原样
    if (!m || !m[2] || !m[4]) continue;
    if (m[2].startsWith('_') || m[4].startsWith('_')) continue;
    const ems = cell.querySelectorAll('em');
    if (ems.length !== 1) continue;
    const em = ems[0];
    const doc = cell.ownerDocument || document;
    em.replaceWith(doc.createTextNode('_' + em.textContent + '_'));
    fixed += 1;
  }
  return fixed;
}

// ─── 表格增强 ────────────────────────────────────────────────────────────

class ComfyTableChild extends MarkdownRenderChild {
  /**
   * @param {HTMLElement} containerEl 表格所在容器
   * @param {HTMLElement} table 原始 table 元素
   * @param {object} plugin 插件实例
   * @param {MarkdownPostProcessorContext} ctx 渲染上下文(用于取源文件路径)
   */
  constructor(containerEl, table, plugin, ctx) {
    super(containerEl);
    this.table = table;
    this.plugin = plugin;
    /** 渲染上下文 */
    this.ctx = ctx || null;
    /** 源文件路径: 双击编辑后要写回这个文件 */
    this.sourcePath = ctx && ctx.sourcePath ? ctx.sourcePath : '';

    /** 表头列名(已去类型标注) */
    this.headers = [];
    /** 各列类型(大写) */
    this.types = [];
    /** tbody 行快照 */
    this.rows = [];

    this.query = '';
    this.sortDir = 'asc';
    this.page = 1;
    this.pageSize = plugin.settings.lastPageSize || plugin.settings.defaultPageSize;
  }

  /**
   * 挂载: 解析表格 → 重排 DOM → 绑定交互。
   *
   * @returns {void}
   */
  onload() {
    const headRow = this.table.querySelector('thead tr') || this.table.querySelector('tr');
    if (!headRow) return;

    this.headers = Array.from(headRow.children).map((th) => stripType(th.textContent || ''));
    this.types = Array.from(headRow.children).map((th) => colType(th.textContent || ''));
    if (this.headers.length < 2) return;

    // 第一列必须是 ID 才接管
    if (this.headers[0].toLowerCase() !== 'id') return;

    const body = this.table.querySelector('tbody') || this.table;
    this.rows = Array.from(body.querySelectorAll('tr')).filter((tr) => tr !== headRow);
    if (this.rows.length === 0) return;

    this.applyCellClasses(headRow);
    this.buildShell(headRow);
    this.bindEdit();
    this.apply();
  }

  /**
   * 绑定数据格双击 → 按列类型分派到对应编辑器。
   *
   * 走事件委托挂在容器上, 这样排序、分页、搜索重排行之后依然有效。
   * 用 `td.oc-cell` 而不是内层裁剪容器定位, 所以空单元格也能双击。
   *
   * @returns {void}
   */
  bindEdit() {
    this.registerDomEvent(this.containerEl, 'dblclick', (ev) => {
      const td = ev.target && ev.target.closest ? ev.target.closest('td.oc-cell') : null;
      if (!td) return;
      // 正在就地编辑的格子不重入
      if (td.querySelector('.oc-cell-input')) return;
      const tr = td.closest('tr');
      if (!tr) return;
      const cells = Array.from(tr.children);
      const colIdx = cells.indexOf(td);
      if (colIdx < 1 || !cells[0]) return; // 第 0 列是 ID, 不可编辑
      ev.preventDefault();
      ev.stopPropagation();
      this.editCell(cells[0].textContent.trim(), colIdx, td);
    });
  }

  /**
   * 按该列声明的类型选择编辑器。
   *
   * IMAGE/VIDEO/AUDIO/MASK 走文件浏览器写 `@{...}`; INT/FLOAT 就地换输入框;
   * 其余(含省略类型的 STRING、以及 TEXT)一律弹多行文本编辑器。
   *
   * @param {string} idText 目标行 ID
   * @param {number} colIdx 目标列下标
   * @param {HTMLElement} td 被双击的单元格
   * @returns {void}
   */
  editCell(idText, colIdx, td) {
    const type = this.types[colIdx] || 'STRING';
    if (REF_TYPES.has(type)) {
      this.pickRef(idText, colIdx);
      return;
    }
    if (NUM_TYPES.has(type)) {
      this.editNumber(idText, colIdx, td, type);
      return;
    }
    this.openTextEditor(idText, colIdx);
  }

  /**
   * IMAGE / VIDEO / AUDIO / MASK 列: 弹与 `@` 相同的文件浏览器, 选中即写回 `@{...}`。
   *
   * @param {string} idText 目标行 ID
   * @param {number} colIdx 目标列下标
   * @returns {void}
   */
  pickRef(idText, colIdx) {
    const label = `${idText} · ${this.headers[colIdx] || ''}`;
    this.plugin.openBrowser(
      (ref) => this.writeCell(idText, colIdx, ref, label),
      `选择引用 · ${label}`,
    );
  }

  /**
   * INT / FLOAT 列: 把静态文本就地换成输入框, 失焦或回车时写回。
   *
   * 初值只认源文件(与 TEXT 一样, 不认已被渲染处理过的 DOM)。内容没改、
   * 按 Esc、或数值不合法时只还原显示, 一个字节都不写盘。
   *
   * @param {string} idText 目标行 ID
   * @param {number} colIdx 目标列下标
   * @param {HTMLElement} td 被双击的单元格
   * @param {string} type `INT` 或 `FLOAT`
   * @returns {Promise<void>}
   */
  async editNumber(idText, colIdx, td, type) {
    const file = this.plugin.app.vault.getFileByPath(this.sourcePath);
    if (!file) {
      new Notice('找不到源文件, 无法编辑');
      return;
    }
    const data = await this.plugin.app.vault.read(file);
    const hit = locateCell(data, idText, colIdx);
    if (!hit) {
      new Notice(`源文件里没定位到 ${idText} 的这一列`);
      return;
    }

    const original = hit.text.trim();
    const clip = td.querySelector('.oc-clip') || td;
    clip.empty();

    const input = document.createElement('input');
    input.addClass('oc-cell-input');
    input.type = 'text';
    input.inputMode = type === 'INT' ? 'numeric' : 'decimal';
    input.spellcheck = false;
    input.value = original;
    clip.appendChild(input);
    input.focus();
    input.select();

    let settled = false;
    const finish = (commit) => {
      if (settled) return;
      settled = true;
      const next = input.value.trim();
      if (!commit || next === original) {
        this.setCellDisplay(td, original);
        return;
      }
      if (!this.validNumber(next, type)) {
        new Notice(`${type} 列需要${type === 'INT' ? '整数' : '数字'}: ${next}`);
        this.setCellDisplay(td, original);
        return;
      }
      this.setCellDisplay(td, next);
      this.writeCell(idText, colIdx, next, `${idText} · ${this.headers[colIdx] || ''}`);
    };

    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        finish(true);
        return;
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        finish(false);
      }
    });
  }

  /**
   * 校验数值列的新值; 空串视为清空该格。
   *
   * @param {string} text 待校验文本
   * @param {string} type `INT` 或 `FLOAT`
   * @returns {boolean} 是否合法
   */
  validNumber(text, type) {
    if (text === '') return true;
    if (type === 'INT') return /^[+-]?\d+$/.test(text);
    return Number.isFinite(Number(text));
  }

  /**
   * 用一段源文本重建单元格的显示。
   *
   * 写盘后表格 DOM 不会自己跟着变, 所以保存完要手动同步这一格。
   * 重建规则与 wrapClip 一致: 源码里的字面 `<br>` 还原成 `<br>` 元素并隐藏,
   * 渲染结果因此仍是单行; `\|` 还原成普通竖线。
   *
   * @param {HTMLElement} td 目标单元格
   * @param {string} text 源文本
   * @returns {void}
   */
  setCellDisplay(td, text) {
    const clip = td.querySelector('.oc-clip') || td;
    clip.empty();
    for (const seg of splitBrText(text)) {
      if (seg.br) {
        clip.appendChild(document.createTextNode(' '));
        const br = document.createElement('br');
        br.addClass('oc-br-hidden');
        clip.appendChild(br);
      }
      if (seg.text) clip.appendChild(document.createTextNode(seg.text));
    }
  }

  /**
   * 读出该单元格的**源文本**, 弹窗展示。
   *
   * 特意从文件重新读, 而不是用 DOM 文本: DOM 里的 <br> 已被渲染处理过,
   * 只有源文本才是保存时该回写的那一份。
   *
   * @param {string} idText 目标行 ID
   * @param {number} colIdx 目标列下标
   * @returns {Promise<void>}
   */
  async openTextEditor(idText, colIdx) {
    const file = this.plugin.app.vault.getFileByPath(this.sourcePath);
    if (!file) {
      new Notice('找不到源文件, 无法编辑');
      return;
    }
    const data = await this.plugin.app.vault.read(file);
    const hit = locateCell(data, idText, colIdx);
    if (!hit) {
      new Notice(`源文件里没定位到 ${idText} 的这一列`);
      return;
    }
    const label = `${idText} · ${this.headers[colIdx] || ''}`;
    new ComfyTextModal(this.plugin.app, {
      title: label,
      value: hit.text.trim(),
      onSave: (next) => this.writeCell(idText, colIdx, next, label),
    }).open();
  }

  /**
   * 写回: 只替换该单元格那一段字符, 其余内容一个字节都不动。
   *
   * 用 vault.process 做原子读改写, 并在回调内**重新定位**一次,
   * 免得弹窗开着期间文件被别处改动而写错位置。
   *
   * @param {string} idText 目标行 ID
   * @param {number} colIdx 目标列下标
   * @param {string} next 新内容
   * @param {string} [label] 提示里显示的名字; 省略时用 ID
   * @returns {Promise<void>}
   */
  async writeCell(idText, colIdx, next, label) {
    const file = this.plugin.app.vault.getFileByPath(this.sourcePath);
    if (!file) {
      new Notice('找不到源文件, 保存失败');
      return;
    }
    let done = false;
    await this.plugin.app.vault.process(file, (data) => {
      const hit = locateCell(data, idText, colIdx);
      if (!hit) return data;
      // 沿用该格原有的首尾空白写法, 保持表格对齐风格不变
      const lead = /^\s*/.exec(hit.text)[0];
      const tail = /\s*$/.exec(hit.text)[0];
      done = true;
      return data.slice(0, hit.start) + lead + next + tail + data.slice(hit.end);
    });
    const who = label || idText;
    new Notice(done ? `已保存 ${who}` : `保存失败: 没定位到 ${who}`);
  }

  /**
   * 给表头与单元格打类名: ID 列可排序, TEXT 列走省略号截断。
   *
   * @param {HTMLElement} headRow 表头行
   * @returns {void}
   */
  applyCellClasses(headRow) {
    Array.from(headRow.children).forEach((th, i) => {
      if (i === 0) th.addClass('oc-th-id');
    });
    for (const tr of this.rows) {
      Array.from(tr.children).forEach((td, i) => {
        if (i === 0) {
          td.addClass('oc-td-id');
          return;
        }
        const type = this.types[i] || 'STRING';
        const isText = type === 'TEXT';
        // oc-cell 是双击编辑的定位锚点: 空单元格没有内层容器, 只能靠它命中
        td.addClass('oc-cell');
        td.addClass(isText ? 'oc-cell-text' : 'oc-cell-other');
        if (REF_TYPES.has(type)) td.addClass('oc-cell-ref');
        if (NUM_TYPES.has(type)) td.addClass('oc-cell-num');
        this.wrapClip(td, isText);
      });
    }
  }

  /**
   * 在单元格内容外包一层裁剪容器。
   *
   * td 自身的 max-width 在 table-layout:auto 下不生效, 只有包一层块级元素
   * 才能让 max-width + text-overflow:ellipsis 可靠截断。
   *
   * @param {HTMLElement} td 单元格
   * @param {boolean} isText 是否为 TEXT 类型列
   * @returns {void}
   */
  wrapClip(td, isText) {
    // 源 md 的 TEXT 单元格用 <br> 分隔多段文字。 <br> 是硬换行, white-space:nowrap
    // 管不了它, 单元格会照旧撑成多行。 这里保留 <br> 本身(源码与 DOM 都不动它),
    // 只在它前面补一个空格、并打上隐藏类, 于是渲染结果摊平成一行, 截断交给上面的省略号。
    for (const br of Array.from(td.querySelectorAll('br'))) {
      br.before(document.createTextNode(' '));
      br.addClass('oc-br-hidden');
    }
    const box = document.createElement('div');
    box.addClass('oc-clip');
    box.addClass(isText ? 'oc-clip-text' : 'oc-clip-other');
    while (td.firstChild) box.appendChild(td.firstChild);
    td.appendChild(box);
  }

  /**
   * 用 工具条 + 滚动容器 + 分页条 三层结构包住原表格。
   *
   * @param {HTMLElement} headRow 表头行
   * @returns {void}
   */
  buildShell(headRow) {
    const block = document.createElement('div');
    block.addClass('oc-table-block');

    const toolbar = document.createElement('div');
    toolbar.addClass('oc-toolbar');

    // 工具栏: 搜索框 + 排序按钮 + 计数
    const search = document.createElement('input');
    search.addClass('oc-search');
    search.type = 'text';
    search.placeholder = '搜索(ID 或任意字段)…';
    search.value = this.query;
    search.oninput = () => {
      this.query = search.value;
      this.page = 1;
      this.apply();
    };
    toolbar.appendChild(search);

    const sortBtn = document.createElement('button');
    sortBtn.addClass('oc-sort-btn');
    sortBtn.onclick = () => this.toggleSort();
    toolbar.appendChild(sortBtn);
    this.sortBtn = sortBtn;

    this.countEl = document.createElement('span');
    this.countEl.addClass('oc-count');
    toolbar.appendChild(this.countEl);

    const scroll = document.createElement('div');
    scroll.addClass('oc-table-scroll');

    const pager = document.createElement('div');
    pager.addClass('oc-pager');
    this.pagerEl = pager;

    const table = this.table;
    table.parentElement.insertBefore(block, table);
    scroll.appendChild(table);
    block.appendChild(toolbar);
    block.appendChild(scroll);
    block.appendChild(pager);

    // ID 列点击排序: 用事件委托, 避免 Obsidian 重建表格后句柄失效
    scroll.addEventListener('click', (ev) => {
      const t = ev.target;
      if (!(t instanceof Element)) return;
      if (!t.closest('th.oc-th-id')) return;
      this.toggleSort();
    });

    sortBtn.addEventListener('click', () => this.toggleSort());

    // 支持横向滚动: 阻止滚轮冒泡到画布
    scroll.addEventListener('wheel', (ev) => {
      if (ev.deltaX !== 0) ev.stopPropagation();
    }, { passive: true });
  }

  /**
   * 切换 ID 列的升降序。
   *
   * @returns {void}
   */
  toggleSort() {
    this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
    this.page = 1;
    this.apply();
  }

  /**
   * 按当前查询 / 排序 / 分页重算可见行并刷新 UI。
   *
   * @returns {void}
   */
  apply() {
    const q = this.query.trim().toLowerCase();

    // 1) 过滤
    let visible = this.rows.filter((tr) => {
      if (!q) return true;
      return (tr.textContent || '').toLowerCase().includes(q);
    });

    // 2) 排序(仅按 ID 列数字键)
    visible = visible.slice().sort((a, b) => {
      const ka = idKey(a.children[0] ? a.children[0].textContent : '');
      const kb = idKey(b.children[0] ? b.children[0].textContent : '');
      return this.sortDir === 'asc' ? ka - kb : kb - ka;
    });

    // 3) 重排 DOM 顺序: 可见行按排序结果排前, 被过滤掉的行排在后面(它们 display:none)
    const body = this.rows[0].parentElement;
    for (const tr of visible) body.appendChild(tr);
    for (const tr of this.rows) {
      if (!visible.includes(tr)) body.appendChild(tr);
    }

    // 4) 分页切片
    const size = this.pageSize > 0 ? this.pageSize : visible.length || 1;
    const total = visible.length;
    const pages = Math.max(1, Math.ceil(total / size));
    if (this.page > pages) this.page = pages;
    if (this.page < 1) this.page = 1;
    const start = (this.page - 1) * size;
    const slice = visible.slice(start, start + size);

    // 5) 显隐
    const shown = new Set(slice);
    for (const tr of this.rows) {
      tr.style.display = shown.has(tr) ? '' : 'none';
    }

    // 6) 刷新计数与排序标记
    if (this.countEl) {
      const mark = this.sortDir === 'asc' ? '↑' : '↓';
      this.countEl.setText(`${total} / ${this.rows.length} 行 · ID ${mark}`);
    }
    if (this.sortBtn) {
      this.sortBtn.setText(this.sortDir === 'asc' ? 'ID ↑' : 'ID ↓');
      this.sortBtn.setAttr('title', '点击切换 ID 增序 / 降序');
    }

    this.renderPager(pages, total);
  }

  /**
   * 渲染分页条: 每页数量、首页、上一页、页码、下一页、尾页、跳转。
   *
   * @param {number} pages 总页数
   * @param {number} total 总行数(过滤后)
   * @returns {void}
   */
  renderPager(pages, total) {
    if (!this.pagerEl) return;
    this.pagerEl.empty();

    // 每页数量
    this.pagerEl.createSpan({ text: '每页' });
    const sel = this.pagerEl.createEl('select');
    const sizes = (this.plugin.settings.pageSizes || []).slice();
    sizes.push(0); // 0 = 全部
    for (const s of sizes) {
      const opt = sel.createEl('option', { text: s === 0 ? '全部' : String(s) });
      opt.value = String(s);
      if (s === this.pageSize) opt.selected = true;
    }
    sel.onchange = () => {
      this.pageSize = Number.parseInt(sel.value, 10) || 0;
      this.page = 1;
      this.plugin.settings.lastPageSize = this.pageSize;
      this.plugin.saveSettings();
      this.apply();
    };
    this.pagerEl.createSpan({ text: '条' });

    // 导航按钮
    const mk = (label, target, disabled) => {
      const b = this.pagerEl.createEl('button', { text: label });
      b.disabled = Boolean(disabled);
      b.onclick = () => {
        this.page = target;
        this.apply();
      };
      return b;
    };
    mk('首页', 1, this.page <= 1);
    mk('上一页', this.page - 1, this.page <= 1);

    // 页码(最多 7 个, 两端加省略)
    const nums = pageWindow(this.page, pages, 7);
    for (const n of nums) {
      if (n === '…') {
        this.pagerEl.createSpan({ cls: 'oc-ellipsis', text: '…' });
        continue;
      }
      const b = this.pagerEl.createEl('button', { text: String(n) });
      if (n === this.page) b.addClass('oc-page-active');
      b.onclick = () => {
        this.page = n;
        this.apply();
      };
    }

    mk('下一页', this.page + 1, this.page >= pages);
    mk('尾页', pages, this.page >= pages);

    // 跳转
    this.pagerEl.createSpan({ text: '跳至' });
    const jump = this.pagerEl.createEl('input', { cls: 'oc-jump', type: 'text' });
    jump.value = String(this.page);
    jump.onkeydown = (ev) => {
      if (ev.key !== 'Enter') return;
      const n = Number.parseInt(jump.value, 10);
      if (!Number.isFinite(n)) return;
      this.page = Math.min(Math.max(n, 1), pages);
      this.apply();
    };
    this.pagerEl.createSpan({ text: `/${pages} 页 · 共 ${total} 行` });
  }
}

/**
 * 计算要显示的页码窗口。
 *
 * @param {number} page 当前页
 * @param {number} pages 总页数
 * @param {number} width 最多显示几个
 * @returns {Array<number|'…'>} 页码与省略号序列
 */
function pageWindow(page, pages, width) {
  if (pages <= width) return Array.from({ length: pages }, (_, i) => i + 1);
  const half = Math.floor(width / 2);
  let start = Math.max(1, page - half);
  let end = start + width - 1;
  if (end > pages) {
    end = pages;
    start = end - width + 1;
  }
  const out = [];
  if (start > 1) {
    out.push(1);
    if (start > 2) out.push('…');
  }
  for (let i = start; i <= end; i += 1) out.push(i);
  if (end < pages) {
    if (end < pages - 1) out.push('…');
    out.push(pages);
  }
  return out;
}

// ─── 文件浏览器排序 ──────────────────────────────────────────────────────

/**
 * 逐字节比较两个字符串。
 *
 * JS 的 `<` 用在字符串上就是逐 UTF-16 code unit 比较, 不做数值化处理,
 * 所以 `00110_万物建模2.1` 会排在 `0011_万物建模` 之前
 * (第 5 个字符 `1` = 0x31 小于 `_` = 0x5F)。
 *
 * @param {string} a 左值
 * @param {string} b 右值
 * @returns {number} 负数 / 0 / 正数
 */
function compareByte(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * 编号分层比较: 开头的数字串先按逐字节比较, 相同再比其余部分。
 *
 * 关键在于开头数字串按字符串比而非按数值比:
 * `0011` 是 `00110` 的前缀, 于是 `0011_万物建模` 排在 `00110_万物建模2.1` 之前;
 * 而 `00110` 与 `0012` 在第 4 位就分出 `1` < `2`, 所以 5 位编号恰好插在
 * 它所属的 4 位编号之后、下一个编号之前。这正是故事库
 * 「在编号末尾追加一位数字做中间插入」的编号体系所要求的顺序。
 *
 * @param {string} a 左文件名
 * @param {string} b 右文件名
 * @returns {number} 负数 / 0 / 正数
 */
function compareNumberedName(a, b) {
  const numA = /^\d+/.exec(a);
  const numB = /^\d+/.exec(b);
  if (numA && numB) {
    const byNumber = compareByte(numA[0], numB[0]);
    if (byNumber !== 0) return byNumber;
    return compareByte(a.slice(numA[0].length), b.slice(numB[0].length));
  }
  if (numA) return -1;
  if (numB) return 1;
  return compareByte(a, b);
}

/**
 * 沿原型链找到真正定义某方法的对象, 便于替换后精确还原。
 *
 * @param {object} obj 起始对象
 * @param {string} name 方法名
 * @returns {object|null} 定义该方法的对象; 找不到返回 null
 */
function findMethodOwner(obj, name) {
  let cur = obj;
  while (cur) {
    if (Object.prototype.hasOwnProperty.call(cur, name)) return cur;
    cur = Object.getPrototypeOf(cur);
  }
  return null;
}

// ─── 设置页 ──────────────────────────────────────────────────────────────

class ComfySettingTab extends PluginSettingTab {
  /**
   * @param {import('obsidian').App} app Obsidian app
   * @param {object} plugin 插件实例
   */
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * 渲染设置界面。
   *
   * @returns {void}
   */
  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('output 目录')
      .setDesc('ComfyUI 的 output 目录绝对路径, @ 弹窗浏览的就是这里。')
      .addText((t) => t
        .setValue(this.plugin.settings.outputDir)
        .onChange(async (v) => {
          this.plugin.settings.outputDir = v.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('启用表格增强')
      .setDesc('对第一列是 ID 的 md 表格启用单行渲染、分页、搜索与排序。')
      .addToggle((t) => t
        .setValue(this.plugin.settings.enableTable)
        .onChange(async (v) => {
          this.plugin.settings.enableTable = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('启用 @ 弹窗')
      .setDesc('在编辑器里输入 @ 时弹出 output 目录浏览器。')
      .addToggle((t) => t
        .setValue(this.plugin.settings.enableAtSuggest)
        .onChange(async (v) => {
          this.plugin.settings.enableAtSuggest = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('每页数量可选项')
      .setDesc('逗号分隔, 例如 20,50,100,200')
      .addText((t) => t
        .setValue((this.plugin.settings.pageSizes || []).join(','))
        .onChange(async (v) => {
          const arr = v.split(',')
            .map((s) => Number.parseInt(s.trim(), 10))
            .filter((n) => Number.isFinite(n) && n > 0);
          if (arr.length === 0) return;
          this.plugin.settings.pageSizes = arr;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('默认每页数量')
      .setDesc('0 表示全部')
      .addText((t) => t
        .setValue(String(this.plugin.settings.defaultPageSize))
        .onChange(async (v) => {
          const n = Number.parseInt(v, 10);
          if (!Number.isFinite(n) || n < 0) return;
          this.plugin.settings.defaultPageSize = n;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('TEXT 列最大宽度')
      .setDesc('像素; 超出即用省略号截断(只影响渲染, 不改源码)')
      .addText((t) => t
        .setValue(String(this.plugin.settings.textColMaxWidth))
        .onChange(async (v) => {
          const n = Number.parseInt(v, 10);
          if (!Number.isFinite(n) || n < 60) return;
          this.plugin.settings.textColMaxWidth = n;
          await this.plugin.saveSettings();
          this.applyCssVars();
        }));

    new Setting(containerEl)
      .setName('其它列最大宽度')
      .setDesc('像素; 非 TEXT 列的上限')
      .addText((t) => t
        .setValue(String(this.plugin.settings.otherColMaxWidth))
        .onChange(async (v) => {
          const n = Number.parseInt(v, 10);
          if (!Number.isFinite(n) || n < 60) return;
          this.plugin.settings.otherColMaxWidth = n;
          await this.plugin.saveSettings();
          this.applyCssVars();
        }));

    new Setting(containerEl)
      .setName('文件浏览器排序')
      .setDesc('编号分层: 0011_万物建模 → 00110_万物建模2.1 → 0012_万物变化; 纯逐字节: 只按 UTF-16 码位比文件名')
      .addDropdown((d) => d
        .addOption('prefix', '编号分层(推荐)')
        .addOption('byte', '纯逐字节')
        .addOption('off', '关闭')
        .setValue(this.plugin.settings.explorerSort)
        .onChange(async (v) => {
          this.plugin.settings.explorerSort = v;
          await this.plugin.saveSettings();
          this.plugin.setupExplorerSort();
          this.plugin.refreshExplorerSort();
        }));

    new Setting(containerEl)
      .setName('缩略图取图方式')
      .setDesc('app = app://local 协议(推荐); base64 = 读文件转 data URL(兼容性最好但占内存)')
      .addDropdown((d) => d
        .addOption('app', 'app 协议')
        .addOption('base64', 'base64 内联')
        .setValue(this.plugin.settings.thumbMode)
        .onChange(async (v) => {
          this.plugin.settings.thumbMode = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('弹窗缩略图宽度')
      .setDesc('像素')
      .addText((t) => t
        .setValue(String(this.plugin.settings.thumbWidth))
        .onChange(async (v) => {
          const n = Number.parseInt(v, 10);
          if (!Number.isFinite(n) || n < 24) return;
          this.plugin.settings.thumbWidth = n;
          await this.plugin.saveSettings();
        }));
  }

  /**
   * 把宽度设置写进 CSS 变量。
   *
   * @returns {void}
   */
  applyCssVars() {
    const root = document.body;
    root.style.setProperty('--oc-text-max', `${this.plugin.settings.textColMaxWidth}px`);
    root.style.setProperty('--oc-other-max', `${this.plugin.settings.otherColMaxWidth}px`);
  }
}

// ─── 插件主体 ────────────────────────────────────────────────────────────

class ComfyPlugin extends Plugin {
  /**
   * 加载插件。
   *
   * @returns {Promise<void>} 完成
   */
  async onload() {
    await this.loadSettings();
    this.applyCssVars();

    // 1) 引用原文还原 + 表格增强
    this.registerMarkdownPostProcessor((el, ctx) => {
      // 1a) `@{}` 里的下划线被 Markdown 当强调吃掉(斜体) → 显示层按约定补回;
      //     阅读视图与实时预览的表格单元格都会走到这里, 与「启用表格增强」无关
      restoreRefText(el);

      if (!this.settings.enableTable) return;
      const tables = el.querySelectorAll('table');
      for (const table of Array.from(tables)) {
        const headRow = table.querySelector('thead tr') || table.querySelector('tr');
        if (!headRow) continue;
        const first = stripType(headRow.children[0] ? headRow.children[0].textContent : '');
        if (first.toLowerCase() !== 'id') continue;
        if (table.hasClass('oc-done')) continue;
        table.addClass('oc-done');
        // 交给 ctx 托管, 阅读视图重渲染时会自动卸载
        ctx.addChild(new ComfyTableChild(el, table, this, ctx));
      }
    });

    // 2) @ 弹窗: 借 EditorSuggest.onTrigger 检测, 命中即开自定义 Modal
    this.registerEditorSuggest(new AtTriggerSuggest(this.app, this));

    // 3) 命令
    this.addCommand({
      id: 'open-file-browser',
      name: '打开 output 文件浏览器',
      editorCallback: (editor) => {
        this.openBrowser((ref) => {
          editor.replaceSelection(ref);
        });
      },
    });

    // 4) 设置页
    this.addSettingTab(new ComfySettingTab(this.app, this));

    // 5) 文件浏览器排序; layout 变化时重装, 以防 file-explorer 视图被重建
    this.setupExplorerSort();
    this.registerEvent(this.app.workspace.on('layout-change', () => this.setupExplorerSort()));
  }

  /**
   * 卸载插件。
   *
   * @returns {void}
   */
  onunload() {
    this.teardownExplorerSort();
    // 其余交由 Obsidian 处理已注册资源
  }

  /**
   * 打开文件浏览器弹窗。
   *
   * @param {(ref: string) => void} onPick 选中回调
   * @param {string} [title] 弹窗标题; 省略时用默认标题
   * @returns {void}
   */
  openBrowser(onPick, title) {
    new ComfyFileModal(this.app, {
      root: this.settings.outputDir,
      thumbMode: this.settings.thumbMode,
      thumbWidth: this.settings.thumbWidth,
      title,
      onPick,
    }).open();
  }

  /**
   * 读取设置。
   *
   * @returns {Promise<void>} 完成
   */
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  /**
   * 保存设置。
   *
   * @returns {Promise<void>} 完成
   */
  async saveSettings() {
    await this.saveData(this.settings);
  }

  /**
   * 接管文件浏览器的排序。
   *
   * 替换 FileExplorer 原型上的 `getSortedFolderItems`, 保留 Obsidian 原实现里
   * 「文件夹排在前, 再从 this.fileItems 取回渲染项」的骨架, 只换比较器 ——
   * 于是不依赖 items 的内部结构, 也不需要在视图重建后重新挂载。
   *
   * @returns {void}
   */
  setupExplorerSort() {
    if (this.settings.explorerSort === 'off') {
      this.teardownExplorerSort();
      return;
    }
    const leaf = this.app.workspace.getLeavesOfType('file-explorer')[0];
    const view = leaf && leaf.view;
    if (!view || typeof view.getSortedFolderItems !== 'function') return;

    const owner = findMethodOwner(view, 'getSortedFolderItems');
    if (!owner || owner.__ocOriginalGetSortedFolderItems) return;

    const plugin = this;
    owner.__ocOriginalGetSortedFolderItems = owner.getSortedFolderItems;
    owner.getSortedFolderItems = function (folder) {
      if (!folder || !Array.isArray(folder.children)) {
        return owner.__ocOriginalGetSortedFolderItems.call(this, folder);
      }
      const byName = plugin.settings.explorerSort === 'byte'
        ? (x, y) => compareByte(x.name, y.name)
        : (x, y) => compareNumberedName(x.name, y.name);
      const children = folder.children.slice().sort((x, y) => {
        const xFolder = x instanceof obsidian.TFolder;
        const yFolder = y instanceof obsidian.TFolder;
        if (xFolder !== yFolder) return xFolder ? -1 : 1;
        return byName(x, y);
      });
      const items = [];
      for (const entry of children) {
        const item = this.fileItems[entry.path];
        if (item) items.push(item);
      }
      return items;
    };
    this.explorerSortOwner = owner;
  }

  /**
   * 还原文件浏览器排序, 把原型方法换回去。
   *
   * @returns {void}
   */
  teardownExplorerSort() {
    const owner = this.explorerSortOwner;
    if (!owner || !owner.__ocOriginalGetSortedFolderItems) return;
    owner.getSortedFolderItems = owner.__ocOriginalGetSortedFolderItems;
    delete owner.__ocOriginalGetSortedFolderItems;
    this.explorerSortOwner = null;
  }

  /**
   * 让文件浏览器按当前设置立刻重排。
   *
   * @returns {void}
   */
  refreshExplorerSort() {
    for (const leaf of this.app.workspace.getLeavesOfType('file-explorer')) {
      if (leaf.view && typeof leaf.view.requestSort === 'function') leaf.view.requestSort();
    }
  }

  /**
   * 应用 CSS 变量。
   *
   * @returns {void}
   */
  applyCssVars() {
    document.body.style.setProperty('--oc-text-max', `${this.settings.textColMaxWidth}px`);
    document.body.style.setProperty('--oc-other-max', `${this.settings.otherColMaxWidth}px`);
  }
}

// ─── @ 触发检测 ──────────────────────────────────────────────────────────

/**
 * 用 EditorSuggest 的触发钩子检测 `@`, 命中即打开文件浏览器并返回 null(不显示候选列表)。
 */
class AtTriggerSuggest extends obsidian.EditorSuggest {
  /**
   * @param {import('obsidian').App} app Obsidian app
   * @param {ComfyPlugin} plugin 插件实例
   */
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    /** 防止一次按键触发多个弹窗 */
    this._armed = true;
  }

  /**
   * 判断是否该触发。
   *
   * @param {import('obsidian').EditorPosition} cursor 光标
   * @param {import('obsidian').Editor} editor 编辑器
   * @returns {null} 始终返回 null: 弹窗由这里直接打开, 不用候选列表
   */
  onTrigger(cursor, editor) {
    if (!this.plugin.settings.enableAtSuggest) return null;

    const line = editor.getLine(cursor.line) || '';
    const before = line.slice(0, cursor.ch);

    // 只在刚敲下 @ 时触发: @ 前面不是 @ 或 {, 且 @ 后没有内容
    if (!before.endsWith('@')) return null;
    const prev = before.slice(0, -1);
    if (prev.endsWith('@') || prev.endsWith('{') || prev.endsWith('\\')) return null;

    if (!this._armed) return null;
    this._armed = false;
    window.setTimeout(() => {
      this._armed = true;
    }, 300);

    // 稍后打开, 避免与编辑器当前按键处理抢占
    window.setTimeout(() => {
      this.plugin.openBrowser((ref) => {
        editor.replaceRange(ref, { line: cursor.line, ch: cursor.ch - 1 }, cursor);
      });
    }, 0);

    return null;
  }

  /**
   * 未使用: onTrigger 始终返回 null。
   *
   * @returns {Array} 空数组
   */
  getSuggestions() {
    return [];
  }

  /**
   * 未使用。
   *
   * @returns {void}
   */
  renderSuggestion() {}

  /**
   * 未使用。
   *
   * @returns {void}
   */
  selectSuggestion() {}
}

module.exports = ComfyPlugin;
