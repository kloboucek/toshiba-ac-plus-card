// src/toshiba-ac-plus-card.ts
var CARD_VERSION = "0.2.1";
var DEFAULT_DURATIONS = [15, 30, 60, 90, 120];
var HVAC_MODES = ["off", "auto", "cool", "heat", "dry", "fan_only"];
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
            <div class="subtitle">${this._config.entity}</div>
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
    const target = numericAttribute(entity, "temperature", numericAttribute(entity, "current_temperature", 22));
    const minTemp = numericAttribute(entity, "min_temp", 16);
    const maxTemp = numericAttribute(entity, "max_temp", 30);
    const range = Math.max(maxTemp - minTemp, 1);
    const percent = Math.min(1, Math.max(0, (target - minTemp) / range));
    const dash = Math.round(390 * percent);
    const mode = titleCase(entity.state);
    return `
      <div class="thermostat-shell">
        <div class="current-label">Current temperature</div>
        <div class="current-value">${formatTemperature(entity.attributes.current_temperature, unit)}</div>
        <div class="dial-wrap">
          <svg class="dial" viewBox="0 0 260 260" aria-hidden="true">
            <path class="dial-track" d="M64 203 A92 92 0 1 1 196 203" />
            <path class="dial-progress" d="M64 203 A92 92 0 1 1 196 203" stroke-dasharray="${dash} 390" />
            <circle class="dial-thumb" cx="198" cy="132" r="11" />
            <circle class="dial-dot" cx="198" cy="90" r="3" />
          </svg>
          <div class="dial-center">
            <div class="mode-label">${mode}</div>
            <div class="target-temp">${formatTemperature(target, unit)}</div>
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
    return `
      <select class="tile timer-tile" data-action="timer" ${timerState ? "" : "disabled"}>
        <option value="off">Off</option>
        ${durations.map((minutes) => `<option value="${minutes}">${minutes} min</option>`).join("")}
      </select>
    `;
  }
  renderControls() {
    const climate = this.climate;
    const mode = titleCase(climate?.state ?? "unknown");
    const preset = String(climate?.attributes.preset_mode ?? "None");
    const fanMode = String(climate?.attributes.fan_mode ?? "Auto");
    const swingMode = String(climate?.attributes.swing_mode ?? "Off");
    const highPower = this.featureEntity("high_power");
    const eco = this.featureEntity("eco");
    return `
      <div class="info-grid">
        ${this.renderInfoTile("modeCycle", "mdi:snowflake", "Mode", mode, true)}
        ${this.renderInfoTile("presetCycle", "mdi:circle-small", "Preset", preset, preset !== "None")}
        ${this.renderInfoTile("fanQuiet", "mdi:circle-small", "Fan mode", fanMode, fanMode === "Quiet")}
        ${this.renderInfoTile("swing", "mdi:circle-small", "Swing mode", swingMode, swingMode === "Swing Vertical")}
      </div>
      <div class="extra-row">
        ${this.renderFeatureTile("high_power", highPower)}
        ${this.renderFeatureTile("eco", eco)}
        ${this.renderTimerSelect()}
      </div>
    `;
  }
  renderInfoTile(action, icon, label, value, active) {
    return `
      <button class="info-tile ${active ? "active" : ""}" data-action="${action}">
        <ha-icon icon="${icon}"></ha-icon>
        <span>${label}</span>
        <strong>${value}</strong>
      </button>
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
    this.querySelectorAll("[data-action]").forEach((element) => {
      const action = element.dataset.action;
      if (element instanceof HTMLSelectElement && action === "timer") {
        element.addEventListener("change", () => this.handleTimer(element));
        return;
      }
      if (element instanceof HTMLInputElement && action === "temperature") {
        element.addEventListener("change", () => this.handleTemperature(element));
        return;
      }
      element.addEventListener("click", () => this.handleAction(element));
    });
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
  handleTimer(select) {
    if (!this._hass || !this._config || !this._config.timer || !this._config.timer.entity) return;
    const entityId = this._config.timer.entity;
    const value = select.value;
    if (value === "off" || value === "") {
      this._hass.callService("timer", "cancel", void 0, { entity_id: entityId });
      select.value = "off";
      return;
    }
    const minutes = Number(value);
    if (Number.isFinite(minutes) && minutes > 0) {
      this._hass.callService("timer", "start", { duration: durationToTime(minutes) }, { entity_id: entityId });
      select.value = "";
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
    overflow: hidden;
    border: 1px solid var(--ha-card-border-color, var(--divider-color));
    background: var(--ha-card-background, var(--card-background-color));
    padding: 18px 18px 24px;
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
  .dial-wrap { position: relative; width: min(300px, 82vw); height: 246px; margin-top: 8px; }
  .dial { width: 100%; height: 100%; overflow: visible; }
  .dial-track, .dial-progress { fill: none; stroke-linecap: round; stroke-width: 18; }
  .dial-track { stroke: rgba(120,120,120,.16); }
  .dial-progress { stroke: var(--primary-color, #2196f3); filter: drop-shadow(0 0 4px rgba(33,150,243,.25)); }
  .dial-thumb { fill: #e3f2fd; stroke: var(--primary-color, #2196f3); stroke-width: 4; }
  .dial-dot { fill: rgba(220,220,220,.65); }
  .dial-center {
    position: absolute;
    inset: 78px 0 auto;
    text-align: center;
    pointer-events: none;
  }
  .mode-label { font-size: 15px; font-weight: 700; color: var(--secondary-text-color); margin-bottom: -16px; position: relative; top: -32px; }
  .target-temp { font-size: 58px; font-weight: 300; line-height: .95; letter-spacing: -2px; }
  .temp-buttons { display: flex; gap: 26px; margin-top: -38px; z-index: 1; }
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
  .info-tile, .tile, .timer-tile, .timer-placeholder {
    min-height: 58px;
    border-radius: 12px;
    border: 0;
    background: rgba(120,120,120,.11);
    color: var(--primary-text-color);
    cursor: pointer;
    box-shadow: none;
  }
  .info-tile {
    display: grid;
    grid-template-columns: 42px 1fr;
    grid-template-areas: "icon label" "icon value";
    align-items: center;
    text-align: left;
    padding: 10px 12px;
  }
  .info-tile ha-icon { grid-area: icon; --mdc-icon-size: 18px; color: var(--secondary-text-color); justify-self: center; }
  .info-tile span { grid-area: label; color: var(--secondary-text-color); font-size: 12px; line-height: 1.1; }
  .info-tile strong { grid-area: value; font-size: 14px; line-height: 1.1; font-weight: 700; }
  .info-tile.active ha-icon, .tile.active ha-icon { color: var(--primary-color, #42a5f5); }
  .tile { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; padding: 6px 4px; }
  .tile ha-icon { --mdc-icon-size: 22px; color: var(--secondary-text-color); }
  .tile span { font-size: 12px; line-height: 1.1; text-align: center; }
  .tile.active { background: rgba(33,150,243,.22); }
  .tile.disabled { opacity: .35; cursor: not-allowed; }
  .timer-tile { width: 100%; padding: 0 8px; font-size: 13px; text-align: center; }
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
