/**
 * dsh-screen-capture-record-desktop — 浏览器端一半。
 *
 * 在输入框工具条的「听写」（内置语音输入按钮，aria-label = 开始录音）**左边**
 * 依次插入两个按钮：
 *
 *   1. 录屏提问（录屏图标）—— 点一下开始按间隔抓屏，再点一下结束；
 *      只保留**画面有变化**的帧，结束时一次性放进附件，补一句话就能问。
 *   2. 截图（相机）—— 点一下抓整屏并弹出选区，框选后进附件。
 *
 * 抓屏在宿主侧做，不在浏览器（这是 2026-10-01 的重写）
 * ---------------------------------------------------
 * 桌面版 Electron 主进程写死了（app.asar/lib/main.js → configureSession()）：
 *
 *     setPermissionRequestHandler((_c, _p, cb) => cb(false))     // 一切权限→拒绝
 *     setDisplayMediaRequestHandler((_r, cb) => cb({}))          // 屏幕共享→回空对象
 *
 * 所以 navigator.mediaDevices.getDisplayMedia() 在桌面壳里**永远拿不到流**，
 * 旧版（浏览器共享方案）必然失败，还被 catch 误报成「已取消截图」。现在改成：
 *
 *     GET /plugins/dsh-screen-capture-record-desktop/shot  →  宿主跑 lib/shot.ps1（GDI 抓屏）
 *
 * 见 lib/index.js。挂载时会先 probe：宿主没重启时按钮会说明原因，而不是点了没反应。
 *
 * 为什么是「关键帧」而不是整段 webm
 * --------------------------------
 * 模型没有视频输入通道（MP4/WebM 打不开），只认图片；宿主抓屏也只能给静态图。
 * 所以按间隔抓，并用 SHA-256 丢掉没变化的帧 —— 静止画面不会刷出一堆重复图。
 * 体积用四件事兜住：间隔（默认 900ms）、单帧最大边（1440px）、
 * 总帧数与总字节双上限。
 *
 * 为什么用 DOM 直插而不是槽位
 * --------------------------
 * 工具条上「听写」来自内置包 @deepseek-ai/dsh-experimental-client-ui-voice-input，
 * 它注册在 conversation.input.activity —— 那是一个 `kind: "single"` 槽位，
 * 已经被它占了，第二个注册会被拒绝。而我们要的位置（听写**左边**、
 * 与模型选择器之间）在「权限」「模型」两个槽位之间，没有声明槽位可用。
 * 所以用 MutationObserver 直插 DOM —— 项目里 dsh-balance-hud、老
 * dsh-screen-record 出于同样理由都是这个做法。
 *
 * 安全约定（照抄老插件的三条）：
 *   - 不 require 任何 DSH 内部模块，只用标准 DOM / Web API；
 *   - 所有对外动作包在 try/catch 里，异常只影响本插件，不冒泡进 React 渲染；
 *   - 找不到锚点就安静退出，绝不抛错。
 *
 * DevTools 里可调的开关（localStorage，改完立即生效）：
 *   localStorage['dsh-capture.fps']          = '5'      // 录屏帧率（1-15）
 *   localStorage['dsh-capture.picker']       = '1'      // 截图是否弹选区（0=抓完整屏直接进附件）
 *   localStorage['dsh-capture.maxDimension'] = '1280'   // 长边上限（640-2560）
 *   localStorage['dsh-capture.quality']      = '0.72'   // JPEG 质量（0.3-0.95）
 *   localStorage['dsh-capture.maxSeconds']   = '180'    // 录屏最长秒数（5-900）
 */

/** 录屏按钮的 DOM 标记。 */
const REC_ATTR = 'data-dsh-capture-rec'
/** 截图按钮的 DOM 标记。 */
const SHOT_ATTR = 'data-dsh-capture-shot'
/** 轻提示标记。 */
const TOAST_ATTR = 'data-dsh-capture-toast'
/** 自绘 tooltip 标记（样式照抄 @deepseek-ai/dsh-client-ui-primitives 的 Tooltip）。 */
const TIP_ATTR = 'data-dsh-capture-tip'
/**
 * 「听写」按钮的可访问名。
 *
 * 0.1.7 桌面版是内置语音输入，i18n 文案「开始录音」/ "Start recording"；
 * 老版本（0.1.5）工具条上那个麦克风是本机自研插件 dsh-screen-record 插的，
 * 名字叫「语音输入」。两个都认下来。
 */
const DICTATION_LABELS = [
  '开始录音', '停止录音', '语音输入', '停止语音输入',
  'Start recording', 'Stop recording', 'Voice input', 'Dictation'
]

// ---------------------------------------------------------------- 可调参数

function tunedNumber(key, fallback, min, max) {
  try {
    const raw = Number(localStorage.getItem('dsh-capture.' + key))
    if (Number.isFinite(raw) && raw >= min && raw <= max) return raw
  } catch (e) {
    /* localStorage 可能被禁；忽略，用默认值 */
  }
  return fallback
}

function tunedFlag(key, fallback) {
  try {
    const raw = localStorage.getItem('dsh-capture.' + key)
    if (raw === null) return fallback
    return !(raw === '0' || raw === 'false')
  } catch (e) {
    return fallback
  }
}

function cfg() {
  return {
    fps: Math.round(tunedNumber('fps', 5, 1, 15)),
    picker: tunedFlag('picker', true),
    maxDimension: Math.round(tunedNumber('maxDimension', 1280, 640, 2560)),
    quality: tunedNumber('quality', 0.72, 0.3, 0.95),
    maxSeconds: Math.round(tunedNumber('maxSeconds', 180, 5, 900))
  }
}

// ------------------------------------------------------------------ 小工具

function warn(...args) {
  try {
    console.warn.apply(console, ['[dsh-capture]'].concat(args))
  } catch (e) {
    /* 控制台不可用时忽略 */
  }
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n
}

/** 文件名用的时间戳：20260928-091530。 */
function stamp() {
  const d = new Date()
  return (
    d.getFullYear() +
    pad2(d.getMonth() + 1) +
    pad2(d.getDate()) +
    '-' +
    pad2(d.getHours()) +
    pad2(d.getMinutes()) +
    pad2(d.getSeconds())
  )
}

function sizeText(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB'
  return bytes + ' B'
}

/** setTimeout 的 promise 版本。 */
function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms)
  })
}

/** 至少等 ms 毫秒（传给 delay 的是剩余时间，所以是「至少」）。 */
async function atLeast(startedAt, ms) {
  const left = ms - (Date.now() - startedAt)
  if (left > 0) await delay(left)
}

/** 把 canvas 压成 JPEG Blob（toBlob 失败时返回 null）。 */
function canvasToJpeg(canvas, quality) {
  return new Promise(function (resolve) {
    try {
      canvas.toBlob(
        function (blob) {
          resolve(blob || null)
        },
        'image/jpeg',
        quality
      )
    } catch (e) {
      resolve(null)
    }
  })
}

/**
 * 轻提示 —— **照官方 Toast 复刻**（@deepseek-ai/dsh-client-ui-primitives/lib/Toast.module.css）：
 *   position fixed / top 40px / left 50% / z-index 1100 / pointer-events none
 *   display flex / align-items center / gap 10px
 *   width max-content / max-width min(640px, 100vw - 48px)
 *   padding 12px 16px / border-radius var(--dsw-radius-lg)（=16px）
 *   background var(--dsw-alias-toast-bg) / color var(--dsw-alias-toast-label)
 *   font 14px/22px / box-shadow var(--dsw-shadow-lv3) / transform translateX(-50%)
 *   animation: 160ms ease-out 滑入 → hold 之后 1000ms 淡出
 *
 * 官方那条是**两套主题都深底**的（bluish-800 / bluish-750），所以文字色固定不跟随主题 ——
 * 这点要照抄，否则浅色主题下会变成"白底黑字"，一眼就不像。
 * 之前我画的是自己拼的小黑块（定位在按钮上方、12px 字），跟官方的横幅完全不是一个东西。
 */
function toast(text, ms, kind) {
  try {
    let el = document.querySelector('[' + TOAST_ATTR + ']')
    if (!el) {
      el = document.createElement('div')
      el.setAttribute(TOAST_ATTR, '1')
      el.style.cssText = [
        'position:fixed',
        'top:40px',
        'left:50%',
        'z-index:1100',
        'pointer-events:none',
        'display:flex',
        'align-items:center',
        'gap:10px',
        'width:max-content',
        'max-width:min(640px,calc(100vw - 48px))',
        'padding:12px 16px',
        'border-radius:var(--dsw-radius-lg,16px)',
        'background:var(--dsw-alias-toast-bg,#2c2c2e)',
        'color:var(--dsw-alias-toast-label,#fff)',
        'font-size:14px',
        'line-height:22px',
        'box-shadow:var(--dsw-shadow-lv3,0 8px 24px rgba(0,0,0,.24))',
        'transform:translateX(-50%)',
        'white-space:pre-line',
        'overflow-wrap:break-word'
      ].join(';')
      const icon = document.createElement('span')
      icon.setAttribute('data-dsh-capture-toast-icon', '1')
      icon.style.cssText = 'display:grid;place-items:center;flex:none'
      el.appendChild(icon)
      const label = document.createElement('span')
      label.setAttribute('data-dsh-capture-toast-text', '1')
      label.style.cssText = 'min-width:0'
      el.appendChild(label)
      document.body.appendChild(el)
    }
    const icon = el.querySelector('[data-dsh-capture-toast-icon]')
    const label = el.querySelector('[data-dsh-capture-toast-text]')
    const failed = kind === 'error' || kind === 'warn'
    if (icon) {
      icon.style.color = failed
        ? 'var(--dsw-alias-state-warn-label,var(--dsw-static-amber-400))'
        : 'var(--dsw-alias-state-success-primary,#3ddc97)'
      icon.innerHTML = failed ? toastWarnIcon() : toastOkIcon()
    }
    if (label) label.textContent = text

    // 重放动画（同一元素复用，不重放的话第二条提示不会滑入）
    el.style.animation = 'none'
    void el.offsetWidth
    const hold = Math.max(1200, ms || 3000)
    el.style.animation =
      'dsh-capture-toast-in 160ms ease-out, dsh-capture-toast-fade 1000ms ease ' + hold + 'ms forwards'
    el.style.display = 'flex'

    if (typeof el.__hideTimer === 'number') clearTimeout(el.__hideTimer)
    el.__hideTimer = setTimeout(function () {
      try {
        el.style.display = 'none'
      } catch (e) {
        /* 忽略 */
      }
    }, hold + 1000)
  } catch (e) {
    /* 提示失败不影响主流程 */
  }
}

