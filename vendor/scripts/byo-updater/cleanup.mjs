import { rm } from 'node:fs/promises';

export async function removeQuarantine(root) {
  await rm(root, { recursive: true, force: true });
}
