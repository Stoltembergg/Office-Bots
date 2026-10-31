import { createGitHubAppPullRequestsLoader } from './github-app-pull-requests.js';
import { createGitHubAppReviewInputLoader } from './github-app-review-input.js';
import { createGitHubAppPullRequestsAdapter } from './github-app-pull-requests-adapter.js';
import {
  createGitHubAppRepositoriesRuntime,
  type GitHubAppRepositoriesRuntimeOptions,
} from './github-app-repositories-runtime.js';

export class GitHubAppPullRequestsConfigurationError extends Error {
  constructor() {
    super('GitHub App pull request access is not configured');
    this.name = 'GitHubAppPullRequestsConfigurationError';
  }
}

export type GitHubAppPullRequestsRuntime = ReturnType<typeof createGitHubAppRepositoriesRuntime> & {
  readonly loader: ReturnType<typeof createGitHubAppPullRequestsLoader>;
  readonly reviewInputLoader: ReturnType<typeof createGitHubAppReviewInputLoader>;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GitHubAppPullRequestsConfigurationError();
  }
  return value;
}

/** Adds per-repository, read-only GitHub App access to the existing server-only Office runtime. */
export function createGitHubAppPullRequestsRuntime(
  env: NodeJS.ProcessEnv = process.env,
  options: GitHubAppRepositoriesRuntimeOptions = {},
): GitHubAppPullRequestsRuntime {
  try {
    const repositoriesRuntime = createGitHubAppRepositoriesRuntime(env, options);
    const appId = required(env, 'GITHUB_APP_ID');
    const privateKey = required(env, 'GITHUB_APP_PRIVATE_KEY');
    const github = createGitHubAppPullRequestsAdapter({
      appId,
      privateKey,
      fetch: options.fetch,
      now: options.now,
    });
    const loader = createGitHubAppPullRequestsLoader({
      sessions: repositoriesRuntime.sessions,
      repositoriesStore: repositoriesRuntime.repositoriesStore,
      github,
    });
    const reviewInputLoader = createGitHubAppReviewInputLoader({
      sessions: repositoriesRuntime.sessions,
      repositoriesStore: repositoriesRuntime.repositoriesStore,
      github,
    });
    return Object.freeze({ ...repositoriesRuntime, loader, reviewInputLoader });
  } catch {
    throw new GitHubAppPullRequestsConfigurationError();
  }
}