/** 提示条上的图标，与内置图标同一套规范（16 格网 / stroke 1 / 16px）。 */
function toastWarnIcon() {
  return (
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true">' +
    '<path d="M8 2.3 14.6 13.4H1.4z"/>' +
    '<path d="M8 6.4v3.2"/>' +
    '<circle cx="8" cy="11.6" r="0.7" fill="currentColor" stroke="none"/>' +
    '</svg>'
  )
}

function toastOkIcon() {
  return (
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true">' +
    '<circle cx="8" cy="8" r="6.2"/>' +
    '<path d="M5.2 8.3 7.2 10.3 10.9 6"/>' +
    '</svg>'
  )
}

/**
 * Toast 的两个关键帧。官方用的是 `dsh-toast-in` / `dsh-toast-fade`，
 * 那两个名字在宿主样式表里，本插件不该去借用别人的全局 keyframes 名（会撞），
 * 所以用同名形状、自己的一套名字注入一次。
 */
function ensureToastKeyframes() {
  try {
    if (document.querySelector('style[data-dsh-capture-style]')) return
    const style = document.createElement('style')
    style.setAttribute('data-dsh-capture-style', '1')
    style.textContent =
      '@keyframes dsh-capture-toast-in{from{opacity:0;transform:translate(-50%,-6px)}to{opacity:1;transform:translate(-50%,0)}}' +
      '@keyframes dsh-capture-toast-fade{to{opacity:0;visibility:hidden}}' +
      '@keyframes dsh-capture-tip-in{from{opacity:0}}'
    document.head.appendChild(style)
  } catch (e) {
    /* 忽略 */
  }
}

// --------------------------------------------------------------- 找锚点

/** 判断一个按钮是不是「听写」（内置语音输入）。 */
function isDictationButton(el) {
  try {
    const label = (el.getAttribute('aria-label') || '').trim()
    if (label && DICTATION_LABELS.indexOf(label) !== -1) return true
    // i18n 可能给出别的语言：按关键字兜一层
    if (/录音|听写|语音输入|record|dictat|voice/i.test(label)) return true
  } catch (e) {
    /* 忽略 */
  }
  return false
}

/** composer 的输入框（内容最多 / 有 placeholder 的那个）。 */
function findComposerInput() {
  try {
    const areas = document.querySelectorAll('textarea, [contenteditable="true"]')
    let fallback = null
    let fallbackW = 0
    for (let i = 0; i < areas.length; i++) {
      const el = areas[i]
      const r = el.getBoundingClientRect()
      if (r.width < 60 || r.height < 12) continue
      const ph = el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || ''
      if (ph.indexOf('发消息') >= 0 || /message/i.test(ph)) return el
      if (r.width > fallbackW) {
        fallbackW = r.width
        fallback = el
      }
    }
    return fallback
  } catch (e) {
    return null
  }
}

/**
 * 找「听写」按钮 —— 这是本插件唯一的定位锚点。
 *
 * 优先在全页按可访问名找；找不到再在 composer 那一带（输入框下方的工具条行）
 * 按名字找一次，避免命中页面别处同名的按钮。
 */
function findDictationButton() {
  try {
    const all = Array.prototype.slice.call(
      document.querySelectorAll('button[aria-label], [role="button"][aria-label]')
    )
    for (let i = 0; i < all.length; i++) {
      if (!isDictationButton(all[i])) continue
      const r = all[i].getBoundingClientRect()
      if (r.width < 12 || r.height < 12) continue
      return all[i]
    }
  } catch (e) {
    warn('findDictationButton', e)
  }

  try {
    const inputEl = findComposerInput()
    if (!inputEl) return null
    const r0 = inputEl.getBoundingClientRect()
    let box = inputEl
    for (let depth = 0; depth < 8; depth++) {
      box = box.parentElement
      if (!box) break
      const btns = Array.prototype.slice.call(box.querySelectorAll('button[aria-label], [role="button"][aria-label]'))
      for (let i = 0; i < btns.length; i++) {
        const r = btns[i].getBoundingClientRect()
        if (r.width < 12 || r.height < 12) continue
        if (r.top < r0.bottom - 6) continue // 只要输入框下面那一行
        if (isDictationButton(btns[i])) return btns[i]
      }
    }
  } catch (e) {
    warn('findDictationButton(near composer)', e)
  }
  return null
}

// ------------------------------------------------------------- 按钮装配

/**
 * 图标：录屏（显示器 + 录制圆点）。
 *
 * 全部照抄原生图标集的规范（@deepseek-ai/dsh-client-ui-primitives/lib/index.js）：
 *   viewBox 16×16、fill:none、stroke:currentColor、**stroke-width = 1**
 *   （ICON_REGULAR_STROKE），按 size=18 渲染 —— 和内置听写麦克风
 *   （IconMicrophoneOutlineRegular，viewBox 16 / stroke 1 / size 18）逐项一致。
 * 之前用 20 格网 + 1.5 线宽 + 20px 渲染，所以看起来又大又重、跟邻居不像一家人。
 * 几何也按原生的做法内缩半个线宽，保证 1px 描边落在格内。
 */
function recIcon() {
  return (
    '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true">' +
    '<rect x="2" y="1.75" width="12" height="10.5" rx="1.6"/>' +
    '<circle cx="8" cy="7" r="1.6" fill="currentColor" stroke="none"/>' +
    '<path d="M6 14.25h4"/>' +
    '</svg>'
  )
}

/**
 * 图标：相机（截图）。
 *
 * 尺寸按"和麦克风同量级"定：麦克风图形占 16 格网里的 ~11×14。相机天生矮，
 * 所以靠宽度对齐观感（画到 ~12 宽），线宽仍是 1、渲染仍是 18px。
 */
function shotIcon() {
  return (
    '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true">' +
    '<path d="M2 5.85a1.3 1.3 0 0 1 1.3-1.3h1.9l1-1.6h3.6l1 1.6h1.9A1.3 1.3 0 0 1 14 5.85v5.1a1.3 1.3 0 0 1-1.3 1.3H3.3A1.3 1.3 0 0 1 2 10.95z"/>' +
    '<circle cx="8" cy="8.1" r="2.2"/>' +
    '</svg>'
  )
}

/**
 * 按钮外面的容器：尺寸必须照抄内置的「小按钮」。
 *
 * 实测（UIA，2026-10-01）：内置「开始录音」按钮是 **42×43 设备像素**，
 * 而它的类名是 `_button_1rv3m_2 _ghost_1rv3m_45 _sm_1rv3m_28` —— 也就是 28px
 * CSS，在 150% 显示缩放下正好 42。这里以前写死 42px CSS，于是渲染成 63×65，
 * 比邻居大 1.5 倍：这就是「看着丑」的主因，不是图标本身。
 */
function makeHost(attr) {
  const host = document.createElement('span')
  host.setAttribute(attr, '1')
  host.style.cssText = [
    'display:inline-flex',
    'align-items:center',
    'justify-content:center',
    'flex:0 0 auto',
    'width:28px',
    'height:28px',
    'margin:0',
    'padding:0',
    'box-sizing:border-box',
    'line-height:0'
  ].join(';')
  return host
}

/**
 * 统一的按钮样式 —— 对齐输入框里**同一排的图标按钮**（「+」），而不是 Button 的通用 sm。
 *
 * 出处（@deepseek-ai/dsh-client-ui-conversation 的 InputBar 样式表）：
 *   .add{corner-shape:round;background:var(--dsw-specific-selector);width:28px;height:28px;
 *        color:var(--dsw-alias-label-primary);border-radius:999px;place-items:center;display:grid}
 *   .add:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}
 *
 * 也就是说「+」是**圆形**、hover 是实心浅灰。之前我用的是 Button 的 `sm`（8px 圆角）+
 * 幽灵 hover 的半透明色 —— 和同排邻居既不同形状也不同颜色，用户一眼就看出来了
 * （2026-10-01：「官方的是半圆形的，这个自己做的甚至对不到中间」）。
 *
 * 居中改用 `display:grid + place-items:center`（与 .add 完全一致）：inline-flex 会被
 * 行高/基线影响，grid 不会。
 */
/**
 * 把样式**只写样式、不挂监听**，便于反复重放（幂等）。
 *
 * ⚠ 坑一：`style.cssText` 只认 **kebab-case** 的 CSS 属性名。早先我写成
 * `borderRadius:` / `placeItems:` 这种 camelCase，浏览器**静默丢弃**这几条声明 ——
 * 圆角没了、居中也没了，而 HMR 一轮轮覆盖，肉眼根本看不出哪一步坏的。
 * 用户原话：「官方的是半圆形的，这个自己做的，甚至都对不到中间」。
 *
 * ⚠ 坑二：**别猜，量**。用 MCP 真截图逐像素量了同排的听写按钮（150% 缩放）：
 *     尺寸  42×42 设备px = 28×28 CSS   ← 与我们一致
 *     底色  #F2F3F4                    ← 与 `--dsw-alias-interactive-bg-hover-solid` 一致
 *     圆角  内缩 6 设备px = **4 CSS**  ← 即 `--dsw-radius-xs`，不是 sm(8px)
 * 所以按钮 = 28×28 / 圆角 4px / 居中 / hover 浅灰。用 999px 反而会变成圆形，与邻居不一致。
 */
function styleButton(btn) {
  btn.style.cssText = [
    'box-sizing:border-box',
    'display:grid',
    'place-items:center',
    'width:28px',
    'height:28px',
    'padding:0',
    'margin:0',
    'border:none',
    'border-radius:var(--dsw-radius-xs,4px)',
    'flex:0 0 auto',
    'cursor:pointer',
    'color:var(--dsw-alias-label-primary,currentColor)',
    'line-height:0',
    'background:transparent',
    'transition:background .15s ease'
  ].join(';')
}

