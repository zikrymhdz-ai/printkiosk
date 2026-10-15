#!/usr/bin/env python3
"""Brightness/contrast must actually reach the printed page.

The sliders moved a CSS filter on the preview, the value was stored on the job,
and then nothing ever applied it: claim-job did not even select the columns and
the worker converted the image without adjustment. The customer saw an adjusted
preview and got the original photograph.

This checks the real worker helpers against the real Pillow output, and pins the
arithmetic to what the browser's CSS filter does, because the print is supposed
to match the preview the customer approved.
"""
import importlib.util
import os
import sys
import tempfile

WORKER = os.path.join(os.path.dirname(__file__), "..", "pi", "print-worker.py")

# The filename has a hyphen, so load it under a usable module name.
_spec = importlib.util.spec_from_file_location("pk_worker", WORKER)
w = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(w)

from PIL import Image, ImageEnhance  # noqa: E402

failed = 0


def ok(cond, msg):
    global failed
    print(("  ok      " if cond else "  FAILED  ") + msg)
    if not cond:
        failed += 1


def mean_luma(im):
    return sum(im.convert("L").get_flattened_data()) / float(im.size[0] * im.size[1])


def flat(value=128, size=(64, 64)):
    return Image.new("RGB", size, (value, value, value))


tmp = tempfile.mkdtemp(prefix="pk-adj-")
src = os.path.join(tmp, "flat.png")
flat(128).save(src, "PNG")

# --- the adjustment is actually clamped, not trusted -----------------------
ok(w._clamp_adjust("40") == 40, "a normal value passes through")
ok(w._clamp_adjust(40) == 40, "an integer passes through")
ok(w._clamp_adjust(0) == 0, "zero is no adjustment")
ok(w._clamp_adjust("") == 0, "an empty value is no adjustment")
ok(w._clamp_adjust(None) == 0, "None is no adjustment")
ok(w._clamp_adjust("abc") == 0, "junk is no adjustment, not a crash")
ok(w._clamp_adjust(9999) == 100, "an absurd value is clamped to 100")
ok(w._clamp_adjust(-9999) == -100, "an absurd negative is clamped to -100")
ok(w._clamp_adjust("40.6") == 41, "a string decimal rounds like the slider")

# --- brightness changes the pixels the customer asked for --------------------
base = mean_luma(flat(128))
brighter = mean_luma(w.adjust_image(flat(128), False, 50, 0))
darker = mean_luma(w.adjust_image(flat(128), False, -50, 0))
same = mean_luma(w.adjust_image(flat(128), False, 0, 0))

ok(brighter > base + 10,
   "brightness +50 actually lightens the page (%.1f -> %.1f)" % (base, brighter))
ok(darker < base - 10,
   "brightness -50 actually darkens the page (%.1f -> %.1f)" % (base, darker))
ok(abs(same - base) < 0.5,
   "no adjustment leaves the image alone (%.1f -> %.1f)" % (base, same))

# --- contrast matches the browser's CSS filter -----------------------------
# CSS contrast() is linear about mid grey: (v - 127.5) * f + 127.5. Pillow's
# ImageEnhance.Contrast pivots on the image mean instead, which does not match
# the preview - so the worker does the CSS formula. Checked per pixel value.
ramp = Image.frombytes("RGB", (256, 1),
                       bytes(bytearray([v for v in range(256) for _ in range(3)])))
for v in (-60, -25, 0, 25, 60, 100):
    f = 1.0 + v / 100.0
    got = [p[0] for p in list(w.adjust_image(ramp, False, 0, v).get_flattened_data())[0:256]]
    want = []
    for i in range(256):
        x = (i - 127.5) * f + 127.5
        want.append(0 if x < 0 else (255 if x > 255 else int(x + 0.5)))
    ok(got == want,
       "contrast %+d reproduces CSS contrast(%d%%) exactly" % (v, 100 + v))

# A flat image must still respond to contrast, which it would not if this were
# Pillow's mean-pivot version.
flat_mean = mean_luma(w.adjust_image(flat(128, (16, 16)), False, 0, 50))
ok(abs(flat_mean - 128) < 1,
   "contrast pivots on mid grey, so a flat 128 stays 128 (got %.1f)" % flat_mean)
low = mean_luma(w.adjust_image(flat(60, (16, 16)), False, 0, 50))
ok(low < 60, "contrast +50 still darkens an already-dark image (%.1f)" % low)
high = mean_luma(w.adjust_image(flat(200, (16, 16)), False, 0, 50))
ok(high > 200, "contrast +50 still lightens an already-light image (%.1f)" % high)

# --- brightness matches the browser's CSS filter ----------------------------
# The preview used filter: brightness(100 + n)%. CSS brightness is a plain
# multiply, so the worker must use the same factor or the print will not match
# the screen the customer approved. Compared on the mean, with a tolerance for
# rounding, because Pillow and CSS round differently.
base_mean = mean_luma(flat(128, (16, 16)))
for v in (-40, -10, 0, 10, 40, 100):
    got = mean_luma(w.adjust_image(flat(128, (16, 16)), False, v, 0))
    want = base_mean * (1.0 + v / 100.0)
    ok(abs(got - want) <= 1.0,
       "brightness %+d scales pixels by %s, like CSS brightness(%d%%) (%.1f vs %.1f)"
       % (v, 1.0 + v / 100.0, 100 + v, got, want))

# --- greyscale still wins, and combined adjustments compose ------------------
colored = w.adjust_image(flat(200, (8, 8)), True, 0, 0)
ok(all(p[0] == p[1] == p[2] for p in colored.get_flattened_data()),
   "greyscale is still applied when no adjustment is asked for")

combo = w.adjust_image(flat(128, (8, 8)), False, 30, 30)
ok(mean_luma(combo) > 128, "brightness and contrast together still apply")

# --- and the real entry point writes a printable single-page PDF ------------
# pypdf is not installed here, so check the file is a real PDF rather than
# pretending to read it.
def assert_pdf(path, label):
    with open(path, "rb") as fh:
        head = fh.read(5)
    ok(head == b"%PDF-", label + " is a real PDF")
    ok(os.path.getsize(path) > 800, label + " has real content")


out = os.path.join(tmp, "out.pdf")
w.image_to_pdf(src, out, False, 30, 30)
ok(os.path.exists(out), "image_to_pdf writes the file")
assert_pdf(out, "an adjusted image")

# A colour JPEG must still flatten even with adjustments on.
jpeg = os.path.join(tmp, "c.jpg")
flat(180, (32, 32)).save(jpeg, "JPEG")
out2 = os.path.join(tmp, "c.pdf")
w.image_to_pdf(jpeg, out2, True, -20, 20)
assert_pdf(out2, "an adjusted greyscale JPEG")

# A PNG with an alpha channel must not crash the adjustment path.
rgba = os.path.join(tmp, "a.png")
Image.new("RGBA", (32, 32), (10, 20, 30, 128)).save(rgba, "PNG")
out3 = os.path.join(tmp, "a.pdf")
w.image_to_pdf(rgba, out3, False, 25, 0)
assert_pdf(out3, "a transparent PNG")

if failed:
    print("  -> %d failed" % failed)
    sys.exit(1)
print("  ok      brightness and contrast reach the printed page")
