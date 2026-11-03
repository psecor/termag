// LaunchPad's components ship one stylesheet for all of them
// (@launchpad-ui/components/dist/style.css, imported by its own index), and it
// starts with LaunchPad's page base: rules on html, *, body, [data-theme],
// h1-h3 and :root. Imported as is, those would restyle termag's whole app. The
// build serves that import through launchpadComponentsCss (vite.config.ts),
// which keeps every component's rules, each scoped to its CSS module's hashed
// classes ([hash]_[local]), and drops the rest, so any LaunchPad component
// can be used with nothing to register (docs/agents/gotchas.md, LaunchPad).
//
// Node-only: vite.config.ts runs it; nothing in the app imports it.
import postcss, { type AtRule, type ChildNode, type Container, type Rule } from 'postcss';

/**
 * The hashed prefix of every CSS module in the stylesheet: `DpiyKW` for
 * Slider's `.DpiyKW_slider`, `_1iK3oq` for Popover's `._1iK3oq_popover` (a
 * hash that would start with a digit gets a leading `_`). Throws when there is
 * none, so a LaunchPad release that changes the class scheme fails the build
 * instead of shipping every component unstyled.
 */
export function modulePrefixes(css: string): string[] {
  const prefixes = [...new Set([...css.matchAll(/\.(_?[A-Za-z0-9-]{6})_[A-Za-z]/g)].map(m => m[1]))];
  if (prefixes.length === 0) throw new Error('launchpadCss: no .<hash>_<local> classes in LaunchPad\'s stylesheet');
  return prefixes;
}

/**
 * The stylesheet with only the rules whose every selector names a LaunchPad
 * module's class. Page-wide rules, @font-face and @import go; @media and
 * @supports keep what is left inside them; @keyframes stay only when a kept
 * rule animates with them.
 */
export function launchpadComponentsCss(css: string): string {
  const prefixes = modulePrefixes(css);
  const scoped = (selector: string) => prefixes.some(p => selector.includes(`.${p}_`));
  const root = postcss.parse(css);
  const animations = new Set<string>();

  const prune = (container: Container) => {
    container.each((node: ChildNode) => {
      if (node.type === 'rule') {
        const rule = node as Rule;
        if (!rule.selectors.every(scoped)) { rule.remove(); return; }
        rule.walkDecls(/^animation(-name)?$/, decl => {
          for (const word of decl.value.split(/[\s,]+/)) animations.add(word);
        });
        return;
      }
      if (node.type === 'atrule') {
        const at = node as AtRule;
        if (at.name === 'keyframes') return;
        if (at.name === 'media' || at.name === 'supports' || at.name === 'container' || at.name === 'layer') {
          if (at.nodes) prune(at);
          if (!at.nodes?.length) at.remove();
          return;
        }
        at.remove();
        return;
      }
      if (node.type !== 'comment') node.remove();
    });
  };
  prune(root);
  root.walkAtRules('keyframes', at => { if (!animations.has(at.params)) at.remove(); });
  root.walkComments(c => { c.remove(); });
  return root.toString().trim() + '\n';
}
