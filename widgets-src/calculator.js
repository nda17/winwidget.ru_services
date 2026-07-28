(function () {
	'use strict';

	if (window.__wincalculatorScriptRunning) return;
	window.__wincalculatorScriptRunning = true;

	var SYSTEM_FONT_STACK =
		"system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

	var currentScript = document.currentScript;
	var API_BASE = (function () {
		try {
			var src = new URL(
				currentScript && currentScript.src
					? currentScript.src
					: window.location.href
			);
			return src.origin + '/api/v1';
		} catch (e) {
			return 'https://winwidget.ru/api/v1';
		}
	})();
	var KEY =
		(currentScript && currentScript.getAttribute('data-key')) ||
		window.wincalculator ||
		'';

	if (!KEY) {
		delete window.__wincalculatorScriptRunning;
		return;
	}

	var RUNTIME_VERSION = '2026.07';
	var telemetryEventsSent = Object.create(null);

	function sendTelemetryEvent(eventName) {
		if (
			(eventName !== 'IMPRESSION' &&
				eventName !== 'OPEN' &&
				eventName !== 'START') ||
			telemetryEventsSent[eventName]
		) {
			return;
		}

		if (eventName === 'OPEN') {
			sendTelemetryEvent('IMPRESSION');
		} else if (eventName === 'START') {
			sendTelemetryEvent('IMPRESSION');
			sendTelemetryEvent('OPEN');
		}

		telemetryEventsSent[eventName] = true;
		try {
			var request = fetch(
				API_BASE + '/widget-events/calculator/' + encodeURIComponent(KEY),
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						event: eventName,
						runtimeVersion: RUNTIME_VERSION
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

	var AUTO_OPEN = Boolean(
		window.wincalculatorAutoOpen ||
		window.winwidgetCalculatorAutoOpen ||
		(window.winwidget && window.winwidget.autoOpen)
	);
	var EMAIL_REGEXP =
		/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;

	var cfg = null;
	var host = null;
	var shadow = null;
	var launcher = null;
	var bubble = null;
	var overlay = null;
	var card = null;
	var content = null;
	var closeButton = null;
	var isStarted = false;
	var isDestroyed = false;
	var bodyReadyListenersAttached = false;
	var autoOpenTimer = null;
	var bubbleTimer = null;
	var previousBodyStyles = null;
	var currentAnswers = Object.create(null);
	var currentPrice = 0;

	function getWidgetFetchOptions(options) {
		var next = options || {};
		if (AUTO_OPEN) next.referrerPolicy = 'unsafe-url';
		return next;
	}

	function getWidgetAssetUrl(fileName) {
		try {
			var src = new URL(
				currentScript && currentScript.src
					? currentScript.src
					: window.location.href
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
				if (window.winwidgetPhone) {
					resolve();
					return;
				}
				existing.addEventListener('load', resolve, { once: true });
				existing.addEventListener('error', reject, { once: true });
				return;
			}

			var script = document.createElement('script');
			script.src = src;
			script.async = true;
			script.onload = resolve;
			script.onerror = reject;
			(document.head || document.documentElement).appendChild(script);
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
			.catch(function (error) {
				console.warn(
					'[wincalculator] Failed to load phone formatter:',
					error
				);
				return null;
			});
	}

	function esc(value) {
		return String(value == null ? '' : value)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#039;');
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

	function toFiniteNumber(value, fallback) {
		var number = Number(value);
		return Number.isFinite(number) ? number : fallback;
	}

	function hexToRgba(hex, alpha) {
		var normalized = String(hex || '#4705fb').replace('#', '');
		if (normalized.length === 3) {
			normalized =
				normalized[0] +
				normalized[0] +
				normalized[1] +
				normalized[1] +
				normalized[2] +
				normalized[2];
		}
		var red = parseInt(normalized.slice(0, 2), 16);
		var green = parseInt(normalized.slice(2, 4), 16);
		var blue = parseInt(normalized.slice(4, 6), 16);
		if (![red, green, blue].every(Number.isFinite))
			return 'rgba(71,5,251,' + alpha + ')';
		return 'rgba(' + red + ',' + green + ',' + blue + ',' + alpha + ')';
	}

	function formatPrice(value, currency) {
		var safeValue = Math.max(0, toFiniteNumber(value, 0));
		var safeCurrency = String(currency || 'RUB').toUpperCase();
		try {
			return new Intl.NumberFormat('ru-RU', {
				style: 'currency',
				currency: safeCurrency,
				maximumFractionDigits: 2
			}).format(safeValue);
		} catch (e) {
			return safeValue.toLocaleString('ru-RU') + ' ' + safeCurrency;
		}
	}

	function getOption(field, optionId) {
		var options = Array.isArray(field.options) ? field.options : [];
		for (var index = 0; index < options.length; index += 1) {
			if (String(options[index].id) === String(optionId)) {
				return options[index];
			}
		}
		return null;
	}

	function isBooleanOptionPair(options) {
		if (!Array.isArray(options) || options.length !== 2) return false;
		var labels = options.map(function (option) {
			return String(option && option.label ? option.label : '')
				.trim()
				.toLocaleLowerCase('ru-RU');
		});
		return (
			(labels.indexOf('да') !== -1 && labels.indexOf('нет') !== -1) ||
			(labels.indexOf('yes') !== -1 && labels.indexOf('no') !== -1)
		);
	}

	function calculatePrice(answers) {
		var fields = Array.isArray(cfg && cfg.fields) ? cfg.fields : [];
		var subtotal = Math.max(0, toFiniteNumber(cfg && cfg.basePrice, 0));
		var multiplier = 1;

		function applyOption(option) {
			if (!option) return;
			subtotal += toFiniteNumber(option.add, 0);
			var optionMultiplier = toFiniteNumber(option.multiplier, 1);
			if (optionMultiplier >= 0) multiplier *= optionMultiplier;
		}

		fields.forEach(function (field) {
			var value = answers[field.id];
			if (field.type === 'number') {
				var numberValue = toFiniteNumber(value, 0);
				subtotal += numberValue * toFiniteNumber(field.unitPrice, 0);
				return;
			}

			if (
				field.type === 'checkbox' &&
				!isBooleanOptionPair(field.options)
			) {
				(Array.isArray(value) ? value : []).forEach(function (optionId) {
					applyOption(getOption(field, optionId));
				});
				return;
			}

			applyOption(getOption(field, value));
		});

		var result = Math.max(0, subtotal * multiplier);
		var roundingStep = Math.max(
			0,
			toFiniteNumber(cfg && cfg.roundingStep, 0)
		);
		if (roundingStep > 0) {
			result = Math.round(result / roundingStep) * roundingStep;
		}

		return Number(result.toFixed(2));
	}

	function firePixel(goal) {
		if (!cfg) return;
		if (cfg.yandexMetrikaId && typeof window.ym === 'function') {
			try {
				window.ym(Number(cfg.yandexMetrikaId), 'reachGoal', goal);
			} catch (e) {}
		}
		if (
			cfg.vkPixelId &&
			window.VK &&
			typeof window.VK.Goal === 'function'
		) {
			try {
				window.VK.Goal(goal);
			} catch (e) {}
		}
		if (cfg.roistatEnabled && window.roistat && window.roistat.event) {
			try {
				window.roistat.event.send(goal);
			} catch (e) {}
		}
	}

	function ensureWidgetDom() {
		if (host && host.parentNode && shadow && overlay && card) return true;
		if (!document.body) return false;

		host = document.createElement('div');
		host.id = 'calculator-widget-host';
		document.body.appendChild(host);
		shadow = host.attachShadow({ mode: 'open' });

		var style = document.createElement('style');
		style.textContent = [
			':host{font-family:' + SYSTEM_FONT_STACK + '}',
			'*{box-sizing:border-box}',
			'#wwc-launcher{position:fixed;z-index:9999;display:none;align-items:center;cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent}',
			'#wwc-button{width:60px;height:60px;border:0;border-radius:20px;display:flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(145deg,#7438d4,#4705fb);box-shadow:0 12px 30px rgba(71,5,251,.38);cursor:pointer;animation:wwcPulse 2.8s ease-in-out infinite;transition:transform .2s,filter .2s}',
			'#wwc-button.wwc-default-image{border-radius:0;background:transparent!important;box-shadow:none!important;filter:drop-shadow(0 10px 20px var(--wwc-button-glow,rgba(249,63,31,.42)));animation-name:wwcImagePulse}',
			'#wwc-button:hover{transform:translateY(-2px) scale(1.03);filter:brightness(1.08)}',
			'#wwc-button img{width:100%;height:100%;object-fit:contain}',
			'#wwc-button svg{width:31px;height:31px}',
			'#wwc-bubble{position:absolute;top:50%;width:190px;padding:12px 32px 12px 14px;border:1px solid rgba(71,5,251,.12);border-radius:16px;background:#fff;color:#1d1730;font-size:13px;font-weight:650;line-height:1.35;box-shadow:0 16px 40px rgba(71,5,251,.16);transform:translateY(-50%) scale(.9);opacity:0;pointer-events:none;transition:opacity .25s,transform .25s}',
			'#wwc-bubble.visible{opacity:1;transform:translateY(-50%) scale(1);pointer-events:auto}',
			'#wwc-bubble-close{position:absolute;top:7px;right:8px;width:18px;height:18px;padding:0;border:0;background:transparent;color:#aaa;cursor:pointer}',
			'#wwc-overlay{position:fixed;inset:0;z-index:' +
				(AUTO_OPEN ? '2147483647' : '10000') +
				';display:none;align-items:center;justify-content:center;padding:16px;background:rgba(8,4,20,.84);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);overflow:auto}',
			'#wwc-overlay.visible{display:flex}',
			'#wwc-card{position:relative;width:100%;max-width:520px;max-height:calc(100dvh - 32px);overflow:auto;padding:34px 26px 26px;border:1px solid rgba(255,255,255,.09);border-radius:24px;background:linear-gradient(155deg,#1a0a2e,#0f0520);color:#fff;box-shadow:0 32px 90px rgba(0,0,0,.55)}',
			'#wwc-close{position:absolute;top:12px;right:12px;width:34px;height:34px;border:1px solid rgba(255,255,255,.12);border-radius:50%;background:rgba(255,255,255,.08);color:#fff;font-size:18px;cursor:pointer}',
			'#wwc-brand{position:absolute;top:12px;left:50%;transform:translateX(-50%);font-size:11px;color:rgba(255,255,255,.38);white-space:nowrap}',
			'#wwc-brand a{color:rgba(255,200,50,.78);text-decoration:none}',
			'.wwc-screen{display:flex;flex-direction:column;gap:16px;animation:wwcFade .22s ease}',
			'.wwc-title{font-size:clamp(1.25rem,5vw,1.75rem);font-weight:850;line-height:1.2;overflow-wrap:anywhere}',
			'.wwc-subtitle{font-size:14px;line-height:1.55;color:rgba(255,255,255,.66)}',
			'.wwc-fields{display:flex;flex-direction:column;gap:14px}',
			'.wwc-field{display:flex;flex-direction:column;gap:8px}',
			'.wwc-label{font-size:14px;font-weight:700;color:rgba(255,255,255,.9)}',
			'.wwc-required{color:#fb7185}',
			'.wwc-input,.wwc-select{width:100%;height:50px;padding:0 14px;border:1.5px solid rgba(255,255,255,.12);border-radius:12px;outline:0;background:rgba(255,255,255,.07);color:#fff;font-size:15px;transition:border-color .2s,box-shadow .2s}',
			".wwc-select{-webkit-appearance:none;appearance:none;padding-right:44px;background-image:url(\"data:image/svg+xml,%3Csvg width='16' height='16' viewBox='0 0 16 16' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M4 6L8 10L12 6' stroke='%23FFFFFF' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\");background-repeat:no-repeat;background-position:right 14px center;background-size:16px 16px}",
			'.wwc-select option{color:#111;background:#fff}',
			'.wwc-input:focus,.wwc-select:focus{border-color:#8b5cf6;box-shadow:0 0 0 3px rgba(139,92,246,.15)}',
			'.wwc-input.error,.wwc-select.error{border-color:#ef4444}',
			'.wwc-checks{display:flex;flex-direction:column;gap:8px}',
			'.wwc-check{display:flex;align-items:flex-start;gap:10px;padding:11px 12px;border:1px solid rgba(255,255,255,.1);border-radius:11px;background:rgba(255,255,255,.045);font-size:14px;line-height:1.35;cursor:pointer}',
			'.wwc-check input{margin-top:2px;accent-color:#7c3aed}',
			'.wwc-btn{width:100%;min-height:50px;padding:12px 18px;border:0;border-radius:13px;background:linear-gradient(135deg,#7c3aed,#4705fb);color:#fff;font-size:16px;font-weight:800;cursor:pointer;box-shadow:0 8px 24px rgba(71,5,251,.36);transition:transform .15s,filter .15s}',
			'.wwc-btn:hover{transform:translateY(-1px);filter:brightness(1.08)}',
			'.wwc-btn:disabled{opacity:.55;cursor:not-allowed;transform:none}',
			'.wwc-error{min-height:18px;color:#fb8b82;font-size:13px}',
			'.wwc-price-card{display:flex;flex-direction:column;gap:8px;padding:22px;border:1px solid rgba(167,139,250,.32);border-radius:18px;background:linear-gradient(135deg,rgba(124,58,237,.22),rgba(71,5,251,.12));text-align:center}',
			'.wwc-price-label{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:rgba(255,255,255,.56)}',
			'.wwc-price{font-size:clamp(1.9rem,9vw,3rem);font-weight:900;line-height:1;color:#fff;overflow-wrap:anywhere}',
			'.wwc-price-note{font-size:12px;line-height:1.45;color:rgba(255,255,255,.52)}',
			'.wwc-privacy{font-size:12px;line-height:1.45;text-align:center;color:rgba(255,255,255,.4)}',
			'.wwc-privacy a{color:rgba(255,255,255,.62)}',
			'@keyframes wwcPulse{0%,100%{box-shadow:0 12px 30px rgba(71,5,251,.34)}50%{box-shadow:0 14px 38px rgba(168,85,247,.56)}}',
			'@keyframes wwcImagePulse{0%,100%{filter:drop-shadow(0 10px 20px var(--wwc-button-glow,rgba(249,63,31,.36)))}50%{filter:drop-shadow(0 13px 28px var(--wwc-button-glow,rgba(249,63,31,.58)))}}',
			'@keyframes wwcFade{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}',
			'@media(max-width:520px){#wwc-overlay{padding:10px}#wwc-card{max-height:calc(100dvh - 20px);padding:32px 16px 20px;border-radius:19px}#wwc-bubble{display:none}}'
		].join('');
		shadow.appendChild(style);

		launcher = document.createElement('div');
		launcher.id = 'wwc-launcher';
		launcher.innerHTML = [
			'<div id="wwc-bubble"><button id="wwc-bubble-close" type="button" aria-label="Закрыть">×</button><span id="wwc-bubble-text"></span></div>',
			'<button id="wwc-button" type="button" aria-label="Открыть калькулятор">',
			'<span id="wwc-default-icon" style="display:none"><svg viewBox="0 0 32 32" aria-hidden="true"><rect x="5" y="3" width="22" height="26" rx="5" fill="none" stroke="currentColor" stroke-width="2.4"/><rect x="9" y="7" width="14" height="5" rx="1.5" fill="currentColor" opacity=".9"/><path d="M10 17h2m4 0h2m4 0h1M10 22h2m4 0h2m4 0h1" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg></span>',
			'<img id="wwc-button-image" src="' +
				getWidgetAssetUrl('calculator-button.png') +
				'" alt="" aria-hidden="true" draggable="false" />',
			'</button>'
		].join('');
		shadow.appendChild(launcher);

		overlay = document.createElement('div');
		overlay.id = 'wwc-overlay';
		overlay.innerHTML = [
			'<div id="wwc-card">',
			'<button id="wwc-close" type="button" aria-label="Закрыть">×</button>',
			'<div id="wwc-brand">Сделано в <a href="https://winwidget.ru" target="_blank" rel="noopener">winwidget.ru</a></div>',
			'<div id="wwc-content"></div>',
			'</div>'
		].join('');
		shadow.appendChild(overlay);

		card = shadow.getElementById('wwc-card');
		content = shadow.getElementById('wwc-content');
		closeButton = shadow.getElementById('wwc-close');
		bubble = shadow.getElementById('wwc-bubble');

		shadow
			.getElementById('wwc-button')
			.addEventListener('click', openWidget);
		shadow
			.getElementById('wwc-bubble-close')
			.addEventListener('click', function (event) {
				event.stopPropagation();
				hideBubble();
			});
		bubble.addEventListener('click', function () {
			hideBubble();
			openWidget();
		});
		closeButton.addEventListener('click', closeWidget);
		overlay.addEventListener('click', function (event) {
			if (event.target === overlay && !AUTO_OPEN) closeWidget();
		});

		return true;
	}

	function hideBubble() {
		if (bubbleTimer) clearTimeout(bubbleTimer);
		bubbleTimer = null;
		if (bubble) bubble.classList.remove('visible');
	}

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

	function openWidget() {
		if (isDestroyed || !cfg || !ensureWidgetDom()) return;
		hideBubble();
		overlay.classList.add('visible');
		launcher.style.opacity = '0';
		launcher.style.pointerEvents = 'none';
		lockBody();
		showWelcome();
		sendTelemetryEvent('OPEN');
		firePixel('calculator_open');
	}

	function closeWidget() {
		if (!overlay) return;
		overlay.classList.remove('visible');
		unlockBody();
		if (!AUTO_OPEN && launcher) {
			launcher.style.opacity = '1';
			launcher.style.pointerEvents = 'auto';
		}
	}

	function applyConfig() {
		if (!cfg || !ensureWidgetDom()) return;
		var accent = cfg.color || '#4705fb';
		var buttonColor = cfg.buttonColor || accent;
		var openButtonColor = cfg.openButtonColor || accent;
		var dynamicStyle = shadow.getElementById('wwc-dynamic-style');
		if (!dynamicStyle) {
			dynamicStyle = document.createElement('style');
			dynamicStyle.id = 'wwc-dynamic-style';
			shadow.appendChild(dynamicStyle);
		}
		dynamicStyle.textContent = [
			cfg.glassEffect && !cfg.bgColor
				? '#wwc-card{background:rgba(15,5,32,.78)!important;backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}'
				: '',
			cfg.bgColor
				? '#wwc-card{background:' + cfg.bgColor + '!important}'
				: '',
			cfg.textColor
				? '.wwc-title,.wwc-label,.wwc-price,.wwc-subtitle,.wwc-check,.wwc-price-label,.wwc-price-note,.wwc-privacy,.wwc-privacy a{color:' +
					cfg.textColor +
					'!important}'
				: '',
			'#wwc-button{--wwc-button-glow:' +
				hexToRgba(openButtonColor, 0.42) +
				';background:' +
				openButtonColor +
				'!important;box-shadow:0 12px 30px ' +
				hexToRgba(openButtonColor, 0.42) +
				'!important}',
			'.wwc-btn{background:' +
				buttonColor +
				'!important;box-shadow:0 8px 24px ' +
				hexToRgba(buttonColor, 0.4) +
				'!important}',
			'.wwc-input:focus,.wwc-select:focus{border-color:' +
				accent +
				'!important;box-shadow:0 0 0 3px ' +
				hexToRgba(accent, 0.16) +
				'!important}',
			'.wwc-price-card{border-color:' +
				hexToRgba(accent, 0.38) +
				'!important;background:linear-gradient(135deg,' +
				hexToRgba(accent, 0.24) +
				',' +
				hexToRgba(buttonColor, 0.12) +
				')!important}'
		].join('');

		var side = cfg.buttonSide === 'left' ? 'left' : 'right';
		launcher.style.left =
			side === 'left' ? (cfg.buttonOffset ?? 3) + '%' : '';
		launcher.style.right =
			side === 'right' ? (cfg.buttonOffset ?? 3) + '%' : '';
		launcher.style.bottom = (cfg.buttonBottom ?? 3) + '%';
		launcher.style.display = AUTO_OPEN ? 'none' : 'flex';
		var button = shadow.getElementById('wwc-button');
		var size = Math.max(
			40,
			Math.min(120, toFiniteNumber(cfg.buttonSize, 60))
		);
		button.style.width = size + 'px';
		button.style.height = size + 'px';
		button.style.animation = cfg.buttonPulse === false ? 'none' : '';

		bubble.style.left = side === 'left' ? 'calc(100% + 14px)' : 'auto';
		bubble.style.right = side === 'right' ? 'calc(100% + 14px)' : 'auto';
		shadow.getElementById('wwc-bubble-text').textContent =
			cfg.bubbleText || 'Рассчитайте стоимость';

		var image = shadow.getElementById('wwc-button-image');
		var defaultIcon = shadow.getElementById('wwc-default-icon');
		var defaultImageUrl = getWidgetAssetUrl('calculator-button.png');
		var usesDefaultImage = !cfg.buttonImageUrl;
		button.classList.toggle('wwc-default-image', usesDefaultImage);
		image.style.display = 'block';
		defaultIcon.style.display = 'none';
		image.onerror = function () {
			if (image.src !== defaultImageUrl) {
				button.classList.add('wwc-default-image');
				image.src = defaultImageUrl;
				return;
			}
			button.classList.remove('wwc-default-image');
			image.style.display = 'none';
			defaultIcon.style.display = '';
		};
		image.src = cfg.buttonImageUrl || defaultImageUrl;

		var brand = shadow.getElementById('wwc-brand');
		brand.style.display =
			cfg.developInfoActive === false || cfg.hideBranding === true
				? 'none'
				: '';

		if (!AUTO_OPEN && cfg.bubbleEnabled !== false) {
			bubbleTimer = setTimeout(function () {
				if (!isDestroyed && !overlay.classList.contains('visible')) {
					bubble.classList.add('visible');
				}
			}, 1800);
		}

		if (autoOpenTimer) clearTimeout(autoOpenTimer);
		if (AUTO_OPEN) {
			closeButton.style.display = 'none';
			autoOpenTimer = setTimeout(openWidget, 250);
		} else if (toFiniteNumber(cfg.autoOpenDelay, 0) > 0) {
			autoOpenTimer = setTimeout(
				openWidget,
				toFiniteNumber(cfg.autoOpenDelay, 0) * 1000
			);
		}
	}

	function render(html) {
		if (content) content.innerHTML = html;
	}

	function showWelcome() {
		currentAnswers = Object.create(null);
		currentPrice = Math.max(0, toFiniteNumber(cfg.basePrice, 0));
		render(
			[
				'<div class="wwc-screen">',
				'<div class="wwc-title">' +
					esc(cfg.title || 'Рассчитайте стоимость') +
					'</div>',
				cfg.subtitle
					? '<div class="wwc-subtitle">' + esc(cfg.subtitle) + '</div>'
					: '',
				'<button class="wwc-btn" id="wwc-start" type="button">' +
					esc(cfg.calculateButtonText || cfg.buttonText || 'Рассчитать') +
					'</button>',
				'</div>'
			].join('')
		);
		shadow
			.getElementById('wwc-start')
			.addEventListener('click', function () {
				sendTelemetryEvent('START');
				showFields();
			});
	}

	function showFields() {
		var fields = Array.isArray(cfg.fields) ? cfg.fields : [];
		if (!fields.length) {
			currentPrice = calculatePrice({});
			continueAfterCalculation();
			return;
		}

		content.innerHTML = '';
		var screen = document.createElement('div');
		screen.className = 'wwc-screen';

		var title = document.createElement('div');
		title.className = 'wwc-title';
		title.textContent = cfg.fieldsTitle || 'Укажите параметры';
		screen.appendChild(title);

		var fieldsContainer = document.createElement('div');
		fieldsContainer.className = 'wwc-fields';
		var fieldElements = Object.create(null);
		fields.forEach(function (field) {
			var fieldElement = document.createElement('div');
			fieldElement.className = 'wwc-field';
			fieldElement.setAttribute('data-field-id', field.id);
			fieldElements[field.id] = fieldElement;

			var label = document.createElement('label');
			label.className = 'wwc-label';
			label.textContent = field.label || 'Параметр';
			if (field.required) {
				var required = document.createElement('span');
				required.className = 'wwc-required';
				required.textContent = ' *';
				label.appendChild(required);
			}
			fieldElement.appendChild(label);

			if (field.type === 'number') {
				var numberInput = document.createElement('input');
				numberInput.className = 'wwc-input';
				numberInput.type = 'number';
				numberInput.min = String(field.min ?? 0);
				numberInput.max = String(field.max ?? 1000000);
				numberInput.step = String(field.step ?? 1);
				numberInput.placeholder = field.unit
					? 'Значение, ' + field.unit
					: 'Введите значение';
				if (field.defaultValue != null)
					numberInput.value = String(field.defaultValue);
				numberInput.setAttribute('data-value-input', 'number');
				fieldElement.appendChild(numberInput);
			} else if (field.type === 'checkbox' || field.type === 'radio') {
				var checks = document.createElement('div');
				checks.className = 'wwc-checks';
				var isSingleChoice =
					field.type === 'radio' || isBooleanOptionPair(field.options);
				checks.setAttribute(
					'role',
					isSingleChoice ? 'radiogroup' : 'group'
				);
				checks.setAttribute('aria-label', field.label || 'Параметр');
				(Array.isArray(field.options) ? field.options : []).forEach(
					function (option) {
						var checkLabel = document.createElement('label');
						checkLabel.className = 'wwc-check';
						var checkInput = document.createElement('input');
						checkInput.type = isSingleChoice ? 'radio' : 'checkbox';
						if (isSingleChoice) checkInput.name = 'wwc-field-' + field.id;
						checkInput.value = option.id;
						checkInput.setAttribute(
							'data-value-input',
							isSingleChoice ? 'radio' : 'checkbox'
						);
						var checkText = document.createElement('span');
						checkText.textContent = option.label || 'Вариант';
						checkLabel.appendChild(checkInput);
						checkLabel.appendChild(checkText);
						checks.appendChild(checkLabel);
					}
				);
				fieldElement.appendChild(checks);
			} else {
				var select = document.createElement('select');
				select.className = 'wwc-select';
				select.setAttribute('data-value-input', 'select');
				var emptyOption = document.createElement('option');
				emptyOption.value = '';
				emptyOption.textContent = 'Выберите вариант';
				select.appendChild(emptyOption);
				(Array.isArray(field.options) ? field.options : []).forEach(
					function (option) {
						var optionElement = document.createElement('option');
						optionElement.value = option.id;
						optionElement.textContent = option.label || 'Вариант';
						select.appendChild(optionElement);
					}
				);
				fieldElement.appendChild(select);
			}

			fieldsContainer.appendChild(fieldElement);
		});
		screen.appendChild(fieldsContainer);

		var error = document.createElement('div');
		error.id = 'wwc-fields-error';
		error.className = 'wwc-error';
		screen.appendChild(error);

		var button = document.createElement('button');
		button.id = 'wwc-calculate';
		button.className = 'wwc-btn';
		button.type = 'button';
		button.textContent = cfg.calculateButtonText || 'Рассчитать стоимость';
		button.addEventListener('click', function () {
			var collected = Object.create(null);
			var invalidField = null;

			fields.forEach(function (field) {
				var fieldElement = fieldElements[field.id];
				if (!fieldElement) return;
				if (
					field.type === 'checkbox' &&
					!isBooleanOptionPair(field.options)
				) {
					var selected = Array.prototype.slice
						.call(fieldElement.querySelectorAll('input:checked'))
						.map(function (input) {
							return input.value;
						});
					collected[field.id] = selected;
					if (field.required && !selected.length && !invalidField)
						invalidField = fieldElement;
					return;
				}
				if (
					field.type === 'radio' ||
					(field.type === 'checkbox' && isBooleanOptionPair(field.options))
				) {
					var selectedRadio = fieldElement.querySelector('input:checked');
					collected[field.id] = selectedRadio ? selectedRadio.value : '';
					if (field.required && !selectedRadio && !invalidField)
						invalidField = fieldElement;
					return;
				}

				var input = fieldElement.querySelector('[data-value-input]');
				var value = input ? input.value : '';
				if (field.type === 'number') {
					var parsed = Number(value);
					var min = toFiniteNumber(field.min, 0);
					var max = toFiniteNumber(field.max, 1000000);
					var step = Math.max(0.01, toFiniteNumber(field.step, 1));
					var steps = (parsed - min) / step;
					if (
						(field.required && value === '') ||
						(value !== '' &&
							(!Number.isFinite(parsed) ||
								parsed < min ||
								parsed > max ||
								Math.abs(steps - Math.round(steps)) > 1e-7))
					) {
						if (!invalidField) invalidField = input;
					}
					collected[field.id] = value === '' ? null : parsed;
					return;
				}

				collected[field.id] = value;
				if (field.required && !value && !invalidField)
					invalidField = input;
			});

			if (invalidField) {
				error.textContent = 'Заполните обязательные поля корректно';
				invalidField.classList.add('error');
				if (invalidField.focus) invalidField.focus();
				return;
			}

			currentAnswers = collected;
			currentPrice = calculatePrice(currentAnswers);
			continueAfterCalculation();
		});
		screen.appendChild(button);
		content.appendChild(screen);
	}

	function continueAfterCalculation() {
		if (String(cfg.dataType || 'NONE').toUpperCase() === 'NONE') {
			showResult();
			return;
		}
		showContact(false);
	}

	function buildPriceCard(price) {
		return [
			'<div class="wwc-price-card">',
			'<div class="wwc-price-label">' +
				esc(cfg.resultTitle || 'Предварительная стоимость') +
				'</div>',
			'<div class="wwc-price">' +
				esc(formatPrice(price, cfg.currency)) +
				'</div>',
			'<div class="wwc-price-note">Итоговая стоимость может измениться после уточнения деталей.</div>',
			'</div>'
		].join('');
	}

	function showContact(showPriceBeforeSubmit) {
		var dataType = String(cfg.dataType || 'PHONE').toUpperCase();
		var privacyUrl = getSafeExternalUrl(cfg.privacyUrl);
		render(
			[
				'<div class="wwc-screen">',
				showPriceBeforeSubmit ? buildPriceCard(currentPrice) : '',
				'<div class="wwc-title">' +
					esc(cfg.contactTitle || 'Куда отправить расчёт?') +
					'</div>',
				dataType === 'PHONE' || dataType === 'PHONE_AND_EMAIL'
					? '<input class="wwc-input" id="wwc-phone" type="tel" autocomplete="tel" placeholder="Ваш телефон" />'
					: '',
				dataType === 'EMAIL' || dataType === 'PHONE_AND_EMAIL'
					? '<input class="wwc-input" id="wwc-email" type="email" autocomplete="email" placeholder="Ваш email" />'
					: '',
				'<div class="wwc-error" id="wwc-contact-error"></div>',
				'<button class="wwc-btn" id="wwc-submit" type="button">' +
					esc(cfg.submitButtonText || 'Получить расчёт') +
					'</button>',
				privacyUrl
					? '<div class="wwc-privacy">Нажимая кнопку, вы соглашаетесь с <a href="' +
						esc(privacyUrl) +
						'" target="_blank" rel="noopener">политикой конфиденциальности</a></div>'
					: '',
				'</div>'
			].join('')
		);

		var phoneInput = shadow.getElementById('wwc-phone');
		var emailInput = shadow.getElementById('wwc-email');
		var error = shadow.getElementById('wwc-contact-error');
		var submitButton = shadow.getElementById('wwc-submit');
		var phoneController =
			phoneInput && window.winwidgetPhone
				? window.winwidgetPhone.attach(phoneInput, {
						placeholder: '+7 999 123-45-67'
					})
				: null;

		function getPhone() {
			if (!phoneInput) return null;
			if (phoneController) return phoneController.getNumber();
			var raw = phoneInput.value.trim();
			var digits = raw.replace(/\D/g, '');
			if (
				digits.length === 11 &&
				(digits.charAt(0) === '7' || digits.charAt(0) === '8')
			) {
				return '+7' + digits.slice(1);
			}
			if (digits.length === 10) return '+7' + digits;
			if (
				raw.charAt(0) === '+' &&
				digits.length >= 8 &&
				digits.length <= 15
			) {
				return '+' + digits;
			}
			return null;
		}

		submitButton.addEventListener('click', function () {
			error.textContent = '';
			var phone = getPhone();
			var email = emailInput ? emailInput.value.trim() : null;

			if (phoneInput && !phone) {
				phoneInput.classList.add('error');
				error.textContent = 'Введите корректный номер телефона';
				phoneInput.focus();
				return;
			}
			if (emailInput && !EMAIL_REGEXP.test(email || '')) {
				emailInput.classList.add('error');
				error.textContent = 'Введите корректный email';
				emailInput.focus();
				return;
			}

			submitButton.disabled = true;
			submitButton.textContent = 'Отправляем...';
			submitLead(phone, email).catch(function () {
				submitButton.disabled = false;
				submitButton.textContent =
					cfg.submitButtonText || 'Получить расчёт';
				error.textContent =
					'Не удалось отправить расчёт. Попробуйте ещё раз.';
			});
		});
	}

	function serializeAnswers() {
		return (Array.isArray(cfg.fields) ? cfg.fields : [])
			.map(function (field) {
				return {
					fieldId: field.id,
					value: currentAnswers[field.id]
				};
			})
			.filter(function (answer) {
				return !(
					answer.value == null ||
					answer.value === '' ||
					(Array.isArray(answer.value) && !answer.value.length)
				);
			});
	}

	function submitLead(phone, email) {
		return fetch(
			API_BASE + '/calculator/' + encodeURIComponent(KEY) + '/lead',
			getWidgetFetchOptions({
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					contact: phone || email || '',
					phone: phone || undefined,
					email: email || undefined,
					answers: serializeAnswers(),
					url: window.location.href
				})
			})
		)
			.then(function (response) {
				return response.json().then(function (data) {
					if (!response.ok) {
						throw new Error(
							data && data.message ? data.message : 'submit_failed'
						);
					}
					return data;
				});
			})
			.then(function (data) {
				var serverPrice =
					data && data.result && data.result.calculatedPrice != null
						? data.result.calculatedPrice
						: data && data.calculatedPrice != null
							? data.calculatedPrice
							: data && data.lead && data.lead.calculatedPrice != null
								? data.lead.calculatedPrice
								: currentPrice;
				currentPrice = toFiniteNumber(serverPrice, currentPrice);
				firePixel('calculator_lead');
				showResult();
			});
	}

	function showResult() {
		var collectsContacts =
			String(cfg.dataType || 'NONE').toUpperCase() !== 'NONE';
		render(
			[
				'<div class="wwc-screen">',
				buildPriceCard(currentPrice),
				'<div class="wwc-title">' +
					esc(
						collectsContacts
							? cfg.successTitle || 'Спасибо! Расчёт готов'
							: 'Расчёт готов'
					) +
					'</div>',
				collectsContacts
					? '<div class="wwc-subtitle">' +
						esc(
							cfg.successSubtitle ||
								'Мы получили ваши данные и свяжемся с вами для уточнения деталей.'
						) +
						'</div>'
					: '',
				'</div>'
			].join('')
		);
	}

	function showDisabledPage() {
		if (!document.body) return;
		var existing = document.getElementById('calculator-widget-disabled');
		if (existing) return;
		var disabled = document.createElement('div');
		disabled.id = 'calculator-widget-disabled';
		disabled.style.cssText =
			'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0d0d1a;color:#fff;font-family:' +
			SYSTEM_FONT_STACK +
			';text-align:center;padding:24px;z-index:2147483647';
		disabled.innerHTML =
			'<div style="font-size:3rem;margin-bottom:16px">🔒</div><h1 style="font-size:1.3rem;font-weight:700">Виджет временно отключен</h1>';
		document.body.appendChild(disabled);
	}

	function loadConfig() {
		return Promise.all([
			ensurePhoneHelper(),
			fetch(
				API_BASE +
					'/calculator/' +
					encodeURIComponent(KEY) +
					'/config?_=' +
					Date.now(),
				getWidgetFetchOptions({ cache: 'no-store' })
			)
		])
			.then(function (result) {
				if (isDestroyed) return null;
				var response = result[1];
				if (!response.ok) {
					console.warn(
						'[wincalculator] Widget not found or inactive (' +
							response.status +
							')'
					);
					return null;
				}
				return response.json();
			})
			.then(function (data) {
				if (isDestroyed || data === null) return;
				if (!data || !data.isActive) {
					console.warn('[wincalculator] Widget is inactive');
					cfg = null;
					if (AUTO_OPEN) showDisabledPage();
					return;
				}
				cfg = data;
				applyConfig();
				sendTelemetryEvent('IMPRESSION');
			})
			.catch(function (error) {
				console.error('[wincalculator] Failed to load config:', error);
			});
	}

	function refreshConfig() {
		if (isDestroyed) return Promise.resolve(null);
		if (!isStarted) {
			startWhenBodyReady();
			return Promise.resolve(null);
		}
		return loadConfig();
	}

	function handleDomReady() {
		document.removeEventListener('DOMContentLoaded', handleDomReady);
		window.removeEventListener('load', handleDomReady);
		bodyReadyListenersAttached = false;
		startWidget();
	}

	function startWhenBodyReady() {
		if (isStarted || isDestroyed) return;
		if (document.body) {
			startWidget();
			return;
		}
		if (bodyReadyListenersAttached) return;
		bodyReadyListenersAttached = true;
		document.addEventListener('DOMContentLoaded', handleDomReady, {
			once: true
		});
		window.addEventListener('load', handleDomReady, { once: true });
	}

	function startWidget() {
		if (isStarted || isDestroyed) return;
		if (!ensureWidgetDom()) {
			startWhenBodyReady();
			return;
		}
		isStarted = true;
		loadConfig();
	}

	function destroyWidget() {
		isDestroyed = true;
		if (autoOpenTimer) clearTimeout(autoOpenTimer);
		if (bubbleTimer) clearTimeout(bubbleTimer);
		document.removeEventListener('DOMContentLoaded', handleDomReady);
		window.removeEventListener('load', handleDomReady);
		bodyReadyListenersAttached = false;
		unlockBody();
		var disabled = document.getElementById('calculator-widget-disabled');
		if (disabled && disabled.parentNode)
			disabled.parentNode.removeChild(disabled);
		if (host && host.parentNode) host.parentNode.removeChild(host);
		host = null;
		shadow = null;
		launcher = null;
		bubble = null;
		overlay = null;
		card = null;
		content = null;
		closeButton = null;
		cfg = null;
		delete window.__wincalculatorScriptRunning;
		if (
			window.winwidgetCalculator &&
			window.winwidgetCalculator.key === KEY
		) {
			delete window.winwidgetCalculator;
		}
	}

	window.winwidgetCalculator = {
		key: KEY,
		open: openWidget,
		close: closeWidget,
		refresh: refreshConfig,
		destroy: destroyWidget
	};

	startWhenBodyReady();
})();
