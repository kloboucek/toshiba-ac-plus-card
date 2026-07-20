export {};

declare global {
  interface Window {
    customCards: Array<Record<string, unknown>>;
  }
}

type HassEntity = {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
};

type HomeAssistant = {
  states: Record<string, HassEntity>;
  callService: (domain: string, service: string, data?: Record<string, unknown>, target?: Record<string, unknown>) => Promise<unknown>;
  localize?: (key: string) => string;
};

type FeatureName = "high_power" | "eco" | "outdoor_silent" | "air_purifier";

type FeatureConfig = Partial<Record<FeatureName, string | false>> & {
  auto_detect?: boolean;
};

type TimerConfig = {
  entity?: string;
  durations?: number[];
};

type ToshibaAcPlusCardConfig = {
  type: string;
  entity: string;
  name?: string;
  features?: FeatureConfig;
  timer?: TimerConfig | false;
};

const CARD_VERSION = "0.1.2";
const DEFAULT_DURATIONS = [15, 30, 60, 90, 120];
const HVAC_MODES = ["off", "auto", "cool", "heat", "dry", "fan_only"];
const FEATURE_LABELS: Record<FeatureName, { name: string; icon: string }> = {
  high_power: { name: "High power", icon: "mdi:high-power" },
  eco: { name: "ECO", icon: "mdi:eco" },
  outdoor_silent: { name: "Outdoor silent", icon: "mdi:home-sound-in-outline" },
  air_purifier: { name: "Air purifier", icon: "mdi:air-purifier" },
};

function fireEvent(node: HTMLElement, type: string, detail: Record<string, unknown>, options: EventInit = {}): void {
  node.dispatchEvent(
    new CustomEvent(type, {
      bubbles: options.bubbles ?? true,
      cancelable: options.cancelable ?? false,
      composed: options.composed ?? true,
      detail,
    }),
  );
}

function hasEntity(hass: HomeAssistant | undefined, entityId: string | undefined): entityId is string {
  return Boolean(entityId && hass?.states[entityId]);
}

