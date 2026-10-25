#!/usr/bin/env python3
"""patch_ents.py <macho> <xml> <der>: rewrite a simulator binary's __TEXT,__entitlements and
__TEXT,__ents_der in place, moving __ents_der into the segment's zero padding."""
import struct, sys
path, xml_path, der_path = sys.argv[1:]
b = bytearray(open(path, 'rb').read())
xml, der = open(xml_path, 'rb').read(), open(der_path, 'rb').read()
magic, cpu, sub, ftype, ncmds, sizeofcmds, flags, _ = struct.unpack_from('<IiiIIIII', b, 0)
assert magic == 0xfeedfacf, 'thin 64-bit Mach-O only'
off = 32; secs = {}; text = None
for _ in range(ncmds):
    cmd, csize = struct.unpack_from('<II', b, off)
    if cmd == 0x19:  # LC_SEGMENT_64
        segname = b[off+8:off+24].rstrip(b'\0').decode()
        vmaddr, vmsize, fileoff, filesize, _, _, nsects, _ = struct.unpack_from('<QQQQiiII', b, off+24)
        if segname == '__TEXT': text = (vmaddr, fileoff, filesize)
        s = off + 72
        for _ in range(nsects):
            name = b[s:s+16].rstrip(b'\0').decode(); seg = b[s+16:s+32].rstrip(b'\0').decode()
            if seg == '__TEXT': secs[name] = s
            s += 80
    off += csize
vmaddr, fileoff, filesize = text
def sect(name):
    s = secs[name]; addr, size, offset = struct.unpack_from('<QQI', b, s+32); return s, addr, size, offset
es, ea, esz, eo = sect('__entitlements'); ds, da, dsz, do = sect('__ents_der')
assert do > eo, 'expects __ents_der after __entitlements'
new_do = 4096
assert eo + len(xml) <= new_do and new_do + len(der) <= fileoff + filesize, 'does not fit in __TEXT'
assert all(x == 0 for x in b[do+dsz:fileoff+filesize]), 'tail of __TEXT is not padding'
b[eo:do+dsz] = b'\0' * (do + dsz - eo)       # clear old contents
b[eo:eo+len(xml)] = xml
b[new_do:new_do+len(der)] = der
struct.pack_into('<QQI', b, es+32, ea, len(xml), eo)
struct.pack_into('<QQI', b, ds+32, vmaddr + new_do - fileoff, len(der), new_do)
open(path, 'wb').write(b)
print(f'__entitlements {len(xml)}B @{eo}, __ents_der {len(der)}B @{new_do}')
