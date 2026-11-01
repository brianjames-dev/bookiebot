// Offline circle-quality review. Never downloads, calls AI, or changes app assets.
// BOOKIEBOT_PLAYWRIGHT_MODULE=/path/to/playwright node scripts/build_company_logo_review.cjs [bundle.json]
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const { createRequire } = require('node:module')
const root = path.resolve(__dirname, '..'), req = createRequire(path.join(root, 'web/expense-report/package.json'))
const { chromium } = process.env.BOOKIEBOT_PLAYWRIGHT_MODULE ? require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE) : req('playwright')
const review = path.join(root, 'docs/logo-review')
const read = name => {
  const absolute = path.resolve(root, name)
  if (!absolute.startsWith(root + path.sep)) throw Error('Source outside project')
  const bytes = fs.readFileSync(absolute)
  if (bytes.length > 3_000_000) throw Error('Oversized source: ' + name)
  const mime = name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.ico') ? 'image/x-icon' : name.endsWith('.jpg') ? 'image/jpeg' : 'image/png'
  return 'data:' + mime + ';base64,' + bytes.toString('base64')
}
async function main() {
  const recipes = JSON.parse(fs.readFileSync(path.join(review, 'recipes.json')))
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'web/expense-report/src/company-logos.json')))
  if (new Set(recipes.items.map(x => x.id)).size !== catalog.length || catalog.some(x => !recipes.items.some(r => r.id === x.id))) throw Error('Review must cover catalog exactly')
  fs.mkdirSync(path.join(review, 'assets'), { recursive: true })
  const browser = await chromium.launch({ headless: true })
  const results = []
  try {
    const page = await browser.newPage()
    for (const item of recipes.items) {
      if (!/^#[0-9a-f]{6}$/i.test(item.background) || item.fill < .5 || item.fill > 1) throw Error('Invalid circle treatment: ' + item.id)
      const bytes = fs.readFileSync(path.resolve(root, item.source))
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== item.sourceSha256) throw Error('Source changed; review recipe first: ' + item.id)
      const result = await page.evaluate(async ({ item, source, original, size }) => {
        const load = url => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(Error('Image decode failed')); image.src = url })
        const image = await load(source), old = await load(original)
        const canvas = (w, h = w) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c }
        const sample = canvas(512), sc = sample.getContext('2d'), ratio = Math.min(512 / image.naturalWidth, 512 / image.naturalHeight)
        sc.drawImage(image, (512-image.naturalWidth*ratio)/2, (512-image.naturalHeight*ratio)/2, image.naturalWidth*ratio, image.naturalHeight*ratio)
        let box = [0, 0, 512, 512]
        if (item.trim) {
          const pixels = sc.getImageData(0, 0, 512, 512).data
          let left=512, top=512, right=-1, bottom=-1
          for (let y=0; y<512; y++) for (let x=0; x<512; x++) if (pixels[(y*512+x)*4+3] > 24) { left=Math.min(left,x); top=Math.min(top,y); right=Math.max(right,x); bottom=Math.max(bottom,y) }
          if (right < left) throw Error('Empty logo')
          box = [left, top, right-left+1, bottom-top+1]
        }
        const render = (n, before = false) => {
          const c = canvas(n), ctx = c.getContext('2d')
          ctx.beginPath(); ctx.arc(n/2,n/2,n/2,0,Math.PI*2); ctx.clip()
          ctx.fillStyle = before ? '#e2e6e3' : item.background; ctx.fillRect(0,0,n,n)
          const input = before ? old : sample, b = before ? [0,0,old.naturalWidth,old.naturalHeight] : box
          const scale = n*(before ? .68 : item.fill)/Math.max(b[2],b[3]), w=b[2]*scale, h=b[3]*scale
          ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'
          ctx.drawImage(input,...b,(n-w)/2,(n-h)/2,w,h)
          return c
        }
        const output = render(size), ctx = output.getContext('2d')
        const edgeChecks = (item.edgeChecks ?? []).map(check => {
          const actual = [...ctx.getImageData(Math.round(check.point[0]*size),Math.round(check.point[1]*size),1,1).data]
          const expected = check.color.match(/[0-9a-f]{2}/gi).map(x=>parseInt(x,16))
          if (actual[3] !== 255 || expected.some((value,index)=>Math.abs(value-actual[index])>4)) throw Error('Unexpected border/background: '+item.id)
          return { ...check, actual }
        })
        return { png:output.toDataURL('image/png'), after:render(96).toDataURL('image/webp',.92), before:render(96,true).toDataURL('image/webp',.90), sourceSize:[image.naturalWidth,image.naturalHeight], crop:box, edgeChecks }
      }, { item, source:read(item.source), original:read(item.original), size:recipes.exportSize })
      const output = Buffer.from(result.png.split(',')[1], 'base64'), digest = crypto.createHash('sha256').update(output).digest('hex')
      const asset = `assets/${item.id}-${digest.slice(0,16)}.png`
      fs.writeFileSync(path.join(review, asset), output)
      results.push({ ...item, asset, sha256:digest, sourceSize:result.sourceSize, crop:result.crop, edgeChecks:result.edgeChecks, before:result.before, after:result.after })
    }
  } finally { await browser.close() }
  const audit = results.map(({ before, after, ...row }) => ({ ...row, rasterBelow2x:!row.source.endsWith('.svg') && Math.min(...row.sourceSize) < 52 }))
  fs.writeFileSync(path.join(review, 'audit.json'), JSON.stringify({ version:1, status:'review-candidates', cssSize:recipes.cssSize, items:audit }, null, 2)+'\n')
  if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), JSON.stringify(results.map(({ id,name,method,ai,sourceUrl,background,fill,before,after }) => ({ id,name,method,ai,sourceUrl,background,fill,before,after }))))
  console.log(`${results.length} circle candidates exported; app catalog unchanged. ${audit.filter(x=>x.rasterBelow2x).length} sources below 2x density need visual review.`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
