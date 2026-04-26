(function () {
	'use strict';

	if (window.__wincallbackScriptRunning) return;
	window.__wincallbackScriptRunning = true;

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
		(_currentScript && _currentScript.getAttribute('data-key')) || '';
	if (!KEY) return;

	var AUTO_OPEN = Boolean(
		window.wincallbackAutoOpen ||
		window.winwidgetCallbackAutoOpen ||
		(window.winwidget && window.winwidget.autoOpen)
	);

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

	// ─── Floating button ──────────────────────────────────────────────────────

	var cbBtn = document.createElement('div');
	cbBtn.id = 'callback-widget-button';
	cbBtn.innerHTML = [
		'<div id="wcb-bubble" style="',
		'display:none;position:absolute;top:50%;transform:translateY(-50%) scale(0.85);',
		'background:#fff;border-radius:14px;padding:10px 30px 10px 14px;',
		'width:150px;box-sizing:border-box;',
		'border:1px solid rgba(71,5,251,0.1);',
		'box-shadow:0 8px 28px rgba(71,5,251,0.16),0 2px 8px rgba(0,0,0,0.08);',
		'cursor:pointer;opacity:0;',
		'transition:opacity 0.3s ease,transform 0.35s cubic-bezier(.22,1,.36,1);',
		'font-family:system-ui,-apple-system,sans-serif;',
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
		'<div id="wcb-bubble-tail" style="',
		'position:absolute;top:50%;transform:translateY(-50%);',
		'width:0;height:0;',
		'border-top:7px solid transparent;border-bottom:7px solid transparent;',
		'"></div>',
		'</div>',
		'<div id="wcb-btn-icon" style="',
		'filter:drop-shadow(0 6px 24px rgba(71,5,251,0.6)) drop-shadow(0 2px 8px rgba(0,0,0,0.25));',
		'transition:filter 0.4s ease,transform 0.2s cubic-bezier(.34,1.56,.64,1);',
		'">',
		'<svg width="60" height="60" viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg">',
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
		'</div>'
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
		'@keyframes wcbPulse{0%,100%{box-shadow:0 0 0 0 rgba(71,5,251,0.4)}70%{box-shadow:0 0 0 14px rgba(71,5,251,0)}}',
		'@keyframes wcbShake{0%,100%{transform:translateX(0)}12%{transform:translateX(-5px)}25%{transform:translateX(5px)}37%{transform:translateX(-4px)}50%{transform:translateX(4px)}62%{transform:translateX(-2px)}75%{transform:translateX(2px)}87%{transform:translateX(-1px)}}',
		'.wcb-field-err{border-color:#ef4444!important;box-shadow:0 0 0 3px rgba(239,68,68,0.15)!important}',
		'.wcb-shake{animation:wcbShake 420ms ease}',
		'.wcb-err-text{color:#ef4444;font-size:11px;margin-top:5px;display:none;padding-left:2px}',
		'.wcb-err-text.wcb-err-show{display:block}',
		'#wcb-btn-icon:hover{transform:scale(1.1)!important}',
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
	].join('');
	document.head.appendChild(styleAnim);

	// ─── Modal ────────────────────────────────────────────────────────────────

	var overlay = document.createElement('div');
	overlay.id = 'callback-widget-overlay';
	overlay.style.cssText = [
		'position:fixed',
		'inset:0',
		'z-index:10000',
		'display:none',
		'align-items:center',
		'justify-content:center',
		'padding:16px',
		'box-sizing:border-box'
	].join(';');

	var backdrop = document.createElement('div');
	backdrop.style.cssText =
		'position:absolute;inset:0;background:rgba(0,0,0,0.45);backdrop-filter:blur(3px);';
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
		'font-family:system-ui,-apple-system,sans-serif',
		'max-height:calc(100svh - 48px)',
		'overflow-y:auto',
		'-webkit-overflow-scrolling:touch',
		'transform:translateY(40px)',
		'opacity:0',
		'transition:transform 380ms cubic-bezier(.22,1,.36,1),opacity 280ms ease'
	].join(';');
	overlay.appendChild(modal);
	document.body.appendChild(overlay);

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
		setTimeout(function () {
			input.classList.remove('wcb-shake');
		}, 450);
	}

	function positionButton() {
		if (!cfg) return;
		var side = cfg.buttonSide === 'left' ? 'left' : 'right';
		var opp = side === 'left' ? 'right' : 'left';
		var bottom = (cfg.buttonBottom || 3) * 16;
		var offset = (cfg.buttonOffset || 3) * 16;
		cbBtn.style.bottom = bottom + 'px';
		cbBtn.style[side] = offset + 'px';
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
		var svgGrad = icon.querySelector('#wcbGrad');
		if (svgGrad) {
			svgGrad.children[0].setAttribute('stop-color', color);
			svgGrad.children[1].setAttribute('stop-color', color);
		}
		var glowColor = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.6)';
		icon.style.filter =
			'drop-shadow(0 6px 24px ' +
			glowColor +
			') drop-shadow(0 2px 8px rgba(0,0,0,0.25))';
	}

	// ─── Build modal content ──────────────────────────────────────────────────

	function buildBrand() {
		var wrap = document.createElement('div');
		wrap.id = 'wcb-brand';
		wrap.innerHTML =
			'\u0421\u0434\u0435\u043b\u0430\u043d\u043e \u0432&nbsp;<a href="https://winwidget.ru" target="_blank" rel="noopener">winwidget.ru</a>';
		return wrap;
	}

	function buildForm() {
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

		var maskDef = MASKS[cfg.phoneRegion] || MASKS.RU;
		var phoneValid = false;

		var phoneWrap = el('div', { marginBottom: '12px' });

		var phoneInput = document.createElement('input');
		phoneInput.type = 'tel';
		phoneInput.autocomplete = 'tel';
		phoneInput.placeholder = maskDef.placeholder;
		phoneInput.value = applyMask('', maskDef);
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

		var prevRaw = getRawDigits(phoneInput.value, maskDef);

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

		function applyPhoneUpdate(newRaw) {
			var masked = applyMask(newRaw, maskDef);
			prevRaw = getRawDigits(masked, maskDef);
			phoneInput.value = masked;
			phoneValid = isPhoneComplete(masked, maskDef);
			submitBtn.style.opacity = phoneValid ? '1' : '0.5';
			clearPhoneErr();
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
		phoneInput.addEventListener('keydown', function (e) {
			if (e.key === 'Backspace') {
				e.preventDefault();
				applyPhoneUpdate(prevRaw.slice(0, -1));
			}
		});
		phoneInput.addEventListener('input', function (e) {
			var isDelete =
				e.inputType === 'deleteContentBackward' ||
				e.inputType === 'deleteContentForward';
			if (isDelete) {
				var currentRaw = getRawDigits(phoneInput.value, maskDef);
				if (currentRaw.length >= prevRaw.length) {
					applyPhoneUpdate(prevRaw.slice(0, -1));
				} else {
					applyPhoneUpdate(currentRaw);
				}
			} else {
				applyPhoneUpdate(getRawDigits(phoneInput.value, maskDef));
			}
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
			marginBottom: cfg.privacyUrl ? '12px' : '0',
			transition: 'opacity 0.2s, transform 0.15s',
			opacity: '0.5'
		});
		submitBtn.textContent = cfg.submitButtonText || 'Заказать звонок';

		submitBtn.addEventListener('mouseenter', function () {
			if (phoneValid) submitBtn.style.opacity = '0.88';
		});
		submitBtn.addEventListener('mouseleave', function () {
			submitBtn.style.opacity = phoneValid ? '1' : '0.5';
		});

		var isSubmitting = false;
		submitBtn.addEventListener('click', function () {
			if (isSubmitting) return;
			if (!phoneValid) {
				showPhoneErr();
				return;
			}

			var phone = phoneInput.value.replace(/\D/g, '');

			isSubmitting = true;
			submitBtn.disabled = true;
			submitBtn.style.opacity = '0.6';
			submitBtn.textContent = 'Отправляем...';

			var timezone = '';
			try {
				timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
			} catch (e) {}

			fetch(API_BASE + '/callback/' + KEY + '/lead', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					phone: '+' + phone,
					timeSlot: timeSelect ? timeSelect.value : '',
					timezone: timezone,
					url: window.location.href
				})
			})
				.then(function (r) {
					return r.json();
				})
				.then(function () {
					submitted = true;
					buildSuccess();
				})
				.catch(function () {
					isSubmitting = false;
					submitBtn.disabled = false;
					submitBtn.style.opacity = '1';
					submitBtn.textContent =
						cfg.submitButtonText || 'Заказать звонок';
				});
		});

		modal.appendChild(submitBtn);

		// Privacy link
		if (cfg.privacyUrl) {
			var privacyEl = el('p', {
				margin: '0',
				fontSize: '11px',
				color: '#bbb',
				textAlign: 'center',
				lineHeight: '1.5'
			});
			privacyEl.innerHTML =
				'Нажимая кнопку, вы соглашаетесь с <a href="' +
				cfg.privacyUrl +
				'" target="_blank" style="color:#bbb">политикой конфиденциальности</a>';
			modal.appendChild(privacyEl);
		}
		modal.appendChild(buildBrand());
	}

	function buildSuccess() {
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

	function openModal() {
		if (isOpen) return;
		isOpen = true;
		overlay.style.display = 'flex';
		submitted ? buildSuccess() : buildForm();
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
		modal.style.transform = 'translateY(40px)';
		modal.style.opacity = '0';
		setTimeout(function () {
			if (!isOpen) overlay.style.display = 'none';
		}, 300);
		fireEvent('close');
	}

	function fireEvent(name) {
		try {
			document.dispatchEvent(
				new CustomEvent('winwidget:callback:' + name)
			);
		} catch (e) {}
	}

	// ─── Clicks ───────────────────────────────────────────────────────────────

	function hideBubble() {
		var bubble = document.getElementById('wcb-bubble');
		if (!bubble || bubble.style.display === 'none') return;
		bubble.style.opacity = '0';
		bubble.style.transform = 'translateY(-50%) scale(0.85)';
		setTimeout(function () {
			bubble.style.display = 'none';
		}, 300);
	}

	cbBtn.addEventListener('click', function () {
		hideBubble();
		isOpen ? closeModal() : openModal();
	});

	backdrop.addEventListener('click', function () {
		if (!AUTO_OPEN) closeModal();
	});

	// ─── Init ─────────────────────────────────────────────────────────────────

	fetch(API_BASE + '/callback/' + KEY + '/config')
		.then(function (r) {
			return r.json();
		})
		.then(function (data) {
			if (!data || !data.isActive) return;

			cfg = data;

			var size = cfg.buttonSize || 60;

			positionButton();
			cbBtn.style.display = AUTO_OPEN ? 'none' : 'flex';

			var iconEl = cbBtn.querySelector('#wcb-btn-icon');
			if (iconEl) {
				var svg = iconEl.querySelector('svg');
				if (svg) {
					svg.setAttribute('width', size);
					svg.setAttribute('height', size);
					svg.setAttribute('viewBox', '0 0 60 60');
				}
			}

			if (cfg.color) applyColor(cfg.color);

			if (cfg.bgColor) modal.style.background = cfg.bgColor;

			updateBubbleSide(cfg.buttonSide || 'right');

			var bubbleClose = document.getElementById('wcb-bubble-close');
			var bubbleEl = document.getElementById('wcb-bubble');
			var bubbleText = document.getElementById('wcb-bubble-text');

			if (bubbleText)
				bubbleText.textContent =
					cfg.bubbleText || cfg.title || 'Перезвоним!';

			if (bubbleClose) {
				bubbleClose.addEventListener('click', function (e) {
					e.stopPropagation();
					hideBubble();
				});
			}

			if (bubbleEl) {
				bubbleEl.addEventListener('click', function () {
					hideBubble();
					openModal();
				});
			}

			if (!AUTO_OPEN) {
				setTimeout(function () {
					var b = document.getElementById('wcb-bubble');
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

			if (cfg.buttonPulse) {
				var pulseStyle = document.createElement('style');
				pulseStyle.textContent =
					'#wcb-pulse-ring{animation:wcbPulse 2s cubic-bezier(0.66,0,0,1) infinite}';
				document.head.appendChild(pulseStyle);
				var ring = document.createElement('div');
				ring.id = 'wcb-pulse-ring';
				css(ring, {
					position: 'absolute',
					width: size + 'px',
					height: size + 'px',
					borderRadius: '50%',
					border: '3px solid ' + (cfg.color || '#4705fb'),
					boxSizing: 'border-box',
					pointerEvents: 'none'
				});
				var firstChild = cbBtn.querySelector('#wcb-btn-icon');
				if (firstChild) firstChild.style.position = 'relative';
				cbBtn.insertBefore(ring, cbBtn.firstChild);
			}

			if (cfg.hasSubmittedByIp && cfg.filterDuplicates) return;

			if (cfg.autoOpenDelay && cfg.autoOpenDelay > 0) {
				setTimeout(function () {
					if (!isOpen) openModal();
				}, cfg.autoOpenDelay * 1000);
			}

			if (AUTO_OPEN) {
				openModal();
			}
		})
		.catch(function () {});

	// ─── Public API ───────────────────────────────────────────────────────────

	window.winwidgetCallback = {
		open: openModal,
		close: closeModal
	};
})();
