/**
 * Tower-Defense HUD — a self-contained DOM overlay (no THREE).
 *
 * Pure DOM + TypeScript. It owns nothing about the game state: each frame the
 * integrator calls `update(state)` with a plain snapshot and the HUD diff-renders
 * (only touching the DOM when a value actually changed). It exposes optional
 * callbacks (onBuild / onCall / onUpgrade / onSell / onTarget) for its buttons,
 * but binds NO global keys — the integrator owns input. Hotkey glyphs on the
 * palette are purely informative.
 *
 * Driving it:
 *   const hud = new TdHud(document.getElementById("ui")!, {
 *     onBuild: (i) => placeTower(i),
 *     onCall:  () => callWaveEarly(),
 *   });
 *   hud.setTowers([{ name: "Arrow", cost: 50, key: "1", color: 0x7fd4ff }, ...]);
 *   hud.update(state);          // every frame
 *   hud.banner("Wave 5 — BOSS");
 *   hud.showTowerPanel({ name: "Arrow", tier: 2, target: "First",
 *                        upgradeCost: 80, sellValue: 35 });  // at an owned tower
 *   hud.showTowerPanel(null);   // back to the build palette
 *   hud.destroy();
 *
 * Visual language mirrors the game's other UI modules (#bw-shop, #td-hud in
 * style.css): dark warm translucent panels, rounded corners, gold/teal accents,
 * drop shadows, tabular-nums numbers. CSS is injected once, scoped under #tdh.
 */

/** A single buildable tower entry shown in the bottom palette. */
export interface TdTower {
  /** Display name (e.g. "Arrow"). */
  name: string;
  /** Gold cost to place. */
  cost: number;
  /** Informative hotkey glyph (e.g. "1"); the HUD does not bind it. */
  key: string;
  /** Accent colour as a 0xRRGGBB number; tints the icon + card. */
  color: number;
}

/** Info for the owned-tower panel (upgrade / sell / target). */
export interface TdTowerInfo {
  name: string;
  /** 1-based upgrade tier. */
  tier: number;
  /** Current targeting mode label (e.g. "First", "Strong", "Close"). */
  target: string;
  /** Gold to upgrade, or null when maxed. */
  upgradeCost: number | null;
  /** Gold refunded on sell. */
  sellValue: number;
}

/** Plain per-frame snapshot the HUD renders from. */
export interface TdHudState {
  mode: "solo" | "duel";
  gold: number;
  wave: number;
  totalWaves?: number;
  betweenWaves: boolean;
  earlyCallBonus: number;
  lives?: number;
  playerHp?: number;
  botHp?: number;
  income?: number;
  over: boolean;
  win: boolean;
}

/** Optional callbacks fired by the HUD's buttons. */
export interface TdHudOpts {
  onBuild?: (tower: TdTower, index: number) => void;
  onCall?: () => void;
  onUpgrade?: () => void;
  onSell?: () => void;
  onTarget?: () => void;
}

