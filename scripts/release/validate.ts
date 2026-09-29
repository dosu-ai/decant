import { ReleaseFailure } from "./actions.ts";

// Each check throws inline rather than through fail() so the accepted value is
// only reachable past the test, which is what lets static analysis treat it as
// validated before it reaches a command argument.

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;
const RELEASE_TAG = /^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const ABSOLUTE_PATH = /^\/[A-Za-z0-9._@+/-]*$/;
const PATH = /^[A-Za-z0-9._@+/][A-Za-z0-9._@+/-]*$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ASC_ISSUER_ID =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const ASC_KEY_ID = /^[A-Z0-9]{10}$/;

export function releaseVersion(value: string): string {
  if (!SEMVER.test(value)) {
    throw new ReleaseFailure(`'${value}' is not semver`);
  }
  return value;
}

export function releaseTag(name: string, value: string): string {
  if (!RELEASE_TAG.test(value)) {
    throw new ReleaseFailure(`${name} must be v followed by a semver version, got '${value}'`);
  }
  return value;
}

export function commitSha(name: string, value: string): string {
  if (!COMMIT_SHA.test(value)) {
    throw new ReleaseFailure(`${name} must be a 40-character lowercase hex commit SHA`);
  }
  return value;
}

export function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ReleaseFailure(`${name} must be one of ${allowed.join(", ")}, got '${value}'`);
  }
  return value as T;
}

/** Absolute, and limited to characters no command can read as an option or separator. */
export function absolutePath(name: string, value: string): string {
  if (!ABSOLUTE_PATH.test(value)) {
    throw new ReleaseFailure(
      `${name} must be an absolute path of letters, digits, and ._@+/- characters`,
    );
  }
  return value;
}

/** Relative or absolute, but never starting with `-`. */
export function safePath(name: string, value: string): string {
  if (!PATH.test(value)) {
    throw new ReleaseFailure(
      `${name} must be a path of letters, digits, and ._@+/- characters that does not start with -`,
    );
  }
  return value;
}

/** A single path component that cannot be read as an option or split into several arguments. */
export function releaseFileName(value: string): string {
  if (!FILE_NAME.test(value)) {
    throw new ReleaseFailure(
      `release file name '${value}' must use only letters, digits, and ._- and start with a letter or digit`,
    );
  }
  return value;
}

// Secret-derived checks name the variable but never echo its value.
export function ascIssuerId(name: string, value: string): string {
  if (!ASC_ISSUER_ID.test(value)) {
    throw new ReleaseFailure(`${name} must be an App Store Connect issuer ID (a UUID)`);
  }
  return value;
}

export function ascKeyId(name: string, value: string): string {
  if (!ASC_KEY_ID.test(value)) {
    throw new ReleaseFailure(
      `${name} must be an App Store Connect key ID (10 uppercase letters or digits)`,
    );
  }
  return value;
}
