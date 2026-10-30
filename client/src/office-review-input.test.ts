import { describe, expect, it } from 'vitest';
import { readPreparedReviewInputResponse } from './office-review-input';

const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);

function response(overrides: Record<string, unknown> = {}) {
  return {
    pullRequest: { number: 17, baseSha: BASE_SHA, headSha: HEAD_SHA },
    files: [{ filename: 'src/example.ts' }],
    completeness: 'unverified',
    ...overrides,
  };
}

describe('prepared pull request input response parser', () => {
  it('accepts bounded filenames and pinned PR refs without patch contents', () => {
    expect(readPreparedReviewInputResponse(response(), 17)).toEqual({
      pullRequest: { number: 17, baseSha: BASE_SHA, headSha: HEAD_SHA },
      files: [{ filename: 'src/example.ts' }],
      completeness: 'unverified',
    });
  });

  it('rejects patch data, mismatched refs, duplicate files, and excessive lists', () => {
    expect(() => readPreparedReviewInputResponse(response({ files: [{ filename: 'a.ts', patch: '+secret' }] }), 17)).toThrow();
    expect(() => readPreparedReviewInputResponse(response(), 18)).toThrow();
    expect(() => readPreparedReviewInputResponse(response({ files: [{ filename: 'same.ts' }, { filename: 'same.ts' }] }), 17)).toThrow();
    expect(() => readPreparedReviewInputResponse(response({ files: Array.from({ length: 301 }, (_, index) => ({ filename: `file-${index}.ts` })) }), 17)).toThrow();
  });

  it('rejects malformed paths and unverified refs', () => {
    expect(() => readPreparedReviewInputResponse(response({ files: [{ filename: '' }] }), 17)).toThrow();
    expect(() => readPreparedReviewInputResponse(response({ completeness: 'verified' }), 17)).toThrow();
    expect(() => readPreparedReviewInputResponse(response({ pullRequest: { number: 17, baseSha: 'short', headSha: HEAD_SHA } }), 17)).toThrow();
  });
});
