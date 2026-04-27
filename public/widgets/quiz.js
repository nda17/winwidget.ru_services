(function () {
	'use strict';
	if (window.__winquizScriptRunning) return;
	window.__winquizScriptRunning = !0;
	var h = document.currentScript,
		Z = (function () {
			try {
				var e = new URL(h && h.src ? h.src : location.href);
				return e.origin + '/api';
			} catch (n) {
				return 'https://winwidget.ru/api';
			}
		})(),
		L = (h && h.getAttribute('data-key')) || '';
	if (!L) return;
	function he(e) {
		try {
			var n = new URL(h && h.src ? h.src : location.href);
			return (
				(n.pathname = n.pathname.replace(/\/[^/]*$/, '/' + e)),
				(n.search = ''),
				(n.hash = ''),
				n.toString()
			);
		} catch (r) {
			return 'https://winwidget.ru/widgets/' + e;
		}
	}
	function me(e) {
		return new Promise(function (n, r) {
			var a = document.querySelector('script[src="' + e + '"]');
			if (a) {
				(a.addEventListener('load', n, { once: !0 }),
					a.addEventListener('error', r, { once: !0 }),
					window.winwidgetPhone && n());
				return;
			}
			var d = document.createElement('script');
			((d.src = e),
				(d.async = !0),
				(d.onload = function () {
					n();
				}),
				(d.onerror = r),
				document.head.appendChild(d));
		});
	}
	function ve() {
		return window.winwidgetPhone
			? window.winwidgetPhone.load()
			: me(he('helpers/winwidget-phone.js'))
					.then(function () {
						return window.winwidgetPhone
							? window.winwidgetPhone.load()
							: null;
					})
					.catch(function (e) {
						return (
							console.warn('[winquiz] Failed to load phone formatter:', e),
							null
						);
					});
	}
	var o = document.createElement('div');
	((o.innerHTML = [
		'<div id="wq-bubble" style="',
		'display:none;position:absolute;top:50%;transform:translateY(-50%) scale(0.85);',
		'background:#fff;border-radius:18px;padding:12px 34px 12px 16px;',
		'width:172px;box-sizing:border-box;',
		'border:1px solid rgba(71,5,251,0.12);',
		'box-shadow:0 16px 40px rgba(71,5,251,0.18),0 8px 18px rgba(15,23,42,0.08);',
		'cursor:pointer;opacity:0;',
		'transition:opacity 0.3s ease,transform 0.35s cubic-bezier(.22,1,.36,1);',
		'font-family:system-ui,-apple-system,sans-serif;',
		'">',
		'<button id="wq-bubble-close" style="',
		'position:absolute;top:7px;right:8px;background:none;border:none;',
		'font-size:11px;cursor:pointer;color:#ccc;line-height:1;padding:2px;',
		'display:flex;align-items:center;justify-content:center;',
		'width:16px;height:16px;border-radius:50%;',
		'">\u2715</button>',
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
		'<div id="wq-btn-icon" style="',
		'filter:drop-shadow(0 6px 20px rgba(71,5,251,0.55)) drop-shadow(0 2px 6px rgba(0,0,0,0.3));',
		'transition:filter 0.4s ease;',
		'">',
		'<svg id="wq-btn-svg" width="60" height="60" viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg">',
		'<circle cx="30" cy="30" r="30" fill="url(#wqGrad)"/>',
		'<circle cx="30" cy="30" r="28" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1"/>',
		'<text x="30" y="38" text-anchor="middle" font-family="system-ui,sans-serif" font-size="28" font-weight="900" fill="white">?</text>',
		'<defs>',
		'<radialGradient id="wqGrad" cx="40%" cy="30%" r="70%">',
		'<stop offset="0%" stop-color="#7c3aed"/>',
		'<stop offset="100%" stop-color="#4705fb"/>',
		'</radialGradient>',
		'</defs>',
		'</svg>',
		'</div>',
		'<div id="wq-btn-label" style="',
		'margin-top:6px;',
		'background:linear-gradient(135deg,#7c3aed,#4705fb);',
		'color:#fff;font-size:11px;font-weight:900;',
		'padding:3px 12px;border-radius:20px;white-space:normal;text-align:center;',
		'letter-spacing:0.8px;text-transform:uppercase;line-height:1.3;',
		'box-shadow:0 3px 12px rgba(71,5,251,0.5);',
		'">\u041A\u0432\u0438\u0437!<br>\u041F\u0440\u0438\u0437!</div>'
	].join('')),
		(o.style.cssText = [
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
		].join(';')),
		document.body.appendChild(o));
	var F = document.createElement('style');
	((F.textContent = [
		'@keyframes wqBounce{0%,100%{transform:translateY(0) scale(1)}10%{transform:translateY(-16px) scale(1.1)}20%{transform:translateY(0) scale(1)}30%{transform:translateY(-6px) scale(1.04)}40%{transform:translateY(0) scale(1)}}',
		'@keyframes wqSway{0%,100%{transform:rotate(0)}25%{transform:rotate(-6deg)}75%{transform:rotate(6deg)}}',
		'@keyframes wqGlow{0%,100%{filter:drop-shadow(0 6px 16px rgba(0,0,0,0.35)) drop-shadow(0 2px 4px rgba(0,0,0,0.2))}50%{filter:drop-shadow(0 8px 28px rgba(101,16,255,0.7)) drop-shadow(0 2px 12px rgba(37,117,252,0.5))}}',
		'#wq-bubble:hover{opacity:0.95!important}',
		'#wq-bubble-close:hover{color:#888!important}',
		'@media(max-width:480px){#wq-bubble{display:none!important}}'
	].join('')),
		document.head.appendChild(F));
	var W = !0,
		O = !1;
	function T() {
		O ||
			((O = !0),
			(o.style.animation = [
				'wqBounce 3s ease-in-out infinite',
				'wqSway 4s ease-in-out infinite',
				W ? 'wqGlow 2.5s ease-in-out infinite' : ''
			]
				.filter(Boolean)
				.join(',')));
	}
	function K() {
		((O = !1), (o.style.animation = 'none'));
	}
	function ye(e) {
		var n = document.getElementById('wq-bubble'),
			r = document.getElementById('wq-bubble-tail');
		!n ||
			!r ||
			(e === 'left'
				? ((n.style.left = 'calc(100% + 14px)'),
					(n.style.right = 'auto'),
					(r.style.left = '-8px'),
					(r.style.right = 'auto'),
					(r.style.borderLeft = 'none'),
					(r.style.borderRight = '8px solid #fff'))
				: ((n.style.right = 'calc(100% + 14px)'),
					(n.style.left = 'auto'),
					(r.style.right = '-8px'),
					(r.style.left = 'auto'),
					(r.style.borderRight = 'none'),
					(r.style.borderLeft = '8px solid #fff')));
	}
	function D() {
		var e = document.getElementById('wq-bubble');
		!e ||
			e.style.display === 'none' ||
			((e.style.opacity = '0'),
			(e.style.transform = 'translateY(-50%) scale(0.85)'),
			setTimeout(function () {
				e.style.display = 'none';
			}, 300));
	}
	setTimeout(T, 4e3);
	var X = !1;
	window.addEventListener(
		'scroll',
		function () {
			X ||
				((X = !0),
				o.animate(
					[
						{ transform: 'translateY(0) rotate(0)' },
						{ transform: 'translateY(-250px) rotate(-6deg)' },
						{ transform: 'translateY(0) rotate(0)' }
					],
					{ duration: 2300, easing: 'cubic-bezier(.34,1.56,.64,1)' }
				),
				T());
		},
		{ passive: !0 }
	);
	var R = document.createElement('div');
	((R.id = 'quiz-widget-host'), document.body.appendChild(R));
	var f = R.attachShadow({ mode: 'open' }),
		V = document.createElement('style');
	((V.textContent = [
		':host{position:fixed;z-index:10000;top:0}',
		'*{box-sizing:border-box;margin:0;padding:0}',
		'#wq-wrap{width:100vw;height:100dvh;display:none;overflow-x:hidden;overflow-y:auto;justify-content:center;align-items:flex-start;padding:12px}',
		'@supports not (height:100dvh){#wq-wrap{height:100vh}}',
		'.visible{display:flex!important}',
		'.hidden{display:none!important}',
		'#wq-overlay{position:fixed;inset:0;background:rgba(8,4,20,0.86);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);z-index:999;touch-action:none}',
		'#wq-card{position:relative;z-index:1000;display:flex;flex-direction:column;width:100%;max-width:520px;margin:auto;',
		'background:linear-gradient(160deg,#1a0a2e 0%,#0f0520 100%);',
		'border-radius:24px;padding:32px 24px 28px;',
		'box-shadow:0 0 0 1px rgba(255,255,255,0.07),0 32px 80px rgba(0,0,0,0.6),0 0 80px rgba(71,5,251,0.18);',
		'min-height:calc(100dvh - 24px);justify-content:center;gap:0;',
		'overflow:hidden}',
		'#wq-card::before{content:"";position:absolute;top:0;left:10%;right:10%;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.18),transparent);pointer-events:none}',
		'#wq-card::after{content:"";position:absolute;top:-80px;right:-80px;width:240px;height:240px;background:radial-gradient(circle,rgba(124,58,237,0.15) 0%,transparent 70%);pointer-events:none}',
		'#wq-close{position:absolute;top:14px;right:14px;width:34px;height:34px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.1);border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.2s,transform 0.2s,border-color 0.2s;backdrop-filter:blur(4px)}',
		'#wq-close:hover{background:rgba(255,255,255,0.16);border-color:rgba(255,255,255,0.22);transform:scale(1.08) rotate(90deg)}',
		'#wq-close svg{width:14px;height:14px}',
		'#wq-close line{stroke:rgba(255,255,255,0.8);stroke-width:2;stroke-linecap:round}',
		'#wq-brand{position:absolute;top:10px;left:50%;transform:translateX(-50%);font-size:11px;color:rgba(255,255,255,0.3);white-space:nowrap;letter-spacing:0.2px;pointer-events:auto}',
		'#wq-brand a{color:rgba(255,200,50,0.65);text-decoration:none;font-weight:600}',
		'#wq-brand a:hover{color:#ffc832}',
		'#wq-progress{display:flex;gap:5px;margin-bottom:22px}',
		'.wq-bar{flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,0.1);transition:background 0.3s}',
		'.wq-bar.done{background:linear-gradient(90deg,#7c3aed,#4705fb)}',
		'.wq-screen{display:none;flex-direction:column;gap:16px;animation:wqFadeIn 0.25s ease}',
		'.wq-screen.active{display:flex}',
		'@keyframes wqFadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}',
		'.wq-title{font-size:clamp(1.1rem,4.5vw,1.6rem);font-weight:800;color:#fff;line-height:1.25;letter-spacing:-0.3px;text-shadow:0 2px 12px rgba(0,0,0,0.3);overflow-wrap:break-word;word-break:break-word}',
		'.wq-subtitle{font-size:14px;color:rgba(255,255,255,0.65);line-height:1.55}',
		'.wq-start-btn{padding:0 24px;height:52px;font-size:16px;font-weight:700;letter-spacing:0.4px;cursor:pointer;border:none;border-radius:14px;color:#fff;',
		'background:linear-gradient(135deg,#7c3aed 0%,#4705fb 100%);',
		'box-shadow:0 4px 22px rgba(71,5,251,0.5),inset 0 1px 0 rgba(255,255,255,0.15);',
		'transition:transform 0.15s,box-shadow 0.15s,filter 0.15s;position:relative;overflow:hidden;margin-top:6px}',
		'.wq-start-btn::before{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,255,255,0.1) 0%,transparent 60%);pointer-events:none}',
		'.wq-start-btn:hover{transform:translateY(-2px);box-shadow:0 8px 30px rgba(71,5,251,0.65),inset 0 1px 0 rgba(255,255,255,0.15);filter:brightness(1.08)}',
		'.wq-start-btn:active{transform:translateY(0)}',
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
		'.wq-next-btn{align-self:flex-end;padding:10px 24px;border-radius:10px;border:none;',
		'background:linear-gradient(135deg,#7c3aed,#4705fb);color:#fff;',
		'font-size:0.9rem;font-weight:700;cursor:pointer;transition:opacity 0.2s,transform 0.15s;',
		'box-shadow:0 3px 12px rgba(71,5,251,0.4)}',
		'.wq-next-btn:hover{opacity:0.9;transform:translateY(-1px)}',
		'.wq-next-btn:disabled{opacity:0.35;cursor:default;transform:none}',
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
		'.wq-already-icon{font-size:2.5rem;text-align:center}',
		'.wq-already-title{font-size:1.1rem;font-weight:700;color:#fff;text-align:center}',
		'.wq-already-desc{font-size:0.875rem;color:rgba(255,255,255,0.6);text-align:center;line-height:1.55}',
		'@media (min-width:768px){',
		'#wq-wrap{align-items:center}',
		'#wq-card{min-height:unset;padding:40px 40px 36px;justify-content:flex-start}',
		'}'
	].join('')),
		f.appendChild(V));
	var $ = document.createElement('div');
	(($.innerHTML = [
		'<div id="wq-wrap">',
		'<div id="wq-overlay"></div>',
		'<div id="wq-card">',
		'<button id="wq-close" aria-label="\u0417\u0430\u043A\u0440\u044B\u0442\u044C">',
		'<svg viewBox="0 0 24 24" fill="none"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
		'</button>',
		'<div id="wq-brand">\u0421\u0434\u0435\u043B\u0430\u043D\u043E \u0432&nbsp;<a href="https://winwidget.ru" target="_blank" rel="noopener">winwidget.ru</a></div>',
		'<div id="wq-inner"></div>',
		'</div>',
		'</div>'
	].join('')),
		f.appendChild($));
	var B = f.getElementById('wq-wrap'),
		Y = f.getElementById('wq-inner'),
		J = f.getElementById('wq-close'),
		Q = f.getElementById('wq-overlay'),
		qe =
			/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
	function je(e) {
		return e === 'BY'
			? '+375 (__) ___-__-__'
			: e === 'UA'
				? '+380 (__) ___-__-__'
				: e === 'KZ'
					? '+7 (7__) ___-__-__'
					: e === 'international'
						? '+__ (__________'
						: '+7 (9__) ___-__-__';
	}
	function Me(e) {
		return e === 'BY' || e === 'UA' || e === 'KZ'
			? 9
			: e === 'international'
				? 7
				: 9;
	}
	function ee(e) {
		var n = 6,
			r = 15,
			a = 350,
			d = null;
		function i(s) {
			d || (d = s);
			var x = (s - d) / a;
			((e.style.transform =
				'translateX(' +
				Math.sin(x * r * Math.PI * 2) * n * (1 - x) +
				'px)'),
				s - d < a
					? requestAnimationFrame(i)
					: ((e.style.transform = ''), e.classList.remove('error')));
		}
		(e.classList.add('error'), requestAnimationFrame(i));
	}
	function u(e) {
		return String(e || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
	}
	function p(e, n) {
		var r = String(e || '#7c3aed').replace('#', '');
		r.length === 3 && (r = r[0] + r[0] + r[1] + r[1] + r[2] + r[2]);
		var a = parseInt(r.slice(0, 2), 16),
			d = parseInt(r.slice(2, 4), 16),
			i = parseInt(r.slice(4, 6), 16);
		return 'rgba(' + a + ',' + d + ',' + i + ',' + n + ')';
	}
	function ke(e, n, r) {
		if (!r || !r.length) return null;
		var a = {};
		(r.forEach(function (s) {
			a[s.id] = 0;
		}),
			e.forEach(function (s) {
				for (var x = null, E = 0; E < n.length; E++)
					if (n[E].id === s.questionId) {
						x = n[E];
						break;
					}
				x &&
					s.optionIds.forEach(function (z) {
						for (var m = null, C = 0; C < x.options.length; C++)
							if (x.options[C].id === z) {
								m = x.options[C];
								break;
							}
						!m ||
							!m.scores ||
							Object.keys(m.scores).forEach(function (v) {
								v in a && (a[v] += Number(m.scores[v]) || 0);
							});
					});
			}));
		var d = r[0],
			i = -1 / 0;
		return (
			r.forEach(function (s) {
				(a[s.id] || 0) > i && ((i = a[s.id] || 0), (d = s));
			}),
			d
		);
	}
	function Ee(e) {
		var pe, ue, be, fe;
		var n = e.questions || [],
			r = e.results || [],
			a = [];
		W = e.buttonPulse !== !1;
		var d = e.devModeActive === !0,
			i = e.color || '#7c3aed',
			s = e.buttonColor || i,
			x = document.createElement('style');
		((x.textContent = [
			e.bgColor ? '#wq-card{background:' + e.bgColor + '!important}' : '',
			'.wq-bar.done{background:' + i + '!important}',
			'.wq-start-btn,.wq-submit-btn,.wq-result-btn{background:' +
				s +
				'!important;box-shadow:0 4px 22px ' +
				p(s, 0.5) +
				',inset 0 1px 0 rgba(255,255,255,0.15)!important}',
			'.wq-start-btn:hover,.wq-submit-btn:hover,.wq-result-btn:hover{box-shadow:0 8px 30px ' +
				p(s, 0.65) +
				'!important}',
			'.wq-next-btn{background:' +
				i +
				'!important;box-shadow:0 3px 12px ' +
				p(i, 0.4) +
				'!important}',
			'.wq-opt:hover{border-color:' +
				p(i, 0.6) +
				'!important;background:' +
				p(i, 0.12) +
				'!important}',
			'.wq-opt.selected{border-color:' +
				i +
				'!important;background:linear-gradient(135deg,' +
				p(i, 0.35) +
				',' +
				p(s, 0.25) +
				')!important;box-shadow:0 2px 12px ' +
				p(s, 0.25) +
				'!important}',
			'.wq-input:focus{border-color:' +
				p(i, 0.7) +
				'!important;box-shadow:0 0 0 3px ' +
				p(i, 0.15) +
				'!important}',
			'.wq-result-badge{background:linear-gradient(135deg,' +
				p(i, 0.3) +
				',' +
				p(s, 0.2) +
				')!important;border-color:' +
				p(i, 0.4) +
				'!important}'
		].join('')),
			f.appendChild(x));
		function E(t) {
			if (e.yandexMetrikaId && typeof ym == 'function')
				try {
					ym(Number(e.yandexMetrikaId), 'reachGoal', t);
				} catch (l) {}
			if (e.vkPixelId && window.VK && typeof VK.Goal == 'function')
				try {
					VK.Goal(t);
				} catch (l) {}
			if (e.roistatEnabled && window.roistat && window.roistat.event)
				try {
					window.roistat.event.send(t);
				} catch (l) {}
		}
		function z() {
			(D(),
				B.classList.remove('hidden'),
				B.classList.add('visible'),
				(document.body.style.overflow = 'hidden'),
				(document.body.style.position = 'fixed'),
				(document.body.style.width = '100%'),
				(o.style.opacity = '0'),
				(o.style.pointerEvents = 'none'),
				(o.style.transform = 'scale(0.8)'),
				K(),
				E('quiz_open'));
		}
		function m() {
			(B.classList.remove('visible'),
				B.classList.add('hidden'),
				(document.body.style.overflow = ''),
				(document.body.style.position = ''),
				(document.body.style.width = ''),
				window.winquizAutoOpen ||
					((o.style.opacity = '1'),
					(o.style.pointerEvents = 'auto'),
					(o.style.transform = 'scale(1)'),
					T()));
		}
		(o.addEventListener('click', z),
			J.addEventListener('click', m),
			Q.addEventListener('click', m));
		function C(t, l) {
			var c = document.createElement('div');
			c.id = 'wq-progress';
			for (var w = 0; w < l; w++) {
				var b = document.createElement('div');
				((b.className = 'wq-bar' + (w < t ? ' done' : '')),
					c.appendChild(b));
			}
			return c;
		}
		function v(t) {
			Y.innerHTML = t;
		}
		function te() {
			((a = []),
				v(
					[
						'<div class="wq-screen active" id="s-welcome">',
						'<div class="wq-title">' + u(e.title) + '</div>',
						e.subtitle
							? '<div class="wq-subtitle">' + u(e.subtitle) + '</div>'
							: '',
						'<div class="wq-divider"></div>',
						'<button class="wq-start-btn" id="wq-start">' +
							u(
								e.buttonText ||
									'\u041D\u0430\u0447\u0430\u0442\u044C \u043A\u0432\u0438\u0437'
							) +
							'</button>',
						'</div>'
					].join('')
				),
				f
					.getElementById('wq-start')
					.addEventListener('click', function () {
						n.length && ne(0);
					}));
		}
		function ne(t) {
			if (t >= n.length) {
				var l = (e.dataType || 'PHONE').toUpperCase();
				l === 'NONE' ? re(null, null) : ze();
				return;
			}
			var c = n[t],
				w = c.type === 'checkbox',
				b = [];
			((Y.innerHTML = ''), Y.appendChild(C(t, n.length)));
			var g = document.createElement('div');
			g.className = 'wq-screen active';
			var I = document.createElement('div');
			((I.style.cssText =
				'font-size:12px;font-weight:600;color:rgba(255,255,255,0.4);letter-spacing:0.5px;text-transform:uppercase'),
				(I.textContent =
					'\u0412\u043E\u043F\u0440\u043E\u0441 ' +
					(t + 1) +
					' \u0438\u0437 ' +
					n.length),
				g.appendChild(I));
			var y = document.createElement('div');
			((y.className = 'wq-q-text'),
				(y.textContent =
					c.text || '\u0412\u043E\u043F\u0440\u043E\u0441 ' + (t + 1)),
				g.appendChild(y));
			var N = document.createElement('div');
			N.className = 'wq-options';
			var we = !1;
			(c.options.forEach(function (P, Te) {
				var k = document.createElement('button');
				((k.className = 'wq-opt' + (w ? ' wq-opt-checkbox' : '')),
					k.setAttribute('data-id', P.id),
					(k.innerHTML = [
						'<span class="wq-opt-indicator' +
							(w ? ' wq-opt-checkbox-indicator' : '') +
							'"></span>',
						'<span>' +
							u(
								P.text ||
									'\u0412\u0430\u0440\u0438\u0430\u043D\u0442 ' + (Te + 1)
							) +
							'</span>'
					].join('')),
					k.addEventListener('click', function () {
						if (w) {
							var ge = b.indexOf(P.id);
							(ge === -1
								? (b.push(P.id), k.classList.add('selected'))
								: (b.splice(ge, 1), k.classList.remove('selected')),
								q && (q.disabled = b.length === 0));
						} else
							((b = [P.id]),
								N.querySelectorAll('.wq-opt').forEach(function (Ye) {
									Ye.classList.remove('selected');
								}),
								k.classList.add('selected'),
								we || ((we = !0), setTimeout(xe, 300)));
					}),
					N.appendChild(k));
			}),
				g.appendChild(N));
			var q = null;
			(w &&
				((q = document.createElement('button')),
				(q.className = 'wq-next-btn'),
				(q.textContent = '\u0414\u0430\u043B\u0435\u0435 \u2192'),
				(q.disabled = !0),
				q.addEventListener('click', xe),
				g.appendChild(q)),
				Y.appendChild(g));
			function xe() {
				(a.push({ questionId: c.id, optionIds: b.slice() }), ne(t + 1));
			}
		}
		function ze() {
			var t = (e.dataType || 'PHONE').toUpperCase();
			v(
				[
					'<div class="wq-screen active" id="s-contact">',
					'<div class="wq-contact-title">' +
						u(
							e.contactTitle ||
								'\u041E\u0441\u0442\u0430\u0432\u044C\u0442\u0435 \u043A\u043E\u043D\u0442\u0430\u043A\u0442 \u0434\u043B\u044F \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u0438\u044F \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442\u0430'
						) +
						'</div>',
					t === 'PHONE' || t === 'PHONE_AND_EMAIL'
						? '<input class="wq-input" id="wq-phone" type="tel" placeholder="\u2726  \u0412\u0430\u0448 \u0442\u0435\u043B\u0435\u0444\u043E\u043D" autocomplete="tel"/>'
						: '',
					t === 'EMAIL' || t === 'PHONE_AND_EMAIL'
						? '<input class="wq-input" id="wq-email" type="email" placeholder="\u2726  \u0412\u0430\u0448 email" autocomplete="email"/>'
						: '',
					'<div id="wq-err" style="font-size:13px;color:rgba(239,120,100,1);min-height:18px"></div>',
					'<button class="wq-submit-btn" id="wq-submit">\u041F\u043E\u043B\u0443\u0447\u0438\u0442\u044C \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442</button>',
					e.privacyUrl
						? '<div class="wq-privacy">\u041D\u0430\u0436\u0438\u043C\u0430\u044F \u043A\u043D\u043E\u043F\u043A\u0443, \u0432\u044B \u0441\u043E\u0433\u043B\u0430\u0448\u0430\u0435\u0442\u0435\u0441\u044C \u0441 <a href="' +
							u(e.privacyUrl) +
							'" target="_blank" rel="noopener">\u043F\u043E\u043B\u0438\u0442\u0438\u043A\u043E\u0439 \u043A\u043E\u043D\u0444\u0438\u0434\u0435\u043D\u0446\u0438\u0430\u043B\u044C\u043D\u043E\u0441\u0442\u0438</a></div>'
						: '',
					'</div>'
				].join('')
			);
			var l = f.getElementById('wq-phone'),
				c = f.getElementById('wq-email'),
				w = f.getElementById('wq-err'),
				b = f.getElementById('wq-submit'),
				g =
					l && window.winwidgetPhone
						? window.winwidgetPhone.attach(l, {
								placeholder: '+7 999 123-45-67'
							})
						: null;
			function I() {
				return l && g ? g.getNumber() : null;
			}
			b.addEventListener('click', function () {
				w.textContent = '';
				var y = !0;
				(!d &&
					(l &&
						!I() &&
						(ee(l),
						(w.textContent =
							'\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u043D\u043E\u043C\u0435\u0440 \u0442\u0435\u043B\u0435\u0444\u043E\u043D\u0430'),
						(y = !1)),
					y &&
						c &&
						!qe.test(c.value.trim()) &&
						(ee(c),
						(w.textContent =
							'\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 email'),
						(y = !1)),
					!y)) ||
					((b.disabled = !0),
					(b.textContent =
						'\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u0435\u043C...'),
					re(I(), c ? c.value.trim() : null));
			});
		}
		function Ce() {
			try {
				var t = 'wq_p_' + L + '_' + (e.quizResetToken || ''),
					l = (e.quizCooldownDays || 0) > 0 ? e.quizCooldownDays : 365;
				document.cookie =
					t +
					'=' +
					encodeURIComponent(String(Date.now())) +
					';expires=' +
					new Date(Date.now() + l * 864e5).toUTCString() +
					';path=/;SameSite=Lax';
			} catch (c) {}
		}
		function re(t, l) {
			var c = ke(a, n, r);
			(Ce(),
				fetch(Z + '/quiz/' + L + '/lead', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						contact: t || l || 'unknown',
						phone: t || void 0,
						email: l || void 0,
						answers: a,
						url: window.location.href
					})
				}).catch(function () {}),
				E('quiz_lead'),
				Ae(c));
		}
		function Ae(t) {
			v(
				[
					'<div class="wq-screen active" id="s-result">',
					'<div class="wq-result-badge">&#10003; \u0412\u0430\u0448 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442</div>',
					t
						? [
								'<div class="wq-result-title">' + u(t.title) + '</div>',
								t.description
									? '<div class="wq-result-desc">' +
										u(t.description) +
										'</div>'
									: '',
								t.promoCode
									? [
											'<div class="wq-promo">',
											'<div class="wq-promo-label">\u0412\u0430\u0448 \u043F\u0440\u043E\u043C\u043E\u043A\u043E\u0434</div>',
											'<div class="wq-promo-code">' +
												u(t.promoCode) +
												'</div>',
											'</div>'
										].join('')
									: '',
								t.buttonText && t.buttonUrl
									? '<a class="wq-result-btn" href="' +
										u(t.buttonUrl) +
										'" target="_blank" rel="noopener noreferrer">' +
										u(t.buttonText) +
										'</a>'
									: ''
							].join('')
						: [
								'<div class="wq-result-title">\u0421\u043F\u0430\u0441\u0438\u0431\u043E!</div>',
								'<div class="wq-result-desc">\u0412\u0430\u0448\u0438 \u043E\u0442\u0432\u0435\u0442\u044B \u043F\u0440\u0438\u043D\u044F\u0442\u044B. \u041C\u044B \u0441\u0432\u044F\u0436\u0435\u043C\u0441\u044F \u0441 \u0432\u0430\u043C\u0438 \u0432 \u0431\u043B\u0438\u0436\u0430\u0439\u0448\u0435\u0435 \u0432\u0440\u0435\u043C\u044F.</div>'
							].join(''),
					'</div>'
				].join('')
			);
		}
		function oe() {
			v(
				[
					'<div class="wq-screen active">',
					'<div class="wq-already-icon">\u{1F389}</div>',
					'<div class="wq-already-title">' +
						u(
							e.alreadyPlayedTitle ||
								'\u0412\u044B \u0443\u0436\u0435 \u043F\u0440\u043E\u0445\u043E\u0434\u0438\u043B\u0438 \u044D\u0442\u043E\u0442 \u043A\u0432\u0438\u0437!'
						) +
						'</div>',
					'<div class="wq-already-desc">' +
						u(
							e.alreadyPlayedSubtitle ||
								'\u041A\u0430\u0436\u0434\u044B\u0439 \u043F\u043E\u0441\u0435\u0442\u0438\u0442\u0435\u043B\u044C \u043C\u043E\u0436\u0435\u0442 \u043F\u0440\u043E\u0439\u0442\u0438 \u043A\u0432\u0438\u0437 \u0442\u043E\u043B\u044C\u043A\u043E \u043E\u0434\u0438\u043D \u0440\u0430\u0437'
						) +
						'</div>',
					'</div>'
				].join('')
			);
		}
		var S = (pe = e.buttonSize) != null ? pe : 60,
			U = o.querySelector('#wq-btn-svg');
		U &&
			(U.setAttribute('width', S + ''), U.setAttribute('height', S + ''));
		var H = o.querySelector('#wq-btn-label');
		if (H) {
			var Ie = Math.max(8, Math.round((S / 60) * 11)),
				Le = Math.max(2, Math.round((S / 60) * 3)),
				Be = Math.max(6, Math.round((S / 60) * 12));
			((H.style.fontSize = Ie + 'px'),
				(H.style.padding = Le + 'px ' + Be + 'px'));
		}
		var A = e.openButtonColor || i,
			ie = o.querySelector('#wqGrad');
		if (ie) {
			var j = ie.querySelectorAll('stop');
			(j[0] && j[0].setAttribute('stop-color', A),
				j[1] && j[1].setAttribute('stop-color', A));
		}
		var ae = o.querySelector('#wq-btn-icon');
		ae &&
			(ae.style.filter =
				'drop-shadow(0 6px 20px ' +
				p(A, 0.55) +
				') drop-shadow(0 2px 6px rgba(0,0,0,0.3))');
		var G = o.querySelector('#wq-btn-label');
		(G &&
			((G.style.background =
				'linear-gradient(135deg,' + A + ',' + A + ')'),
			(G.style.boxShadow = '0 3px 12px ' + p(A, 0.5))),
			(o.style.bottom = ((ue = e.buttonBottom) != null ? ue : 3) + '%'),
			ye(e.buttonSide || 'right'));
		var se = document.getElementById('wq-bubble-text');
		se &&
			(se.textContent =
				e.bubbleText ||
				e.title ||
				'\u041F\u0440\u043E\u0439\u0434\u0438\u0442\u0435 \u043A\u0432\u0438\u0437!');
		var M = document.getElementById('wq-bubble'),
			de = document.getElementById('wq-bubble-close');
		(M && e.bubbleEnabled === !1 && (M.style.display = 'none'),
			de &&
				de.addEventListener('click', function (t) {
					(t.stopPropagation(), D());
				}),
			M &&
				M.addEventListener('click', function (t) {
					(t.stopPropagation(), D(), z());
				}),
			e.buttonSide === 'left'
				? ((o.style.right = 'auto'),
					(o.style.left = ((be = e.buttonOffset) != null ? be : 3) + '%'))
				: ((o.style.left = 'auto'),
					(o.style.right =
						((fe = e.buttonOffset) != null ? fe : 3) + '%')));
		var _ = !1;
		try {
			var Se = 'wq_p_' + L + '_' + (e.quizResetToken || ''),
				le = document.cookie.match('(?:^|;)\\s*' + Se + '=([^;]*)');
			if (le) {
				var Pe = decodeURIComponent(le[1]),
					ce = (e.quizCooldownDays || 0) * 864e5;
				ce === 0 ? (_ = !0) : (_ = Date.now() - parseInt(Pe, 10) < ce);
			}
		} catch (t) {}
		if ((e.hasPlayedByIp && (_ = !0), _ && e.hideIfPlayed)) {
			o.style.display = 'none';
			return;
		}
		(e.autoOpenDelay && !_ && setTimeout(z, e.autoOpenDelay * 1e3),
			window.winquizAutoOpen
				? ((J.style.display = 'none'),
					(Q.style.pointerEvents = 'none'),
					setTimeout(z, 300),
					_ ? setTimeout(oe, 350) : te())
				: (_ ? oe() : te(),
					(o.style.display = 'flex'),
					e.bubbleEnabled !== !1 &&
						setTimeout(function () {
							var t = document.getElementById('wq-bubble');
							!t ||
								B.classList.contains('visible') ||
								((t.style.display = 'block'),
								requestAnimationFrame(function () {
									requestAnimationFrame(function () {
										((t.style.opacity = '1'),
											(t.style.transform = 'translateY(-50%) scale(1)'));
									});
								}));
						}, 2e3),
					K(),
					T()));
	}
	function _e() {
		var e = document.createElement('div');
		((e.style.cssText =
			'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0d0d1a;color:#fff;font-family:sans-serif;text-align:center;padding:24px;z-index:2147483647'),
			(e.innerHTML =
				'<div style="font-size:3rem;margin-bottom:16px">\u{1F512}</div><h1 style="font-size:1.3rem;font-weight:700;margin-bottom:10px">\u041A\u0432\u0438\u0437 \u043E\u0442\u043A\u043B\u044E\u0447\u0451\u043D</h1><p style="font-size:0.9rem;color:#8080a0;margin-bottom:28px;max-width:300px">\u042D\u0442\u043E\u0442 \u043A\u0432\u0438\u0437 \u0432 \u0434\u0430\u043D\u043D\u044B\u0439 \u043C\u043E\u043C\u0435\u043D\u0442 \u043E\u0442\u043A\u043B\u044E\u0447\u0451\u043D.</p><a href="https://winwidget.ru/widgets" style="display:inline-block;padding:11px 28px;background:#4705fb;color:#fff;border-radius:10px;font-weight:700;font-size:0.9rem;text-decoration:none">\u041F\u0435\u0440\u0435\u0439\u0442\u0438 \u0432 \u043A\u0430\u0431\u0438\u043D\u0435\u0442</a>'),
			document.body.appendChild(e));
	}
	Promise.all([ve(), fetch(Z + '/quiz/' + L + '/config')])
		.then(function (e) {
			var n = e[1];
			return n.ok
				? n.json()
				: (console.warn(
						'[winquiz] Widget not found or inactive (' + n.status + ')'
					),
					null);
		})
		.then(function (e) {
			if (e !== null) {
				if (!e || !e.isActive) {
					(console.warn('[winquiz] Widget is inactive'),
						window.winquizAutoOpen && _e());
					return;
				}
				Ee(e);
			}
		})
		.catch(function (e) {
			console.error('[winquiz] failed to load config', e);
		});
})();
