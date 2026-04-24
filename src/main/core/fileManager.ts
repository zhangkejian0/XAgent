// ═══════════════════════════════════════════════════════════════
//  生成文件管理系统
//  - 目录结构规范
//  - 文件追踪 (manifest.json)
//  - 分类路由
//  - 清理功能
// ═══════════════════════════════════════════════════════════════

import * as fs from 'node:fs';
import * as path from 'node:path';

/** 文件分类 */
export type FileCategory =
  | 'document'    // 文档
  | 'spreadsheet' // 表格
  | 'image'       // 图片
  | 'code'        // 代码
  | 'ppt'         // PPT
  | 'pdf'         // PDF
  | 'other';      // 其他

/** 文件记录 */
export interface FileRecord {
  /** 文件路径（相对于 .xagent 目录） */
  path: string;
  /** 分类 */
  category: FileCategory;
  /** 创建时间 */
  createdAt: string;
  /** 创建来源：会话 ID */
  sessionId?: string;
  /** 文件描述 */
  description?: string;
  /** 文件大小 (bytes) */
  size?: number;
  /** 是否可清理 */
  cleanable: boolean;
}

/** Manifest 结构 */
export interface FileManifest {
  /** 版本 */
  version: number;
  /** 工作目录 */
  cwd: string;
  /** 文件记录列表 */
  files: FileRecord[];
  /** 最后更新时间 */
  updatedAt: string;
}

/** 目录结构 */
const XAGENT_DIR = '.xagent';
const SUBDIRS: Record<FileCategory, string> = {
  document: 'documents',
  spreadsheet: 'spreadsheets',
  image: 'images',
  code: 'code',
  ppt: 'ppt',
  pdf: 'pdf',
  other: 'other',
};

/** 扫描时跳过的目录名（避免污染文件列表） */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.idea', '.vscode',
  '__pycache__', '.venv', 'venv', 'env',
  '.cache', '.next', '.nuxt', '.parcel-cache', '.turbo',
  'dist', 'build', 'out', 'target',
  '.pytest_cache', '.mypy_cache', '.tox',
  '.gradle', '.angular', 'coverage',
  '.DS_Store',
]);

/** .xagent 目录下不展示的内部文件 */
const XAGENT_INTERNAL_FILES = new Set([
  'manifest.json',
  '.gitignore',
]);

/** 最大扫描文件数（防止扫描过大目录卡顿） */
const MAX_SCAN_FILES = 5000;
/** 最大扫描深度 */
const MAX_SCAN_DEPTH = 8;

/** 可清理的分类 */
const CLEANABLE_CATEGORIES: FileCategory[] = [];

/** 旧分类到新分类的基础映射（无法推断路径时的默认值） */
const OLD_TO_NEW_CATEGORY_DEFAULT: Partial<Record<string, FileCategory>> = {
  script: 'code',
  output: 'document',  // output 默认为文档，实际会根据路径重新推断
  temp: 'other',
  cache: 'other',
  artifact: 'code',
  log: 'document',     // log 默认为文档
};

/** 获取实际分类（兼容旧数据，会根据路径重新推断） */
function normalizeCategory(category: string, filePath?: string): FileCategory {
  // 如果是新分类，直接返回
  if (SUBDIRS[category as FileCategory]) {
    return category as FileCategory;
  }
  
  // 对于旧分类，如果提供了文件路径，尝试根据路径重新推断
  if (filePath) {
    // 提取扩展名
    const ext = path.extname(filePath).toLowerCase();
    const filePathLower = filePath.toLowerCase();
    
    // output 目录下的文件根据扩展名判断
    if (filePathLower.includes('outputs/') || filePathLower.includes('output/') ||
        filePathLower.includes('\\outputs\\') || filePathLower.includes('\\output\\')) {
      if (['.xlsx', '.xls', '.csv', '.tsv', '.json'].includes(ext)) return 'spreadsheet';
      if (['.txt', '.md', '.html', '.log'].includes(ext)) return 'document';
      if (['.png', '.jpg', '.jpeg', '.gif', '.svg'].includes(ext)) return 'image';
      if (ext === '.pdf') return 'pdf';
      if (['.ppt', '.pptx'].includes(ext)) return 'ppt';
      if (['.js', '.ts', '.py', '.json', '.xml', '.yaml'].includes(ext)) return 'code';
      return 'document';
    }
    
    // scripts 目录 -> 代码
    if (filePathLower.includes('scripts/') || filePathLower.includes('\\scripts\\')) {
      return 'code';
    }
    
    // artifacts 目录 -> 代码
    if (filePathLower.includes('artifacts/') || filePathLower.includes('\\artifacts\\')) {
      return 'code';
    }
    
    // temp/cache 目录 -> 根据扩展名
    if (filePathLower.includes('temp/') || filePathLower.includes('cache/')) {
      if (['.xlsx', '.xls', '.csv', '.json'].includes(ext)) return 'spreadsheet';
      if (['.txt', '.md', '.log'].includes(ext)) return 'document';
      if (['.js', '.ts', '.py', '.sh'].includes(ext)) return 'code';
      return 'other';
    }
    
    // log 目录下的 .log 文件 -> 文档
    if (filePathLower.includes('logs/') || filePathLower.includes('log/') || ext === '.log') {
      return 'document';
    }
  }
  
  // 无法推断时使用默认映射
  return OLD_TO_NEW_CATEGORY_DEFAULT[category] || 'other';
}

