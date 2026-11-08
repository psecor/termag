-- Each preview link gets its own origin, <name>--<hostSuffix>.<domain> (SR19,
-- decided 2026-11-06), so a Service Worker an earlier link's app left on a
-- reused name never sees a new link's code exchange. The default fills every
-- existing row with its own random suffix (a volatile default is evaluated per
-- row): six characters of base32 (a-z, 2-7), from md5 hex with the four digits
-- base32 lacks (0, 1, 8, 9) mapped to w, x, y, z. `db push` adds it the same
-- way. The app writes its own suffix for each new link.
ALTER TABLE "preview_links" ADD COLUMN "hostSuffix" TEXT NOT NULL DEFAULT substr(translate(md5((random())::text), '0189'::text, 'wxyz'::text), 1, 6);