const STYLE_ID = "tdh-style";
const STYLE_CSS = `
#tdh {
  position: absolute; inset: 0; z-index: 40; pointer-events: none;
  font-family: inherit; color: #f1ece1;
  font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased;
}
#tdh * { box-sizing: border-box; }

/* ── top status ─────────────────────────────────────────────────────────── */
#tdh .tdh-top {
  position: absolute; top: 14px; left: 50%; transform: translateX(-50%);
  display: flex; gap: 10px; align-items: stretch; max-width: 96vw;
}
#tdh .tdh-chip {
  pointer-events: auto;
  background: rgba(22,28,34,0.86); border: 1.5px solid rgba(255,255,255,0.13);
  border-radius: 14px; padding: 7px 14px; box-shadow: 0 6px 18px rgba(0,0,0,0.34);
  display: flex; flex-direction: column; gap: 2px; justify-content: center;
  backdrop-filter: blur(4px);
}
#tdh .tdh-chip .tdh-lbl {
  font-size: 10px; font-weight: 700; letter-spacing: 0.6px;
  text-transform: uppercase; color: #9fb0bc; line-height: 1;
}
#tdh .tdh-chip .tdh-val {
  font-size: 19px; font-weight: 800; line-height: 1.05;
  display: flex; align-items: center; gap: 6px;
}
#tdh .tdh-gold .tdh-val { color: #ffd24a; }
#tdh .tdh-lives .tdh-val { color: #ff8a7a; }
#tdh .tdh-wave .tdh-val { color: #7fd4ff; }
#tdh .tdh-income .tdh-val { color: #7be08a; }

/* HP bars (duel) */
#tdh .tdh-hp { min-width: 168px; }
#tdh .tdh-hp .tdh-bar {
  margin-top: 4px; height: 11px; border-radius: 999px; overflow: hidden;
  background: rgba(0,0,0,0.42); border: 1px solid rgba(255,255,255,0.1);
}
#tdh .tdh-hp .tdh-fill {
  height: 100%; width: 100%; border-radius: 999px;
  transition: width 0.35s cubic-bezier(0.25,0.8,0.3,1);
}
#tdh .tdh-hp.tdh-you .tdh-fill { background: linear-gradient(90deg,#5fe08a,#7be08a); }
#tdh .tdh-hp.tdh-you .tdh-lbl { color: #7be08a; }
#tdh .tdh-hp.tdh-bot .tdh-fill { background: linear-gradient(90deg,#b98aff,#c89bff); }
#tdh .tdh-hp.tdh-bot .tdh-lbl { color: #c89bff; }
#tdh .tdh-hp .tdh-hprow { display: flex; justify-content: space-between; align-items: baseline; }
#tdh .tdh-hp .tdh-hpnum { font-size: 13px; font-weight: 800; }

/* ── wave / call-wave pill ──────────────────────────────────────────────── */
#tdh .tdh-wavebar {
  position: absolute; top: 96px; left: 50%; transform: translateX(-50%);
  pointer-events: auto;
}
#tdh .tdh-pill {
  display: flex; align-items: center; gap: 10px;
  background: rgba(22,28,34,0.86); border: 1.5px solid rgba(255,255,255,0.13);
  border-radius: 999px; padding: 7px 8px 7px 16px;
  box-shadow: 0 6px 18px rgba(0,0,0,0.34); backdrop-filter: blur(4px);
  font-size: 14px; font-weight: 700;
}
#tdh .tdh-pill.tdh-call {
  border-color: rgba(255,210,74,0.6); cursor: pointer;
  animation: tdh-glow 2.2s ease-in-out infinite;
}
@keyframes tdh-glow {
  0%,100% { box-shadow: 0 6px 18px rgba(0,0,0,0.34), 0 0 0 0 rgba(255,210,74,0.0); }
  50%     { box-shadow: 0 6px 22px rgba(0,0,0,0.38), 0 0 0 4px rgba(255,210,74,0.16); }
}
#tdh .tdh-pill .tdh-key {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 22px; height: 22px; padding: 0 6px; border-radius: 7px;
  background: rgba(255,210,74,0.18); border: 1px solid rgba(255,210,74,0.5);
  color: #ffd24a; font-size: 12px; font-weight: 800;
}
#tdh .tdh-pill .tdh-bonus { color: #ffd24a; font-weight: 800; }
#tdh .tdh-pill .tdh-prog {
  width: 84px; height: 8px; border-radius: 999px; margin-left: 4px;
  background: rgba(0,0,0,0.4); overflow: hidden; position: relative;
}
#tdh .tdh-pill .tdh-prog::after {
  content: ""; position: absolute; inset: 0; width: 38%;
  background: linear-gradient(90deg, transparent, rgba(127,212,255,0.85), transparent);
  animation: tdh-sweep 1.4s linear infinite;
}
@keyframes tdh-sweep { from { transform: translateX(-100%); } to { transform: translateX(264%); } }

/* ── bottom build palette ───────────────────────────────────────────────── */
#tdh .tdh-bottom {
  position: absolute; bottom: 18px; left: 50%; transform: translateX(-50%);
  pointer-events: auto; max-width: 96vw;
}
#tdh .tdh-palette { display: flex; gap: 8px; }
#tdh .tdh-tower {
  position: relative; width: 88px; min-height: 86px;
  background: rgba(22,28,34,0.88); border: 1.5px solid rgba(255,255,255,0.12);
  border-radius: 14px; padding: 8px 6px 7px; cursor: pointer;
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  color: inherit; font: inherit; text-align: center;
  box-shadow: 0 6px 18px rgba(0,0,0,0.34); backdrop-filter: blur(4px);
  transition: transform 0.1s, border-color 0.12s, background 0.12s, opacity 0.12s;
}
#tdh .tdh-tower:hover:not(.tdh-dim) { transform: translateY(-3px); }
#tdh .tdh-tower.tdh-dim { opacity: 0.4; cursor: not-allowed; }
#tdh .tdh-tower .tdh-key {
  position: absolute; top: 5px; left: 6px;
  min-width: 18px; height: 18px; padding: 0 4px; border-radius: 6px;
  background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.18);
  font-size: 11px; font-weight: 800; color: #cfd9e0;
  display: inline-flex; align-items: center; justify-content: center;
}
#tdh .tdh-tower .tdh-ico { font-size: 26px; line-height: 1; margin-top: 6px; filter: drop-shadow(0 2px 3px rgba(0,0,0,0.4)); }
#tdh .tdh-tower .tdh-tname { font-size: 12px; font-weight: 800; }
#tdh .tdh-tower .tdh-tcost {
  font-size: 12px; font-weight: 800; color: #ffd24a;
  display: flex; align-items: center; gap: 3px;
}
#tdh .tdh-tower.tdh-dim .tdh-tcost { color: #ff8a7a; }

/* owned-tower panel */
#tdh .tdh-towerpanel {
  display: none; align-items: center; gap: 8px;
  background: rgba(22,28,34,0.9); border: 1.5px solid rgba(255,255,255,0.14);
  border-radius: 16px; padding: 8px 12px; box-shadow: 0 8px 22px rgba(0,0,0,0.4);
  backdrop-filter: blur(4px);
}
#tdh .tdh-towerpanel .tdh-tphead { display: flex; flex-direction: column; gap: 1px; padding-right: 6px; margin-right: 2px; border-right: 1px solid rgba(255,255,255,0.12); }
#tdh .tdh-towerpanel .tdh-tpname { font-size: 14px; font-weight: 800; }
#tdh .tdh-towerpanel .tdh-tptier { font-size: 11px; font-weight: 700; color: #9fb0bc; }
#tdh .tdh-act {
  pointer-events: auto; cursor: pointer; color: inherit; font: inherit;
  display: flex; align-items: center; gap: 7px;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
  border-radius: 11px; padding: 7px 11px; font-size: 13px; font-weight: 700;
  transition: background 0.12s, border-color 0.12s, opacity 0.12s;
}
#tdh .tdh-act:hover:not(:disabled) { background: rgba(255,255,255,0.12); }
#tdh .tdh-act:disabled { opacity: 0.4; cursor: not-allowed; }
#tdh .tdh-act .tdh-akey {
  min-width: 18px; height: 18px; padding: 0 4px; border-radius: 6px;
  background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.18);
  font-size: 11px; font-weight: 800; display: inline-flex; align-items: center; justify-content: center;
}
#tdh .tdh-act.tdh-up { border-color: rgba(123,224,138,0.45); }
#tdh .tdh-act.tdh-up .tdh-cost { color: #ffd24a; }
#tdh .tdh-act.tdh-sell { border-color: rgba(255,138,122,0.4); }
#tdh .tdh-act.tdh-sell .tdh-cost { color: #7be08a; }
#tdh .tdh-act.tdh-target .tdh-cost { color: #7fd4ff; }
#tdh.tdh-owned .tdh-palette { display: none; }
#tdh.tdh-owned .tdh-towerpanel { display: flex; }

/* ── transient center banner ────────────────────────────────────────────── */
#tdh .tdh-banner {
  position: absolute; top: 30%; left: 50%; transform: translate(-50%,-50%) scale(0.85);
  padding: 14px 30px; border-radius: 18px;
  background: rgba(22,28,34,0.92); border: 2px solid rgba(255,210,74,0.7);
  box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  font-size: 30px; font-weight: 900; letter-spacing: 0.5px; color: #ffe9a8;
  text-shadow: 0 2px 6px rgba(0,0,0,0.5); white-space: nowrap;
  opacity: 0; pointer-events: none;
}
#tdh .tdh-banner.tdh-show { animation: tdh-banner 2.1s cubic-bezier(0.2,0.7,0.3,1) forwards; }
@keyframes tdh-banner {
  0%   { opacity: 0; transform: translate(-50%,-50%) scale(0.8); }
  14%  { opacity: 1; transform: translate(-50%,-50%) scale(1.04); }
  24%  { transform: translate(-50%,-50%) scale(1); }
  78%  { opacity: 1; transform: translate(-50%,-50%) scale(1); }
  100% { opacity: 0; transform: translate(-50%,-50%) scale(1.06); }
}

/* ── win / lose overlay ─────────────────────────────────────────────────── */
#tdh .tdh-over {
  position: absolute; inset: 0; display: none;
  align-items: center; justify-content: center; flex-direction: column; gap: 8px;
  background: radial-gradient(ellipse at center, rgba(14,18,22,0.5), rgba(10,12,16,0.82));
  backdrop-filter: blur(3px); pointer-events: auto;
}
#tdh .tdh-over.tdh-show { display: flex; animation: tdh-fadein 0.5s ease forwards; }
@keyframes tdh-fadein { from { opacity: 0; } to { opacity: 1; } }
#tdh .tdh-over .tdh-otitle { font-size: 56px; font-weight: 900; letter-spacing: 1px; text-shadow: 0 4px 14px rgba(0,0,0,0.6); }
#tdh .tdh-over.tdh-win .tdh-otitle { color: #ffe08a; }
#tdh .tdh-over.tdh-lose .tdh-otitle { color: #ff8a7a; }
#tdh .tdh-over .tdh-osub { font-size: 16px; font-weight: 700; color: #c4cfd6; }

@media (max-width: 560px) {
  #tdh .tdh-tower { width: 64px; min-height: 76px; }
  #tdh .tdh-tower .tdh-ico { font-size: 22px; }
  #tdh .tdh-over .tdh-otitle { font-size: 40px; }
  #tdh .tdh-banner { font-size: 22px; padding: 10px 20px; }
}
`;