/** hover 底色：与「+」按钮的 `.add:hover` 同源（实心浅灰）。 */
function attachHover(btn) {
  btn.addEventListener('mouseenter', function () {
    try {
      btn.style.background = 'var(--dsw-alias-interactive-bg-hover-solid,rgba(127,127,127,.18))'
    } catch (e) {
      /* 忽略 */
    }
  })
  btn.addEventListener('mouseleave', function () {
    try {
      btn.style.background = 'transparent'
    } catch (e) {
      /* 忽略 */
    }
  })
}

/**
 * 每次扫描都重申一次样式，但**已经对了就不动**。
 *
 * 为什么要重申：client-hmr 会反复重新执行本插件，早期版本留下的实例可能还活着
 * （它们自己的 setInterval 还在跑），会按旧代码把按钮挪回旧位置/旧样式。
 * 为什么要"对了就不动"：styleButton 会把 background 写回 transparent，
 * 如果用户正在悬停，每 3 秒重申一次会让 hover 底色闪一下。
 */
function reassertHost(host, btn) {
  try {
    if (!host || !btn) return
    // 用计算样式判断"已经对了"，而不是读内联声明（谁写的都能判出来）
    const cs = window.getComputedStyle(btn)
    if (cs.display === 'grid' && cs.borderRadius === '4px') return
    styleButton(btn)
    attachHover(btn)
  } catch (e) {
    /* 忽略 */
  }
}

/**
 * 自绘 tooltip —— 逐条对齐官方 Tooltip（@deepseek-ai/dsh-client-ui-primitives）：
 *
 * CSS（Tooltip.module.css .bubble）：
 *   position fixed / z-index 1100（portal 情形）/ width max-content / max-width 50vw /
 *   padding 3px 7px / border-radius var(--dsw-radius-sm) /
 *   background var(--dsw-alias-tooltip-bg) / color var(--dsw-static-neutral-bluish-00) /
 *   font 13px/20px / white-space:pre-line / overflow-wrap:break-word /
 *   pointer-events:none / transform translate(-50%,-100%) / animation tooltip-in 150ms
 *   display inline-flex / align-items center / gap 8px（给快捷键键帽留位）
 *
 * 定位（Tooltip 组件本体）：
 *   gap = 8（锚点与气泡的距离）、edgeMargin = 12（离视口边至少 12px）、
 *   上方放不下就翻到下方（`fitsAbove` 判定），水平居中后再夹到 [12, vw-12-w] 区间。
 *
 * 延迟：听写那颗按钮写的是 `<Tooltip label=… side="top" portal>`，**没给 delayMs**，
 * 也就是官方默认 **0ms（立即显示）** —— 所以这里也用 0，不再自己拍一个 400ms。
 */
const TIP_GAP = 8
const TIP_EDGE = 12

function attachTooltip(btn, getText) {
  let tip = null
  let timer = null

  function hide() {
    try {
      if (timer) clearTimeout(timer)
    } catch (e) {
      /* 忽略 */
    }
    timer = null
    try {
      if (tip && tip.parentNode) tip.parentNode.removeChild(tip)
    } catch (e) {
      /* 忽略 */
    }
    tip = null
  }

  function show() {
    try {
      const text = getText()
      if (!text) return
      tip = document.createElement('div')
      tip.setAttribute(TIP_ATTR, '1')
      tip.textContent = text
      tip.style.cssText = [
        'display:inline-flex',
        'align-items:center',
        'gap:8px',
        'position:fixed',
        'z-index:1100',
        'width:max-content',
        'max-width:50vw',
        'padding:3px 7px',
        'border-radius:var(--dsw-radius-sm,8px)',
        'background:var(--dsw-alias-tooltip-bg,#2c2c2e)',
        'color:var(--dsw-static-neutral-bluish-00,#fff)',
        'font-size:13px',
        'line-height:20px',
        'white-space:pre-line',
        'overflow-wrap:break-word',
        'pointer-events:none',
        'transform:translate(-50%,-100%)',
        'animation:dsh-capture-tip-in 150ms var(--ds-ease-in-out,ease-in-out)'
      ].join(';')
      document.body.appendChild(tip)

      const r = btn.getBoundingClientRect()
      const w = tip.offsetWidth
      const h = tip.offsetHeight
      // 水平：居中后夹进 [TIP_EDGE, vw - TIP_EDGE - w]
      const half = w / 2
      const left = Math.min(
        Math.max(r.left + r.width / 2, half + TIP_EDGE),
        Math.max(half + TIP_EDGE, window.innerWidth - TIP_EDGE - half)
      )
      // 垂直：默认在上方；上方放不下就翻到下方（官方同款判定）
      const fitsAbove = r.top - TIP_GAP - h >= TIP_EDGE
      tip.style.left = left + 'px'
      if (fitsAbove) {
        tip.style.top = Math.max(TIP_EDGE, r.top - TIP_GAP) + 'px'
      } else {
        tip.style.top = r.bottom + TIP_GAP + 'px'
        tip.style.transform = 'translate(-50%,0)'
      }
    } catch (e) {
      /* 忽略 */
    }
  }

  btn.addEventListener('mouseenter', function () {
    hide()
    try {
      timer = setTimeout(show, 0)
    } catch (e) {
      show()
    }
  })
  btn.addEventListener('mouseleave', hide)
  btn.addEventListener('mousedown', hide)
  btn.addEventListener('blur', hide)

  /**
   * 第二道保险：拦住鼠标事件向上冒泡。
   *
   * 万一 Tooltip 的包装层比预想的深、我们仍然落在它内部，只要事件不冒泡到 React
   * 挂在根上的委托监听，宿主自己的 Tooltip（「听写」那条）就不会被触发。
   * 我们自己的 mouseenter 是直接挂在本按钮上的，不受影响。
   */
  try {
    btn.addEventListener('mouseover', function (ev) {
      ev.stopPropagation()
    })
    btn.addEventListener('mouseout', function (ev) {
      ev.stopPropagation()
    })
    btn.addEventListener('pointerover', function (ev) {
      ev.stopPropagation()
    })
    btn.addEventListener('pointerout', function (ev) {
      ev.stopPropagation()
    })
  } catch (e) {
    /* 忽略 */
  }
}

/**
 * 录屏按钮的悬浮提示文案。
 *
 * 用户明确要求（2026-10-01）：**就两个字**，不要功能介绍。所以常态只有「录屏」，
 * 只有宿主路由没挂上这种真需要用户动作的情况才补一句。
 */
function recTipText() {
  if (rec.state === 'recording') return '停止录屏'
  if (rec.state === 'busy') return '处理中…'
  if (hostCapable === false) return '录屏\n宿主路由没挂上（' + hostProbeDetail + '），需完整重启桌面版'
  return '录屏'
}

/** 截图按钮的悬浮提示文案。同样只两个字。 */
function shotTipText() {
  if (shotBusy) return '处理中…'
  if (hostCapable === false) return '截图\n宿主路由没挂上（' + hostProbeDetail + '），需完整重启桌面版'
  return '截图'
}

function paintRec() {
  try {
    const btn = document.querySelector('[' + REC_ATTR + ']')
    if (!btn) return
    if (rec.state === 'recording') {
      btn.style.color = '#e5484d'
      btn.setAttribute('aria-label', '停止录屏')
    } else if (rec.state === 'busy') {
      btn.style.color = '#d9a441'
      btn.setAttribute('aria-label', '正在处理录屏')
    } else {
      btn.style.color = ''
      btn.setAttribute('aria-label', '录屏提问')
    }
    paintRecBadge()
  } catch (e) {
    /* 忽略 */
  }
}

/**
 * 录制中在录屏按钮右上角挂一个红点计时。
 *
 * 为什么：录屏是「静默」的，用户看不到任何动静，很容易以为卡死/没在录
 * （2026-10-01 就是这么反馈的）。红点 + 秒数让状态一眼可见。
 */
function paintRecBadge() {
  try {
    const host = document.querySelector('[' + REC_ATTR + ']')
    if (!host) return
    let badge = host.querySelector('[data-dsh-capture-badge]')
    if (rec.state === 'recording') {
      if (!badge) {
        badge = document.createElement('span')
        badge.setAttribute('data-dsh-capture-badge', '1')
        badge.style.cssText = [
          'position:absolute',
          'top:-3px',
          'right:-3px',
          'min-width:14px',
          'height:14px',
          'padding:0 3px',
          'border-radius:8px',
          'background:#e5484d',
          'color:#fff',
          'font-size:9px',
          'line-height:14px',
          'text-align:center',
          'font-weight:600',
          'pointer-events:none'
        ].join(';')
        host.style.position = 'relative'
        host.appendChild(badge)
      }
      badge.textContent = String(rec.seconds)
    } else if (badge && badge.parentNode) {
      badge.parentNode.removeChild(badge)
    }
  } catch (e) {
    /* 忽略 */
  }
}

function paintShot() {
  try {
    const btn = document.querySelector('[' + SHOT_ATTR + ']')
    if (!btn) return
    if (shotBusy) {
      btn.style.color = '#d9a441'
      btn.setAttribute('aria-label', '正在截图')
    } else {
      btn.style.color = ''
      btn.setAttribute('aria-label', '截图')
    }
  } catch (e) {
    /* 忽略 */
  }
}

/**
 * 该插在哪：**一路剥掉所有"只有一个子元素"的包装层**，插到它们外面。
 *
 * 听写按钮的结构是（见 @deepseek-ai/dsh-experimental-client-ui-voice-input
 * lib/client.js:5073）：
 *     <Tooltip label="听写"><span class="triggerAnchor"><Button/></span></Tooltip>
 * 插进那层 span 里的话，hover 命中的是外层 anchor —— 鼠标停在我们按钮上，弹出来的
 * 却是「听写」（2026-10-01 用户实测反馈）；而且那层的 flex 布局会把我们算成
 * "听写的一部分"，看起来就是没对齐。
 *
 * 为什么循环剥而不是只剥一层：Tooltip 实现里到底套了几层 span 无法从这里断言，
 * 只剥一层可能仍然留在 Tooltip 的锚点里。剥到"有兄弟"的那一层为止最稳
 * （工具条行本身有多个子元素，一定会停下）。
 */
