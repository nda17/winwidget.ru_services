(function () {
	'use strict';

	if (window.__winonlineconsultantScriptRunning) return;
	window.__winonlineconsultantScriptRunning = true;

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
		(_currentScript && _currentScript.getAttribute('data-key')) ||
		window.winonlineconsultant ||
		'';
	if (!KEY) {
		delete window.__winonlineconsultantScriptRunning;
		return;
	}

	var RUNTIME_VERSION = '2026.08';
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
				API_BASE +
					'/widget-events/online-consultant/' +
					encodeURIComponent(KEY),
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

	var AUTO_OPEN = Boolean(
		window.winonlineconsultantAutoOpen ||
		window.winwidgetOnlineConsultantAutoOpen ||
		(window.winwidget && window.winwidget.autoOpen)
	);

	function safeText(value, fallback) {
		return value == null || value === '' ? fallback : String(value);
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

	function getActions() {
		var actions =
			cfg && Array.isArray(cfg.quickActions) ? cfg.quickActions : [];
		return actions.length
			? actions
			: [
					{
						label: 'Цена',
						answer: 'Оставьте контакт, и мы подскажем актуальную цену.',
						buttonText: '',
						buttonUrl: ''
					},
					{
						label: 'Доставка',
						answer: 'Расскажем условия доставки для вашего региона.',
						buttonText: '',
						buttonUrl: ''
					},
					{
						label: 'Сроки',
						answer:
							'Подскажем ориентировочные сроки после уточнения деталей.',
						buttonText: '',
						buttonUrl: ''
					},
					{
						label: 'Подбор',
						answer: 'Поможем подобрать подходящий вариант под задачу.',
						buttonText: '',
						buttonUrl: ''
					}
				];
	}

	function isPhoneRequired() {
		return (
			cfg &&
			(cfg.dataType === 'PHONE' || cfg.dataType === 'PHONE_AND_EMAIL')
		);
	}

	function isEmailRequired() {
		return (
			cfg &&
			(cfg.dataType === 'EMAIL' || cfg.dataType === 'PHONE_AND_EMAIL')
		);
	}

	function isContactDisabled() {
		return cfg && cfg.dataType === 'NONE';
	}

	var cfg = null;
	var isOpen = false;
	var selectedAction = null;
	var submitted = false;

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

	var host = document.createElement('div');
	host.id = 'online-consultant-widget-host';
	document.body.appendChild(host);
	var shadow = host.attachShadow({ mode: 'open' });

	var style = document.createElement('style');
	style.textContent = [
		':host{all:initial}',
		'*{box-sizing:border-box}',
		'.woc-btn{position:fixed;display:none;align-items:center;justify-content:center;cursor:pointer;z-index:10000;user-select:none;-webkit-tap-highlight-color:transparent;transition:transform .25s ease,opacity .25s ease}',
		'.woc-btn:hover{transform:translateY(-2px) scale(1.03)}',
		'.woc-btn img{display:block;width:100%;height:100%;object-fit:contain;filter:drop-shadow(0 10px 22px rgba(239,43,23,.35)) drop-shadow(0 3px 8px rgba(0,0,0,.28))}',
		'.woc-pulse img{animation:wocPulse 2.8s ease-in-out infinite}',
		'@keyframes wocPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}',
		'.woc-overlay{position:fixed;inset:0;z-index:2147483647;display:none;align-items:center;justify-content:center;padding:16px;background:rgba(9,5,22,.76);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);font-family:' +
			SYSTEM_FONT_STACK +
			'}',
		'.woc-overlay-open{display:flex}',
		'.woc-modal{position:relative;width:min(440px,100%);max-height:calc(100vh - 32px);overflow:auto;background:#fff;border-radius:24px;padding:24px;box-shadow:0 28px 80px rgba(0,0,0,.32);transform:translateY(18px) scale(.98);opacity:0;transition:transform .25s ease,opacity .2s ease}',
		'.woc-overlay-open .woc-modal{transform:translateY(0) scale(1);opacity:1}',
		'.woc-close{position:absolute;top:14px;right:14px;width:32px;height:32px;border:0;border-radius:50%;background:#f3f0f5;color:#5c5365;cursor:pointer;font-size:18px}',
		'.woc-title{margin:0 38px 8px 0;color:#1b1720;font-size:26px;line-height:1.14;font-weight:800}',
		'.woc-subtitle{margin:0 0 18px;color:#7b7282;font-size:14px;line-height:1.45}',
		'.woc-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:0 0 16px}',
		'.woc-action{min-height:48px;border:1px solid rgba(239,43,23,.18);border-radius:14px;background:#fff7ed;color:#3b1d13;cursor:pointer;font-size:14px;font-weight:750;line-height:1.2;transition:transform .15s ease,border-color .15s ease,background .15s ease}',
		'.woc-action:hover,.woc-action-active{transform:translateY(-1px);border-color:var(--woc-color);background:#fff0d7}',
		'.woc-answer{display:none;margin:0 0 16px;padding:14px;border-radius:16px;background:#f8f7fb;color:#2a2630;font-size:14px;line-height:1.5}',
		'.woc-answer-show{display:block}',
		'.woc-action-link{display:inline-flex;margin-top:12px;border:0;border-radius:999px;background:var(--woc-color);color:#fff;text-decoration:none;padding:10px 14px;font-weight:700;font-size:13px}',
		'.woc-form{display:none;gap:10px}',
		'.woc-form-show{display:grid}',
		'.woc-contact-title{margin:0 0 2px;color:#1b1720;font-size:15px;font-weight:750}',
		'.woc-field{width:100%;height:44px;border:1px solid #ded8e8;border-radius:12px;padding:0 13px;font-size:14px;outline:none;transition:border-color .15s ease,box-shadow .15s ease}',
		'.woc-field:focus{border-color:var(--woc-color);box-shadow:0 0 0 3px rgba(239,43,23,.12)}',
		'.woc-field-error{border-color:#ef4444!important;box-shadow:0 0 0 3px rgba(239,68,68,.12)!important}',
		'.woc-submit{height:46px;border:0;border-radius:999px;background:var(--woc-button-color);color:#fff;font-size:15px;font-weight:800;cursor:pointer;box-shadow:0 12px 28px rgba(239,43,23,.24)}',
		'.woc-submit:disabled{opacity:.7;cursor:default}',
		'.woc-error{display:none;color:#ef4444;font-size:12px;line-height:1.35}',
		'.woc-error-show{display:block}',
		'.woc-success{display:none;padding:16px;border-radius:16px;background:#f0fdf4;color:#166534;font-size:14px;line-height:1.45}',
		'.woc-success-show{display:block}',
		'.woc-privacy{margin:2px 0 0;color:#8b8494;font-size:11px;line-height:1.35}',
		'.woc-privacy a{color:var(--woc-color);text-decoration:none}',
		'.woc-brand{margin-top:14px;text-align:center;color:#8b8494;font-size:12px;line-height:1.4}',
		'.woc-brand a{color:var(--woc-color);font-weight:700;text-decoration:none}',
		'@media(max-width:480px){.woc-overlay{padding:10px}.woc-modal{padding:22px 16px 18px;border-radius:20px}.woc-title{font-size:23px}.woc-actions{grid-template-columns:1fr}}'
	].join('');
	shadow.appendChild(style);

	var root = document.createElement('div');
	root.innerHTML = [
		'<div class="woc-btn" id="woc-button">',
		'<img id="woc-button-img" alt="" aria-hidden="true" draggable="false" src="' +
			getWidgetAssetUrl('online-consultant-button.png') +
			'">',
		'</div>',
		'<div class="woc-overlay" id="woc-overlay">',
		'<div class="woc-modal" id="woc-modal">',
		'<button class="woc-close" id="woc-close" type="button">×</button>',
		'<h2 class="woc-title" id="woc-title"></h2>',
		'<p class="woc-subtitle" id="woc-subtitle"></p>',
		'<div class="woc-actions" id="woc-actions"></div>',
		'<div class="woc-answer" id="woc-answer"></div>',
		'<form class="woc-form" id="woc-form" novalidate>',
		'<p class="woc-contact-title" id="woc-contact-title"></p>',
		'<input class="woc-field" id="woc-phone" name="phone" inputmode="tel" autocomplete="tel" placeholder="+7 (___) ___-__-__">',
		'<input class="woc-field" id="woc-email" name="email" inputmode="email" autocomplete="email" placeholder="email@example.com">',
		'<button class="woc-submit" id="woc-submit" type="submit"></button>',
		'<p class="woc-error" id="woc-error"></p>',
		'<p class="woc-privacy" id="woc-privacy"></p>',
		'</form>',
		'<div class="woc-success" id="woc-success"></div>',
		'<div class="woc-brand" id="woc-brand">Сделано в <a href="https://winwidget.ru" target="_blank" rel="noopener noreferrer">winwidget.ru</a></div>',
		'</div>',
		'</div>'
	].join('');
	shadow.appendChild(root);

	var button = shadow.getElementById('woc-button');
	var buttonImg = shadow.getElementById('woc-button-img');
	var overlay = shadow.getElementById('woc-overlay');
	var title = shadow.getElementById('woc-title');
	var subtitle = shadow.getElementById('woc-subtitle');
	var actionsWrap = shadow.getElementById('woc-actions');
	var answer = shadow.getElementById('woc-answer');
	var form = shadow.getElementById('woc-form');
	var contactTitle = shadow.getElementById('woc-contact-title');
	var phoneInput = shadow.getElementById('woc-phone');
	var emailInput = shadow.getElementById('woc-email');
	var submitBtn = shadow.getElementById('woc-submit');
	var errorText = shadow.getElementById('woc-error');
	var privacy = shadow.getElementById('woc-privacy');
	var success = shadow.getElementById('woc-success');
	var brand = shadow.getElementById('woc-brand');

	function applyPosition() {
		var side = cfg && cfg.buttonSide === 'left' ? 'left' : 'right';
		var bottom = Number((cfg && cfg.buttonBottom) || 3);
		var offset = Number((cfg && cfg.buttonOffset) || 3);
		var size = Number((cfg && cfg.buttonSize) || 60);
		button.style.width = size + 'px';
		button.style.height = size + 'px';
		button.style.bottom = bottom + '%';
		button.style[side] = offset + '%';
		button.style[side === 'right' ? 'left' : 'right'] = 'auto';
	}

	function setTheme() {
		var color = (cfg && cfg.color) || '#ef2b17';
		var buttonColor = (cfg && (cfg.buttonColor || cfg.color)) || '#ef2b17';
		root.style.setProperty('--woc-color', color);
		root.style.setProperty('--woc-button-color', buttonColor);
		if (cfg && cfg.bgColor) {
			shadow.getElementById('woc-modal').style.background = cfg.bgColor;
		}
	}

	function openModal() {
		if (!cfg || submitted) return;
		isOpen = true;
		overlay.classList.add('woc-overlay-open');
		renderModal();
		sendTelemetryEvent('OPEN');
		firePixelEvent('woc_open');
	}

	function closeModal() {
		isOpen = false;
		overlay.classList.remove('woc-overlay-open');
	}

	function renderModal() {
		var actions = getActions();
		title.textContent = safeText(cfg.title, 'Онлайн-консультант');
		subtitle.textContent = safeText(
			cfg.subtitle,
			'Выберите популярный вопрос и получите быстрый ответ.'
		);
		contactTitle.textContent = safeText(
			cfg.contactTitle,
			'Оставьте контакт, если нужен персональный ответ'
		);
		submitBtn.textContent = safeText(cfg.submitButtonText, 'Отправить');
		phoneInput.style.display = isPhoneRequired() ? 'block' : 'none';
		emailInput.style.display = isEmailRequired() ? 'block' : 'none';
		privacy.textContent = '';
		var privacyUrl = getSafeExternalUrl(cfg.privacyUrl, false);
		if (privacyUrl) {
			privacy.appendChild(
				document.createTextNode('Нажимая кнопку, вы соглашаетесь с ')
			);
			var privacyLink = document.createElement('a');
			privacyLink.href = privacyUrl;
			privacyLink.target = '_blank';
			privacyLink.rel = 'noopener noreferrer';
			privacyLink.textContent = 'обработкой данных';
			privacy.appendChild(privacyLink);
			privacy.appendChild(document.createTextNode('.'));
		}
		brand.style.display =
			cfg.developInfoActive === false || cfg.hideBranding
				? 'none'
				: 'block';
		success.classList.remove('woc-success-show');
		form.classList.remove('woc-form-show');

		actionsWrap.innerHTML = '';
		actions.forEach(function (action, index) {
			var btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'woc-action';
			btn.textContent = safeText(action.label, 'Вопрос');
			btn.addEventListener('click', function () {
				sendTelemetryEvent('START');
				selectedAction = action;
				Array.prototype.forEach.call(
					actionsWrap.querySelectorAll('.woc-action'),
					function (node) {
						node.classList.remove('woc-action-active');
					}
				);
				btn.classList.add('woc-action-active');
				renderAnswer(action);
				if (isContactDisabled()) {
					sendTelemetryEvent('COMPLETE');
				}
			});
			actionsWrap.appendChild(btn);
			if (index === 0 && !selectedAction) {
				selectedAction = action;
				btn.classList.add('woc-action-active');
			}
		});
		renderAnswer(selectedAction || actions[0]);
	}

	function renderAnswer(action) {
		if (!action) return;
		answer.classList.add('woc-answer-show');
		answer.textContent = '';
		var answerText = document.createElement('div');
		answerText.textContent = safeText(action.answer, '');
		answer.appendChild(answerText);

		var actionUrl = getSafeExternalUrl(action.buttonUrl, true);
		if (actionUrl && action.buttonText) {
			var actionLink = document.createElement('a');
			actionLink.className = 'woc-action-link';
			actionLink.href = actionUrl;
			if (
				actionUrl.indexOf('http:') === 0 ||
				actionUrl.indexOf('https:') === 0
			) {
				actionLink.target = '_blank';
				actionLink.rel = 'noopener noreferrer';
			}
			actionLink.textContent = String(action.buttonText);
			actionLink.addEventListener('click', function () {
				sendTelemetryEvent('START');
			});
			answer.appendChild(actionLink);
		}
		if (isContactDisabled()) {
			form.classList.remove('woc-form-show');
		} else {
			form.classList.add('woc-form-show');
		}
	}

	function setError(message) {
		errorText.textContent = message || '';
		errorText.classList.toggle('woc-error-show', Boolean(message));
	}

	function validateEmail(value) {
		return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
	}

	function handleSubmit(event) {
		event.preventDefault();
		sendTelemetryEvent('START');
		if (!cfg || !selectedAction || isContactDisabled()) return;

		var phone = phoneInput.value.trim();
		var email = emailInput.value.trim();
		phoneInput.classList.remove('woc-field-error');
		emailInput.classList.remove('woc-field-error');
		setError('');

		if (isPhoneRequired() && !phone) {
			phoneInput.classList.add('woc-field-error');
			setError('Введите телефон');
			return;
		}
		if (isEmailRequired() && (!email || !validateEmail(email))) {
			emailInput.classList.add('woc-field-error');
			setError('Введите корректный email');
			return;
		}

		submitBtn.disabled = true;
		fetch(
			API_BASE + '/online-consultant/' + encodeURIComponent(KEY) + '/lead',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					key: KEY,
					phone: phone || undefined,
					email: email || undefined,
					actionLabel: selectedAction.label || '',
					actionValue: selectedAction.answer || '',
					url: location.href
				})
			}
		)
			.then(function (response) {
				if (!response.ok) {
					return response.json().then(function (data) {
						throw new Error(
							data && data.message ? data.message : 'Ошибка'
						);
					});
				}
				return response.json();
			})
			.then(function () {
				sendTelemetryEvent('COMPLETE');
				submitted = true;
				button.classList.remove('woc-pulse');
				button.style.display = 'none';
				button.style.pointerEvents = 'none';
				firePixelEvent('woc_send');
				form.classList.remove('woc-form-show');
				success.textContent = '';
				var successTitle = document.createElement('strong');
				successTitle.textContent = safeText(
					cfg.successTitle,
					'Спасибо! Заявка отправлена'
				);
				success.appendChild(successTitle);
				success.appendChild(document.createElement('br'));
				success.appendChild(
					document.createTextNode(
						safeText(cfg.successSubtitle, 'Мы скоро свяжемся с вами')
					)
				);
				success.classList.add('woc-success-show');
			})
			.catch(function (error) {
				setError(error.message || 'Не удалось отправить заявку');
			})
			.finally(function () {
				submitBtn.disabled = false;
			});
	}

	function showDisabledPage() {
		var existing = document.getElementById(
			'online-consultant-widget-disabled'
		);
		if (existing) return;
		var node = document.createElement('div');
		node.id = 'online-consultant-widget-disabled';
		node.style.cssText =
			'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0d0d1a;color:#fff;font-family:' +
			SYSTEM_FONT_STACK +
			';text-align:center;padding:24px;z-index:2147483647';
		node.innerHTML =
			'<div><div style="font-size:42px;margin-bottom:12px">🔒</div><h1 style="font-size:22px">Виджет временно отключён</h1></div>';
		document.body.appendChild(node);
	}

	button.addEventListener('click', function () {
		isOpen ? closeModal() : openModal();
	});
	shadow.getElementById('woc-close').addEventListener('click', closeModal);
	overlay.addEventListener('click', function (event) {
		if (event.target === overlay && !AUTO_OPEN) closeModal();
	});
	form.addEventListener('submit', handleSubmit);
	phoneInput.addEventListener('input', function () {
		sendTelemetryEvent('START');
	});
	emailInput.addEventListener('input', function () {
		sendTelemetryEvent('START');
	});

	fetch(
		API_BASE +
			'/online-consultant/' +
			encodeURIComponent(KEY) +
			'/config?_=' +
			Date.now(),
		AUTO_OPEN ? { referrerPolicy: 'unsafe-url' } : undefined
	)
		.then(function (response) {
			if (!response.ok) {
				console.warn(
					'[winonlineconsultant] Widget not found or inactive (' +
						response.status +
						')'
				);
				return null;
			}
			return response.json();
		})
		.then(function (data) {
			if (data === null) return;
			if (!data || !data.isActive) {
				console.warn('[winonlineconsultant] Widget is inactive');
				if (AUTO_OPEN) showDisabledPage();
				return;
			}

			cfg = data;
			updatePublishedVersion(cfg.publishedVersion);
			if (cfg.hasSubmittedByIp && cfg.filterDuplicates) return;
			sendTelemetryEvent('IMPRESSION');
			setTheme();
			applyPosition();
			button.classList.toggle('woc-pulse', cfg.buttonPulse !== false);
			button.style.display = AUTO_OPEN ? 'none' : 'flex';
			buttonImg.onerror = function () {
				buttonImg.onerror = null;
				buttonImg.src = getWidgetAssetUrl('online-consultant-button.png');
			};
			buttonImg.src =
				cfg.buttonImageUrl ||
				getWidgetAssetUrl('online-consultant-button.png');

			if (cfg.autoOpenDelay && cfg.autoOpenDelay > 0) {
				setTimeout(openModal, cfg.autoOpenDelay * 1000);
			}
			if (AUTO_OPEN) openModal();
		})
		.catch(function (error) {
			console.error('[winonlineconsultant] Failed to load config:', error);
		});

	function destroyWidget() {
		var disabledPage = document.getElementById(
			'online-consultant-widget-disabled'
		);
		if (disabledPage && disabledPage.parentNode)
			disabledPage.parentNode.removeChild(disabledPage);
		if (host.parentNode) host.parentNode.removeChild(host);
		delete window.__winonlineconsultantScriptRunning;
		delete window.winwidgetOnlineConsultant;
	}

	window.winwidgetOnlineConsultant = {
		open: openModal,
		close: closeModal,
		destroy: destroyWidget
	};
})();
