import { useLayoutEffect } from 'react';
import { FLAGS, useFlag } from '../../flags';
import { useTheme } from '../ThemeProvider';
import { applyDailyTheme } from './applyDailyTheme';
import { DailyDecor } from './DailyDecor';
import { useDailyTheme } from './useDailyTheme';

/**
 * Theme of the day: today's dated reskin, for a person
 * who turned it on in Settings → Appearance while daily-theme-enabled is on.
 * Mounted once per page, inside its flag provider: the full UI's
 * MainLayout, the simple UI's ChatApp, and Settings (where it is turned on). `suppressSprite` keeps the
 * day's sprite off while the Thanksgiving turkeys fly: they win. The flag is
 * the kill switch for all of it, ?dailyTheme= previews included.
 */
export function DailyThemeLayer({ suppressSprite = false }: { suppressSprite?: boolean }) {
  const enabled = useFlag(FLAGS.dailyTheme, false);
  const { theme } = useTheme();
  const { theme: daily } = useDailyTheme(enabled, theme.dailyTheme === true);
  // Before paint, so a page switch (another mount of this layer) never shows a
  // frame without the day's CSS.
  useLayoutEffect(() => (daily ? applyDailyTheme(daily) : undefined), [daily]);
  if (!daily?.sprite || suppressSprite) return null;
  return <DailyDecor source={daily.sprite} />;
}
