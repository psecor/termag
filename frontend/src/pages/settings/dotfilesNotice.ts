/**
 * What saving the dotfiles repository says, given the URL now stored (null
 * when cleared). `newBoxes`: onboarding-refresh-enabled, under which a box
 * launched for you applies them too, not only one claimed from the warm pool.
 *
 */
export function dotfilesNotice(saved: string | null, newBoxes = false): string {
  if (newBoxes) {
    return saved
      ? `Saved. Your new boxes apply ${saved}; boxes you already have are not changed.`
      : 'Cleared. Your new boxes get no dotfiles.';
  }
  return saved
    ? `Saved. Boxes you claim from now on apply ${saved}; boxes you already have are not changed.`
    : 'Cleared. Boxes you claim from now on get no dotfiles.';
}