/** Default emoji glyph per tower name (falls back to a generic turret). */
const ICONS: Record<string, string> = {
  Arrow: "\u{1F3F9}", // 🏹
  Frost: "❄️", // ❄️
  Pylon: "⚡", // ⚡
  Cannon: "\u{1F4A3}", // 💣
  Sniper: "\u{1F3AF}", // 🎯
};
const GOLD = "\u{1FA99}"; // 🪙

function hex(color: number): string {
  return "#" + (color & 0xffffff).toString(16).padStart(6, "0");
}

export class TdHud {
  private root: HTMLElement;
  private el: HTMLElement;
  private opts: TdHudOpts;

  // top status refs
  private topEl!: HTMLElement;
  private goldEl!: HTMLElement;
  private livesEl!: HTMLElement;
  private waveEl!: HTMLElement;
  private incomeEl!: HTMLElement;
  private youHp!: { wrap: HTMLElement; fill: HTMLElement; num: HTMLElement };
  private botHp!: { wrap: HTMLElement; fill: HTMLElement; num: HTMLElement };

  // wave control refs
  private waveBarEl!: HTMLElement;
  private pillEl!: HTMLElement;

  // bottom refs
  private paletteEl!: HTMLElement;
  private upBtn!: HTMLButtonElement;
  private sellBtn!: HTMLButtonElement;
  private targetBtn!: HTMLButtonElement;
  private tpName!: HTMLElement;
  private tpTier!: HTMLElement;

