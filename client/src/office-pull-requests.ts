const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/i;

export interface PullRequestPickerItem {
  readonly number: number;
  readonly title: string;
  readonly draft: boolean;
  readonly updatedAt: string;
  readonly headSha: string;
  readonly htmlUrl: string;
}

export interface PullRequestPickerResponse {
  readonly pullRequests: readonly PullRequestPickerItem[];
  readonly hasMore: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function validRepositoryFullName(value: string): boolean {
  if (!REPOSITORY_NAME_PATTERN.test(value)) return false;
  const [owner, repository] = value.split('/');
  return owner !== '.' && owner !== '..' && repository !== '.' && repository !== '..';
}

function validUpdatedAt(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

/** Validates API data before a PR title or URL is placed in a DOM node. */
export function readPullRequestPickerResponse(value: unknown, expectedRepository: string): PullRequestPickerResponse {
  if (!validRepositoryFullName(expectedRepository) || !isRecord(value)) throw new Error('Invalid pull request response');
  const repositoryFullName = ownDataProperty(value, 'repositoryFullName');
  const pullRequests = ownDataProperty(value, 'pullRequests');
  const hasMore = ownDataProperty(value, 'hasMore');
  if (
    repositoryFullName !== expectedRepository ||
    !Array.isArray(pullRequests) ||
    pullRequests.length > 100 ||
    typeof hasMore !== 'boolean'
  ) {
    throw new Error('Invalid pull request response');
  }
  const numbers = new Set<number>();
  const result: PullRequestPickerItem[] = [];
  for (const rawPullRequest of pullRequests) {
    if (!isRecord(rawPullRequest)) throw new Error('Invalid pull request response');
    const number = ownDataProperty(rawPullRequest, 'number');
    const title = ownDataProperty(rawPullRequest, 'title');
    const draft = ownDataProperty(rawPullRequest, 'draft');
    const updatedAt = ownDataProperty(rawPullRequest, 'updatedAt');
    const headSha = ownDataProperty(rawPullRequest, 'headSha');
    const htmlUrl = ownDataProperty(rawPullRequest, 'htmlUrl');
    if (
      typeof number !== 'number' ||
      !Number.isSafeInteger(number) ||
      number < 1 ||
      numbers.has(number) ||
      typeof title !== 'string' ||
      title.length === 0 ||
      title.length > 512 ||
      /[\x00-\x1f\x7f]/.test(title) ||
      typeof draft !== 'boolean' ||
      !validUpdatedAt(updatedAt) ||
      typeof headSha !== 'string' ||
      !COMMIT_SHA_PATTERN.test(headSha) ||
      htmlUrl !== `https://github.com/${expectedRepository}/pull/${number}`
    ) {
      throw new Error('Invalid pull request response');
    }
    numbers.add(number);
    result.push(Object.freeze({ number, title, draft, updatedAt, headSha: headSha.toLowerCase(), htmlUrl }));
  }
  return Object.freeze({ pullRequests: Object.freeze(result), hasMore });
}
