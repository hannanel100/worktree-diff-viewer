// One RepoService per process, bound to the directory the CLI was started in.
// The CLI sets WTDIFF_CWD before starting Next; `next dev` falls back to the
// current directory so contributors can run it inside any repository.

import { RepoService } from './repo-service';

let servicePromise: Promise<RepoService> | null = null;
let boundCwd: string | null = null;

export function repoCwd(): string {
  return process.env.WTDIFF_CWD || process.cwd();
}

export function getRepoService(): Promise<RepoService> {
  const cwd = repoCwd();
  if (!servicePromise || boundCwd !== cwd) {
    boundCwd = cwd;
    servicePromise = RepoService.open(cwd).catch((err) => {
      servicePromise = null;
      throw err;
    });
  }
  return servicePromise;
}

export function resetRepoService(): void {
  servicePromise = null;
  boundCwd = null;
}
