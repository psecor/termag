import type { DailyTheme } from './registry';

export const DAILY_THEME_STYLE_ATTR = 'data-daily-theme-style';

interface DailyRoot { dataset: Record<string, string | undefined> }

/**
 * Puts a day's theme on the page: html[data-daily-theme=<date>], which every
 * rule of its CSS is scoped under (lint.ts), and one <style> holding that CSS.
 * Returns the undo. The style goes last in <head>, so for equal specificity
 * the day wins over App.css and chrome.css, and its scope selector adds
 * specificity on top.
 */
export function applyDailyTheme(theme: DailyTheme, root: DailyRoot = document.documentElement, doc: Document = document): () => void {
  root.dataset.dailyTheme = theme.date;
  const style = doc.createElement('style');
  style.setAttribute(DAILY_THEME_STYLE_ATTR, theme.date);
  style.textContent = theme.css;
  doc.head.appendChild(style);
  return () => {
    style.remove();
    if (root.dataset.dailyTheme === theme.date) delete root.dataset.dailyTheme;
  };
}
