# Vendored terminfo sources

`deploy/termag-terminfo-setup` compiles these with `tic -x` into a box's
`/etc/terminfo`, for terminals Ubuntu 24.04's ncurses has no entry for. It
refuses a file whose sha256 is not the one pinned in the script.

## ghostty.terminfo

Ghostty's own entry (`xterm-ghostty|ghostty|Ghostty`), from
[Ghostty](https://github.com/ghostty-org/ghostty) **v1.4.0** (tag commit
`83fb95624b0439ee660c2679b43b38c8b63769cd`), MIT-licensed:
[`LICENSE.ghostty`](LICENSE.ghostty) is that release's `LICENSE`.

Ghostty keeps its terminfo in Zig (`src/terminfo/ghostty.zig`) and its build
writes the source with `Source.encode`. The file here is exactly that output,
made from the release tarball with the Zig the release asks for:

- `https://release.files.ghostty.org/1.4.0/ghostty-1.4.0.tar.gz`, sha256
  `cb188ac6c3a8278d5fd7bfef15d8c017104c87f638b5560eb38024a71ae0f005`
- Zig 0.17.0 (`build.zig.zon`'s `minimum_zig_version`)
- `ghostty.terminfo` sha256
  `e5e9cc4e9fddf6aab3088b40ec42fafe8309ef1ae5d3764d0bbf2fc44105ccf0`

To regenerate it (for a newer release, then update the pin in
`termag-terminfo-setup` and the versions above), save this as `gen.zig`
outside the extracted tarball:

```zig
const std = @import("std");
const terminfo = @import("terminfo");

pub fn main(init: std.process.Init) !void {
    var buffer: [1024]u8 = undefined;
    var stdout_writer = std.Io.File.stdout().writerStreaming(init.io, &buffer);
    try terminfo.ghostty.encode(&stdout_writer.interface);
    try stdout_writer.end();
}
```

and run, with `<src>` the extracted `ghostty-1.4.0`:

```sh
zig run --dep terminfo -Mroot=gen.zig -Mterminfo=<src>/src/terminfo/main.zig > ghostty.terminfo
```

This is what Ghostty's build runs (`src/main_build_data.zig`, `+terminfo`):
`src/terminfo/` imports nothing but `std`. Ghostty's build then installs it
with the same `tic -x`.

kitty (`xterm-kitty`) and WezTerm (`wezterm`) are not vendored: Ubuntu's
`kitty-terminfo` and `ncurses-term` packages carry them, and the bake installs
both.
