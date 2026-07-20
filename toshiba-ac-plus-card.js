// src/toshiba-ac-plus-card.ts
var CARD_VERSION = "0.2.7";
var DEFAULT_DURATIONS = [15, 30, 60, 90, 120];
var HVAC_MODES = ["off", "auto", "cool", "heat", "dry", "fan_only"];
var DIAL_CENTER = 160;
var DIAL_RADIUS = 118;
var DIAL_START_DEGREES = 140;
var DIAL_SWEEP_DEGREES = 260;
var DIAL_ARC_LENGTH = Math.round(DIAL_RADIUS * DIAL_SWEEP_DEGREES * Math.PI / 180);
function dialPoint(percent) {
  const angle = (DIAL_START_DEGREES + percent * DIAL_SWEEP_DEGREES) * Math.PI / 180;
  return {
    x: DIAL_CENTER + DIAL_RADIUS * Math.cos(angle),
    y: DIAL_CENTER + DIAL_RADIUS * Math.sin(angle)
  };
}
function dialArcPath() {
  const start = dialPoint(0);
  const end = dialPoint(1);
  return `M${start.x.toFixed(1)} ${start.y.toFixed(1)} A${DIAL_RADIUS} ${DIAL_RADIUS} 0 1 1 ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
}
var FEATURE_LABELS = {
  high_power: { name: "High power", icon: "mdi:high-power" },
  eco: { name: "ECO", icon: "mdi:eco" },
  outdoor_silent: { name: "Outdoor silent", icon: "mdi:home-sound-in-outline" },
  air_purifier: { name: "Air purifier", icon: "mdi:air-purifier" }
};
function fireEvent(node, type, detail, options = {}) {
  node.dispatchEvent(
    new CustomEvent(type, {
      bubbles: options.bubbles ?? true,
      cancelable: options.cancelable ?? false,
      composed: options.composed ?? true,
      detail
    })
  );
}
function hasEntity(hass, entityId) {
  return Boolean(entityId && hass?.states[entityId]);
}
function titleCase(value) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function escapeHtml(value) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  return value.replace(/[&<>"]/g, (char) => map[char] ?? char);
}
function objectId(entityId) {
  return entityId.split(".")[1] ?? entityId;
}
function durationToTime(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:00`;
}
function numericAttribute(entity, key, fallback) {
  const value = Number(entity.attributes[key]);
  return Number.isFinite(value) ? value : fallback;
}
function formatTemperature(value, unit) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "\u2014";
  return `${numeric.toLocaleString(void 0, { maximumFractionDigits: 1 })}${unit ?? "\xB0C"}`;
}
function asStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}
function nextFromList(values, current, fallback) {
  if (!values.length) return fallback;
  const currentIndex = values.indexOf(String(current));
  return values[(currentIndex + 1) % values.length] ?? fallback;
}
var ToshibaAcPlusCard = class extends HTMLElement {
  constructor() {
    super(...arguments);
    this._isDraggingDial = false;
  }
  setConfig(config) {
    if (!config.entity) {
      throw new Error("Toshiba AC Plus Card requires an entity, e.g. climate.living_room");
    }
    this._config = {
      ...config,
      features: { auto_detect: true, ...config.features ?? {} }
    };
    this.render();
  }
  set hass(hass) {
    this._hass = hass;
    if (this._isDraggingDial || this.querySelector("details[open]")) {
      return;
    }
    this.render();
  }
  getCardSize() {
    return 8;
  }
  static getStubConfig(hass) {
    const climate = Object.keys(hass.states).find((entity) => entity.startsWith("climate."));
    return {
      type: "custom:toshiba-ac-plus-card",
      entity: climate ?? "climate.living_room",
      name: climate ? titleCase(objectId(climate)) : "Living Room AC",
      features: { auto_detect: true }
    };
  }
  static getConfigElement() {
    return document.createElement("toshiba-ac-plus-card-editor");
  }
  get climate() {
    return this._config && this._hass?.states[this._config.entity];
  }
  featureEntity(feature) {
    const config = this._config;
    if (!config) return void 0;
    const configured = config.features?.[feature];
    if (configured === false) return void 0;
    if (typeof configured === "string" && configured) return configured;
    if (config.features?.auto_detect === false) return void 0;
    const base = objectId(config.entity);
    const candidates = {
      high_power: `switch.${base}_high_power_mode`,
      eco: `switch.${base}_eco_mode`,
      outdoor_silent: `select.${base}_outdoor_unit_silent_mode`,
      air_purifier: `switch.${base}_air_purifier`
    };
    return candidates[feature];
  }
  render() {
    if (!this._config || !this._hass) return;
    const climate = this.climate;
    const name = this._config.name ?? climate?.attributes.friendly_name?.toString() ?? this._config.entity;
    this.innerHTML = `
      <ha-card class="tap-card">
        <div class="header">
          <div>
            <div class="title">${name}</div>
          </div>
          <ha-icon icon="mdi:air-conditioner"></ha-icon>
        </div>
        ${climate ? this.renderClimate(climate) : this.renderWarning(`Entity not found: ${this._config.entity}`)}
        ${this.renderControls()}
      </ha-card>
      <style>${styles}</style>
    `;
    this.bindEvents();
  }
  renderClimate(entity) {
    const unit = entity.attributes.temperature_unit ?? "\xB0C";
    const stateTarget = numericAttribute(entity, "temperature", numericAttribute(entity, "current_temperature", 22));
    const minTemp = numericAttribute(entity, "min_temp", 16);
    const maxTemp = numericAttribute(entity, "max_temp", 30);
    const target = this._dragTemperature ?? stateTarget;
    const currentTemperature = numericAttribute(entity, "current_temperature", target);
    const range = Math.max(maxTemp - minTemp, 1);
    const percent = Math.min(1, Math.max(0, (target - minTemp) / range));
    const currentPercent = Math.min(1, Math.max(0, (currentTemperature - minTemp) / range));
    const dash = Math.round(DIAL_ARC_LENGTH * percent);
    const thumb = dialPoint(percent);
    const dot = dialPoint(currentPercent);
    const arcPath = dialArcPath();
    const mode = titleCase(entity.state);
    return `
      <div class="thermostat-shell">
        <div class="current-label">Current temperature</div>
        <div class="current-value">${formatTemperature(entity.attributes.current_temperature, unit)}</div>
        <div class="dial-wrap">
          <svg class="dial" viewBox="0 0 320 320" data-action="dial" aria-label="Drag or click to set target temperature">
            <path class="dial-hit" d="${arcPath}" />
            <path class="dial-track" d="${arcPath}" />
            <path class="dial-progress" d="${arcPath}" stroke-dasharray="${dash} ${DIAL_ARC_LENGTH}" />
            <circle class="dial-thumb" cx="${thumb.x}" cy="${thumb.y}" r="13" />
            <circle class="dial-dot" cx="${dot.x}" cy="${dot.y}" r="4" />
          </svg>
          <div class="dial-center" data-role="dial-center" data-unit="${unit}" data-min="${minTemp}" data-max="${maxTemp}" data-step="${numericAttribute(entity, "target_temp_step", 1)}">
            <div class="mode-label">${mode}</div>
            <div class="target-temp" data-role="target-temp">${formatTemperature(target, unit)}</div>
          </div>
        </div>
        <div class="temp-buttons">
          <button class="round-button" data-action="temperatureStep" data-step="down" aria-label="Decrease temperature">\u2212</button>
          <button class="round-button" data-action="temperatureStep" data-step="up" aria-label="Increase temperature">+</button>
        </div>
      </div>
    `;
  }
  renderTimerSelect() {
    const timer = this._config?.timer;
    if (!timer || !timer.entity) {
      return `<div class="timer-placeholder">Timer<br><small>Disabled</small></div>`;
    }
    const timerState = this._hass?.states[timer.entity];
    const durations = timer.durations?.length ? timer.durations : DEFAULT_DURATIONS;
    const options = ["off", ...durations.map((minutes) => String(minutes))];
    const current = timerState?.state === "active" ? "active" : "off";
    return this.renderDropdownTile("timer", "mdi:timer-outline", "Timer", current === "active" ? "Running" : "Off", options, timerState ? "" : "disabled");
  }
  renderControls() {
    const climate = this.climate;
    const hvacModes = asStringArray(climate?.attributes.hvac_modes).filter((mode) => HVAC_MODES.includes(mode));
    const presetModes = asStringArray(climate?.attributes.preset_modes);
    const fanModes = asStringArray(climate?.attributes.fan_modes);
    const swingModes = asStringArray(climate?.attributes.swing_modes);
    const highPower = this.featureEntity("high_power");
    const eco = this.featureEntity("eco");
    return `
      <div class="info-grid">
        ${this.renderSelectTile("hvacSelect", "mdi:snowflake", "Mode", String(climate?.state ?? "off"), hvacModes.length ? hvacModes : HVAC_MODES)}
        ${this.renderSelectTile("presetSelect", "mdi:circle-small", "Preset", String(climate?.attributes.preset_mode ?? ""), presetModes)}
        ${this.renderSelectTile("fanSelect", "mdi:circle-small", "Fan mode", String(climate?.attributes.fan_mode ?? ""), fanModes)}
        ${this.renderSelectTile("swingSelect", "mdi:circle-small", "Swing mode", String(climate?.attributes.swing_mode ?? ""), swingModes)}
      </div>
      <div class="extra-row">
        ${this.renderFeatureTile("high_power", highPower)}
        ${this.renderFeatureTile("eco", eco)}
        ${this.renderTimerSelect()}
      </div>
    `;
  }
  renderSelectTile(action, icon, label, value, options) {
    const safeOptions = options.length ? options : [value || "None"];
    const currentValue = value || safeOptions[0] || "";
    return this.renderDropdownTile(action, icon, label, currentValue, safeOptions);
  }
  renderDropdownTile(action, icon, label, value, options, disabled = "") {
    const display = value === "off" ? "Off" : value === "active" ? "Running" : value ? titleCase(value) : "None";
    return `
      <details class="select-tile ${disabled}" data-dropdown>
        <summary>
          <ha-icon icon="${icon}"></ha-icon>
          <span>${label}</span>
          <strong>${escapeHtml(display)}</strong>
        </summary>
        <div class="select-menu">
          ${options.map((option) => {
      const optionLabel = action === "timer" && option !== "off" ? `${option} min` : option === "off" ? "Off" : option ? titleCase(option) : "None";
      const selected = option === value || (action === "timer" && value === "active" && option !== "off" ? "" : "");
      return `<button class="select-option ${selected ? "selected" : ""}" data-action="dropdownOption" data-select-action="${action}" data-value="${escapeHtml(option)}">${escapeHtml(optionLabel)}</button>`;
    }).join("")}
        </div>
      </details>
    `;
  }
  renderFeatureTile(feature, entityId) {
    const meta = FEATURE_LABELS[feature];
    const entity = entityId ? this._hass?.states[entityId] : void 0;
    const disabled = !entity || entity.state === "unavailable";
    const active = entity?.state === "on";
    return `
      <button class="tile ${active ? "active" : ""} ${disabled ? "disabled" : ""}" data-action="feature" data-feature="${feature}" data-entity="${entityId ?? ""}" ${disabled ? "disabled" : ""}>
        <ha-icon icon="${meta.icon}"></ha-icon>
        <span>${meta.name}</span>
      </button>
    `;
  }
  renderWarning(message) {
    return `<div class="warning">${message}</div>`;
  }
  bindEvents() {
    this.querySelectorAll("details[data-dropdown]").forEach((details) => {
      details.addEventListener("toggle", () => {
        if (!details.open) return;
        this.querySelectorAll("details[data-dropdown][open]").forEach((other) => {
          if (other !== details) other.removeAttribute("open");
        });
      });
    });
    this.querySelectorAll("[data-action]").forEach((element) => {
      const action = element.dataset.action;
      if (action === "dropdownOption") {
        element.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.handleDropdownOption(element);
        });
        return;
      }
      if (element instanceof HTMLInputElement && action === "temperature") {
        element.addEventListener("change", () => this.handleTemperature(element));
        return;
      }
      if (action === "dial") {
        element.addEventListener("pointerdown", (event) => this.handleDialPointer(event, element));
        return;
      }
      element.addEventListener("click", () => this.handleAction(element));
    });
  }
  handleDropdownOption(element) {
    if (!this._hass || !this._config) return;
    const value = element.dataset.value ?? "";
    const action = element.dataset.selectAction;
    element.closest("details")?.removeAttribute("open");
    if (!value) return;
    if (action === "timer") {
      this.handleTimerValue(value);
      return;
    }
    if (action === "hvacSelect") {
      this._hass.callService("climate", "set_hvac_mode", { hvac_mode: value }, { entity_id: this._config.entity });
      return;
    }
    if (action === "presetSelect") {
      this._hass.callService("climate", "set_preset_mode", { preset_mode: value }, { entity_id: this._config.entity });
      return;
    }
    if (action === "fanSelect") {
      this._hass.callService("climate", "set_fan_mode", { fan_mode: value }, { entity_id: this._config.entity });
      return;
    }
    if (action === "swingSelect") {
      this._hass.callService("climate", "set_swing_mode", { swing_mode: value }, { entity_id: this._config.entity });
    }
  }
  handleDialPointer(event, svg) {
    const climate = this.climate;
    if (!climate) return;
    let pendingTemperature = numericAttribute(climate, "temperature", numericAttribute(climate, "current_temperature", 22));
    const minTemp = numericAttribute(climate, "min_temp", 16);
    const maxTemp = numericAttribute(climate, "max_temp", 30);
    const step = numericAttribute(climate, "target_temp_step", 1);
    const unit = climate.attributes.temperature_unit ?? "\xB0C";
    const preview = (temperature) => {
      const percent = Math.min(1, Math.max(0, (temperature - minTemp) / Math.max(maxTemp - minTemp, 1)));
      const thumbPoint = dialPoint(percent);
      svg.querySelector(".dial-progress")?.setAttribute("stroke-dasharray", `${Math.round(DIAL_ARC_LENGTH * percent)} ${DIAL_ARC_LENGTH}`);
      const thumb = svg.querySelector(".dial-thumb");
      thumb?.setAttribute("cx", String(thumbPoint.x));
      thumb?.setAttribute("cy", String(thumbPoint.y));
      const target = this.querySelector('[data-role="target-temp"]');
      if (target) target.textContent = formatTemperature(temperature, unit);
    };
    const temperatureFromPointer = (pointer) => {
      const rect = svg.getBoundingClientRect();
      const x = (pointer.clientX - rect.left) / rect.width * 320;
      const y = (pointer.clientY - rect.top) / rect.height * 320;
      let degrees = Math.atan2(y - DIAL_CENTER, x - DIAL_CENTER) * 180 / Math.PI;
      if (degrees < 0) degrees += 360;
      if (degrees < DIAL_START_DEGREES) degrees += 360;
      const percent = Math.min(1, Math.max(0, (degrees - DIAL_START_DEGREES) / DIAL_SWEEP_DEGREES));
      const raw = minTemp + percent * (maxTemp - minTemp);
      const snapped = Math.round(raw / step) * step;
      return Math.min(maxTemp, Math.max(minTemp, snapped));
    };
    const update = (pointer) => {
      pendingTemperature = temperatureFromPointer(pointer);
      this._dragTemperature = pendingTemperature;
      window.requestAnimationFrame(() => preview(pendingTemperature));
    };
    event.preventDefault();
    this._isDraggingDial = true;
    this._dragTemperature = pendingTemperature;
    svg.setPointerCapture?.(event.pointerId);
    update(event);
    const move = (moveEvent) => update(moveEvent);
    const stop = () => {
      svg.removeEventListener("pointermove", move);
      svg.removeEventListener("pointerup", stop);
      svg.removeEventListener("pointercancel", stop);
      try {
        svg.releasePointerCapture?.(event.pointerId);
      } catch {
      }
      this._isDraggingDial = false;
      this._dragTemperature = void 0;
      this.setTargetTemperature(pendingTemperature);
      this.render();
    };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerup", stop);
    svg.addEventListener("pointercancel", stop);
  }
  setTargetTemperature(temperature) {
    if (!this._hass || !this._config || !Number.isFinite(temperature)) return;
    this._hass.callService("climate", "set_temperature", { temperature }, { entity_id: this._config.entity });
  }
  handleTemperature(input) {
    this.setTargetTemperature(Number(input.value));
  }
  handleAction(element) {
    if (!this._hass || !this._config) return;
    const action = element.dataset.action;
    if (action === "hvac") {
      this._hass.callService("climate", "set_hvac_mode", { hvac_mode: element.dataset.mode }, { entity_id: this._config.entity });
      return;
    }
    if (action === "temperatureStep") {
      const climate = this.climate;
      if (!climate) return;
      const step = numericAttribute(climate, "target_temp_step", 1);
      const current = numericAttribute(climate, "temperature", numericAttribute(climate, "current_temperature", 22));
      const minTemp = numericAttribute(climate, "min_temp", 16);
      const maxTemp = numericAttribute(climate, "max_temp", 30);
      const direction = element.dataset.step === "down" ? -1 : 1;
      const next = Math.min(maxTemp, Math.max(minTemp, current + direction * step));
      this.setTargetTemperature(next);
      return;
    }
    if (action === "modeCycle") {
      const climate = this.climate;
      const modes = asStringArray(climate?.attributes.hvac_modes).filter((mode) => HVAC_MODES.includes(mode));
      const next = nextFromList(modes.length ? modes : HVAC_MODES, climate?.state, "auto");
      if (next) this._hass.callService("climate", "set_hvac_mode", { hvac_mode: next }, { entity_id: this._config.entity });
      return;
    }
    if (action === "presetCycle") {
      const climate = this.climate;
      const presets = asStringArray(climate?.attributes.preset_modes);
      const next = nextFromList(presets, climate?.attributes.preset_mode, presets[0] ?? "Power 50");
      if (next) this._hass.callService("climate", "set_preset_mode", { preset_mode: next }, { entity_id: this._config.entity });
      return;
    }
    if (action === "swing") {
      const current = this.climate?.attributes.swing_mode;
      const next = current === "Swing Vertical" ? "Off" : "Swing Vertical";
      this._hass.callService("climate", "set_swing_mode", { swing_mode: next }, { entity_id: this._config.entity });
      return;
    }
    if (action === "fanQuiet") {
      const current = this.climate?.attributes.fan_mode;
      const next = current === "Quiet" ? "Auto" : "Quiet";
      this._hass.callService("climate", "set_fan_mode", { fan_mode: next }, { entity_id: this._config.entity });
      return;
    }
    if (action === "feature") {
      const entityId = element.dataset.entity;
      const feature = element.dataset.feature;
      if (!entityId || !feature || !hasEntity(this._hass, entityId)) return;
      if (feature === "outdoor_silent") {
        this._hass.callService("select", "select_next", { cycle: true }, { entity_id: entityId });
      } else {
        this._hass.callService("switch", "toggle", void 0, { entity_id: entityId });
      }
    }
  }
  handleTimerValue(value) {
    if (!this._hass || !this._config || !this._config.timer || !this._config.timer.entity) return;
    const entityId = this._config.timer.entity;
    if (value === "off" || value === "") {
      this._hass.callService("timer", "cancel", void 0, { entity_id: entityId });
      return;
    }
    const minutes = Number(value);
    if (Number.isFinite(minutes) && minutes > 0) {
      this._hass.callService("timer", "start", { duration: durationToTime(minutes) }, { entity_id: entityId });
    }
  }
};
var ToshibaAcPlusCardEditor = class extends HTMLElement {
  setConfig(config) {
    this._config = { ...config, features: { auto_detect: true, ...config.features ?? {} } };
    this.render();
  }
  set hass(hass) {
    this._hass = hass;
    this.render();
  }
  render() {
    if (!this._config) return;
    const timerConfig = typeof this._config.timer === "object" ? this._config.timer : void 0;
    const timerDurations = timerConfig?.durations ?? DEFAULT_DURATIONS;
    this.innerHTML = `
      <div class="editor">
        <label>Climate entity</label>
        <ha-entity-picker .hass="${""}" data-key="entity" domain-filter="climate" value="${this._config.entity ?? ""}" allow-custom-entity></ha-entity-picker>
        <label>Name</label>
        <ha-textfield data-key="name" value="${this._config.name ?? ""}"></ha-textfield>
        <label>Timer entity</label>
        <ha-entity-picker data-key="timer.entity" domain-filter="timer" value="${timerConfig?.entity ?? ""}" allow-custom-entity></ha-entity-picker>
        <label>Timer durations, minutes</label>
        <ha-textfield data-key="timer.durations" value="${timerDurations.join(", ")}"></ha-textfield>
        <label><input type="checkbox" data-key="features.auto_detect" ${this._config.features?.auto_detect !== false ? "checked" : ""}> Auto-detect feature entities</label>
      </div>
      <style>
        .editor { display: grid; gap: 10px; }
        label { font-weight: 600; }
        ha-textfield, ha-entity-picker { width: 100%; }
      </style>
    `;
    this.querySelectorAll("ha-entity-picker").forEach((picker) => {
      picker.hass = this._hass;
      picker.addEventListener("value-changed", (event) => this.changed(picker.dataset.key, event.detail.value));
    });
    this.querySelectorAll("ha-textfield").forEach((field) => {
      field.addEventListener("change", () => this.changed(field.dataset.key, field.value));
    });
    this.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.addEventListener("change", () => this.changed(input.dataset.key, input.checked));
    });
  }
  changed(key, value) {
    if (!this._config) return;
    const next = structuredClone(this._config);
    if (key === "entity") next.entity = String(value || "");
    if (key === "name") next.name = String(value || "");
    if (key === "timer.entity") {
      next.timer = { ...typeof next.timer === "object" ? next.timer : {}, entity: String(value || "") };
    }
    if (key === "timer.durations") {
      next.timer = {
        ...typeof next.timer === "object" ? next.timer : {},
        durations: String(value || "").split(",").map((part) => Number(part.trim())).filter((num) => Number.isFinite(num) && num > 0)
      };
    }
    if (key === "features.auto_detect") {
      next.features = { ...next.features ?? {}, auto_detect: Boolean(value) };
    }
    fireEvent(this, "config-changed", { config: next });
  }
};
var styles = `
  ha-card.tap-card {
    border-radius: 24px;
    overflow: visible;
    border: 1px solid var(--ha-card-border-color, var(--divider-color));
    background: var(--ha-card-background, var(--card-background-color));
    padding: 18px 18px 28px;
    color: var(--primary-text-color);
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 6px;
  }
  .title { font-size: 18px; font-weight: 700; }
  .subtitle, .muted { color: var(--secondary-text-color); font-size: 12px; }
  .thermostat-shell { display: grid; justify-items: center; margin-top: 4px; }
  .current-label { color: var(--secondary-text-color); font-size: 13px; font-weight: 600; }
  .current-value { font-size: 18px; font-weight: 700; margin-top: 6px; }
  .dial-wrap { position: relative; width: min(360px, 90vw); height: 306px; margin-top: 4px; }
  .dial { width: 100%; height: 100%; overflow: visible; }
  .dial-hit, .dial-track, .dial-progress { fill: none; stroke-linecap: round; }
  .dial-hit { stroke: transparent; stroke-width: 58; cursor: pointer; touch-action: none; }
  .dial-track, .dial-progress { stroke-width: 24; pointer-events: none; }
  .dial-track { stroke: rgba(120,120,120,.16); }
  .dial-progress { stroke: var(--primary-color, #2196f3); filter: drop-shadow(0 0 4px rgba(33,150,243,.25)); }
  .dial-thumb { fill: #e3f2fd; stroke: var(--primary-color, #2196f3); stroke-width: 4; pointer-events: none; }
  .dial-dot { fill: rgba(220,220,220,.65); }
  .dial-center {
    position: absolute;
    inset: 106px 0 auto;
    text-align: center;
    pointer-events: none;
  }
  .mode-label { font-size: 15px; font-weight: 700; color: var(--secondary-text-color); margin-bottom: 12px; position: relative; top: -44px; }
  .target-temp { font-size: 58px; font-weight: 300; line-height: .95; letter-spacing: -2px; }
  .temp-buttons { display: flex; gap: 26px; margin-top: -50px; z-index: 1; }
  .round-button {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    border: 1px solid rgba(220,220,220,.45);
    background: transparent;
    color: var(--primary-text-color);
    font-size: 28px;
    line-height: 1;
    cursor: pointer;
  }
  .round-button:active { transform: scale(.96); }
  .info-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 24px; }
  .extra-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 10px; }
  .select-tile, .tile, .timer-tile, .timer-placeholder {
    min-height: 58px;
    border-radius: 12px;
    border: 0;
    background: rgba(120,120,120,.11);
    color: var(--primary-text-color);
    cursor: pointer;
    box-shadow: none;
  }
  .select-tile {
    position: relative;
    display: block;
    padding: 0;
    z-index: 1;
  }
  .select-tile[open] { z-index: 50; }
  .select-tile.disabled { opacity: .35; pointer-events: none; }
  .select-tile summary {
    display: grid;
    grid-template-columns: 36px 1fr 18px;
    grid-template-areas: "icon label chevron" "icon value chevron";
    align-items: center;
    min-height: 58px;
    padding: 9px 10px;
    list-style: none;
  }
  .select-tile summary::-webkit-details-marker { display: none; }
  .select-tile summary::after { content: "\u2304"; grid-area: chevron; color: var(--secondary-text-color); justify-self: end; font-size: 16px; }
  .select-tile[open] summary::after { transform: rotate(180deg); }
  .select-tile ha-icon { grid-area: icon; --mdc-icon-size: 17px; color: var(--primary-color, #42a5f5); justify-self: center; }
  .select-tile span { grid-area: label; color: var(--secondary-text-color); font-size: 12px; line-height: 1.1; }
  .select-tile strong { grid-area: value; color: var(--primary-text-color); font-size: 14px; line-height: 1.1; font-weight: 700; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .select-menu {
    position: absolute;
    z-index: 100;
    left: 0;
    right: 0;
    top: auto;
    bottom: calc(100% + 6px);
    display: grid;
    gap: 4px;
    padding: 6px;
    border-radius: 14px;
    border: 1px solid rgba(140,140,140,.22);
    background: var(--ha-card-background, var(--card-background-color));
    box-shadow: 0 10px 26px rgba(0,0,0,.35);
  }
  .select-option {
    border: 0;
    border-radius: 10px;
    background: rgba(120,120,120,.10);
    color: var(--primary-text-color);
    min-height: 34px;
    padding: 7px 9px;
    text-align: left;
    font-size: 13px;
    font-weight: 650;
    cursor: pointer;
  }
  .select-option:hover, .select-option.selected { background: rgba(33,150,243,.24); }
  .tile.active ha-icon { color: var(--primary-color, #42a5f5); }
  .tile { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; padding: 6px 4px; }
  .tile ha-icon { --mdc-icon-size: 22px; color: var(--secondary-text-color); }
  .tile span { font-size: 12px; line-height: 1.1; text-align: center; }
  .tile.active { background: rgba(33,150,243,.22); }
  .tile.disabled { opacity: .35; cursor: not-allowed; }
  .timer-placeholder { display: flex; align-items: center; justify-content: center; text-align: center; color: var(--secondary-text-color); font-size: 12px; }
  .warning { margin-top: 14px; color: var(--error-color); }
`;
customElements.define("toshiba-ac-plus-card", ToshibaAcPlusCard);
customElements.define("toshiba-ac-plus-card-editor", ToshibaAcPlusCardEditor);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "toshiba-ac-plus-card",
  name: "Toshiba AC Plus Card",
  description: "Climate card with Toshiba AC extra controls and off timer support",
  preview: true
});
console.info(`%cToshiba AC Plus Card ${CARD_VERSION}`, "color: #42a5f5; font-weight: 700;");
