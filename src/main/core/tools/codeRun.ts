// ═══════════════════════════════════════════════════════════════
//  code_run 工具：执行 python / node / powershell / bash 代码
//  对齐 ga.py 的 code_run / do_code_run
// ═══════════════════════════════════════════════════════════════

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { registerTool, type ToolResult } from './types.js';

function smartFormat(s: string, maxLen = 600, omit = '\n\n[omitted long output]\n\n'): string {
  if (s.length < maxLen + omit.length * 2) return s;
  const half = Math.floor(maxLen / 2);
  return s.slice(0, half) + omit + s.slice(-half);
}

/** 获取某个语言的启动命令与临时脚本扩展名 */
function buildCommand(codeType: string, code: string, cwd: string): {
  cmd: string;
  args: string[];
  tmpFile?: string;
} {
  const isWin = os.platform() === 'win32';
  switch (codeType) {
    case 'python': {
      const tmp = path.join(os.tmpdir(), `xagent_${Date.now()}.ai.py`);
      fs.writeFileSync(tmp, code, 'utf-8');
      return {
        cmd: isWin ? 'python' : 'python3',
        args: ['-X', 'utf8', '-u', tmp],
        tmpFile: tmp,
      };
    }
    case 'node': {
      const tmp = path.join(os.tmpdir(), `xagent_${Date.now()}.ai.mjs`);
      fs.writeFileSync(tmp, code, 'utf-8');
      return { cmd: 'node', args: [tmp], tmpFile: tmp };
    }
    case 'powershell':
      return {
        cmd: 'powershell',
        args: ['-NoProfile', '-NonInteractive', '-Command', code],
      };
    case 'bash':
      return { cmd: 'bash', args: ['-c', code] };
    default:
      throw new Error(`不支持的类型: ${codeType}`);
  }
}

registerTool('code_run', async function* (args, ctx): AsyncGenerator<string, ToolResult> {
  const codeType = args.type || 'python';
  let code = args.code || args.script;
  if (!code && ctx.responseContent) {
    const pattern = new RegExp('```' + codeType + '\\n([\\s\\S]*?)\\n```', 'g');
    const matches = [...ctx.responseContent.matchAll(pattern)];
    if (matches.length) code = matches[matches.length - 1][1].trim();
  }
  if (!code) {
    return {
      data: `[Error] Code missing. Use \`\`\`${codeType} block or 'script' arg.`,
      nextPrompt: '\n',
    };
  }

  const timeoutSec = Math.max(5, args.timeout ?? 60);
  const rawCwd = args.cwd ? path.resolve(ctx.cwd, args.cwd) : ctx.cwd;
  const cwd = path.normalize(rawCwd);

  const preview = code.length > 60 ? code.slice(0, 60).replace(/\n/g, ' ') + '...' : code.trim();
  yield `[Action] Running ${codeType} in ${path.basename(cwd)}: ${preview}\n`;

  let built: ReturnType<typeof buildCommand>;
  try {
    built = buildCommand(codeType, code, cwd);
  } catch (e: any) {
    return { data: { status: 'error', msg: e.message }, nextPrompt: '\n' };
  }

  try {
    fs.mkdirSync(cwd, { recursive: true });
  } catch { /* ignore */ }

  const proc = spawn(built.cmd, built.args, {
    cwd,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });

  const startT = Date.now();
  let fullStdout = '';
  let killed = false;
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    try { proc.kill('SIGKILL' as any); } catch { /* ignore */ }
  }, timeoutSec * 1000);

  const stopCheck = setInterval(() => {
    if (ctx.stopSignal.aborted && !killed) {
      killed = true;
      try { proc.kill('SIGKILL' as any); } catch { /* ignore */ }
    }
  }, 500);

  const decoder = new TextDecoder('utf-8', { fatal: false });
  proc.stdout?.on('data', (chunk: Buffer) => {
    const s = decoder.decode(chunk, { stream: true });
    fullStdout += s;
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    const s = decoder.decode(chunk, { stream: true });
    fullStdout += s;
  });

  const exitCode: number | null = await new Promise((resolve) => {
    proc.on('close', (code) => resolve(code));
    proc.on('error', () => resolve(null));
  });

  clearTimeout(timeout);
  clearInterval(stopCheck);

  if (timedOut) fullStdout += '\n[Timeout Error] 超时强制终止';
  else if (killed) fullStdout += '\n[Stopped] 用户强制终止';

  // 清理临时文件
  if (built.tmpFile && fs.existsSync(built.tmpFile)) {
    try { fs.unlinkSync(built.tmpFile); } catch { /* ignore */ }
  }

  const status = exitCode === 0 ? 'success' : 'error';
  const icon = exitCode === 0 ? '[OK]' : exitCode === null ? '[?]' : '[FAIL]';
  const snippet = smartFormat(fullStdout, 600);
  yield `[Status] ${icon} Exit Code: ${exitCode}\n[Stdout]\n${snippet}\n`;

  const elapsed = ((Date.now() - startT) / 1000).toFixed(1);
  return {
    data: {
      status,
      stdout: smartFormat(fullStdout, 10000),
      exit_code: exitCode,
      elapsed_sec: parseFloat(elapsed),
    },
    nextPrompt: '\n',
  };
});
