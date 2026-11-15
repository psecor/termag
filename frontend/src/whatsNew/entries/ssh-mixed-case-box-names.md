---
title: SSH reaches boxes with capitals in their names
surface: termag
category: fixed
date: 2026-11-13
---
`ssh termag-<box>`, and opening a box in VS Code or Cursor, failed for a box with capitals in its name. Run `termag ssh-config --install` again: each box's entry now names the box by its instance id, so ssh always reaches the right one.