function insertionPoint(anchor) {
  let node = anchor
  let parent = anchor.parentElement
  for (let i = 0; i < 6 && parent; i++) {
    if (parent.children.length !== 1) break
    node = parent
    parent = parent.parentElement
  }
  if (!parent) return null
  return { parent: parent, before: node }
}

/**
 * 把两个按钮贴在「听写」左边。
 *
 * 期望顺序（左 → 右）：录屏 | 截图 | 听写。都以听写按钮为锚点定位，
 * 这样 React 重渲染把按钮挤走时，下一次扫描能拉回来。
 */
function ensureButtons() {
  try {
    const anchor = findDictationButton()
    if (!anchor) return
    const place = insertionPoint(anchor)
    if (!place) return
    const parent = place.parent
    const before = place.before

    let shotHost = document.querySelector('[' + SHOT_ATTR + ']')
    if (!shotHost || !shotHost.isConnected) {
      shotHost = makeHost(SHOT_ATTR)
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.setAttribute(SHOT_ATTR, '1')
      btn.setAttribute('aria-label', '截图')
      styleButton(btn)
      attachHover(btn)
      btn.innerHTML = shotIcon()
      attachTooltip(btn, shotTipText)
      btn.addEventListener('mousedown', function (ev) {
        try {
          ev.preventDefault()
        } catch (e) {
          /* 忽略 */
        }
      })
      btn.addEventListener('click', function (ev) {
        try {
          ev.preventDefault()
          ev.stopPropagation()
          shootOnce()
        } catch (e) {
          warn('shot click', e)
        }
      })
      shotHost.appendChild(btn)
    }
    if (shotHost.nextElementSibling !== before) parent.insertBefore(shotHost, before)

    let recHost = document.querySelector('[' + REC_ATTR + ']')
    if (!recHost || !recHost.isConnected) {
      recHost = makeHost(REC_ATTR)
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.setAttribute(REC_ATTR, '1')
      btn.setAttribute('aria-label', '录屏提问')
      styleButton(btn)
      attachHover(btn)
      btn.innerHTML = recIcon()
      attachTooltip(btn, recTipText)
      btn.addEventListener('mousedown', function (ev) {
        try {
          ev.preventDefault()
        } catch (e) {
          /* 忽略 */
        }
      })
      btn.addEventListener('click', function (ev) {
        try {
          ev.preventDefault()
          ev.stopPropagation()
          toggleRec()
        } catch (e) {
          warn('rec click', e)
        }
      })
      recHost.appendChild(btn)
    }
    if (recHost.nextElementSibling !== shotHost) parent.insertBefore(recHost, shotHost)

    // 每轮重申样式（旧实例可能用旧代码把样式改回去了）；已经对就不动，避免 hover 闪烁
    reassertHost(shotHost, shotHost.firstElementChild)
    reassertHost(recHost, recHost.firstElementChild)

    paintRec()
    paintShot()
  } catch (e) {
    warn('ensureButtons', e)
  }
}

// ----------------------------------------------------------- 抓画面（宿主侧）

/** 宿主抓屏路由（见 lib/index.js）。 */
const SHOT_ROUTE = '/plugins/dsh-screen-capture-record-desktop/shot'

/** 宿主抓屏是否可用：null = 还没探过，false = 不可用（宿主没重启）。 */
let hostCapable = null

/** 探活失败的原因（HTTP 状态或异常消息），用于把话说清楚。 */
let hostProbeDetail = ''

/** 探一次宿主抓屏路由；返回是否可用。 */
async function hostProbe() {
  try {
    const res = await fetch(SHOT_ROUTE + '?probe=1&ts=' + Date.now(), { cache: 'no-store' })
    hostCapable = !!res.ok
    hostProbeDetail = res.ok ? '' : 'HTTP ' + res.status
  } catch (e) {
    hostCapable = false
    hostProbeDetail = String((e && e.message) || e)
  }
  return hostCapable
}

/**
 * 让宿主抓一张整屏，返回可裁剪的 ImageBitmap。
 *
 * 为什么不在这里用 getDisplayMedia：桌面版 Electron 把所有媒体权限写死成拒绝、
 * 且 setDisplayMediaRequestHandler 回空对象，那条路在桌面壳里永远失败（见文件头）。
 *
 * @param {{format?: string, maxEdge?: number, quality?: number}} [opts]
 *        maxEdge 为 0 表示要原生分辨率（选区取景用）。
 * @returns {Promise<{bitmap: ImageBitmap, width: number, height: number}>}
 */
async function hostShot(opts) {
  const o = opts || {}
  const q = [
    'format=' + (o.format || 'jpg'),
    'maxEdge=' + (o.maxEdge || 0),
    'quality=' + Math.round((o.quality || 0.82) * 100),
    'ts=' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  ]
  let res
  try {
    res = await fetch(SHOT_ROUTE + '?' + q.join('&'), { cache: 'no-store' })
  } catch (e) {
    hostCapable = false
    throw new Error('连不上宿主抓屏路由（完整重启桌面版后才会挂上）')
  }
  if (!res.ok) {
    if (res.status === 404) hostCapable = false
    let detail = 'HTTP ' + res.status
    try {
      const j = await res.json()
      if (j && j.error) detail = j.error
    } catch (e) {
      /* 不是 JSON 就用状态码 */
    }
    throw new Error(detail)
  }
  hostCapable = true
  const blob = await res.blob()
  if (!blob || !blob.size) throw new Error('宿主返回了空图')
  const bitmap = await createImageBitmap(blob)
  return { bitmap: bitmap, width: bitmap.width, height: bitmap.height }
}

/** 把 bitmap 上的一个矩形裁出来、按上限缩放、压成 JPEG。 */
async function cropToJpeg(bitmap, rect, maxDimension, quality) {
  const sx = Math.max(0, Math.min(bitmap.width - 1, Math.round(rect.x)))
  const sy = Math.max(0, Math.min(bitmap.height - 1, Math.round(rect.y)))
  const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(rect.w)))
  const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(rect.h)))
  const scale = Math.min(1, maxDimension / Math.max(sw, sh))
  const tw = Math.max(2, Math.round(sw * scale))
  const th = Math.max(2, Math.round(sh * scale))

  const canvas = document.createElement('canvas')
  canvas.width = tw
  canvas.height = th
  canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, tw, th)

  const blob = await canvasToJpeg(canvas, quality)
  if (!blob || !blob.size) throw new Error('转 JPEG 失败')
  return blob
}

/**
 * 选区浮层：把抓到的整屏铺在遮罩上，拖一个矩形，Enter / 双击 / 「用这张」确认。
 *
 * 交互约定：单击不拖 = 整屏；Esc / 右键 / 「取消」/ 点遮罩空白 = 放弃。
 * 风格照本机约定走深色卡片（深底 + 琥珀→橙红描边），不弹系统框。
 *
 * @param {ImageBitmap} bitmap 宿主抓到的整屏
 * @returns {Promise<{x:number,y:number,w:number,h:number}|null>} 图像坐标系里的矩形；null = 取消
 */
