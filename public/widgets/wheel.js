(function () {
	if (window.__winwidgetScriptRunning) return;
	window.__winwidgetScriptRunning = !0;
	var k = document.currentScript,
		tt = (() => {
			try {
				const t = new URL((k == null ? void 0 : k.src) || location.href);
				return t.hostname === 'localhost'
					? `${t.origin}/api`
					: `${t.origin}/api`;
			} catch (t) {
				return 'https://winwidget.ru/api';
			}
		})();
	const p = document.createElement('div'),
		gt = '64px';
	function yt(t) {
		try {
			const c = new URL((k == null ? void 0 : k.src) || location.href);
			return (
				(c.pathname = c.pathname.replace(/\/[^/]*$/, '/' + t)),
				(c.search = ''),
				(c.hash = ''),
				c.toString()
			);
		} catch (c) {
			return 'https://winwidget.ru/widgets/' + t;
		}
	}
	function vt(t) {
		return new Promise((c, l) => {
			const y = document.querySelector('script[src="' + t + '"]');
			if (y) {
				(y.addEventListener('load', c, { once: !0 }),
					y.addEventListener('error', l, { once: !0 }),
					window.winwidgetPhone && c());
				return;
			}
			const b = document.createElement('script');
			((b.src = t),
				(b.async = !0),
				(b.onload = () => {
					c();
				}),
				(b.onerror = l),
				document.head.appendChild(b));
		});
	}
	function At() {
		return window.winwidgetPhone
			? window.winwidgetPhone.load()
			: vt(yt('helpers/winwidget-phone.js'))
					.then(() =>
						window.winwidgetPhone ? window.winwidgetPhone.load() : null
					)
					.catch(
						t => (
							console.warn(
								'[winwidget] Failed to load phone formatter:',
								t
							),
							null
						)
					);
	}
	((p.innerHTML = `
  <div id="ww-bubble" style="
    display:none;position:absolute;top:50%;transform:translateY(-50%) scale(0.85);
    background:#fff;border-radius:18px;padding:12px 34px 12px 16px;
    width:172px;box-sizing:border-box;
    border:1px solid rgba(71,5,251,0.12);
    box-shadow:0 16px 40px rgba(71,5,251,0.18),0 8px 18px rgba(15,23,42,0.08);
    cursor:pointer;opacity:0;
    transition:opacity 0.3s ease,transform 0.35s cubic-bezier(.22,1,.36,1);
    font-family:system-ui,-apple-system,sans-serif;
  ">
    <button id="ww-bubble-close" style="
      position:absolute;top:7px;right:8px;background:none;border:none;
      font-size:11px;cursor:pointer;color:#ccc;line-height:1;padding:2px;
      display:flex;align-items:center;justify-content:center;
      width:16px;height:16px;border-radius:50%;
    ">\u2715</button>
    <p id="ww-bubble-text" style="
      margin:0;font-size:13px;font-weight:600;color:#1a1a1a;line-height:1.4;
    "></p>
    <span style="position:absolute;left:12px;top:-6px;width:12px;height:12px;border-radius:50%;background:#22c55e;border:2px solid #fff;box-shadow:0 0 0 4px rgba(34,197,94,.14);"></span>
    <div id="ww-bubble-tail" style="
      position:absolute;top:50%;transform:translateY(-50%);
      width:0;height:0;
      border-top:7px solid transparent;border-bottom:7px solid transparent;
    "></div>
  </div>
  <div id="ww-btn-emoji" style="
    font-size:${gt};line-height:1;
    filter:drop-shadow(0 6px 16px rgba(0,0,0,0.35)) drop-shadow(0 2px 4px rgba(0,0,0,0.2));
    transform-origin:50% 100%;
  ">\u{1F381}</div>
  <div id="ww-btn-label" style="
    margin-top:6px;
    background:linear-gradient(135deg,#ffd700,#ff8c00);
    color:#1a0600;font-size:11px;font-weight:900;
    padding:3px 12px;border-radius:20px;white-space:nowrap;
    letter-spacing:0.8px;text-transform:uppercase;
    box-shadow:0 3px 10px rgba(255,140,0,0.5);
  ">\u041F\u0440\u0438\u0437!</div>
`),
		(p.style.cssText = `
    position: fixed;
    bottom: 28px;
    right: max(28px, env(safe-area-inset-right, 0px) + 28px);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    cursor: pointer;
    z-index: 9999;
    max-width: calc(100vw - 56px);
    transition: opacity 350ms ease, transform 350ms cubic-bezier(.34,1.56,.64,1);
    user-select: none;
`),
		(p.style.display = 'none'),
		document.body.appendChild(p));
	const et = document.createElement('style');
	((et.textContent = `
@keyframes gift-bounce {
  0%   { transform: translateY(0) scale(1); }
  10%  { transform: translateY(-16px) scale(1.1); }
  20%  { transform: translateY(0) scale(1); }
  30%  { transform: translateY(-6px) scale(1.04); }
  40%  { transform: translateY(0) scale(1); }
  100% { transform: translateY(0) scale(1); }
}
@keyframes gift-sway {
  0%   { transform: rotate(0deg); }
  25%  { transform: rotate(-6deg); }
  75%  { transform: rotate(6deg); }
  100% { transform: rotate(0deg); }
}
@keyframes gift-pulse {
  0%   { filter: drop-shadow(0 6px 16px rgba(0,0,0,0.35)) drop-shadow(0 2px 4px rgba(0,0,0,0.2)); }
  50%  { filter: drop-shadow(0 8px 28px rgba(101,16,255,0.7)) drop-shadow(0 2px 12px rgba(37,117,252,0.5)); }
  100% { filter: drop-shadow(0 6px 16px rgba(0,0,0,0.35)) drop-shadow(0 2px 4px rgba(0,0,0,0.2)); }
}
#ww-bubble:hover{opacity:0.95!important}
#ww-bubble-close:hover{color:#888!important}
@media(max-width:480px){#ww-bubble{display:none!important}}
`),
		document.head.appendChild(et));
	let W = !1,
		Qt = null,
		nt = !0;
	function q() {
		W ||
			((W = !0),
			(p.style.animation = [
				'gift-bounce 3s ease-in-out infinite',
				'gift-sway 4s ease-in-out infinite',
				nt ? 'gift-pulse 2.5s ease-in-out infinite' : ''
			]
				.filter(Boolean)
				.join(', ')));
	}
	function V() {
		((W = !1), (p.style.animation = 'none'));
	}
	function kt(t) {
		var c = document.getElementById('ww-bubble'),
			l = document.getElementById('ww-bubble-tail');
		!c ||
			!l ||
			(t === 'left'
				? ((c.style.left = 'calc(100% + 14px)'),
					(c.style.right = 'auto'),
					(l.style.left = '-8px'),
					(l.style.right = 'auto'),
					(l.style.borderLeft = 'none'),
					(l.style.borderRight = '8px solid #fff'))
				: ((c.style.right = 'calc(100% + 14px)'),
					(c.style.left = 'auto'),
					(l.style.right = '-8px'),
					(l.style.left = 'auto'),
					(l.style.borderRight = 'none'),
					(l.style.borderLeft = '8px solid #fff')));
	}
	function H() {
		var t = document.getElementById('ww-bubble');
		!t ||
			t.style.display === 'none' ||
			((t.style.opacity = '0'),
			(t.style.transform = 'translateY(-50%) scale(0.85)'),
			setTimeout(function () {
				t.style.display = 'none';
			}, 300));
	}
	setTimeout(() => {
		q();
	}, 4e3);
	let ot = !1;
	window.addEventListener(
		'scroll',
		() => {
			ot ||
				((ot = !0),
				p.animate(
					[
						{ transform: 'translateY(0) rotate(0deg)' },
						{ transform: 'translateY(-250px) rotate(-6deg)' },
						{ transform: 'translateY(0) rotate(0deg)' }
					],
					{ duration: 2300, easing: 'cubic-bezier(.34,1.56,.64,1)' }
				),
				q());
		},
		{ passive: !0 }
	);
	async function Et(t) {
		var pt, ut, ht, ft;
		function c(e) {
			if (t.yandexMetrikaId && typeof ym == 'function')
				try {
					ym(Number(t.yandexMetrikaId), 'reachGoal', e);
				} catch (r) {}
			if (t.vkPixelId && window.VK && typeof VK.Goal == 'function')
				try {
					VK.Goal(e);
				} catch (r) {}
			if (
				t.roistatEnabled &&
				window.roistat &&
				typeof window.roistat.event == 'object' &&
				typeof window.roistat.event.send == 'function'
			)
				try {
					window.roistat.event.send(e);
				} catch (r) {}
		}
		function l() {
			(H(),
				M.classList.remove('hidden'),
				M.classList.add('visible'),
				(document.body.style.overflow = 'hidden'),
				(document.body.style.position = 'fixed'),
				(document.body.style.width = '100%'),
				(p.style.opacity = '0'),
				(p.style.pointerEvents = 'none'),
				(p.style.transform = 'scale(0.8)'),
				V(),
				c('ip3_open'));
		}
		function y() {
			(M.classList.remove('visible'),
				M.classList.add('hidden'),
				(document.body.style.overflow = ''),
				(document.body.style.position = ''),
				(document.body.style.width = ''),
				window.winwidgetAutoOpen ||
					((p.style.opacity = '1'),
					(p.style.pointerEvents = 'auto'),
					(p.style.transform = 'scale(1)'),
					q()));
		}
		const b = document.createElement('div');
		((b.id = 'wheel-widget-host'), document.body.appendChild(b));
		const u = b.attachShadow({ mode: 'open' }),
			N = document.createElement('style');
		((N.textContent = `
    :host {
      --spin-duration: ${t.spinDuration || 5}s;
      --wheel-size: 300px;
      --accent: ${t.widgetColor};
      position: fixed;
      z-index: 10000;
      top: 0;
    }
    * { box-sizing: border-box; }

    /* \u2500\u2500 \u041E\u0431\u0451\u0440\u0442\u043A\u0430 \u043D\u0430 \u0432\u0435\u0441\u044C \u044D\u043A\u0440\u0430\u043D \u2500\u2500 */
    #main-wrapper {
      width: 100vw;
      height: 100dvh;
      display: none;
      overflow-x: hidden;
      overflow-y: auto;
      justify-content: center;
      align-items: flex-start;
      padding: 12px;
    }

    /* \u2500\u2500 \u041F\u043E\u043B\u0443\u043F\u0440\u043E\u0437\u0440\u0430\u0447\u043D\u044B\u0439 \u0444\u043E\u043D \u2500\u2500 */
    #overlay {
      position: fixed;
      inset: 0;
      background: rgba(8, 4, 20, 0.85);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      z-index: 999;
      touch-action: none;
    }

    /* \u2500\u2500 \u041A\u0430\u0440\u0442\u043E\u0447\u043A\u0430 \u2500\u2500 */
    #banner-wrapper {
      position: relative;
      z-index: 1000;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 28px 20px 24px;
      background: ${t.bgColor};
      border-radius: 20px;
      box-shadow:
        0 0 0 1px rgba(255,255,255,0.08),
        0 24px 64px rgba(0,0,0,0.55),
        0 0 80px rgba(101,16,255,0.18);
      overflow: hidden;
      clip-path: inset(0 round 20px);
      gap: 28px;
      touch-action: pan-y;
      min-height: calc(100dvh - 24px);
      justify-content: center;
    }

    /* \u0414\u0435\u043A\u043E\u0440\u0430\u0442\u0438\u0432\u043D\u044B\u0439 \u0431\u043B\u0438\u043A \u0441\u0432\u0435\u0440\u0445\u0443 */
    #banner-wrapper::before {
      content: '';
      position: absolute;
      top: 0; left: 10%; right: 10%;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.25), transparent);
      pointer-events: none;
    }

    /* \u2500\u2500 \u041A\u043E\u043D\u0442\u0435\u043D\u0442 (\u0444\u043E\u0440\u043C\u0430 + \u043A\u043E\u043B\u0435\u0441\u043E) \u2500\u2500 */
    #banner-content {
      display: flex;
      flex-direction: column;
      width: 100%;
      justify-content: center;
      align-items: center;
      gap: 24px;
    }

    /* \u2500\u2500 \u041A\u043E\u043B\u0435\u0441\u043E \u2500\u2500 */
    #wheel-wrapper {
      position: relative;
      width: var(--wheel-size);
      height: var(--wheel-size);
      filter: drop-shadow(0 8px 32px rgba(0,0,0,0.45));
    }
    svg { width: 100%; height: 100%; overflow: visible; }
    #wheel {
      transform-origin: 50% 50%;
      transition: transform var(--spin-duration) cubic-bezier(.17,.67,.3,1);
    }
    .sector text { pointer-events: none; user-select: none; }

    /* \u0421\u0442\u0440\u0435\u043B\u043A\u0430 */
    #wheel-arrow {
      position: absolute;
      top: 50%;
      right: -18px;
      transform: translateY(-50%);
      width: 44px;
      height: 44px;
      z-index: 10;
      pointer-events: none;
      filter: drop-shadow(0 2px 6px rgba(0,0,0,0.5));
    }
    #wheel-arrow svg { width: 100%; height: 100%; display: block; }

    /* \u2500\u2500 \u041F\u0430\u043D\u0435\u043B\u044C \u0443\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u044F \u2500\u2500 */
    #control-wrapper {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
      width: 100%;
    }

    /* \u0417\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A */
    #title-widget {
      font-size: clamp(1.1rem, 4.5vw, 1.75rem);
      font-weight: 800;
      margin: 0;
      text-align: center;
      color: #ffffff;
      letter-spacing: -0.3px;
      line-height: 1.2;
      text-shadow: 0 2px 12px rgba(0,0,0,0.3);
      overflow-wrap: break-word;
      word-break: break-word;
    }

    /* \u041F\u043E\u0434\u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A */
    #subtitle-widget {
      width: 100%;
      color: rgba(255,255,255,0.72);
      margin: 0;
      text-align: center;
      font-size: 14px;
      line-height: 1.5;
    }

    /* \u0418\u043D\u043F\u0443\u0442\u044B */
    #name-input,
    #phone-input,
    #email-input {
      border: 1.5px solid rgba(255,255,255,0.12);
      outline: none;
      background: rgba(255,255,255,0.08);
      padding: 0 14px;
      border-radius: 12px;
      width: 100%;
      color: #ffffff;
      font-weight: 400;
      font-size: 15px;
      line-height: 1;
      height: 48px;
      transition: border-color 250ms, background 250ms, box-shadow 250ms;
      backdrop-filter: blur(4px);
    }
    #name-input::placeholder,
    #phone-input::placeholder,
    #email-input::placeholder { color: rgba(255,255,255,0.4); }
    #name-input:focus,
    #phone-input:focus,
    #email-input:focus {
      border-color: rgba(255,255,255,0.4);
      background: rgba(255,255,255,0.13);
      box-shadow: 0 0 0 3px rgba(255,255,255,0.06);
    }

    /* \u041A\u043D\u043E\u043F\u043A\u0430 \u041A\u0420\u0423\u0422\u0418\u0422\u042C */
    #spin {
      width: 100%;
      padding: 0 24px;
      height: 52px;
      font-size: 16px;
      font-weight: 700;
      letter-spacing: 0.5px;
      cursor: pointer;
      border: none;
      border-radius: 14px;
      color: #ffffff;
      background: linear-gradient(135deg, #6a11cb 0%, #2575fc 100%);
      box-shadow: 0 4px 20px rgba(101,16,255,0.45), inset 0 1px 0 rgba(255,255,255,0.15);
      transition: transform 0.15s ease, box-shadow 0.15s ease, filter 0.15s ease;
      position: relative;
      overflow: hidden;
    }
    #spin::before {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(180deg, rgba(255,255,255,0.1) 0%, transparent 60%);
      pointer-events: none;
    }
    #spin:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 28px rgba(101,16,255,0.6), inset 0 1px 0 rgba(255,255,255,0.15);
      filter: brightness(1.08);
    }
    #spin:active { transform: translateY(0); }
    #spin:disabled {
      opacity: 0.55;
      cursor: not-allowed;
      transform: none;
    }

    /* \u0421\u0441\u044B\u043B\u043A\u0438 \u043F\u043E\u043B\u0438\u0442\u0438\u043A\u0438 */
    #link-policy, #link-consent, #link-offer {
      color: rgba(255,255,255,0.75);
      text-decoration: underline;
      text-underline-offset: 2px;
      cursor: pointer;
      transition: color 0.2s;
    }
    #link-policy:hover, #link-consent:hover, #link-offer:hover {
      color: #ffffff;
    }

    /* \u0411\u0440\u0435\u043D\u0434\u0438\u043D\u0433 */
    #dev-info {
      font-size: 12px;
      position: absolute;
      top: 5px;
      color: rgba(255,255,255,0.35);
      letter-spacing: 0.2px;
    }
    #dev-info-text {
      color: rgba(255,200,50,0.7);
      text-decoration: none;
      font-weight: 600;
    }
    #dev-info-text:hover { color: #ffc832; }

    /* \u041A\u043E\u043D\u0444\u0435\u0442\u0442\u0438 */
    .confetti {
      position: absolute;
      width: 8px;
      height: 8px;
      pointer-events: none;
      opacity: 1;
      transform-origin: center center;
      will-change: transform, opacity;
    }
    .confetti.square { border-radius: 2px; }
    .confetti.circle { border-radius: 50%; }
    .confetti.diamond { border-radius: 1px; transform: rotate(45deg); }
    .confetti.streamer { width: 4px !important; height: 20px !important; border-radius: 2px; }

    .blur { filter: blur(2.5px); }
    .visible { display: flex !important; }
    .hidden { display: none !important; }

    /* \u041A\u043D\u043E\u043F\u043A\u0430 \u0437\u0430\u043A\u0440\u044B\u0442\u0438\u044F */
    #widget-close {
      position: absolute;
      top: 14px;
      right: 14px;
      width: 34px;
      height: 34px;
      padding: 0;
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.2s, transform 0.2s, border-color 0.2s;
      backdrop-filter: blur(4px);
    }
    #widget-close:hover {
      background: rgba(255,255,255,0.2);
      border-color: rgba(255,255,255,0.25);
      transform: scale(1.08) rotate(90deg);
    }
    #widget-close svg { width: 14px; height: 14px; }
    #widget-close line {
      stroke: rgba(255,255,255,0.85);
      stroke-width: 2;
      stroke-linecap: round;
    }

    /* \u2500\u2500 Desktop \u2500\u2500 */
    @media (min-width: 768px) {
      :host { --wheel-size: 360px; }
      #main-wrapper { align-items: center; }
      #banner-content {
        flex-direction: row-reverse;
        gap: 48px;
      }
      #banner-wrapper {
        width: 100%;
        padding: 44px 48px;
        max-width: 940px;
        max-height: 520px;
        min-height: unset;
        justify-content: flex-start;
      }
      #control-wrapper { max-width: 290px; gap: 12px; }
      #title-widget { font-size: clamp(1.5rem, 2vw, 2rem); }
    }

    @supports not (height: 100dvh) {
      #main-wrapper { height: 100vh; }
    }

    /* \u2500\u2500 Checkbox \u2500\u2500 */
    #checkbox-text {
      color: rgba(255,255,255,0.65);
      font-size: 13px;
      line-height: 1.45;
    }
    #custom-checkbox {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      cursor: pointer;
      user-select: none;
      font-size: 13px;
      line-height: 1.45;
    }
    #custom-checkbox input {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }
    #custom-checkbox #checkmark {
      width: 18px;
      height: 18px;
      min-width: 18px;
      margin-top: 1px;
      border-radius: 5px;
      border: 1.5px solid rgba(255,255,255,0.35);
      background: rgba(255,255,255,0.06);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
    }
    #custom-checkbox #checkmark::after {
      content: '';
      width: 10px;
      height: 6px;
      border-left: 2px solid #fff;
      border-bottom: 2px solid #fff;
      transform: rotate(-45deg) scale(0);
      transition: transform 0.15s ease;
    }
    #custom-checkbox input:checked + #checkmark {
      background: linear-gradient(135deg, #6a11cb, #2575fc);
      border-color: transparent;
    }
    #custom-checkbox input:checked + #checkmark::after {
      transform: rotate(-45deg) scale(1);
    }
    #custom-checkbox:hover #checkmark {
      border-color: rgba(255,255,255,0.6);
    }

    @keyframes shake {
      0%   { transform: translateX(0); }
      20%  { transform: translateX(-5px); }
      40%  { transform: translateX(5px); }
      60%  { transform: translateX(-4px); }
      80%  { transform: translateX(4px); }
      100% { transform: translateX(0); }
    }
  `),
			u.appendChild(N));
		const E = document.createElement('div');
		((E.innerHTML = `
  <div id='main-wrapper'>
    <div id="overlay"></div>
    <div id="banner-wrapper">
      <button id="widget-close" aria-label="\u0417\u0430\u043A\u0440\u044B\u0442\u044C">
        <svg viewBox="0 0 24 24" fill="none">
          <line x1="6" y1="6" x2="18" y2="18"/>
          <line x1="18" y1="6" x2="6" y2="18"/>
        </svg>
      </button>

      <div id="banner-content">
        <div id='control-wrapper'>
          <h1 id='title-widget'>${t.title}</h1>
          <p id='subtitle-widget'>${t.subtitle}</p>
          ${t.nameFieldActive ? '<input type="text"  placeholder="\u2726  \u0412\u0430\u0448\u0435 \u0438\u043C\u044F"    id="name-input"  autocomplete="name" />' : ''}
          ${t.phoneFieldActive ? '<input type="tel"   placeholder="\u2726  \u0412\u0430\u0448 \u0442\u0435\u043B\u0435\u0444\u043E\u043D" id="phone-input" autocomplete="tel" />' : ''}
          ${t.emailFieldActive ? '<input type="email" placeholder="\u2726  \u0412\u0430\u0448 email"   id="email-input" autocomplete="email" />' : ''}
          ${
						t.checkboxPolicyActive
							? `
            <label id="custom-checkbox">
              <input type="checkbox" id="policy-input" />
              <span id="checkmark"></span>
              <span id="checkbox-text">
                <a id='link-consent' href='${t.linkConsentText}' target='_blank' rel='noopener noreferrer'>\u0421\u043E\u0433\u043B\u0430\u0441\u0435\u043D</a> \u043D\u0430 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0443 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445
              </span>
            </label>`
							: ''
					}
          <button type='button' id="spin">
            <span style="margin-right:6px">\u{1F3B0}</span>${t.startBtnText}
          </button>
        </div>

        <div id="wheel-wrapper">
          <div id="wheel-arrow"></div>
          <svg viewBox="0 0 300 300" id="wheel-svg">
            <defs>
              <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
                <feDropShadow dx="0" dy="3" stdDeviation="6" flood-color="rgba(0,0,0,0.45)" />
              </filter>
              <filter id="text-shadow" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-color="rgba(0,0,0,0.5)" />
              </filter>
              <linearGradient id="sector-shine" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="rgba(255,255,255,0.12)" />
                <stop offset="60%" stop-color="rgba(255,255,255,0)" />
              </linearGradient>
            </defs>
            <g class="wheel" id="wheel"></g>
          </svg>
        </div>
      </div>

      ${t.developInfoActive ? "<div id='dev-info'>\u0421\u0434\u0435\u043B\u0430\u043D\u043E \u0432&nbsp;<a id='dev-info-text' href='https://winwidget.ru'>winwidget.ru</a></div>" : ''}
    </div>
  </div>
`),
			u.appendChild(E));
		const X =
				/^(([^<>()[\].,;:\s@"]+(\.[^<>()[\].,;:\s@"]+)*)|(".+"))@(([^<>()[\].,;:\s@"]+\.)+[^<>()[\].,;:\s@"]{2,})$/iu,
			B = u.querySelector('#overlay'),
			M = u.querySelector('#main-wrapper'),
			te = u.querySelector('#wheel-wrapper'),
			U = u.querySelector('#banner-wrapper'),
			w = u.querySelector('#wheel'),
			it = u.querySelector('#widget-close'),
			z = u.querySelector('#spin'),
			$t = u.querySelector('#wheel-arrow'),
			Ft = u.querySelector('#title-widget'),
			rt = u.querySelector('#subtitle-widget'),
			R = u.querySelector('#custom-checkbox'),
			h = 150,
			C = 150;
		let at = 0,
			O = null;
		((U.style.background = t.bgColor),
			t.buttonColor &&
				((z.style.background = t.buttonColor),
				(z.style.boxShadow = `0 4px 20px ${t.buttonColor}80, inset 0 1px 0 rgba(255,255,255,0.15)`)),
			t.arrowSVG &&
				($t.innerHTML = `<svg viewBox="0 0 20 24">${t.arrowSVG}</svg>`));
		function st(e, r) {
			const n = Math.PI / 180,
				o = h + C * Math.cos(e * n),
				s = h + C * Math.sin(e * n),
				a = h + C * Math.cos(r * n),
				d = h + C * Math.sin(r * n),
				i = r - e > 180 ? 1 : 0;
			return `M ${h} ${h} L ${o} ${s} A ${C} ${C} 0 ${i} 1 ${a} ${d} Z`;
		}
		function zt() {
			if (t.centerSVG) {
				const e = document.createElementNS(
					'http://www.w3.org/2000/svg',
					'g'
				);
				e.setAttribute('transform', `translate(${h}, ${h})`);
				const r = document.createElement('div');
				r.innerHTML = t.centerSVG.trim();
				const n = r.firstChild,
					o = n.getAttribute('width') || 40,
					s = n.getAttribute('height') || 40;
				(n.setAttribute('x', -o / 2),
					n.setAttribute('y', -s / 2),
					e.appendChild(n),
					w.appendChild(e));
			} else {
				const e = 'http://www.w3.org/2000/svg',
					r = document.createElementNS(e, 'defs'),
					n = document.createElementNS(e, 'radialGradient');
				(n.setAttribute('id', 'center-grad'),
					n.setAttribute('cx', '35%'),
					n.setAttribute('cy', '35%'));
				const o = document.createElementNS(e, 'stop');
				(o.setAttribute('offset', '0%'),
					o.setAttribute('stop-color', '#ffffff'));
				const s = document.createElementNS(e, 'stop');
				(s.setAttribute('offset', '100%'),
					s.setAttribute('stop-color', t.centerColor),
					n.appendChild(o),
					n.appendChild(s),
					r.appendChild(n),
					w.appendChild(r));
				const a = document.createElementNS(e, 'circle');
				(a.setAttribute('cx', h),
					a.setAttribute('cy', h),
					a.setAttribute('r', 26),
					a.setAttribute('fill', 'none'),
					a.setAttribute('stroke', 'rgba(255,255,255,0.2)'),
					a.setAttribute('stroke-width', '3'),
					w.appendChild(a));
				const d = document.createElementNS(e, 'circle');
				(d.setAttribute('cx', h),
					d.setAttribute('cy', h),
					d.setAttribute('r', 22),
					d.setAttribute('fill', 'url(#center-grad)'),
					d.setAttribute('stroke', 'rgba(255,255,255,0.35)'),
					d.setAttribute('stroke-width', '1.5'),
					d.setAttribute('filter', 'url(#shadow)'),
					w.appendChild(d));
				const i = document.createElementNS(e, 'circle');
				(i.setAttribute('cx', h - 6),
					i.setAttribute('cy', h - 6),
					i.setAttribute('r', 4),
					i.setAttribute('fill', 'rgba(255,255,255,0.45)'),
					w.appendChild(i));
			}
		}
		function Pt() {
			w.innerHTML = '';
			const n = 360 / t.sectors.length;
			t.sectors.forEach((a, d) => {
				const i = d * n - 90,
					x = i + n,
					v = i + n / 2,
					g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
				g.classList.add('sector');
				const A = document.createElementNS(
					'http://www.w3.org/2000/svg',
					'path'
				);
				(A.setAttribute('d', st(i, x)),
					A.setAttribute('fill', a.color),
					A.setAttribute('stroke', 'rgba(0,0,0,0.18)'),
					A.setAttribute('stroke-width', '1.5'),
					g.appendChild(A));
				const F = document.createElementNS(
					'http://www.w3.org/2000/svg',
					'path'
				);
				(F.setAttribute('d', st(i, x)),
					F.setAttribute('fill', 'url(#sector-shine)'),
					F.setAttribute('pointer-events', 'none'),
					g.appendChild(F));
				const m = document.createElementNS(
						'http://www.w3.org/2000/svg',
						'text'
					),
					f = C * 0.62,
					L = h + f * Math.cos((v * Math.PI) / 180),
					D = h + f * Math.sin((v * Math.PI) / 180);
				(m.setAttribute('x', L),
					m.setAttribute('y', D),
					m.setAttribute('text-anchor', 'middle'),
					m.setAttribute('dominant-baseline', 'middle'),
					m.setAttribute('transform', `rotate(${v}, ${L}, ${D})`),
					(m.style.fontFamily = "'Arial', sans-serif"),
					(m.style.fontWeight = '700'),
					(m.style.fill = a.textColor),
					(m.style.fontSize = `${Math.max(10, parseInt(a.fontSize) || 14)}px`),
					m.setAttribute('filter', 'url(#text-shadow)'),
					(m.textContent = a.label),
					g.appendChild(m),
					w.appendChild(g));
			});
			const o = document.createElementNS(
				'http://www.w3.org/2000/svg',
				'circle'
			);
			(o.setAttribute('cx', h),
				o.setAttribute('cy', h),
				o.setAttribute('r', C + t.borderWidth / 2),
				o.setAttribute('fill', 'none'),
				o.setAttribute('stroke', t.borderColor),
				o.setAttribute('stroke-width', t.borderWidth),
				o.setAttribute('filter', 'url(#shadow)'),
				w.appendChild(o));
			const s = document.createElementNS(
				'http://www.w3.org/2000/svg',
				'circle'
			);
			(s.setAttribute('cx', h),
				s.setAttribute('cy', h),
				s.setAttribute('r', C - 2),
				s.setAttribute('fill', 'none'),
				s.setAttribute('stroke', 'rgba(255,255,255,0.12)'),
				s.setAttribute('stroke-width', '2'),
				w.appendChild(s),
				zt());
		}
		function Tt(e) {
			const r = e.reduce((o, s) => o + s.probability, 0);
			let n = Math.random() * r;
			for (let o = 0; o < e.length; o++)
				if (((n -= e[o].probability), n <= 0)) return o;
		}
		function Bt() {
			try {
				const a =
					'winwidget_played_' +
					t._token +
					(t.spinResetToken ? '_' + t.spinResetToken : '');
				localStorage.setItem(a, Date.now().toString());
			} catch (a) {}
			const e = Tt(t.sectors);
			O = t.sectors[e];
			const n = 360 / t.sectors.length,
				o = -90 + e * n + n / 2,
				s = 360 * 6 - o;
			((at = s),
				(w.style.transition = 'transform 4s cubic-bezier(.17,.67,.3,1)'),
				(w.style.transform = `rotate(${at}deg)`),
				setTimeout(() => It(s, e), 4200));
		}
		function It(e, r) {
			const s = Date.now();
			function a() {
				const d = Date.now() - s,
					i = Math.min(d / 1e3, 1),
					x = Math.sin(i * Math.PI * 4) * 5 * (1 - i);
				((w.style.transition = 'transform 0s'),
					(w.style.transform = `rotate(${e + x}deg)`),
					i < 1
						? requestAnimationFrame(a)
						: (t.confettiEffectActive &&
								(Vt({ container: U, count: 180 }),
								setTimeout(() => Wt({ container: U }), 600)),
							(Ft.textContent = `\u{1F38A} \u0412\u044B \u0432\u044B\u0438\u0433\u0440\u0430\u043B\u0438: ${t.sectors[r].label}`),
							Lt()));
			}
			(a(), Gt());
		}
		function Lt() {
			(t.winningAdviceActive
				? (rt.textContent = t.winningAdviceText)
				: rt.remove(),
				t.nameFieldActive && (S == null || S.remove()),
				t.phoneFieldActive && (P == null || P.remove()),
				t.emailFieldActive && ($ == null || $.remove()),
				z.remove(),
				t.checkboxPolicyActive && (R == null || R.remove()));
		}
		const S = t.nameFieldActive ? u.getElementById('name-input') : null,
			P = t.phoneFieldActive ? u.getElementById('phone-input') : null,
			$ = t.emailFieldActive ? u.getElementById('email-input') : null,
			Dt = t.checkboxPolicyActive
				? u.getElementById('policy-input')
				: null,
			_ =
				t.phoneFieldActive && window.winwidgetPhone
					? window.winwidgetPhone.attach(P, {
							placeholder: '+7 999 123-45-67'
						})
					: null;
		function j(e) {
			let s = null;
			function a(d) {
				s || (s = d);
				const i = d - s,
					x = i / 350,
					v = Math.sin(x * 15 * Math.PI * 2) * 6 * (1 - x);
				((e.style.transform = `translateX(${v}px)`),
					i < 350 ? requestAnimationFrame(a) : (e.style.transform = ''));
			}
			requestAnimationFrame(a);
		}
		function Y() {
			let e = !0;
			return (
				t.devModeActive ||
					(t.nameFieldActive && !S.value.trim().length && (j(S), (e = !1)),
					t.phoneFieldActive && (!_ || !_.isValid()) && (j(P), (e = !1)),
					t.emailFieldActive && !X.test($.value) && (j($), (e = !1)),
					t.checkboxPolicyActive && !Dt.checked && (j(R), (e = !1))),
				e
			);
		}
		function qt() {
			S.value.length && Y();
		}
		function Nt() {
			Y();
		}
		function Rt() {
			$.value.length && Y();
		}
		function Ot() {
			return t.nameFieldActive ? S.value : null;
		}
		function _t() {
			return _ ? _.getNumber() : null;
		}
		function jt() {
			return t.emailFieldActive ? $.value : null;
		}
		async function Yt() {
			Y() &&
				((z.disabled = !0),
				(z.style.opacity = '0.6'),
				(z.style.cursor = 'not-allowed'),
				Bt());
		}
		async function Gt() {
			const e = {
				phone: _t(),
				email: jt(),
				name: Ot(),
				bonus: O == null ? void 0 : O.label
			};
			try {
				(await fetch(`${tt}/widget/${t._token}/lead`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(e)
				}),
					c('ip3_send'));
			} catch (r) {
				console.error('[winwidget] Failed to send lead:', r);
			}
		}
		function Wt({ container: e, count: r = 60 }) {
			const n = [
					'#FFD700',
					'#FF6B9D',
					'#7BED9F',
					'#70A1FF',
					'#ECCC68',
					'#ffffff',
					'#A29BFE',
					'#FF6348'
				],
				o = ['square', 'circle', 'streamer', 'diamond'],
				s = e.getBoundingClientRect();
			for (let a = 0; a < r; a++) {
				const d = Math.random() * 1200;
				setTimeout(() => {
					const i = document.createElement('div'),
						x = o[Math.floor(Math.random() * o.length)];
					(i.classList.add('confetti', x),
						(i.style.backgroundColor =
							n[Math.floor(Math.random() * n.length)]));
					const v = Math.random() * 6 + 5;
					(x !== 'streamer' &&
						((i.style.width = `${v}px`), (i.style.height = `${v}px`)),
						(i.style.left = Math.random() * s.width + 'px'),
						(i.style.top = '-20px'),
						(i.style.opacity = '1'),
						e.appendChild(i));
					const g = 3.5 + Math.random() * 2,
						A = (Math.random() - 0.5) * 60,
						F = Math.random() * 720 * (Math.random() < 0.5 ? 1 : -1);
					(requestAnimationFrame(() => {
						((i.style.transition = `top ${g}s linear, transform ${g}s ease-out, opacity 0.8s ease-out ${(g - 0.9).toFixed(1)}s`),
							(i.style.top = `${s.height + 20}px`),
							(i.style.transform = `translateX(${A}px) rotate(${F}deg)`),
							(i.style.opacity = '0'));
					}),
						setTimeout(() => i.remove(), g * 1e3 + 300));
				}, d);
			}
		}
		function Vt({ container: e, count: r = 160 }) {
			const n = [
					'#FFD700',
					'#FFC200',
					'#FF6B9D',
					'#FF4757',
					'#7BED9F',
					'#2ED573',
					'#70A1FF',
					'#1E90FF',
					'#ECCC68',
					'#ffffff',
					'#A29BFE',
					'#6C5CE7',
					'#FF6348',
					'#FFA502'
				],
				o = [
					'square',
					'circle',
					'streamer',
					'diamond',
					'square',
					'circle'
				],
				s = e.getBoundingClientRect(),
				a = s.width,
				d = s.height;
			[
				{
					delay: 0,
					origins: [{ x: a * 0.5, y: d * 0.35, n: Math.floor(r * 0.45) }]
				},
				{
					delay: 180,
					origins: [
						{ x: a * 0.2, y: d * 0.25, n: Math.floor(r * 0.25) },
						{ x: a * 0.8, y: d * 0.25, n: Math.floor(r * 0.25) }
					]
				},
				{
					delay: 380,
					origins: [
						{ x: a * 0.5, y: d * 0.2, n: Math.floor(r * 0.2) },
						{ x: a * 0.1, y: d * 0.4, n: Math.floor(r * 0.1) },
						{ x: a * 0.9, y: d * 0.4, n: Math.floor(r * 0.1) }
					]
				}
			].forEach(({ delay: x, origins: v }) => {
				setTimeout(() => {
					v.forEach(({ x: g, y: A, n: F }) => {
						for (let m = 0; m < F; m++) {
							const f = document.createElement('div'),
								L = o[Math.floor(Math.random() * o.length)];
							(f.classList.add('confetti', L),
								(f.style.backgroundColor =
									n[Math.floor(Math.random() * n.length)]));
							const D = Math.random() * 8 + 5;
							(L !== 'streamer' &&
								((f.style.width = `${D}px`), (f.style.height = `${D}px`)),
								(f.style.left = `${g + (Math.random() - 0.5) * 16}px`),
								(f.style.top = `${A + (Math.random() - 0.5) * 16}px`),
								(f.style.opacity = '1'),
								e.appendChild(f));
							const bt =
									(-90 + (Math.random() - 0.5) * 200) * (Math.PI / 180),
								mt = 120 + Math.random() * 220,
								wt = Math.cos(bt) * mt,
								J = Math.sin(bt) * mt,
								xt = Math.random() * 360,
								Kt = xt + (Math.random() * 900 - 450),
								Z = 380 + Math.random() * 200;
							(requestAnimationFrame(() => {
								((f.style.transition = `transform ${Z}ms cubic-bezier(.15,.8,.25,1)`),
									(f.style.transform = `translate(${wt}px,${J}px) rotate(${xt}deg)`));
							}),
								setTimeout(() => {
									const Jt = d - A + Math.abs(J) + 80,
										Zt = (Math.random() - 0.5) * 100,
										Q = 1800 + Math.random() * 900;
									((f.style.transition = `transform ${Q}ms cubic-bezier(.1,.5,.3,1), opacity ${Math.round(Q * 0.35)}ms ease-out ${Math.round(Q * 0.65)}ms`),
										(f.style.transform = `translate(${wt + Zt}px,${J + Jt}px) rotate(${Kt}deg)`),
										(f.style.opacity = '0'));
								}, Z),
								setTimeout(() => f.remove(), Z + 2800));
						}
					});
				}, x);
			});
		}
		(Pt(),
			t.nameFieldActive && S.addEventListener('blur', qt),
			t.phoneFieldActive && P.addEventListener('blur', Nt),
			t.emailFieldActive && $.addEventListener('blur', Rt),
			it.addEventListener('click', y),
			z.addEventListener('click', Yt),
			p.addEventListener('click', l));
		var lt = document.getElementById('ww-bubble-close'),
			I = document.getElementById('ww-bubble');
		(lt &&
			lt.addEventListener('click', function (e) {
				(e.stopPropagation(), H());
			}),
			I &&
				I.addEventListener('click', function (e) {
					(e.stopPropagation(), H(), l());
				}),
			B.addEventListener('click', y));
		let T = !1;
		try {
			const e =
					'winwidget_played_' +
					t._token +
					(t.spinResetToken ? '_' + t.spinResetToken : ''),
				r = localStorage.getItem(e);
			if (((T = t.hasPlayedByIp === !0), !T && r)) {
				const n = (t.spinCooldownDays || 0) * 24 * 60 * 60 * 1e3;
				n === 0 ? (T = !0) : (T = Date.now() - parseInt(r, 10) < n);
			}
			if (T) {
				if (t.hideIfPlayed) {
					((p.style.display = 'none'), V());
					const o = document.getElementById('wheel-widget-host');
					o && (o.style.display = 'none');
					return;
				}
				const n = u.querySelector('#control-wrapper');
				n &&
					(n.innerHTML = `
					<h1 id='title-widget' style='text-align:center;overflow-wrap:break-word;word-break:break-word'>${t.alreadyPlayedTitle}</h1>
					<p id='subtitle-widget' style='text-align:center;margin-top:8px'>${t.alreadyPlayedSubtitle}</p>
				`);
			}
		} catch (e) {}
		(t.autoOpenSeconds && !T && setTimeout(l, t.autoOpenSeconds * 1e3),
			(nt = t.buttonPulse !== !1));
		var G = (pt = t.buttonSize) != null ? pt : 64,
			dt = p.querySelector('#ww-btn-emoji');
		dt && (dt.style.fontSize = G + 'px');
		var K = p.querySelector('#ww-btn-label');
		if (K) {
			var Ht = Math.max(8, Math.round((G / 64) * 11)),
				Xt = Math.max(2, Math.round((G / 64) * 3)),
				Ut = Math.max(6, Math.round((G / 64) * 12));
			((K.style.fontSize = Ht + 'px'),
				(K.style.padding = Xt + 'px ' + Ut + 'px'));
		}
		kt(t.buttonSide || 'right');
		var ct = document.getElementById('ww-bubble-text');
		ct &&
			(ct.textContent =
				t.bubbleText ||
				t.title ||
				'\u0418\u0441\u043F\u044B\u0442\u0430\u0439\u0442\u0435 \u0443\u0434\u0430\u0447\u0443!');
		var I = document.getElementById('ww-bubble');
		(I && t.bubbleEnabled === !1 && (I.style.display = 'none'),
			(p.style.bottom = `${(ut = t.buttonBottom) != null ? ut : 3}%`),
			t.buttonSide === 'left'
				? ((p.style.right = 'auto'),
					(p.style.left = ((ht = t.buttonOffset) != null ? ht : 3) + '%'))
				: ((p.style.left = 'auto'),
					(p.style.right =
						((ft = t.buttonOffset) != null ? ft : 3) + '%')),
			window.winwidgetAutoOpen
				? ((it.style.display = 'none'),
					(B.style.pointerEvents = 'none'),
					setTimeout(l, 300))
				: ((p.style.display = 'flex'),
					t.bubbleEnabled !== !1 &&
						setTimeout(function () {
							var e = document.getElementById('ww-bubble');
							!e ||
								M.classList.contains('visible') ||
								((e.style.display = 'block'),
								requestAnimationFrame(function () {
									requestAnimationFrame(function () {
										((e.style.opacity = '1'),
											(e.style.transform = 'translateY(-50%) scale(1)'));
									});
								}));
						}, 2e3),
					V(),
					q()));
	}
	function Ct(t, c) {
		const l = t.color,
			y = t.arrowColor || '#ffcc00',
			b = t.dataType,
			u = (t.bonuses || []).filter(E => E.active),
			N =
				u.length > 0
					? u.map((E, X) => {
							var M;
							const B = E.color || (X % 2 === 0 ? l : '#ffffff');
							return {
								label: E.name,
								probability: E.neverWin
									? 0
									: (M = E.probability) != null
										? M
										: 1,
								color: B,
								textColor: B !== '#ffffff' ? '#ffffff' : '#000000',
								fontSize: '14'
							};
						})
					: [
							{
								label: '\u041F\u0440\u0438\u0437 1',
								probability: 1,
								color: l,
								textColor: '#ffffff',
								fontSize: '14'
							},
							{
								label: '\u041F\u0440\u0438\u0437 2',
								probability: 1,
								color: '#ffffff',
								textColor: '#000000',
								fontSize: '14'
							}
						];
		return {
			...t,
			_token: c,
			widgetColor: l,
			bgColor: t.bgColor || l,
			sectors: N,
			centerSVG: null,
			arrowSVG: `<polygon points="0,12 18,5 18,19" fill="${y}" filter="url(#arrow-shadow)"/><defs><filter id="arrow-shadow"><feDropShadow dx="0" dy="1" stdDeviation="2" flood-color="rgba(0,0,0,0.5)"/></filter></defs>`,
			borderColor: l,
			borderWidth: 8,
			phoneFieldActive: b === 'PHONE' || b === 'PHONE_AND_EMAIL',
			emailFieldActive: b === 'EMAIL' || b === 'PHONE_AND_EMAIL',
			nameFieldActive: b !== 'NONE',
			checkboxPolicyActive: !0,
			startBtnText:
				t.buttonText || '\u041A\u0440\u0443\u0442\u0438\u0442\u044C!',
			linkConsentText:
				t.privacyUrl ||
				'https://winwidget.ru/legal-documentation/consent-processing',
			winningAdviceActive: !!t.winMessage,
			winningAdviceText: t.winMessage || '',
			developInfoActive: !0,
			devModeActive: !1,
			confettiEffectActive: !0,
			autoOpenSeconds: t.autoOpenDelay
		};
	}
	function Mt() {
		const t = document.createElement('div');
		((t.style.cssText = [
			'position:fixed',
			'inset:0',
			'display:flex',
			'flex-direction:column',
			'align-items:center',
			'justify-content:center',
			'background:#0d0d1a',
			'color:#fff',
			'font-family:sans-serif',
			'text-align:center',
			'padding:24px',
			'z-index:2147483647'
		].join(';')),
			(t.innerHTML = [
				'<div style="font-size:3rem;margin-bottom:16px">\u{1F512}</div>',
				'<h1 style="font-size:1.4rem;font-weight:700;margin-bottom:10px">\u0412\u0438\u0434\u0436\u0435\u0442 \u043E\u0442\u043A\u043B\u044E\u0447\u0451\u043D</h1>',
				'<p style="font-size:0.95rem;color:#8080a0;margin-bottom:28px;max-width:320px">',
				'\u042D\u0442\u043E\u0442 \u0432\u0438\u0434\u0436\u0435\u0442 \u0432 \u0434\u0430\u043D\u043D\u044B\u0439 \u043C\u043E\u043C\u0435\u043D\u0442 \u043E\u0442\u043A\u043B\u044E\u0447\u0451\u043D. \u0412\u043A\u043B\u044E\u0447\u0438\u0442\u0435 \u0435\u0433\u043E \u0432 \u043B\u0438\u0447\u043D\u043E\u043C \u043A\u0430\u0431\u0438\u043D\u0435\u0442\u0435.',
				'</p>',
				'<a href="https://winwidget.ru/widgets" ',
				'style="display:inline-block;padding:11px 28px;background:#4705fb;color:#fff;',
				'border-radius:10px;font-weight:700;font-size:0.9rem;text-decoration:none;',
				'transition:background 0.2s" ',
				`onmouseover="this.style.background='#5a1aff'" `,
				`onmouseout="this.style.background='#4705fb'">`,
				'\u041F\u0435\u0440\u0435\u0439\u0442\u0438 \u0432 \u043A\u0430\u0431\u0438\u043D\u0435\u0442',
				'</a>'
			].join('')),
			document.body.appendChild(t));
	}
	async function St() {
		var c;
		const t =
			((c = k == null ? void 0 : k.dataset) == null ? void 0 : c.key) ||
			window.winwidget;
		if (!t) {
			console.warn(
				'[winwidget] Token not set. Use data-key attribute: <script src="..." data-key="YOUR_TOKEN"> or set window.winwidget before the script.'
			);
			return;
		}
		try {
			const [, l] = await Promise.all([
				At(),
				fetch(`${tt}/widget/${t}/config`)
			]);
			if (!l.ok) {
				console.warn(
					`[winwidget] Widget not found or inactive (${l.status})`
				);
				return;
			}
			const y = await l.json();
			if (!y.isActive) {
				(console.warn('[winwidget] Widget is inactive'),
					window.winwidgetAutoOpen && Mt());
				return;
			}
			Et(Ct(y, t));
		} catch (l) {
			console.error('[winwidget] Failed to load config:', l);
		}
	}
	St();
})();
