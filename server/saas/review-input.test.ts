import { describe, expect, it, vi } from 'vitest';
import {
  createReviewInputLoader,
  REVIEW_INPUT_LIMITS,
  ReviewInputError,
  type ReviewInputAccessRequest,
  type ReviewInputGitHubAdapter,
  type ReviewInputSessionAuthenticator,
} from './review-input';

const USER_A = '101';
const USER_B = '202';
const INSTALLATION_ID = '303';
const REPOSITORY_ID = '404';
const OTHER_REPOSITORY_ID = '405';
const PULL_NUMBER = 17;
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const SESSION_A = 'synthetic-session-A';
const SESSION_B = 'synthetic-session-B';

type TestOverrides = {
  readonly authenticateSession?: ReviewInputSessionAuthenticator['authenticateSession'];
  readonly validateRepositoryAccess?: ReviewInputGitHubAdapter['validateRepositoryAccess'];
  readonly getPullRequest?: ReviewInputGitHubAdapter['getPullRequest'];
  readonly listPullRequestFiles?: ReviewInputGitHubAdapter['listPullRequestFiles'];
};

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    repositoryId: REPOSITORY_ID,
    number: PULL_NUMBER,
    base: { sha: BASE_SHA },
    head: { sha: HEAD_SHA },
    ...overrides,
  };
}

function file(filename = 'src/example.ts', patch = '@@ -1 +1 @@\n-old\n+new') {
  return { filename, patch };
}

function page(
  pageNumber: number,
  files: readonly unknown[] = [file()],
  overrides: Record<string, unknown> = {},
) {
  return {
    repositoryId: REPOSITORY_ID,
    pullNumber: PULL_NUMBER,
    page: pageNumber,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    files,
    hasNextPage: false,
    ...overrides,
  };
}

function createTestLoader(overrides: TestOverrides = {}) {
  const sessionAuthenticator: ReviewInputSessionAuthenticator = {
    authenticateSession:
      overrides.authenticateSession ??
      vi.fn(async (credential: unknown) => ({ githubUserId: credential === SESSION_B ? USER_B : USER_A })),
  };
  const github: ReviewInputGitHubAdapter = {
    validateRepositoryAccess:
      overrides.validateRepositoryAccess ??
      vi.fn(async (input: ReviewInputAccessRequest) => ({ authorized: true, ...input })),
    getPullRequest: overrides.getPullRequest ?? vi.fn(async () => pullRequest()),
    listPullRequestFiles: overrides.listPullRequestFiles ?? vi.fn(async ({ page: pageNumber }) => page(pageNumber)),
  };
  const loader = createReviewInputLoader({ sessionAuthenticator, github });
  return { loader, sessionAuthenticator, github };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    sessionCredential: SESSION_A,
    installationId: INSTALLATION_ID,
    repositoryId: REPOSITORY_ID,
    pullNumber: PULL_NUMBER,
    ...overrides,
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<unknown> {
  const failure = await promise.catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ReviewInputError);
  expect(failure).toMatchObject({ code });
  return failure;
}

