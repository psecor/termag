/** What saving the dotfiles repository says, given the URL now stored (null when cleared). */
export function dotfilesNotice(saved: string | null): string {
  return saved
    ? `Saved. Boxes you claim from now on apply ${saved}; boxes you already have are not changed.`
    : 'Cleared. Boxes you claim from now on get no dotfiles.';
}