function pickRegion(bitmap) {
  return new Promise(function (resolve) {
    const OVERLAY_ATTR = 'data-dsh-capture-picker'
    const scale = Math.min(
      1,
      (window.innerWidth * 0.92) / bitmap.width,
      (window.innerHeight * 0.8) / bitmap.height
    )
    const dw = Math.max(1, Math.round(bitmap.width * scale))
    const dh = Math.max(1, Math.round(bitmap.height * scale))
    const k = bitmap.width / dw

    // 遮罩用官方 Modal 的 mask 令牌（Modal.module.css .mask::after → --dsw-alias-bg-mask-1）
    const root = document.createElement('div')
    root.setAttribute(OVERLAY_ATTR, '1')
    root.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483001',
      'background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45))',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'justify-content:center',
      'gap:10px',
      'user-select:none',
      'cursor:crosshair'
    ].join(';')

    const stage = document.createElement('div')
    stage.style.cssText = [
      'position:relative',
      'width:' + dw + 'px',
      'height:' + dh + 'px',
      'border-radius:var(--dsw-radius-md,12px)',
      'overflow:hidden',
      'background:#000',
      'box-shadow:var(--dsw-elevation-prominent,0 18px 60px rgba(0,0,0,.55))'
    ].join(';')

    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.style.cssText = 'width:100%;height:100%;display:block;opacity:.9'
    try {
      canvas.getContext('2d').drawImage(bitmap, 0, 0)
    } catch (e) {
      /* 画不出底图也还能盲选 */
    }
    stage.appendChild(canvas)

    const sel = document.createElement('div')
    sel.style.cssText = [
      'position:absolute',
      'left:0',
      'top:0',
      'width:0',
      'height:0',
      'border:1.5px solid #ffb020',
      'background:rgba(255,176,32,.12)',
      'box-shadow:0 0 0 9999px rgba(9,11,15,.36)',
      'border-radius:2px',
      'pointer-events:none'
    ].join(';')
    stage.appendChild(sel)

    // 工具条 = 官方 Modal 的浮层卡片语言（Modal.module.css .dialog）：
    //   background var(--dsw-alias-bg-layer-2) / border-radius var(--dsw-radius-lg) /
    //   box-shadow var(--dsw-elevation-prominent) / gap 8px（同 .footer）
    // 两个按钮 = 官方 Button 的 sm 变体（Button.module.css .sm + .primary/.outline）：
    //   height 28 / padding 0 10px / border-radius var(--dsw-radius-sm) / font 12px/18px
    const bar = document.createElement('div')
    bar.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:8px',
      'padding:8px 12px',
      'border-radius:var(--dsw-radius-lg,16px)',
      'background:var(--dsw-alias-bg-layer-2,#fff)',
      'color:var(--dsw-alias-label-primary)',
      'box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.32))',
      'border:0.5px solid var(--dsw-alias-border-l1,transparent)'
    ].join(';')

    const hint = document.createElement('span')
    hint.textContent = '拖动框选 · 单击=整屏 · Enter 确认 · Esc 取消'
    hint.style.cssText = 'color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin-right:4px'
    bar.appendChild(hint)

    function makeBarButton(text, primary) {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = text
      b.style.cssText = [
        'box-sizing:border-box',
        'display:inline-flex',
        'align-items:center',
        'justify-content:center',
        'gap:4px',
        'height:28px',
        'padding:0 10px',
        'border-radius:var(--dsw-radius-sm,8px)',
        'font-size:12px',
        'line-height:18px',
        'cursor:pointer',
        'border:' + (primary ? 'none' : '0.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.18))'),
        'background:' + (primary ? 'var(--dsw-alias-button-primary-fill,#4d6bfe)' : 'transparent'),
        'color:' + (primary
          ? 'var(--dsw-alias-label-primary-foreground,#fff)'
          : 'var(--dsw-alias-label-primary)')
      ].join(';')
      // hover 与官方一致：primary 用 button-primary-hover，outline 用 interactive-bg-hover
      b.addEventListener('mouseenter', function () {
        b.style.background = primary
          ? 'var(--dsw-alias-button-primary-hover,#3f5cf0)'
          : 'var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))'
      })
      b.addEventListener('mouseleave', function () {
        b.style.background = primary
          ? 'var(--dsw-alias-button-primary-fill,#4d6bfe)'
          : 'transparent'
      })
      return b
    }
    // 官方 footer 的动作顺序是「次要在前、主要在后，右对齐」（Modal.module.css .footer）
    const okBtn = makeBarButton('用这张', true)
    const cancelBtn = makeBarButton('取消', false)
    bar.appendChild(cancelBtn)
    bar.appendChild(okBtn)

    root.appendChild(stage)
    root.appendChild(bar)
    document.body.appendChild(root)

    let rect = { x: 0, y: 0, w: bitmap.width, h: bitmap.height }
    let dragging = false
    let start = null
    let moved = false
    let settled = false

    function paint() {
      sel.style.left = rect.x / k + 'px'
      sel.style.top = rect.y / k + 'px'
      sel.style.width = Math.max(0, rect.w / k) + 'px'
      sel.style.height = Math.max(0, rect.h / k) + 'px'
    }
    paint()

    function finish(result) {
      if (settled) return
      settled = true
      try {
        root.remove()
      } catch (e) {
        /* 忽略 */
      }
      document.removeEventListener('keydown', onKey, true)
      resolve(result)
    }

    function onKey(ev) {
      if (ev.key === 'Escape') {
        ev.preventDefault()
        finish(null)
      } else if (ev.key === 'Enter') {
        ev.preventDefault()
        finish(rect)
      }
    }
    document.addEventListener('keydown', onKey, true)

    stage.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return
      ev.preventDefault()
      const r = stage.getBoundingClientRect()
      dragging = true
      moved = false
      start = { x: ev.clientX - r.left, y: ev.clientY - r.top }
      rect = { x: 0, y: 0, w: 0, h: 0 }
    })

    stage.addEventListener('pointermove', function (ev) {
      if (!dragging) return
      const r = stage.getBoundingClientRect()
      const cx = Math.max(0, Math.min(dw, ev.clientX - r.left))
      const cy = Math.max(0, Math.min(dh, ev.clientY - r.top))
      if (Math.abs(cx - start.x) > 3 || Math.abs(cy - start.y) > 3) moved = true
      rect = {
        x: Math.min(start.x, cx) * k,
        y: Math.min(start.y, cy) * k,
        w: Math.abs(cx - start.x) * k,
        h: Math.abs(cy - start.y) * k
      }
      paint()
    })

    stage.addEventListener('pointerup', function () {
      if (!dragging) return
      dragging = false
      if (!moved || rect.w < 4 || rect.h < 4) {
        rect = { x: 0, y: 0, w: bitmap.width, h: bitmap.height }
      }
      paint()
    })

    stage.addEventListener('dblclick', function (ev) {
      ev.preventDefault()
      finish(rect)
    })
    stage.addEventListener('contextmenu', function (ev) {
      ev.preventDefault()
      finish(null)
    })
    root.addEventListener('mousedown', function (ev) {
      if (ev.target === root) {
        ev.preventDefault()
        finish(null)
      }
    })

    okBtn.addEventListener('click', function (ev) {
      ev.preventDefault()
      finish(rect)
    })
    cancelBtn.addEventListener('click', function (ev) {
      ev.preventDefault()
      finish(null)
    })
  })
}

/**
 * 挑最像「composer 附件入口」的那个 file input。
 *
 * 为什么要挑：页面上不止一个 `input[type=file]`（设置里的头像、目录选择器等），
 * 旧写法盲取**最后一个**，撞上别的入口就会出现「提示成功但附件里什么都没有」。
 * 评分依据（都是 DOM 层能看到的信号）：multiple、accept 放宽/含 image、
 * 不在对话框里、离输入框越近越优先。
 */
function findAttachmentInput() {
  const inputs = Array.prototype.slice.call(document.querySelectorAll('input[type="file"]'))
  if (!inputs.length) return null

  const composer = findComposerInput()
  const composerRect = composer ? composer.getBoundingClientRect() : null

  let best = null
  let bestScore = -Infinity
  for (let i = 0; i < inputs.length; i++) {
    const el = inputs[i]
    if (el.disabled) continue
    const accept = (el.getAttribute('accept') || '').toLowerCase()
    let score = 0
    if (el.multiple) score += 4
    if (!accept) score += 2
    else if (accept.indexOf('image') !== -1) score += 3
    else score -= 2
    // 对话框/弹窗里的入口优先级压低
    if (el.closest('[role="dialog"], [aria-modal="true"]')) score -= 5
    if (composerRect) {
      const r = el.getBoundingClientRect()
      const dy = Math.abs(r.top - composerRect.bottom)
      score += Math.max(0, 3 - dy / 200)
    }
    if (score > bestScore) {
      bestScore = score
      best = el
    }
  }
  return best
}

/**
 * 把文件塞进 composer 的附件。返回实际走通的那条路（'input' / 'paste'）。
 *
 * 桌面版 composer 里有一个 hidden 的 `input[type=file][multiple]`
 * （@deepseek-ai/dsh-client-ui-conversation lib/client.js:17512，就在「+」按钮旁，
 * onChange = onPickFiles），它挂着 React 自己的 onChange。所以用 DataTransfer 造一个
 * FileList 派发 change，让宿主自己的 intakeFiles 去处理 —— 不碰任何 React 内部 API。
 * 这与网页版一直在用的 dsh-screen-record 是同一招。
 *
 * ⚠⚠ 只走一条通道，绝不"两条都试"（2026-10-01 实测教训）：
 *   上一版为了兜底，先派发 file input 的 change，再观测输入框附近 500ms 的 DOM 变化，
 *   没变化就再补一次 paste —— 结果两条都成功，同一段录像被挂进附件**两次**
 *   （用户消息里那条 [File …] 出现了两遍）。观测失灵的原因是：附件卡片渲染在输入框
 *   **之外**的节点里，盯着 input.parentElement 这棵子树看不到任何变化。
 *   既然 input 通道本身是通的（网页版天天在用），就只用它；只有拿不到 input
 *   或派发抛错时才退到 paste。宁可有明确失败提示，也不要静默重复。
 */
async function pushToComposer(files) {
  const input = findAttachmentInput()

  if (input) {
    try {
      const dt = new DataTransfer()
      for (let i = 0; i < files.length; i++) dt.items.add(files[i])
      input.files = dt.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
      // 消费完就把 input 清空：防止后续任何一次重渲染把同一个 FileList 再读一遍
      setTimeout(function () {
        try {
          input.value = ''
        } catch (e) {
          /* 忽略 */
        }
      }, 0)
      return 'input'
    } catch (e) {
      warn('附件 input 通道派发失败，退到 paste', e)
    }
  } else {
    const total = document.querySelectorAll('input[type="file"]').length
    warn('页面上有 ' + total + ' 个 file input，但都不像附件入口，退到 paste')
  }

  // 兜底（只在上面没走通时）：编辑器自己的 paste → intakeFiles
  const target = findComposerInput()
  if (!target) throw new Error('找不到附件入口，也找不到输入框')
  const dt2 = new DataTransfer()
  for (let i = 0; i < files.length; i++) dt2.items.add(files[i])
  target.dispatchEvent(
    new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt2
    })
  )
  return 'paste'
}

/** 落盘路由（见 lib/index.js）：保证附件之外一定还有文件。 */
const SAVE_ROUTE = '/plugins/dsh-screen-capture-record-desktop/save'

/**
 * 把一批图片写到宿主磁盘：<DSH_HOME>\dsh-screen-capture\<base>\<名字>
 * @returns {Promise<string|null>} 目录绝对路径；全部失败返回 null
 */
async function saveFramesToHost(files, base) {
  let dir = null
  for (let i = 0; i < files.length; i++) {
    const name = files[i].name || 'frame-' + pad2(i + 1) + '.jpg'
    try {
      const res = await fetch(
        SAVE_ROUTE + '?dir=' + encodeURIComponent(base) + '&file=' + encodeURIComponent(name),
        { method: 'POST', body: files[i], cache: 'no-store' }
      )
      if (!res.ok) continue
      const json = await res.json()
      if (json && json.dir) dir = json.dir
    } catch (e) {
      warn('saveFramesToHost', e)
    }
  }
  return dir
}

/** 把文本塞进剪贴板（失败就算了，只为方便用户去文件管理器粘贴）。 */
async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text)
    return true
  } catch (e) {
    return false
  }
}

// ------------------------------------------------------------- 录屏主流程

/** 宿主录屏路由（见 lib/index.js）。 */
const REC_START = '/plugins/dsh-screen-capture-record-desktop/record/start'
const REC_STOP = '/plugins/dsh-screen-capture-record-desktop/record/stop'
const REC_FILE = '/plugins/dsh-screen-capture-record-desktop/record/file'
const REC_STATUS = '/plugins/dsh-screen-capture-record-desktop/record/status'