  // banner + overlay
  private bannerEl!: HTMLElement;
  private overEl!: HTMLElement;
  private overTitle!: HTMLElement;
  private overSub!: HTMLElement;

  private towers: TdTower[] = [];
  private towerBtns: HTMLButtonElement[] = [];
  private bannerTimer: number | null = null;

  // cached prev-frame values for cheap diffing
  private prev: Partial<Record<string, string>> = {};
  private prevAffordKey = "";
  private prevTopMode: "" | "solo" | "duel" = "";

  constructor(parent: HTMLElement, opts: TdHudOpts = {}) {
    this.root = parent;
    this.opts = opts;
    this.injectStyle();

    this.el = document.createElement("div");
    this.el.id = "tdh";
    this.el.innerHTML = `
      <div class="tdh-top">
        <div class="tdh-chip tdh-hp tdh-you" data-show="duel">
          <div class="tdh-hprow"><span class="tdh-lbl">You</span><span class="tdh-hpnum">100%</span></div>
          <div class="tdh-bar"><div class="tdh-fill"></div></div>
        </div>
        <div class="tdh-chip tdh-hp tdh-bot" data-show="duel">
          <div class="tdh-hprow"><span class="tdh-lbl">Rival</span><span class="tdh-hpnum">100%</span></div>
          <div class="tdh-bar"><div class="tdh-fill"></div></div>
        </div>
        <div class="tdh-chip tdh-gold"><span class="tdh-lbl">Gold</span><span class="tdh-val">0</span></div>
        <div class="tdh-chip tdh-lives" data-show="solo"><span class="tdh-lbl">Lives</span><span class="tdh-val">0</span></div>
        <div class="tdh-chip tdh-income" data-show="duel"><span class="tdh-lbl">Income</span><span class="tdh-val">0</span></div>
        <div class="tdh-chip tdh-wave"><span class="tdh-lbl">Wave</span><span class="tdh-val">0</span></div>
      </div>

      <div class="tdh-wavebar">
        <div class="tdh-pill"></div>
      </div>

      <div class="tdh-bottom">
        <div class="tdh-palette"></div>
        <div class="tdh-towerpanel">
          <div class="tdh-tphead"><span class="tdh-tpname">Tower</span><span class="tdh-tptier">Tier 1</span></div>
          <button class="tdh-act tdh-up"><span class="tdh-akey">E</span><span>upgrade</span><span class="tdh-cost"></span></button>
          <button class="tdh-act tdh-sell"><span class="tdh-akey">X</span><span>sell</span><span class="tdh-cost"></span></button>
          <button class="tdh-act tdh-target"><span class="tdh-akey">T</span><span>target</span><span class="tdh-cost"></span></button>
        </div>
      </div>

      <div class="tdh-banner"></div>
      <div class="tdh-over">
        <div class="tdh-otitle">Victory</div>
        <div class="tdh-osub"></div>
      </div>`;
    this.root.appendChild(this.el);

    this.topEl = this.q(".tdh-top");
    this.goldEl = this.q(".tdh-gold .tdh-val");
    this.livesEl = this.q(".tdh-lives .tdh-val");
    this.waveEl = this.q(".tdh-wave .tdh-val");
    this.incomeEl = this.q(".tdh-income .tdh-val");
    this.youHp = this.hpRefs(".tdh-you");
    this.botHp = this.hpRefs(".tdh-bot");

    this.waveBarEl = this.q(".tdh-wavebar");
    this.pillEl = this.q(".tdh-pill");

    this.paletteEl = this.q(".tdh-palette");
    this.upBtn = this.q(".tdh-act.tdh-up") as HTMLButtonElement;
    this.sellBtn = this.q(".tdh-act.tdh-sell") as HTMLButtonElement;
    this.targetBtn = this.q(".tdh-act.tdh-target") as HTMLButtonElement;
    this.tpName = this.q(".tdh-tpname");
    this.tpTier = this.q(".tdh-tptier");

    this.bannerEl = this.q(".tdh-banner");
    this.overEl = this.q(".tdh-over");
    this.overTitle = this.q(".tdh-otitle");
    this.overSub = this.q(".tdh-osub");

    this.upBtn.addEventListener("click", () => this.opts.onUpgrade?.());
    this.sellBtn.addEventListener("click", () => this.opts.onSell?.());
    this.targetBtn.addEventListener("click", () => this.opts.onTarget?.());
  }

