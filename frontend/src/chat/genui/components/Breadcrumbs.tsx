// LaunchPad's Breadcrumbs, for display only: every item is a plain label (a
// spec has nowhere to send a click), and the last is where the reader is.
import React from 'react';
import { z } from 'zod';
import { Breadcrumb, Breadcrumbs } from '@launchpad-ui/components';
import { defineGenUiComponent } from './index';
import './Breadcrumbs.css';

const props = z.object({
  label: z.string().min(1).max(200).optional(),
  items: z.array(z.object({
    id: z.string().min(1).max(100),
    label: z.string().min(1).max(100),
  })).min(1).max(8),
});

function BreadcrumbsEl({ label, items }: z.infer<typeof props>) {
  // Collection keys must be unique, whatever ids the spec repeats: each is its place in the trail.
  const keyed = items.map((it, i) => ({ id: `${i}:${it.id}`, label: it.label }));
  return (
    // React Aria names every trail "Breadcrumbs"; two on a surface would read alike, so the spec may name it.
    <Breadcrumbs className="genui-breadcrumbs" aria-label={label ?? 'Location'}>
      {keyed.map(it => (
        <Breadcrumb key={it.id} id={it.id} className="genui-breadcrumbs-item">
          {({ isCurrent }) => (isCurrent ? <span aria-current="location">{it.label}</span> : it.label)}
        </Breadcrumb>
      ))}
    </Breadcrumbs>
  );
}

export default defineGenUiComponent({
  name: 'Breadcrumbs',
  props,
  description: 'Where something sits, as a trail of names from the top down to it (project, repo, folder, file; org, team, flag), the last being the thing itself. 1 to 8 items, each a unique id and a label; they are not links. label names the trail for screen readers (default "Location"; say what it locates when a surface has more than one). Put it at the top of a Card, above what it locates.',
  Component: ({ props: p }) => <BreadcrumbsEl {...p} />,
});
