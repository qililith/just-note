#!/usr/bin/env node
/**
 * Align Android shell with web:
 *   --live   sync config so WebView loads JUST_NOTE_LIVE_URL (default production)
 *   --apk    build + sync bundled dist (no live URL) + verify asset hash + assembleDebug
 *   --check  verify dist and android assets share the same index-*.js (bundled mode only)
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_LIVE = 'https://just-note.pages.dev'
const args = new Set(process.argv.slice(2))

function fail(message) {
  console.error(message)
  process.exit(1)
}

function run(command, commandArgs, { env = process.env, cwd = root } = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    env,
    stdio: 'inherit',
    shell: true
  })
  if (result.status !== 0) {
    fail(`Command failed (${result.status}): ${command} ${commandArgs.join(' ')}`)
  }
}

function androidIndexHtml() {
  const candidates = [
    path.join(root, 'android', 'app', 'src', 'main', 'assets', 'public', 'index.html'),
    path.join(root, 'android', 'app', 'src', 'main', 'assets', 'index.html')
  ]
  return candidates.find(candidate => fs.existsSync(candidate)) ?? null
}

function indexBundleName(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8')
  const match = html.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/)
  return match?.[1] ?? null
}

function readCapacitorConfigJson() {
  const candidates = [
    path.join(root, 'android', 'app', 'src', 'main', 'assets', 'capacitor.config.json'),
    path.join(root, 'android', 'app', 'src', 'main', 'assets', 'public', 'capacitor.config.json')
  ]
  const file = candidates.find(candidate => fs.existsSync(candidate))
  if (!file) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function checkBundledAlign() {
  const distHtml = path.join(root, 'dist', 'index.html')
  if (!fs.existsSync(distHtml)) fail('缺少 dist/index.html，请先 pnpm build')
  const androidHtml = androidIndexHtml()
  if (!androidHtml) fail('缺少 android assets 里的 index.html，请先 pnpm cap:sync / android:apk')

  const distBundle = indexBundleName(distHtml)
  const androidBundle = indexBundleName(androidHtml)
  if (!distBundle || !androidBundle) fail(`无法解析 index 包名 dist=${distBundle} android=${androidBundle}`)

  const cap = readCapacitorConfigJson()
  const live = cap?.server?.url
  if (live) {
    fail(
      `android 仍配置了 server.url=${live}（跟站模式）。打可分发 APK 前请跑: pnpm android:apk\n` +
        `（会清掉 LIVE_URL 并重新 sync）`
    )
  }

  if (distBundle !== androidBundle) {
    fail(
      `Web 与安卓资源不一致：dist=${distBundle} android=${androidBundle}\n` +
        `请跑: pnpm android:apk`
    )
  }

  console.log(`OK android web assets aligned: ${androidBundle}`)
}

function syncAndroid({ live }) {
  const env = { ...process.env }
  if (live) {
    env.JUST_NOTE_LIVE_URL = env.JUST_NOTE_LIVE_URL?.trim() || DEFAULT_LIVE
    console.log(`Live sync → WebView loads ${env.JUST_NOTE_LIVE_URL}`)
  } else {
    delete env.JUST_NOTE_LIVE_URL
    console.log('Bundled sync → WebView uses packaged dist')
  }

  // Live mode still needs a present webDir; keep build so sync never fails on empty dist.
  run('pnpm', ['build'], { env })
  run('pnpm', ['exec', 'cap', 'sync', 'android'], { env })

  const cap = readCapacitorConfigJson()
  const url = cap?.server?.url
  if (live && url !== env.JUST_NOTE_LIVE_URL) {
    fail(`期望 capacitor.config.json server.url=${env.JUST_NOTE_LIVE_URL}，实际=${url ?? '(无)'}`)
  }
  if (!live && url) {
    fail(`发版 sync 后不应带 server.url，实际=${url}`)
  }
}

function assembleDebug({ required = true } = {}) {
  const androidDir = path.join(root, 'android')
  const isWin = process.platform === 'win32'
  const gradlew = isWin ? 'gradlew.bat' : './gradlew'
  const result = spawnSync(gradlew, ['assembleDebug'], {
    cwd: androidDir,
    env: process.env,
    stdio: 'inherit',
    shell: true
  })
  if (result.status !== 0) {
    const hint =
      'Gradle 失败。请安装 JDK 21+ 并设置 JAVA_HOME，然后在 android/ 执行 gradlew assembleDebug。\n' +
      '（cap sync 若已成功，capacitor 配置已写入工程；只需补打 APK。）'
    if (required) fail(hint)
    console.warn(hint)
    return false
  }
  const apk = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
  if (!fs.existsSync(apk)) {
    if (required) fail(`未找到 ${apk}`)
    console.warn(`未找到 ${apk}`)
    return false
  }
  console.log(`APK: ${apk}`)
  return true
}

if (args.has('--check')) {
  checkBundledAlign()
} else if (args.has('--live')) {
  syncAndroid({ live: true })
  // Config is baked into the APK at assemble time; sync alone does not update an already-installed app.
  const built = assembleDebug({ required: false })
  if (built) {
    console.log('安装上述 APK 一次即可：之后 App 内容跟正式站，网站部署后无需重打壳。')
  } else {
    console.log('工程已切到 live（server.url=正式站）。配好 JDK 后：cd android && gradlew assembleDebug')
  }
  console.log('若要改回本地打包资源，再跑 pnpm android:apk。')
} else if (args.has('--apk')) {
  syncAndroid({ live: false })
  checkBundledAlign()
  assembleDebug({ required: true })
} else {
  fail('Usage: node scripts/android-web-align.mjs --live | --apk | --check')
}
