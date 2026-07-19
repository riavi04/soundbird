#!/usr/bin/env python3
"""Check that every #id the JS reaches for exists in the markup, and vice versa.

A missing id only shows up when someone clicks the thing, so it is worth
catching statically.
"""
import os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")

html = open(os.path.join(SRC, "index.html"), encoding="utf-8").read()
js = "".join(open(os.path.join(SRC, f), encoding="utf-8").read()
             for f in ("app.js", "player.js", "generate.js", "engine.js"))

html_ids = set(re.findall(r'\bid="([\w-]+)"', html))

# $("#foo"), $$("#foo ..."), querySelector("#foo").
# Selectors built by concatenation, like "#view-" + name, are skipped: the
# literal prefix is not an id and the real ones cannot be seen statically.
used = set()
for m in re.finditer(r'["\'`]#([\w-]+)(["\'`])(\s*\+)?', js):
    if m.group(3):
        continue
    used.add(m.group(1))

missing = sorted(used - html_ids)
unused = sorted(html_ids - used)

# Elements the JS reaches only via a container query are fine; list them
# rather than failing.
print(f"ids in markup: {len(html_ids)}")
print(f"ids used in js: {len(used)}")
if missing:
    print("\nMISSING from markup (js will get null):")
    for i in missing:
        print("  #" + i)
if unused:
    print("\nin markup but never selected by id (may be fine):")
    for i in unused:
        print("  #" + i)

# Check the CSS custom properties resolve
css = open(os.path.join(SRC, "style.css"), encoding="utf-8").read()
declared = set(re.findall(r'^\s*(--[\w-]+)\s*:', css, re.M))
referenced = set(re.findall(r'var\((--[\w-]+)', css))
undeclared = sorted(referenced - declared)
if undeclared:
    print("\nCSS vars used but never declared:")
    for v in undeclared:
        print("  " + v)

# Obviously malformed CSS values (a stray word where a colour belongs)
bad = [l.strip() for l in css.splitlines()
       if re.search(r':\s*#[0-9a-fA-F]*[g-zG-Z]', l)]
if bad:
    print("\nmalformed colour values:")
    for b in bad:
        print("  " + b)

sys.exit(1 if (missing or undeclared or bad) else 0)