  // ── public API ────────────────────────────────────────────────────────────

  /** Replace the bottom build palette contents. Affordability is applied on update(). */
  setTowers(list: TdTower[]): void {
    this.towers = list.slice();
    this.paletteEl.innerHTML = "";
    this.towerBtns = list.map((t, i) => {
      const btn = document.createElement("button");
      btn.className = "tdh-tower";
      btn.style.borderColor = `${hex(t.color)}55`;
      const ico = ICONS[t.name] ?? "\u{1F5FC}"; // 🗼
      btn.innerHTML = `
        <span class="tdh-key">${t.key}</span>
        <span class="tdh-ico" style="color:${hex(t.color)}">${ico}</span>
        <span class="tdh-tname">${t.name}</span>
        <span class="tdh-tcost">${GOLD}${t.cost}</span>`;
      btn.addEventListener("click", () => {
        if (!btn.classList.contains("tdh-dim")) this.opts.onBuild?.(t, i);
      });
      this.paletteEl.appendChild(btn);
      return btn;
    });
    this.prevAffordKey = ""; // force re-eval next update
  }

  /** Swap the bottom bar to the owned-tower panel, or null to show the palette. */
  showTowerPanel(info: TdTowerInfo | null): void {
    if (!info) {
      this.el.classList.remove("tdh-owned");
      return;
    }
    this.el.classList.add("tdh-owned");
    this.tpName.textContent = info.name;
    this.tpTier.textContent = `Tier ${info.tier}`;
    const upCost = this.upBtn.querySelector(".tdh-cost") as HTMLElement;
    if (info.upgradeCost == null) {
      this.upBtn.disabled = true;
      (this.upBtn.querySelector("span:nth-child(2)") as HTMLElement).textContent = "maxed";
      upCost.textContent = "";
    } else {
      this.upBtn.disabled = false;
      (this.upBtn.querySelector("span:nth-child(2)") as HTMLElement).textContent = "upgrade";
      upCost.textContent = `(${GOLD}${info.upgradeCost})`;
    }
    (this.sellBtn.querySelector(".tdh-cost") as HTMLElement).textContent = `(+${info.sellValue})`;
    (this.targetBtn.querySelector(".tdh-cost") as HTMLElement).textContent = `[${info.target}]`;
  }

