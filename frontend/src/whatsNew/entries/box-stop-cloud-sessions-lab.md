---
title: Stopping a box asks first when cloud sessions run on it
surface: lab
category: changed
date: 2026-11-06
flag: box-stop-cloud-session-guard-enabled
---
Stop on a box running your Claude Code cloud sessions now says the stop ends them, and asks again before it goes ahead. `termag box stop <box> --force` does the same from the command line; an agent on a box can't force it.
