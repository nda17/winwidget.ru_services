(function () {
	'use strict';
	if (window.__wintimerScriptRunning) return;
	window.__wintimerScriptRunning = !0;
	var b = document.currentScript,
		F = (function () {
			try {
				var t = new URL(b && b.src ? b.src : location.href);
				return t.origin + '/api';
			} catch (e) {
				return 'https://winwidget.ru/api';
			}
		})(),
		f = (b && b.getAttribute('data-key')) || window.wintimer || '';
	if (!f) {
		delete window.__wintimerScriptRunning;
		return;
	}
	function ae(t) {
		try {
			var e = new URL(b && b.src ? b.src : location.href);
			return (
				(e.pathname = e.pathname.replace(/\/[^/]*$/, '/' + t)),
				(e.search = ''),
				(e.hash = ''),
				e.toString()
			);
		} catch (n) {
			return 'https://winwidget.ru/widgets/' + t;
		}
	}
	function le(t) {
		return new Promise(function (e, n) {
			var r = document.querySelector('script[src="' + t + '"]');
			if (r) {
				(r.addEventListener('load', e, { once: !0 }),
					r.addEventListener('error', n, { once: !0 }),
					window.winwidgetPhone && e());
				return;
			}
			var a = document.createElement('script');
			((a.src = t),
				(a.async = !0),
				(a.onload = function () {
					e();
				}),
				(a.onerror = n),
				document.head.appendChild(a));
		});
	}
	function de() {
		return window.winwidgetPhone
			? window.winwidgetPhone.load()
			: le(ae('helpers/winwidget-phone.js'))
					.then(function () {
						return window.winwidgetPhone
							? window.winwidgetPhone.load()
							: null;
					})
					.catch(function (t) {
						return (
							console.warn(
								'[wintimer] Failed to load phone formatter:',
								t
							),
							null
						);
					});
	}
	var v = !!(
			window.wintimerAutoOpen ||
			window.winwidgetTimerAutoOpen ||
			(window.winwidget && window.winwidget.autoOpen)
		),
		_ = {
			RU: {
				mask: '+7 (###) ###-##-##',
				placeholder: '+7 (___) ___-__-__',
				digits: 10
			},
			BY: {
				mask: '+375 (##) ###-##-##',
				placeholder: '+375 (__) ___-__-__',
				digits: 9
			},
			KZ: {
				mask: '+7 (###) ###-##-##',
				placeholder: '+7 (___) ___-__-__',
				digits: 10
			},
			UA: {
				mask: '+380 (##) ###-##-##',
				placeholder: '+380 (__) ___-__-__',
				digits: 9
			},
			UZ: {
				mask: '+998 (##) ###-##-##',
				placeholder: '+998 (__) ___-__-__',
				digits: 9
			},
			INT: {
				mask: '+##############',
				placeholder: '+______________',
				digits: 14
			}
		};
	function _e(t, e) {
		var n = t.replace(/\D/g, '');
		((e === _.RU || e === _.KZ) &&
			(n.startsWith('8') && (n = '7' + n.slice(1)),
			n.startsWith('7') && (n = n.slice(1))),
			e === _.BY && n.startsWith('375') && (n = n.slice(3)),
			e === _.UA && n.startsWith('380') && (n = n.slice(3)),
			e === _.UZ && n.startsWith('998') && (n = n.slice(3)));
		var r = 0;
		return e.mask.replace(/#/g, function () {
			return r < n.length ? n[r++] : '_';
		});
	}
	function se(t, e) {
		var n = e.mask.split('#')[0].replace(/\D/g, ''),
			r = t.replace(/\D/g, '');
		return (
			r.startsWith(n) && (r = r.slice(n.length)),
			r.replace(/_/g, '')
		);
	}
	function Se(t, e) {
		return se(t, e).length >= e.digits;
	}
	function d(t, e, n) {
		var r = document.createElement(t);
		return (
			e &&
				Object.keys(e).forEach(function (a) {
					r.style[a] = e[a];
				}),
			n !== void 0 && (r.innerHTML = n),
			r
		);
	}
	function g(t, e) {
		return t == null || t === '' ? e : String(t);
	}
	function pe() {
		return (
			F +
			'/countdown-timer/' +
			encodeURIComponent(f) +
			'/config?_=' +
			Date.now()
		);
	}
	var i = null,
		u = !1,
		k = !1,
		O = null,
		m = null,
		x = null,
		l = document.createElement('div');
	((l.id = 'timer-widget-button'),
		(l.innerHTML = [
			'<div id="wt-bubble" style="display:none;position:absolute;top:50%;transform:translateY(-50%) scale(0.85);background:#fff;border-radius:18px;padding:12px 34px 12px 16px;width:172px;box-sizing:border-box;border:1px solid rgba(71,5,251,0.12);box-shadow:0 16px 40px rgba(71,5,251,0.18),0 8px 18px rgba(15,23,42,0.08);cursor:pointer;opacity:0;transition:opacity 0.3s ease,transform 0.35s cubic-bezier(.22,1,.36,1);font-family:system-ui,-apple-system,sans-serif;">',
			'<button id="wt-bubble-close" style="position:absolute;top:7px;right:8px;background:none;border:none;font-size:11px;cursor:pointer;color:#ccc;line-height:1;padding:2px;display:flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;">\u2715</button>',
			'<p id="wt-bubble-text" style="margin:0;font-size:13px;font-weight:600;color:#1a1a1a;line-height:1.4;"></p>',
			'<span style="position:absolute;left:12px;top:-6px;width:12px;height:12px;border-radius:50%;background:#22c55e;border:2px solid #fff;box-shadow:0 0 0 4px rgba(34,197,94,.14);"></span>',
			'<div id="wt-bubble-tail" style="position:absolute;top:50%;transform:translateY(-50%);width:0;height:0;border-top:7px solid transparent;border-bottom:7px solid transparent;"></div>',
			'</div>',
			'<div id="wt-btn-icon" style="position:relative;filter:drop-shadow(0 6px 24px rgba(71,5,251,0.45)) drop-shadow(0 2px 8px rgba(0,0,0,0.22));">',
			'<div id="wt-ring-1" style="position:absolute;inset:0;border-radius:50%;pointer-events:none;background:rgba(71,5,251,0.32);"></div>',
			'<div id="wt-ring-2" style="position:absolute;inset:0;border-radius:50%;pointer-events:none;background:rgba(71,5,251,0.18);"></div>',
			'<svg width="60" height="60" viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg" style="position:relative;z-index:1;display:block">',
			'<circle cx="30" cy="30" r="30" fill="#4705fb"/>',
			'<circle cx="30" cy="30" r="26" stroke="rgba(255,255,255,0.22)" stroke-width="1.5"/>',
			'<path d="M30 16a14 14 0 1014 14 14 14 0 00-14-14zm1.2 7v7.4l5 3-.95 1.56-6.05-3.62V23h2z" fill="white"/>',
			'</svg></div>',
			'<div id="wt-btn-label" style="margin-top:6px;background:#fff;color:#1a1a1a;border:1px solid rgba(71,5,251,0.12);box-shadow:0 8px 24px rgba(71,5,251,0.14);font-size:11px;font-weight:800;padding:5px 10px;border-radius:999px;white-space:nowrap;line-height:1.2;">\u0410\u043A\u0446\u0438\u044F</div>'
		].join('')),
		(l.style.cssText = [
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
		document.body.appendChild(l));
	var h = document.createElement('style');
	((h.id = 'timer-widget-style'),
		(h.textContent = [
			'@keyframes wtBounce{0%,100%{transform:translateY(0) scale(1)}10%{transform:translateY(-16px) scale(1.1)}20%{transform:translateY(0) scale(1)}30%{transform:translateY(-6px) scale(1.04)}40%{transform:translateY(0) scale(1)}}',
			'@keyframes wtSway{0%,100%{transform:rotate(0)}25%{transform:rotate(-6deg)}75%{transform:rotate(6deg)}}',
			'@keyframes wtGlow{0%,100%{filter:drop-shadow(0 6px 16px rgba(0,0,0,0.35)) drop-shadow(0 2px 4px rgba(0,0,0,0.2))}50%{filter:drop-shadow(0 8px 28px rgba(101,16,255,0.7)) drop-shadow(0 2px 12px rgba(37,117,252,0.5))}}',
			'@keyframes wtRipple{0%{transform:scale(1);opacity:.55}100%{transform:scale(2.15);opacity:0}}',
			'#wt-ring-1,#wt-ring-2{display:none}',
			'#wt-bubble:hover{opacity:0.95!important}',
			'#wt-bubble-close:hover{color:#888!important}',
			'.wt-input-error{border-color:#ef4444!important;box-shadow:0 0 0 3px rgba(239,68,68,.12)!important}',
			'@media(max-width:480px){#timer-widget-overlay{padding:12px!important}#wt-modal{padding:22px 16px 18px!important;border-radius:18px!important}.wt-time-value{font-size:24px!important}.wt-time-box{padding:10px 6px!important}#wt-bubble{display:none!important}}'
		].join('')),
		document.head.appendChild(h));
	var R = !1,
		q = !0,
		K = !1;
	function B() {
		R ||
			((R = !0),
			(l.style.animation = [
				'wtBounce 3s ease-in-out infinite',
				'wtSway 4s ease-in-out infinite',
				q ? 'wtGlow 2.5s ease-in-out infinite' : ''
			]
				.filter(Boolean)
				.join(',')));
	}
	function Z() {
		((R = !1), (l.style.animation = 'none'));
	}
	(setTimeout(B, 4e3),
		window.addEventListener(
			'scroll',
			function () {
				K ||
					((K = !0),
					l.animate(
						[
							{ transform: 'translateY(0) rotate(0deg)' },
							{ transform: 'translateY(-250px) rotate(-6deg)' },
							{ transform: 'translateY(0) rotate(0deg)' }
						],
						{ duration: 2300, easing: 'cubic-bezier(.34,1.56,.64,1)' }
					),
					B());
			},
			{ passive: !0 }
		));
	var C = document.createElement('div');
	((C.id = 'timer-widget-host'), document.body.appendChild(C));
	var G = C.attachShadow({ mode: 'open' }),
		V = document.createElement('style');
	((V.textContent = h.textContent), G.appendChild(V));
	var w = document.createElement('div');
	((w.id = 'timer-widget-overlay'),
		(w.style.cssText =
			'position:fixed;inset:0;z-index:10000;display:none;align-items:center;justify-content:center;padding:16px;box-sizing:border-box'));
	var A = document.createElement('div');
	((A.style.cssText =
		'position:absolute;inset:0;background:rgba(8,4,20,0.85);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);touch-action:none;'),
		w.appendChild(A));
	var o = document.createElement('div');
	((o.id = 'wt-modal'),
		(o.style.cssText = [
			'position:relative',
			'z-index:1',
			'width:100%',
			'max-width:440px',
			'background:#fff',
			'border-radius:22px',
			'padding:28px 24px 22px',
			'box-sizing:border-box',
			'box-shadow:0 28px 80px rgba(0,0,0,.28)',
			'font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
			'transform:translateY(28px)',
			'opacity:0',
			'transition:transform .3s cubic-bezier(.22,1,.36,1),opacity .25s ease',
			'overflow:hidden'
		].join(';')),
		w.appendChild(o),
		G.appendChild(w));
	function ue() {
		var r, a;
		var t = i.buttonSize || 60,
			e = i.buttonSide === 'left' ? 'left' : 'right';
		((l.style[e] = ((r = i.buttonOffset) != null ? r : 3) + '%'),
			(l.style[e === 'left' ? 'right' : 'left'] = 'auto'),
			(l.style.bottom = ((a = i.buttonBottom) != null ? a : 3) + '%'));
		var n = l.querySelector('svg');
		n && (n.setAttribute('width', t), n.setAttribute('height', t));
	}
	function ce(t) {
		var e = document.getElementById('wt-bubble'),
			n = document.getElementById('wt-bubble-tail');
		!e ||
			!n ||
			(t === 'left'
				? ((e.style.left = 'calc(100% + 14px)'),
					(e.style.right = 'auto'),
					(n.style.left = '-8px'),
					(n.style.right = 'auto'),
					(n.style.borderLeft = 'none'),
					(n.style.borderRight = '8px solid #fff'))
				: ((e.style.right = 'calc(100% + 14px)'),
					(e.style.left = 'auto'),
					(n.style.right = '-8px'),
					(n.style.left = 'auto'),
					(n.style.borderRight = 'none'),
					(n.style.borderLeft = '8px solid #fff')));
	}
	function M() {
		var t = document.getElementById('wt-bubble');
		!t ||
			t.style.display === 'none' ||
			((t.style.opacity = '0'),
			(t.style.transform = 'translateY(-50%) scale(0.85)'),
			setTimeout(function () {
				t.style.display = 'none';
			}, 300));
	}
	function fe(t) {
		q = i.buttonPulse !== !1;
		var e = l.querySelector('circle');
		e && t && e.setAttribute('fill', t);
		var n = l.querySelector('#wt-btn-icon');
		(n &&
			t &&
			(n.style.filter =
				'drop-shadow(0 6px 24px ' +
				t +
				'66) drop-shadow(0 2px 8px rgba(0,0,0,.22))'),
			['wt-ring-1', 'wt-ring-2'].forEach(function (r) {
				var a = document.getElementById(r);
				a && (a.style.display = i.buttonPulse === !1 ? 'none' : '');
			}));
	}
	function be() {
		if (!i) return new Date(Date.now() + 900 * 1e3);
		if (i.timerMode === 'FIXED_DATE' && i.deadlineAt) {
			var t = new Date(i.deadlineAt);
			if (!isNaN(t.getTime())) return t;
		}
		var e = Math.max(1, Number(i.evergreenDurationMinutes) || 15),
			n = 'wintimer_deadline_' + f + '_' + (i.timerResetToken || '');
		try {
			var r = localStorage.getItem(n);
			if (r) {
				var a = new Date(r);
				if (!isNaN(a.getTime())) return a;
			}
			var s = new Date(Date.now() + e * 60 * 1e3);
			return (localStorage.setItem(n, s.toISOString()), s);
		} catch (c) {
			return new Date(Date.now() + e * 60 * 1e3);
		}
	}
	function $() {
		return 'wintimer_submitted_' + f + '_' + (i.timerResetToken || '');
	}
	function ge() {
		if (!(!i || i.filterDuplicates !== !0 || i.dataType === 'NONE'))
			try {
				localStorage.setItem($(), Date.now().toString());
			} catch (t) {}
	}
	function me() {
		if (!i || i.filterDuplicates !== !0 || i.dataType === 'NONE')
			return !1;
		try {
			var t = localStorage.getItem($());
			if (!t) return !1;
			var e = parseInt(t, 10);
			if (!e) return !1;
			var n = (Number(i.submissionCooldownDays) || 0) * 24 * 60 * 60 * 1e3;
			return n === 0 || Date.now() - e < n;
		} catch (r) {
			return !1;
		}
	}
	function J() {
		return (
			i &&
			i.filterDuplicates === !0 &&
			i.dataType !== 'NONE' &&
			(i.hasSubmittedByIp === !0 || me())
		);
	}
	function z() {
		return O ? Math.max(0, O.getTime() - Date.now()) : 0;
	}
	function xe(t) {
		var e = Math.floor(t / 1e3),
			n = Math.floor(e / 86400);
		e -= n * 86400;
		var r = Math.floor(e / 3600);
		e -= r * 3600;
		var a = Math.floor(e / 60);
		return { days: n, hours: r, minutes: a, seconds: e - a * 60 };
	}
	function P(t) {
		return t < 10 ? '0' + t : String(t);
	}
	function L() {
		var t = z(),
			e = xe(t);
		['days', 'hours', 'minutes', 'seconds'].forEach(function (r) {
			var a = o.querySelector('[data-wt-time="' + r + '"]');
			a && (a.textContent = r === 'days' ? String(e[r]) : P(e[r]));
		});
		var n = document.getElementById('wt-btn-label');
		if (
			(n &&
				(n.textContent =
					t <= 0
						? i.expiredTitle ||
							'\u0410\u043A\u0446\u0438\u044F \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0430'
						: (i.bubbleText || '\u0410\u043A\u0446\u0438\u044F') +
							': ' +
							(e.days > 0 ? e.days + '\u0434 ' : '') +
							P(e.hours) +
							':' +
							P(e.minutes)),
			t <= 0)
		) {
			if (i.expiredBehavior === 'hide') {
				((l.style.display = 'none'), y());
				return;
			}
			u && Y();
		}
	}
	function he() {
		(m && clearInterval(m), L(), (m = setInterval(L, 1e3)));
	}
	function H() {
		var t = d(
			'button',
			{
				position: 'absolute',
				top: '12px',
				right: '14px',
				width: '32px',
				height: '32px',
				border: 'none',
				borderRadius: '50%',
				background: 'rgba(71,5,251,.08)',
				color: '#7b3fa0',
				fontSize: '20px',
				lineHeight: '1',
				cursor: 'pointer'
			},
			'&times;'
		);
		return (v && (t.style.display = 'none'), (t.onclick = y), t);
	}
	function N() {
		var t = d('div', {
			textAlign: 'center',
			fontSize: '11px',
			color: '#bbb',
			marginTop: '12px',
			lineHeight: '1.5'
		});
		return (
			(t.innerHTML =
				'\u0420\u0430\u0431\u043E\u0442\u0430\u0435\u0442 \u043D\u0430 <a href="https://winwidget.ru" target="_blank" style="color:#999;text-decoration:none;font-weight:700">Winwidget</a>'),
			t
		);
	}
	function we() {
		var t = d('div', {
			display: 'grid',
			gridTemplateColumns: 'repeat(4,1fr)',
			gap: '8px',
			margin: '18px 0 18px'
		});
		return (
			[
				['days', '\u0434\u043D\u0438'],
				['hours', '\u0447\u0430\u0441\u044B'],
				['minutes', '\u043C\u0438\u043D'],
				['seconds', '\u0441\u0435\u043A']
			].forEach(function (e) {
				var n = d('div', {
					borderRadius: '14px',
					background: 'linear-gradient(180deg,#f8f5ff,#fff)',
					border: '1px solid #e0d6f0',
					padding: '12px 8px',
					textAlign: 'center'
				});
				n.className = 'wt-time-box';
				var r = d('div', {
					fontSize: '28px',
					fontWeight: '850',
					color: i.color || '#4705fb',
					lineHeight: '1',
					fontVariantNumeric: 'tabular-nums'
				});
				((r.className = 'wt-time-value'),
					r.setAttribute('data-wt-time', e[0]),
					(r.textContent = '00'));
				var a = d('div', {
					marginTop: '6px',
					fontSize: '10px',
					color: '#999',
					textTransform: 'uppercase',
					letterSpacing: '.05em'
				});
				((a.textContent = e[1]),
					n.appendChild(r),
					n.appendChild(a),
					t.appendChild(n));
			}),
			t
		);
	}
	function W(t) {
		if (!i.actionButtonUrl) return null;
		var e = d('a', {
			display: 'inline-flex',
			alignItems: 'center',
			justifyContent: 'center',
			width: t ? '100%' : 'auto',
			minHeight: '48px',
			padding: '0 18px',
			borderRadius: '12px',
			background: i.buttonColor || i.color || '#4705fb',
			color: '#fff',
			fontSize: '15px',
			fontWeight: '750',
			textDecoration: 'none',
			boxSizing: 'border-box',
			boxShadow: '0 8px 22px rgba(71,5,251,.22)'
		});
		return (
			(e.href = i.actionButtonUrl),
			(e.target = '_blank'),
			(e.rel = 'noopener noreferrer'),
			(e.textContent =
				i.actionButtonText ||
				'\u041F\u0435\u0440\u0435\u0439\u0442\u0438 \u043A \u0430\u043A\u0446\u0438\u0438'),
			(e.onclick = function () {
				D('action');
			}),
			e
		);
	}
	function X() {
		((o.innerHTML = ''), o.appendChild(H()));
		var t = d('div', {
			display: 'inline-flex',
			alignSelf: 'center',
			padding: '5px 10px',
			borderRadius: '999px',
			background: (i.color || '#4705fb') + '12',
			color: i.color || '#4705fb',
			fontSize: '11px',
			fontWeight: '800',
			letterSpacing: '.06em',
			textTransform: 'uppercase',
			marginBottom: '12px'
		});
		((t.textContent = g(i.bubbleText, '\u0410\u043A\u0446\u0438\u044F')),
			o.appendChild(t));
		var e = d('h2', {
			margin: '0 22px 8px',
			fontSize: '24px',
			lineHeight: '1.2',
			textAlign: 'center',
			color: '#1a1a1a',
			fontWeight: '800'
		});
		if (
			((e.textContent = g(
				i.title,
				'\u0421\u043A\u0438\u0434\u043A\u0430 \u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0435\u043D\u0430 \u043F\u043E \u0432\u0440\u0435\u043C\u0435\u043D\u0438'
			)),
			o.appendChild(e),
			i.subtitle)
		) {
			var n = d('p', {
				margin: '0 auto',
				fontSize: '14px',
				color: '#777',
				textAlign: 'center',
				lineHeight: '1.5',
				maxWidth: '340px'
			});
			((n.textContent = i.subtitle), o.appendChild(n));
		}
		if ((o.appendChild(we()), i.dataType === 'NONE')) {
			var r = W(!0);
			(r && o.appendChild(r), o.appendChild(N()), L());
			return;
		}
		if (J()) {
			I();
			return;
		}
		(ye(), L());
	}
	function ye() {
		var t = d('p', {
			margin: '0 0 10px',
			fontSize: '14px',
			fontWeight: '700',
			color: '#1a1a1a',
			textAlign: 'center',
			lineHeight: '1.4'
		});
		((t.textContent = g(
			i.contactTitle,
			'\u041E\u0441\u0442\u0430\u0432\u044C\u0442\u0435 \u043A\u043E\u043D\u0442\u0430\u043A\u0442, \u0447\u0442\u043E\u0431\u044B \u043F\u043E\u043B\u0443\u0447\u0438\u0442\u044C \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u0435\u043D\u0438\u0435'
		)),
			o.appendChild(t));
		var e = d('div', {
				display: 'flex',
				flexDirection: 'column',
				gap: '10px'
			}),
			n = null,
			r = null,
			a = null;
		function s(T, E) {
			var p = d('input', {
				width: '100%',
				height: '48px',
				border: '1px solid #e0d6f0',
				borderRadius: '12px',
				background: '#f8f5ff',
				padding: '0 14px',
				fontSize: '15px',
				color: '#1a1a1a',
				outline: 'none',
				boxSizing: 'border-box'
			});
			return (
				(p.type = T),
				(p.placeholder = E),
				(p.onfocus = function () {
					((p.style.borderColor = i.color || '#4705fb'),
						(p.style.boxShadow =
							'0 0 0 3px ' + (i.color || '#4705fb') + '22'));
				}),
				(p.onblur = function () {
					((p.style.borderColor = '#e0d6f0'),
						(p.style.boxShadow = 'none'));
				}),
				p
			);
		}
		((i.dataType === 'PHONE' || i.dataType === 'PHONE_AND_EMAIL') &&
			((n = s('tel', '+7 999 123-45-67')),
			window.winwidgetPhone &&
				(a = window.winwidgetPhone.attach(n, {
					placeholder: '+7 999 123-45-67',
					onChange: function () {
						n.classList.remove('wt-input-error');
					}
				})),
			n.addEventListener('input', function () {
				n.classList.remove('wt-input-error');
			}),
			e.appendChild(n)),
			(i.dataType === 'EMAIL' || i.dataType === 'PHONE_AND_EMAIL') &&
				((r = s('email', 'Email')),
				r.addEventListener('input', function () {
					r.classList.remove('wt-input-error');
				}),
				e.appendChild(r)));
		var c = d('button', {
			width: '100%',
			height: '50px',
			border: 'none',
			borderRadius: '12px',
			background: i.buttonColor || i.color || '#4705fb',
			color: '#fff',
			fontSize: '15px',
			fontWeight: '750',
			cursor: 'pointer',
			boxShadow: '0 8px 22px rgba(71,5,251,.22)'
		});
		if (
			((c.textContent = g(
				i.submitButtonText,
				'\u041F\u043E\u043B\u0443\u0447\u0438\u0442\u044C \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u0435\u043D\u0438\u0435'
			)),
			e.appendChild(c),
			i.privacyUrl)
		) {
			var re = d('p', {
				margin: '0',
				fontSize: '11px',
				color: '#aaa',
				textAlign: 'center',
				lineHeight: '1.45'
			});
			((re.innerHTML =
				'\u041D\u0430\u0436\u0438\u043C\u0430\u044F \u043A\u043D\u043E\u043F\u043A\u0443, \u0432\u044B \u0441\u043E\u0433\u043B\u0430\u0448\u0430\u0435\u0442\u0435\u0441\u044C \u0441 <a href="' +
				i.privacyUrl +
				'" target="_blank" style="color:#999">\u043F\u043E\u043B\u0438\u0442\u0438\u043A\u043E\u0439 \u043A\u043E\u043D\u0444\u0438\u0434\u0435\u043D\u0446\u0438\u0430\u043B\u044C\u043D\u043E\u0441\u0442\u0438</a>'),
				e.appendChild(re));
		}
		var j = !1;
		((c.onclick = function () {
			if (!j) {
				var T = '',
					E = '',
					p = !0;
				(n &&
					((T = a ? a.getNumber() : null),
					T || (n.classList.add('wt-input-error'), (p = !1))),
					r &&
						((E = r.value.trim()),
						/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(E) ||
							(r.classList.add('wt-input-error'), (p = !1))),
					p &&
						((j = !0),
						(c.disabled = !0),
						(c.style.opacity = '.65'),
						(c.textContent =
							'\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u0435\u043C...'),
						fetch(F + '/countdown-timer/' + f + '/lead', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								phone: T || void 0,
								email: E || void 0,
								url: window.location.href
							})
						})
							.then(function (oe) {
								if (!oe.ok) throw new Error('submit failed');
								return oe.json();
							})
							.then(function () {
								((k = !0), ge(), D('submit'), I());
							})
							.catch(function () {
								((j = !1),
									(c.disabled = !1),
									(c.style.opacity = '1'),
									(c.textContent = g(
										i.submitButtonText,
										'\u041F\u043E\u043B\u0443\u0447\u0438\u0442\u044C \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u0435\u043D\u0438\u0435'
									)));
							})));
			}
		}),
			o.appendChild(e),
			o.appendChild(N()));
	}
	function I() {
		((o.innerHTML = ''), o.appendChild(H()));
		var t = d('div', {
			width: '60px',
			height: '60px',
			borderRadius: '50%',
			background: (i.color || '#4705fb') + '12',
			color: i.color || '#4705fb',
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			margin: '8px auto 16px',
			fontSize: '30px',
			fontWeight: '800'
		});
		((t.textContent = '\u2713'), o.appendChild(t));
		var e = d('h2', {
			margin: '0 0 8px',
			fontSize: '22px',
			fontWeight: '800',
			color: '#1a1a1a',
			textAlign: 'center'
		});
		if (
			((e.textContent = g(
				i.successTitle,
				'\u0421\u043F\u0430\u0441\u0438\u0431\u043E! \u0417\u0430\u044F\u0432\u043A\u0430 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0430'
			)),
			o.appendChild(e),
			i.successSubtitle)
		) {
			var n = d('p', {
				margin: '0 0 16px',
				fontSize: '14px',
				color: '#777',
				textAlign: 'center',
				lineHeight: '1.5'
			});
			((n.textContent = i.successSubtitle), o.appendChild(n));
		}
		var r = W(!0);
		(r && o.appendChild(r), o.appendChild(N()));
	}
	function Y() {
		((o.innerHTML = ''), o.appendChild(H()));
		var t = d('div', {
			width: '60px',
			height: '60px',
			borderRadius: '50%',
			background: '#f3f4f6',
			color: '#6b7280',
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			margin: '8px auto 16px',
			fontSize: '28px'
		});
		((t.textContent = '00'), o.appendChild(t));
		var e = d('h2', {
			margin: '0 0 8px',
			fontSize: '22px',
			fontWeight: '800',
			color: '#1a1a1a',
			textAlign: 'center'
		});
		if (
			((e.textContent = g(
				i.expiredTitle,
				'\u0410\u043A\u0446\u0438\u044F \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0430'
			)),
			o.appendChild(e),
			i.expiredSubtitle)
		) {
			var n = d('p', {
				margin: '0',
				fontSize: '14px',
				color: '#777',
				textAlign: 'center',
				lineHeight: '1.5'
			});
			((n.textContent = i.expiredSubtitle), o.appendChild(n));
		}
		if (i.expiredBehavior === 'disableForm') {
			var r = W(!0);
			r && ((r.style.marginTop = '16px'), o.appendChild(r));
		}
		o.appendChild(N());
	}
	function S() {
		!i ||
			u ||
			((u = !0),
			(l.style.opacity = '0'),
			(l.style.pointerEvents = 'none'),
			(l.style.transform = 'scale(0.8)'),
			Z(),
			(w.style.display = 'flex'),
			z() <= 0 && i.expiredBehavior !== 'disableForm'
				? Y()
				: k && i.dataType !== 'NONE'
					? I()
					: X(),
			requestAnimationFrame(function () {
				requestAnimationFrame(function () {
					((o.style.transform = 'translateY(0)'), (o.style.opacity = '1'));
				});
			}),
			D('open'));
	}
	function y() {
		u &&
			((u = !1),
			(l.style.opacity = '1'),
			(l.style.pointerEvents = 'auto'),
			(l.style.transform = 'scale(1)'),
			B(),
			(o.style.transform = 'translateY(28px)'),
			(o.style.opacity = '0'),
			setTimeout(function () {
				u || (w.style.display = 'none');
			}, 280),
			D('close'));
	}
	function D(t) {
		try {
			document.dispatchEvent(new CustomEvent('winwidget:timer:' + t));
		} catch (e) {}
	}
	function Q() {
		(M(), u ? y() : S());
	}
	function ee() {
		v || y();
	}
	function ve(t) {
		((t = t || {}),
			ue(),
			fe(i.openButtonColor || i.color || '#4705fb'),
			(l.style.display = v ? 'none' : 'flex'),
			(o.style.background = i.bgColor || '#fff'));
		var e = document.getElementById('wt-btn-label');
		(e &&
			(e.textContent = i.bubbleText || '\u0410\u043A\u0446\u0438\u044F'),
			ce(i.buttonSide || 'right'));
		var n = document.getElementById('wt-bubble-close'),
			r = document.getElementById('wt-bubble'),
			a = document.getElementById('wt-bubble-text');
		if (
			(a &&
				(a.textContent =
					i.bubbleText || '\u0410\u043A\u0446\u0438\u044F!'),
			r && i.bubbleEnabled === !1 && (r.style.display = 'none'),
			n &&
				n.addEventListener('click', function (s) {
					(s.stopPropagation(), M());
				}),
			r &&
				r.addEventListener('click', function (s) {
					(s.stopPropagation(), M(), S());
				}),
			!v &&
				i.bubbleEnabled !== !1 &&
				setTimeout(function () {
					var s = document.getElementById('wt-bubble');
					!s ||
						u ||
						((s.style.display = 'block'),
						requestAnimationFrame(function () {
							requestAnimationFrame(function () {
								((s.style.opacity = '1'),
									(s.style.transform = 'translateY(-50%) scale(1)'));
							});
						}));
				}, 2e3),
			!v && !u && (Z(), B()),
			he(),
			z() <= 0 && i.expiredBehavior === 'hide')
		) {
			((l.style.display = 'none'), y());
			return;
		}
		(u &&
			(z() <= 0 && i.expiredBehavior !== 'disableForm'
				? Y()
				: k && i.dataType !== 'NONE'
					? I()
					: X(),
			(o.style.transform = 'translateY(0)'),
			(o.style.opacity = '1')),
			x && clearTimeout(x),
			t.initial &&
				i.autoOpenDelay &&
				i.autoOpenDelay > 0 &&
				(x = setTimeout(function () {
					u || S();
				}, i.autoOpenDelay * 1e3)),
			v && !u && S());
	}
	function te(t) {
		return Promise.all([de(), fetch(pe(), { cache: 'no-store' })])
			.then(function (e) {
				var n = e[1];
				return n.ok
					? n.json()
					: (console.warn(
							'[wintimer] Widget not found or inactive (' + n.status + ')'
						),
						null);
			})
			.then(function (e) {
				if (e !== null) {
					if (!e || !e.isActive) {
						(console.warn('[wintimer] Widget is inactive'),
							m && clearInterval(m),
							x && clearTimeout(x),
							(i = null),
							(l.style.display = 'none'),
							y());
						return;
					}
					((i = e),
						(k = i.dataType === 'NONE' ? !1 : J()),
						(O = be()),
						ve(t));
				}
			})
			.catch(function (e) {
				console.error('[wintimer] Failed to load config:', e);
			});
	}
	function U() {
		return te({ refresh: !0 });
	}
	function ne(t) {
		(!t.detail || !t.detail.key || t.detail.key === f) && U();
	}
	function ie(t) {
		t.key === 'winwidget:timer:' + f + ':updated' && U();
	}
	function Ce() {
		(m && clearInterval(m),
			x && clearTimeout(x),
			l.removeEventListener('click', Q),
			A.removeEventListener('click', ee),
			window.removeEventListener('winwidget:timer:updated', ne),
			window.removeEventListener('storage', ie),
			l.parentNode && l.parentNode.removeChild(l),
			C.parentNode && C.parentNode.removeChild(C),
			h.parentNode && h.parentNode.removeChild(h),
			delete window.__wintimerScriptRunning,
			window.winwidgetTimer &&
				window.winwidgetTimer.key === f &&
				delete window.winwidgetTimer);
	}
	(l.addEventListener('click', Q),
		A.addEventListener('click', ee),
		window.addEventListener('winwidget:timer:updated', ne),
		window.addEventListener('storage', ie),
		(window.winwidgetTimer = {
			key: f,
			open: S,
			close: y,
			refresh: U,
			destroy: Ce
		}),
		te({ initial: !0 }));
})();
