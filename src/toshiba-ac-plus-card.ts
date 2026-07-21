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

const CARD_VERSION = "0.2.16";
const DEFAULT_DURATIONS = [15, 30, 60, 90, 120];
const HVAC_MODES = ["off", "auto", "cool", "heat", "dry", "fan_only"];
const PENDING_STORAGE_PREFIX = "toshiba-ac-plus-card:pending:";

const DIAL_CENTER = 160;
const DIAL_RADIUS = 118;
const DIAL_START_DEGREES = 140;
const DIAL_SWEEP_DEGREES = 260;
const DIAL_ARC_LENGTH = Math.round(DIAL_RADIUS * DIAL_SWEEP_DEGREES * Math.PI / 180);
const DIAL_HIT_TOLERANCE = 30;
const DIAL_THUMB_HIT_RADIUS = 34;

function dialPoint(percent: number): { x: number; y: number } {
  const angle = (DIAL_START_DEGREES + percent * DIAL_SWEEP_DEGREES) * Math.PI / 180;
  return {
    x: DIAL_CENTER + DIAL_RADIUS * Math.cos(angle),
    y: DIAL_CENTER + DIAL_RADIUS * Math.sin(angle),
  };
}

function dialArcPath(): string {
  const start = dialPoint(0);
  const end = dialPoint(1);
  return `M${start.x.toFixed(1)} ${start.y.toFixed(1)} A${DIAL_RADIUS} ${DIAL_RADIUS} 0 1 1 ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
}
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

function escapeHtml(value: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  return value.replace(/[&<>"]/g, (char) => map[char] ?? char);
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

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function nextFromList(values: string[], current: unknown, fallback: string): string | undefined {
  if (!values.length) return fallback;
  const currentIndex = values.indexOf(String(current));
  return values[(currentIndex + 1) % values.length] ?? fallback;
}

class ToshibaAcPlusCard extends HTMLElement {
  private _hass?: HomeAssistant;
  private _config?: ToshibaAcPlusCardConfig;
  private _isDraggingDial = false;
  private _dragTemperature?: number;
  private _pendingPresetMode?: string;
  private _pendingFanMode?: string;
  private _pendingSwingMode?: string;

  setConfig(config: ToshibaAcPlusCardConfig): void {
    if (!config.entity) {
      throw new Error("Toshiba AC Plus Card requires an entity, e.g. climate.living_room");
    }
    this._config = {
      ...config,
      features: { auto_detect: true, ...(config.features ?? {}) },
    };
    this.loadPendingSettings();
    this.render();
  }

  set hass(hass: HomeAssistant) {
    this._hass = hass;
    if (this._isDraggingDial || this.querySelector("details[open]")) {
      return;
    }
    this.render();
  }

  getCardSize(): number {
    return 8;
  }

  static getStubConfig(hass: HomeAssistant): Partial<ToshibaAcPlusCardConfig> {
    const climate = Object.keys(hass.states).find((entity) => entity.startsWith("climate."));
    const entity = climate ? hass.states[climate] : undefined;
    return {
      type: "custom:toshiba-ac-plus-card",
      entity: climate ?? "climate.living_room",
      name: entity?.attributes.friendly_name?.toString() ?? (climate ? titleCase(objectId(climate)) : "Living Room AC"),
      features: { auto_detect: true },
    };
  }

  static getConfigElement(): HTMLElement {
    return document.createElement("toshiba-ac-plus-card-editor");
  }

  private get climate(): HassEntity | undefined {
    return this._config && this._hass?.states[this._config.entity];
  }

  private pendingStorageKey(): string | undefined {
    return this._config ? `${PENDING_STORAGE_PREFIX}${this._config.entity}` : undefined;
  }

  private loadPendingSettings(): void {
    const key = this.pendingStorageKey();
    if (!key) return;
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return;
      const pending = JSON.parse(raw) as { preset?: unknown; fan?: unknown; swing?: unknown };
      this._pendingPresetMode = typeof pending.preset === "string" ? pending.preset : undefined;
      this._pendingFanMode = typeof pending.fan === "string" ? pending.fan : undefined;
      this._pendingSwingMode = typeof pending.swing === "string" ? pending.swing : undefined;
    } catch {
      this.clearPendingSettings();
    }
  }

  private savePendingSettings(): void {
    const key = this.pendingStorageKey();
    if (!key) return;
    const pending = {
      preset: this._pendingPresetMode,
      fan: this._pendingFanMode,
      swing: this._pendingSwingMode,
    };
    try {
      if (!pending.preset && !pending.fan && !pending.swing) {
        window.localStorage.removeItem(key);
        return;
      }
      window.localStorage.setItem(key, JSON.stringify(pending));
    } catch {
      // localStorage may be unavailable in some privacy/browser contexts; in-memory staging still works.
    }
  }

  private clearPendingSettings(): void {
    this._pendingPresetMode = undefined;
    this._pendingFanMode = undefined;
    this._pendingSwingMode = undefined;
    this.savePendingSettings();
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

  private renderClimate(entity: HassEntity): string {
    const unit = entity.attributes.temperature_unit ?? "°C";
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
          <svg class="dial" viewBox="0 0 320 320" aria-label="Drag or click to set target temperature">
            <path class="dial-hit" d="${arcPath}" data-action="dial" data-dial-hit="arc" />
            <path class="dial-track" d="${arcPath}" />
            <path class="dial-progress" d="${arcPath}" stroke-dasharray="${dash} ${DIAL_ARC_LENGTH}" />
            <circle class="dial-thumb-hit" cx="${thumb.x}" cy="${thumb.y}" r="${DIAL_THUMB_HIT_RADIUS}" data-action="dial" data-dial-hit="thumb" />
            <circle class="dial-thumb" cx="${thumb.x}" cy="${thumb.y}" r="13" />
            <circle class="dial-dot" cx="${dot.x}" cy="${dot.y}" r="4" />
          </svg>
          <div class="dial-center" data-role="dial-center" data-unit="${unit}" data-min="${minTemp}" data-max="${maxTemp}" data-step="${numericAttribute(entity, "target_temp_step", 1)}">
            <div class="mode-label">${mode}</div>
            <div class="target-temp" data-role="target-temp">${formatTemperature(target, unit)}</div>
          </div>
        </div>
        <div class="temp-buttons">
          <button class="round-button" data-action="temperatureStep" data-step="down" aria-label="Decrease temperature">−</button>
          <button class="round-button" data-action="temperatureStep" data-step="up" aria-label="Increase temperature">+</button>
        </div>
      </div>
    `;
  }

  private renderTimerSelect(): string {
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

  private renderControls(): string {
    const climate = this.climate;
    const hvacModes = asStringArray(climate?.attributes.hvac_modes).filter((mode) => HVAC_MODES.includes(mode));
    const presetModes = asStringArray(climate?.attributes.preset_modes);
    const fanModes = asStringArray(climate?.attributes.fan_modes);
    const swingModes = asStringArray(climate?.attributes.swing_modes);
    const climateOff = !climate || climate.state === "off";
    const presetValue = climateOff ? (this._pendingPresetMode ?? String(climate?.attributes.preset_mode ?? "")) : String(climate?.attributes.preset_mode ?? "");
    const fanValue = climateOff ? (this._pendingFanMode ?? String(climate?.attributes.fan_mode ?? "")) : String(climate?.attributes.fan_mode ?? "");
    const swingValue = climateOff ? (this._pendingSwingMode ?? String(climate?.attributes.swing_mode ?? "")) : String(climate?.attributes.swing_mode ?? "");
    const highPower = this.featureEntity("high_power");
    const eco = this.featureEntity("eco");

    return `
      <div class="info-grid">
        ${this.renderSelectTile("hvacSelect", "mdi:snowflake", "Mode", String(climate?.state ?? "off"), hvacModes.length ? hvacModes : HVAC_MODES)}
        ${this.renderSelectTile("presetSelect", "mdi:circle-small", "Preset", presetValue, presetModes)}
        ${this.renderSelectTile("fanSelect", "mdi:circle-small", "Fan mode", fanValue, fanModes)}
        ${this.renderSelectTile("swingSelect", "mdi:circle-small", "Swing mode", swingValue, swingModes)}
      </div>
      <div class="extra-row">
        ${this.renderFeatureTile("high_power", highPower)}
        ${this.renderFeatureTile("eco", eco)}
        ${this.renderTimerSelect()}
      </div>
    `;
  }

  private renderSelectTile(action: string, icon: string, label: string, value: string, options: string[]): string {
    const safeOptions = options.length ? options : [value || "None"];
    const currentValue = value || safeOptions[0] || "";
    return this.renderDropdownTile(action, icon, label, currentValue, safeOptions);
  }

  private renderDropdownTile(action: string, icon: string, label: string, value: string, options: string[], disabled = ""): string {
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

  private renderFeatureTile(feature: FeatureName, entityId: string | undefined): string {
    const meta = FEATURE_LABELS[feature];
    const entity = entityId ? this._hass?.states[entityId] : undefined;
    const disabled = !entity || entity.state === "unavailable";
    const active = entity?.state === "on";
    return `
      <button class="tile ${active ? "active" : ""} ${disabled ? "disabled" : ""}" data-action="feature" data-feature="${feature}" data-entity="${entityId ?? ""}" ${disabled ? "disabled" : ""}>
        <ha-icon icon="${meta.icon}"></ha-icon>
        <span>${meta.name}</span>
      </button>
    `;
  }


  private renderWarning(message: string): string {
    return `<div class="warning">${message}</div>`;
  }

  private bindEvents(): void {
    this.querySelectorAll<HTMLDetailsElement>("details[data-dropdown]").forEach((details) => {
      details.addEventListener("toggle", () => {
        if (!details.open) return;
        this.querySelectorAll<HTMLDetailsElement>("details[data-dropdown][open]").forEach((other) => {
          if (other !== details) other.removeAttribute("open");
        });
      });
    });
    this.querySelectorAll<HTMLElement>("[data-action]").forEach((element) => {
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
        const svg = element.closest("svg") as SVGSVGElement | null;
        if (!svg) return;
        const dialHit = element.dataset.dialHit === "thumb" ? "thumb" : "arc";
        element.addEventListener("touchstart", (event) => this.handleDialTouch(event as TouchEvent, svg, dialHit), { passive: false });
        element.addEventListener("pointerdown", (event) => this.handleDialPointer(event as PointerEvent, svg, dialHit));
        return;
      }
      element.addEventListener("click", () => this.handleAction(element));
    });
  }

  private handleDropdownOption(element: HTMLElement): void {
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
      if (value !== "off") this.applyPendingSettingsAfterModeChange();
      return;
    }
    if (action === "presetSelect") {
      this.setPresetMode(value);
      return;
    }
    if (action === "fanSelect") {
      this.setFanMode(value);
      return;
    }
    if (action === "swingSelect") {
      this.setSwingMode(value);
    }
  }

  private isClimateOff(): boolean {
    return this.climate?.state === "off";
  }

  private setPresetMode(value: string): void {
    if (!this._hass || !this._config) return;
    if (this.isClimateOff()) {
      this._pendingPresetMode = value;
      this.savePendingSettings();
      this.render();
      return;
    }
    this._pendingPresetMode = undefined;
    this.savePendingSettings();
    this._hass.callService("climate", "set_preset_mode", { preset_mode: value }, { entity_id: this._config.entity });
  }

  private setFanMode(value: string): void {
    if (!this._hass || !this._config) return;
    if (this.isClimateOff()) {
      this._pendingFanMode = value;
      this.savePendingSettings();
      this.render();
      return;
    }
    this._pendingFanMode = undefined;
    this.savePendingSettings();
    this._hass.callService("climate", "set_fan_mode", { fan_mode: value }, { entity_id: this._config.entity });
  }

  private setSwingMode(value: string): void {
    if (!this._hass || !this._config) return;
    if (this.isClimateOff()) {
      this._pendingSwingMode = value;
      this.savePendingSettings();
      this.render();
      return;
    }
    this._pendingSwingMode = undefined;
    this.savePendingSettings();
    this._hass.callService("climate", "set_swing_mode", { swing_mode: value }, { entity_id: this._config.entity });
  }

  private applyPendingSettingsAfterModeChange(): void {
    if (!this._hass || !this._config) return;
    const presetMode = this._pendingPresetMode;
    const fanMode = this._pendingFanMode;
    const swingMode = this._pendingSwingMode;
    if (!presetMode && !fanMode && !swingMode) return;
    window.setTimeout(() => {
      if (!this._hass || !this._config) return;
      if (presetMode) this._hass.callService("climate", "set_preset_mode", { preset_mode: presetMode }, { entity_id: this._config.entity });
      if (fanMode) this._hass.callService("climate", "set_fan_mode", { fan_mode: fanMode }, { entity_id: this._config.entity });
      if (swingMode) this._hass.callService("climate", "set_swing_mode", { swing_mode: swingMode }, { entity_id: this._config.entity });
      this.clearPendingSettings();
    }, 900);
  }


  private clientDialPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number; degrees: number; distance: number; percent: number } {
    const rect = svg.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 320;
    const y = ((clientY - rect.top) / rect.height) * 320;
    const distance = Math.hypot(x - DIAL_CENTER, y - DIAL_CENTER);
    let degrees = Math.atan2(y - DIAL_CENTER, x - DIAL_CENTER) * 180 / Math.PI;
    if (degrees < 0) degrees += 360;
    if (degrees < DIAL_START_DEGREES) degrees += 360;
    const percent = (degrees - DIAL_START_DEGREES) / DIAL_SWEEP_DEGREES;
    return { x, y, degrees, distance, percent };
  }

  private isClientOnDialArc(svg: SVGSVGElement, clientX: number, clientY: number): boolean {
    const point = this.clientDialPoint(svg, clientX, clientY);
    return point.percent >= 0 && point.percent <= 1 && Math.abs(point.distance - DIAL_RADIUS) <= DIAL_HIT_TOLERANCE;
  }

  private temperatureFromClient(svg: SVGSVGElement, clientX: number, clientY: number, minTemp: number, maxTemp: number, step: number): number {
    const { degrees } = this.clientDialPoint(svg, clientX, clientY);
    const percent = Math.min(1, Math.max(0, (degrees - DIAL_START_DEGREES) / DIAL_SWEEP_DEGREES));
    const raw = minTemp + percent * (maxTemp - minTemp);
    const snapped = Math.round(raw / step) * step;
    return Math.min(maxTemp, Math.max(minTemp, snapped));
  }

  private previewDialTemperature(svg: SVGSVGElement, temperature: number, minTemp: number, maxTemp: number, unit: unknown): void {
    const percent = Math.min(1, Math.max(0, (temperature - minTemp) / Math.max(maxTemp - minTemp, 1)));
    const thumbPoint = dialPoint(percent);
    svg.querySelector<SVGPathElement>(".dial-progress")?.setAttribute("stroke-dasharray", `${Math.round(DIAL_ARC_LENGTH * percent)} ${DIAL_ARC_LENGTH}`);
    const thumb = svg.querySelector<SVGCircleElement>(".dial-thumb");
    thumb?.setAttribute("cx", String(thumbPoint.x));
    thumb?.setAttribute("cy", String(thumbPoint.y));
    const target = this.querySelector<HTMLElement>('[data-role="target-temp"]');
    if (target) target.textContent = formatTemperature(temperature, unit);
  }

  private handleDialPointer(event: PointerEvent, svg: SVGSVGElement, dialHit: "arc" | "thumb"): void {
    const climate = this.climate;
    if (event.pointerType === "touch") return;
    if (!climate || this._isDraggingDial || (dialHit === "arc" && !this.isClientOnDialArc(svg, event.clientX, event.clientY))) return;
    let pendingTemperature = numericAttribute(climate, "temperature", numericAttribute(climate, "current_temperature", 22));
    const minTemp = numericAttribute(climate, "min_temp", 16);
    const maxTemp = numericAttribute(climate, "max_temp", 30);
    const step = numericAttribute(climate, "target_temp_step", 1);
    const unit = climate.attributes.temperature_unit ?? "°C";
    const update = (pointer: PointerEvent): void => {
      pendingTemperature = this.temperatureFromClient(svg, pointer.clientX, pointer.clientY, minTemp, maxTemp, step);
      this._dragTemperature = pendingTemperature;
      window.requestAnimationFrame(() => this.previewDialTemperature(svg, pendingTemperature, minTemp, maxTemp, unit));
    };
    event.preventDefault();
    this._isDraggingDial = true;
    this._dragTemperature = pendingTemperature;
    svg.setPointerCapture?.(event.pointerId);
    update(event);
    const move = (moveEvent: PointerEvent): void => update(moveEvent);
    const stop = (): void => {
      svg.removeEventListener("pointermove", move);
      svg.removeEventListener("pointerup", stop);
      svg.removeEventListener("pointercancel", stop);
      try { svg.releasePointerCapture?.(event.pointerId); } catch { /* pointer capture may already be gone */ }
      this._isDraggingDial = false;
      this._dragTemperature = undefined;
      this.setTargetTemperature(pendingTemperature);
      this.render();
    };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerup", stop);
    svg.addEventListener("pointercancel", stop);
  }

  private handleDialTouch(event: TouchEvent, svg: SVGSVGElement, dialHit: "arc" | "thumb"): void {
    const climate = this.climate;
    const touch = event.changedTouches[0];
    if (!climate || !touch || this._isDraggingDial || (dialHit === "arc" && !this.isClientOnDialArc(svg, touch.clientX, touch.clientY))) return;
    let pendingTemperature = numericAttribute(climate, "temperature", numericAttribute(climate, "current_temperature", 22));
    const touchId = touch.identifier;
    const startClientX = touch.clientX;
    const startClientY = touch.clientY;
    let dialGestureStarted = false;
    const minTemp = numericAttribute(climate, "min_temp", 16);
    const maxTemp = numericAttribute(climate, "max_temp", 30);
    const step = numericAttribute(climate, "target_temp_step", 1);
    const unit = climate.attributes.temperature_unit ?? "°C";
    const touchById = (touches: TouchList): Touch | undefined => {
      for (let i = 0; i < touches.length; i += 1) {
        const candidate = touches.item(i);
        if (candidate?.identifier === touchId) return candidate;
      }
      return undefined;
    };
    const cleanup = (): void => {
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", stop);
      window.removeEventListener("touchcancel", stop);
    };
    const startDialGesture = (touchPoint: Touch): void => {
      dialGestureStarted = true;
      this._isDraggingDial = true;
      this._dragTemperature = pendingTemperature;
      update(touchPoint);
    };
    const update = (touchPoint: Touch): void => {
      pendingTemperature = this.temperatureFromClient(svg, touchPoint.clientX, touchPoint.clientY, minTemp, maxTemp, step);
      this._dragTemperature = pendingTemperature;
      window.requestAnimationFrame(() => this.previewDialTemperature(svg, pendingTemperature, minTemp, maxTemp, unit));
    };
    const move = (moveEvent: TouchEvent): void => {
      const activeTouch = touchById(moveEvent.changedTouches) ?? touchById(moveEvent.touches);
      if (!activeTouch) return;
      if (!dialGestureStarted) {
        const deltaX = activeTouch.clientX - startClientX;
        const deltaY = activeTouch.clientY - startClientY;
        const absX = Math.abs(deltaX);
        const absY = Math.abs(deltaY);
        if (absY > 8 && absY > absX * 1.15) {
          cleanup();
          return;
        }
        if (Math.max(absX, absY) < 8) return;
        startDialGesture(activeTouch);
      }
      moveEvent.preventDefault();
      update(activeTouch);
    };
    const stop = (endEvent: TouchEvent): void => {
      const activeTouch = touchById(endEvent.changedTouches);
      if (!activeTouch && endEvent.type !== "touchcancel") return;
      cleanup();
      if (endEvent.type === "touchcancel") {
        this._isDraggingDial = false;
        this._dragTemperature = undefined;
        return;
      }
      if (!dialGestureStarted && activeTouch && dialHit === "arc") startDialGesture(activeTouch);
      if (!dialGestureStarted) return;
      endEvent.preventDefault();
      this._isDraggingDial = false;
      this._dragTemperature = undefined;
      this.setTargetTemperature(pendingTemperature);
      this.render();
    };
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", stop, { passive: false });
    window.addEventListener("touchcancel", stop, { passive: false });
    if (dialHit === "thumb") {
      event.preventDefault();
      startDialGesture(touch);
    }
  }


  private setTargetTemperature(temperature: number): void {
    if (!this._hass || !this._config || !Number.isFinite(temperature)) return;
    this._hass.callService("climate", "set_temperature", { temperature }, { entity_id: this._config.entity });
  }

  private handleTemperature(input: HTMLInputElement): void {
    this.setTargetTemperature(Number(input.value));
  }

  private handleAction(element: HTMLElement): void {
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
      const feature = element.dataset.feature as FeatureName | undefined;
      if (!entityId || !feature || !hasEntity(this._hass, entityId)) return;
      if (feature === "outdoor_silent") {
        this._hass.callService("select", "select_next", { cycle: true }, { entity_id: entityId });
      } else {
        this._hass.callService("switch", "toggle", undefined, { entity_id: entityId });
      }
    }
  }

  private handleTimerValue(value: string): void {
    if (!this._hass || !this._config || !this._config.timer || !this._config.timer.entity) return;
    const entityId = this._config.timer.entity;
    if (value === "off" || value === "") {
      this._hass.callService("timer", "cancel", undefined, { entity_id: entityId });
      return;
    }
    const minutes = Number(value);
    if (Number.isFinite(minutes) && minutes > 0) {
      this._hass.callService("timer", "start", { duration: durationToTime(minutes) }, { entity_id: entityId });
    }
  }
}

