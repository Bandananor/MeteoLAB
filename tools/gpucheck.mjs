// Usage: node tools/gpucheck.mjs <Chrome executable> [Chrome flags...]
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'

const [chrome, ...flags] = process.argv.slice(2)
if (!chrome) throw new Error('Usage: node tools/gpucheck.mjs <Chrome executable> [Chrome flags...]')

function validate(result) {
  if (result.unavailable) throw new Error(`WebGPU unavailable: ${result.unavailable}`)
  if (result.error || result.stepFailed) throw new Error(result.error || result.stepFailed)
  const fullStep = result.fullStep
  const errors = [...result.errors, ...result.ellipticErrors, ...result.dynamicsErrors, ...fullStep.errors]
  if (errors.length) throw new Error(`WebGPU errors: ${errors.join('\n')}`)
  console.log(`WebGPU adapter: ${result.adapter}; ${result.grid}; T+${result.minutes} min`)

  const values = (section, keys) => keys.map(key => [key, section[key]])
  const fields = (rows, key) => rows.map(row => [row.field, row[key]])
  // Allow float32 roundoff relative to small changes (rain charge and pressure corrections in particular).
  // The SwiftShader baseline at T+10 min peaks at 0.37% for transport and 0.09% for whole-step pressure.
  const groups = [
    ['Transport tendency', 1e-2, fields(result.fields, 'maxRel')],
    ['Scalar RK3', 1e-2, fields(result.step.fields, 'maxRelOfChange')],
    ['Face projection', 2e-4, values(result.faces, ['mx', 'my', 'mz', 'divLeftGpu'])],
    ['Pressure projection', 2e-3, values(result.pressure, ['duRel', 'dvRel', 'dwRel', 'divLeftGpu'])],
    ['Step dynamics', 1e-2, fields(result.dynamics.fields, 'maxRelOfChange')],
    ['Full step', 5e-3, fields(fullStep.rows.filter(row => row.steps === 1), 'maxRelOfChange')],
    ['Full step pressure', 3e-3, values(fullStep, ['pressureRel'])],
  ]
  let passed = true
  for (const [name, limit, measurements] of groups) {
    if (!measurements.length) throw new Error(`${name}: no measurements`)
    const score = value => Number.isFinite(value) ? value : Infinity
    const [field, value] = measurements.reduce((worst, row) => score(row[1]) > score(worst[1]) ? row : worst)
    const ok = score(value) <= limit
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${field} = ${Number.isFinite(value) ? value.toExponential(3) : 'non-finite'}, tolerance ${limit.toExponential(1)}`)
    passed &&= ok
  }
  if (!passed) process.exitCode = 1
}

const { promise: report, resolve: accept, reject: fail } = Promise.withResolvers()
const server = await createServer({
  configLoader: 'runner',
  base: '/',
  server: { host: '127.0.0.1', port: 0, watch: null },
  plugins: [{
    name: 'gpucheck-report',
    configureServer({ middlewares }) {
      middlewares.use('/__gpucheck', async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405).end(); return }
        try {
          let body = ''
          for await (const chunk of req) body += chunk
          const result = JSON.parse(body)
          res.writeHead(204).end()
          accept(result)
        } catch (error) {
          res.writeHead(400).end()
          fail(error)
        }
      })
    },
  }],
})

let browser, closed, profile, timer
let stderr = ''
try {
  await server.listen()
  const { port } = server.httpServer.address()
  profile = await mkdtemp(join(tmpdir(), 'stormlab-gpucheck-'))
  const url = `http://127.0.0.1:${port}/tests/bench/gpucheck.html?report=1&minutes=10&steps=1`
  browser = spawn(chrome, [
    '--headless=new', '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader',
    '--no-first-run', `--user-data-dir=${profile}`, ...flags, url,
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  browser.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
  browser.on('error', fail)
  closed = new Promise(resolve => browser.once('close', code => {
    fail(new Error(`Chrome closed before the benchmark reported (exit ${code})`))
    resolve()
  }))
  timer = setTimeout(() => fail(new Error('Timed out waiting for the WebGPU benchmark')), 180_000)
  validate(await report)
} catch (error) {
  console.error(error)
  if (stderr) console.error(stderr)
  process.exitCode = 1
} finally {
  clearTimeout(timer)
  if (browser?.pid && browser.exitCode === null && browser.signalCode === null) {
    if (process.platform === 'win32') spawnSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${browser.pid} -Force -ErrorAction SilentlyContinue`], { windowsHide: true })
    else browser.kill()
  }
  await closed
  await server.close()
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
