import { ISSUES_URL } from './version.js';

/** Expected, user-facing failure: printed without a stack trace. */
export class CsmError extends Error {
  override readonly name = 'CsmError';
}

const ERRNO_PATH_KEYS = ['path', 'dest'] as const;

/** "syscall path", or the raw error message when the error carries no path. */
const where = (code: string, p: string, errno: NodeJS.ErrnoException | null | undefined): string => {
  if (p === '') return errno?.message ?? code;
  return errno?.syscall !== undefined ? `${errno.syscall} ${p}` : p;
};

/**
 * Maps any thrown value to the one-line message cli.ts prints and the process exit code:
 * 1 = user/environment error (fixable by the user), 2 = unexpected (a bug worth reporting).
 */
export const describeError = (
  err: unknown,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { readonly message: string; readonly exitCode: 1 | 2 } => {
  if (err instanceof CsmError) return { message: err.message, exitCode: 1 };
  const errno = err as NodeJS.ErrnoException | null | undefined;
  const code = typeof errno === 'object' && errno !== null ? errno.code : undefined;
  const p = ERRNO_PATH_KEYS.map((k) => (errno as unknown as Record<string, unknown>)[k]).find(
    (v): v is string => typeof v === 'string' && v !== '',
  ) ?? '';
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return {
        message: `permission denied: ${p}. Check its owner/permissions.${platform === 'win32' ? ' It may be locked by an editor or antivirus; close it and retry.' : ''}`,
        exitCode: 1,
      };
    case 'EBUSY':
      return { message: `${p} is in use by another program (antivirus, indexer, editor). Close it and retry.`, exitCode: 1 };
    case 'ENOSPC':
      return { message: `no space left on device while writing ${p}.`, exitCode: 1 };
    case 'EROFS':
      return { message: `${p} is on a read-only file system.`, exitCode: 1 };
    case 'ELOOP':
      return {
        message: `too many levels of symbolic links at ${p}; a shared link may point to itself. Run "csm doctor".`,
        exitCode: 1,
      };
    case 'ENOENT':
      return { message: `${where('ENOENT', p, errno)}: no such file or directory.`, exitCode: 1 };
    case 'ENOTDIR':
      return { message: `${where('ENOTDIR', p, errno)}: a path component is not a directory.`, exitCode: 1 };
    case 'EEXIST':
      return { message: `${where('EEXIST', p, errno)}: already exists.`, exitCode: 1 };
    case 'ENAMETOOLONG':
      return {
        message: `${where('ENAMETOOLONG', p, errno)}: path or file name is too long.${platform === 'win32' ? ' Use a shorter CSM_HOME, or enable Windows long paths.' : ''}`,
        exitCode: 1,
      };
    case 'EMFILE':
      return { message: `${where('EMFILE', p, errno)}: too many open files. Close other programs and retry.`, exitCode: 1 };
    case 'ENOTEMPTY':
      return { message: `${where('ENOTEMPTY', p, errno)}: directory is not empty.`, exitCode: 1 };
    case 'EISDIR':
      return { message: `${where('EISDIR', p, errno)}: is a directory, expected a file.`, exitCode: 1 };
  }
  if (typeof code === 'string' && /^E[A-Z0-9]+$/.test(code)) {
    const syscall = typeof errno?.syscall === 'string' ? `${errno.syscall} ` : '';
    const at = p !== '' ? `${p}: ` : '';
    return { message: `system error: ${syscall}${at}${code} (${errno?.message ?? code})`, exitCode: 1 };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return {
    message: `unexpected error: ${msg}\nThis is a bug. Please report it at ${ISSUES_URL} with "csm doctor" output (re-run with CSM_DEBUG=1 for a stack trace).`,
    exitCode: 2,
  };
};