function titleCase(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function objectId(entityId: string): string {
  return entityId.split(".")[1] ?? entityId;
}

function durationToTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:00`;
}

function numericAttribute(entity: HassEntity, key: string, fallback: number): number {
  const value = Number(entity.attributes[key]);
  return Number.isFinite(value) ? value : fallback;
}

function formatTemperature(value: number | unknown, unit: unknown): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return `${numeric.toLocaleString(undefined, { maximumFractionDigits: 1 })}${unit ?? "°C"}`;
}

class ToshibaAcPlusCard extends HTMLElement {
  private _hass?: HomeAssistant;
  private _config?: ToshibaAcPlusCardConfig;

  setConfig(config: ToshibaAcPlusCardConfig): void {
    if (!config.entity) {
      throw new Error("Toshiba AC Plus Card requires an entity, e.g. climate.living_room");
    }
    this._config = {
      ...config,
      features: { auto_detect: true, ...(config.features ?? {}) },
    };
    this.render();
  }

  set hass(hass: HomeAssistant) {
    this._hass = hass;
    this.render();
  }

  getCardSize(): number {
    return 6;
  }

  static getStubConfig(hass: HomeAssistant): Partial<ToshibaAcPlusCardConfig> {
    const climate = Object.keys(hass.states).find((entity) => entity.startsWith("climate."));
    return {
      type: "custom:toshiba-ac-plus-card",
      entity: climate ?? "climate.living_room",
      name: climate ? titleCase(objectId(climate)) : "Living Room AC",
      features: { auto_detect: true },
    };
  }

  static getConfigElement(): HTMLElement {
    return document.createElement("toshiba-ac-plus-card-editor");
  }

  private get climate(): HassEntity | undefined {
    return this._config && this._hass?.states[this._config.entity];
  }

  private featureEntity(feature: FeatureName): string | undefined {
    const config = this._config;
    if (!config) return undefined;
    const configured = config.features?.[feature];
    if (configured === false) return undefined;
    if (typeof configured === "string" && configured) return configured;
    if (config.features?.auto_detect === false) return undefined;

    const base = objectId(config.entity);
    const candidates: Record<FeatureName, string> = {
      high_power: `switch.${base}_high_power_mode`,
      eco: `switch.${base}_eco_mode`,
      outdoor_silent: `select.${base}_outdoor_unit_silent_mode`,
      air_purifier: `switch.${base}_air_purifier`,
    };
    return candidates[feature];
  }

  private render(): void {
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

  private renderClimate(entity: HassEntity): string {
    const unit = entity.attributes.temperature_unit ?? "°C";
    const target = numericAttribute(entity, "temperature", numericAttribute(entity, "current_temperature", 22));
    const minTemp = numericAttribute(entity, "min_temp", 16);
    const maxTemp = numericAttribute(entity, "max_temp", 30);
    const step = numericAttribute(entity, "target_temp_step", 0.5);
    const state = entity.state;
    const supportedModes = Array.isArray(entity.attributes.hvac_modes) ? entity.attributes.hvac_modes as string[] : HVAC_MODES;
    const modes = HVAC_MODES.filter((mode) => supportedModes.includes(mode));

    return `
      <div class="climate-block">
        <div class="temperatures">
          <div>
            <div class="big-temp">${formatTemperature(target, unit)}</div>
            <div class="muted">Target</div>
          </div>
          <div class="current-temp">
            <div>${formatTemperature(entity.attributes.current_temperature, unit)}</div>
            <div class="muted">Current</div>
          </div>
        </div>
        <div class="temperature-control">
          <div class="temperature-scale">
            <span>${formatTemperature(minTemp, unit)}</span>
            <span>${formatTemperature(maxTemp, unit)}</span>
          </div>
          <input
            class="temperature-slider"
            type="range"
            min="${minTemp}"
            max="${maxTemp}"
            step="${step}"
            value="${target}"
            data-action="temperature"
            aria-label="Set target temperature"
          >
        </div>
        <div class="mode-grid">
          ${modes.map((mode) => `
            <button class="mode-button ${state === mode ? "active" : ""}" data-action="hvac" data-mode="${mode}">${titleCase(mode)}</button>
          `).join("")}
        </div>
      </div>
    `;
  }

  private renderTimer(): string {
    const timer = this._config?.timer;
    if (!timer || !timer.entity) return "";
    const timerState = this._hass?.states[timer.entity];
    const durations = timer.durations?.length ? timer.durations : DEFAULT_DURATIONS;
    const status = timerState ? titleCase(timerState.state) : "Timer entity missing";
    return `
      <div class="section timer-section">
        <div>
          <div class="section-title">Turn-off timer</div>
          <div class="muted">${timer.entity} · ${status}</div>
        </div>
        <select class="timer-select" data-action="timer" ${timerState ? "" : "disabled"}>
          <option value="">${timerState?.state === "active" ? "Running…" : "Off"}</option>
          ${durations.map((minutes) => `<option value="${minutes}">${minutes} min</option>`).join("")}
          <option value="off">Off / cancel</option>
        </select>
      </div>
    `;
  }

  private renderControls(): string {
    const climate = this.climate;
    const swingMode = climate?.attributes.swing_mode;
    const fanMode = climate?.attributes.fan_mode;
    const controls: string[] = [
      this.renderClimateButton("swing", "Swing", "mdi:swap-vertical", swingMode === "Swing Vertical" ? "Vertical" : "Off", swingMode === "Swing Vertical"),
      this.renderClimateButton("fanQuiet", "Fan quiet", "mdi:fan", fanMode?.toString() || "Auto", fanMode === "Quiet"),
    ];

    for (const feature of Object.keys(FEATURE_LABELS) as FeatureName[]) {
      const entityId = this.featureEntity(feature);
      if (!entityId) continue;
      const entity = this._hass?.states[entityId];
      const meta = FEATURE_LABELS[feature];
      const disabled = !entity || entity.state === "unavailable";
      const active = entity?.state === "on" || (feature === "outdoor_silent" && entity?.state !== "off" && entity?.state !== "unavailable");
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

  private renderClimateButton(action: string, name: string, icon: string, label: string, active: boolean): string {
    return `
      <button class="tile ${active ? "active" : ""}" data-action="${action}">
        <ha-icon icon="${icon}"></ha-icon>
        <span>${name}</span>
        <small>${label}</small>
      </button>
    `;
  }

  private renderWarning(message: string): string {
    return `<div class="warning">${message}</div>`;
  }

  private bindEvents(): void {
    this.querySelectorAll<HTMLElement>("[data-action]").forEach((element) => {
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

  private handleTemperature(input: HTMLInputElement): void {
    if (!this._hass || !this._config) return;
    const temperature = Number(input.value);
    if (!Number.isFinite(temperature)) return;
    this._hass.callService("climate", "set_temperature", { temperature }, { entity_id: this._config.entity });
  }

  private handleAction(element: HTMLElement): void {
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
      const feature = element.dataset.feature as FeatureName | undefined;
      if (!entityId || !feature || !hasEntity(this._hass, entityId)) return;
      if (feature === "outdoor_silent") {
        this._hass.callService("select", "select_next", { cycle: true }, { entity_id: entityId });
      } else {
        this._hass.callService("switch", "toggle", undefined, { entity_id: entityId });
      }
    }
  }

  private handleTimer(select: HTMLSelectElement): void {
    if (!this._hass || !this._config || !this._config.timer || !this._config.timer.entity) return;
    const entityId = this._config.timer.entity;
    const value = select.value;
    if (value === "off" || value === "") {
      this._hass.callService("timer", "cancel", undefined, { entity_id: entityId });
      select.value = "";
      return;
    }
    const minutes = Number(value);
    if (Number.isFinite(minutes) && minutes > 0) {
      this._hass.callService("timer", "start", { duration: durationToTime(minutes) }, { entity_id: entityId });
      select.value = "";
    }
  }
}

class ToshibaAcPlusCardEditor extends HTMLElement {
  private _hass?: HomeAssistant;
  private _config?: ToshibaAcPlusCardConfig;

  setConfig(config: ToshibaAcPlusCardConfig): void {
    this._config = { ...config, features: { auto_detect: true, ...(config.features ?? {}) } };
    this.render();
  }

  set hass(hass: HomeAssistant) {
    this._hass = hass;
    this.render();
  }

  private render(): void {
    if (!this._config) return;
    const timerConfig = typeof this._config.timer === "object" ? this._config.timer : undefined;
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
      (picker as unknown as { hass?: HomeAssistant }).hass = this._hass;
      picker.addEventListener("value-changed", (event) => this.changed((picker as HTMLElement).dataset.key!, (event as CustomEvent).detail.value));
    });
    this.querySelectorAll("ha-textfield").forEach((field) => {
      field.addEventListener("change", () => this.changed((field as HTMLElement).dataset.key!, (field as HTMLInputElement).value));
    });
    this.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => {
      input.addEventListener("change", () => this.changed(input.dataset.key!, input.checked));
    });
  }

  private changed(key: string, value: unknown): void {
    if (!this._config) return;
    const next: ToshibaAcPlusCardConfig = structuredClone(this._config);
    if (key === "entity") next.entity = String(value || "");
    if (key === "name") next.name = String(value || "");
    if (key === "timer.entity") {
      next.timer = { ...(typeof next.timer === "object" ? next.timer : {}), entity: String(value || "") };
    }
    if (key === "timer.durations") {
      next.timer = {
        ...(typeof next.timer === "object" ? next.timer : {}),
        durations: String(value || "").split(",").map((part) => Number(part.trim())).filter((num) => Number.isFinite(num) && num > 0),
      };
    }
    if (key === "features.auto_detect") {
      next.features = { ...(next.features ?? {}), auto_detect: Boolean(value) };
    }
    fireEvent(this, "config-changed", { config: next });
  }
}

const styles = `
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
  .current-temp { text-align: right; font-size: 18px; }
  .temperature-control { margin-top: 14px; }
  .temperature-scale { display: flex; justify-content: space-between; color: var(--secondary-text-color); font-size: 11px; margin-bottom: 4px; }
  .temperature-slider {
    width: 100%;
    accent-color: var(--primary-color, #42a5f5);
    cursor: pointer;
  }
  .temperature-slider::-webkit-slider-thumb { cursor: pointer; }
  .temperature-slider::-moz-range-thumb { cursor: pointer; }
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
  preview: true,
});

console.info(`%cToshiba AC Plus Card ${CARD_VERSION}`, "color: #42a5f5; font-weight: 700;");