class ToshibaAcPlusCardEditor extends HTMLElement {
  private _hass?: HomeAssistant;
  private _config?: ToshibaAcPlusCardConfig;
  private _rendered = false;

  setConfig(config: ToshibaAcPlusCardConfig): void {
    this._config = { ...config, features: { auto_detect: true, ...(config.features ?? {}) } };
    if (!this._rendered) this.render();
  }

  set hass(hass: HomeAssistant) {
    this._hass = hass;
    if (!this._rendered) {
      this.render();
      return;
    }
    this.updatePickerHass();
  }

  private render(): void {
    if (!this._config) return;
    const timerConfig = typeof this._config.timer === "object" ? this._config.timer : undefined;
    const timerDurations = timerConfig?.durations ?? DEFAULT_DURATIONS;
    this.innerHTML = `
      <div class="editor">
        <label>Climate entity</label>
        <ha-entity-picker data-key="entity" domain-filter="climate" value="${this._config.entity ?? ""}" allow-custom-entity></ha-entity-picker>
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
    this.updatePickerHass();
    this.querySelectorAll("ha-entity-picker").forEach((picker) => {
      picker.addEventListener("value-changed", (event) => this.changed((picker as HTMLElement).dataset.key!, (event as CustomEvent).detail.value));
    });
    this.querySelectorAll("ha-textfield").forEach((field) => {
      field.addEventListener("change", () => this.changed((field as HTMLElement).dataset.key!, (field as HTMLInputElement).value));
    });
    this.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => {
      input.addEventListener("change", () => this.changed(input.dataset.key!, input.checked));
    });
    this._rendered = true;
  }

  private updatePickerHass(): void {
    this.querySelectorAll("ha-entity-picker").forEach((picker) => {
      (picker as unknown as { hass?: HomeAssistant }).hass = this._hass;
    });
  }

  private defaultName(entityId: string | undefined): string {
    if (!entityId) return "";
    return this._hass?.states[entityId]?.attributes.friendly_name?.toString() ?? titleCase(objectId(entityId));
  }

  private nameLooksAutomatic(name: string | undefined, entityId: string | undefined): boolean {
    if (!name || !entityId) return true;
    return name === this.defaultName(entityId) || name === titleCase(objectId(entityId));
  }

  private syncNameField(value: string): void {
    const field = this.querySelector<HTMLElement & { value?: string }>('ha-textfield[data-key="name"]');
    if (field) field.value = value;
  }

  private changed(key: string, value: unknown): void {
    if (!this._config) return;
    const next: ToshibaAcPlusCardConfig = structuredClone(this._config);
    if (key === "entity") {
      const previousEntity = this._config.entity;
      const previousName = this._config.name;
      next.entity = String(value || "");
      if (this.nameLooksAutomatic(previousName, previousEntity)) {
        next.name = this.defaultName(next.entity);
        this.syncNameField(next.name);
      }
    }
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
  .title { font-size: 18px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .subtitle, .muted { color: var(--secondary-text-color); font-size: 12px; }
  .thermostat-shell { display: grid; justify-items: center; margin-top: 4px; }
  .current-label { color: var(--secondary-text-color); font-size: 13px; font-weight: 600; }
  .current-value { font-size: 18px; font-weight: 700; margin-top: 6px; }
  .dial-wrap { position: relative; width: min(320px, 100%); height: 306px; margin-top: 4px; touch-action: pan-y; user-select: none; -webkit-user-select: none; }
  .dial { width: 100%; height: 100%; overflow: visible; pointer-events: none; touch-action: pan-y; user-select: none; -webkit-user-select: none; }
  .dial-hit, .dial-track, .dial-progress { fill: none; stroke-linecap: round; }
  .dial-hit { stroke: transparent; stroke-width: 60; cursor: pointer; pointer-events: stroke; touch-action: pan-y; }
  .dial-track, .dial-progress { stroke-width: 24; pointer-events: none; }
  .dial-track { stroke: rgba(120,120,120,.16); }
  .dial-progress { stroke: var(--primary-color, #2196f3); filter: drop-shadow(0 0 4px rgba(33,150,243,.25)); }
  .dial-thumb-hit { fill: transparent; cursor: pointer; pointer-events: all; touch-action: none; }
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
  .select-tile summary::after { content: "⌄"; grid-area: chevron; color: var(--secondary-text-color); justify-self: end; font-size: 16px; }
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
  preview: true,
});

console.info(`%cToshiba AC Plus Card ${CARD_VERSION}`, "color: #42a5f5; font-weight: 700;");
