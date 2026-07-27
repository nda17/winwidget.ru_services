(function () {
	'use strict';

	if (window.__winquizScriptRunning) return;
	window.__winquizScriptRunning = true;

	var SYSTEM_FONT_STACK =
		"system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

	var _currentScript = document.currentScript;

	var API_BASE = (function () {
		try {
			var src = new URL(
				_currentScript && _currentScript.src
					? _currentScript.src
					: location.href
			);
			return src.origin + '/api/v1';
		} catch (e) {
			return 'https://winwidget.ru/api/v1';
		}
	})();

	var KEY =
		(_currentScript && _currentScript.getAttribute('data-key')) || '';
	if (!KEY) return;

	function getWidgetFetchOptions(options) {
		var next = options || {};
		if (window.winquizAutoOpen) next.referrerPolicy = 'unsafe-url';
		return next;
	}

	function getWidgetAssetUrl(fileName) {
		try {
			var src = new URL(
				_currentScript && _currentScript.src
					? _currentScript.src
					: location.href
			);
			src.pathname = src.pathname.replace(/\/[^/]*$/, '/' + fileName);
			src.search = '';
			src.hash = '';
			return src.toString();
		} catch (e) {
			return 'https://winwidget.ru/widgets/' + fileName;
		}
	}

	function loadExternalScript(src) {
		return new Promise(function (resolve, reject) {
			var existing = document.querySelector('script[src="' + src + '"]');
			if (existing) {
				existing.addEventListener('load', resolve, { once: true });
				existing.addEventListener('error', reject, { once: true });
				if (window.winwidgetPhone) resolve();
				return;
			}
			var script = document.createElement('script');
			script.src = src;
			script.async = true;
			script.onload = function () {
				resolve();
			};
			script.onerror = reject;
			document.head.appendChild(script);
		});
	}

	function ensurePhoneHelper() {
		if (window.winwidgetPhone) return window.winwidgetPhone.load();
		return loadExternalScript(
			getWidgetAssetUrl('helpers/winwidget-phone.js')
		)
			.then(function () {
				return window.winwidgetPhone ? window.winwidgetPhone.load() : null;
			})
			.catch(function (e) {
				console.warn('[winquiz] Failed to load phone formatter:', e);
				return null;
			});
	}

	// ─── Floating button ──────────────────────────────────────────────────────

	var quizBtn = document.createElement('div');
	quizBtn.innerHTML = [
		'<div id="wq-bubble" style="',
		'display:none;position:absolute;top:50%;transform:translateY(-50%) scale(0.85);',
		'background:#fff;border-radius:18px;padding:12px 34px 12px 16px;',
		'width:172px;box-sizing:border-box;',
		'border:1px solid rgba(71,5,251,0.12);',
		'box-shadow:0 16px 40px rgba(71,5,251,0.18),0 8px 18px rgba(15,23,42,0.08);',
		'cursor:pointer;opacity:0;',
		'transition:opacity 0.3s ease,transform 0.35s cubic-bezier(.22,1,.36,1);',
		'font-family:' + SYSTEM_FONT_STACK + ';',
		'">',
		'<button id="wq-bubble-close" style="',
		'position:absolute;top:7px;right:8px;background:none;border:none;',
		'font-size:11px;cursor:pointer;color:#ccc;line-height:1;padding:2px;',
		'display:flex;align-items:center;justify-content:center;',
		'width:16px;height:16px;border-radius:50%;',
		'">✕</button>',
		'<p id="wq-bubble-text" style="',
		'margin:0;font-size:13px;font-weight:600;color:#1a1a1a;line-height:1.4;',
		'"></p>',
		'<span style="position:absolute;left:12px;top:-6px;width:12px;height:12px;border-radius:50%;background:#22c55e;border:2px solid #fff;box-shadow:0 0 0 4px rgba(34,197,94,.14);"></span>',
		'<div id="wq-bubble-tail" style="',
		'position:absolute;top:50%;transform:translateY(-50%);',
		'width:0;height:0;',
		'border-top:7px solid transparent;border-bottom:7px solid transparent;',
		'"></div>',
		'</div>',
		'<img id="wq-btn-icon" src="' +
			getWidgetAssetUrl('quiz-button.png') +
			'" alt="" aria-hidden="true" draggable="false" style="',
		'width:60px;height:60px;display:block;object-fit:contain;line-height:1;',
		'filter:drop-shadow(0 6px 20px rgba(71,5,251,0.55)) drop-shadow(0 2px 6px rgba(0,0,0,0.3));',
		'transform-origin:50% 100%;',
		'transition:filter 0.4s ease;',
		'" />'
	].join('');

	quizBtn.style.cssText = [
		'position:fixed',
		'display:none',
		'align-items:center',
		'justify-content:center',
		'flex-direction:column',
		'cursor:pointer',
		'z-index:9999',
		'max-width:calc(100vw - 56px)',
		'transition:opacity 350ms ease,transform 350ms cubic-bezier(.34,1.56,.64,1)',
		'user-select:none',
		'-webkit-tap-highlight-color:transparent'
	].join(';');

	document.body.appendChild(quizBtn);

	// Button animations
	var styleAnim = document.createElement('style');
	styleAnim.textContent = [
		'@keyframes wqBounce{0%,100%{transform:translateY(0) scale(1)}10%{transform:translateY(-16px) scale(1.1)}20%{transform:translateY(0) scale(1)}30%{transform:translateY(-6px) scale(1.04)}40%{transform:translateY(0) scale(1)}}',
		'@keyframes wqSway{0%,100%{transform:rotate(0)}25%{transform:rotate(-6deg)}75%{transform:rotate(6deg)}}',
		'@keyframes wqGlow{0%,100%{filter:drop-shadow(0 6px 16px rgba(0,0,0,0.35)) drop-shadow(0 2px 4px rgba(0,0,0,0.2))}50%{filter:drop-shadow(0 8px 28px rgba(101,16,255,0.7)) drop-shadow(0 2px 12px rgba(37,117,252,0.5))}}',
		'#wq-bubble:hover{opacity:0.95!important}',
		'#wq-bubble-close:hover{color:#888!important}',
		'@media(max-width:480px){#wq-bubble{display:none!important}}'
	].join('');
	document.head.appendChild(styleAnim);

	var _pulseEnabled = true;
	var _animActive = false;

	function startBtnAnim() {
		if (_animActive) return;
		_animActive = true;
		quizBtn.style.animation = [
			'wqBounce 3s ease-in-out infinite',
			'wqSway 4s ease-in-out infinite',
			_pulseEnabled ? 'wqGlow 2.5s ease-in-out infinite' : ''
		]
			.filter(Boolean)
			.join(',');
	}

	function stopBtnAnim() {
		_animActive = false;
		quizBtn.style.animation = 'none';
	}

	function updateBubbleSide(side) {
		var bubble = document.getElementById('wq-bubble');
		var tail = document.getElementById('wq-bubble-tail');
		if (!bubble || !tail) return;
		if (side === 'left') {
			bubble.style.left = 'calc(100% + 14px)';
			bubble.style.right = 'auto';
			tail.style.left = '-8px';
			tail.style.right = 'auto';
			tail.style.borderLeft = 'none';
			tail.style.borderRight = '8px solid #fff';
		} else {
			bubble.style.right = 'calc(100% + 14px)';
			bubble.style.left = 'auto';
			tail.style.right = '-8px';
			tail.style.left = 'auto';
			tail.style.borderRight = 'none';
			tail.style.borderLeft = '8px solid #fff';
		}
	}

	function hideBubble() {
		var bubble = document.getElementById('wq-bubble');
		if (!bubble || bubble.style.display === 'none') return;
		bubble.style.opacity = '0';
		bubble.style.transform = 'translateY(-50%) scale(0.85)';
		setTimeout(function () {
			bubble.style.display = 'none';
		}, 300);
	}

	setTimeout(startBtnAnim, 4000);

	var _scrollTriggered = false;
	window.addEventListener(
		'scroll',
		function () {
			if (_scrollTriggered) return;
			_scrollTriggered = true;
			quizBtn.animate(
				[
					{ transform: 'translateY(0) rotate(0)' },
					{ transform: 'translateY(-250px) rotate(-6deg)' },
					{ transform: 'translateY(0) rotate(0)' }
				],
				{ duration: 2300, easing: 'cubic-bezier(.34,1.56,.64,1)' }
			);
			startBtnAnim();
		},
		{ passive: true }
	);

	// ─── Shadow DOM host ─────────────────────────────────────────────────────

	var host = document.createElement('div');
	host.id = 'quiz-widget-host';
	document.body.appendChild(host);
	var shadow = host.attachShadow({ mode: 'open' });

	var style = document.createElement('style');
	style.textContent = [
		`:host{font-family:${SYSTEM_FONT_STACK};position:fixed;z-index:${window.winquizAutoOpen ? 2147483647 : 10000};top:0}`,
		'*{box-sizing:border-box;margin:0;padding:0}',

		// wrapper
		'#wq-wrap{width:100vw;height:100dvh;display:none;overflow-x:hidden;overflow-y:auto;justify-content:center;align-items:flex-start;padding:12px}',
		'@supports not (height:100dvh){#wq-wrap{height:100vh}}',
		'.visible{display:flex!important}',
		'.hidden{display:none!important}',

		// overlay
		'#wq-overlay{position:fixed;inset:0;background:rgba(8,4,20,0.85);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);z-index:999;touch-action:none}',

		// card
		'#wq-card{position:relative;z-index:1000;display:flex;flex-direction:column;width:100%;max-width:520px;margin:auto;',
		'background:linear-gradient(160deg,#1a0a2e 0%,#0f0520 100%);',
		'border-radius:24px;padding:32px 24px 28px;',
		'box-shadow:0 0 0 1px rgba(255,255,255,0.07),0 32px 80px rgba(0,0,0,0.6),0 0 80px rgba(71,5,251,0.18);',
		'min-height:calc(100dvh - 24px);justify-content:center;gap:0;',
		'overflow:hidden}',
		'#wq-card::before{content:"";position:absolute;top:0;left:10%;right:10%;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.18),transparent);pointer-events:none}',
		'#wq-card::after{content:"";position:absolute;top:-80px;right:-80px;width:240px;height:240px;background:radial-gradient(circle,rgba(124,58,237,0.15) 0%,transparent 70%);pointer-events:none}',

		// close
		'#wq-close{position:absolute;top:14px;right:14px;width:34px;height:34px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.1);border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.2s,transform 0.2s,border-color 0.2s;backdrop-filter:blur(4px)}',
		'#wq-close:hover{background:rgba(255,255,255,0.16);border-color:rgba(255,255,255,0.22);transform:scale(1.08) rotate(90deg)}',
		'#wq-close svg{width:14px;height:14px}',
		'#wq-close line{stroke:rgba(255,255,255,0.8);stroke-width:2;stroke-linecap:round}',
		'#wq-brand{position:absolute;top:10px;left:50%;transform:translateX(-50%);font-size:12px;color:rgba(255,255,255,0.35);white-space:nowrap;letter-spacing:0.2px;pointer-events:auto}',
		'#wq-brand a{color:rgba(255,200,50,0.7);text-decoration:none;font-weight:600}',
		'#wq-brand a:hover{color:#ffc832}',

		// progress
		'#wq-progress{display:flex;gap:5px;margin-bottom:22px}',
		'.wq-bar{flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,0.1);transition:background 0.3s}',
		'.wq-bar.done{background:linear-gradient(90deg,#7c3aed,#4705fb)}',

		// screens
		'.wq-screen{display:none;flex-direction:column;gap:16px;animation:wqFadeIn 0.25s ease}',
		'.wq-screen.active{display:flex}',
		'@keyframes wqFadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}',

		// typography
		'.wq-title{font-size:clamp(1.1rem,4.5vw,1.6rem);font-weight:800;color:#fff;line-height:1.25;letter-spacing:-0.3px;text-shadow:0 2px 12px rgba(0,0,0,0.3);overflow-wrap:break-word;word-break:break-word}',
		'.wq-subtitle{font-size:14px;color:rgba(255,255,255,0.65);line-height:1.55}',

		// start btn
		'.wq-start-btn{padding:0 24px;height:52px;font-size:16px;font-weight:700;letter-spacing:0.4px;cursor:pointer;border:none;border-radius:14px;color:#fff;',
		'background:linear-gradient(135deg,#7c3aed 0%,#4705fb 100%);',
		'box-shadow:0 4px 22px rgba(71,5,251,0.5),inset 0 1px 0 rgba(255,255,255,0.15);',
		'transition:transform 0.15s,box-shadow 0.15s,filter 0.15s;position:relative;overflow:hidden;margin-top:6px}',
		'.wq-start-btn::before{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,255,255,0.1) 0%,transparent 60%);pointer-events:none}',
		'.wq-start-btn:hover{transform:translateY(-2px);box-shadow:0 8px 30px rgba(71,5,251,0.65),inset 0 1px 0 rgba(255,255,255,0.15);filter:brightness(1.08)}',
		'.wq-start-btn:active{transform:translateY(0)}',

		// question
		'.wq-q-text{font-size:1rem;font-weight:700;color:#fff;line-height:1.4;overflow-wrap:break-word}',
		'.wq-options{display:flex;flex-direction:column;gap:9px}',
		'.wq-opt{display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:12px;',
		'border:1.5px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.05);',
		'transition:border-color 0.15s,background 0.15s,transform 0.1s;',
		'text-align:left;font-size:0.9rem;color:rgba(255,255,255,0.85);cursor:pointer;line-height:1.35}',
		'.wq-opt:hover{border-color:rgba(124,58,237,0.6);background:rgba(124,58,237,0.12);transform:translateX(2px)}',
		'.wq-opt.selected{border-color:#7c3aed;background:linear-gradient(135deg,rgba(124,58,237,0.35),rgba(71,5,251,0.25));color:#fff;box-shadow:0 2px 12px rgba(71,5,251,0.25)}',
		'.wq-opt-indicator{width:18px;height:18px;min-width:18px;border-radius:50%;border:2px solid rgba(255,255,255,0.3);display:flex;align-items:center;justify-content:center;transition:border-color 0.15s,background 0.15s}',
		'.wq-opt.selected .wq-opt-indicator{border-color:#a78bfa;background:rgba(167,139,250,0.2)}',
		'.wq-opt.selected .wq-opt-indicator::after{content:"";display:block;width:8px;height:8px;border-radius:50%;background:#a78bfa}',
		'.wq-opt-checkbox .wq-opt-indicator{border-radius:5px}',
		'.wq-opt.selected .wq-opt-checkbox-indicator::after{content:"";display:block;width:10px;height:6px;border-left:2px solid #a78bfa;border-bottom:2px solid #a78bfa;transform:rotate(-45deg) translateY(-1px)}',

		// next btn
		'.wq-next-btn{align-self:flex-end;padding:10px 24px;border-radius:10px;border:none;',
		'background:linear-gradient(135deg,#7c3aed,#4705fb);color:#fff;',
		'font-size:0.9rem;font-weight:700;cursor:pointer;transition:opacity 0.2s,transform 0.15s;',
		'box-shadow:0 3px 12px rgba(71,5,251,0.4)}',
		'.wq-next-btn:hover{opacity:0.9;transform:translateY(-1px)}',
		'.wq-next-btn:disabled{opacity:0.35;cursor:default;transform:none}',

		// contact
		'.wq-contact-title{font-size:1rem;font-weight:700;color:#fff;line-height:1.35}',
		'.wq-input{border:1.5px solid rgba(255,255,255,0.1);outline:none;',
		'background:rgba(255,255,255,0.07);padding:0 15px;border-radius:12px;',
		'width:100%;color:#fff;font-size:15px;height:50px;',
		'transition:border-color 250ms,background 250ms,box-shadow 250ms;backdrop-filter:blur(4px)}',
		'.wq-input::placeholder{color:rgba(255,255,255,0.35)}',
		'.wq-input:focus{border-color:rgba(124,58,237,0.7);background:rgba(124,58,237,0.1);box-shadow:0 0 0 3px rgba(124,58,237,0.15)}',
		'.wq-input.error{border-color:rgba(239,68,68,0.7);box-shadow:0 0 0 3px rgba(239,68,68,0.12)}',

		'.wq-submit-btn{padding:0 24px;height:52px;font-size:16px;font-weight:700;letter-spacing:0.4px;cursor:pointer;border:none;border-radius:14px;color:#fff;',
		'background:linear-gradient(135deg,#7c3aed 0%,#4705fb 100%);',
		'box-shadow:0 4px 22px rgba(71,5,251,0.5),inset 0 1px 0 rgba(255,255,255,0.15);',
		'transition:transform 0.15s,box-shadow 0.15s,filter 0.15s;position:relative;overflow:hidden}',
		'.wq-submit-btn::before{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,255,255,0.1) 0%,transparent 60%);pointer-events:none}',
		'.wq-submit-btn:hover{transform:translateY(-2px);box-shadow:0 8px 30px rgba(71,5,251,0.65);filter:brightness(1.08)}',
		'.wq-submit-btn:active{transform:translateY(0)}',
		'.wq-submit-btn:disabled{opacity:0.5;cursor:not-allowed;transform:none}',

		'.wq-privacy{font-size:12px;color:rgba(255,255,255,0.38);text-align:center;line-height:1.5}',
		'.wq-privacy a{color:rgba(255,255,255,0.55);text-decoration:underline;text-underline-offset:2px}',
		'.wq-privacy a:hover{color:#fff}',

		// result
		'.wq-result-badge{display:inline-flex;align-items:center;gap:6px;background:linear-gradient(135deg,rgba(124,58,237,0.3),rgba(71,5,251,0.2));border:1px solid rgba(124,58,237,0.4);border-radius:20px;padding:5px 14px;font-size:12px;font-weight:700;color:#a78bfa;letter-spacing:0.5px;text-transform:uppercase}',
		'.wq-result-title{font-size:clamp(1.1rem,4vw,1.5rem);font-weight:800;color:#fff;line-height:1.25;overflow-wrap:break-word}',
		'.wq-result-desc{font-size:0.9rem;color:rgba(255,255,255,0.72);line-height:1.65}',
		'.wq-promo{background:rgba(255,255,255,0.05);border:1px solid rgba(124,58,237,0.4);border-radius:14px;padding:16px 20px;text-align:center}',
		'.wq-promo-label{font-size:11px;color:rgba(255,255,255,0.5);letter-spacing:0.8px;text-transform:uppercase;margin-bottom:6px}',
		'.wq-promo-code{font-size:1.4rem;font-weight:900;letter-spacing:0.1em;',
		'background:linear-gradient(135deg,#a78bfa,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}',
		'.wq-result-btn{display:block;padding:13px 24px;border-radius:12px;border:none;',
		'background:linear-gradient(135deg,#7c3aed,#4705fb);color:#fff;',
		'font-size:0.95rem;font-weight:700;text-decoration:none;text-align:center;cursor:pointer;',
		'box-shadow:0 4px 18px rgba(71,5,251,0.45);transition:opacity 0.2s,transform 0.15s}',
		'.wq-result-btn:hover{opacity:0.9;transform:translateY(-1px)}',
		'.wq-divider{height:1px;background:rgba(255,255,255,0.08);margin:2px 0}',

		// already
		'.wq-already-icon{font-size:2.5rem;text-align:center}',
		'.wq-already-title{font-size:1.1rem;font-weight:700;color:#fff;text-align:center}',
		'.wq-already-desc{font-size:0.875rem;color:rgba(255,255,255,0.6);text-align:center;line-height:1.55}',

		// desktop
		'@media (min-width:768px){',
		'#wq-wrap{align-items:center}',
		'#wq-card{min-height:unset;padding:40px 40px 36px;justify-content:flex-start}',
		'}'
	].join('');

	shadow.appendChild(style);

	var container = document.createElement('div');
	container.innerHTML = [
		'<div id="wq-wrap">',
		'<div id="wq-overlay"></div>',
		'<div id="wq-card">',
		'<button id="wq-close" aria-label="Закрыть">',
		'<svg viewBox="0 0 24 24" fill="none"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
		'</button>',
		'<div id="wq-brand">Сделано в&nbsp;<a href="https://winwidget.ru" target="_blank" rel="noopener">winwidget.ru</a></div>',
		'<div id="wq-inner"></div>',
		'</div>',
		'</div>'
	].join('');
	shadow.appendChild(container);

	var wrap = shadow.getElementById('wq-wrap');
	var inner = shadow.getElementById('wq-inner');
	var closeBtn = shadow.getElementById('wq-close');
	var overlay = shadow.getElementById('wq-overlay');

	// ─── Validation helpers ───────────────────────────────────────────────────

	var EMAIL_REGEXP =
		/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;

	// Phone mask (RU: +7 (9__) ___-__-__)
	function buildPhoneMask(region) {
		if (region === 'BY') return '+375 (__) ___-__-__';
		if (region === 'UA') return '+380 (__) ___-__-__';
		if (region === 'KZ') return '+7 (7__) ___-__-__';
		if (region === 'international') return '+__ (__________';
		return '+7 (9__) ___-__-__';
	}

	function maskDigitsCount(region) {
		if (region === 'BY') return 9;
		if (region === 'UA') return 9;
		if (region === 'KZ') return 9;
		if (region === 'international') return 7;
		return 9;
	}

	function shakeInput(el) {
		var distance = 6,
			shakes = 15,
			duration = 350,
			start = null;
		function frame(t) {
			if (!start) start = t;
			var p = (t - start) / duration;
			el.style.transform =
				'translateX(' +
				Math.sin(p * shakes * Math.PI * 2) * distance * (1 - p) +
				'px)';
			if (t - start < duration) requestAnimationFrame(frame);
			else {
				el.style.transform = '';
				el.classList.remove('error');
			}
		}
		el.classList.add('error');
		requestAnimationFrame(frame);
	}

	function esc(s) {
		return String(s || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
	}

	function getSafeExternalUrl(value, allowContactProtocols) {
		if (typeof value !== 'string' || !value.trim()) return '';
		try {
			var url = new URL(value.trim(), window.location.href);
			if (url.protocol === 'http:' || url.protocol === 'https:') {
				return url.href;
			}
			if (
				allowContactProtocols &&
				(url.protocol === 'tel:' || url.protocol === 'mailto:')
			) {
				return url.href;
			}
		} catch (e) {}
		return '';
	}

	function getSafeColor(value, fallback) {
		const color = String(value || '').trim();
		return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
	}

	function hexToRgba(hex, alpha) {
		var h = String(hex || '#7c3aed').replace('#', '');
		if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
		var r = parseInt(h.slice(0, 2), 16),
			g = parseInt(h.slice(2, 4), 16),
			b = parseInt(h.slice(4, 6), 16);
		return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
	}

	// ─── Score calculation ────────────────────────────────────────────────────

	function scoreAnswers(answers, questions, results) {
		if (!results || !results.length) return null;
		var scores = {};
		results.forEach(function (r) {
			scores[r.id] = 0;
		});
		answers.forEach(function (ans) {
			var q = null;
			for (var i = 0; i < questions.length; i++) {
				if (questions[i].id === ans.questionId) {
					q = questions[i];
					break;
				}
			}
			if (!q) return;
			ans.optionIds.forEach(function (oid) {
				var opt = null;
				for (var j = 0; j < q.options.length; j++) {
					if (q.options[j].id === oid) {
						opt = q.options[j];
						break;
					}
				}
				if (!opt || !opt.scores) return;
				Object.keys(opt.scores).forEach(function (rid) {
					if (rid in scores) scores[rid] += Number(opt.scores[rid]) || 0;
				});
			});
		});
		var winner = results[0];
		var max = -Infinity;
		results.forEach(function (r) {
			if ((scores[r.id] || 0) > max) {
				max = scores[r.id] || 0;
				winner = r;
			}
		});
		return winner;
	}

	// ─── Widget init ──────────────────────────────────────────────────────────

	function initWidget(cfg) {
		var questions = cfg.questions || [];
		var results = cfg.results || [];
		var answers = [];
		var brand = shadow.getElementById('wq-brand');
		if (brand) {
			brand.style.display =
				cfg.developInfoActive === false || cfg.hideBranding === true
					? 'none'
					: '';
		}

		_pulseEnabled = cfg.buttonPulse !== false;
		var _devMode = cfg.devModeActive === true;

		// Dynamic color overrides
		var _accent = getSafeColor(cfg.color, '#7c3aed');
		var _btn = getSafeColor(cfg.buttonColor, _accent);
		var _background = getSafeColor(cfg.bgColor, '');
		var dynStyle = document.createElement('style');
		dynStyle.textContent = [
			_background
				? '#wq-card{background:' + _background + '!important}'
				: '',
			'.wq-bar.done{background:' + _accent + '!important}',
			'.wq-start-btn,.wq-submit-btn,.wq-result-btn{background:' +
				_btn +
				'!important;box-shadow:0 4px 22px ' +
				hexToRgba(_btn, 0.5) +
				',inset 0 1px 0 rgba(255,255,255,0.15)!important}',
			'.wq-start-btn:hover,.wq-submit-btn:hover,.wq-result-btn:hover{box-shadow:0 8px 30px ' +
				hexToRgba(_btn, 0.65) +
				'!important}',
			'.wq-next-btn{background:' +
				_accent +
				'!important;box-shadow:0 3px 12px ' +
				hexToRgba(_accent, 0.4) +
				'!important}',
			'.wq-opt:hover{border-color:' +
				hexToRgba(_accent, 0.6) +
				'!important;background:' +
				hexToRgba(_accent, 0.12) +
				'!important}',
			'.wq-opt.selected{border-color:' +
				_accent +
				'!important;background:linear-gradient(135deg,' +
				hexToRgba(_accent, 0.35) +
				',' +
				hexToRgba(_btn, 0.25) +
				')!important;box-shadow:0 2px 12px ' +
				hexToRgba(_btn, 0.25) +
				'!important}',
			'.wq-input:focus{border-color:' +
				hexToRgba(_accent, 0.7) +
				'!important;box-shadow:0 0 0 3px ' +
				hexToRgba(_accent, 0.15) +
				'!important}',
			'.wq-result-badge{background:linear-gradient(135deg,' +
				hexToRgba(_accent, 0.3) +
				',' +
				hexToRgba(_btn, 0.2) +
				')!important;border-color:' +
				hexToRgba(_accent, 0.4) +
				'!important}'
		].join('');
		shadow.appendChild(dynStyle);

		// pixel events
		function firePixel(goal) {
			if (cfg.yandexMetrikaId && typeof ym === 'function') {
				try {
					ym(Number(cfg.yandexMetrikaId), 'reachGoal', goal);
				} catch (e) {}
			}
			if (cfg.vkPixelId && window.VK && typeof VK.Goal === 'function') {
				try {
					VK.Goal(goal);
				} catch (e) {}
			}
			if (cfg.roistatEnabled && window.roistat && window.roistat.event) {
				try {
					window.roistat.event.send(goal);
				} catch (e) {}
			}
		}

		function openWidget() {
			hideBubble();
			wrap.classList.remove('hidden');
			wrap.classList.add('visible');
			document.body.style.overflow = 'hidden';
			document.body.style.position = 'fixed';
			document.body.style.width = '100%';
			quizBtn.style.opacity = '0';
			quizBtn.style.pointerEvents = 'none';
			quizBtn.style.transform = 'scale(0.8)';
			stopBtnAnim();
			firePixel('wq_open');
		}

		function closeWidget() {
			wrap.classList.remove('visible');
			wrap.classList.add('hidden');
			document.body.style.overflow = '';
			document.body.style.position = '';
			document.body.style.width = '';
			if (!window.winquizAutoOpen) {
				quizBtn.style.opacity = '1';
				quizBtn.style.pointerEvents = 'auto';
				quizBtn.style.transform = 'scale(1)';
				startBtnAnim();
			}
		}

		quizBtn.addEventListener('click', openWidget);
		closeBtn.addEventListener('click', closeWidget);
		overlay.addEventListener('click', closeWidget);

		// ── Screens ────────────────────────────────────────────────────────────

		function makeProgress(current, total) {
			var el = document.createElement('div');
			el.id = 'wq-progress';
			for (var i = 0; i < total; i++) {
				var bar = document.createElement('div');
				bar.className = 'wq-bar' + (i < current ? ' done' : '');
				el.appendChild(bar);
			}
			return el;
		}

		function render(html) {
			inner.innerHTML = html;
		}

		function showWelcome() {
			answers = [];
			render(
				[
					'<div class="wq-screen active" id="s-welcome">',
					'<div class="wq-title">' + esc(cfg.title) + '</div>',
					cfg.subtitle
						? '<div class="wq-subtitle">' + esc(cfg.subtitle) + '</div>'
						: '',
					'<div class="wq-divider"></div>',
					'<button class="wq-start-btn" id="wq-start">' +
						esc(cfg.buttonText || 'Начать квиз') +
						'</button>',
					'</div>'
				].join('')
			);

			shadow
				.getElementById('wq-start')
				.addEventListener('click', function () {
					if (!questions.length) return;
					showQuestion(0);
				});
		}

		function showQuestion(idx) {
			if (idx >= questions.length) {
				var dc = (cfg.dataType || 'PHONE').toUpperCase();
				if (dc === 'NONE') {
					submitAndShowResult(null, null);
				} else {
					showContact();
				}
				return;
			}
			var q = questions[idx];
			var isCheckbox = q.type === 'checkbox';
			var selected = [];

			inner.innerHTML = '';
			inner.appendChild(makeProgress(idx, questions.length));

			var screen = document.createElement('div');
			screen.className = 'wq-screen active';

			var counter = document.createElement('div');
			counter.style.cssText =
				'font-size:12px;font-weight:600;color:rgba(255,255,255,0.4);letter-spacing:0.5px;text-transform:uppercase';
			counter.textContent =
				'Вопрос ' + (idx + 1) + ' из ' + questions.length;
			screen.appendChild(counter);

			var qText = document.createElement('div');
			qText.className = 'wq-q-text';
			qText.textContent = q.text || 'Вопрос ' + (idx + 1);
			screen.appendChild(qText);

			var optList = document.createElement('div');
			optList.className = 'wq-options';
			var goNextScheduled = false;

			q.options.forEach(function (opt, oIdx) {
				var btn = document.createElement('button');
				btn.className = 'wq-opt' + (isCheckbox ? ' wq-opt-checkbox' : '');
				btn.setAttribute('data-id', opt.id);
				btn.innerHTML = [
					'<span class="wq-opt-indicator' +
						(isCheckbox ? ' wq-opt-checkbox-indicator' : '') +
						'"></span>',
					'<span>' + esc(opt.text || 'Вариант ' + (oIdx + 1)) + '</span>'
				].join('');

				btn.addEventListener('click', function () {
					if (isCheckbox) {
						var i = selected.indexOf(opt.id);
						if (i === -1) {
							selected.push(opt.id);
							btn.classList.add('selected');
						} else {
							selected.splice(i, 1);
							btn.classList.remove('selected');
						}
						if (nextBtn) nextBtn.disabled = selected.length === 0;
					} else {
						selected = [opt.id];
						optList.querySelectorAll('.wq-opt').forEach(function (b) {
							b.classList.remove('selected');
						});
						btn.classList.add('selected');
						if (!goNextScheduled) {
							goNextScheduled = true;
							setTimeout(goNext, 300);
						}
					}
				});
				optList.appendChild(btn);
			});
			screen.appendChild(optList);

			var nextBtn = null;
			if (isCheckbox) {
				nextBtn = document.createElement('button');
				nextBtn.className = 'wq-next-btn';
				nextBtn.textContent = 'Далее →';
				nextBtn.disabled = true;
				nextBtn.addEventListener('click', goNext);
				screen.appendChild(nextBtn);
			}

			inner.appendChild(screen);

			function goNext() {
				answers.push({ questionId: q.id, optionIds: selected.slice() });
				showQuestion(idx + 1);
			}
		}

		function showContact() {
			var dc = (cfg.dataType || 'PHONE').toUpperCase();
			var privacyUrl = getSafeExternalUrl(cfg.privacyUrl, false);

			render(
				[
					'<div class="wq-screen active" id="s-contact">',
					'<div class="wq-contact-title">' +
						esc(
							cfg.contactTitle ||
								'Оставьте контакт для получения результата'
						) +
						'</div>',
					dc === 'PHONE' || dc === 'PHONE_AND_EMAIL'
						? '<input class="wq-input" id="wq-phone" type="tel" placeholder="✦  Ваш телефон" autocomplete="tel"/>'
						: '',
					dc === 'EMAIL' || dc === 'PHONE_AND_EMAIL'
						? '<input class="wq-input" id="wq-email" type="email" placeholder="✦  Ваш email" autocomplete="email"/>'
						: '',
					'<div id="wq-err" style="font-size:13px;color:rgba(239,120,100,1);min-height:18px"></div>',
					'<button class="wq-submit-btn" id="wq-submit">Получить результат</button>',
					privacyUrl
						? '<div class="wq-privacy">Нажимая кнопку, вы соглашаетесь с <a href="' +
							esc(privacyUrl) +
							'" target="_blank" rel="noopener">политикой конфиденциальности</a></div>'
						: '',
					'</div>'
				].join('')
			);

			var phoneInput = shadow.getElementById('wq-phone');
			var emailInput = shadow.getElementById('wq-email');
			var errEl = shadow.getElementById('wq-err');
			var submitBtn = shadow.getElementById('wq-submit');
			var phoneController =
				phoneInput && window.winwidgetPhone
					? window.winwidgetPhone.attach(phoneInput, {
							placeholder: '+7 999 123-45-67'
						})
					: null;

			function getPhone() {
				if (!phoneInput) return null;
				return phoneController ? phoneController.getNumber() : null;
			}

			submitBtn.addEventListener('click', function () {
				errEl.textContent = '';
				var valid = true;

				if (!_devMode) {
					if (phoneInput && !getPhone()) {
						shakeInput(phoneInput);
						errEl.textContent = 'Введите корректный номер телефона';
						valid = false;
					}
					if (
						valid &&
						emailInput &&
						!EMAIL_REGEXP.test(emailInput.value.trim())
					) {
						shakeInput(emailInput);
						errEl.textContent = 'Введите корректный email';
						valid = false;
					}
					if (!valid) return;
				}

				submitBtn.disabled = true;
				submitBtn.textContent = 'Отправляем...';
				submitAndShowResult(
					getPhone(),
					emailInput ? emailInput.value.trim() : null
				);
			});
		}

		function setPlayedCookie() {
			try {
				var ck = 'wq_p_' + KEY + '_' + (cfg.quizResetToken || '');
				var d =
					(cfg.quizCooldownDays || 0) > 0 ? cfg.quizCooldownDays : 365;
				document.cookie =
					ck +
					'=' +
					encodeURIComponent(String(Date.now())) +
					';expires=' +
					new Date(Date.now() + d * 864e5).toUTCString() +
					';path=/;SameSite=Lax';
			} catch (e) {}
		}

		function showSubmitting() {
			render(
				[
					'<div class="wq-screen active">',
					'<div class="wq-result-badge">Отправляем</div>',
					'<div class="wq-result-title">Сохраняем ваши ответы...</div>',
					'<div class="wq-result-desc">Пожалуйста, не закрывайте виджет.</div>',
					'</div>'
				].join('')
			);
		}

		function showSubmitError(message, phone, email) {
			render(
				[
					'<div class="wq-screen active">',
					'<div class="wq-result-badge">Не отправлено</div>',
					'<div class="wq-result-title">Не удалось сохранить ответы</div>',
					'<div class="wq-result-desc">' + esc(message) + '</div>',
					'<button class="wq-submit-btn" id="wq-retry">Повторить отправку</button>',
					'</div>'
				].join('')
			);
			shadow
				.getElementById('wq-retry')
				.addEventListener('click', function () {
					submitAndShowResult(phone, email);
				});
		}

		function getSubmitError(response) {
			return response
				.json()
				.catch(function () {
					return null;
				})
				.then(function (data) {
					var message =
						data && Array.isArray(data.message)
							? data.message.join('. ')
							: data && typeof data.message === 'string'
								? data.message
								: 'Попробуйте ещё раз через несколько секунд.';
					var error = new Error(message);
					error.isServerResponse = true;
					throw error;
				});
		}

		function submitAndShowResult(phone, email) {
			var resultData = scoreAnswers(answers, questions, results);
			showSubmitting();

			fetch(
				API_BASE + '/quiz/' + KEY + '/lead',
				getWidgetFetchOptions({
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						contact: phone || email || 'unknown',
						phone: phone || undefined,
						email: email || undefined,
						answers: answers,
						url: window.location.href
					})
				})
			)
				.then(function (response) {
					if (!response.ok) return getSubmitError(response);
					return response;
				})
				.then(function () {
					setPlayedCookie();
					firePixel('wq_send');
					showResult(resultData);
				})
				.catch(function (error) {
					showSubmitError(
						error && error.isServerResponse && error.message
							? error.message
							: 'Проверьте интернет-соединение и попробуйте ещё раз.',
						phone,
						email
					);
				});
		}

		function showResult(rd) {
			var resultButtonUrl = rd && getSafeExternalUrl(rd.buttonUrl, true);
			render(
				[
					'<div class="wq-screen active" id="s-result">',
					'<div class="wq-result-badge">&#10003; Ваш результат</div>',
					rd
						? [
								'<div class="wq-result-title">' + esc(rd.title) + '</div>',
								rd.description
									? '<div class="wq-result-desc">' +
										esc(rd.description) +
										'</div>'
									: '',
								rd.promoCode
									? [
											'<div class="wq-promo">',
											'<div class="wq-promo-label">Ваш промокод</div>',
											'<div class="wq-promo-code">' +
												esc(rd.promoCode) +
												'</div>',
											'</div>'
										].join('')
									: '',
								rd.buttonText && resultButtonUrl
									? '<a class="wq-result-btn" href="' +
										esc(resultButtonUrl) +
										'"' +
										(resultButtonUrl.indexOf('http:') === 0 ||
										resultButtonUrl.indexOf('https:') === 0
											? ' target="_blank" rel="noopener noreferrer"'
											: '') +
										'>' +
										esc(rd.buttonText) +
										'</a>'
									: ''
							].join('')
						: [
								'<div class="wq-result-title">Спасибо!</div>',
								'<div class="wq-result-desc">Ваши ответы приняты. Мы свяжемся с вами в ближайшее время.</div>'
							].join(''),
					'</div>'
				].join('')
			);
		}

		function showAlready() {
			render(
				[
					'<div class="wq-screen active">',
					'<div class="wq-already-icon">🎉</div>',
					'<div class="wq-already-title">' +
						esc(cfg.alreadyPlayedTitle || 'Вы уже проходили этот квиз!') +
						'</div>',
					'<div class="wq-already-desc">' +
						esc(
							cfg.alreadyPlayedSubtitle ||
								'Каждый посетитель может пройти квиз только один раз'
						) +
						'</div>',
					'</div>'
				].join('')
			);
		}

		// ── Button positioning ─────────────────────────────────────────────────

		var qsz = cfg.buttonSize ?? 60;
		var btnIcon = quizBtn.querySelector('#wq-btn-icon');
		if (btnIcon) {
			btnIcon.style.width = qsz + 'px';
			btnIcon.style.height = qsz + 'px';
			btnIcon.onerror = function () {
				btnIcon.onerror = null;
				btnIcon.src = getWidgetAssetUrl('quiz-button.png');
			};
			btnIcon.src =
				cfg.buttonImageUrl || getWidgetAssetUrl('quiz-button.png');
		}
		var _openBtnColor = getSafeColor(cfg.openButtonColor, _accent);
		var iconEl = quizBtn.querySelector('#wq-btn-icon');
		if (iconEl) {
			iconEl.style.filter =
				'drop-shadow(0 6px 20px ' +
				hexToRgba(_openBtnColor, 0.55) +
				') drop-shadow(0 2px 6px rgba(0,0,0,0.3))';
		}
		quizBtn.style.bottom = (cfg.buttonBottom ?? 3) + '%';
		updateBubbleSide(cfg.buttonSide || 'right');
		var bubbleText = document.getElementById('wq-bubble-text');
		if (bubbleText) {
			bubbleText.textContent =
				cfg.bubbleText || cfg.title || 'Пройдите квиз!';
		}
		var bubbleEl = document.getElementById('wq-bubble');
		var bubbleClose = document.getElementById('wq-bubble-close');
		if (bubbleEl && cfg.bubbleEnabled === false) {
			bubbleEl.style.display = 'none';
		}
		if (bubbleClose) {
			bubbleClose.addEventListener('click', function (e) {
				e.stopPropagation();
				hideBubble();
			});
		}
		if (bubbleEl) {
			bubbleEl.addEventListener('click', function (e) {
				e.stopPropagation();
				hideBubble();
				openWidget();
			});
		}
		if (cfg.buttonSide === 'left') {
			quizBtn.style.right = 'auto';
			quizBtn.style.left = (cfg.buttonOffset ?? 3) + '%';
		} else {
			quizBtn.style.left = 'auto';
			quizBtn.style.right = (cfg.buttonOffset ?? 3) + '%';
		}

		// ── Already played check ──────────────────────────────────────────────

		var hasPlayed = false;
		try {
			var cookieKey = 'wq_p_' + KEY + '_' + (cfg.quizResetToken || '');
			var stored = document.cookie.match(
				'(?:^|;)\\s*' + cookieKey + '=([^;]*)'
			);
			if (stored) {
				var ts = decodeURIComponent(stored[1]);
				var cooldownMs = (cfg.quizCooldownDays || 0) * 864e5;
				if (cooldownMs === 0) {
					hasPlayed = true;
				} else {
					hasPlayed = Date.now() - parseInt(ts, 10) < cooldownMs;
				}
			}
		} catch (e) {}

		// Server-side IP check takes priority
		if (cfg.hasPlayedByIp) hasPlayed = true;

		if (hasPlayed && cfg.hideIfPlayed) {
			quizBtn.style.display = 'none';
			return;
		}

		if (cfg.autoOpenDelay && !hasPlayed)
			setTimeout(openWidget, cfg.autoOpenDelay * 1000);

		if (window.winquizAutoOpen) {
			closeBtn.style.display = 'none';
			overlay.style.pointerEvents = 'none';
			setTimeout(openWidget, 300);
			if (hasPlayed) {
				setTimeout(showAlready, 350);
			} else {
				showWelcome();
			}
		} else {
			if (hasPlayed) {
				showAlready();
			} else {
				showWelcome();
			}
			quizBtn.style.display = 'flex';
			if (cfg.bubbleEnabled !== false) {
				setTimeout(function () {
					var b = document.getElementById('wq-bubble');
					if (!b || wrap.classList.contains('visible')) return;
					b.style.display = 'block';
					requestAnimationFrame(function () {
						requestAnimationFrame(function () {
							b.style.opacity = '1';
							b.style.transform = 'translateY(-50%) scale(1)';
						});
					});
				}, 2000);
			}
			stopBtnAnim();
			startBtnAnim();
		}
	}

	// ─── Boot ─────────────────────────────────────────────────────────────────

	function showDisabledPage() {
		var el = document.createElement('div');
		el.style.cssText =
			'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0d0d1a;color:#fff;font-family:' +
			SYSTEM_FONT_STACK +
			';text-align:center;padding:24px;z-index:2147483647';
		el.innerHTML =
			'<div style="font-size:3rem;margin-bottom:16px">🔒</div><h1 style="font-size:1.3rem;font-weight:700;margin-bottom:10px">Виджет временно отключен</h1>';
		document.body.appendChild(el);
	}

	Promise.all([
		ensurePhoneHelper(),
		fetch(API_BASE + '/quiz/' + KEY + '/config', getWidgetFetchOptions())
	])
		.then(function (result) {
			var r = result[1];
			if (!r.ok) {
				console.warn(
					'[winquiz] Widget not found or inactive (' + r.status + ')'
				);
				return null;
			}
			return r.json();
		})
		.then(function (server) {
			if (server === null) return;
			if (!server || !server.isActive) {
				console.warn('[winquiz] Widget is inactive');
				if (window.winquizAutoOpen) showDisabledPage();
				return;
			}
			initWidget(server);
		})
		.catch(function (e) {
			console.error('[winquiz] failed to load config', e);
		});
})();
