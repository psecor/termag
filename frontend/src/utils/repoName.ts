/** Repo basename, sanitised the way the server's suggestProjectName does. Shared by the Welcome wizard and the phone's New project form. */
export function nameFromRepo(url: string): string {
  const m = /([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  const base = (m?.[1] ?? 'project').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
  return base || 'project';
}
