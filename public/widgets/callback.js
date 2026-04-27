(function () {
	'use strict';
	if (window.__wincallbackScriptRunning) return;
	window.__wincallbackScriptRunning = !0;
	var h = document.currentScript,
		O = (function () {
			try {
				var e = new URL(h && h.src ? h.src : location.href);
				return e.origin + '/api';
			} catch (t) {
				return 'https://winwidget.ru/api';
			}
		})(),
		T = (h && h.getAttribute('data-key')) || '';
	if (!T) return;
	function V(e) {
		try {
			var t = new URL(h && h.src ? h.src : location.href);
			return (
				(t.pathname = t.pathname.replace(/\/[^/]*$/, '/' + e)),
				(t.search = ''),
				(t.hash = ''),
				t.toString()
			);
		} catch (n) {
			return 'https://winwidget.ru/widgets/' + e;
		}
	}
	function $(e) {
		return new Promise(function (t, n) {
			var o = document.querySelector('script[src="' + e + '"]');
			if (o) {
				(o.addEventListener('load', t, { once: !0 }),
					o.addEventListener('error', n, { once: !0 }),
					window.winwidgetPhone && t());
				return;
			}
			var r = document.createElement('script');
			((r.src = e),
				(r.async = !0),
				(r.onload = function () {
					t();
				}),
				(r.onerror = n),
				document.head.appendChild(r));
		});
	}
	function J() {
		return window.winwidgetPhone
			? window.winwidgetPhone.load()
			: $(V('helpers/winwidget-phone.js'))
					.then(function () {
						return window.winwidgetPhone
							? window.winwidgetPhone.load()
							: null;
					})
					.catch(function (e) {
						return (
							console.warn(
								'[wincallback] Failed to load phone formatter:',
								e
							),
							null
						);
					});
	}
	var m = !!(
			window.wincallbackAutoOpen ||
			window.winwidgetCallbackAutoOpen ||
			(window.winwidget && window.winwidget.autoOpen)
		),
		C = {
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
	function le(e, t) {
		var n = e.replace(/\D/g, '');
		((t === C.RU || t === C.KZ) &&
			(n.startsWith('8') && (n = '7' + n.slice(1)),
			n.startsWith('7') && (n = n.slice(1))),
			t === C.BY && n.startsWith('375') && (n = n.slice(3)),
			t === C.UA && n.startsWith('380') && (n = n.slice(3)),
			t === C.UZ && n.startsWith('998') && (n = n.slice(3)));
		var o = t.mask,
			r = 0;
		return (
			(o = o.replace(/#/g, function () {
				return r < n.length ? n[r++] : '_';
			})),
			o
		);
	}
	function Q(e, t) {
		var n = t.mask.split('#')[0],
			o = n.replace(/\D/g, ''),
			r = e.replace(/\D/g, '');
		return (
			r.startsWith(o) && (r = r.slice(o.length)),
			r.replace(/_/g, '')
		);
	}
	function se(e, t) {
		return Q(e, t).length >= t.digits;
	}
	var i = null,
		f = !1,
		U = !1,
		s = document.createElement('div');
	((s.id = 'callback-widget-button'),
		(s.innerHTML = [
			'<div id="wcb-bubble" style="',
			'display:none;position:absolute;top:50%;transform:translateY(-50%) scale(0.85);',
			'background:#fff;border-radius:18px;padding:12px 34px 12px 16px;',
			'width:172px;box-sizing:border-box;',
			'border:1px solid rgba(71,5,251,0.12);',
			'box-shadow:0 16px 40px rgba(71,5,251,0.18),0 8px 18px rgba(15,23,42,0.08);',
			'cursor:pointer;opacity:0;',
			'transition:opacity 0.3s ease,transform 0.35s cubic-bezier(.22,1,.36,1);',
			'font-family:system-ui,-apple-system,sans-serif;',
			'">',
			'<button id="wcb-bubble-close" style="',
			'position:absolute;top:7px;right:8px;background:none;border:none;',
			'font-size:11px;cursor:pointer;color:#ccc;line-height:1;padding:2px;',
			'display:flex;align-items:center;justify-content:center;',
			'width:16px;height:16px;border-radius:50%;',
			'">\u2715</button>',
			'<p id="wcb-bubble-text" style="',
			'margin:0;font-size:13px;font-weight:600;color:#1a1a1a;line-height:1.4;',
			'"></p>',
			'<span style="position:absolute;left:12px;top:-6px;width:12px;height:12px;border-radius:50%;background:#22c55e;border:2px solid #fff;box-shadow:0 0 0 4px rgba(34,197,94,.14);"></span>',
			'<div id="wcb-bubble-tail" style="',
			'position:absolute;top:50%;transform:translateY(-50%);',
			'width:0;height:0;',
			'border-top:7px solid transparent;border-bottom:7px solid transparent;',
			'"></div>',
			'</div>',
			'<div id="wcb-btn-icon" style="',
			'filter:drop-shadow(0 6px 24px rgba(71,5,251,0.6)) drop-shadow(0 2px 8px rgba(0,0,0,0.25));',
			'transition:filter 0.4s ease,transform 0.2s cubic-bezier(.34,1.56,.64,1);',
			'position:relative;',
			'">',
			'<div id="wcb-ring-1" style="position:absolute;inset:0;border-radius:50%;pointer-events:none;background:rgba(71,5,251,0.35);"></div>',
			'<div id="wcb-ring-2" style="position:absolute;inset:0;border-radius:50%;pointer-events:none;background:rgba(71,5,251,0.25);"></div>',
			'<div id="wcb-ring-3" style="position:absolute;inset:0;border-radius:50%;pointer-events:none;background:rgba(71,5,251,0.15);"></div>',
			'<svg width="60" height="60" viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg" style="position:relative;z-index:1;display:block">',
			'<circle cx="30" cy="30" r="30" fill="url(#wcbGrad)"/>',
			'<circle cx="30" cy="30" r="27" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="1.5"/>',
			'<path d="M21 19.5c0-.83.67-1.5 1.5-1.5h3.1c.4 0 .77.24.9.6l1.4 4c.14.38.03.82-.28 1.1l-1.62 1.62c1.15 2.38 3.08 4.3 5.46 5.46l1.62-1.62c.28-.3.72-.42 1.1-.28l4 1.4c.36.13.6.5.6.9V34c0 .83-.67 1.5-1.5 1.5C28.27 35.5 21 28.23 21 19.5z" fill="white" opacity="0.95"/>',
			'<defs>',
			'<linearGradient id="wcbGrad" x1="0" y1="0" x2="60" y2="60" gradientUnits="userSpaceOnUse">',
			'<stop offset="0%" stop-color="#9333ea"/>',
			'<stop offset="100%" stop-color="#4705fb"/>',
			'</linearGradient>',
			'</defs>',
			'</svg>',
			'</div>',
			''
		].join('')),
		(s.style.cssText = [
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
		document.body.appendChild(s));
	var y = document.createElement('style');
	((y.textContent = [
		'@keyframes wcbBounce{0%,100%{transform:translateY(0) scale(1)}10%{transform:translateY(-16px) scale(1.1)}20%{transform:translateY(0) scale(1)}30%{transform:translateY(-6px) scale(1.04)}40%{transform:translateY(0) scale(1)}}',
		'@keyframes wcbSway{0%,100%{transform:rotate(0)}25%{transform:rotate(-6deg)}75%{transform:rotate(6deg)}}',
		'@keyframes wcbGlow{0%,100%{filter:drop-shadow(0 6px 16px rgba(0,0,0,0.35)) drop-shadow(0 2px 4px rgba(0,0,0,0.2))}50%{filter:drop-shadow(0 8px 28px rgba(101,16,255,0.7)) drop-shadow(0 2px 12px rgba(37,117,252,0.5))}}',
		'@keyframes wcbRipple{0%{transform:scale(1);opacity:0.55}100%{transform:scale(2.4);opacity:0}}',
		'@keyframes wcbShake{0%,100%{transform:translateX(0)}12%{transform:translateX(-5px)}25%{transform:translateX(5px)}37%{transform:translateX(-4px)}50%{transform:translateX(4px)}62%{transform:translateX(-2px)}75%{transform:translateX(2px)}87%{transform:translateX(-1px)}}',
		'.wcb-field-err{border-color:#ef4444!important;box-shadow:0 0 0 3px rgba(239,68,68,0.15)!important}',
		'.wcb-shake{animation:wcbShake 420ms ease}',
		'.wcb-err-text{color:#ef4444;font-size:11px;margin-top:5px;display:none;padding-left:2px}',
		'.wcb-err-text.wcb-err-show{display:block}',
		'#wcb-ring-1,#wcb-ring-2,#wcb-ring-3{display:none}',
		'#wcb-bubble:hover{opacity:0.95!important}',
		'#wcb-bubble-close:hover{color:#888!important}',
		'#callback-widget-overlay{align-items:center!important}',
		'@media(max-width:480px){',
		'#callback-widget-overlay{padding:12px!important}',
		'#wcb-modal{padding:20px 16px 20px!important}',
		'#wcb-bubble{display:none!important}',
		'}',
		'#wcb-brand{text-align:center;font-size:11px;color:#ccc;margin-top:8px;line-height:1.5}',
		'#wcb-brand a{color:#bbb;text-decoration:none;font-weight:600}',
		'#wcb-brand a:hover{color:#888}'
	].join('')),
		document.head.appendChild(y));
	var I = !1,
		j = !0,
		W = !1;
	function z() {
		I ||
			((I = !0),
			(s.style.animation = [
				'wcbBounce 3s ease-in-out infinite',
				'wcbSway 4s ease-in-out infinite',
				j ? 'wcbGlow 2.5s ease-in-out infinite' : ''
			]
				.filter(Boolean)
				.join(',')));
	}
	function H() {
		((I = !1), (s.style.animation = 'none'));
	}
	(setTimeout(z, 4e3),
		window.addEventListener(
			'scroll',
			function () {
				W ||
					((W = !0),
					s.animate(
						[
							{ transform: 'translateY(0) rotate(0deg)' },
							{ transform: 'translateY(-250px) rotate(-6deg)' },
							{ transform: 'translateY(0) rotate(0deg)' }
						],
						{ duration: 2300, easing: 'cubic-bezier(.34,1.56,.64,1)' }
					),
					z());
			},
			{ passive: !0 }
		));
	var v = document.createElement('div');
	((v.id = 'callback-widget-host'), document.body.appendChild(v));
	var F = v.attachShadow({ mode: 'open' }),
		N = document.createElement('style');
	((N.textContent = y.textContent), F.appendChild(N));
	var x = document.createElement('div');
	((x.id = 'callback-widget-overlay'),
		(x.style.cssText = [
			'position:fixed',
			'inset:0',
			'z-index:10000',
			'display:none',
			'align-items:center',
			'justify-content:center',
			'padding:16px',
			'box-sizing:border-box'
		].join(';')));
	var P = document.createElement('div');
	((P.style.cssText =
		'position:absolute;inset:0;background:rgba(8,4,20,0.85);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);touch-action:none;'),
		x.appendChild(P));
	var a = document.createElement('div');
	((a.id = 'wcb-modal'),
		(a.style.cssText = [
			'position:relative',
			'width:100%',
			'max-width:400px',
			'background:#fff',
			'border-radius:20px',
			'padding:28px 24px 24px',
			'box-sizing:border-box',
			'box-shadow:0 24px 80px rgba(0,0,0,0.22)',
			'font-family:system-ui,-apple-system,sans-serif',
			'max-height:calc(100svh - 48px)',
			'overflow-y:auto',
			'-webkit-overflow-scrolling:touch',
			'transform:translateY(40px)',
			'opacity:0',
			'transition:transform 380ms cubic-bezier(.22,1,.36,1),opacity 280ms ease'
		].join(';')),
		x.appendChild(a),
		F.appendChild(x));
	function R(e, t) {
		Object.keys(t).forEach(function (n) {
			e.style[n] = t[n];
		});
	}
	function u(e, t, n) {
		var o = document.createElement(e);
		return (t && R(o, t), n && (o.innerHTML = n), o);
	}
	function ee(e) {
		(e.classList.remove('wcb-shake'),
			e.offsetWidth,
			e.classList.add('wcb-shake'),
			setTimeout(function () {
				e.classList.remove('wcb-shake');
			}, 450));
	}
	function te() {
		if (i) {
			var e = i.buttonSide === 'left' ? 'left' : 'right',
				t = e === 'left' ? 'right' : 'left';
			((s.style.bottom = (i.buttonBottom || 3) + '%'),
				(s.style[e] = (i.buttonOffset || 3) + '%'),
				(s.style[t] = 'auto'));
		}
	}
	function ne(e) {
		var t = document.getElementById('wcb-bubble'),
			n = document.getElementById('wcb-bubble-tail');
		!t ||
			!n ||
			(e === 'left'
				? ((t.style.left = 'calc(100% + 14px)'),
					(t.style.right = 'auto'),
					(n.style.left = '-8px'),
					(n.style.right = 'auto'),
					(n.style.borderLeft = 'none'),
					(n.style.borderRight = '8px solid #fff'))
				: ((t.style.right = 'calc(100% + 14px)'),
					(t.style.left = 'auto'),
					(n.style.right = '-8px'),
					(n.style.left = 'auto'),
					(n.style.borderRight = 'none'),
					(n.style.borderLeft = '8px solid #fff')));
	}
	function ie(e) {
		var t = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(e);
		return t
			? {
					r: parseInt(t[1], 16),
					g: parseInt(t[2], 16),
					b: parseInt(t[3], 16)
				}
			: null;
	}
	function oe(e) {
		var t = document.getElementById('wcb-btn-icon');
		if (!(!t || !e)) {
			var n = ie(e);
			if (n) {
				var o = t.querySelector('#wcbGrad');
				if (o) {
					var r = Math.round(n.r + (255 - n.r) * 0.3),
						b = Math.round(n.g + (255 - n.g) * 0.15),
						w = Math.round(n.b + (255 - n.b) * 0.05),
						c =
							'#' +
							[r, b, w]
								.map(function (B) {
									return ('0' + Math.min(255, B).toString(16)).slice(-2);
								})
								.join('');
					(o.children[0].setAttribute('stop-color', c),
						o.children[1].setAttribute('stop-color', e));
				}
				var l = 'rgba(' + n.r + ',' + n.g + ',' + n.b + ',0.6)';
				t.style.filter =
					'drop-shadow(0 6px 24px ' +
					l +
					') drop-shadow(0 2px 8px rgba(0,0,0,0.25))';
				var g = 'rgba(' + n.r + ',' + n.g + ',' + n.b + ',',
					L = document.getElementById('wcb-ring-1'),
					A = document.getElementById('wcb-ring-2'),
					d = document.getElementById('wcb-ring-3');
				(L && (L.style.background = g + '0.35)'),
					A && (A.style.background = g + '0.25)'),
					d && (d.style.background = g + '0.15)'));
			}
		}
	}
	function q() {
		var e = document.createElement('div');
		return (
			(e.id = 'wcb-brand'),
			(e.innerHTML =
				'\u0421\u0434\u0435\u043B\u0430\u043D\u043E \u0432&nbsp;<a href="https://winwidget.ru" target="_blank" rel="noopener">winwidget.ru</a>'),
			e
		);
	}
	function re() {
		a.innerHTML = '';
		var e = u(
			'button',
			{
				position: 'absolute',
				top: '12px',
				right: '16px',
				background: 'none',
				border: 'none',
				fontSize: '22px',
				cursor: 'pointer',
				color: '#aaa',
				lineHeight: '1',
				padding: '4px'
			},
			'&times;'
		);
		(e.setAttribute(
			'aria-label',
			'\u0417\u0430\u043A\u0440\u044B\u0442\u044C'
		),
			m && (e.style.display = 'none'),
			(e.onclick = function () {
				S();
			}),
			a.appendChild(e));
		var t = i.color || '#4705fb',
			n = i.buttonColor || t;
		if (i.title) {
			var o = u('h2', {
				margin: '0 0 6px',
				fontSize: '20px',
				fontWeight: '700',
				color: '#1a1a1a',
				lineHeight: '1.3',
				paddingRight: '24px'
			});
			((o.textContent = i.title), a.appendChild(o));
		}
		if (i.subtitle) {
			var r = u('p', {
				margin: '0 0 20px',
				fontSize: '13px',
				color: '#888',
				lineHeight: '1.5'
			});
			((r.textContent = i.subtitle), a.appendChild(r));
		}
		var b = !1,
			w = null,
			c = u('div', { marginBottom: '12px' }),
			l = document.createElement('input');
		((l.type = 'tel'),
			(l.autocomplete = 'tel'),
			(l.placeholder = '+7 999 123-45-67'),
			R(l, {
				width: '100%',
				boxSizing: 'border-box',
				padding: '12px 14px',
				fontSize: '16px',
				border: '1.5px solid #e0d6f0',
				borderRadius: '12px',
				outline: 'none',
				fontFamily: 'inherit',
				transition: 'border-color 0.2s, box-shadow 0.2s'
			}));
		var g = document.createElement('div');
		((g.className = 'wcb-err-text'),
			(g.textContent =
				'\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u043D\u043E\u043C\u0435\u0440 \u0442\u0435\u043B\u0435\u0444\u043E\u043D\u0430'));
		function L() {
			(l.classList.remove('wcb-field-err'),
				g.classList.remove('wcb-err-show'));
		}
		function A() {
			(l.classList.add('wcb-field-err'),
				g.classList.add('wcb-err-show'),
				ee(l),
				l.focus());
		}
		(l.addEventListener('focus', function () {
			l.classList.contains('wcb-field-err') ||
				((l.style.borderColor = t),
				(l.style.boxShadow = '0 0 0 3px ' + t + '22'));
		}),
			l.addEventListener('blur', function () {
				l.classList.contains('wcb-field-err') ||
					((l.style.borderColor = '#e0d6f0'),
					(l.style.boxShadow = 'none'));
			}),
			c.appendChild(l),
			c.appendChild(g),
			a.appendChild(c));
		var d = null;
		if (i.timeSlots && i.timeSlots.length > 0) {
			var B = u('div', { marginBottom: '12px' }),
				Z = u('label', {
					display: 'block',
					fontSize: '12px',
					color: '#888',
					marginBottom: '4px',
					fontWeight: '500'
				});
			((Z.textContent =
				'\u0423\u0434\u043E\u0431\u043D\u043E\u0435 \u0432\u0440\u0435\u043C\u044F \u0434\u043B\u044F \u0437\u0432\u043E\u043D\u043A\u0430'),
				(d = document.createElement('select')),
				R(d, {
					width: '100%',
					boxSizing: 'border-box',
					padding: '12px 14px',
					fontSize: '15px',
					border: '1.5px solid #e0d6f0',
					borderRadius: '12px',
					outline: 'none',
					fontFamily: 'inherit',
					background: '#fff',
					color: '#1a1a1a',
					cursor: 'pointer',
					transition: 'border-color 0.2s, box-shadow 0.2s',
					appearance: 'none',
					backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24'%3E%3Cpath fill='%23888' d='M7 10l5 5 5-5z'/%3E%3C/svg%3E")`,
					backgroundRepeat: 'no-repeat',
					backgroundPosition: 'right 12px center'
				}),
				d.addEventListener('focus', function () {
					((d.style.borderColor = t),
						(d.style.boxShadow = '0 0 0 3px ' + t + '22'));
				}),
				d.addEventListener('blur', function () {
					((d.style.borderColor = '#e0d6f0'),
						(d.style.boxShadow = 'none'));
				}),
				i.timeSlots.forEach(function (k) {
					var _ = document.createElement('option');
					((_.value = k), (_.textContent = k), d.appendChild(_));
				}),
				B.appendChild(Z),
				B.appendChild(d),
				a.appendChild(B));
		}
		var p = u('button', {
			width: '100%',
			padding: '14px',
			fontSize: '15px',
			fontWeight: '700',
			color: '#fff',
			border: 'none',
			borderRadius: '12px',
			cursor: 'pointer',
			background: 'linear-gradient(135deg,' + n + ',' + n + 'cc)',
			marginBottom: i.privacyUrl ? '12px' : '0',
			transition: 'opacity 0.2s, transform 0.15s',
			opacity: '0.5'
		});
		((p.textContent =
			i.submitButtonText ||
			'\u0417\u0430\u043A\u0430\u0437\u0430\u0442\u044C \u0437\u0432\u043E\u043D\u043E\u043A'),
			window.winwidgetPhone &&
				(w = window.winwidgetPhone.attach(l, {
					placeholder: '+7 999 123-45-67',
					onChange: function (k) {
						((b = !!k), (p.style.opacity = b ? '1' : '0.5'), L());
					}
				})),
			p.addEventListener('mouseenter', function () {
				b && (p.style.opacity = '0.88');
			}),
			p.addEventListener('mouseleave', function () {
				p.style.opacity = b ? '1' : '0.5';
			}));
		var M = !1;
		if (
			(p.addEventListener('click', function () {
				if (!M) {
					if (!b) {
						A();
						return;
					}
					var k = w ? w.getNumber() : null;
					((M = !0),
						(p.disabled = !0),
						(p.style.opacity = '0.6'),
						(p.textContent =
							'\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u0435\u043C...'));
					var _ = '';
					try {
						_ = Intl.DateTimeFormat().resolvedOptions().timeZone;
					} catch (K) {}
					fetch(O + '/callback/' + T + '/lead', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							phone: k,
							timeSlot: d ? d.value : '',
							timezone: _,
							url: window.location.href
						})
					})
						.then(function (K) {
							return K.json();
						})
						.then(function () {
							((U = !0), G());
						})
						.catch(function () {
							((M = !1),
								(p.disabled = !1),
								(p.style.opacity = '1'),
								(p.textContent =
									i.submitButtonText ||
									'\u0417\u0430\u043A\u0430\u0437\u0430\u0442\u044C \u0437\u0432\u043E\u043D\u043E\u043A'));
						});
				}
			}),
			a.appendChild(p),
			i.privacyUrl)
		) {
			var D = u('p', {
				margin: '0',
				fontSize: '11px',
				color: '#bbb',
				textAlign: 'center',
				lineHeight: '1.5'
			});
			((D.innerHTML =
				'\u041D\u0430\u0436\u0438\u043C\u0430\u044F \u043A\u043D\u043E\u043F\u043A\u0443, \u0432\u044B \u0441\u043E\u0433\u043B\u0430\u0448\u0430\u0435\u0442\u0435\u0441\u044C \u0441 <a href="' +
				i.privacyUrl +
				'" target="_blank" style="color:#bbb">\u043F\u043E\u043B\u0438\u0442\u0438\u043A\u043E\u0439 \u043A\u043E\u043D\u0444\u0438\u0434\u0435\u043D\u0446\u0438\u0430\u043B\u044C\u043D\u043E\u0441\u0442\u0438</a>'),
				a.appendChild(D));
		}
		a.appendChild(q());
	}
	function G() {
		a.innerHTML = '';
		var e = i.color || '#4705fb',
			t = u(
				'button',
				{
					position: 'absolute',
					top: '12px',
					right: '16px',
					background: 'none',
					border: 'none',
					fontSize: '22px',
					cursor: 'pointer',
					color: '#aaa',
					lineHeight: '1',
					padding: '4px'
				},
				'&times;'
			);
		(m && (t.style.display = 'none'),
			(t.onclick = function () {
				S();
			}),
			a.appendChild(t));
		var n = u('div', {
			width: '60px',
			height: '60px',
			borderRadius: '50%',
			background: e + '18',
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			margin: '0 auto 16px',
			fontSize: '28px'
		});
		((n.textContent = '\u2713'), (n.style.color = e), a.appendChild(n));
		var o = u('h2', {
			margin: '0 0 8px',
			fontSize: '20px',
			fontWeight: '700',
			color: '#1a1a1a',
			textAlign: 'center',
			paddingRight: '0'
		});
		if (
			((o.textContent =
				i.successTitle ||
				'\u0421\u043F\u0430\u0441\u0438\u0431\u043E! \u041C\u044B \u043F\u0435\u0440\u0435\u0437\u0432\u043E\u043D\u0438\u043C'),
			a.appendChild(o),
			i.successSubtitle)
		) {
			var r = u('p', {
				margin: '0',
				fontSize: '14px',
				color: '#888',
				textAlign: 'center',
				lineHeight: '1.5'
			});
			((r.textContent = i.successSubtitle), a.appendChild(r));
		}
		a.appendChild(q());
	}
	function E() {
		f ||
			((f = !0),
			(s.style.opacity = '0'),
			(s.style.pointerEvents = 'none'),
			(s.style.transform = 'scale(0.8)'),
			H(),
			(x.style.display = 'flex'),
			U ? G() : re(),
			requestAnimationFrame(function () {
				requestAnimationFrame(function () {
					((a.style.transform = 'translateY(0)'), (a.style.opacity = '1'));
				});
			}),
			X('open'));
	}
	function S() {
		f &&
			((f = !1),
			(s.style.opacity = '1'),
			(s.style.pointerEvents = 'auto'),
			(s.style.transform = 'scale(1)'),
			z(),
			(a.style.transform = 'translateY(40px)'),
			(a.style.opacity = '0'),
			setTimeout(function () {
				f || (x.style.display = 'none');
			}, 300),
			X('close'));
	}
	function X(e) {
		try {
			document.dispatchEvent(new CustomEvent('winwidget:callback:' + e));
		} catch (t) {}
	}
	function Y() {
		var e = document.getElementById('wcb-bubble');
		!e ||
			e.style.display === 'none' ||
			((e.style.opacity = '0'),
			(e.style.transform = 'translateY(-50%) scale(0.85)'),
			setTimeout(function () {
				e.style.display = 'none';
			}, 300));
	}
	(s.addEventListener('click', function () {
		(Y(), f ? S() : E());
	}),
		P.addEventListener('click', function () {
			m || S();
		}),
		Promise.all([J(), fetch(O + '/callback/' + T + '/config')])
			.then(function (e) {
				var t = e[1];
				return t.ok
					? t.json()
					: (console.warn(
							'[wincallback] Widget not found or inactive (' +
								t.status +
								')'
						),
						null);
			})
			.then(function (e) {
				if (e !== null) {
					if (!e || !e.isActive) {
						console.warn('[wincallback] Widget is inactive');
						return;
					}
					i = e;
					var t = i.buttonSize || 60;
					(te(), (s.style.display = m ? 'none' : 'flex'));
					var n = s.querySelector('#wcb-btn-icon');
					if (n) {
						var o = n.querySelector('svg');
						o &&
							(o.setAttribute('width', t),
							o.setAttribute('height', t),
							o.setAttribute('viewBox', '0 0 60 60'));
					}
					(oe(i.openButtonColor || i.color || '#4705fb'),
						(j = i.buttonPulse !== !1),
						i.buttonPulse === !1 &&
							['wcb-ring-1', 'wcb-ring-2', 'wcb-ring-3'].forEach(
								function (c) {
									var l = document.getElementById(c);
									l && (l.style.display = 'none');
								}
							),
						i.bgColor && (a.style.background = i.bgColor),
						ne(i.buttonSide || 'right'));
					var r = document.getElementById('wcb-bubble-close'),
						b = document.getElementById('wcb-bubble'),
						w = document.getElementById('wcb-bubble-text');
					(w &&
						(w.textContent =
							i.bubbleText ||
							i.title ||
							'\u041F\u0435\u0440\u0435\u0437\u0432\u043E\u043D\u0438\u043C!'),
						b && i.bubbleEnabled === !1 && (b.style.display = 'none'),
						r &&
							r.addEventListener('click', function (c) {
								(c.stopPropagation(), Y());
							}),
						b &&
							b.addEventListener('click', function (c) {
								(c.stopPropagation(), Y(), E());
							}),
						!m &&
							i.bubbleEnabled !== !1 &&
							setTimeout(function () {
								var c = document.getElementById('wcb-bubble');
								!c ||
									f ||
									((c.style.display = 'block'),
									requestAnimationFrame(function () {
										requestAnimationFrame(function () {
											((c.style.opacity = '1'),
												(c.style.transform = 'translateY(-50%) scale(1)'));
										});
									}));
							}, 2e3),
						!(i.hasSubmittedByIp && i.filterDuplicates) &&
							(!m && !f && (H(), z()),
							i.autoOpenDelay &&
								i.autoOpenDelay > 0 &&
								setTimeout(function () {
									f || E();
								}, i.autoOpenDelay * 1e3),
							m && E()));
				}
			})
			.catch(function (e) {
				console.error('[wincallback] Failed to load config:', e);
			}));
	function ae() {
		(s.parentNode && s.parentNode.removeChild(s),
			v.parentNode && v.parentNode.removeChild(v),
			y.parentNode && y.parentNode.removeChild(y),
			delete window.__wincallbackScriptRunning,
			delete window.winwidgetCallback);
	}
	window.winwidgetCallback = { open: E, close: S, destroy: ae };
})();