export class FileManager {
  private cwd: string;
  private xagentDir: string;
  private manifestPath: string;
  private manifest: FileManifest;

  constructor(cwd: string) {
    this.cwd = path.resolve(cwd);
    this.xagentDir = path.join(this.cwd, XAGENT_DIR);
    this.manifestPath = path.join(this.xagentDir, 'manifest.json');
    this.init();
    this.manifest = this.loadManifest();
    this.migrateLegacyPaths();   // 旧 manifest 路径迁移
    this.syncWithDisk();          // 同步磁盘上的实际文件
  }

  /** 初始化目录结构 */
  private init(): void {
    fs.mkdirSync(this.xagentDir, { recursive: true });
    for (const subdir of Object.values(SUBDIRS)) {
      fs.mkdirSync(path.join(this.xagentDir, subdir), { recursive: true });
    }
    // 创建 .gitignore 防止生成文件进入版本控制
    const gitignorePath = path.join(this.xagentDir, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, `# XAgent 生成的文件目录
documents/
spreadsheets/
images/
code/
ppt/
pdf/
other/
manifest.json
`);
    }
  }

  /** 加载 manifest */
  private loadManifest(): FileManifest {
    if (!fs.existsSync(this.manifestPath)) {
      return {
        version: 2,
        cwd: this.cwd,
        files: [],
        updatedAt: new Date().toISOString(),
      };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.manifestPath, 'utf-8'));
      return { ...raw, cwd: this.cwd };
    } catch {
      return {
        version: 2,
        cwd: this.cwd,
        files: [],
        updatedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * 旧 manifest 兼容：v1 的 path 字段是相对于 .xagent 目录的；
   * v2 改为相对于 cwd。这里把不带 .xagent 前缀但实际位于 .xagent 内的旧路径加上前缀。
   */
  private migrateLegacyPaths(): void {
    let changed = false;
    for (const f of this.manifest.files) {
      const p = f.path.replace(/\\/g, '/');
      // 如果路径已经以 .xagent/ 开头或是绝对路径，认为是新格式
      if (p.startsWith('.xagent/') || path.isAbsolute(f.path)) continue;
      // 如果按 cwd 解读能找到文件，认为是新格式
      const newAbs = path.join(this.cwd, f.path);
      if (fs.existsSync(newAbs)) continue;
      // 否则尝试按旧格式（相对 xagentDir）解读
      const oldAbs = path.join(this.xagentDir, f.path);
      if (fs.existsSync(oldAbs)) {
        f.path = path.relative(this.cwd, oldAbs);
        changed = true;
      }
    }
    if (changed) {
      this.manifest.version = 2;
      this.saveManifest();
    }
  }

  /** 保存 manifest */
  private saveManifest(): void {
    this.manifest.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2));
  }

  /** 同步磁盘上的实际文件到 manifest（扫描并注册未追踪的文件） */
  private syncWithDisk(): void {
    const found = new Map<string, { category: FileCategory; size: number; mtime: number }>();

    this.scanDir(this.cwd, found, 0);

    let changed = false;

    // 1. 添加 / 更新发现的文件
    for (const [relPath, info] of found) {
      const existing = this.manifest.files.find(f => f.path === relPath);
      if (!existing) {
        this.manifest.files.push({
          path: relPath,
          category: info.category,
          createdAt: new Date(info.mtime).toISOString(),
          cleanable: false,
          size: info.size,
        });
        changed = true;
      } else {
        if (existing.size !== info.size) {
          existing.size = info.size;
          changed = true;
        }
        // 修正历史上分类错误的记录（比如 "log"/"output" 等旧分类）
        if (!SUBDIRS[existing.category]) {
          existing.category = info.category;
          changed = true;
        }
      }
    }

    // 2. 移除磁盘上已不存在的文件
    const before = this.manifest.files.length;
    this.manifest.files = this.manifest.files.filter(f => {
      if (path.isAbsolute(f.path)) {
        return fs.existsSync(f.path);
      }
      return fs.existsSync(path.join(this.cwd, f.path));
    });
    if (this.manifest.files.length !== before) changed = true;

    if (changed) this.saveManifest();
  }

  /** 递归扫描目录，把发现的文件填入 found 中（key 为相对 cwd 的路径） */
  private scanDir(
    dirPath: string,
    found: Map<string, { category: FileCategory; size: number; mtime: number }>,
    depth: number,
  ): void {
    if (found.size >= MAX_SCAN_FILES) return;
    if (depth > MAX_SCAN_DEPTH) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (found.size >= MAX_SCAN_FILES) return;

      const fullPath = path.join(dirPath, entry.name);
      const relFromCwd = path.relative(this.cwd, fullPath);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        // 跳过隐藏目录（除了 .xagent 自身）
        if (entry.name.startsWith('.') && entry.name !== XAGENT_DIR) continue;
        this.scanDir(fullPath, found, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;

      // 跳过 .xagent 内部辅助文件
      const segments = relFromCwd.split(/[\\/]/);
      if (segments[0] === XAGENT_DIR) {
        // .xagent/manifest.json、.xagent/.gitignore 不展示
        if (segments.length === 2 && XAGENT_INTERNAL_FILES.has(segments[1])) continue;
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      // 优先按所在子目录推断分类（保持 .xagent/<sub>/ 下的稳定分类）
      let category: FileCategory;
      if (segments[0] === XAGENT_DIR && segments.length >= 3) {
        const subdir = segments[1];
        const matched = (Object.entries(SUBDIRS) as [FileCategory, string][])
          .find(([, dir]) => dir === subdir);
        category = matched ? matched[0] : this.inferCategory(relFromCwd);
      } else {
        category = this.inferCategory(relFromCwd);
      }

      found.set(relFromCwd, {
        category,
        size: stat.size,
        mtime: stat.mtimeMs,
      });
    }
  }

  /** 解析文件分类（根据扩展名/路径/文件名推断） */
  inferCategory(filePath: string): FileCategory {
    const ext = path.extname(filePath).toLowerCase();
    const filePathLower = filePath.toLowerCase();
    const basename = path.basename(filePath).toLowerCase();

    // ===== 优先基于路径目录名检测 =====
    // 注意：支持新旧两种目录名格式
    
    // scripts 目录 -> 代码
    if (filePathLower.includes('scripts/') || filePathLower.includes('/script/') ||
        filePathLower.includes('\\scripts\\') || filePathLower.includes('\\script\\') ||
        filePathLower.includes('.xagent/scripts') || filePathLower.startsWith('scripts')) {
      return 'code';
    }
    
    // outputs/output 目录 -> 根据扩展名判断具体类型
    if (filePathLower.includes('outputs/') || filePathLower.includes('output/') ||
        filePathLower.includes('\\outputs\\') || filePathLower.includes('\\output\\') ||
        filePathLower.includes('.xagent/outputs') || filePathLower.includes('.xagent/output')) {
      if (['.xlsx', '.xls', '.csv', '.tsv', '.ods', '.json'].includes(ext)) return 'spreadsheet';
      if (['.txt', '.md', '.html', '.htm', '.log', '.rst', '.adoc'].includes(ext)) return 'document';
      if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.tiff'].includes(ext)) return 'image';
      if (ext === '.pdf') return 'pdf';
      if (['.ppt', '.pptx', '.odp', '.key'].includes(ext)) return 'ppt';
      // 默认：根据扩展名再判断一次
      if (['.js', '.ts', '.py', '.json', '.xml', '.yaml', '.yml', '.toml', '.ini', '.conf'].includes(ext)) return 'code';
      return 'document'; // outputs 目录下默认为文档
    }
    
    // artifacts 目录 -> 代码（项目产物）
    if (filePathLower.includes('artifacts/') || filePathLower.includes('\\artifacts\\') ||
        filePathLower.includes('.xagent/artifacts') || filePathLower.startsWith('artifacts')) {
      return 'code';
    }
    
    // temp/cache/log 目录 -> 根据扩展名判断（这些是旧目录名）
    if (filePathLower.includes('temp/') || filePathLower.includes('cache/') || 
        filePathLower.includes('log/') || filePathLower.includes('logs/') ||
        filePathLower.includes('\\temp\\') || filePathLower.includes('\\cache\\') ||
        filePathLower.includes('\\log\\') || filePathLower.includes('\\logs\\') ||
        filePathLower.includes('.xagent/temp') || filePathLower.includes('.xagent/cache') ||
        filePathLower.includes('.xagent/log') || filePathLower.includes('.xagent/logs')) {
      // 这些目录下的文件根据扩展名判断类型
      if (['.xlsx', '.xls', '.csv', '.json'].includes(ext)) return 'spreadsheet';
      if (['.txt', '.md', '.log'].includes(ext)) return 'document';
      if (['.js', '.ts', '.py', '.sh', '.bat'].includes(ext)) return 'code';
      return 'other';
    }
    
    // images/img 目录 -> 图片
    if (filePathLower.includes('images/') || filePathLower.includes('img/') ||
        filePathLower.includes('pictures/') || filePathLower.includes('\\images\\') ||
        filePathLower.includes('\\img\\') || filePathLower.includes('\\pictures\\') ||
        filePathLower.includes('.xagent/images') || filePathLower.startsWith('images')) {
      return 'image';
    }
    
    // documents/docs 目录 -> 文档
    if (filePathLower.includes('documents/') || filePathLower.includes('docs/') ||
        filePathLower.includes('\\documents\\') || filePathLower.includes('\\docs\\') ||
        filePathLower.includes('.xagent/documents') || filePathLower.startsWith('documents') ||
        filePathLower.startsWith('docs')) {
      if (ext === '.pdf') return 'pdf'; // docs 下 pdf 文件归为 PDF 类
      if (['.xlsx', '.xls', '.csv'].includes(ext)) return 'spreadsheet'; // docs 下表格归为表格类
      return 'document';
    }
    
    // spreadsheets/data 目录 -> 表格
    if (filePathLower.includes('spreadsheets/') || filePathLower.includes('data/') ||
        filePathLower.includes('\\spreadsheets\\') || filePathLower.includes('\\data\\') ||
        filePathLower.includes('.xagent/spreadsheets') || filePathLower.startsWith('spreadsheets') ||
        filePathLower.startsWith('data')) {
      return 'spreadsheet';
    }
    
    // pdf 目录 -> PDF
    if (filePathLower.includes('pdf/') || filePathLower.includes('\\pdf\\') ||
        filePathLower.includes('.xagent/pdf') || filePathLower.startsWith('pdf')) {
      return 'pdf';
    }
    
    // ppt/slides/presentations 目录 -> PPT
    if (filePathLower.includes('ppt/') || filePathLower.includes('slides/') ||
        filePathLower.includes('presentations/') || filePathLower.includes('\\ppt\\') ||
        filePathLower.includes('\\slides\\') || filePathLower.includes('\\presentations\\') ||
        filePathLower.includes('.xagent/ppt')) {
      return 'ppt';
    }
    
    // code/src 目录 -> 代码
    if (filePathLower.includes('code/') || filePathLower.includes('src/') ||
        filePathLower.includes('source/') || filePathLower.includes('\\code\\') ||
        filePathLower.includes('\\src\\') || filePathLower.includes('\\source\\') ||
        filePathLower.includes('.xagent/code')) {
      return 'code';
    }
    
    // other 目录 -> other
    if (filePathLower.includes('other/') || filePathLower.includes('\\other\\') ||
        filePathLower.includes('.xagent/other') || filePathLower.startsWith('other')) {
      return 'other';
    }

    // ===== 基于文件名模式检测 =====
    // 输出/报告类文件名 -> 根据扩展名判断
    if (basename.includes('output') || basename.includes('result') || basename.includes('report') ||
        basename.includes('summary') || basename.includes('log') || basename.startsWith('debug_') ||
        basename.includes('export') || basename.includes('download')) {
      if (['.xlsx', '.xls', '.csv', '.tsv'].includes(ext)) return 'spreadsheet';
      if (['.png', '.jpg', '.jpeg', '.gif', '.svg'].includes(ext)) return 'image';
      if (ext === '.pdf') return 'pdf';
      return 'document';
    }
    // 脚本/配置类文件名 -> 代码
    if (basename.includes('script') || basename.includes('config') || basename.includes('setup') ||
        basename.includes('test') || basename.includes('spec')) {
      return 'code';
    }

    // ===== 基于扩展名检测 =====
    // 文档类型
    const DOC_EXTENSIONS = [
      '.doc', '.docx', '.txt', '.md', '.markdown', '.rtf', '.odt', '.pages',
      '.html', '.htm', '.xhtml', '.epub', '.mobi',
      '.log', '.rst', '.adoc', '.asciidoc', '.tex', '.latex',
      '.org', '.wiki', '.txt2tags'
    ];
    if (DOC_EXTENSIONS.includes(ext)) {
      return 'document';
    }

    // 表格类型
    const SPREADSHEET_EXTENSIONS = [
      '.xlsx', '.xls', '.csv', '.ods', '.numbers', '.tsv',
      '.dif', '.slk', '.prn', '.dbf', '.fods'
    ];
    if (SPREADSHEET_EXTENSIONS.includes(ext)) {
      return 'spreadsheet';
    }

    // 图片类型
    const IMAGE_EXTENSIONS = [
      '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico',
      '.tiff', '.tif', '.raw', '.heif', '.heic', '.avif', '.jxl',
      '.psd', '.ai', '.eps', '.indd', '.sketch', '.fig', '.xd'
    ];
    if (IMAGE_EXTENSIONS.includes(ext)) {
      return 'image';
    }

    // PPT 类型
    const PPT_EXTENSIONS = [
      '.ppt', '.pptx', '.odp', '.key', '.pps', '.ppsx'
    ];
    if (PPT_EXTENSIONS.includes(ext)) {
      return 'ppt';
    }
    
    // PDF 类型
    if (ext === '.pdf') {
      return 'pdf';
    }

    // 代码类型
    const CODE_EXTENSIONS = [
      '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte',
      '.py', '.pyw', '.pyi', '.ipynb',
      '.java', '.kt', '.kts', '.scala', '.groovy', '.gradle',
      '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh', '.hxx', '.m', '.mm',
      '.go', '.rs',
      '.rb', '.rake', '.gemspec',
      '.php', '.phtml',
      '.sh', '.bash', '.zsh', '.bat', '.cmd', '.ps1', '.psm1', '.vbs',
      '.css', '.scss', '.sass', '.less', '.styl',
      '.json', '.xml', '.yaml', '.yml', '.toml', '.ini', '.conf', '.cfg', '.env',
      '.sql', '.ddl', '.prisma',
      '.swift', '.dart',
      '.hs', '.clj', '.cljs', '.ex', '.exs', '.erl',
      '.lua', '.pl', '.pm', '.r', '.jl', '.nim', '.cr', '.d', '.f90',
      '.sol', '.proto', '.graphql', '.gql'
    ];
    if (CODE_EXTENSIONS.includes(ext)) {
      return 'code';
    }

    // 无扩展名或未知扩展名
    return 'other';
  }

  /** 获取分类目录 */
  getCategoryDir(category: FileCategory): string {
    return path.join(this.xagentDir, SUBDIRS[category]);
  }

  /** 路由文件到正确目录 */
  routeFile(filePath: string, category?: FileCategory): string {
    // 如果路径已经是绝对路径或在 .xagent 内，直接返回
    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    if (filePath.startsWith(XAGENT_DIR) || filePath.startsWith('.xagent')) {
      return path.resolve(this.xagentDir, filePath.replace(/^\.xagent\/?/, ''));
    }

    // 推断分类
    const cat = category || this.inferCategory(filePath);
    const catDir = this.getCategoryDir(cat);
    const routedPath = path.join(catDir, path.basename(filePath));

    return routedPath;
  }

  /** 把任意输入路径解析为相对 cwd 的路径（保持与 manifest 一致） */
  private toRelPath(filePath: string): { abs: string; rel: string } {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(this.cwd, filePath);
    const rel = path.relative(this.cwd, abs);
    return { abs, rel };
  }

  /** 注册文件到 manifest */
  registerFile(
    filePath: string,
    category: FileCategory,
    sessionId?: string,
    description?: string
  ): void {
    const { abs, rel } = this.toRelPath(filePath);

    // 检查是否已存在
    const existing = this.manifest.files.find(f => f.path === rel);
    if (existing) {
      // 更新现有记录
      existing.createdAt = new Date().toISOString();
      existing.sessionId = sessionId;
      existing.description = description;
      existing.category = category;
      existing.cleanable = false;
      if (fs.existsSync(abs)) {
        existing.size = fs.statSync(abs).size;
      }
    } else {
      // 新增记录
      this.manifest.files.push({
        path: rel,
        category,
        createdAt: new Date().toISOString(),
        sessionId,
        description,
        cleanable: false,
        size: fs.existsSync(abs) ? fs.statSync(abs).size : undefined,
      });
    }
    this.saveManifest();
  }

  /** 取消注册文件 */
  unregisterFile(filePath: string): void {
    const { rel } = this.toRelPath(filePath);
    this.manifest.files = this.manifest.files.filter(f => f.path !== rel);
    this.saveManifest();
  }

  /** 获取所有文件记录 */
  getFiles(): FileRecord[] {
    return this.manifest.files;
  }

  /** 按分类获取文件 */
  getFilesByCategory(category: FileCategory): FileRecord[] {
    return this.manifest.files.filter(f => f.category === category);
  }

  /** 获取可清理文件 */
  getCleanableFiles(): FileRecord[] {
    return this.manifest.files.filter(f => f.cleanable);
  }

  /** 清理文件 */
  cleanFiles(categories?: FileCategory[]): { cleaned: number; errors: string[] } {
    const toClean = categories
      ? this.manifest.files.filter(f => categories.includes(f.category))
      : this.manifest.files.filter(f => f.cleanable);

    let cleaned = 0;
    const errors: string[] = [];

    for (const record of toClean) {
      const absPath = path.isAbsolute(record.path)
        ? record.path
        : path.join(this.cwd, record.path);
      try {
        if (fs.existsSync(absPath)) {
          fs.unlinkSync(absPath);
          cleaned++;
        }
        this.manifest.files = this.manifest.files.filter(f => f.path !== record.path);
      } catch (e: any) {
        errors.push(`${record.path}: ${e.message}`);
      }
    }

    this.saveManifest();
    return { cleaned, errors };
  }

  /** 清理空目录 */
  cleanEmptyDirs(): void {
    for (const subdir of Object.values(SUBDIRS)) {
      const dirPath = path.join(this.xagentDir, subdir);
      try {
        const files = fs.readdirSync(dirPath);
        if (files.length === 0) {
          // 不删除目录本身，保持结构
        }
      } catch { /* ignore */ }
    }
  }

  /** 获取统计信息 */
  getStats(): {
    totalFiles: number;
    totalSize: number;
    byCategory: Record<FileCategory, { count: number; size: number }>;
    cleanableCount: number;
    cleanableSize: number;
  } {
    const byCategory: Record<FileCategory, { count: number; size: number }> = {} as any;
    let totalSize = 0;
    let cleanableCount = 0;
    let cleanableSize = 0;

    for (const cat of Object.keys(SUBDIRS) as FileCategory[]) {
      byCategory[cat] = { count: 0, size: 0 };
    }

    for (const record of this.manifest.files) {
      // 兼容旧数据：使用 normalizeCategory 映射（传递路径以便智能推断）
      const cat = normalizeCategory(record.category, record.path);
      byCategory[cat].count++;
      byCategory[cat].size += record.size || 0;
      totalSize += record.size || 0;
      if (record.cleanable) {
        cleanableCount++;
        cleanableSize += record.size || 0;
      }
    }

    return {
      totalFiles: this.manifest.files.length,
      totalSize,
      byCategory,
      cleanableCount,
      cleanableSize,
    };
  }

  /** 获取 .xagent 目录路径 */
  getXagentDir(): string {
    return this.xagentDir;
  }

  /** 获取工作目录路径 */
  getCwd(): string {
    return this.cwd;
  }
}