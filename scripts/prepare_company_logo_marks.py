"""Extract existing vector symbols for the offline logo review, without tracing.

Run from the repository root after saving the reviewed original sources. Brand
path geometry is retained; only symbol selection, viewBox and paint are changed.
"""
from pathlib import Path
import xml.etree.ElementTree as E
import copy
p=Path('docs/logo-review/sources')
E.register_namespace('','http://www.w3.org/2000/svg')
def write(name,r):
 r.attrib.pop('width',None);r.attrib.pop('height',None);r.attrib.pop('style',None)
 text=E.tostring(r,encoding='unicode')
 (p/(name+'-mark.svg')).write_text('\n'.join(line.rstrip() for line in text.splitlines())+'\n')
def base():return E.Element('{http://www.w3.org/2000/svg}svg')
r=E.parse(p/'sdge-original.svg').getroot();r.set('viewBox','9 6 143 143')
# Original artwork's symbol group, without the unreadable wordmark.
outer=list(r)[1];outer.remove(list(outer)[0]);r.remove(list(r)[-1]);write('sdge',r)
r=E.parse(p/'socalgas-original.svg').getroot();r.set('viewBox','0 0 24.6 45')
g=list(r)[0]
for child in list(g)[1:]:g.remove(child)
write('socalgas',r)
r=E.parse(p/'fpl-original.svg').getroot();group=next(x for x in r.iter() if x.get('id')=='FPL_logo_0096DB')
n=base();n.set('viewBox','0 0 108 108')
for child in list(group)[:2]:n.append(copy.deepcopy(child))
write('fpl',n)
r=E.parse(p/'dominion-energy-original.svg').getroot();r.set('viewBox','0 0 45 53')
for child in list(r)[1:]:r.remove(child)
write('dominion-energy',r)
r=E.parse(p/'liberty-mutual-original.svg').getroot();r.set('viewBox','0 0 76 92')
for child in list(r)[1:]:r.remove(child)
for node in list(r)[0]:node.set('fill','#1a1446' if node.get('class')=='lmig-Logo--path' else '#ffd000')
write('liberty-mutual',r)
# Fill-only adaptation of existing native paths; no hand-authored brand geometry.
for name,fill in [('chatgpt','#ffffff'),('railway','#ffffff'),('att','#009fdb'),('fubo','#ffffff')]:
 r=E.parse(p/(name+'-original.svg')).getroot()
 for node in r.iter():
  if node.tag.endswith('path'):node.set('fill',fill)
 write(name,r)
r=E.parse(p/'travelers-original.svg').getroot();r.set('viewBox','112 0 35 30')
for child in list(r)[1:]:r.remove(child)
write('travelers',r)
