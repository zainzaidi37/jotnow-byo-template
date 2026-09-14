#!/usr/bin/env node
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPackage } from './manifest.mjs';
import { verifySignedManifest } from './signature.mjs';

const SIGNATURE_PATH = 'manifest.json.minisig';

async function assertRegular(path, label) {
  const absolute = resolve(path);
  const stat = await lstat(absolute).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || (await realpath(absolute)) !== absolute) {
    throw new Error(`${label} must be a regular file with no symlink traversal`);
  }
  return absolute;
}

export async function verifySignedPackage({
  packageRoot,
  trustList,
  expectedVersion,
  expectedSequence,
  expectedSourceCommit,
}) {
  const root = resolve(packageRoot);
  const manifestPath = await assertRegular(join(root, 'manifest.json'), 'release manifest');
  const signaturePath = await assertRegular(join(root, SIGNATURE_PATH), 'release signature');
  const trustPath = await assertRegular(trustList, 'verification trust list');

  // Nothing from the manifest, including its file paths and hashes, is used
  // until both minisign signatures authenticate against the caller's anchor.
  const verified = verifySignedManifest({
    manifestBytes: await readFile(manifestPath),
    signature: await readFile(signaturePath),
    trustList: await readFile(trustPath),
  });
  if (verified.manifest.signature?.path !== SIGNATURE_PATH) {
    throw new Error(`signed package signature path must be ${SIGNATURE_PATH}`);
  }
  const actual = verified.manifest.release;
  if (expectedVersion !== undefined && actual.version !== expectedVersion) {
    throw new Error(
      `signed package version mismatch: expected ${expectedVersion}, received ${actual.version}`,
    );
  }
  if (expectedSequence !== undefined && actual.sequence !== expectedSequence) {
    throw new Error(
      `signed package sequence mismatch: expected ${expectedSequence}, received ${actual.sequence}`,
    );
  }
  if (expectedSourceCommit !== undefined && actual.sourceCommit !== expectedSourceCommit) {
    throw new Error(
      `signed package source commit mismatch: expected ${expectedSourceCommit}, received ${actual.sourceCommit}`,
    );
  }
  await verifyPackage(root, verified.manifest);
  return verified;
}

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined)
      throw new Error(`invalid argument near ${key ?? '<end>'}`);
    values[key.slice(2)] = value;
  }
  for (const required of ['package', 'trust-list']) {
    if (!values[required]) throw new Error(`missing --${required}`);
  }
  return {
    packageRoot: values.package,
    trustList: values['trust-list'],
    expectedVersion: values['expected-version'],
    expectedSequence:
      values['expected-sequence'] === undefined ? undefined : Number(values['expected-sequence']),
    expectedSourceCommit: values['expected-source-commit'],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifySignedPackage(parseArgs(process.argv.slice(2)))
    .then((verified) => {
      const release = verified.manifest.release;
      console.log(
        `authenticated and hash-verified ${release.version} sequence ${release.sequence} from ${release.sourceCommit}`,
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
