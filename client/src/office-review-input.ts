const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/i;
const MAX_FILES = 300;
const MAX_FILENAME_LENGTH = 4_096;

export interface PreparedPullRequestFile {
  readonly filename: string;
}

export interface PreparedPullRequestInputSummary {
  readonly pullRequest: {
    readonly number: number;
    readonly baseSha: string;
    readonly headSha: string;
  };
  readonly files: readonly PreparedPullRequestFile[];
  readonly completeness: 'unverified';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

/** Reads only the API's metadata contract; responses containing code patches are rejected. */
export function readPreparedReviewInputResponse(value: unknown, expectedNumber: number): PreparedPullRequestInputSummary {
  try {
    if (!isRecord(value)) throw new Error();
    const pullRequest = ownDataProperty(value, 'pullRequest');
    const files = ownDataProperty(value, 'files');
    const completeness = ownDataProperty(value, 'completeness');
    if (!isRecord(pullRequest) || !Array.isArray(files) || files.length === 0 || files.length > MAX_FILES || completeness !== 'unverified') {
      throw new Error();
    }
    const number = ownDataProperty(pullRequest, 'number');
    const baseSha = ownDataProperty(pullRequest, 'baseSha');
    const headSha = ownDataProperty(pullRequest, 'headSha');
    if (
      typeof number !== 'number' || !Number.isSafeInteger(number) || number !== expectedNumber ||
      typeof baseSha !== 'string' || !COMMIT_SHA_PATTERN.test(baseSha) ||
      typeof headSha !== 'string' || !COMMIT_SHA_PATTERN.test(headSha)
    ) throw new Error();

    const seen = new Set<string>();
    const parsedFiles: PreparedPullRequestFile[] = [];
    for (const rawFile of files) {
      if (!isRecord(rawFile) || Object.hasOwn(rawFile, 'patch')) throw new Error();
      const filename = ownDataProperty(rawFile, 'filename');
      if (
        typeof filename !== 'string' || filename.length === 0 || filename.length > MAX_FILENAME_LENGTH ||
        /[\x00-\x1f\x7f]/.test(filename) || seen.has(filename)
      ) throw new Error();
      seen.add(filename);
      parsedFiles.push(Object.freeze({ filename }));
    }
    return Object.freeze({
      pullRequest: Object.freeze({ number, baseSha: baseSha.toLowerCase(), headSha: headSha.toLowerCase() }),
      files: Object.freeze(parsedFiles),
      completeness: 'unverified',
    });
  } catch {
    throw new Error('Invalid prepared pull request input response');
  }
}
