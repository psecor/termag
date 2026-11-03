// termag desktop's links (the T3 Code fork).
//
// A pull request: the desktop reads `t3code://new?pr=<PR URL>` itself. It opens
// the PR's thread if it has one, else offers to check the PR out in a new
// worktree of the project on its repository, or to clone the repository first.
// Nothing runs on the PR's code until the person agrees.
//
// A session's project: `t3code://termag/projects/<id>` (the fork's
// TermagProjectLinkDialog). The desktop finds the project's box, asks before
// starting or reconnecting it, opens a new thread in the project, and offers
// to import its termag chats. It opens the project's own checkout, and the
// import reads that checkout's chats only, so only main's sessions offer it;
// a collaborator's shared project isn't on their boxes, so theirs don't.

/** The termag desktop link that opens `repo`'s PR `number`. */
export function desktopPrHref(repo: string, number: number): string {
  return `t3code://new?${new URLSearchParams({ pr: `https://github.com/${repo}/pull/${number}` }).toString()}`;
}

/** The termag desktop link that opens a session's project, or null where the desktop can't. */
export function desktopSessionHref(session: { projectId: string; workstream: string; shared: boolean }): string | null {
  if (session.shared || session.workstream !== 'main') return null;
  return `t3code://termag/projects/${encodeURIComponent(session.projectId)}`;
}

/**
 * Follows a desktop link from a menu that runs a callback rather than
 * rendering a link: as a link click, so the browser hands the scheme to its
 * handler and the page stays.
 */
export function openDesktopLink(href: string): void {
  const link = document.createElement('a');
  link.href = href;
  link.click();
}