/**
 * 录制状态。
 *
 * 关键设计（2026-10-01 重做）：**录像由宿主侧生成一个 .webm 视频文件**，浏览器只负责
 * 「按开始 / 按结束 + 把这一个视频塞进附件」。上一版在浏览器里逐帧抓 JPEG 当附件
 * （一次几十张图片）方向就错了 —— 抽帧是 Agent 的事：视频是完整证据，少一帧还能重抽，
 * 抽帧密度也能按问题现场调（本机现成 tools/screen-watch/watch_video.py，opencv 解 VP8）。
 */
let rec = { state: 'idle', startedAt: 0, file: '', seconds: 0 }
let recLocked = false
let recTicker = null
let shotBusy = false
/** 最近一次收尾有没有把视频真的挂进附件（录制中点「发送」要靠它决定放不放行）。 */
let lastAttach = { ok: false, at: 0, name: '' }

function setRecState(next) {
  rec.state = next
  paintRec()
}

/**
 * 按钮点击：录屏中 = 停；否则 = 开。
 *
 * ⚠ 顺序不能反：startRec 会在录制期间持有 `recLocked`，旧写法
 * `if (recLocked) return` 放在最前面会把"停止"这一次点击直接吞掉 —— 表现为
 * "能开不能关"。必须先判 state 再判锁（现在 startRec 的 finally 也会尽早释放锁，
 * 双保险）。
 */
function toggleRec() {
  if (rec.state === 'recording') {
    stopRec()
    return
  }
  if (recLocked) return
  startRec()
}

/** 录制期间按 Esc 也能停：万一按钮状态卡住，还有一条退路。 */
function onRecKeydown(ev) {
  if (ev.key === 'Escape' && rec.state === 'recording') {
    ev.preventDefault()
    stopRec()
  }
}

/** 录制中每秒刷新一次计时（红点徽标显示已录秒数）。 */
function startRecTicker() {
  stopRecTicker()
  recTicker = setInterval(function () {
    try {
      if (rec.state !== 'recording') return
      rec.seconds = Math.round((Date.now() - rec.startedAt) / 1000)
      paintRec()
      if (rec.seconds >= cfg().maxSeconds) {
        toast('到时长上限，自动结束', 3000)
        stopRec()
      }
    } catch (e) {
      /* 忽略 */
    }
  }, 1000)
}

function stopRecTicker() {
  try {
    if (recTicker) clearInterval(recTicker)
  } catch (e) {
    /* 忽略 */
  }
  recTicker = null
}

/** 开录：让宿主起 recorder.py → ffmpeg（VP8/WebM），一路录到一个真视频文件。 */
async function startRec() {
  const c = cfg()
  recLocked = true
  try {
    if (hostCapable === null) await hostProbe()
    if (!hostCapable) {
      toast('宿主路由没挂上（' + hostProbeDetail + '）：完整重启桌面版后再生效', 7000)
      return
    }

    let res = null
    let json = null
    try {
      res = await fetch(
        REC_START +
          '?fps=' + c.fps +
          '&maxEdge=' + c.maxDimension +
          '&quality=' + Math.round(c.quality * 100) +
          '&seconds=' + c.maxSeconds,
        { method: 'POST', cache: 'no-store' }
      )
      json = await res.json().catch(function () {
        return null
      })
    } catch (e) {
      toast('起录屏失败：连不上宿主录屏路由（完整重启桌面版后生效）', 9000)
      return
    }
    if (!res.ok || !json || json.ok !== true) {
      toast('起录屏失败：' + ((json && json.error) || 'HTTP ' + res.status), 9000)
      return
    }

    rec = { state: 'recording', startedAt: Date.now(), file: json.file || '', seconds: 0 }
    paintRec()
    startRecTicker()
    document.addEventListener('keydown', onRecKeydown, true)
    toast('录制中… 再点一次（或按 Esc）结束；结束时生成一个 .webm 视频直接进附件', 6000)
  } catch (e) {
    warn('startRec', e)
    toast('起录屏失败：' + ((e && e.message) || e), 8000)
  } finally {
    recLocked = false
  }
}

function stopRec() {
  if (rec.state !== 'recording') return null
  setRecState('busy')
  stopRecTicker()
  // 返回收尾 Promise：录制中直接点「发送」时要等它把视频挂进附件
  return finishRec()
}

/** 停录 → 取回整段视频 → 放进附件（并报告磁盘路径）。 */
async function finishRec() {
  const startedAt = rec.startedAt
  const t0 = Date.now()
  let stopMs = 0
  let blobMs = 0
  lastAttach = { ok: false, at: 0, name: '', stopMs: 0, blobMs: 0, attachMs: 0 }
  try {
    let res = null
    let json = null
    try {
      res = await fetch(REC_STOP, { method: 'POST', cache: 'no-store' })
      json = await res.json().catch(function () {
        return null
      })
      stopMs = Date.now() - t0
    } catch (e) {
      throw new Error('连不上宿主录屏路由')
    }
    if (!res.ok || !json || json.ok !== true) {
      // 把宿主给的原因（或子进程日志尾巴）带出来：只报「HTTP 200」等于没说
      const why = json && (json.error || (json.log ? String(json.log).trim().split('\n').slice(-2).join(' ') : ''))
      throw new Error(why || 'HTTP ' + res.status)
    }

    const file = json.file || ''
    const bytes = json.bytes || 0
    const secs = json.seconds || Math.max(1, Math.round((Date.now() - startedAt) / 1000))

    // 浏览器必须拿到 File 才能塞进 composer 的附件，所以把整段视频取回来
    let blob = null
    try {
      const got = await fetch(REC_FILE + '?ts=' + Date.now(), { cache: 'no-store' })
      if (got.ok) blob = await got.blob()
      blobMs = Date.now() - t0 - stopMs
    } catch (e) {
      warn('取录像失败', e)
    }

    if (!blob || !blob.size) {
      toast('录到 ' + sizeText(bytes) + '，但取回失败；文件在 ' + file, 13000)
      return
    }

    const name = file.split(/[\\/]/).pop() || 'rec-' + stamp() + '.webm'
    const video = new File([blob], name, { type: 'video/webm' })

    let attached = true
    let attachError = ''
    let channel = ''
    try {
      channel = await pushToComposer([video])
    } catch (e) {
      attached = false
      attachError = (e && e.message) || String(e)
      warn('pushToComposer', e)
    }
    const via = channel === 'paste' ? '（走粘贴通道）' : ''
    const attachMs = Date.now() - t0

    if (attached) {
      // stopMs/blobMs/attachMs 留在 lastAttach 里：录制中点「发送」时要把
      // 「收尾用了多久」一并告诉用户，不然只会感觉「点了半天没反应」。
      lastAttach = { ok: true, at: Date.now(), name: name, stopMs: stopMs, blobMs: blobMs, attachMs: attachMs }
      toast(
        '录屏已进附件' + via + '：' + name + '（' + secs + ' 秒 / ' + sizeText(blob.size) + '）' +
          '｜收尾 ' + (attachMs / 1000).toFixed(1) + 's｜磁盘：' + file,
        13000,
        'ok'
      )
    } else {
      await copyText(file)
      toast('附件入口没用上（' + attachError + '）；视频已存到 ' + file + '（路径已复制），可直接拖进输入框', 15000)
    }
  } catch (e) {
    warn('finishRec', e)
    toast('结束录屏失败：' + ((e && e.message) || e), 9000)
  } finally {
    document.removeEventListener('keydown', onRecKeydown, true)
    stopRecTicker()
    rec = { state: 'idle', startedAt: 0, file: rec.file, seconds: 0 }
    paintRec()
  }
}

// ------------------------------------------ 录制中点「发送」= 收尾 + 一并发出

/**
 * 用户要求（2026-10-01）：「把『再点一次录屏形成文件』和『发送消息』结合 —— 我点发送，
 * 录制的文件也一并发送」。也就是录屏中不用先停下来，直接点「发送」就走完整条链路：
 * 停录 → 生成 .webm → 挂进附件 → 发送。
 *
 * 实现要点
 * --------
 * ① **捕获阶段**拦这一次点击。React 的事件委托挂在冒泡阶段，capture 里
 *    preventDefault + stopImmediatePropagation 就能把它挡下来。
 * ② 拦住之后先 `await stopRec()`（finishRec 会把视频 pushToComposer 进附件），
 *    再等一拍让 React 把附件卡片渲染出来，最后**原样重放一次点击**（`btn.click()`），
 *    这一次 `sendReplaying` 已经是 true，拦截器直接放行。
 * ③ 收尾没挂上附件就**不发**：把磁盘路径告诉用户，绝不静默丢文件。
 * ④ 只在 `rec.state === 'recording'` 时生效，其余时候对「发送」零影响。
 *
 * 关闭开关（DevTools）：localStorage['dsh-screen-capture.sendStopsRec'] = '0'
 */
const SEND_LABELS = ['发送', '发送消息', 'Send', 'Send message']
let sendReplaying = false

// 调试追踪（默认关）：万一还有「回车被吞 / 没挂上附件」这类问题，DevTools 里
//   localStorage['dsh-screen-capture.trace'] = '1'
// 打开，它就会把「回车到达时钩子的全部判据 + 收尾各步耗时」写回宿主
// <DSH_HOME>\dsh-screen-capture\screendiag\trace.json。平时零开销、不发任何请求。
let traceBuf = []
function trace(kind, extra) {
  try {
    if (localStorage.getItem('dsh-screen-capture.trace') !== '1') return
    traceBuf.push(Object.assign({ at: new Date().toISOString(), kind: kind, rec: rec.state, replaying: sendReplaying }, extra || {}))
    if (traceBuf.length > 40) traceBuf.shift()
    fetch(SAVE_ROUTE + '?dir=screendiag&file=trace.json', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(traceBuf, null, 2)
    }).catch(function () {})
  } catch (e) {
    /* 忽略 */
  }
}

/** 只记回车，别刷屏；注册在 onSendKeyWhileRec **之前**，这样即使钩子吞了事件也能留下记录。 */
function onTraceKey(ev) {
  try {
    if (ev.key !== 'Enter' && ev.keyCode !== 13) return
    const input = findComposerInput()
    const t = ev.target
    trace('keydown-enter', {
      key: ev.key,
      keyCode: ev.keyCode,
      shift: ev.shiftKey,
      alt: ev.altKey,
      ctrl: ev.ctrlKey,
      meta: ev.metaKey,
      isComposing: ev.isComposing === true,
      targetTag: t && t.tagName,
      targetCls: t ? String(t.className || '').slice(0, 70) : '',
      inputFound: !!input,
      inputTag: input ? input.tagName : '',
      inInput: !!(input && (t === input || input.contains(t))),
      wantSend: !!findSendButton()
    })
  } catch (e) {
    /* 忽略 */
  }
}

