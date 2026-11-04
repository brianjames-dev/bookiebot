// Offline proposal only. Preserve the official vector's paths; add circle framing.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const {createRequire} = require('node:module')
const req = createRequire(path.resolve(__dirname, '../../../../web/expense-report/package.json'))
const {chromium} = require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE || req.resolve('playwright'))
const sha = data => crypto.createHash('sha256').update(data).digest('hex')
const folder = __dirname
;(async () => {
  const source = fs.readFileSync(path.join(folder, 'aws-navigation.svg'))
  const metadata = JSON.parse(fs.readFileSync(path.join(folder, 'request.json')))
  if (sha(source) !== metadata.renderSourceSha256) throw Error('Reference changed')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.route('**/*', route => route.abort())
    const png = await page.evaluate(async url => {
      const image = await new Promise((resolve, reject) => {
        const item = new Image(); item.onload = () => resolve(item); item.onerror = reject; item.src = url
      })
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256
      const ctx = canvas.getContext('2d')
      ctx.beginPath(); ctx.arc(128, 128, 128, 0, Math.PI * 2); ctx.clip()
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 256, 256)
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'
      const width = 198, height = width * 64 / 109
      ctx.drawImage(image, (256 - width) / 2, (256 - height) / 2, width, height)
      return canvas.toDataURL('image/png')
    }, 'data:image/svg+xml;base64,' + source.toString('base64'))
    const bytes = Buffer.from(png.split(',')[1], 'base64')
    fs.writeFileSync(path.resolve(process.argv[2] || '/tmp/bookiebot-aws-circle.png'), bytes)
    fs.writeFileSync(path.join(folder, 'rendering.json'), JSON.stringify({
      method: 'Official navigation vector / deterministic circle framing',
      sourceSha256: sha(source), sha256: sha(bytes), size: [256, 256],
      background: '#ffffff', fill: 198 / 256, ai: false,
      status: 'candidate-review'
    }, null, 2) + '\n')
    console.log(JSON.stringify({sha256: sha(bytes), bytes: bytes.length}))
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