  /** Per-frame render. Cheap: only touches the DOM when a value changed. */
  update(s: TdHudState): void {
    // top: toggle which chips are visible for the mode (only when mode changes)
    if (s.mode !== this.prevTopMode) {
      this.prevTopMode = s.mode;
      this.topEl.querySelectorAll<HTMLElement>("[data-show]").forEach((c) => {
        c.style.display = c.dataset.show === s.mode ? "" : "none";
      });
    }

    this.setText(this.goldEl, "gold", `${GOLD}${Math.floor(s.gold)}`);

    const total = s.totalWaves != null ? `/${s.totalWaves}` : "";
    this.setText(this.waveEl, "wave", `${s.wave}${total}`);

    if (s.mode === "solo") {
      this.setText(this.livesEl, "lives", `❤️ ${s.lives ?? 0}`);
    } else {
      this.setText(this.incomeEl, "income", `+${s.income ?? 0}/wave`);
      this.setHp(this.youHp, "youhp", s.playerHp);
      this.setHp(this.botHp, "bothp", s.botHp);
    }

    this.renderWave(s);
    this.renderAfford(s.gold);
    this.renderOver(s);
  }

  /** Show a big transient center banner that animates in then fades. */
  banner(text: string): void {
    this.bannerEl.textContent = text;
    this.bannerEl.classList.remove("tdh-show");
    void this.bannerEl.offsetWidth; // restart animation
    this.bannerEl.classList.add("tdh-show");
    if (this.bannerTimer != null) clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => {
      this.bannerEl.classList.remove("tdh-show");
      this.bannerTimer = null;
    }, 2100);
  }

  /** Remove DOM + listeners. Safe to call once. */
  destroy(): void {
    if (this.bannerTimer != null) {
      clearTimeout(this.bannerTimer);
      this.bannerTimer = null;
    }
    this.el.remove();
    this.towerBtns = [];
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private renderWave(s: TdHudState): void {
    const key = `${s.betweenWaves ? "b" : "a"}|${s.wave}|${s.earlyCallBonus}`;
    if (this.prev["__wavebar"] === key) return;
    this.prev["__wavebar"] = key;
    if (s.over) {
      this.waveBarEl.style.display = "none";
      return;
    }
    this.waveBarEl.style.display = "";
    if (s.betweenWaves) {
      this.pillEl.className = "tdh-pill tdh-call";
      this.pillEl.innerHTML = `
        <span class="tdh-key">SPACE</span>
        <span>Wave ${s.wave} — start now</span>
        <span class="tdh-bonus">+${s.earlyCallBonus}${GOLD}</span>`;
      this.pillEl.onclick = () => this.opts.onCall?.();
    } else {
      this.pillEl.className = "tdh-pill";
      this.pillEl.innerHTML = `<span>Wave ${s.wave}</span><span class="tdh-prog"></span>`;
      this.pillEl.onclick = null;
    }
  }

  private renderAfford(gold: number): void {
    const g = Math.floor(gold);
    const key = `${g}|${this.towers.map((t) => t.cost).join(",")}`;
    if (key === this.prevAffordKey) return;
    this.prevAffordKey = key;
    this.towers.forEach((t, i) => {
      const btn = this.towerBtns[i];
      if (btn) btn.classList.toggle("tdh-dim", g < t.cost);
    });
  }

  private renderOver(s: TdHudState): void {
    const key = s.over ? (s.win ? "win" : "lose") : "off";
    if (this.prev["__over"] === key) return;
    this.prev["__over"] = key;
    if (!s.over) {
      this.overEl.className = "tdh-over";
      return;
    }
    this.overEl.className = `tdh-over tdh-show ${s.win ? "tdh-win" : "tdh-lose"}`;
    this.overTitle.textContent = s.win ? "Victory" : "Defeat";
    this.overSub.textContent = s.win
      ? "All waves survived."
      : s.mode === "duel"
        ? "Your base fell."
        : "Your base was overrun.";
  }

  private setHp(ref: { wrap: HTMLElement; fill: HTMLElement; num: HTMLElement }, slot: string, hp: number | undefined): void {
    const pct = Math.max(0, Math.min(100, Math.round(hp ?? 100)));
    if (this.prev[slot] === String(pct)) return;
    this.prev[slot] = String(pct);
    ref.fill.style.width = `${pct}%`;
    ref.num.textContent = `${pct}%`;
  }

  private setText(el: HTMLElement, slot: string, text: string): void {
    if (this.prev[slot] === text) return;
    this.prev[slot] = text;
    el.textContent = text;
  }

  private hpRefs(sel: string): { wrap: HTMLElement; fill: HTMLElement; num: HTMLElement } {
    const wrap = this.q(sel);
    return {
      wrap,
      fill: wrap.querySelector(".tdh-fill") as HTMLElement,
      num: wrap.querySelector(".tdh-hpnum") as HTMLElement,
    };
  }

  private q(sel: string): HTMLElement {
    return this.el.querySelector(sel) as HTMLElement;
  }

  private injectStyle(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE_CSS;
    document.head.appendChild(style);
  }
}