function sendStopsRec() {
  try {
    return localStorage.getItem('dsh-screen-capture.sendStopsRec') !== '0'
  } catch (e) {
    return true
  }
}

function isSendButton(el) {
  try {
    const label = (el.getAttribute('aria-label') || '').trim()
    if (!label) return false
    if (SEND_LABELS.indexOf(label) !== -1) return true
    return /^(发送|send)/i.test(label)
  } catch (e) {
    return false
  }
}

/**
 * 找「发送」按钮。
 *
 * ⚠ 实测（2026-10-01）：composer 卡片里那个**主操作按钮**是「发送 ↔ 停止生成」共用的
 * 同一个槽位（`button[class*="_primary"]`，生成中 aria-label 是「停止生成」）。
 * 所以判据是「它是主操作按钮 **且** 不是停止/中断类文案」——只按文案找发送会落空
 * （空闲时的文案不一定叫「发送」），只按位置找又会把「停止生成」当成发送。
 */
function findComposerCard() {
  const seeds = []
  try {
    const dict = findDictationButton()
    if (dict) seeds.push(dict)
  } catch (e) {
    /* 忽略 */
  }
  try {
    const inputEl = findComposerInput()
    if (inputEl) seeds.push(inputEl)
  } catch (e) {
    /* 忽略 */
  }
  for (let s = 0; s < seeds.length; s++) {
    try {
      let box = seeds[s]
      for (let depth = 0; depth < 8; depth++) {
        box = box.parentElement
        if (!box) break
        if (box.querySelector('button[class*="_primary"]')) return box
      }
    } catch (e) {
      /* 忽略 */
    }
  }
  return null
}

function findSendButton() {
  // ① 精确：可访问名本身就写明是发送
  try {
    const all = Array.prototype.slice.call(
      document.querySelectorAll('button[aria-label], [role="button"][aria-label]')
    )
    for (let i = 0; i < all.length; i++) {
      if (!isSendButton(all[i])) continue
      const r = all[i].getBoundingClientRect()
      if (r.width < 12 || r.height < 12) continue
      return all[i]
    }
  } catch (e) {
    warn('findSendButton', e)
  }

  // ② composer 卡片里的主操作按钮（排除「停止生成」）
  try {
    const card = findComposerCard()
    if (card) {
      const btn = card.querySelector('button[class*="_primary"]')
      if (btn) {
        const label = (btn.getAttribute('aria-label') || '').trim()
        if (!/停止|中断|stop|abort/i.test(label)) {
          const r = btn.getBoundingClientRect()
          if (r.width >= 12 && r.height >= 12) return btn
        }
      }
    }
  } catch (e) {
    warn('findSendButton(primary)', e)
  }
  return null
}

/**
 * 等附件卡片真的渲染出来（录制中点「发送」时要等它，不能用一个大固定等待）。
 *
 * ⚠ 附件卡片可能渲染在 composer 卡片**之外**的节点里，所以搜索根要往上爬几层，
 * 而不是只扫 composer 卡片 —— 只扫卡片的话每次都等满超时，用户感觉就是「卡了几秒」。
 * 越往上爬越贵，所以加了文本长度闸门：爬到对话区（几万字）就放弃这一层。
 */
function attachmentChipVisible(name) {
  const key = String(name || '').trim()
  try {
    const card = findComposerCard()
    let root = card || findComposerInput()
    const seen = []
    for (let up = 0; up < 5 && root; up++) {
      seen.push(root)
      root = root.parentElement
    }
    for (let i = 0; i < seen.length; i++) {
      const box = seen[i]
      const txt = box.textContent || ''
      if (txt.length > 3000) continue // 爬到对话区了，这里找不但贵还会误判
      if (key && txt.indexOf(key) >= 0) return true
      if (!key && /\.webm/i.test(txt)) return true
    }
  } catch (e) {
    /* 忽略 */
  }
  return false
}

async function waitForAttachmentChip(name, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 1200)
  while (Date.now() < deadline) {
    if (attachmentChipVisible(name)) return true
    await delay(60)
  }
  return false
}

/**
 * 走一遍「停录 → 挂附件 → 把这次发送补上」。
 *
 * ⚠ 2026-10-01 用户实测：他按的是**回车**（不是点按钮），于是消息发出去但没带视频，
 * 而且录制一直没停（跑到 45 秒还是我先手动停的）。原因是钩子只监听了 click，
 * 回车的发送路径根本不经过那个按钮的点击事件。所以现在两条路都接进来：
 *   - 点「发送 / 发送消息」按钮（`onSendClickWhileRec`）
 *   - 在输入框里按回车（`onSendKeyWhileRec`）
 *
 * @param {Element|null} btn 发送按钮（回车路径可能拿不到，比如 agent 正在生成时它变成「停止生成」）
 * @param {Element|null} input composer 输入框（用来在拿不到按钮时合成一次回车）
 */
async function finishAndSend(btn, input) {
  if (sendReplaying) return
  if (rec.state !== 'recording') return
  if (!sendStopsRec()) return

  const t0 = Date.now()
  sendReplaying = true
  try {
    trace('finishAndSend-start', { file: rec.file })
    toast('正在结束录屏并把视频挂进附件，随后自动发送…', 8000)
    const done = stopRec()
    if (done && typeof done.then === 'function') await done
    trace('after-stop', { attachOk: lastAttach.ok, stopMs: lastAttach.stopMs, blobMs: lastAttach.blobMs })
    if (!lastAttach.ok) {
      trace('bail-no-attach', { file: rec.file })
      toast(
        '录屏没能挂进附件，已取消这次发送；视频已存在磁盘上：' + (rec.file || '(未知路径)'),
        14000
      )
      return
    }
    // 等附件卡片渲染出来再放行；等不到也照发（pushToComposer 已经成功了），
    // 但不再拿「没带上视频」吓用户 —— 那条提示以前每次都会误报。
    const chipOk = await waitForAttachmentChip(lastAttach.name, 1200)
    trace('after-chip', { chipOk: chipOk, name: lastAttach.name })
    if (!chipOk) warn('附件卡片 1.2s 内没看到，仍按已挂上处理')
    await delay(60)

    // 补上这次发送。
    //
    // 为什么要**重试**：DSH 的回车主流程是 Lexical 的 KEY_ENTER_COMMAND，开头有一道
    //   if (isComposingEvent(event, recentlyComposing)) return true;   // 吞掉
    // 也就是「刚打完中文（输入法刚结束组字）的那一小段时间里，回车会被吞掉，不发也不报错」。
    // 只补发一次会正好撞上这道闸门 —— 用户看到的就是「回车按了但什么都没发生」。
    // 所以这里隔 350ms 重试，直到「附件卡片消失」（= 已经被提交）或超时。
    let replayed = false
    {
      const deadline = Date.now() + 6000
      let attempt = 0
      while (Date.now() < deadline) {
        attempt++
        if (!attachmentChipVisible(lastAttach.name)) {
          replayed = true
          break
        }
        const b = btn || findSendButton()
        if (b) {
          try {
            b.click()
          } catch (e) {
            warn('重放点击发送失败', e)
          }
        } else if (input) {
          try {
            input.dispatchEvent(
              new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true,
                composed: true
              })
            )
          } catch (e) {
            warn('重放回车失败', e)
          }
        }
        await delay(350)
      }
      if (!replayed) replayed = !attachmentChipVisible(lastAttach.name)
      trace('after-replay', { replayed: replayed, attempts: attempt, hadBtn: !!(btn || findSendButton()), input: !!input })
    }
    if (!replayed) {
      toast('附件已经挂好了，但自动发送没成功 —— 请再按一次回车（或点一次发送）', 14000)
    }

    // 自测数据留档（也在 localStorage 里，方便以后回答「为什么慢」）
    try {
      const timing = {
        at: new Date().toISOString(),
        stopMs: lastAttach.stopMs,
        blobMs: lastAttach.blobMs,
        attachMs: lastAttach.attachMs,
        chipWaitMs: Date.now() - t0 - lastAttach.attachMs,
        totalMs: Date.now() - t0,
        size: lastAttach.name
      }
      localStorage.setItem('dsh-screen-capture.lastSendTiming', JSON.stringify(timing))
      // 只在调试开关打开时才把计时写回宿主（默认关，平时不发这个请求）
      if (localStorage.getItem('dsh-screen-capture.trace') === '1') {
        fetch(SAVE_ROUTE + '?dir=screendiag&file=send-timing.json', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(timing, null, 2)
        }).catch(function () {})
      }
    } catch (e) {
      /* 忽略 */
    }
  } finally {
    setTimeout(function () {
      sendReplaying = false
    }, 1500)
  }
}

/** 录制中点「发送 / 发送消息」按钮。 */
async function onSendClickWhileRec(ev) {
  try {
    if (sendReplaying) return
    if (rec.state !== 'recording') return
    const btn = findSendButton()
    if (!btn) return
    const target = ev.target
    if (!(target === btn || btn.contains(target))) return

    ev.preventDefault()
    ev.stopPropagation()
    if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation()
    await finishAndSend(btn, findComposerInput())
  } catch (e) {
    warn('onSendClickWhileRec', e)
  }
}

/**
 * 录制中在输入框里按回车。
 *
 * 三个必须放行的例外，否则会毁掉正常输入：
 *   ① Shift+Enter / Alt+Enter —— 换行，不是发送；
 *   ② `ev.isComposing` / keyCode 229 —— 中文输入法正在组字，回车是「选词」；
 *   ③ 焦点不在 composer 输入框里（比如在搜索框里敲回车）。
 */
