import { describe, expect, it } from 'vitest';
import { readPullRequestPickerResponse } from './office-pull-requests';

const REPOSITORY = 'octo/example';
const SHA = 'a'.repeat(40);

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    number: 17,
    title: 'Add safer parser',
    draft: false,
    updatedAt: '2026-10-30T20:00:00Z',
    headSha: SHA,
    htmlUrl: 'https://github.com/octo/example/pull/17',
    ...overrides,
  };
}

describe('pull request picker response parser', () => {
  it('accepts bounded metadata for the selected repository', () => {
    expect(readPullRequestPickerResponse({
      repositoryFullName: REPOSITORY,
      pullRequests: [pullRequest()],
      hasMore: true,
    }, REPOSITORY)).toEqual({
      pullRequests: [pullRequest()],
      hasMore: true,
    });
  });

  it('rejects untrusted or cross-repository links, duplicates, and oversized lists', () => {
    expect(() => readPullRequestPickerResponse({
      repositoryFullName: REPOSITORY,
      pullRequests: [pullRequest({ htmlUrl: 'https://attacker.example/pull/17' })],
      hasMore: false,
    }, REPOSITORY)).toThrow();
    expect(() => readPullRequestPickerResponse({
      repositoryFullName: REPOSITORY,
      pullRequests: [pullRequest(), pullRequest()],
      hasMore: false,
    }, REPOSITORY)).toThrow();
    expect(() => readPullRequestPickerResponse({
      repositoryFullName: 'another/repository',
      pullRequests: [],
      hasMore: false,
    }, REPOSITORY)).toThrow();
    expect(() => readPullRequestPickerResponse({
      repositoryFullName: REPOSITORY,
      pullRequests: Array.from({ length: 101 }, (_, index) => pullRequest({ number: index + 1 })),
      hasMore: false,
    }, REPOSITORY)).toThrow();
  });

  it('rejects malformed titles instead of relying on HTML interpolation', () => {
    expect(() => readPullRequestPickerResponse({
      repositoryFullName: REPOSITORY,
      pullRequests: [pullRequest({ title: 'bad\nlabel' })],
      hasMore: false,
    }, REPOSITORY)).toThrow();
  });
});
