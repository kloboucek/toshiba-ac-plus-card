// src/toshiba-ac-plus-card.ts
var CARD_VERSION = "0.1.0";
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
    return 6;
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
        ${this.renderTimer()}
        ${this.renderControls()}
      </ha-card>
      <style>${styles}</style>
    `;
    this.bindEvents();
  }
  renderClimate(entity) {
    const current = entity.attributes.current_temperature;
    const target = entity.attributes.temperature;
    const unit = entity.attributes.temperature_unit ?? "\xB0C";
    const state = entity.state;
    const supportedModes = Array.isArray(entity.attributes.hvac_modes) ? entity.attributes.hvac_modes : HVAC_MODES;
    const modes = HVAC_MODES.filter((mode) => supportedModes.includes(mode));
    return `
      <div class="climate-block">
        <div class="temperatures">
          <div>
            <div class="big-temp">${target ?? "\u2014"}<span>${unit}</span></div>
            <div class="muted">Target</div>
          </div>
          <div class="current-temp">
            <div>${current ?? "\u2014"}${unit}</div>
            <div class="muted">Current</div>
          </div>
        </div>
        <div class="mode-grid">
          ${modes.map((mode) => `
            <button class="mode-button ${state === mode ? "active" : ""}" data-action="hvac" data-mode="${mode}">${titleCase(mode)}</button>
          `).join("")}
        </div>
      </div>
    `;
  }
  renderTimer() {
    const timer = this._config?.timer;
    if (!timer || !timer.entity) return "";
    const timerState = this._hass?.states[timer.entity];
    const durations = timer.durations?.length ? timer.durations : DEFAULT_DURATIONS;
    const status = timerState ? titleCase(timerState.state) : "Timer entity missing";
    return `
      <div class="section timer-section">
        <div>
          <div class="section-title">Turn-off timer</div>
          <div class="muted">${timer.entity} \xB7 ${status}</div>
        </div>
        <select class="timer-select" data-action="timer" ${timerState ? "" : "disabled"}>
          <option value="">${timerState?.state === "active" ? "Running\u2026" : "Off"}</option>
          ${durations.map((minutes) => `<option value="${minutes}">${minutes} min</option>`).join("")}
          <option value="off">Off / cancel</option>
        </select>
      </div>
    `;
  }
  renderControls() {
    const climate = this.climate;
    const swingMode = climate?.attributes.swing_mode;
    const fanMode = climate?.attributes.fan_mode;
    const controls = [
      this.renderClimateButton("swing", "Swing", "mdi:swap-vertical", swingMode === "Swing Vertical" ? "Vertical" : "Off", swingMode === "Swing Vertical"),
      this.renderClimateButton("fanQuiet", "Fan quiet", "mdi:fan", fanMode?.toString() || "Auto", fanMode === "Quiet")
    ];
    for (const feature of Object.keys(FEATURE_LABELS)) {
      const entityId = this.featureEntity(feature);
      if (!entityId) continue;
      const entity = this._hass?.states[entityId];
      const meta = FEATURE_LABELS[feature];
      const disabled = !entity || entity.state === "unavailable";
      const active = entity?.state === "on" || feature === "outdoor_silent" && entity?.state !== "off" && entity?.state !== "unavailable";
      controls.push(`
        <button class="tile ${active ? "active" : ""} ${disabled ? "disabled" : ""}" data-action="feature" data-feature="${feature}" data-entity="${entityId}" ${disabled ? "disabled" : ""}>
          <ha-icon icon="${meta.icon}"></ha-icon>
          <span>${meta.name}</span>
          ${feature === "outdoor_silent" ? `<small>${entity?.state ?? "missing"}</small>` : ""}
        </button>
      `);
    }
    return `<div class="control-grid">${controls.join("")}</div>`;
  }
  renderClimateButton(action, name, icon, label, active) {
    return `
      <button class="tile ${active ? "active" : ""}" data-action="${action}">
        <ha-icon icon="${icon}"></ha-icon>
        <span>${name}</span>
        <small>${label}</small>
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
      element.addEventListener("click", () => this.handleAction(element));
    });
  }
  handleAction(element) {
    if (!this._hass || !this._config) return;
    const action = element.dataset.action;
    if (action === "hvac") {
      this._hass.callService("climate", "set_hvac_mode", { hvac_mode: element.dataset.mode }, { entity_id: this._config.entity });
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
      select.value = "";
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
    border-radius: 18px;
    overflow: hidden;
    border: 1px solid var(--ha-card-border-color, var(--divider-color));
    background: var(--ha-card-background, var(--card-background-color));
    padding: 14px;
  }
  .header, .temperatures, .timer-section {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .title { font-size: 18px; font-weight: 700; }
  .subtitle, .muted { color: var(--secondary-text-color); font-size: 12px; }
  .climate-block { margin-top: 14px; }
  .big-temp { font-size: 42px; font-weight: 700; line-height: 1; }
  .big-temp span { font-size: 18px; margin-left: 2px; }
  .current-temp { text-align: right; font-size: 18px; }
  .mode-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 14px; }
  .mode-button, .tile, .timer-select {
    border: 1px solid rgba(140,140,140,.22);
    background: rgba(120,120,120,.13);
    color: var(--primary-text-color);
    border-radius: 14px;
    min-height: 42px;
    cursor: pointer;
  }
  .mode-button.active, .tile.active {
    background: rgba(33,150,243,.28);
    border-color: rgba(33,150,243,.55);
  }
  .section { margin-top: 14px; padding-top: 12px; border-top: 1px solid rgba(140,140,140,.18); }
  .section-title { font-size: 13px; font-weight: 700; }
  .timer-select { padding: 8px 10px; min-width: 120px; }
  .control-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 14px; }
  .tile { height: 62px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; padding: 6px 4px; }
  .tile ha-icon { --mdc-icon-size: 24px; color: var(--secondary-text-color); }
  .tile.active ha-icon { color: #42a5f5; }
  .tile span { font-size: 11px; line-height: 1.15; }
  .tile small { color: var(--secondary-text-color); font-size: 10px; text-transform: capitalize; }
  .tile.disabled { opacity: .35; cursor: not-allowed; }
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