async function onSendKeyWhileRec(ev) {
  try {
    if (sendReplaying) return
    if (rec.state !== 'recording') return
    if (ev.key !== 'Enter' && ev.keyCode !== 13) return
    if (ev.shiftKey || ev.altKey) return
    if (ev.isComposing || ev.keyCode === 229) return
    const input = findComposerInput()
    if (!input) return
    const target = ev.target
    if (!(target === input || input.contains(target))) return

    ev.preventDefault()
    ev.stopPropagation()
    if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation()
    await finishAndSend(null, input)
  } catch (e) {
    warn('onSendKeyWhileRec', e)
  }
}

// ------------------------------------------------------------- 截图主流程

async function shootOnce() {
  if (shotBusy) return
  shotBusy = true
  paintShot()
  try {
    const c = cfg()
    if (hostCapable === null) await hostProbe()
    if (!hostCapable) {
      toast('宿主抓屏路由没挂上（' + hostProbeDetail + '）：完整重启桌面版后再生效', 7000)
      return
    }

    let shot
    try {
      // 选区取景要原生像素：先缩放到 1440 再框选，裁出来就是糊的
      shot = await hostShot({
        maxEdge: c.picker ? 0 : c.maxDimension,
        quality: Math.min(0.92, c.quality + 0.1)
      })
    } catch (e) {
      warn('shootOnce', e)
      toast('截图失败：' + ((e && e.message) || e), 6000)
      return
    }

    try {
      let rect = { x: 0, y: 0, w: shot.width, h: shot.height }
      if (c.picker) {
        const picked = await pickRegion(shot.bitmap)
        if (!picked) {
          toast('已取消截图', 2500)
          return
        }
        rect = picked
      }
      const blob = await cropToJpeg(
        shot.bitmap,
        rect,
        Math.max(c.maxDimension, 1920),
        Math.min(0.92, c.quality + 0.1)
      )
      const base = stamp()
      const file = new File([blob], 'shot-' + base + '.jpg', { type: 'image/jpeg' })

      // ① 落盘保证有文件
      const dir = await saveFramesToHost([file], 'shot-' + base)
      // ② 再试着进附件
      let attached = true
      let attachError = ''
      let channel = ''
      try {
        channel = await pushToComposer([file])
      } catch (e) {
        attached = false
        attachError = (e && e.message) || String(e)
        warn('pushToComposer', e)
      }
      const via = channel === 'paste' ? '（走粘贴通道）' : ''

      if (attached && dir) {
        toast('截图已进附件' + via + '（' + sizeText(blob.size) + '）；同时也存到了 ' + dir, 9000, 'ok')
      } else if (attached) {
        toast('已把截图放进附件' + via + '（' + sizeText(blob.size) + '），补一句话发出去', 6000, 'ok')
      } else if (dir) {
        await copyText(dir)
        toast('附件入口没用上（' + attachError + '），截图已存到 ' + dir + '（路径已复制）', 12000)
      } else {
        toast('截图没能放进去：' + attachError, 10000)
      }
    } finally {
      try {
        shot.bitmap.close()
      } catch (e) {
        /* 忽略 */
      }
    }
  } catch (e) {
    warn('shootOnce(outer)', e)
    toast('截图失败：' + ((e && e.message) || e), 7000)
  } finally {
    shotBusy = false
    paintShot()
  }
}

// ------------------------------------------------------------------ 装配

let scheduled = false

function schedule() {
  if (scheduled) return
  scheduled = true
  try {
    requestAnimationFrame(function () {
      scheduled = false
      ensureButtons()
    })
  } catch (e) {
    scheduled = false
  }
}

/** 返回一个拆卸函数：断开 MutationObserver 并停掉心跳。 */
function observe() {
  let observer = null
  try {
    observer = new MutationObserver(function () {
      schedule()
    })
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    })
  } catch (e) {
    warn('MutationObserver', e)
  }
  // 兜底心跳：React 在同一个 MutationObserver 回调里收敛时可能漏掉我们的调度
  let timer = null
  try {
    timer = setInterval(schedule, 3000)
  } catch (e) {
    /* 忽略 */
  }
  return function dispose() {
    try {
      if (observer) observer.disconnect()
    } catch (e) {
      /* 忽略 */
    }
    try {
      if (timer) clearInterval(timer)
    } catch (e) {
      /* 忽略 */
    }
  }
}

// ------------------------------------------------------------ 插件本体

/**
 * 上一代实例的挂点。
 *
 * 为什么需要：桌面版的 client-hmr 每 500ms stat 轮询客户端 bundle，文件一变就
 * `rebuilt()` 并推 SSE，浏览器侧走 `modules.reload(id, rev)` —— 也就是**重新执行
 * 本插件的 apply**。而按钮是 DOM 直插的、不属于 React 树，所以重新 apply 时必须
 * 先撤掉上一代（按钮 + 观察器 + 心跳 + 进行中的录制），否则会出现：
 *   - 旧按钮带旧监听器留在界面上（新代码永远不生效）；
 *   - 每热更一次多一个 MutationObserver + 一个 3 秒 setInterval；
 *   - 上一代那轮录制还在跑到超时。
 * 老版本用 `window.__...__` 当"只装一次"的守卫，在 HMR 下正好把新代码挡回去。
 */
const STATE_KEY = '__DSH_SCREEN_CAPTURE_DESKTOP__'

function teardownPrevious() {
  let prev = null
  try {
    prev = window[STATE_KEY]
  } catch (e) {
    /* 忽略 */
  }
  if (prev && typeof prev === 'object') {
    try {
      if (typeof prev.stopRecording === 'function') prev.stopRecording()
    } catch (e) {
      /* 忽略 */
    }
    try {
      if (typeof prev.dispose === 'function') prev.dispose()
    } catch (e) {
      /* 忽略 */
    }
  }
  try {
    const stale = document.querySelectorAll(
      '[' + REC_ATTR + '], [' + SHOT_ATTR + '], [' + TOAST_ATTR + '], [' + TIP_ATTR + ']'
    )
    for (let i = 0; i < stale.length; i++) {
      const el = stale[i]
      if (el && el.parentNode) el.parentNode.removeChild(el)
    }
  } catch (e) {
    /* 忽略 */
  }
  try {
    window[STATE_KEY] = null
  } catch (e) {
    /* 忽略 */
  }
}

/** 客户端插件体：监听 DOM 并挂按钮；可被 HMR 反复重新执行。 */
function apply(ctx) {
  try {
    // 本插件只跟 DOM/Web API 打交道，非浏览器 surface 直接退出。
    if (typeof window === 'undefined' || typeof document === 'undefined') return

    // HMR 重新装载：先撤掉上一代（含上一代还在跑的录制）
    teardownPrevious()
    // 官方 Toast / Tooltip 用的那套入场关键帧，注入一次
    ensureToastKeyframes()

    const disposeObserve = observe()
    // 录制中点「发送」= 停录 + 挂视频 + 一并发出（捕获阶段拦，见 finishAndSend）
    // 两条发送路径都要接：点按钮（click）与按回车（keydown）
    document.addEventListener('click', onSendClickWhileRec, true)
    document.addEventListener('keydown', onTraceKey, true)
    document.addEventListener('keydown', onSendKeyWhileRec, true)
    schedule()
    // 输入框第一次挂载完成后马上再来一次，省掉一轮 3 秒心跳的等待
    atLeast(Date.now(), 600).then(schedule)
    // 探一次宿主抓屏路由：没挂上就说明原因，而不是等用户点了才报「已取消」
    hostProbe().then(function (ok) {
      if (ok) return
      // 具体原因现在由 tooltip 文案（recTipText/shotTipText）带出来
      warn('宿主路由不可用（' + hostProbeDetail + '）—— 完整重启桌面版后再生效')
    })
    // 认领宿主里正在进行的录制：client-hmr 重载（或页面刷新）会把 rec.state 重置成
    // idle，而宿主那边还在录；不认领的话「录制中点发送」的钩子会直接放行（实测踩过）。
    fetch(REC_STATUS + '?ts=' + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        return r.ok ? r.json() : null
      })
      .then(function (j) {
        if (!j || j.recording !== true) return
        // 两道保险，宁可不恢复状态也不能凭空跳秒数（2026-10-01 用户报障：停止后红点一直跳）：
        // ① 宿主必须能明确回答 finished —— 老版 /record/status 只回 !!recording，
        //    而宿主那个变量收尾后不清空，回的是永久的 true；这种情况直接不认领。
        // ② 超过最长录制时长 + 5 秒的，一定是已经结束的陈旧会话。
        if (j.finished === undefined) {
          warn('宿主 /record/status 没有 finished 字段（老版），跳过认领以免误判')
          return
        }
        const age = j.startedAt ? Date.now() - j.startedAt : 0
        if (j.finished === true || age > (cfg().maxSeconds + 5) * 1000) {
          warn('宿主报的是已结束的陈旧会话，不认领：' + (j.file || ''))
          return
        }
        rec = {
          state: 'recording',
          startedAt: j.startedAt || Date.now(),
          file: j.file || '',
          seconds: j.seconds || 0
        }
        paintRec()
        startRecTicker()
        document.addEventListener('keydown', onRecKeydown, true)
        warn('认领了宿主里正在进行的录制（热更/刷新后自动恢复）：' + (j.file || ''))
      })
      .catch(function () {})

    window[STATE_KEY] = {
      dispose: function () {
        try {
          disposeObserve()
        } catch (e) {
          /* 忽略 */
        }
        try {
          document.removeEventListener('click', onSendClickWhileRec, true)
        } catch (e) {
          /* 忽略 */
        }
        try {
          document.removeEventListener('keydown', onTraceKey, true)
        } catch (e) {
          /* 忽略 */
        }
        try {
          document.removeEventListener('keydown', onSendKeyWhileRec, true)
        } catch (e) {
          /* 忽略 */
        }
      },
      stopRecording: function () {
        try {
          document.removeEventListener('keydown', onRecKeydown, true)
          if (rec.state === 'recording') setRecState('busy')
        } catch (e) {
          /* 忽略 */
        }
      }
    }

    console.log('[dsh-capture] 已挂载：录屏 / 截图按钮会插在「听写」左边（宿主侧抓屏）')
  } catch (e) {
    warn('apply', e)
  }
}

exports.apply = apply
exports.inject = []
