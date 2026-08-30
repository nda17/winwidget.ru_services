(function () {
	'use strict';

	if (window.__winAiConsultantScriptRunning) return;
	window.__winAiConsultantScriptRunning = true;

	var currentScript = document.currentScript;
	var STYLE_NONCE =
		currentScript && currentScript.nonce ? currentScript.nonce : '';
	var SYSTEM_FONT_STACK =
		"system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
	var API_BASE = (function () {
		try {
			var src = new URL(
				currentScript && currentScript.src
					? currentScript.src
					: window.location.href
			);
			return src.origin + '/api/v1';
		} catch (error) {
			return 'https://winwidget.ru/api/v1';
		}
	})();
	var KEY =
		(currentScript && currentScript.getAttribute('data-key')) ||
		window.winAiConsultant ||
		'';

	if (!KEY) {
		delete window.__winAiConsultantScriptRunning;
		return;
	}

	var RUNTIME_VERSION = '2026.08';
	var CONSENT_REQUEST_TIMEOUT_MS = 30000;
	var SESSION_REQUEST_TIMEOUT_MS = 30000;
	var MESSAGE_REQUEST_TIMEOUT_MS = 55000;
	var TURNSTILE_CHALLENGE_TIMEOUT_MS = 120000;
	var PUBLISHED_VERSION = 0;
	var telemetryEventsSent = Object.create(null);
	var AUTO_OPEN = Boolean(window.winAiConsultantAutoOpen);
	var AUTO_FOCUS_ENABLED =
		window.__winwidgetPreviewDisableAutoFocus !== true;

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
				API_BASE +
					'/widget-events/ai-consultant/' +
					encodeURIComponent(KEY),
				getWidgetFetchOptions({
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
				})
			);
			if (request && typeof request.catch === 'function') {
				request.catch(function () {});
			}
		} catch (error) {}
	}

	function isDirectPreviewPage() {
		try {
			var hostname = String(window.location.hostname || '').toLowerCase();
			return (
				(hostname === 'winwidget.ru' ||
					hostname === 'www.winwidget.ru' ||
					hostname === 'localhost') &&
				window.location.pathname.replace(/\/+$/, '') ===
					'/page-ai-consultant/' + KEY
			);
		} catch (error) {
			return false;
		}
	}

	function getWidgetFetchOptions(options) {
		var result = options || {};
		if (isDirectPreviewPage()) {
			result.referrerPolicy = 'unsafe-url';
		}
		return result;
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
		} catch (error) {
			return 'https://winwidget.ru/widgets/' + fileName;
		}
	}

	function getSafeExternalUrl(value, allowContactProtocols) {
		if (typeof value !== 'string' || !value.trim()) return '';
		try {
			var url = new URL(value.trim(), window.location.href);
			if (url.protocol === 'http:' || url.protocol === 'https:') {
				return url.href;
			}
		} catch (error) {}
		return '';
	}

	function getSafeConsentUrl(value) {
		if (typeof value !== 'string' || !value.trim()) return '';
		try {
			var url = new URL(value.trim());
			if (
				(url.protocol === 'http:' || url.protocol === 'https:') &&
				!url.username &&
				!url.password
			) {
				return url.href;
			}
		} catch (error) {}
		return '';
	}

	function readConsentConfig(config) {
		var consent = config && config.consent;
		if (!consent || typeof consent !== 'object') return null;
		var privacyUrl = getSafeConsentUrl(consent.privacyUrl);
		if (
			typeof consent.documentVersion !== 'string' ||
			!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(consent.documentVersion) ||
			typeof consent.documentHash !== 'string' ||
			!/^[a-f0-9]{64}$/.test(consent.documentHash) ||
			typeof consent.statementText !== 'string' ||
			!consent.statementText.trim() ||
			consent.statementText.length > 2000 ||
			!privacyUrl
		) {
			return null;
		}
		return {
			documentVersion: consent.documentVersion,
			documentHash: consent.documentHash,
			statementText: consent.statementText,
			privacyUrl: privacyUrl
		};
	}

	function safeText(value, fallback) {
		return value == null || value === '' ? fallback : String(value);
	}

	function safeCssColor(value, fallback) {
		var color = safeText(value, '').trim();
		return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
	}

	function boundedNumber(value, fallback, minimum, maximum) {
		var number = Number(value);
		return Number.isFinite(number)
			? Math.min(maximum, Math.max(minimum, number))
			: fallback;
	}

	function uuid() {
		if (window.crypto && typeof window.crypto.randomUUID === 'function') {
			return window.crypto.randomUUID();
		}
		var bytes = new Uint8Array(16);
		if (
			window.crypto &&
			typeof window.crypto.getRandomValues === 'function'
		) {
			window.crypto.getRandomValues(bytes);
		} else {
			for (var index = 0; index < bytes.length; index += 1) {
				bytes[index] = Math.floor(Math.random() * 256);
			}
		}
		bytes[6] = (bytes[6] & 15) | 64;
		bytes[8] = (bytes[8] & 63) | 128;
		var hex = Array.prototype.map
			.call(bytes, function (byte) {
				return byte.toString(16).padStart(2, '0');
			})
			.join('');
		return (
			hex.slice(0, 8) +
			'-' +
			hex.slice(8, 12) +
			'-' +
			hex.slice(12, 16) +
			'-' +
			hex.slice(16, 20) +
			'-' +
			hex.slice(20)
		);
	}

	var cfg = null;
	var isOpen = false;
	var inFlight = false;
	var sessionId = uuid();
	var sessionToken = '';
	var sessionTokenExpiresAt = 0;
	var consentConfig = null;
	var consentAcceptanceId = uuid();
	var consentToken = '';
	var consentAccepted = false;
	var consentInFlight = false;
	var history = [];
	var operatorJoined = false;
	var sessionClosed = false;
	var inactivityTimer = null;
	var sessionExpiryTimer = null;
	var typingNode = null;
	var autoOpenTimer = null;
	var activeController = null;
	var configController = new AbortController();
	var turnstileWidgetId = null;
	var pendingTurnstile = null;
	var destroyed = false;

	var host = document.createElement('div');
	host.id = 'ai-consultant-widget-host';
	document.body.appendChild(host);
	var shadow = host.attachShadow({ mode: 'open' });

	var style = document.createElement('style');
	if (STYLE_NONCE) style.nonce = STYLE_NONCE;
	style.textContent = [
		':host{all:initial}',
		'*,*::before,*::after{box-sizing:border-box}',
		'.waic-button{position:fixed;display:none;align-items:center;justify-content:center;z-index:2147483645;border:0;border-radius:50%;background:var(--waic-button-color,transparent);padding:0;cursor:pointer;box-shadow:0 10px 30px rgba(25,18,45,.28);transition:transform .2s ease,background .2s ease;-webkit-tap-highlight-color:transparent}',
		'.waic-button-ready{display:flex}',
		'.waic-button-open{background:var(--waic-open-button-color,var(--waic-button-color,transparent))}',
		'.waic-button:hover{transform:translateY(-2px) scale(1.03)}',
		'.waic-button:focus-visible{outline:3px solid rgba(71,5,251,.28);outline-offset:3px}',
		'.waic-button img{display:block;width:100%;height:100%;object-fit:contain;border-radius:50%}',
		'.waic-button-pulse{animation:waicPulse 2.8s ease-in-out infinite}',
		'@keyframes waicPulse{0%,100%{box-shadow:0 10px 30px rgba(25,18,45,.28),0 0 0 0 rgba(71,5,251,.25)}50%{box-shadow:0 10px 30px rgba(25,18,45,.28),0 0 0 12px rgba(71,5,251,0)}}',
		'.waic-overlay{position:fixed;inset:0;z-index:2147483646;display:none;pointer-events:none;font-family:' +
			SYSTEM_FONT_STACK +
			';color:var(--waic-text,#1f2937)}',
		'.waic-overlay-open{display:block}',
		'.waic-modal{position:absolute;right:var(--waic-offset,16px);bottom:var(--waic-panel-bottom,88px);display:flex;width:min(390px,calc(100vw - 24px));height:min(610px,calc(100vh - 108px));min-height:420px;overflow:hidden;flex-direction:column;border:1px solid rgba(20,14,42,.08);border-radius:20px;background:var(--waic-bg,#fff);box-shadow:0 24px 70px rgba(25,18,45,.28);pointer-events:auto;transform:translateY(12px) scale(.98);opacity:0;transition:transform .2s ease,opacity .2s ease}',
		'.waic-overlay-open .waic-modal{transform:none;opacity:1}',
		'.waic-side-left .waic-modal{right:auto;left:var(--waic-offset,16px)}',
		'.waic-header{display:flex;min-height:78px;align-items:center;gap:12px;padding:14px 14px 14px 16px;background:var(--waic-color,#4705fb);color:#fff}',
		'.waic-avatar{display:flex;width:44px;height:44px;flex:0 0 44px;align-items:center;justify-content:center;border:2px solid rgba(255,255,255,.65);border-radius:50%;background:rgba(255,255,255,.18);font-size:13px;font-weight:800}',
		'.waic-head-copy{min-width:0;flex:1}',
		'.waic-name{overflow:hidden;margin:0;text-overflow:ellipsis;white-space:nowrap;font-size:16px;font-weight:800}',
		'.waic-status{display:flex;align-items:center;gap:6px;margin-top:4px;font-size:12px;opacity:.9}',
		'.waic-ai-badge{display:inline-flex;align-items:center;border-radius:999px;background:rgba(255,255,255,.18);padding:3px 7px;font-size:10px;font-weight:800;letter-spacing:.04em}',
		'.waic-close{display:flex;width:36px;height:36px;align-items:center;justify-content:center;border:0;border-radius:50%;background:rgba(255,255,255,.14);color:#fff;cursor:pointer;font-size:22px;line-height:1}',
		'.waic-close:hover{background:rgba(255,255,255,.24)}',
		'.waic-chat{display:flex;min-height:0;flex:1;flex-direction:column;gap:12px;overflow-y:auto;padding:18px 14px;background:linear-gradient(180deg,rgba(71,5,251,.035),transparent 120px);scroll-behavior:smooth}',
		'.waic-row{display:flex;max-width:88%;flex-direction:column;gap:4px}',
		'.waic-row-operator{align-self:flex-start}',
		'.waic-row-user{align-self:flex-end;align-items:flex-end}',
		'.waic-label{padding:0 7px;color:#7c7486;font-size:10px;font-weight:700}',
		'.waic-message{border-radius:17px;padding:10px 13px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.45}',
		'.waic-row-operator .waic-message{border-bottom-left-radius:5px;background:#f1eff5;color:var(--waic-text,#1f2937)}',
		'.waic-row-user .waic-message{border-bottom-right-radius:5px;background:var(--waic-color,#4705fb);color:#fff}',
		'.waic-system{align-self:center;border-radius:999px;background:rgba(31,41,55,.07);padding:5px 10px;color:#786f80;text-align:center;font-size:11px;line-height:1.35}',
		'.waic-error{background:#fff0f0;color:#a92626}',
		'.waic-typing .waic-message{display:flex;align-items:center;gap:4px;min-width:54px;height:38px}',
		'.waic-typing-dot{width:6px;height:6px;border-radius:50%;background:#8b8294;animation:waicTyping 1.2s infinite ease-in-out}',
		'.waic-typing-dot:nth-child(2){animation-delay:.15s}',
		'.waic-typing-dot:nth-child(3){animation-delay:.3s}',
		'@keyframes waicTyping{0%,60%,100%{transform:translateY(0);opacity:.45}30%{transform:translateY(-4px);opacity:1}}',
		'.waic-form{display:flex;align-items:flex-end;gap:8px;border-top:1px solid rgba(31,41,55,.09);padding:11px;background:var(--waic-bg,#fff)}',
		'.waic-input-area{display:flex;min-width:0;flex:1;flex-direction:column;gap:5px}',
		'.waic-turnstile{display:flex;min-height:0;justify-content:center;background:var(--waic-bg,#fff)}',
		'.waic-consent{display:flex;flex-direction:column;gap:12px;border-top:1px solid rgba(31,41,55,.09);padding:16px 14px;background:var(--waic-bg,#fff)}',
		'.waic-consent[hidden],.waic-turnstile[hidden],.waic-form[hidden]{display:none}',
		'.waic-consent-choice{display:flex;align-items:flex-start;gap:10px;color:var(--waic-text,#1f2937);font-size:12px;line-height:1.45;cursor:pointer}',
		'.waic-consent-checkbox{width:18px;height:18px;flex:0 0 18px;margin:1px 0 0;accent-color:var(--waic-color,#4705fb)}',
		'.waic-consent-checkbox:focus-visible,.waic-consent-submit:focus-visible{outline:3px solid rgba(71,5,251,.28);outline-offset:2px}',
		'.waic-consent-copy{min-width:0}',
		'.waic-consent-link{display:inline-block;margin-top:5px;color:var(--waic-color,#4705fb);text-decoration:underline;text-underline-offset:2px}',
		'.waic-consent-submit{min-height:42px;border:0;border-radius:13px;background:var(--waic-color,#4705fb);padding:10px 14px;color:#fff;cursor:pointer;font:700 13px/1.35 ' +
			SYSTEM_FONT_STACK +
			'}',
		'.waic-consent-submit:disabled{cursor:default;opacity:.48}',
		'.waic-consent-error{margin:0;color:#a92626;font-size:11px;line-height:1.4}',
		'.waic-consent-error:empty{display:none}',
		'.waic-input{width:100%;min-height:42px;max-height:108px;resize:none;border:1px solid rgba(31,41,55,.16);border-radius:14px;background:#fff;padding:10px 12px;color:#1f2937;font:14px/1.4 ' +
			SYSTEM_FONT_STACK +
			';outline:none}',
		'.waic-input:focus{border-color:var(--waic-color,#4705fb);box-shadow:0 0 0 3px rgba(71,5,251,.1)}',
		'.waic-input:disabled{background:#f5f4f7;color:#8e8796}',
		'.waic-privacy{color:#7c7486;font-size:10px;line-height:1.3}',
		'.waic-privacy a{color:var(--waic-color,#4705fb);text-decoration:underline;text-underline-offset:2px}',
		'.waic-privacy a[hidden],.waic-brand[hidden]{display:none}',
		'.waic-send{display:flex;width:42px;height:42px;flex:0 0 42px;align-items:center;justify-content:center;border:0;border-radius:13px;background:var(--waic-color,#4705fb);color:#fff;cursor:pointer;font-size:20px;font-weight:800}',
		'.waic-send:disabled{cursor:default;opacity:.48}',
		'.waic-brand{border-top:1px solid rgba(31,41,55,.06);padding:5px 12px 7px;background:var(--waic-bg,#fff);text-align:center;font-size:10px}',
		'.waic-brand a{color:#8b8294;text-decoration:none}',
		'@media(max-width:640px){.waic-modal{right:8px;bottom:76px;left:8px!important;width:auto;height:calc(100dvh - 88px);min-height:0;border-radius:18px}.waic-chat{padding:14px 11px}.waic-header{min-height:70px;padding:11px 12px}}',
		'@media(prefers-reduced-motion:reduce){.waic-button-pulse,.waic-typing-dot{animation:none}.waic-modal,.waic-button{transition:none}}'
	].join('');
	shadow.appendChild(style);
	var dynamicStyle = document.createElement('style');
	if (STYLE_NONCE) dynamicStyle.nonce = STYLE_NONCE;
	shadow.appendChild(dynamicStyle);

	var button = document.createElement('button');
	button.id = 'waic-button';
	button.className = 'waic-button';
	button.type = 'button';
	button.setAttribute('aria-label', 'Открыть AI-консультант');
	button.setAttribute('aria-expanded', 'false');
	var buttonImage = document.createElement('img');
	buttonImage.alt = '';
	buttonImage.src = getWidgetAssetUrl('ai-consultant-button.png');
	button.appendChild(buttonImage);
	shadow.appendChild(button);

	var overlay = document.createElement('div');
	overlay.id = 'waic-overlay';
	overlay.className = 'waic-overlay';
	var modal = document.createElement('section');
	modal.id = 'waic-modal';
	modal.className = 'waic-modal';
	modal.setAttribute('role', 'dialog');
	modal.setAttribute('aria-modal', 'false');
	modal.setAttribute('aria-label', 'AI-консультант');

	var header = document.createElement('header');
	header.className = 'waic-header';
	var avatar = document.createElement('span');
	avatar.className = 'waic-avatar';
	avatar.textContent = 'AI';
	var headCopy = document.createElement('div');
	headCopy.className = 'waic-head-copy';
	var operatorName = document.createElement('p');
	operatorName.className = 'waic-name';
	var status = document.createElement('div');
	status.className = 'waic-status';
	var statusText = document.createElement('span');
	statusText.textContent = 'Отвечает по инструкциям';
	var aiBadge = document.createElement('span');
	aiBadge.className = 'waic-ai-badge';
	aiBadge.textContent = 'AI-оператор';
	status.appendChild(statusText);
	status.appendChild(aiBadge);
	headCopy.appendChild(operatorName);
	headCopy.appendChild(status);
	var closeButton = document.createElement('button');
	closeButton.className = 'waic-close';
	closeButton.type = 'button';
	closeButton.setAttribute('aria-label', 'Закрыть чат');
	closeButton.textContent = '×';
	header.appendChild(avatar);
	header.appendChild(headCopy);
	header.appendChild(closeButton);

	var chat = document.createElement('div');
	chat.className = 'waic-chat';
	chat.setAttribute('role', 'log');
	chat.setAttribute('aria-live', 'polite');
	var form = document.createElement('form');
	form.className = 'waic-form';
	form.hidden = true;
	var turnstileContainer = document.createElement('div');
	turnstileContainer.className = 'waic-turnstile';
	turnstileContainer.hidden = true;
	var consentPanel = document.createElement('section');
	consentPanel.className = 'waic-consent';
	consentPanel.setAttribute('aria-label', 'Согласие на обработку запроса');
	var consentChoice = document.createElement('label');
	consentChoice.className = 'waic-consent-choice';
	var consentCheckbox = document.createElement('input');
	consentCheckbox.className = 'waic-consent-checkbox';
	consentCheckbox.type = 'checkbox';
	consentCheckbox.required = true;
	consentCheckbox.setAttribute('aria-required', 'true');
	var consentCopy = document.createElement('span');
	consentCopy.className = 'waic-consent-copy';
	var consentStatement = document.createElement('span');
	var consentLink = document.createElement('a');
	consentLink.className = 'waic-consent-link';
	consentLink.target = '_blank';
	consentLink.rel = 'noopener noreferrer';
	consentLink.textContent = 'Политика обработки данных';
	consentCopy.appendChild(consentStatement);
	consentCopy.appendChild(document.createElement('br'));
	consentCopy.appendChild(consentLink);
	consentChoice.appendChild(consentCheckbox);
	consentChoice.appendChild(consentCopy);
	var consentButton = document.createElement('button');
	consentButton.className = 'waic-consent-submit';
	consentButton.type = 'button';
	consentButton.disabled = true;
	consentButton.textContent = 'Согласен, продолжить';
	var consentError = document.createElement('p');
	consentError.className = 'waic-consent-error';
	consentError.setAttribute('role', 'alert');
	consentError.setAttribute('aria-live', 'assertive');
	consentPanel.appendChild(consentChoice);
	consentPanel.appendChild(consentButton);
	consentPanel.appendChild(consentError);
	var inputArea = document.createElement('div');
	inputArea.className = 'waic-input-area';
	var input = document.createElement('textarea');
	input.className = 'waic-input';
	input.rows = 1;
	input.maxLength = 1000;
	input.setAttribute('aria-label', 'Ваш вопрос');
	var privacyNotice = document.createElement('div');
	privacyNotice.className = 'waic-privacy';
	privacyNotice.appendChild(
		document.createTextNode(
			'Не указывайте специальные категории, биометрические и иные избыточные персональные данные. Вопрос и контекст диалога обрабатываются Cloudflare Workers AI. '
		)
	);
	var privacyLink = document.createElement('a');
	privacyLink.target = '_blank';
	privacyLink.rel = 'noopener noreferrer';
	privacyLink.textContent = 'Политика обработки данных';
	privacyNotice.appendChild(privacyLink);
	var sendButton = document.createElement('button');
	sendButton.className = 'waic-send';
	sendButton.type = 'submit';
	sendButton.setAttribute('aria-label', 'Отправить');
	sendButton.textContent = '↑';
	inputArea.appendChild(input);
	inputArea.appendChild(privacyNotice);
	form.appendChild(inputArea);
	form.appendChild(sendButton);
	var brand = document.createElement('div');
	brand.className = 'waic-brand';
	var brandLink = document.createElement('a');
	brandLink.href = 'https://winwidget.ru';
	brandLink.target = '_blank';
	brandLink.rel = 'noopener noreferrer';
	brandLink.textContent = 'Работает на WinWidget';
	brand.appendChild(brandLink);
	modal.appendChild(header);
	modal.appendChild(chat);
	modal.appendChild(consentPanel);
	modal.appendChild(turnstileContainer);
	modal.appendChild(form);
	modal.appendChild(brand);
	overlay.appendChild(modal);
	shadow.appendChild(overlay);

	function scrollToLatest() {
		window.requestAnimationFrame(function () {
			chat.scrollTop = chat.scrollHeight;
		});
	}

	function appendSystem(text, isError) {
		var node = document.createElement('div');
		node.className = 'waic-system' + (isError ? ' waic-error' : '');
		node.textContent = text;
		chat.appendChild(node);
		scrollToLatest();
		return node;
	}

	function appendMessage(role, text) {
		var row = document.createElement('div');
		row.className =
			'waic-row ' +
			(role === 'user' ? 'waic-row-user' : 'waic-row-operator');
		var label = document.createElement('span');
		label.className = 'waic-label';
		label.textContent =
			role === 'user'
				? 'Вы'
				: safeText(cfg && cfg.operatorName, 'Alex') + ' · AI';
		var message = document.createElement('div');
		message.className = 'waic-message';
		message.textContent = text;
		row.appendChild(label);
		row.appendChild(message);
		chat.appendChild(row);
		scrollToLatest();
		return row;
	}

	function showTyping() {
		if (typingNode) return;
		var row = document.createElement('div');
		row.className = 'waic-row waic-row-operator waic-typing';
		var label = document.createElement('span');
		label.className = 'waic-label';
		label.textContent = safeText(cfg.operatorName, 'Alex') + ' печатает';
		var bubble = document.createElement('div');
		bubble.className = 'waic-message';
		for (var index = 0; index < 3; index += 1) {
			var dot = document.createElement('span');
			dot.className = 'waic-typing-dot';
			bubble.appendChild(dot);
		}
		row.appendChild(label);
		row.appendChild(bubble);
		chat.appendChild(row);
		typingNode = row;
		scrollToLatest();
	}

	function hideTyping() {
		if (typingNode && typingNode.parentNode)
			typingNode.parentNode.removeChild(typingNode);
		typingNode = null;
	}

	function clearInactivityTimer() {
		if (inactivityTimer) window.clearTimeout(inactivityTimer);
		inactivityTimer = null;
	}

	function clearSessionExpiryTimer() {
		if (sessionExpiryTimer) window.clearTimeout(sessionExpiryTimer);
		sessionExpiryTimer = null;
	}

	function resetTurnstileState() {
		if (pendingTurnstile) {
			pendingTurnstile.reject(new Error('TURNSTILE_ABORTED'));
			pendingTurnstile = null;
		}
		if (window.turnstile && turnstileWidgetId !== null) {
			try {
				window.turnstile.remove(turnstileWidgetId);
			} catch (error) {}
		}
		turnstileWidgetId = null;
	}

	function leaveForInactivity() {
		if (!operatorJoined || sessionClosed || inFlight || destroyed) return;
		appendMessage(
			'assistant',
			safeText(
				cfg.farewellMessage,
				'Я не дождался ответа. Если у вас появятся вопросы, напишите снова — я обязательно помогу.'
			)
		);
		appendSystem(safeText(cfg.operatorName, 'Alex') + ' покинул чат');
		sessionClosed = true;
		operatorJoined = false;
		history = [];
		clearInactivityTimer();
		prepareNewSession(false);
	}

	function scheduleInactivity() {
		clearInactivityTimer();
		var minutes = boundedNumber(cfg.inactivityTimeoutMinutes, 10, 1, 60);
		inactivityTimer = window.setTimeout(
			leaveForInactivity,
			minutes * 60 * 1000
		);
	}

	function resetConsentState() {
		resetTurnstileState();
		consentAcceptanceId = uuid();
		consentToken = '';
		consentAccepted = false;
		consentInFlight = false;
		consentPanel.removeAttribute('aria-busy');
		consentCheckbox.checked = false;
		consentCheckbox.disabled = false;
		consentButton.disabled = true;
		consentButton.textContent = 'Согласен, продолжить';
		consentError.textContent = '';
		consentPanel.hidden = false;
		turnstileContainer.hidden = true;
		form.hidden = true;
		input.disabled = true;
		sendButton.disabled = true;
	}

	function prepareNewSession(announce) {
		clearInactivityTimer();
		clearSessionExpiryTimer();
		sessionId = uuid();
		sessionToken = '';
		sessionTokenExpiresAt = 0;
		history = [];
		sessionClosed = false;
		operatorJoined = false;
		resetConsentState();
		if (announce) appendSystem('Новый диалог');
	}

	function startNewSession() {
		prepareNewSession(true);
	}

	function requireFreshConsent(message) {
		prepareNewSession(false);
		consentError.textContent = message;
		if (isOpen && AUTO_FOCUS_ENABLED) consentCheckbox.focus();
	}

	function expireSession() {
		sessionExpiryTimer = null;
		if (destroyed || !consentAccepted) return;
		if (inFlight || consentInFlight) {
			sessionExpiryTimer = window.setTimeout(expireSession, 1000);
			return;
		}
		requireFreshConsent(
			'Срок сессии истёк. Подтвердите согласие ещё раз.'
		);
	}

	function scheduleSessionExpiry(expiresAt) {
		clearSessionExpiryTimer();
		sessionExpiryTimer = window.setTimeout(
			expireSession,
			Math.max(0, expiresAt - Date.now())
		);
	}

	function setInFlight(value) {
		inFlight = value;
		input.disabled = value || !consentAccepted;
		sendButton.disabled = value || !consentAccepted;
		statusText.textContent = value
			? 'Формирует ответ…'
			: 'Отвечает по инструкциям';
	}

	function setConsentInFlight(value) {
		consentInFlight = value;
		if (value) consentPanel.setAttribute('aria-busy', 'true');
		else consentPanel.removeAttribute('aria-busy');
		consentCheckbox.disabled = value;
		consentButton.disabled = value || !consentCheckbox.checked;
		consentButton.textContent = value
			? 'Сохраняем согласие…'
			: 'Согласен, продолжить';
	}

	function loadTurnstile() {
		if (
			window.turnstile &&
			typeof window.turnstile.render === 'function'
		) {
			return Promise.resolve(window.turnstile);
		}
		if (window.__winAiTurnstileLoader) {
			return window.__winAiTurnstileLoader;
		}
		var script = document.createElement('script');
		var loader = new Promise(function (resolve, reject) {
			script.src =
				'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
			script.async = true;
			script.defer = true;
			script.setAttribute('data-win-ai-turnstile', 'true');
			script.onload = function () {
				if (
					window.turnstile &&
					typeof window.turnstile.render === 'function'
				) {
					resolve(window.turnstile);
				} else {
					reject(new Error('TURNSTILE_UNAVAILABLE'));
				}
			};
			script.onerror = function () {
				reject(new Error('TURNSTILE_UNAVAILABLE'));
			};
			document.head.appendChild(script);
		});
		var retryableLoader = loader.catch(function (error) {
			if (window.__winAiTurnstileLoader === retryableLoader) {
				window.__winAiTurnstileLoader = null;
			}
			script.onload = null;
			script.onerror = null;
			if (script.parentNode) script.parentNode.removeChild(script);
			throw error;
		});
		window.__winAiTurnstileLoader = retryableLoader;
		return window.__winAiTurnstileLoader;
	}

	async function ensureTurnstileWidget() {
		if (turnstileWidgetId !== null) return window.turnstile;
		if (
			!cfg ||
			typeof cfg.turnstileSiteKey !== 'string' ||
			!cfg.turnstileSiteKey ||
			cfg.turnstileAction !== 'ai-consultant-session'
		) {
			throw new Error('TURNSTILE_CONFIG_INVALID');
		}
		var api = await loadTurnstile();
		turnstileWidgetId = api.render(turnstileContainer, {
			sitekey: cfg.turnstileSiteKey,
			action: cfg.turnstileAction,
			cData: KEY,
			appearance: 'interaction-only',
			execution: 'execute',
			callback: function (token) {
				if (!pendingTurnstile) return;
				pendingTurnstile.resolve(token);
			},
			'error-callback': function () {
				if (!pendingTurnstile) return;
				pendingTurnstile.reject(new Error('TURNSTILE_FAILED'));
			},
			'expired-callback': function () {
				if (!pendingTurnstile) return;
				pendingTurnstile.reject(new Error('TURNSTILE_EXPIRED'));
			}
		});
		if (turnstileWidgetId === undefined || turnstileWidgetId === null) {
			throw new Error('TURNSTILE_UNAVAILABLE');
		}
		return api;
	}

	async function getTurnstileToken(controller) {
		var api = await ensureTurnstileWidget();
		if (controller.signal.aborted) throw new Error('TURNSTILE_ABORTED');
		if (pendingTurnstile) throw new Error('TURNSTILE_IN_PROGRESS');
		return new Promise(function (resolve, reject) {
			var challengeTimeout = null;
			function finish(callback, value) {
				if (!pendingTurnstile) return;
				pendingTurnstile = null;
				controller.signal.removeEventListener('abort', onAbort);
				if (challengeTimeout) window.clearTimeout(challengeTimeout);
				callback(value);
			}
			function onAbort() {
				if (!pendingTurnstile) return;
				pendingTurnstile.reject(new Error('TURNSTILE_ABORTED'));
			}
			pendingTurnstile = {
				resolve: function (token) {
					if (typeof token !== 'string' || !token || token.length > 2048) {
						finish(reject, new Error('TURNSTILE_TOKEN_INVALID'));
						return;
					}
					finish(resolve, token);
				},
				reject: function (error) {
					finish(reject, error);
				}
			};
			controller.signal.addEventListener('abort', onAbort, { once: true });
			challengeTimeout = window.setTimeout(function () {
				if (!pendingTurnstile) return;
				pendingTurnstile.reject(new Error('TURNSTILE_TIMEOUT'));
			}, TURNSTILE_CHALLENGE_TIMEOUT_MS);
			try {
				api.reset(turnstileWidgetId);
				api.execute(turnstileWidgetId);
			} catch (error) {
				pendingTurnstile.reject(new Error('TURNSTILE_UNAVAILABLE'));
			}
		});
	}

	async function fetchWithRequestTimeout(
		url,
		options,
		flowController,
		requestTimeoutMs
	) {
		if (flowController.signal.aborted) {
			throw new Error('AI_REQUEST_ABORTED');
		}
		var requestController = new AbortController();
		function abortRequest() {
			requestController.abort();
		}
		flowController.signal.addEventListener('abort', abortRequest, {
			once: true
		});
		var timeout = window.setTimeout(function () {
			requestController.abort();
		}, requestTimeoutMs);
		try {
			return await fetch(
				url,
				Object.assign({}, options, { signal: requestController.signal })
			);
		} finally {
			window.clearTimeout(timeout);
			flowController.signal.removeEventListener('abort', abortRequest);
		}
	}

	async function acceptConsent() {
		if (
			consentInFlight ||
			consentAccepted ||
			inFlight ||
			destroyed ||
			!consentConfig ||
			!consentCheckbox.checked
		) {
			return;
		}
		consentError.textContent = '';
		setConsentInFlight(true);
		var flowController = new AbortController();
		activeController = flowController;
		try {
			var response = await fetchWithRequestTimeout(
				API_BASE +
					'/ai-consultant/' +
					encodeURIComponent(KEY) +
					'/consents',
				getWidgetFetchOptions({
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						acceptanceId: consentAcceptanceId,
						sessionId: sessionId,
						accepted: true,
						documentVersion: consentConfig.documentVersion,
						documentHash: consentConfig.documentHash
					}),
					credentials: 'omit',
					cache: 'no-store'
				}),
				flowController,
				CONSENT_REQUEST_TIMEOUT_MS
			);
			var payload = null;
			try {
				payload = await response.json();
			} catch (error) {}
			if (
				!response.ok ||
				!payload ||
				typeof payload.consentToken !== 'string' ||
				!payload.consentToken ||
				payload.consentToken.length > 3072
			) {
				throw new Error('AI_CONSENT_UNAVAILABLE');
			}
			consentToken = payload.consentToken;
			consentAccepted = true;
			consentPanel.hidden = true;
			turnstileContainer.hidden = false;
			form.hidden = false;
			setInFlight(false);
			if (isOpen && AUTO_FOCUS_ENABLED) input.focus();
		} catch (error) {
			if (!destroyed) {
				consentError.textContent =
					'Не удалось сохранить согласие. Попробуйте ещё раз.';
			}
		} finally {
			if (activeController === flowController) activeController = null;
			setConsentInFlight(false);
		}
	}

	async function ensureSessionToken(flowController) {
		if (!consentAccepted || !consentToken) {
			throw new Error('AI_CONSENT_REQUIRED');
		}
		if (sessionToken && sessionTokenExpiresAt > Date.now()) {
			return sessionToken;
		}
		if (sessionToken) {
			requireFreshConsent(
				'Срок сессии истёк. Подтвердите согласие ещё раз.'
			);
			throw new Error('AI_CONSENT_REQUIRED');
		}
		var turnstileToken = await getTurnstileToken(flowController);
		var response;
		try {
			response = await fetchWithRequestTimeout(
				API_BASE +
					'/ai-consultant/' +
					encodeURIComponent(KEY) +
					'/session',
				getWidgetFetchOptions({
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						sessionId: sessionId,
						turnstileToken: turnstileToken,
						consentToken: consentToken
					}),
					credentials: 'omit',
					cache: 'no-store'
				}),
				flowController,
				SESSION_REQUEST_TIMEOUT_MS
			);
		} finally {
			if (window.turnstile && turnstileWidgetId !== null) {
				try {
					window.turnstile.reset(turnstileWidgetId);
				} catch (error) {}
			}
		}
		var payload = null;
		try {
			payload = await response.json();
		} catch (error) {}
		var expiresAt = payload ? Date.parse(payload.expiresAt) : NaN;
		if (response.status === 401) {
			requireFreshConsent(
				'Согласие недействительно или уже использовано. Подтвердите его ещё раз.'
			);
			throw new Error('AI_CONSENT_REQUIRED');
		}
		if (
			!response.ok ||
			!payload ||
			payload.sessionId !== sessionId ||
			typeof payload.sessionToken !== 'string' ||
			!payload.sessionToken ||
			!Number.isFinite(expiresAt) ||
			expiresAt <= Date.now()
		) {
			throw new Error('AI_SESSION_UNAVAILABLE');
		}
		sessionToken = payload.sessionToken;
		sessionTokenExpiresAt = expiresAt;
		scheduleSessionExpiry(expiresAt);
		return sessionToken;
	}

	async function requestAnswer(text, previousHistory, flowController) {
		await ensureSessionToken(flowController);
		var response = await fetchWithRequestTimeout(
			API_BASE + '/ai-consultant/' + encodeURIComponent(KEY) + '/messages',
			getWidgetFetchOptions({
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					requestId: uuid(),
					sessionId: sessionId,
					sessionToken: sessionToken,
					message: text,
					history: previousHistory
				}),
				credentials: 'omit',
				cache: 'no-store'
			}),
			flowController,
			MESSAGE_REQUEST_TIMEOUT_MS
		);
		if (response.status === 401) {
			requireFreshConsent(
				'Срок сессии истёк. Подтвердите согласие ещё раз.'
			);
			throw new Error('AI_CONSENT_REQUIRED');
		}
		var payload = null;
		try {
			payload = await response.json();
		} catch (error) {}
		if (
			!response.ok ||
			!payload ||
			typeof payload.reply !== 'string' ||
			!payload.reply.trim()
		) {
			throw new Error('AI_RESPONSE_UNAVAILABLE');
		}
		return payload;
	}

	async function sendMessage(text) {
		if (inFlight || destroyed || !consentAccepted || !consentToken) return;
		clearInactivityTimer();
		if (sessionClosed) startNewSession();
		var previousHistory = history.slice(-12);
		var userMessageNode = appendMessage('user', text);
		if (!operatorJoined) {
			operatorJoined = true;
			appendSystem(
				safeText(cfg.operatorName, 'Alex') + ' присоединился к чату'
			);
		}
		showTyping();
		setInFlight(true);
		sendTelemetryEvent('START');
		var flowController = new AbortController();
		activeController = flowController;

		try {
			var payload = await requestAnswer(
				text,
				previousHistory,
				flowController
			);
			hideTyping();
			appendMessage('assistant', payload.reply.trim());
			history = previousHistory.concat([
				{ role: 'user', content: text },
				{ role: 'assistant', content: payload.reply.trim().slice(0, 2000) }
			]);
			if (history.length > 12) history = history.slice(-12);
			sendTelemetryEvent('COMPLETE');
			scheduleInactivity();
		} catch (error) {
			hideTyping();
			if (!destroyed) {
				if (error && error.message === 'AI_CONSENT_REQUIRED') {
					if (userMessageNode.parentNode) {
						userMessageNode.parentNode.removeChild(userMessageNode);
					}
					input.value = text;
				} else {
					appendSystem(
						'AI-оператор временно не может ответить. Попробуйте ещё раз.',
						true
					);
					scheduleInactivity();
				}
			}
		} finally {
			if (activeController === flowController) activeController = null;
			setInFlight(false);
			if (isOpen && !destroyed && AUTO_FOCUS_ENABLED) {
				if (consentAccepted) input.focus();
				else consentCheckbox.focus();
			}
		}
	}

	function openChat() {
		if (!cfg || cfg.isActive === false || isOpen || destroyed) return;
		isOpen = true;
		overlay.classList.add('waic-overlay-open');
		button.classList.add('waic-button-open');
		button.setAttribute('aria-expanded', 'true');
		sendTelemetryEvent('OPEN');
		window.setTimeout(function () {
			if (!AUTO_FOCUS_ENABLED) return;
			if (consentAccepted) input.focus();
			else consentCheckbox.focus();
		}, 30);
	}

	function closeChat() {
		if (!isOpen) return;
		isOpen = false;
		overlay.classList.remove('waic-overlay-open');
		button.classList.remove('waic-button-open');
		button.setAttribute('aria-expanded', 'false');
		button.focus();
	}

	function applyConfig(config) {
		var nextConsentConfig = readConsentConfig(config);
		if (!nextConsentConfig) throw new Error('AI_CONSENT_CONFIG_INVALID');
		cfg = config;
		consentConfig = nextConsentConfig;
		updatePublishedVersion(config.publishedVersion);
		var side = config.buttonSide === 'left' ? 'left' : 'right';
		var bottom = boundedNumber(config.buttonBottom, 3, 1, 50);
		var offset = boundedNumber(config.buttonOffset, 3, 1, 50);
		var size = boundedNumber(config.buttonSize, 60, 40, 100);
		var color = safeCssColor(config.color, '#4705fb');
		var bgColor = safeCssColor(config.bgColor, '#ffffff');
		var textColor = safeCssColor(config.textColor, '#1f2937');
		var buttonColor = safeCssColor(config.buttonColor, color);
		var openButtonColor = safeCssColor(
			config.openButtonColor,
			buttonColor
		);
		var oppositeSide = side === 'left' ? 'right' : 'left';
		dynamicStyle.textContent =
			':host{' +
			'--waic-color:' +
			color +
			';' +
			'--waic-bg:' +
			bgColor +
			';' +
			'--waic-text:' +
			textColor +
			';' +
			'--waic-button-color:' +
			buttonColor +
			';' +
			'--waic-open-button-color:' +
			openButtonColor +
			';' +
			'--waic-offset:' +
			offset +
			'%;' +
			'--waic-panel-bottom:calc(' +
			bottom +
			'% + ' +
			(size + 16) +
			'px)' +
			'}' +
			'.waic-button{' +
			side +
			':' +
			offset +
			'%;' +
			oppositeSide +
			':auto;' +
			'bottom:' +
			bottom +
			'%;' +
			'width:' +
			size +
			'px;' +
			'height:' +
			size +
			'px' +
			'}';
		overlay.classList.toggle('waic-side-left', side === 'left');
		button.classList.toggle(
			'waic-button-pulse',
			config.buttonPulse !== false
		);
		buttonImage.src =
			getSafeExternalUrl(config.buttonImageUrl, false) ||
			getWidgetAssetUrl('ai-consultant-button.png');
		operatorName.textContent = safeText(config.operatorName, 'Alex');
		input.placeholder = safeText(
			config.inputPlaceholder,
			'Задайте вопрос...'
		);
		consentStatement.textContent = consentConfig.statementText;
		consentLink.href = consentConfig.privacyUrl;
		privacyLink.href = consentConfig.privacyUrl;
		privacyLink.hidden = false;
		resetConsentState();
		brand.hidden = config.developInfoActive === false;
		appendMessage(
			'assistant',
			safeText(
				config.greeting,
				'Здравствуйте! Я Alex, AI-оператор.\nГотов помочь и ответить на ваши вопросы о товарах, услугах и условиях компании.'
			)
		);
		button.classList.add('waic-button-ready');
		sendTelemetryEvent('IMPRESSION');
		var autoOpenDelay = boundedNumber(config.autoOpenDelay, 0, 0, 86400);
		if (AUTO_OPEN || autoOpenDelay > 0) {
			autoOpenTimer = window.setTimeout(
				openChat,
				AUTO_OPEN ? 0 : autoOpenDelay * 1000
			);
		}
	}

	function handleLauncherClick() {
		if (isOpen) closeChat();
		else openChat();
	}

	function handleSubmit(event) {
		event.preventDefault();
		var text = input.value.trim();
		if (!text || inFlight || !consentAccepted || !consentToken) return;
		input.value = '';
		sendMessage(text);
	}

	function handleConsentChange() {
		consentError.textContent = '';
		consentButton.disabled = consentInFlight || !consentCheckbox.checked;
	}

	function handleInputKeydown(event) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			form.requestSubmit();
		}
	}

	function handleDocumentKeydown(event) {
		if (event.key === 'Escape' && isOpen) closeChat();
	}

	function destroy() {
		if (destroyed) return;
		destroyed = true;
		clearInactivityTimer();
		clearSessionExpiryTimer();
		if (autoOpenTimer) window.clearTimeout(autoOpenTimer);
		if (activeController) activeController.abort();
		configController.abort();
		resetTurnstileState();
		button.removeEventListener('click', handleLauncherClick);
		closeButton.removeEventListener('click', closeChat);
		consentCheckbox.removeEventListener('change', handleConsentChange);
		consentButton.removeEventListener('click', acceptConsent);
		form.removeEventListener('submit', handleSubmit);
		input.removeEventListener('keydown', handleInputKeydown);
		document.removeEventListener('keydown', handleDocumentKeydown);
		if (host.parentNode) host.parentNode.removeChild(host);
		if (
			window.winAiConsultantWidget &&
			window.winAiConsultantWidget.destroy === destroy
		) {
			delete window.winAiConsultantWidget;
		}
		delete window.__winAiConsultantScriptRunning;
	}

	button.addEventListener('click', handleLauncherClick);
	closeButton.addEventListener('click', closeChat);
	consentCheckbox.addEventListener('change', handleConsentChange);
	consentButton.addEventListener('click', acceptConsent);
	form.addEventListener('submit', handleSubmit);
	input.addEventListener('keydown', handleInputKeydown);
	document.addEventListener('keydown', handleDocumentKeydown);
	window.winAiConsultantWidget = { destroy: destroy };

	fetch(
		API_BASE + '/ai-consultant/' + encodeURIComponent(KEY) + '/config',
		getWidgetFetchOptions({
			credentials: 'omit',
			cache: 'no-store',
			signal: configController.signal
		})
	)
		.then(function (response) {
			if (!response.ok) throw new Error('CONFIG_UNAVAILABLE');
			return response.json();
		})
		.then(function (config) {
			if (destroyed) return;
			if (!config || config.isActive === false)
				throw new Error('WIDGET_INACTIVE');
			applyConfig(config);
		})
		.catch(function () {
			if (!destroyed) destroy();
		});
})();
