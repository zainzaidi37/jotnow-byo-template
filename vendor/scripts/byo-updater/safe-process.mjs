import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { delimiter, dirname, isAbsolute } from 'node:path';

const MAX_OUTPUT = 1024 * 1024;
const SQLSTATES = new Set([
  '23503',
  '23505',
  '23514',
  '28000',
  '28P01',
  '40001',
  '40P01',
  '42501',
  '42P01',
  '42703',
  '42704',
  '42883',
  '55P03',
  '57014',
  ...Array.from({ length: 32 }, (_, index) => `JN${String(index + 1).padStart(3, '0')}`),
]);

export function isolatedCliEnvironment(home, additions = {}, nodeExecutable = process.execPath) {
  if (
    !isAbsolute(home) ||
    !isAbsolute(nodeExecutable) ||
    Object.hasOwn(additions, 'PATH') ||
    Object.values(additions).some((value) => typeof value !== 'string')
  ) {
    throw new Error('invalid isolated CLI environment');
  }
  const path = [...new Set([dirname(nodeExecutable), '/usr/local/bin', '/usr/bin', '/bin'])].join(
    delimiter,
  );
  return Object.freeze({
    ...additions,
    HOME: home,
    XDG_CACHE_HOME: `${home}/cache`,
    XDG_CONFIG_HOME: `${home}/config`,
    LANG: 'C',
    LC_ALL: 'C',
    PATH: path,
    SUPABASE_TELEMETRY_DISABLED: '1',
  });
}

function failure(label, stderr = '') {
  const found =
    /(?:ERROR|FATAL):\s+([0-9A-Z]{5}):/.exec(stderr)?.[1] ??
    /\bSQLSTATE\s*[(:=]?\s*([0-9A-Z]{5})\b/.exec(stderr)?.[1];
  const sqlstate = SQLSTATES.has(found) ? found : undefined;
  return Object.assign(new Error(`${label} failed${sqlstate ? ` (SQLSTATE ${sqlstate})` : ''}`), {
    code: 'command_failed',
    ...(sqlstate ? { sqlstate } : {}),
  });
}

export function runBoundedProcess({
  executable,
  args,
  cwd,
  env,
  input = '',
  timeoutMs,
  label,
  spawnImpl = spawn,
}) {
  if (
    typeof executable !== 'string' ||
    !isAbsolute(executable) ||
    !Array.isArray(args) ||
    args.some((arg) => typeof arg !== 'string' || /[\0\r\n]/.test(arg)) ||
    typeof cwd !== 'string' ||
    !isAbsolute(cwd) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 15 * 60_000 ||
    typeof label !== 'string' ||
    !label
  ) {
    throw new Error('invalid updater subprocess configuration');
  }
  return new Promise((resolve, reject) => {
    let child;
    const usesProcessGroup = process.platform !== 'win32';
    try {
      child = spawnImpl(executable, args, {
        cwd,
        env: Object.freeze({ ...env }),
        detached: usesProcessGroup,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      reject(failure(label));
      return;
    }
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let closeSeen = false;
    let closeCode;
    let abortError;
    let terminationPoll;
    const processGroup =
      usesProcessGroup && Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null;
    const processGroupIsLive = () => {
      if (processGroup === null) return false;
      try {
        process.kill(-processGroup, 0);
        return true;
      } catch (error) {
        return error?.code !== 'ESRCH';
      }
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (terminationPoll) clearTimeout(terminationPoll);
      if (error) reject(error);
      else resolve(value);
    };
    const finishAfterTermination = () => {
      if (settled || !closeSeen) return;
      if (processGroupIsLive()) {
        if (!terminationPoll) {
          terminationPoll = setTimeout(() => {
            terminationPoll = undefined;
            finishAfterTermination();
          }, 10);
        }
        return;
      }
      if (abortError) {
        finish(abortError);
        return;
      }
      const safeFailure = failure(label, Buffer.concat(stderr).toString('utf8'));
      if (closeCode !== 0) finish(safeFailure);
      else finish(null, Buffer.concat(stdout));
    };
    const abort = (error) => {
      if (settled || abortError) return;
      abortError = error;
      let groupSignaled = false;
      if (processGroup !== null) {
        try {
          process.kill(-processGroup, 'SIGKILL');
          groupSignaled = true;
        } catch {
          // The group may not have formed yet or may already have exited.
        }
      }
      if (!groupSignaled) {
        try {
          child.kill('SIGKILL');
        } catch {
          // The fixed error below remains authoritative.
        }
      }
      finishAfterTermination();
    };
    const timer = setTimeout(
      () => abort(Object.assign(new Error(`${label} timed out`), { code: 'timeout' })),
      timeoutMs,
    );
    child.stdout.on('data', (chunk) => {
      if (abortError) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT) abort(failure(label));
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (abortError) return;
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT) abort(failure(label));
      else stderr.push(chunk);
    });
    child.once('error', () => abort(failure(label)));
    child.once('close', (code) => {
      closeSeen = true;
      closeCode = code;
      finishAfterTermination();
    });
    child.stdin.once('error', () => abort(failure(label)));
    try {
      child.stdin.end(input);
    } catch {
      abort(failure(label));
    }
  });
}
