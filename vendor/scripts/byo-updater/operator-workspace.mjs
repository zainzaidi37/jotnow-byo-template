import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

export async function ensureOperatorWorkDirectory(stateDirectory) {
  const path = join(stateDirectory, 'adapter-work');
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path) {
    throw new Error(
      'operator working directory must be a real directory with no symlink traversal',
    );
  }
  return path;
}
