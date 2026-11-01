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

# Review v2: use exact native artwork, removing only unrelated wordmark fragments
# or square backgrounds before the renderer centers it in a circular frame.
def production(id):
 import json
 catalog=json.loads(Path('web/expense-report/src/company-logos.json').read_text())
 row=next(item for item in catalog if item['id']==id)
 return E.parse(Path('src/bookiebot/reports/assets')/row['asset']).getroot()
r=E.parse(p/'github-black-original-v2.svg').getroot();r.set('viewBox','0 0 98 98');write('github-v2',r)
r=E.parse(p/'liberty-mutual-original.svg').getroot();r.set('viewBox','8 0 56 92');r.set('preserveAspectRatio','xMidYMid meet')
for child in list(r)[1:]:r.remove(child)
for node in list(r)[0]:node.set('fill','#1a1446' if node.get('class')=='lmig-Logo--path' else '#ffd000')
write('liberty-mutual-v2',r)
r=production('disney-plus');r.remove(list(r)[0]);write('disney-plus-v2',r)
# Both source marks only paint the top/side portions of a circle. Center the
# underlying brand circle, rather than the shorter painted-pixel bounding box.
r=production('nordvpn');r.set('viewBox','0 52.8 512 512');write('nordvpn-v2',r)
r=production('paramount-plus');r.set('viewBox','0 2.437 24 24');write('paramount-plus-v2',r)
r=E.parse(p/'waste-management-original-v2.svg').getroot()
for node in list(r):
 if node.tag.split('}')[-1]=='rect':r.remove(node)
write('waste-management-v2',r)
