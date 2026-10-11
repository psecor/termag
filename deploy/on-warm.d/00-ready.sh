#!/bin/sh
# Warm-up work for a warm-pool box, run by termag-hook-run while the box is
# still unowned. termag ships none: add numbered scripts beside this one
# (10-*.sh, 20-*.sh, ...) for the slow work a claimed box should arrive with,
# such as pre-pulling container images or cloning large repositories.
echo "on-warm: nothing to prepare"