describe('domínio de entrada de revisão manual de PR', () => {
  it('retorna patches com referências de leitura e completude não verificada', async () => {
    const { loader, sessionAuthenticator, github } = createTestLoader();

    const result = await loader.load(request());

    expect(result).toEqual({
      githubUserId: USER_A,
      installationId: INSTALLATION_ID,
      repositoryId: REPOSITORY_ID,
      pullRequest: { number: PULL_NUMBER, baseSha: BASE_SHA, headSha: HEAD_SHA },
      files: [file()],
      completeness: 'unverified',
    });
    expect(result).not.toHaveProperty('diffComplete');
    expect(sessionAuthenticator.authenticateSession).toHaveBeenCalledTimes(3);
    expect(github.validateRepositoryAccess).toHaveBeenCalledTimes(3);
    expect(github.validateRepositoryAccess).toHaveBeenCalledWith({
      githubUserId: USER_A,
      installationId: INSTALLATION_ID,
      repositoryId: REPOSITORY_ID,
    });
    expect(github.getPullRequest).toHaveBeenCalledTimes(2);
    expect(github.listPullRequestFiles).toHaveBeenCalledWith({
      installationId: INSTALLATION_ID,
      repositoryId: REPOSITORY_ID,
      pullNumber: PULL_NUMBER,
      page: 1,
      perPage: REVIEW_INPUT_LIMITS.pageSize,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
    });
  });

  it('não autoriza usuário B usando uma instalação/repositório liberados para usuário A', async () => {
    const { loader, github } = createTestLoader({
      validateRepositoryAccess: vi.fn(async (input: ReviewInputAccessRequest) => ({
        authorized: input.githubUserId === USER_A,
        ...input,
      })),
    });

    await expectCode(loader.load(request({ sessionCredential: SESSION_B })), 'forbidden');
    expect(github.getPullRequest).not.toHaveBeenCalled();
    expect(github.listPullRequestFiles).not.toHaveBeenCalled();
  });

  it.each([
    ['installation ID não autorizado', { installationId: '999' }],
    ['repository ID não autorizado', { repositoryId: OTHER_REPOSITORY_ID }],
  ])('nega %s sem confiar no ID do cliente', async (_label, requestOverrides) => {
    const { loader, github } = createTestLoader({
      validateRepositoryAccess: vi.fn(async (input: ReviewInputAccessRequest) => ({
        authorized: input.installationId === INSTALLATION_ID && input.repositoryId === REPOSITORY_ID,
        ...input,
      })),
    });

    await expectCode(loader.load(request(requestOverrides)), 'forbidden');
    expect(github.getPullRequest).not.toHaveBeenCalled();
  });

  it('nega uma resposta de autorização vinculada a outro usuário, instalação ou repositório', async () => {
    const wrongTuple: ReviewInputAccessRequest = {
      githubUserId: USER_B,
      installationId: INSTALLATION_ID,
      repositoryId: REPOSITORY_ID,
    };
    const { loader, github } = createTestLoader({
      validateRepositoryAccess: vi.fn(async () => ({ authorized: true, ...wrongTuple })),
    });

    await expectCode(loader.load(request()), 'forbidden');
    expect(github.getPullRequest).not.toHaveBeenCalled();
  });

  it('falha se a identidade da sessão mudar entre a leitura do PR e a dos arquivos', async () => {
    const authenticateSession = vi
      .fn<ReviewInputSessionAuthenticator['authenticateSession']>()
      .mockResolvedValueOnce({ githubUserId: USER_A })
      .mockResolvedValueOnce({ githubUserId: USER_B });
    const { loader, github } = createTestLoader({ authenticateSession });

    await expectCode(loader.load(request()), 'unauthenticated');
    expect(github.getPullRequest).toHaveBeenCalledTimes(1);
    expect(github.listPullRequestFiles).not.toHaveBeenCalled();
  });

  it('falha fechado para sessão ausente, inválida ou com erro sem expor detalhes', async () => {
    const invalid = createTestLoader({
      authenticateSession: vi.fn(async () => ({ githubUserId: '000101' })),
    });
    await expectCode(invalid.loader.load(request()), 'unauthenticated');
    expect(invalid.github.getPullRequest).not.toHaveBeenCalled();

    const throwing = createTestLoader({
      authenticateSession: vi.fn(async () => {
        throw new Error('synthetic private session token');
      }),
    });
    const failure = await expectCode(throwing.loader.load(request()), 'unauthenticated');
    expect((failure as Error).message).not.toContain('synthetic private session token');
    expect(throwing.github.getPullRequest).not.toHaveBeenCalled();
  });

  it('rejeita PR que pertence a outro repositório ou não corresponde ao número solicitado', async () => {
    const wrongRepository = createTestLoader({
      getPullRequest: vi.fn(async () => pullRequest({ repositoryId: OTHER_REPOSITORY_ID })),
    });
    await expectCode(wrongRepository.loader.load(request()), 'invalid_upstream_data');
    expect(wrongRepository.github.listPullRequestFiles).not.toHaveBeenCalled();

    const wrongNumber = createTestLoader({
      getPullRequest: vi.fn(async () => pullRequest({ number: PULL_NUMBER + 1 })),
    });
    await expectCode(wrongNumber.loader.load(request()), 'invalid_upstream_data');
  });

  it('rejeita PR incompleto, SHAs inválidos e resposta malformada', async () => {
    for (const malformed of [
      { ...pullRequest(), base: undefined },
      pullRequest({ head: { sha: 'not-a-commit' } }),
      null,
    ]) {
      const { loader, github } = createTestLoader({
        getPullRequest: vi.fn(async () => malformed),
      });
      await expectCode(loader.load(request()), 'incomplete_pull_request');
      expect(github.listPullRequestFiles).not.toHaveBeenCalled();
    }
  });

  it('rejeita página vinculada a outros SHAs, repo, PR ou página', async () => {
    const mismatches = [
      { headSha: 'c'.repeat(40) },
      { baseSha: 'd'.repeat(40) },
      { repositoryId: OTHER_REPOSITORY_ID },
      { pullNumber: PULL_NUMBER + 1 },
      { page: 2 },
    ];
    for (const mismatch of mismatches) {
      const { loader, github } = createTestLoader({
        listPullRequestFiles: vi.fn(async () => page(1, [file()], mismatch)),
      });
      await expectCode(loader.load(request()), 'pull_request_changed');
      expect(github.getPullRequest).toHaveBeenCalledTimes(1);
    }
  });

  it('rejeita quando base/head mudam durante a paginação', async () => {
    const getPullRequest = vi
      .fn<ReviewInputGitHubAdapter['getPullRequest']>()
      .mockResolvedValueOnce(pullRequest())
      .mockResolvedValueOnce(pullRequest({ head: { sha: 'c'.repeat(40) } }));
    const { loader } = createTestLoader({ getPullRequest });

    await expectCode(loader.load(request()), 'pull_request_changed');
    expect(getPullRequest).toHaveBeenCalledTimes(2);
  });

  it('nega o resultado se a autorização do repositório for revogada durante a paginação', async () => {
    const validateRepositoryAccess = vi
      .fn<ReviewInputGitHubAdapter['validateRepositoryAccess']>()
      .mockResolvedValueOnce({ authorized: true, githubUserId: USER_A, installationId: INSTALLATION_ID, repositoryId: REPOSITORY_ID })
      .mockResolvedValueOnce({ authorized: false, githubUserId: USER_A, installationId: INSTALLATION_ID, repositoryId: REPOSITORY_ID });
    const { loader, github } = createTestLoader({ validateRepositoryAccess });

    await expectCode(loader.load(request()), 'forbidden');
    expect(github.listPullRequestFiles).not.toHaveBeenCalled();
    expect(github.getPullRequest).toHaveBeenCalledTimes(1);
  });

  it('falha fechado se falta patch, se o patch é vazio ou se o upstream é malformado', async () => {
    for (const files of [[{ filename: 'src/no-patch.ts' }], [file('src/empty.ts', '')], [null]]) {
      const { loader } = createTestLoader({
        listPullRequestFiles: vi.fn(async () => page(1, files)),
      });
      await expectCode(loader.load(request()), files[0] === null ? 'invalid_upstream_data' : 'missing_patch');
    }
  });

  it('não aceita lista vazia como diff completo', async () => {
    const { loader } = createTestLoader({
      listPullRequestFiles: vi.fn(async () => page(1, [])),
    });

    await expectCode(loader.load(request()), 'incomplete_pull_request');
  });

  it('limita bytes, arquivos e páginas sem devolver um resultado parcial', async () => {
    const oversizedPatch = 'x'.repeat(REVIEW_INPUT_LIMITS.maxBytes + 1);
    const tooManyBytes = createTestLoader({
      listPullRequestFiles: vi.fn(async () => page(1, [file('large.txt', oversizedPatch)])),
    });
    await expectCode(tooManyBytes.loader.load(request()), 'limit_exceeded');

    const tooManyFiles = createTestLoader({
      listPullRequestFiles: vi.fn(async ({ page: pageNumber }) =>
        page(
          pageNumber,
          Array.from({ length: REVIEW_INPUT_LIMITS.pageSize }, (_, index) =>
            file(`src/file-${pageNumber}-${index}.ts`, '+x'),
          ),
          { hasNextPage: true },
        ),
      ),
    });
    await expectCode(tooManyFiles.loader.load(request()), 'limit_exceeded');
    expect(tooManyFiles.github.listPullRequestFiles).toHaveBeenCalledTimes(3);

    const tooManyPages = createTestLoader({
      listPullRequestFiles: vi.fn(async ({ page: pageNumber }) => page(pageNumber, [file(`file-${pageNumber}.ts`, '+x')], {
        hasNextPage: true,
      })),
    });
    await expectCode(tooManyPages.loader.load(request()), 'limit_exceeded');
    expect(tooManyPages.github.listPullRequestFiles).toHaveBeenCalledTimes(REVIEW_INPUT_LIMITS.maxPages);
  });

  it('falha em erro de cada adaptador sem expor conteúdo privado nem permitir leitura após falha', async () => {
    const accessFailure = createTestLoader({
      validateRepositoryAccess: vi.fn(async () => {
        throw new Error('synthetic private GitHub response');
      }),
    });
    const accessError = await expectCode(accessFailure.loader.load(request()), 'adapter_failure');
    expect((accessError as Error).message).not.toContain('synthetic private GitHub response');
    expect(accessFailure.github.getPullRequest).not.toHaveBeenCalled();

    const pullFailure = createTestLoader({
      getPullRequest: vi.fn(async () => {
        throw new Error('synthetic private PR body');
      }),
    });
    await expectCode(pullFailure.loader.load(request()), 'adapter_failure');
    expect(pullFailure.github.listPullRequestFiles).not.toHaveBeenCalled();

    const filesFailure = createTestLoader({
      listPullRequestFiles: vi.fn(async () => {
        throw new Error('synthetic private patch');
      }),
    });
    const filesError = await expectCode(filesFailure.loader.load(request()), 'adapter_failure');
    expect((filesError as Error).message).not.toContain('synthetic private patch');
    expect(filesFailure.github.getPullRequest).toHaveBeenCalledTimes(1);
  });

  it('não chama adaptadores para identificadores não estáveis ou requisição malformada', async () => {
    const { loader, sessionAuthenticator, github } = createTestLoader();
    for (const invalid of [
      { installationId: '000303' },
      { repositoryId: 404 },
      { pullNumber: 0 },
      { sessionCredential: '' },
      null,
    ]) {
      await expectCode(loader.load(invalid as never), 'invalid_request');
    }
    expect(sessionAuthenticator.authenticateSession).not.toHaveBeenCalled();
    expect(github.validateRepositoryAccess).not.toHaveBeenCalled();
  });
});
