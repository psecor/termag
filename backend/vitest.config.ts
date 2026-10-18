import { defineConfig } from 'vitest/config';

// The tests are written against a deployment that names its GitHub orgs and
// its own termag repository. The product defaults are empty and the public
// repository (services/githubRepos.ts, services/prPipeline.ts), so set the
// fixtures' values here rather than in every test file.
export default defineConfig({
  test: {
    env: {
      GITHUB_REPO_ORGS: 'example-org,example-team',
      TERMAG_REPO: 'example-org/termag',
    },
  },
});
