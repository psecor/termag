// Sections that expand one at a time (or several, with allowsMultipleExpanded):
// LaunchPad's DisclosureGroup of Disclosures. Each section's trigger is the
// Disclosure component's (registry.tsx DisclosureEl): a heading holding a
// minimal Button with a chevron. Child N is section N's panel, as in Tabs.
import React from 'react';
import { Button, Disclosure, DisclosureGroup, DisclosurePanel, Heading } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { z } from 'zod';
import { defineGenUiComponent } from './index';
import './Accordion.css';

const id = z.string().min(1).max(100);

const props = z.object({
  sections: z.array(z.object({ id, title: z.string().min(1).max(200) })).min(1).max(12),
  allowsMultipleExpanded: z.boolean().optional(),
  defaultExpanded: z.array(id).max(12).optional(),
}).refine(p => new Set(p.sections.map(s => s.id)).size === p.sections.length, { message: 'every section needs its own id', path: ['sections'] });

export default defineGenUiComponent({
  name: 'Accordion',
  props,
  slots: ['default'],
  description: 'Several titled sections stacked in one box, each opening to show its panel: child N is the panel for sections[N]. Only one is open at a time unless allowsMultipleExpanded; defaultExpanded lists the ids open at first (none by default). Use it for related detail the person reads a part at a time (FAQ, per-step notes, per-file findings); use Tabs to switch between whole views, and a Disclosure for a single section.',
  Component: ({ props: p, children }) => {
    const panels = React.Children.toArray(children);
    const open = p.allowsMultipleExpanded ? p.defaultExpanded : p.defaultExpanded?.slice(0, 1);
    return (
      <DisclosureGroup className="genui-accordion" allowsMultipleExpanded={p.allowsMultipleExpanded} defaultExpandedKeys={open}>
        {p.sections.map((s, i) => (
          <Disclosure key={s.id} id={s.id} className="genui-accordion-section">
            {({ isExpanded }) => (
              <>
                <Heading level={5} className="genui-accordion-head">
                  <Button slot="trigger" variant="minimal" className="genui-accordion-trigger">
                    <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size="small" />
                    {s.title}
                  </Button>
                </Heading>
                <DisclosurePanel className="genui-accordion-panel">{panels[i] ?? null}</DisclosurePanel>
              </>
            )}
          </Disclosure>
        ))}
      </DisclosureGroup>
    );
  },
});
