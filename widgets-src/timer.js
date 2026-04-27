(function () {
	'use strict';

	if (window.__wintimerScriptRunning) return;
	window.__wintimerScriptRunning = true;

	var _currentScript = document.currentScript;
	var API_BASE = (function () {
		try {
			var src = new URL(
				_currentScript && _currentScript.src
					? _currentScript.src
					: location.href
			);
			return src.origin + '/api';
		} catch (e) {
			return 'https://winwidget.ru/api';
		}
	})();
	var KEY =
		(_currentScript && _currentScript.getAttribute('data-key')) ||
		window.wintimer ||
		'';
	if (!KEY) {
		delete window.__wintimerScriptRunning;
		return;
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
				console.warn('[wintimer] Failed to load phone formatter:', e);
				return null;
			});
	}

	var AUTO_OPEN = Boolean(
		window.wintimerAutoOpen ||
		window.winwidgetTimerAutoOpen ||
		(window.winwidget && window.winwidget.autoOpen)
	);

	var MASKS = {
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

	function applyMask(raw, maskDef) {
		var digits = raw.replace(/\D/g, '');
		if (maskDef === MASKS.RU || maskDef === MASKS.KZ) {
			if (digits.startsWith('8')) digits = '7' + digits.slice(1);
			if (digits.startsWith('7')) digits = digits.slice(1);
		}
		if (maskDef === MASKS.BY && digits.startsWith('375'))
			digits = digits.slice(3);
		if (maskDef === MASKS.UA && digits.startsWith('380'))
			digits = digits.slice(3);
		if (maskDef === MASKS.UZ && digits.startsWith('998'))
			digits = digits.slice(3);
		var i = 0;
		return maskDef.mask.replace(/#/g, function () {
			return i < digits.length ? digits[i++] : '_';
		});
	}

	function getRawDigits(masked, maskDef) {
		var prefixDigits = maskDef.mask.split('#')[0].replace(/\D/g, '');
		var body = masked.replace(/\D/g, '');
		if (body.startsWith(prefixDigits))
			body = body.slice(prefixDigits.length);
		return body.replace(/_/g, '');
	}

	function isPhoneComplete(masked, maskDef) {
		return getRawDigits(masked, maskDef).length >= maskDef.digits;
	}

	function el(tag, styles, html) {
		var node = document.createElement(tag);
		if (styles) {
			Object.keys(styles).forEach(function (key) {
				node.style[key] = styles[key];
			});
		}
		if (html !== undefined) node.innerHTML = html;
		return node;
	}

	function safeText(value, fallback) {
		return value == null || value === '' ? fallback : String(value);
	}

	function getConfigUrl() {
		return (
			API_BASE +
			'/countdown-timer/' +
			encodeURIComponent(KEY) +
			'/config?_=' +
			Date.now()
		);
	}

	var cfg = null;
	var isOpen = false;
	var submitted = false;
	var deadline = null;
	var tickTimer = null;
	var autoOpenTimer = null;

	var timerBtn = document.createElement('div');
	timerBtn.id = 'timer-widget-button';
	timerBtn.innerHTML = [
		'<div id="wt-bubble" style="display:none;position:absolute;top:50%;transform:translateY(-50%) scale(0.85);background:#fff;border-radius:18px;padding:12px 34px 12px 16px;width:172px;box-sizing:border-box;border:1px solid rgba(71,5,251,0.12);box-shadow:0 16px 40px rgba(71,5,251,0.18),0 8px 18px rgba(15,23,42,0.08);cursor:pointer;opacity:0;transition:opacity 0.3s ease,transform 0.35s cubic-bezier(.22,1,.36,1);font-family:system-ui,-apple-system,sans-serif;">',
		'<button id="wt-bubble-close" style="position:absolute;top:7px;right:8px;background:none;border:none;font-size:11px;cursor:pointer;color:#ccc;line-height:1;padding:2px;display:flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;">✕</button>',
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
		'<div id="wt-btn-label" style="margin-top:6px;background:#fff;color:#1a1a1a;border:1px solid rgba(71,5,251,0.12);box-shadow:0 8px 24px rgba(71,5,251,0.14);font-size:11px;font-weight:800;padding:5px 10px;border-radius:999px;white-space:nowrap;line-height:1.2;">Акция</div>'
	].join('');
	timerBtn.style.cssText = [
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
	document.body.appendChild(timerBtn);

	var style = document.createElement('style');
	style.id = 'timer-widget-style';
	style.textContent = [
		'@keyframes wtBounce{0%,100%{transform:translateY(0) scale(1)}10%{transform:translateY(-16px) scale(1.1)}20%{transform:translateY(0) scale(1)}30%{transform:translateY(-6px) scale(1.04)}40%{transform:translateY(0) scale(1)}}',
		'@keyframes wtSway{0%,100%{transform:rotate(0)}25%{transform:rotate(-6deg)}75%{transform:rotate(6deg)}}',
		'@keyframes wtGlow{0%,100%{filter:drop-shadow(0 6px 16px rgba(0,0,0,0.35)) drop-shadow(0 2px 4px rgba(0,0,0,0.2))}50%{filter:drop-shadow(0 8px 28px rgba(101,16,255,0.7)) drop-shadow(0 2px 12px rgba(37,117,252,0.5))}}',
		'@keyframes wtRipple{0%{transform:scale(1);opacity:.55}100%{transform:scale(2.15);opacity:0}}',
		'#wt-ring-1,#wt-ring-2{display:none}',
		'#wt-bubble:hover{opacity:0.95!important}',
		'#wt-bubble-close:hover{color:#888!important}',
		'.wt-input-error{border-color:#ef4444!important;box-shadow:0 0 0 3px rgba(239,68,68,.12)!important}',
		'@media(max-width:480px){#timer-widget-overlay{padding:12px!important}#wt-modal{padding:22px 16px 18px!important;border-radius:18px!important}.wt-time-value{font-size:24px!important}.wt-time-box{padding:10px 6px!important}#wt-bubble{display:none!important}}'
	].join('');
	document.head.appendChild(style);

	var buttonAnimationActive = false;
	var buttonPulseEnabled = true;
	var scrollTriggered = false;

	function startButtonAnimation() {
		if (buttonAnimationActive) return;
		buttonAnimationActive = true;
		timerBtn.style.animation = [
			'wtBounce 3s ease-in-out infinite',
			'wtSway 4s ease-in-out infinite',
			buttonPulseEnabled ? 'wtGlow 2.5s ease-in-out infinite' : ''
		]
			.filter(Boolean)
			.join(',');
	}

	function stopButtonAnimation() {
		buttonAnimationActive = false;
		timerBtn.style.animation = 'none';
	}

	setTimeout(startButtonAnimation, 4000);

	window.addEventListener(
		'scroll',
		function () {
			if (scrollTriggered) return;
			scrollTriggered = true;
			timerBtn.animate(
				[
					{ transform: 'translateY(0) rotate(0deg)' },
					{ transform: 'translateY(-250px) rotate(-6deg)' },
					{ transform: 'translateY(0) rotate(0deg)' }
				],
				{
					duration: 2300,
					easing: 'cubic-bezier(.34,1.56,.64,1)'
				}
			);
			startButtonAnimation();
		},
		{ passive: true }
	);

	var host = document.createElement('div');
	host.id = 'timer-widget-host';
	document.body.appendChild(host);
	var shadow = host.attachShadow({ mode: 'open' });
	var shadowStyle = document.createElement('style');
	shadowStyle.textContent = style.textContent;
	shadow.appendChild(shadowStyle);

	var overlay = document.createElement('div');
	overlay.id = 'timer-widget-overlay';
	overlay.style.cssText =
		'position:fixed;inset:0;z-index:10000;display:none;align-items:center;justify-content:center;padding:16px;box-sizing:border-box';
	var backdrop = document.createElement('div');
	backdrop.style.cssText =
		'position:absolute;inset:0;background:rgba(7,8,20,.56);backdrop-filter:blur(4px);';
	overlay.appendChild(backdrop);
	var modal = document.createElement('div');
	modal.id = 'wt-modal';
	modal.style.cssText = [
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
	].join(';');
	overlay.appendChild(modal);
	shadow.appendChild(overlay);

	function positionButton() {
		var size = cfg.buttonSize || 60;
		var side = cfg.buttonSide === 'left' ? 'left' : 'right';
		timerBtn.style[side] = (cfg.buttonOffset ?? 3) + '%';
		timerBtn.style[side === 'left' ? 'right' : 'left'] = 'auto';
		timerBtn.style.bottom = (cfg.buttonBottom ?? 3) + '%';
		var svg = timerBtn.querySelector('svg');
		if (svg) {
			svg.setAttribute('width', size);
			svg.setAttribute('height', size);
		}
	}

	function updateBubbleSide(side) {
		var bubble = document.getElementById('wt-bubble');
		var tail = document.getElementById('wt-bubble-tail');
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
		var bubble = document.getElementById('wt-bubble');
		if (!bubble || bubble.style.display === 'none') return;
		bubble.style.opacity = '0';
		bubble.style.transform = 'translateY(-50%) scale(0.85)';
		setTimeout(function () {
			bubble.style.display = 'none';
		}, 300);
	}

	function applyButtonColor(color) {
		buttonPulseEnabled = cfg.buttonPulse !== false;
		var circle = timerBtn.querySelector('circle');
		if (circle && color) circle.setAttribute('fill', color);
		var icon = timerBtn.querySelector('#wt-btn-icon');
		if (icon && color) {
			icon.style.filter =
				'drop-shadow(0 6px 24px ' +
				color +
				'66) drop-shadow(0 2px 8px rgba(0,0,0,.22))';
		}
		['wt-ring-1', 'wt-ring-2'].forEach(function (id) {
			var ring = document.getElementById(id);
			if (ring)
				ring.style.display = cfg.buttonPulse === false ? 'none' : '';
		});
	}

	function getDeadline() {
		if (!cfg) return new Date(Date.now() + 15 * 60 * 1000);
		if (cfg.timerMode === 'FIXED_DATE' && cfg.deadlineAt) {
			var fixed = new Date(cfg.deadlineAt);
			if (!isNaN(fixed.getTime())) return fixed;
		}
		var minutes = Math.max(1, Number(cfg.evergreenDurationMinutes) || 15);
		var storageKey =
			'wintimer_deadline_' + KEY + '_' + (cfg.timerResetToken || '');
		try {
			var stored = localStorage.getItem(storageKey);
			if (stored) {
				var storedDate = new Date(stored);
				if (!isNaN(storedDate.getTime())) return storedDate;
			}
			var created = new Date(Date.now() + minutes * 60 * 1000);
			localStorage.setItem(storageKey, created.toISOString());
			return created;
		} catch (e) {
			return new Date(Date.now() + minutes * 60 * 1000);
		}
	}

	function getSubmittedStorageKey() {
		return 'wintimer_submitted_' + KEY + '_' + (cfg.timerResetToken || '');
	}

	function rememberSubmitted() {
		if (!cfg || cfg.filterDuplicates !== true || cfg.dataType === 'NONE')
			return;
		try {
			localStorage.setItem(
				getSubmittedStorageKey(),
				Date.now().toString()
			);
		} catch (e) {}
	}

	function hasSubmittedLocally() {
		if (!cfg || cfg.filterDuplicates !== true || cfg.dataType === 'NONE')
			return false;
		try {
			var storedTs = localStorage.getItem(getSubmittedStorageKey());
			if (!storedTs) return false;
			var submittedAt = parseInt(storedTs, 10);
			if (!submittedAt) return false;
			var cooldownMs =
				(Number(cfg.submissionCooldownDays) || 0) * 24 * 60 * 60 * 1000;
			return cooldownMs === 0 || Date.now() - submittedAt < cooldownMs;
		} catch (e) {
			return false;
		}
	}

	function isAlreadySubmitted() {
		return (
			cfg &&
			cfg.filterDuplicates === true &&
			cfg.dataType !== 'NONE' &&
			(cfg.hasSubmittedByIp === true || hasSubmittedLocally())
		);
	}

	function getLeftMs() {
		return deadline ? Math.max(0, deadline.getTime() - Date.now()) : 0;
	}

	function splitTime(ms) {
		var total = Math.floor(ms / 1000);
		var days = Math.floor(total / 86400);
		total -= days * 86400;
		var hours = Math.floor(total / 3600);
		total -= hours * 3600;
		var minutes = Math.floor(total / 60);
		return {
			days: days,
			hours: hours,
			minutes: minutes,
			seconds: total - minutes * 60
		};
	}

	function pad(n) {
		return n < 10 ? '0' + n : String(n);
	}

	function updateTimerLabels() {
		var left = getLeftMs();
		var t = splitTime(left);
		['days', 'hours', 'minutes', 'seconds'].forEach(function (key) {
			var node = modal.querySelector('[data-wt-time="' + key + '"]');
			if (!node) return;
			node.textContent = key === 'days' ? String(t[key]) : pad(t[key]);
		});
		var label = document.getElementById('wt-btn-label');
		if (label) {
			label.textContent =
				left <= 0
					? cfg.expiredTitle || 'Акция завершена'
					: (cfg.bubbleText || 'Акция') +
						': ' +
						(t.days > 0 ? t.days + 'д ' : '') +
						pad(t.hours) +
						':' +
						pad(t.minutes);
		}
		if (left <= 0) {
			if (cfg.expiredBehavior === 'hide') {
				timerBtn.style.display = 'none';
				closeModal();
				return;
			}
			if (isOpen) buildExpired();
		}
	}

	function startTicker() {
		if (tickTimer) clearInterval(tickTimer);
		updateTimerLabels();
		tickTimer = setInterval(updateTimerLabels, 1000);
	}

	function buildCloseBtn() {
		var close = el(
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
		if (AUTO_OPEN) close.style.display = 'none';
		close.onclick = closeModal;
		return close;
	}

	function buildBrand() {
		var brand = el('div', {
			textAlign: 'center',
			fontSize: '11px',
			color: '#bbb',
			marginTop: '12px',
			lineHeight: '1.5'
		});
		brand.innerHTML =
			'Работает на <a href="https://winwidget.ru" target="_blank" style="color:#999;text-decoration:none;font-weight:700">Winwidget</a>';
		return brand;
	}

	function buildTimerBlock() {
		var block = el('div', {
			display: 'grid',
			gridTemplateColumns: 'repeat(4,1fr)',
			gap: '8px',
			margin: '18px 0 18px'
		});
		[
			['days', 'дни'],
			['hours', 'часы'],
			['minutes', 'мин'],
			['seconds', 'сек']
		].forEach(function (item) {
			var box = el('div', {
				borderRadius: '14px',
				background: 'linear-gradient(180deg,#f8f5ff,#fff)',
				border: '1px solid #e0d6f0',
				padding: '12px 8px',
				textAlign: 'center'
			});
			box.className = 'wt-time-box';
			var value = el('div', {
				fontSize: '28px',
				fontWeight: '850',
				color: cfg.color || '#4705fb',
				lineHeight: '1',
				fontVariantNumeric: 'tabular-nums'
			});
			value.className = 'wt-time-value';
			value.setAttribute('data-wt-time', item[0]);
			value.textContent = '00';
			var caption = el('div', {
				marginTop: '6px',
				fontSize: '10px',
				color: '#999',
				textTransform: 'uppercase',
				letterSpacing: '.05em'
			});
			caption.textContent = item[1];
			box.appendChild(value);
			box.appendChild(caption);
			block.appendChild(box);
		});
		return block;
	}

	function buildActionLink(fullWidth) {
		if (!cfg.actionButtonUrl) return null;
		var link = el('a', {
			display: 'inline-flex',
			alignItems: 'center',
			justifyContent: 'center',
			width: fullWidth ? '100%' : 'auto',
			minHeight: '48px',
			padding: '0 18px',
			borderRadius: '12px',
			background: cfg.buttonColor || cfg.color || '#4705fb',
			color: '#fff',
			fontSize: '15px',
			fontWeight: '750',
			textDecoration: 'none',
			boxSizing: 'border-box',
			boxShadow: '0 8px 22px rgba(71,5,251,.22)'
		});
		link.href = cfg.actionButtonUrl;
		link.target = '_blank';
		link.rel = 'noopener noreferrer';
		link.textContent = cfg.actionButtonText || 'Перейти к акции';
		link.onclick = function () {
			fireEvent('action');
		};
		return link;
	}

	function buildIntro() {
		modal.innerHTML = '';
		modal.appendChild(buildCloseBtn());
		var badge = el('div', {
			display: 'inline-flex',
			alignSelf: 'center',
			padding: '5px 10px',
			borderRadius: '999px',
			background: (cfg.color || '#4705fb') + '12',
			color: cfg.color || '#4705fb',
			fontSize: '11px',
			fontWeight: '800',
			letterSpacing: '.06em',
			textTransform: 'uppercase',
			marginBottom: '12px'
		});
		badge.textContent = safeText(cfg.bubbleText, 'Акция');
		modal.appendChild(badge);
		var title = el('h2', {
			margin: '0 22px 8px',
			fontSize: '24px',
			lineHeight: '1.2',
			textAlign: 'center',
			color: '#1a1a1a',
			fontWeight: '800'
		});
		title.textContent = safeText(
			cfg.title,
			'Скидка ограничена по времени'
		);
		modal.appendChild(title);
		if (cfg.subtitle) {
			var subtitle = el('p', {
				margin: '0 auto',
				fontSize: '14px',
				color: '#777',
				textAlign: 'center',
				lineHeight: '1.5',
				maxWidth: '340px'
			});
			subtitle.textContent = cfg.subtitle;
			modal.appendChild(subtitle);
		}
		modal.appendChild(buildTimerBlock());
		if (cfg.dataType === 'NONE') {
			var action = buildActionLink(true);
			if (action) modal.appendChild(action);
			modal.appendChild(buildBrand());
			updateTimerLabels();
			return;
		}
		if (isAlreadySubmitted()) {
			buildSuccess();
			return;
		}
		buildFormContent();
		updateTimerLabels();
	}

	function buildFormContent() {
		var contactTitle = el('p', {
			margin: '0 0 10px',
			fontSize: '14px',
			fontWeight: '700',
			color: '#1a1a1a',
			textAlign: 'center',
			lineHeight: '1.4'
		});
		contactTitle.textContent = safeText(
			cfg.contactTitle,
			'Оставьте контакт, чтобы получить предложение'
		);
		modal.appendChild(contactTitle);
		var form = el('div', {
			display: 'flex',
			flexDirection: 'column',
			gap: '10px'
		});
		var phoneInput = null;
		var emailInput = null;
		var phoneController = null;

		function makeInput(type, placeholder) {
			var input = el('input', {
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
			input.type = type;
			input.placeholder = placeholder;
			input.onfocus = function () {
				input.style.borderColor = cfg.color || '#4705fb';
				input.style.boxShadow =
					'0 0 0 3px ' + (cfg.color || '#4705fb') + '22';
			};
			input.onblur = function () {
				input.style.borderColor = '#e0d6f0';
				input.style.boxShadow = 'none';
			};
			return input;
		}

		if (cfg.dataType === 'PHONE' || cfg.dataType === 'PHONE_AND_EMAIL') {
			phoneInput = makeInput('tel', '+7 999 123-45-67');
			if (window.winwidgetPhone) {
				phoneController = window.winwidgetPhone.attach(phoneInput, {
					placeholder: '+7 999 123-45-67',
					onChange: function () {
						phoneInput.classList.remove('wt-input-error');
					}
				});
			}
			phoneInput.addEventListener('input', function () {
				phoneInput.classList.remove('wt-input-error');
			});
			form.appendChild(phoneInput);
		}
		if (cfg.dataType === 'EMAIL' || cfg.dataType === 'PHONE_AND_EMAIL') {
			emailInput = makeInput('email', 'Email');
			emailInput.addEventListener('input', function () {
				emailInput.classList.remove('wt-input-error');
			});
			form.appendChild(emailInput);
		}
		var submit = el('button', {
			width: '100%',
			height: '50px',
			border: 'none',
			borderRadius: '12px',
			background: cfg.buttonColor || cfg.color || '#4705fb',
			color: '#fff',
			fontSize: '15px',
			fontWeight: '750',
			cursor: 'pointer',
			boxShadow: '0 8px 22px rgba(71,5,251,.22)'
		});
		submit.textContent = safeText(
			cfg.submitButtonText,
			'Получить предложение'
		);
		form.appendChild(submit);
		if (cfg.privacyUrl) {
			var privacy = el('p', {
				margin: '0',
				fontSize: '11px',
				color: '#aaa',
				textAlign: 'center',
				lineHeight: '1.45'
			});
			privacy.innerHTML =
				'Нажимая кнопку, вы соглашаетесь с <a href="' +
				cfg.privacyUrl +
				'" target="_blank" style="color:#999">политикой конфиденциальности</a>';
			form.appendChild(privacy);
		}
		var isSubmitting = false;
		submit.onclick = function () {
			if (isSubmitting) return;
			var phone = '';
			var email = '';
			var valid = true;
			if (phoneInput) {
				phone = phoneController ? phoneController.getNumber() : null;
				if (!phone) {
					phoneInput.classList.add('wt-input-error');
					valid = false;
				}
			}
			if (emailInput) {
				email = emailInput.value.trim();
				if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
					emailInput.classList.add('wt-input-error');
					valid = false;
				}
			}
			if (!valid) return;
			isSubmitting = true;
			submit.disabled = true;
			submit.style.opacity = '.65';
			submit.textContent = 'Отправляем...';
			fetch(API_BASE + '/countdown-timer/' + KEY + '/lead', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					phone: phone || undefined,
					email: email || undefined,
					url: window.location.href
				})
			})
				.then(function (r) {
					if (!r.ok) throw new Error('submit failed');
					return r.json();
				})
				.then(function () {
					submitted = true;
					rememberSubmitted();
					fireEvent('submit');
					buildSuccess();
				})
				.catch(function () {
					isSubmitting = false;
					submit.disabled = false;
					submit.style.opacity = '1';
					submit.textContent = safeText(
						cfg.submitButtonText,
						'Получить предложение'
					);
				});
		};
		modal.appendChild(form);
		modal.appendChild(buildBrand());
	}

	function buildSuccess() {
		modal.innerHTML = '';
		modal.appendChild(buildCloseBtn());
		var icon = el('div', {
			width: '60px',
			height: '60px',
			borderRadius: '50%',
			background: (cfg.color || '#4705fb') + '12',
			color: cfg.color || '#4705fb',
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			margin: '8px auto 16px',
			fontSize: '30px',
			fontWeight: '800'
		});
		icon.textContent = '✓';
		modal.appendChild(icon);
		var title = el('h2', {
			margin: '0 0 8px',
			fontSize: '22px',
			fontWeight: '800',
			color: '#1a1a1a',
			textAlign: 'center'
		});
		title.textContent = safeText(
			cfg.successTitle,
			'Спасибо! Заявка отправлена'
		);
		modal.appendChild(title);
		if (cfg.successSubtitle) {
			var sub = el('p', {
				margin: '0 0 16px',
				fontSize: '14px',
				color: '#777',
				textAlign: 'center',
				lineHeight: '1.5'
			});
			sub.textContent = cfg.successSubtitle;
			modal.appendChild(sub);
		}
		var action = buildActionLink(true);
		if (action) modal.appendChild(action);
		modal.appendChild(buildBrand());
	}

	function buildExpired() {
		modal.innerHTML = '';
		modal.appendChild(buildCloseBtn());
		var icon = el('div', {
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
		icon.textContent = '00';
		modal.appendChild(icon);
		var title = el('h2', {
			margin: '0 0 8px',
			fontSize: '22px',
			fontWeight: '800',
			color: '#1a1a1a',
			textAlign: 'center'
		});
		title.textContent = safeText(cfg.expiredTitle, 'Акция завершена');
		modal.appendChild(title);
		if (cfg.expiredSubtitle) {
			var sub = el('p', {
				margin: '0',
				fontSize: '14px',
				color: '#777',
				textAlign: 'center',
				lineHeight: '1.5'
			});
			sub.textContent = cfg.expiredSubtitle;
			modal.appendChild(sub);
		}
		if (cfg.expiredBehavior === 'disableForm') {
			var action = buildActionLink(true);
			if (action) {
				action.style.marginTop = '16px';
				modal.appendChild(action);
			}
		}
		modal.appendChild(buildBrand());
	}

	function openModal() {
		if (!cfg || isOpen) return;
		isOpen = true;
		timerBtn.style.opacity = '0';
		timerBtn.style.pointerEvents = 'none';
		timerBtn.style.transform = 'scale(0.8)';
		stopButtonAnimation();
		overlay.style.display = 'flex';
		if (getLeftMs() <= 0 && cfg.expiredBehavior !== 'disableForm')
			buildExpired();
		else if (submitted && cfg.dataType !== 'NONE') buildSuccess();
		else buildIntro();
		requestAnimationFrame(function () {
			requestAnimationFrame(function () {
				modal.style.transform = 'translateY(0)';
				modal.style.opacity = '1';
			});
		});
		fireEvent('open');
	}

	function closeModal() {
		if (!isOpen) return;
		isOpen = false;
		timerBtn.style.opacity = '1';
		timerBtn.style.pointerEvents = 'auto';
		timerBtn.style.transform = 'scale(1)';
		startButtonAnimation();
		modal.style.transform = 'translateY(28px)';
		modal.style.opacity = '0';
		setTimeout(function () {
			if (!isOpen) overlay.style.display = 'none';
		}, 280);
		fireEvent('close');
	}

	function fireEvent(name) {
		try {
			document.dispatchEvent(new CustomEvent('winwidget:timer:' + name));
		} catch (e) {}
	}

	function handleButtonClick() {
		hideBubble();
		isOpen ? closeModal() : openModal();
	}

	function handleBackdropClick() {
		if (!AUTO_OPEN) closeModal();
	}

	function applyLoadedConfig(options) {
		options = options || {};
		positionButton();
		applyButtonColor(cfg.openButtonColor || cfg.color || '#4705fb');
		timerBtn.style.display = AUTO_OPEN ? 'none' : 'flex';
		modal.style.background = cfg.bgColor || '#fff';
		var label = document.getElementById('wt-btn-label');
		if (label) label.textContent = cfg.bubbleText || 'Акция';

		updateBubbleSide(cfg.buttonSide || 'right');

		var bubbleClose = document.getElementById('wt-bubble-close');
		var bubbleEl = document.getElementById('wt-bubble');
		var bubbleText = document.getElementById('wt-bubble-text');

		if (bubbleText) bubbleText.textContent = cfg.bubbleText || 'Акция!';
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
				openModal();
			});
		}
		if (!AUTO_OPEN && cfg.bubbleEnabled !== false) {
			setTimeout(function () {
				var b = document.getElementById('wt-bubble');
				if (!b || isOpen) return;
				b.style.display = 'block';
				requestAnimationFrame(function () {
					requestAnimationFrame(function () {
						b.style.opacity = '1';
						b.style.transform = 'translateY(-50%) scale(1)';
					});
				});
			}, 2000);
		}

		if (!AUTO_OPEN && !isOpen) {
			stopButtonAnimation();
			startButtonAnimation();
		}
		startTicker();
		if (getLeftMs() <= 0 && cfg.expiredBehavior === 'hide') {
			timerBtn.style.display = 'none';
			closeModal();
			return;
		}
		if (isOpen) {
			if (getLeftMs() <= 0 && cfg.expiredBehavior !== 'disableForm')
				buildExpired();
			else if (submitted && cfg.dataType !== 'NONE') buildSuccess();
			else buildIntro();
			modal.style.transform = 'translateY(0)';
			modal.style.opacity = '1';
		}
		if (autoOpenTimer) clearTimeout(autoOpenTimer);
		if (options.initial && cfg.autoOpenDelay && cfg.autoOpenDelay > 0) {
			autoOpenTimer = setTimeout(function () {
				if (!isOpen) openModal();
			}, cfg.autoOpenDelay * 1000);
		}
		if (AUTO_OPEN && !isOpen) openModal();
	}

	function loadConfig(options) {
		return Promise.all([
			ensurePhoneHelper(),
			fetch(getConfigUrl(), { cache: 'no-store' })
		])
			.then(function (result) {
				var r = result[1];
				if (!r.ok) {
					console.warn(
						'[wintimer] Widget not found or inactive (' + r.status + ')'
					);
					return null;
				}
				return r.json();
			})
			.then(function (data) {
				if (data === null) return;
				if (!data || !data.isActive) {
					console.warn('[wintimer] Widget is inactive');
					if (tickTimer) clearInterval(tickTimer);
					if (autoOpenTimer) clearTimeout(autoOpenTimer);
					cfg = null;
					timerBtn.style.display = 'none';
					closeModal();
					return;
				}
				cfg = data;
				submitted = cfg.dataType === 'NONE' ? false : isAlreadySubmitted();
				deadline = getDeadline();
				applyLoadedConfig(options);
			})
			.catch(function (e) {
				console.error('[wintimer] Failed to load config:', e);
			});
	}

	function refreshConfig() {
		return loadConfig({ refresh: true });
	}

	function handleExternalRefresh(event) {
		if (!event.detail || !event.detail.key || event.detail.key === KEY)
			refreshConfig();
	}

	function handleStorageRefresh(event) {
		if (event.key === 'winwidget:timer:' + KEY + ':updated')
			refreshConfig();
	}

	function destroyWidget() {
		if (tickTimer) clearInterval(tickTimer);
		if (autoOpenTimer) clearTimeout(autoOpenTimer);
		timerBtn.removeEventListener('click', handleButtonClick);
		backdrop.removeEventListener('click', handleBackdropClick);
		window.removeEventListener(
			'winwidget:timer:updated',
			handleExternalRefresh
		);
		window.removeEventListener('storage', handleStorageRefresh);
		if (timerBtn.parentNode) timerBtn.parentNode.removeChild(timerBtn);
		if (host.parentNode) host.parentNode.removeChild(host);
		if (style.parentNode) style.parentNode.removeChild(style);
		delete window.__wintimerScriptRunning;
		if (window.winwidgetTimer && window.winwidgetTimer.key === KEY)
			delete window.winwidgetTimer;
	}

	timerBtn.addEventListener('click', handleButtonClick);
	backdrop.addEventListener('click', handleBackdropClick);
	window.addEventListener(
		'winwidget:timer:updated',
		handleExternalRefresh
	);
	window.addEventListener('storage', handleStorageRefresh);

	window.winwidgetTimer = {
		key: KEY,
		open: openModal,
		close: closeModal,
		refresh: refreshConfig,
		destroy: destroyWidget
	};

	loadConfig({ initial: true });
})();
