import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const COMMIT = /^[a-f0-9]{40}$/;

function fixed(message) {
  return new Error(message);
}

function runGit(repository, args, exec = execFile) {
  return new Promise((resolvePromise, reject) => {
    exec(
      'git',
      ['-C', repository, ...args],
      { env: { PATH: process.env.PATH, LANG: 'C' } },
      (error, stdout) => {
        if (error) reject(fixed('durable Git checkpoint failed'));
        else resolvePromise(String(stdout).trim());
      },
    );
  });
}

export function pushWithLease({ git, repository, remoteRef, expectedHead }) {
  return git(repository, [
    'push',
    `--force-with-lease=${remoteRef}:${expectedHead}`,
    'origin',
    `HEAD:${remoteRef}`,
  ]);
}

async function assertLayout(repository, stateDirectory) {
  const repo = resolve(repository);
  const state = resolve(stateDirectory);
  const path = relative(repo, state).split(sep).join('/');
  if (path !== '.jotnow/deployment') throw fixed('durable state path must be .jotnow/deployment');
  const repoStat = await lstat(repo);
  const stateParent = dirname(state);
  await mkdir(stateParent, { recursive: true, mode: 0o700 }).catch(() => {
    throw fixed('checkpoint paths are invalid');
  });
  const parentStat = await lstat(stateParent);
  if (!repoStat.isDirectory() || !parentStat.isDirectory())
    throw fixed('checkpoint paths are invalid');
  if ((await realpath(repo)) !== repo || (await realpath(stateParent)) !== stateParent) {
    throw fixed('checkpoint paths must not traverse symlinks');
  }
  return { repo, path };
}

function allowedPath(path, sequence) {
  return (
    path === '.jotnow/deployment/deployment-state.json' ||
    path.startsWith(`.jotnow/deployment/control/${sequence}/`)
  );
}

export class GitCheckpointStore {
  constructor({ repository, stateDirectory, branch, expectedHead, localStore, git = runGit }) {
    if (!BRANCH.test(branch) || branch.includes('..') || branch.endsWith('/')) {
      throw fixed('checkpoint branch is invalid');
    }
    if (!COMMIT.test(expectedHead)) throw fixed('checkpoint expected head is invalid');
    if (typeof localStore?.read !== 'function' || typeof localStore?.write !== 'function') {
      throw fixed('checkpoint local store is invalid');
    }
    this.repository = repository;
    this.stateDirectory = stateDirectory;
    this.branch = branch;
    this.expectedHead = expectedHead;
    this.localStore = localStore;
    this.git = git;
  }

  read() {
    return this.localStore.read();
  }

  async write(state) {
    const { repo, path } = await assertLayout(this.repository, this.stateDirectory);
    const remoteRef = `refs/heads/${this.branch}`;
    const observed = (await this.git(repo, ['ls-remote', '--refs', 'origin', remoteRef])).split(
      /\s+/,
    )[0];
    if (observed !== this.expectedHead) throw fixed('configuration branch changed unexpectedly');
    const written = await this.localStore.write(state);
    const sequence = written.updaterControl?.sequence;
    const paths = [`${path}/deployment-state.json`];
    if (sequence) paths.push(`${path}/control/${sequence}`);
    await this.git(repo, ['add', '--', ...paths]);
    const staged = (await this.git(repo, ['diff', '--cached', '--name-only', '-z']))
      .split('\0')
      .filter(Boolean);
    if (staged.some((entry) => !allowedPath(entry, sequence))) {
      throw fixed('checkpoint staged an unexpected path');
    }
    if (staged.length === 0) return written;
    await this.git(repo, [
      '-c',
      'user.name=Jotnow updater',
      '-c',
      'user.email=updater@invalid',
      'commit',
      '-m',
      `Record deployment checkpoint sequence ${written.attempt?.target.sequence ?? written.installedRelease?.sequence}`,
      '--',
      ...paths,
    ]);
    const commit = await this.git(repo, ['rev-parse', 'HEAD']);
    const beforePush = (await this.git(repo, ['ls-remote', '--refs', 'origin', remoteRef])).split(
      /\s+/,
    )[0];
    if (beforePush !== this.expectedHead) throw fixed('configuration branch changed unexpectedly');
    await pushWithLease({
      git: this.git,
      repository: repo,
      remoteRef,
      expectedHead: this.expectedHead,
    });
    this.expectedHead = commit;
    return written;
  }
}
