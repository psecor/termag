/**
 * GET and PUT /api/cli/v1/dotfiles: the dotfiles repository web Settings saves
 * (PUT /auth/me/preferences' dotfilesRepoUrl), for the desktop's Settings →
 * Dotfiles. The same parseDotfilesRepoUrl checks and normalizes it. `newBoxes`
 * is whether every new box of the person's applies it (onboarding-refresh-
 * enabled), or only boxes claimed from the warm pool, which is what Settings'
 * wording follows. Reads are open to a box's own token, as the credential
 * reads are; the write takes a device sign-in only (403): a box clones the
 * repository and runs its installer, so a box's own token never changes it.
 * The Prisma implementation is services/cliDotfilesPrisma.ts.
 */
import type { RequestHandler, Response, Router } from 'express';
import { asyncHandler } from '../middleware/errors';
import { parseDotfilesRepoUrl } from '../services/dotfilesUrl';
import type { CliAuth } from './cliApi';

export interface CliDotfiles {
  read(userId: string): Promise<{ dotfilesRepoUrl: string | null; newBoxes: boolean }>;
  /** Stores an already-normalized URL, or null to clear it. */
  save(userId: string, url: string | null): Promise<void>;
}

const DEVICE_ONLY = {
  error: "A box's own credentials cannot change your dotfiles repository; run this on your laptop after `termag login`",
  code: 'box_credential',
};

function cliAuth(res: Response): CliAuth {
  return res.locals.cliAuth as CliAuth;
}

export function mountCliDotfilesRoutes(router: Router, deps: CliDotfiles, bearer: RequestHandler): void {
  router.get('/dotfiles', bearer, asyncHandler(async (_req, res) => {
    res.json(await deps.read(cliAuth(res).user.id));
  }));

  router.put('/dotfiles', bearer, asyncHandler(async (req, res) => {
    const { user, credential } = cliAuth(res);
    if (credential.kind !== 'device') { res.status(403).json(DEVICE_ONLY); return; }
    const parsed = parseDotfilesRepoUrl((req.body as { dotfilesRepoUrl?: unknown })?.dotfilesRepoUrl);
    if (!parsed.ok) { res.status(400).json({ error: parsed.error, code: 'invalid_dotfiles_url' }); return; }
    await deps.save(user.id, parsed.value);
    res.json({ dotfilesRepoUrl: parsed.value });
  }));
}
