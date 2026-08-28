(function () {
	'use strict';

	var SYSTEM_FONT_STACK =
		"system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

	var _currentScript = document.currentScript;
	var KEY =
		(_currentScript && _currentScript.getAttribute('data-key')) || '';
	if (!KEY) {
		console.warn('[wincallback] Missing required data-key attribute.');
		return;
	}
	if (window.__wincallbackScriptRunning) {
		console.warn(
			'[wincallback] Duplicate script ignored; only one callback widget instance is supported per page.'
		);
		return;
	}
	var INSTANCE_TOKEN = {};
	window.__wincallbackScriptRunning = INSTANCE_TOKEN;

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

	var RUNTIME_VERSION = '2026.08.28-callback-otp';
	var PUBLISHED_VERSION = 0;
	var telemetryEventsSent = Object.create(null);

	function updatePublishedVersion(value) {
		var nextVersion = Number(value);
		if (!Number.isInteger(nextVersion) || nextVersion < 1) nextVersion = 0;
		if (nextVersion !== PUBLISHED_VERSION) {
			telemetryEventsSent = Object.create(null);
		}
		PUBLISHED_VERSION = nextVersion;
	}

	function sendTelemetryEvent(eventName) {
		if (
			!Number.isInteger(PUBLISHED_VERSION) ||
			PUBLISHED_VERSION < 1 ||
			(eventName !== 'IMPRESSION' &&
				eventName !== 'OPEN' &&
				eventName !== 'START' &&
				eventName !== 'COMPLETE') ||
			telemetryEventsSent[eventName]
		) {
			return;
		}

		if (eventName === 'OPEN') {
			sendTelemetryEvent('IMPRESSION');
		} else if (eventName === 'START') {
			sendTelemetryEvent('IMPRESSION');
			sendTelemetryEvent('OPEN');
		} else if (eventName === 'COMPLETE') {
			sendTelemetryEvent('START');
		}

		telemetryEventsSent[eventName] = true;
		try {
			var request = fetch(
				API_BASE + '/widget-events/callback/' + encodeURIComponent(KEY),
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						event: eventName,
						runtimeVersion: RUNTIME_VERSION,
						publishedVersion: PUBLISHED_VERSION
					}),
					keepalive: true,
					credentials: 'omit',
					referrerPolicy: 'no-referrer'
				}
			);
			if (request && typeof request.catch === 'function') {
				request.catch(function () {});
			}
		} catch (e) {}
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
				console.warn('[wincallback] Failed to load phone formatter:', e);
				return null;
			});
	}

	var AUTO_OPEN = Boolean(
		window.wincallbackAutoOpen ||
		window.winwidgetCallbackAutoOpen ||
		(window.winwidget && window.winwidget.autoOpen)
	);
	var widgetLayerZIndex = AUTO_OPEN ? '2147483647' : '10000';

	function getWidgetFetchOptions(options) {
		var next = options || {};
		if (AUTO_OPEN) next.referrerPolicy = 'unsafe-url';
		return next;
	}

	function getSafeExternalUrl(value) {
		if (typeof value !== 'string' || !value.trim()) return '';
		try {
			var url = new URL(value.trim(), window.location.href);
			if (url.protocol === 'http:' || url.protocol === 'https:') {
				return url.href;
			}
		} catch (e) {}
		return '';
	}

	function readResponseJson(response) {
		return response.text().then(function (text) {
			if (!text) return null;
			try {
				return JSON.parse(text);
			} catch (e) {
				return null;
			}
		});
	}

	function getResponseMessage(data, fallback) {
		if (data && typeof data.message === 'string' && data.message.trim()) {
			return data.message.trim();
		}
		if (data && Array.isArray(data.message) && data.message.length) {
			return data.message.join('. ');
		}
		return fallback;
	}

	function fetchJson(url, options) {
		return fetch(url, getWidgetFetchOptions(options)).then(
			function (response) {
				return readResponseJson(response).then(function (data) {
					if (!response.ok) {
						var error = new Error(
							getResponseMessage(data, 'Не удалось выполнить запрос')
						);
						error.status = response.status;
						error.data = data;
						var retryAfterSeconds = Number(
							response.headers.get('Retry-After')
						);
						if (
							Number.isFinite(retryAfterSeconds) &&
							retryAfterSeconds > 0
						) {
							error.retryAfterSeconds = Math.ceil(retryAfterSeconds);
						}
						throw error;
					}
					return data;
				});
			}
		);
	}

	// ─── Phone mask ───────────────────────────────────────────────────────────

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

		var masked = maskDef.mask;
		var i = 0;
		masked = masked.replace(/#/g, function () {
			return i < digits.length ? digits[i++] : '_';
		});
		return masked;
	}

	function getRawDigits(masked, maskDef) {
		var prefix = maskDef.mask.split('#')[0];
		var prefixDigits = prefix.replace(/\D/g, '');
		var body = masked.replace(/\D/g, '');
		if (body.startsWith(prefixDigits))
			body = body.slice(prefixDigits.length);
		return body.replace(/_/g, '');
	}

	function isPhoneComplete(masked, maskDef) {
		return getRawDigits(masked, maskDef).length >= maskDef.digits;
	}

	// ─── State ────────────────────────────────────────────────────────────────

	var cfg = null;
	var isOpen = false;
	var submitted = false;
	var previousBodyStyles = null;
	var destroyed = false;
	var pendingOpen = false;
	var configRequestController = null;
	var formRequestController = null;
	var activePhoneController = null;
	var resendTimerId = null;
	var bubbleShowTimerId = null;
	var autoOpenTimerId = null;
	var buttonAnimation = null;
	var managedTimeoutIds = [];
	var managedAnimationFrameIds = [];
	var publicApi = null;

	function setManagedTimeout(callback, delay) {
		var timeoutId = window.setTimeout(function () {
			managedTimeoutIds = managedTimeoutIds.filter(function (item) {
				return item !== timeoutId;
			});
			if (!destroyed) callback();
		}, delay);
		managedTimeoutIds.push(timeoutId);
		return timeoutId;
	}

	function clearManagedTimeout(timeoutId) {
		if (timeoutId === null || typeof timeoutId === 'undefined') return;
		window.clearTimeout(timeoutId);
		managedTimeoutIds = managedTimeoutIds.filter(function (item) {
			return item !== timeoutId;
		});
	}

	function requestManagedAnimationFrame(callback) {
		var frameId = window.requestAnimationFrame(function () {
			managedAnimationFrameIds = managedAnimationFrameIds.filter(
				function (item) {
					return item !== frameId;
				}
			);
			if (!destroyed) callback();
		});
		managedAnimationFrameIds.push(frameId);
		return frameId;
	}

	function clearManagedAsyncWork() {
		managedTimeoutIds.forEach(function (timeoutId) {
			window.clearTimeout(timeoutId);
		});
		managedTimeoutIds = [];
		managedAnimationFrameIds.forEach(function (frameId) {
			window.cancelAnimationFrame(frameId);
		});
		managedAnimationFrameIds = [];
		resendTimerId = null;
		bubbleShowTimerId = null;
		autoOpenTimerId = null;
	}

	function abortController(controller) {
		if (controller && typeof controller.abort === 'function') {
			try {
				controller.abort();
			} catch (e) {}
		}
	}

	function createRequestController() {
		return typeof AbortController === 'function'
			? new AbortController()
			: null;
	}

	function disposeFormState() {
		if (
			activePhoneController &&
			typeof activePhoneController.destroy === 'function'
		) {
			activePhoneController.destroy();
		}
		activePhoneController = null;
		abortController(formRequestController);
		formRequestController = null;
		clearManagedTimeout(resendTimerId);
		resendTimerId = null;
	}

	function firePixelEvent(goalName) {
		if (cfg && cfg.yandexMetrikaId && typeof window.ym === 'function') {
			try {
				window.ym(Number(cfg.yandexMetrikaId), 'reachGoal', goalName);
			} catch (e) {}
		}
		if (
			cfg &&
			cfg.vkPixelId &&
			window.VK &&
			typeof window.VK.Goal === 'function'
		) {
			try {
				window.VK.Goal(goalName);
			} catch (e) {}
		}
		if (
			cfg &&
			cfg.roistatEnabled &&
			window.roistat &&
			window.roistat.event &&
			typeof window.roistat.event.send === 'function'
		) {
			try {
				window.roistat.event.send(goalName);
			} catch (e) {}
		}
	}

	// ─── Floating button ──────────────────────────────────────────────────────

	var cbBtn = document.createElement('div');
	cbBtn.id = 'callback-widget-button';
	cbBtn.innerHTML = [
		'<div id="wcb-bubble" style="',
		'display:none;position:absolute;top:50%;transform:translateY(-50%) scale(0.85);',
		'background:#fff;border-radius:18px;padding:12px 34px 12px 16px;',
		'width:172px;box-sizing:border-box;',
		'border:1px solid rgba(71,5,251,0.12);',
		'box-shadow:0 16px 40px rgba(71,5,251,0.18),0 8px 18px rgba(15,23,42,0.08);',
		'cursor:pointer;opacity:0;',
		'transition:opacity 0.3s ease,transform 0.35s cubic-bezier(.22,1,.36,1);',
		'font-family:' + SYSTEM_FONT_STACK + ';',
		'">',
		'<button id="wcb-bubble-close" style="',
		'position:absolute;top:7px;right:8px;background:none;border:none;',
		'font-size:11px;cursor:pointer;color:#ccc;line-height:1;padding:2px;',
		'display:flex;align-items:center;justify-content:center;',
		'width:16px;height:16px;border-radius:50%;',
		'">✕</button>',
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
		'<img id="wcb-btn-icon" src="' +
			getWidgetAssetUrl('callback-button.png') +
			'" alt="" aria-hidden="true" draggable="false" style="',
		'width:60px;height:60px;display:block;object-fit:contain;line-height:1;',
		'filter:drop-shadow(0 6px 24px rgba(71,5,251,0.45)) drop-shadow(0 2px 8px rgba(0,0,0,0.22));',
		'transform-origin:50% 100%;',
		'transition:filter 0.4s ease,transform 0.2s cubic-bezier(.34,1.56,.64,1);',
		'" />',
		''
	].join('');

	cbBtn.style.cssText = [
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

	document.body.appendChild(cbBtn);

	var styleAnim = document.createElement('style');
	styleAnim.textContent = [
		'@keyframes wcbBounce{0%,100%{transform:translateY(0) scale(1)}10%{transform:translateY(-16px) scale(1.1)}20%{transform:translateY(0) scale(1)}30%{transform:translateY(-6px) scale(1.04)}40%{transform:translateY(0) scale(1)}}',
		'@keyframes wcbSway{0%,100%{transform:rotate(0)}25%{transform:rotate(-6deg)}75%{transform:rotate(6deg)}}',
		'@keyframes wcbGlow{0%,100%{filter:drop-shadow(0 6px 16px rgba(0,0,0,0.35)) drop-shadow(0 2px 4px rgba(0,0,0,0.2))}50%{filter:drop-shadow(0 8px 28px rgba(101,16,255,0.7)) drop-shadow(0 2px 12px rgba(37,117,252,0.5))}}',
		'@keyframes wcbShake{0%,100%{transform:translateX(0)}12%{transform:translateX(-5px)}25%{transform:translateX(5px)}37%{transform:translateX(-4px)}50%{transform:translateX(4px)}62%{transform:translateX(-2px)}75%{transform:translateX(2px)}87%{transform:translateX(-1px)}}',
		'.wcb-field-err{border-color:#ef4444!important;box-shadow:0 0 0 3px rgba(239,68,68,0.15)!important}',
		'.wcb-shake{animation:wcbShake 420ms ease}',
		'.wcb-err-text{color:#ef4444;font-size:11px;margin-top:5px;display:none;padding-left:2px}',
		'.wcb-err-text.wcb-err-show{display:block}',
		'#wcb-bubble:hover{opacity:0.95!important}',
		'#wcb-bubble-close:hover{color:#888!important}',
		'#callback-widget-overlay{align-items:center!important}',
		'@media(max-width:480px){',
		'#callback-widget-overlay{padding:12px!important}',
		'#wcb-modal{padding:20px 16px 20px!important}',
		'#wcb-bubble{display:none!important}',
		'}',
		'#wcb-brand{text-align:center;font-size:12px;color:#6b6378;margin-top:12px;line-height:1.5;letter-spacing:0.2px}',
		'#wcb-brand a{color:#4705fb;text-decoration:none;font-weight:600}',
		'#wcb-brand a:hover{color:#3210bb}'
	].join('');
	document.head.appendChild(styleAnim);

	var buttonAnimationActive = false;
	var buttonPulseEnabled = true;
	var scrollTriggered = false;

	function startButtonAnimation() {
		if (buttonAnimationActive) return;
		buttonAnimationActive = true;
		cbBtn.style.animation = [
			'wcbBounce 3s ease-in-out infinite',
			'wcbSway 4s ease-in-out infinite',
			buttonPulseEnabled ? 'wcbGlow 2.5s ease-in-out infinite' : ''
		]
			.filter(Boolean)
			.join(',');
	}

	function stopButtonAnimation() {
		buttonAnimationActive = false;
		cbBtn.style.animation = 'none';
	}

	function handleWindowScroll() {
		if (scrollTriggered || destroyed || !canShowLauncher()) return;
		scrollTriggered = true;
		if (typeof cbBtn.animate === 'function') {
			buttonAnimation = cbBtn.animate(
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
		}
		startButtonAnimation();
	}

	window.addEventListener('scroll', handleWindowScroll, { passive: true });

	// ─── Modal ────────────────────────────────────────────────────────────────

	var host = document.createElement('div');
	host.id = 'callback-widget-host';
	document.body.appendChild(host);
	var shadow = host.attachShadow({ mode: 'open' });
	var shadowStyle = document.createElement('style');
	shadowStyle.textContent = styleAnim.textContent;
	shadow.appendChild(shadowStyle);

	var overlay = document.createElement('div');
	overlay.id = 'callback-widget-overlay';
	overlay.style.cssText = [
		'position:fixed',
		'inset:0',
		'z-index:' + widgetLayerZIndex,
		'display:none',
		'align-items:center',
		'justify-content:center',
		'padding:16px',
		'box-sizing:border-box'
	].join(';');

	var backdrop = document.createElement('div');
	backdrop.style.cssText =
		'position:absolute;inset:0;background:rgba(8,4,20,0.85);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);touch-action:none;';
	overlay.appendChild(backdrop);

	var modal = document.createElement('div');
	modal.id = 'wcb-modal';
	modal.style.cssText = [
		'position:relative',
		'width:100%',
		'max-width:400px',
		'background:#fff',
		'border-radius:20px',
		'padding:28px 24px 24px',
		'box-sizing:border-box',
		'box-shadow:0 24px 80px rgba(0,0,0,0.22)',
		'font-family:' + SYSTEM_FONT_STACK,
		'max-height:calc(100svh - 48px)',
		'overflow-y:auto',
		'-webkit-overflow-scrolling:touch',
		'transform:translateY(40px)',
		'opacity:0',
		'transition:transform 380ms cubic-bezier(.22,1,.36,1),opacity 280ms ease'
	].join(';');
	overlay.appendChild(modal);
	shadow.appendChild(overlay);

	// ─── Helpers ──────────────────────────────────────────────────────────────

	function css(el, obj) {
		Object.keys(obj).forEach(function (k) {
			el.style[k] = obj[k];
		});
	}

	function el(tag, styles, html) {
		var e = document.createElement(tag);
		if (styles) css(e, styles);
		if (html) e.innerHTML = html;
		return e;
	}

	function shakeInput(input) {
		input.classList.remove('wcb-shake');
		void input.offsetWidth;
		input.classList.add('wcb-shake');
		setManagedTimeout(function () {
			input.classList.remove('wcb-shake');
		}, 450);
	}

	function positionButton() {
		if (!cfg) return;
		var side = cfg.buttonSide === 'left' ? 'left' : 'right';
		var opp = side === 'left' ? 'right' : 'left';
		cbBtn.style.bottom = (cfg.buttonBottom || 3) + '%';
		cbBtn.style[side] = (cfg.buttonOffset || 3) + '%';
		cbBtn.style[opp] = 'auto';
	}

	function updateBubbleSide(side) {
		var bubble = document.getElementById('wcb-bubble');
		var tail = document.getElementById('wcb-bubble-tail');
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

	function hexToRgb(hex) {
		var r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
		return r
			? {
					r: parseInt(r[1], 16),
					g: parseInt(r[2], 16),
					b: parseInt(r[3], 16)
				}
			: null;
	}

	function applyColor(color) {
		var icon = document.getElementById('wcb-btn-icon');
		if (!icon || !color) return;
		var rgb = hexToRgb(color);
		if (!rgb) return;
		var glowColor = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.6)';
		icon.style.filter =
			'drop-shadow(0 6px 24px ' +
			glowColor +
			') drop-shadow(0 2px 8px rgba(0,0,0,0.25))';
	}

	// ─── Build modal content ──────────────────────────────────────────────────

	function buildBrand() {
		if (
			cfg &&
			(cfg.developInfoActive === false || cfg.hideBranding === true)
		)
			return document.createDocumentFragment();
		var wrap = document.createElement('div');
		wrap.id = 'wcb-brand';
		wrap.innerHTML =
			'Сделано в&nbsp;<a href="https://winwidget.ru" target="_blank" rel="noopener">winwidget.ru</a>';
		return wrap;
	}

	function buildForm() {
		disposeFormState();
		modal.innerHTML = '';

		var closeBtn = el(
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
		closeBtn.setAttribute('aria-label', 'Закрыть');
		if (AUTO_OPEN) closeBtn.style.display = 'none';
		closeBtn.onclick = function () {
			closeModal();
		};
		modal.appendChild(closeBtn);

		var accentColor = cfg.color || '#4705fb';
		var btnColor = cfg.buttonColor || accentColor;
		var privacyUrl = getSafeExternalUrl(cfg.privacyUrl);
		var verificationMode = cfg.verificationMode;

		if (cfg.title) {
			var titleEl = el('h2', {
				margin: '0 0 6px',
				fontSize: '20px',
				fontWeight: '700',
				color: '#1a1a1a',
				lineHeight: '1.3',
				paddingRight: '24px'
			});
			titleEl.textContent = cfg.title;
			modal.appendChild(titleEl);
		}

		if (cfg.subtitle) {
			var subtitleEl = el('p', {
				margin: '0 0 20px',
				fontSize: '13px',
				color: '#888',
				lineHeight: '1.5'
			});
			subtitleEl.textContent = cfg.subtitle;
			modal.appendChild(subtitleEl);
		}

		// ── Phone input ──────────────────────────────────────────────────────────

		var phoneValid = false;
		var phoneController = null;

		var phoneWrap = el('div', { marginBottom: '12px' });

		var phoneInput = document.createElement('input');
		phoneInput.type = 'tel';
		phoneInput.autocomplete = 'tel';
		phoneInput.placeholder = '+7 999 123-45-67';
		css(phoneInput, {
			width: '100%',
			boxSizing: 'border-box',
			padding: '12px 14px',
			fontSize: '16px',
			border: '1.5px solid #e0d6f0',
			borderRadius: '12px',
			outline: 'none',
			fontFamily: 'inherit',
			transition: 'border-color 0.2s, box-shadow 0.2s'
		});

		var phoneErrText = document.createElement('div');
		phoneErrText.className = 'wcb-err-text';
		phoneErrText.textContent = 'Введите корректный номер телефона';

		function clearPhoneErr() {
			phoneInput.classList.remove('wcb-field-err');
			phoneErrText.classList.remove('wcb-err-show');
		}

		function showPhoneErr() {
			phoneInput.classList.add('wcb-field-err');
			phoneErrText.classList.add('wcb-err-show');
			shakeInput(phoneInput);
			phoneInput.focus();
		}

		phoneInput.addEventListener('focus', function () {
			if (!phoneInput.classList.contains('wcb-field-err')) {
				phoneInput.style.borderColor = accentColor;
				phoneInput.style.boxShadow = '0 0 0 3px ' + accentColor + '22';
			}
		});
		phoneInput.addEventListener('blur', function () {
			if (!phoneInput.classList.contains('wcb-field-err')) {
				phoneInput.style.borderColor = '#e0d6f0';
				phoneInput.style.boxShadow = 'none';
			}
		});
		phoneInput.addEventListener('input', function () {
			sendTelemetryEvent('START');
		});

		phoneWrap.appendChild(phoneInput);
		phoneWrap.appendChild(phoneErrText);
		modal.appendChild(phoneWrap);

		// ── Time slot select ─────────────────────────────────────────────────────

		var timeSelect = null;
		if (cfg.timeSlots && cfg.timeSlots.length > 0) {
			var timeWrap = el('div', { marginBottom: '12px' });
			var timeLabel = el('label', {
				display: 'block',
				fontSize: '12px',
				color: '#888',
				marginBottom: '4px',
				fontWeight: '500'
			});
			timeLabel.textContent = 'Удобное время для звонка';

			timeSelect = document.createElement('select');
			css(timeSelect, {
				width: '100%',
				boxSizing: 'border-box',
				padding: '12px 40px 12px 14px',
				fontSize: '15px',
				border: '1.5px solid #e0d6f0',
				borderRadius: '12px',
				outline: 'none',
				fontFamily: 'inherit',
				background: '#fff',
				color: '#1a1a1a',
				cursor: 'pointer',
				transition: 'border-color 0.2s, box-shadow 0.2s',
				webkitAppearance: 'none',
				appearance: 'none',
				backgroundImage:
					"url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24'%3E%3Cpath fill='%23888' d='M7 10l5 5 5-5z'/%3E%3C/svg%3E\")",
				backgroundRepeat: 'no-repeat',
				backgroundPosition: 'right 12px center'
			});
			timeSelect.addEventListener('focus', function () {
				timeSelect.style.borderColor = accentColor;
				timeSelect.style.boxShadow = '0 0 0 3px ' + accentColor + '22';
			});
			timeSelect.addEventListener('blur', function () {
				timeSelect.style.borderColor = '#e0d6f0';
				timeSelect.style.boxShadow = 'none';
			});
			timeSelect.addEventListener('change', function () {
				sendTelemetryEvent('START');
			});

			cfg.timeSlots.forEach(function (slot) {
				var opt = document.createElement('option');
				opt.value = slot;
				opt.textContent = slot;
				timeSelect.appendChild(opt);
			});

			timeWrap.appendChild(timeLabel);
			timeWrap.appendChild(timeSelect);
			modal.appendChild(timeWrap);
		}

		// ── Optional email verification contact ─────────────────────────────────

		var emailInput = null;
		var emailErrText = null;
		if (verificationMode === 'EMAIL') {
			var emailWrap = el('div', { marginBottom: '12px' });
			var emailLabel = el('label', {
				display: 'block',
				fontSize: '12px',
				color: '#888',
				marginBottom: '4px',
				fontWeight: '500'
			});
			emailLabel.textContent = 'Email для получения кода';
			emailInput = document.createElement('input');
			emailInput.type = 'email';
			emailInput.autocomplete = 'email';
			emailInput.inputMode = 'email';
			emailInput.placeholder = 'name@example.com';
			css(emailInput, {
				width: '100%',
				boxSizing: 'border-box',
				padding: '12px 14px',
				fontSize: '16px',
				border: '1.5px solid #e0d6f0',
				borderRadius: '12px',
				outline: 'none',
				fontFamily: 'inherit',
				transition: 'border-color 0.2s, box-shadow 0.2s'
			});
			emailErrText = document.createElement('div');
			emailErrText.className = 'wcb-err-text';
			emailErrText.textContent = 'Введите корректный email';
			emailInput.addEventListener('focus', function () {
				if (!emailInput.classList.contains('wcb-field-err')) {
					emailInput.style.borderColor = accentColor;
					emailInput.style.boxShadow = '0 0 0 3px ' + accentColor + '22';
				}
			});
			emailInput.addEventListener('blur', function () {
				if (!emailInput.classList.contains('wcb-field-err')) {
					emailInput.style.borderColor = '#e0d6f0';
					emailInput.style.boxShadow = 'none';
				}
			});
			emailWrap.appendChild(emailLabel);
			emailWrap.appendChild(emailInput);
			emailWrap.appendChild(emailErrText);
			modal.appendChild(emailWrap);
		}

		// ── OTP code ─────────────────────────────────────────────────────────────

		var codeWrap = el('div', {
			display: 'none',
			marginBottom: '12px'
		});
		var codeLabel = el('label', {
			display: 'block',
			fontSize: '12px',
			color: '#888',
			marginBottom: '4px',
			fontWeight: '500'
		});
		codeLabel.textContent = 'Код подтверждения';
		var destinationHint = el('div', {
			fontSize: '12px',
			color: '#6b6378',
			lineHeight: '1.4',
			marginBottom: '8px'
		});
		var codeInput = document.createElement('input');
		codeInput.type = 'text';
		codeInput.autocomplete = 'one-time-code';
		codeInput.inputMode = 'numeric';
		codeInput.pattern = '[0-9]*';
		codeInput.maxLength = 6;
		codeInput.placeholder = '000000';
		css(codeInput, {
			width: '100%',
			boxSizing: 'border-box',
			padding: '12px 14px',
			fontSize: '20px',
			fontWeight: '700',
			letterSpacing: '0.2em',
			textAlign: 'center',
			border: '1.5px solid #e0d6f0',
			borderRadius: '12px',
			outline: 'none',
			fontFamily: 'inherit',
			transition: 'border-color 0.2s, box-shadow 0.2s'
		});
		var codeErrText = document.createElement('div');
		codeErrText.className = 'wcb-err-text';
		codeErrText.textContent = 'Введите шестизначный код';
		var resendBtn = el('button', {
			display: 'block',
			margin: '8px auto 0',
			padding: '4px 8px',
			border: 'none',
			background: 'transparent',
			color: accentColor,
			fontSize: '12px',
			fontWeight: '600',
			cursor: 'pointer',
			fontFamily: 'inherit'
		});
		resendBtn.type = 'button';
		resendBtn.textContent = 'Отправить код ещё раз';
		codeWrap.appendChild(codeLabel);
		codeWrap.appendChild(destinationHint);
		codeWrap.appendChild(codeInput);
		codeWrap.appendChild(codeErrText);
		codeWrap.appendChild(resendBtn);
		if (verificationMode !== 'OFF') modal.appendChild(codeWrap);

		// ── Submit button ────────────────────────────────────────────────────────

		var submitBtn = el('button', {
			width: '100%',
			padding: '14px',
			fontSize: '15px',
			fontWeight: '700',
			color: '#fff',
			border: 'none',
			borderRadius: '12px',
			cursor: 'pointer',
			background:
				'linear-gradient(135deg,' + btnColor + ',' + btnColor + 'cc)',
			marginBottom: privacyUrl ? '12px' : '0',
			transition: 'opacity 0.2s, transform 0.15s',
			opacity: '0.5'
		});
		submitBtn.type = 'button';
		var submitError = document.createElement('div');
		submitError.className = 'wcb-err-text';
		submitError.style.textAlign = 'center';
		submitError.style.marginBottom = '12px';
		var state = {
			phase: 'CONTACT',
			challengeId: '',
			contact: '',
			expiresAt: 0,
			resendAvailableAt: 0,
			destinationHint: ''
		};

		function getPhone() {
			return phoneController ? phoneController.getNumber() : null;
		}

		function getEmail() {
			return emailInput ? emailInput.value.trim() : '';
		}

		function isEmailValid() {
			return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(getEmail());
		}

		function getVerificationContact() {
			return verificationMode === 'SMS' ? getPhone() || '' : getEmail();
		}

		function setFieldDisabled(disabled) {
			phoneInput.disabled = disabled;
			if (timeSelect) timeSelect.disabled = disabled;
			if (emailInput) emailInput.disabled = disabled;
			codeInput.disabled = disabled;
		}

		function clearEmailErr() {
			if (!emailInput || !emailErrText) return;
			emailInput.classList.remove('wcb-field-err');
			emailErrText.classList.remove('wcb-err-show');
		}

		function showEmailErr() {
			if (!emailInput || !emailErrText) return;
			emailInput.classList.add('wcb-field-err');
			emailErrText.classList.add('wcb-err-show');
			shakeInput(emailInput);
			emailInput.focus();
		}

		function clearCodeErr() {
			codeInput.classList.remove('wcb-field-err');
			codeErrText.classList.remove('wcb-err-show');
		}

		function showCodeErr(message) {
			codeErrText.textContent = message || 'Введите шестизначный код';
			codeInput.classList.add('wcb-field-err');
			codeErrText.classList.add('wcb-err-show');
			shakeInput(codeInput);
			codeInput.focus();
		}

		function showSubmitError(message) {
			submitError.textContent = message;
			submitError.classList.add('wcb-err-show');
		}

		function clearSubmitError() {
			submitError.classList.remove('wcb-err-show');
		}

		function canContinue() {
			if (!phoneValid) return false;
			if (verificationMode === 'EMAIL' && !isEmailValid()) return false;
			if (state.phase === 'CODE') {
				return /^\d{6}$/.test(codeInput.value);
			}
			return true;
		}

		function syncSubmitButton() {
			var busy =
				state.phase === 'STARTING' || state.phase === 'SUBMITTING';
			var retryRemainingSeconds =
				state.phase === 'CONTACT'
					? Math.max(
							0,
							Math.ceil((state.resendAvailableAt - Date.now()) / 1000)
						)
					: 0;
			var coolingDown = retryRemainingSeconds > 0;
			submitBtn.disabled = busy || coolingDown;
			setFieldDisabled(busy);
			if (state.phase === 'STARTING') {
				submitBtn.textContent = 'Отправляем код...';
			} else if (state.phase === 'SUBMITTING') {
				submitBtn.textContent = 'Отправляем...';
			} else if (state.phase === 'CODE') {
				submitBtn.textContent = 'Подтвердить и отправить';
			} else if (coolingDown) {
				submitBtn.textContent =
					'Повторить через ' + retryRemainingSeconds + ' с';
			} else if (verificationMode === 'OFF') {
				submitBtn.textContent = cfg.submitButtonText || 'Заказать звонок';
			} else {
				submitBtn.textContent = 'Получить код';
			}
			submitBtn.style.opacity =
				busy || coolingDown || !canContinue() ? '0.5' : '1';
		}

		function resetChallenge(message) {
			state.phase = 'CONTACT';
			state.challengeId = '';
			state.contact = '';
			state.expiresAt = 0;
			state.resendAvailableAt = 0;
			state.destinationHint = '';
			codeInput.value = '';
			codeWrap.style.display = 'none';
			clearCodeErr();
			clearManagedTimeout(resendTimerId);
			resendTimerId = null;
			if (message) showSubmitError(message);
			syncSubmitButton();
		}

		function invalidateChallengeIfContactChanged() {
			if (
				state.phase === 'CODE' &&
				getVerificationContact() !== state.contact
			) {
				resetChallenge('Контакт изменён. Получите новый код.');
			}
		}

		function updateResendCountdown() {
			clearManagedTimeout(resendTimerId);
			resendTimerId = null;
			if (state.phase !== 'CODE' && state.phase !== 'CONTACT') return;
			var remainingSeconds = Math.max(
				0,
				Math.ceil((state.resendAvailableAt - Date.now()) / 1000)
			);
			if (state.phase === 'CODE') {
				resendBtn.disabled = remainingSeconds > 0;
				resendBtn.style.opacity = remainingSeconds > 0 ? '0.55' : '1';
				resendBtn.style.cursor =
					remainingSeconds > 0 ? 'default' : 'pointer';
				resendBtn.textContent = remainingSeconds
					? 'Повторить через ' + remainingSeconds + ' с'
					: 'Отправить код ещё раз';
			} else {
				syncSubmitButton();
			}
			if (remainingSeconds > 0) {
				resendTimerId = setManagedTimeout(updateResendCountdown, 1000);
			}
		}

		function validateContact() {
			if (!phoneValid) {
				showPhoneErr();
				return false;
			}
			if (verificationMode === 'EMAIL' && !isEmailValid()) {
				showEmailErr();
				return false;
			}
			return true;
		}

		function finishFormRequest(controller) {
			if (formRequestController === controller) {
				formRequestController = null;
			}
		}

		function startVerification() {
			if (state.phase === 'STARTING' || state.phase === 'SUBMITTING') {
				return;
			}
			if (state.resendAvailableAt > Date.now()) {
				updateResendCountdown();
				return;
			}
			clearSubmitError();
			clearEmailErr();
			if (!validateContact()) return;

			var wasResend = state.phase === 'CODE';
			var previousState = {
				challengeId: state.challengeId,
				contact: state.contact,
				expiresAt: state.expiresAt,
				resendAvailableAt: state.resendAvailableAt,
				destinationHint: state.destinationHint
			};
			state.phase = 'STARTING';
			syncSubmitButton();
			var payload =
				verificationMode === 'SMS'
					? { phone: getPhone() }
					: { email: getEmail() };
			var requestContact = getVerificationContact();
			var controller = createRequestController();
			formRequestController = controller;

			fetchJson(
				API_BASE +
					'/callback/' +
					encodeURIComponent(KEY) +
					'/verification/start',
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload),
					signal: controller ? controller.signal : undefined
				}
			)
				.then(function (data) {
					if (destroyed) return;
					var expiresAt = Date.parse(data && data.expiresAt);
					var resendAvailableAt = Date.parse(
						data && data.resendAvailableAt
					);
					if (
						!data ||
						typeof data.challengeId !== 'string' ||
						!data.challengeId ||
						!Number.isFinite(expiresAt) ||
						expiresAt <= Date.now() ||
						!Number.isFinite(resendAvailableAt) ||
						typeof data.destinationHint !== 'string'
					) {
						throw new Error('Сервис проверки вернул некорректный ответ');
					}
					state.phase = 'CODE';
					state.challengeId = data.challengeId;
					state.contact = requestContact;
					state.expiresAt = expiresAt;
					state.resendAvailableAt = resendAvailableAt;
					state.destinationHint = data.destinationHint;
					codeInput.value = '';
					destinationHint.textContent =
						'Код отправлен: ' + data.destinationHint;
					codeWrap.style.display = 'block';
					updateResendCountdown();
					syncSubmitButton();
					codeInput.focus();
				})
				.catch(function (error) {
					if (destroyed || (error && error.name === 'AbortError')) return;
					var retryAfterSeconds =
						error &&
						error.status === 429 &&
						Number.isFinite(error.retryAfterSeconds) &&
						error.retryAfterSeconds > 0
							? error.retryAfterSeconds
							: 0;
					if (wasResend && previousState.challengeId) {
						state.phase = 'CODE';
						state.challengeId = previousState.challengeId;
						state.contact = previousState.contact;
						state.expiresAt = previousState.expiresAt;
						state.resendAvailableAt = previousState.resendAvailableAt;
						state.destinationHint = previousState.destinationHint;
						updateResendCountdown();
					} else {
						state.phase = 'CONTACT';
						state.resendAvailableAt = 0;
					}
					if (retryAfterSeconds > 0) {
						state.resendAvailableAt = Math.max(
							state.resendAvailableAt,
							Date.now() + retryAfterSeconds * 1000
						);
						updateResendCountdown();
					}
					showSubmitError(
						error && error.message
							? error.message
							: 'Не удалось отправить код. Попробуйте ещё раз.'
					);
					syncSubmitButton();
				})
				.then(function () {
					finishFormRequest(controller);
				});
		}

		function submitLead() {
			if (state.phase === 'STARTING' || state.phase === 'SUBMITTING') {
				return;
			}
			clearSubmitError();
			clearCodeErr();
			if (!validateContact()) return;

			var payload = {
				phone: getPhone(),
				timeSlot: timeSelect ? timeSelect.value : '',
				timezone: '',
				url: window.location.href
			};
			try {
				payload.timezone =
					Intl.DateTimeFormat().resolvedOptions().timeZone;
			} catch (e) {}

			if (verificationMode !== 'OFF') {
				if (
					state.phase !== 'CODE' ||
					!state.challengeId ||
					getVerificationContact() !== state.contact
				) {
					resetChallenge('Контакт изменён. Получите новый код.');
					return;
				}
				if (Date.now() >= state.expiresAt) {
					resetChallenge('Срок действия кода истёк. Получите новый код.');
					return;
				}
				var code = codeInput.value.replace(/\D/g, '');
				if (!/^\d{6}$/.test(code)) {
					showCodeErr('Введите шестизначный код');
					return;
				}
				payload.challengeId = state.challengeId;
				payload.code = code;
				if (verificationMode === 'EMAIL') {
					payload.email = state.contact;
				}
			}

			state.phase = 'SUBMITTING';
			syncSubmitButton();
			var controller = createRequestController();
			formRequestController = controller;
			fetchJson(
				API_BASE + '/callback/' + encodeURIComponent(KEY) + '/lead',
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload),
					signal: controller ? controller.signal : undefined
				}
			)
				.then(function (data) {
					if (
						!data ||
						data.success !== true ||
						!data.lead ||
						typeof data.lead.id !== 'string' ||
						!data.lead.id
					) {
						throw new Error('Сервис не подтвердил создание заявки');
					}
					if (destroyed) return;
					submitted = true;
					state.phase = 'DONE';
					sendTelemetryEvent('COMPLETE');
					firePixelEvent('wcb_send');
					buildSuccess();
				})
				.catch(function (error) {
					if (destroyed || (error && error.name === 'AbortError')) return;
					if (
						verificationMode !== 'OFF' &&
						(error.status === 409 || error.status === 410)
					) {
						resetChallenge(
							error.message ||
								'Код больше недействителен. Получите новый код.'
						);
						return;
					}
					state.phase = verificationMode === 'OFF' ? 'CONTACT' : 'CODE';
					showSubmitError(
						error && error.message
							? error.message
							: 'Не удалось отправить заявку. Попробуйте ещё раз.'
					);
					if (verificationMode !== 'OFF') {
						showCodeErr(
							error && error.message
								? error.message
								: 'Проверьте код и попробуйте ещё раз'
						);
					}
					syncSubmitButton();
				})
				.then(function () {
					finishFormRequest(controller);
				});
		}

		if (window.winwidgetPhone) {
			phoneController = window.winwidgetPhone.attach(phoneInput, {
				placeholder: '+7 999 123-45-67',
				onChange: function (phone) {
					phoneValid = Boolean(phone);
					clearPhoneErr();
					invalidateChallengeIfContactChanged();
					syncSubmitButton();
				}
			});
			activePhoneController = phoneController;
		}

		if (emailInput) {
			emailInput.addEventListener('input', function () {
				sendTelemetryEvent('START');
				clearEmailErr();
				invalidateChallengeIfContactChanged();
				syncSubmitButton();
			});
		}
		codeInput.addEventListener('focus', function () {
			if (!codeInput.classList.contains('wcb-field-err')) {
				codeInput.style.borderColor = accentColor;
				codeInput.style.boxShadow = '0 0 0 3px ' + accentColor + '22';
			}
		});
		codeInput.addEventListener('blur', function () {
			if (!codeInput.classList.contains('wcb-field-err')) {
				codeInput.style.borderColor = '#e0d6f0';
				codeInput.style.boxShadow = 'none';
			}
		});
		codeInput.addEventListener('input', function () {
			codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
			clearCodeErr();
			clearSubmitError();
			syncSubmitButton();
		});
		resendBtn.addEventListener('click', function () {
			if (!resendBtn.disabled && state.phase === 'CODE') {
				startVerification();
			}
		});

		submitBtn.addEventListener('mouseenter', function () {
			if (!submitBtn.disabled && canContinue()) {
				submitBtn.style.opacity = '0.88';
			}
		});
		submitBtn.addEventListener('mouseleave', syncSubmitButton);
		submitBtn.addEventListener('click', function () {
			sendTelemetryEvent('START');
			if (verificationMode !== 'OFF' && state.phase !== 'CODE') {
				startVerification();
				return;
			}
			submitLead();
		});

		syncSubmitButton();

		modal.appendChild(submitBtn);
		modal.appendChild(submitError);

		// Privacy link
		if (privacyUrl) {
			var privacyEl = el('p', {
				margin: '0',
				fontSize: '11px',
				color: '#bbb',
				textAlign: 'center',
				lineHeight: '1.5'
			});
			privacyEl.appendChild(
				document.createTextNode('Нажимая кнопку, вы соглашаетесь с ')
			);
			var privacyLink = document.createElement('a');
			privacyLink.href = privacyUrl;
			privacyLink.target = '_blank';
			privacyLink.rel = 'noopener noreferrer';
			privacyLink.style.color = '#bbb';
			privacyLink.textContent = 'политикой конфиденциальности';
			privacyEl.appendChild(privacyLink);
			modal.appendChild(privacyEl);
		}
		modal.appendChild(buildBrand());
	}

	function buildSuccess() {
		disposeFormState();
		modal.innerHTML = '';
		var accentColor = cfg.color || '#4705fb';

		var closeBtn = el(
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
		if (AUTO_OPEN) closeBtn.style.display = 'none';
		closeBtn.onclick = function () {
			closeModal();
		};
		modal.appendChild(closeBtn);

		var icon = el('div', {
			width: '60px',
			height: '60px',
			borderRadius: '50%',
			background: accentColor + '18',
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			margin: '0 auto 16px',
			fontSize: '28px'
		});
		icon.textContent = '✓';
		icon.style.color = accentColor;
		modal.appendChild(icon);

		var title = el('h2', {
			margin: '0 0 8px',
			fontSize: '20px',
			fontWeight: '700',
			color: '#1a1a1a',
			textAlign: 'center',
			paddingRight: '0'
		});
		title.textContent = cfg.successTitle || 'Спасибо! Мы перезвоним';
		modal.appendChild(title);

		if (cfg.successSubtitle) {
			var sub = el('p', {
				margin: '0',
				fontSize: '14px',
				color: '#888',
				textAlign: 'center',
				lineHeight: '1.5'
			});
			sub.textContent = cfg.successSubtitle;
			modal.appendChild(sub);
		}
		modal.appendChild(buildBrand());
	}

	// ─── Open / close ─────────────────────────────────────────────────────────

	function lockBody() {
		if (!document.body || previousBodyStyles) return;
		previousBodyStyles = {
			overflow: document.body.style.overflow,
			position: document.body.style.position,
			width: document.body.style.width
		};
		document.body.style.overflow = 'hidden';
		document.body.style.position = 'fixed';
		document.body.style.width = '100%';
	}

	function unlockBody() {
		if (!document.body || !previousBodyStyles) return;
		document.body.style.overflow = previousBodyStyles.overflow;
		document.body.style.position = previousBodyStyles.position;
		document.body.style.width = previousBodyStyles.width;
		previousBodyStyles = null;
	}

	function canShowLauncher() {
		return Boolean(
			cfg &&
			publicApi &&
			publicApi.ready === true &&
			cfg.launcherEnabled === true &&
			!AUTO_OPEN &&
			!(cfg.hasSubmittedByIp && cfg.filterDuplicates)
		);
	}

	function syncLauncherVisibility() {
		if (!canShowLauncher() || isOpen) {
			cbBtn.style.display = 'none';
			stopButtonAnimation();
			return;
		}
		cbBtn.style.display = 'flex';
		cbBtn.style.opacity = '1';
		cbBtn.style.pointerEvents = 'auto';
		cbBtn.style.transform = 'scale(1)';
		startButtonAnimation();
	}

	function openModal() {
		if (destroyed || !publicApi || publicApi.ready !== true || !cfg) {
			if (!destroyed) pendingOpen = true;
			return false;
		}
		if (cfg.hasSubmittedByIp && cfg.filterDuplicates) return false;
		pendingOpen = false;
		if (isOpen) return true;
		isOpen = true;
		cbBtn.style.display = 'none';
		stopButtonAnimation();
		overlay.style.display = 'flex';
		lockBody();
		submitted ? buildSuccess() : buildForm();
		requestManagedAnimationFrame(function () {
			requestManagedAnimationFrame(function () {
				modal.style.transform = 'translateY(0)';
				modal.style.opacity = '1';
			});
		});
		sendTelemetryEvent('OPEN');
		fireEvent('open');
		firePixelEvent('wcb_open');
		return true;
	}

	function closeModal() {
		pendingOpen = false;
		if (!isOpen) return false;
		isOpen = false;
		syncLauncherVisibility();
		unlockBody();
		modal.style.transform = 'translateY(40px)';
		modal.style.opacity = '0';
		setManagedTimeout(function () {
			if (!isOpen) overlay.style.display = 'none';
		}, 300);
		fireEvent('close');
		return true;
	}

	function fireEvent(name) {
		try {
			document.dispatchEvent(
				new CustomEvent('winwidget:callback:' + name, {
					detail: { key: KEY }
				})
			);
		} catch (e) {}
	}

	// ─── Clicks ───────────────────────────────────────────────────────────────

	function hideBubble() {
		var bubble = document.getElementById('wcb-bubble');
		if (!bubble || bubble.style.display === 'none') return;
		bubble.style.opacity = '0';
		bubble.style.transform = 'translateY(-50%) scale(0.85)';
		setManagedTimeout(function () {
			bubble.style.display = 'none';
		}, 300);
	}

	function handleLauncherClick() {
		hideBubble();
		isOpen ? closeModal() : openModal();
	}

	function handleBackdropClick() {
		if (!AUTO_OPEN) closeModal();
	}

	function handleBubbleCloseClick(event) {
		event.stopPropagation();
		hideBubble();
	}

	function handleBubbleClick(event) {
		event.stopPropagation();
		hideBubble();
		openModal();
	}

	cbBtn.addEventListener('click', handleLauncherClick);
	backdrop.addEventListener('click', handleBackdropClick);

	// ─── Init ─────────────────────────────────────────────────────────────────

	function showDisabledPage() {
		var existing = document.getElementById('callback-widget-disabled');
		if (existing) return;
		var el = document.createElement('div');
		el.id = 'callback-widget-disabled';
		el.style.cssText =
			'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0d0d1a;color:#fff;font-family:' +
			SYSTEM_FONT_STACK +
			';text-align:center;padding:24px;z-index:2147483647';
		el.innerHTML =
			'<div style="font-size:3rem;margin-bottom:16px">🔒</div><h1 style="font-size:1.3rem;font-weight:700;margin-bottom:10px">Виджет временно отключен</h1>';
		document.body.appendChild(el);
	}

	// ─── Public API ───────────────────────────────────────────────────────────

	function removeDisabledPage() {
		var disabledPage = document.getElementById('callback-widget-disabled');
		if (disabledPage && disabledPage.parentNode) {
			disabledPage.parentNode.removeChild(disabledPage);
		}
	}

	function validateRuntimeConfig(data) {
		if (!data || typeof data !== 'object') {
			throw new Error('Widget config is missing');
		}
		if (data.isActive !== true) return;
		if (
			data.verificationMode !== 'OFF' &&
			data.verificationMode !== 'SMS' &&
			data.verificationMode !== 'EMAIL'
		) {
			throw new Error(
				'Widget config must contain verificationMode OFF, SMS or EMAIL'
			);
		}
		if (typeof data.launcherEnabled !== 'boolean') {
			throw new Error(
				'Widget config must contain boolean launcherEnabled'
			);
		}
	}

	function applyRuntimeConfig(data) {
		validateRuntimeConfig(data);
		if (!data.isActive) {
			cfg = null;
			publicApi.ready = false;
			cbBtn.style.display = 'none';
			hideBubble();
			if (isOpen) closeModal();
			if (AUTO_OPEN) showDisabledPage();
			console.warn('[wincallback] Widget is inactive');
			return false;
		}

		removeDisabledPage();
		cfg = data;
		updatePublishedVersion(cfg.publishedVersion);
		clearManagedTimeout(bubbleShowTimerId);
		clearManagedTimeout(autoOpenTimerId);
		bubbleShowTimerId = null;
		autoOpenTimerId = null;

		var size = cfg.buttonSize || 60;
		positionButton();
		var iconEl = cbBtn.querySelector('#wcb-btn-icon');
		if (iconEl) {
			iconEl.style.width = size + 'px';
			iconEl.style.height = size + 'px';
			iconEl.onerror = function () {
				iconEl.onerror = null;
				iconEl.src = getWidgetAssetUrl('callback-button.png');
			};
			iconEl.src =
				cfg.buttonImageUrl || getWidgetAssetUrl('callback-button.png');
		}

		applyColor(cfg.openButtonColor || cfg.color || '#4705fb');
		buttonPulseEnabled = cfg.buttonPulse !== false;
		modal.style.background = cfg.bgColor || '#fff';
		updateBubbleSide(cfg.buttonSide || 'right');

		var bubbleEl = document.getElementById('wcb-bubble');
		var bubbleText = document.getElementById('wcb-bubble-text');
		if (bubbleText) {
			bubbleText.textContent =
				cfg.bubbleText || cfg.title || 'Перезвоним!';
		}
		if (bubbleEl) bubbleEl.style.display = 'none';

		if (cfg.hasSubmittedByIp && cfg.filterDuplicates) {
			publicApi.ready = false;
			cbBtn.style.display = 'none';
			if (isOpen) closeModal();
			return false;
		}

		if (isOpen) submitted ? buildSuccess() : buildForm();
		publicApi.ready = true;
		sendTelemetryEvent('IMPRESSION');
		syncLauncherVisibility();
		fireEvent('ready');

		if (canShowLauncher() && cfg.bubbleEnabled !== false && !isOpen) {
			bubbleShowTimerId = setManagedTimeout(function () {
				var bubble = document.getElementById('wcb-bubble');
				if (!bubble || isOpen || !canShowLauncher()) return;
				bubble.style.display = 'block';
				requestManagedAnimationFrame(function () {
					requestManagedAnimationFrame(function () {
						bubble.style.opacity = '1';
						bubble.style.transform = 'translateY(-50%) scale(1)';
					});
				});
			}, 2000);
		}

		if (pendingOpen || AUTO_OPEN) {
			openModal();
		} else if (cfg.autoOpenDelay && cfg.autoOpenDelay > 0) {
			autoOpenTimerId = setManagedTimeout(function () {
				if (!isOpen) openModal();
			}, cfg.autoOpenDelay * 1000);
		}
		return true;
	}

	var phoneHelperPromise = ensurePhoneHelper();

	function refreshWidgetConfig() {
		if (destroyed) return Promise.resolve(false);
		abortController(configRequestController);
		configRequestController = createRequestController();
		var controller = configRequestController;
		publicApi.ready = false;
		return Promise.all([
			phoneHelperPromise,
			fetchJson(
				API_BASE + '/callback/' + encodeURIComponent(KEY) + '/config',
				{
					signal: controller ? controller.signal : undefined
				}
			)
		])
			.then(function (result) {
				if (destroyed || configRequestController !== controller) {
					return false;
				}
				configRequestController = null;
				return applyRuntimeConfig(result[1]);
			})
			.catch(function (error) {
				if (configRequestController === controller) {
					configRequestController = null;
				}
				if (destroyed || (error && error.name === 'AbortError')) {
					return false;
				}
				cbBtn.style.display = 'none';
				console.error('[wincallback] Failed to load config:', error);
				return false;
			});
	}

	function destroyWidget() {
		if (destroyed) return false;
		destroyed = true;
		pendingOpen = false;
		publicApi.ready = false;
		abortController(configRequestController);
		configRequestController = null;
		disposeFormState();
		clearManagedAsyncWork();
		window.removeEventListener('scroll', handleWindowScroll);
		cbBtn.removeEventListener('click', handleLauncherClick);
		backdrop.removeEventListener('click', handleBackdropClick);
		var bubbleClose = document.getElementById('wcb-bubble-close');
		var bubbleEl = document.getElementById('wcb-bubble');
		if (bubbleClose) {
			bubbleClose.removeEventListener('click', handleBubbleCloseClick);
		}
		if (bubbleEl) {
			bubbleEl.removeEventListener('click', handleBubbleClick);
		}
		if (buttonAnimation && typeof buttonAnimation.cancel === 'function') {
			try {
				buttonAnimation.cancel();
			} catch (e) {}
		}
		buttonAnimation = null;
		unlockBody();
		removeDisabledPage();
		if (cbBtn.parentNode) cbBtn.parentNode.removeChild(cbBtn);
		if (host.parentNode) host.parentNode.removeChild(host);
		if (styleAnim.parentNode) styleAnim.parentNode.removeChild(styleAnim);
		if (window.__wincallbackScriptRunning === INSTANCE_TOKEN) {
			delete window.__wincallbackScriptRunning;
		}
		if (window.winwidgetCallback === publicApi) {
			delete window.winwidgetCallback;
		}
		return true;
	}

	publicApi = {
		key: KEY,
		ready: false,
		open: openModal,
		close: closeModal,
		refresh: refreshWidgetConfig,
		destroy: destroyWidget
	};
	window.winwidgetCallback = publicApi;

	var bubbleClose = document.getElementById('wcb-bubble-close');
	var bubbleEl = document.getElementById('wcb-bubble');
	if (bubbleClose) {
		bubbleClose.addEventListener('click', handleBubbleCloseClick);
	}
	if (bubbleEl) {
		bubbleEl.addEventListener('click', handleBubbleClick);
	}

	refreshWidgetConfig();
})();
