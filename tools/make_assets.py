import sys, struct, math, os
from PIL import Image, ImageDraw
import random, array
BS=chr(92)

app = sys.argv[1]; out = sys.argv[2]

def icon(size, pad_frac):
    s = 1024
    im = Image.new('RGBA', (s, s), (0,0,0,0))
    d = ImageDraw.Draw(im)
    pad = int(s * pad_frac)
    if pad_frac == 0:
        d.rounded_rectangle([0,0,s-1,s-1], radius=224, fill='#0b1220')
    else:
        d.rectangle([0,0,s,s], fill='#0b1220')
    c = s/2; k = (s - 2*pad)/512
    def E(cx, cy, rx, ry, **kw): d.ellipse([c+(cx-256)*k-rx*k, c+(cy-256)*k-ry*k, c+(cx-256)*k+rx*k, c+(cy-256)*k+ry*k], **kw)
    E(256,256,196,196, outline='#2a4a8a', width=int(10*k))
    E(256,262,140,170, fill='#e7ecf5')
    E(256,262,120,150, fill='#5b6577')
    d.line([c, c+(120-256)*k, c, c+(404-256)*k], fill='#0b1220', width=int(8*k))
    E(232,258,16,30, fill='#0b1220'); E(280,258,16,30, fill='#0b1220')
    for x0,x1 in ((96,150),(362,416)):
        d.line([c+(x0-256)*k, c, c+(x1-256)*k, c], fill='#4f8bff', width=int(10*k))
    return im.resize((size,size), Image.LANCZOS)

icon(192, 0).save(f'{app}/icons/icon-192.png')
icon(512, 0).save(f'{app}/icons/icon-512.png')
icon(512, 0.12).save(f'{app}/icons/maskable-512.png')

# ---- synthetic DICOM phantom: skull, brain, ventricles, right subdural crescent ----
def el(group, elem, vr, value):
    if isinstance(value, str):
        b = value.encode('ascii')
        if len(b) % 2: b += b'\0' if vr == 'UI' else b' '
    else:
        b = value
    if vr in ('OB','OW','SQ','UN','UT'):
        return struct.pack('<HH2sHI', group, elem, vr.encode(), 0, len(b)) + b
    return struct.pack('<HH2sH', group, elem, vr.encode(), len(b)) + b

def el_implicit(group, elem, value):
    b = value.encode('ascii') if isinstance(value, str) else value
    if len(b) % 2: b += b' '
    return struct.pack('<HHI', group, elem, len(b)) + b

def us(v): return struct.pack('<H', v)

N, R = 24, 256
ts_explicit = '1.2.840.10008.1.2.1'
ts_implicit = '1.2.840.10008.1.2'
os.makedirs(out, exist_ok=True)
for i in range(N):
    z = (i - N/2) / (N/2)            # -1..1
    scale = math.sqrt(max(0.05, 1 - z*z))
    a, b = 100*scale, 120*scale
    vals = array.array('H')
    for y in range(R):
        for x in range(R):
            r = ((x-128)/a)**2 + ((y-128)/b)**2
            inner = ((x-128)/(a-8))**2 + ((y-128)/(b-8))**2
            v = -1000.0
            if r <= 1.0: v = 1200
            if inner <= 1.0:
                v = 35
                if abs(x-128) < 30*scale and abs(y-128) < 40*scale and abs(x-128) > 6: v = 5
                if -0.3 < z < 0.5 and inner > 0.80 and x < 110: v = 70
            v += random.gauss(0, 4)
            vals.append(int(min(4095, max(0, v + 1024))))
    raw = vals.tobytes()
    sop = f'1.2.826.0.1.3680043.10.999.2.{i+1}'
    common = [
        (0x0008,0x0060,'CS','CT'),
        (0x0008,0x103E,'LO','Synthetic phantom AXIAL'),
        (0x0018,0x0050,'DS','5'),
        (0x0020,0x000E,'UI','1.2.826.0.1.3680043.10.999.1'),
        (0x0020,0x0011,'IS','2'),
        (0x0020,0x0013,'IS',str(N-i)),            # reversed on purpose: sorting must use position
        (0x0020,0x0032,'DS',BS.join(['-128','-128',str(i*5)])),
        (0x0020,0x0037,'DS',BS.join('100010')),
        (0x0028,0x0002,'US',us(1)),
        (0x0028,0x0004,'CS','MONOCHROME2'),
        (0x0028,0x0010,'US',us(R)),
        (0x0028,0x0011,'US',us(R)),
        (0x0028,0x0100,'US',us(16)),
        (0x0028,0x0101,'US',us(12)),
        (0x0028,0x0103,'US',us(0)),
        (0x0028,0x1052,'DS','-1024'),
        (0x0028,0x1053,'DS','1'),
    ]
    implicit = (i % 2 == 1)
    ts = ts_implicit if implicit else ts_explicit
    meta_body = el(0x0002,0x0001,'OB',b'\x00\x01') + el(0x0002,0x0002,'UI','1.2.840.10008.5.1.4.1.1.2') + \
                el(0x0002,0x0003,'UI',sop) + el(0x0002,0x0010,'UI',ts)
    meta = el(0x0002,0x0000,'UL',struct.pack('<I', len(meta_body))) + meta_body
    # A nested sequence of undefined length, to exercise the skipper.
    item = b'' + (el_implicit(0x0008,0x0100,'T-A0100') if implicit else el(0x0008,0x0100,'SH','T-A0100'))
    seq_item = struct.pack('<HHI', 0xFFFE, 0xE000, 0xFFFFFFFF) + item + struct.pack('<HHI', 0xFFFE, 0xE00D, 0)
    seq_end = struct.pack('<HHI', 0xFFFE, 0xE0DD, 0)
    if implicit:
        body = b''.join(el_implicit(g,e,v if isinstance(v,(str,bytes)) else v) for g,e,_,v in common[:2])
        body += struct.pack('<HHI', 0x0008, 0x2218, 0xFFFFFFFF) + seq_item + seq_end
        body += b''.join(el_implicit(g,e,v) for g,e,_,v in common[2:])
        body += struct.pack('<HHI', 0x7FE0, 0x0010, len(raw)) + raw
    else:
        body = b''.join(el(g,e,vr,v) for g,e,vr,v in common[:2])
        body += struct.pack('<HH2sHI', 0x0008, 0x2218, b'SQ', 0, 0xFFFFFFFF) + seq_item + seq_end
        body += b''.join(el(g,e,vr,v) for g,e,vr,v in common[2:])
        body += struct.pack('<HH2sHI', 0x7FE0, 0x0010, b'OW', 0, len(raw)) + raw
    with open(f'{out}/IM{i+1:04d}', 'wb') as f:
        f.write(b'\0'*128 + b'DICM' + meta + body)
print('ok')
