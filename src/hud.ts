import { ActiveGum } from "./powerups";
import { Tier } from "./upgrades";
import { ModDelta } from "./mods";

/** A meta-upgrade row as the HUD needs to render it. */
export interface MetaRow {
  id: string;
  name: string;
  desc: string;
  cost: number;
  owned: boolean;
  affordable: boolean;
}

/** One level-up card as the HUD renders it (view-model built by the game). */
export interface LevelCardVM {
  id: string;
  name: string;
  desc: string;
  icon: string;
  color: string;
  tier: Tier;
  deltas: ModDelta[];
}

export interface LevelUpInfo {
  level: number;
  cards: LevelCardVM[];
  rerollCost: number;
  canReroll: boolean;
  onPick: (id: string) => void;
  onReroll: () => void;
}

/** DOM-based HUD + overlays. Cheap, crisp, and easy to restyle. */
export class Hud {
  private root: HTMLElement;
  private roundEl!: HTMLElement;
  private pointsEl!: HTMLElement;
  private healthFill!: HTMLElement;
  private weaponName!: HTMLElement;
  private weaponAmmo!: HTMLElement;
  private promptEl!: HTMLElement;
  private toastEl!: HTMLElement;
  private powerupsEl!: HTMLElement;
  private startOverlay!: HTMLElement;
  private overOverlay!: HTMLElement;
  private overStats!: HTMLElement;

  private toastTimer?: number;

  constructor(root: HTMLElement) {
    this.root = root;
    this.build();
  }

  private build() {
    this.root.innerHTML = `
      <div class="hud-top">
        <div class="pill round"><span class="label">Round</span><span class="value" id="hud-round">1</span></div>
        <div class="pill points"><span class="label">Points</span><span class="value" id="hud-points">0</span></div>
        <div class="pill room hidden" id="hud-room"><span class="label">Room</span><span class="value" id="hud-room-code"></span></div>
      </div>
      <div class="powerups" id="hud-powerups"></div>
      <div class="combo" id="hud-combo">
        <span class="combo-x" id="hud-combo-x">x2</span>
        <div class="combo-bar"><div class="combo-fill" id="hud-combo-fill"></div></div>
      </div>
      <div class="bossbar hidden" id="hud-boss">
        <div class="boss-name" id="hud-boss-name">BOSS</div>
        <div class="boss-track"><div class="boss-fill" id="hud-boss-fill"></div></div>
      </div>
      <div class="hud-bottom">
        <div class="health"><div class="bar"><div class="fill" id="hud-health"></div></div></div>
        <div class="weapon">
          <div class="name" id="hud-weapon-name">Peashooter</div>
          <div class="ammo"><span id="hud-ammo">12</span> <span class="reserve">/ <span id="hud-reserve">∞</span></span></div>
          <div class="reloading" id="hud-reloading"></div>
        </div>
      </div>
      <div id="prompt"></div>
      <div id="toast"></div>

      <div class="overlay" id="overlay-start">
        <h1>TINY <span class="dead">DEAD</span></h1>
        <p>A cozy little world. Ten flavors of undead — from shamblers to
           armored hulks and the Abomination. Clear rubble, spin for wild guns,
           chew Bubblegum, and grab the loot the dead drop. Every run earns
           <b>Essence</b> — spend it below to come back stronger.</p>
        <div class="bestline" id="best-line"></div>
        <div class="meta" id="meta-shop"></div>
        <div class="controls">
          <span class="k">WASD</span><span>Move</span>
          <span class="k">Mouse</span><span>Aim</span>
          <span class="k">Click</span><span>Fire</span>
          <span class="k">R</span><span>Reload</span>
          <span class="k">E</span><span>Buy / interact</span>
          <span class="k">Q</span><span>Swap weapon</span>
          <span class="k">P</span><span>Pause</span>
          <span class="k">M</span><span>Mute</span>
        </div>
        <button class="play" id="btn-start">Play Solo</button>
        <div class="coop">
          <button class="coop-btn" id="btn-host">Host Co-op</button>
          <div class="join-row">
            <input id="join-code" maxlength="4" placeholder="CODE" autocomplete="off" />
            <button class="coop-btn" id="btn-join">Join</button>
          </div>
        </div>
        <div class="lobby-status" id="lobby-status"></div>
      </div>

      <div class="overlay hidden" id="overlay-over">
        <h1>YOU <span class="dead">DIED</span></h1>
        <div class="overStats" id="over-stats"></div>
        <div class="over-buttons">
          <button class="play" id="btn-restart">Again</button>
          <button class="coop-btn" id="btn-menu">Upgrades</button>
        </div>
      </div>

      <div class="overlay levelup hidden" id="overlay-levelup">
        <div class="lvl-burst" id="lvl-burst"></div>
        <h1 class="lvl-title">LEVEL <span class="dead">UP</span><span class="lvl-num" id="lvl-num"></span></h1>
        <p class="lvl-sub">Choose your upgrade — <span class="key">1</span><span class="key">2</span><span class="key">3</span> or click</p>
        <div class="cards" id="levelup-cards"></div>
        <div class="lvl-foot">
          <button class="reroll" id="btn-reroll"><span class="rr-ico">🎲</span> <span id="rr-label">Reroll</span></button>
        </div>
      </div>
    `;

    this.roundEl = this.q("#hud-round");
    this.pointsEl = this.q("#hud-points");
    this.healthFill = this.q("#hud-health");
    this.weaponName = this.q("#hud-weapon-name");
    this.weaponAmmo = this.q("#hud-ammo");
    this.promptEl = this.q("#prompt");
    this.toastEl = this.q("#toast");
    this.powerupsEl = this.q("#hud-powerups");
    this.startOverlay = this.q("#overlay-start");
    this.overOverlay = this.q("#overlay-over");
    this.overStats = this.q("#over-stats");
  }

  private q(sel: string): HTMLElement {
    const el = this.root.querySelector(sel);
    if (!el) throw new Error(`HUD element missing: ${sel}`);
    return el as HTMLElement;
  }

  onStart(cb: () => void) {
    this.q("#btn-start").addEventListener("click", cb);
  }
  onRestart(cb: () => void) {
    this.q("#btn-restart").addEventListener("click", cb);
  }
  onMenu(cb: () => void) {
    this.q("#btn-menu").addEventListener("click", cb);
  }
  onHost(cb: () => void) {
    this.q("#btn-host").addEventListener("click", cb);
  }

  /** Render the persistent best-run line on the menu. */
  setBest(round: number, score: number) {
    const el = this.q("#best-line");
    el.innerHTML = round > 0 ? `Best run · <b>Round ${round}</b> · ${score} pts` : "No runs yet — go make a mess.";
  }

  /** Render the meta-upgrade shop. `onBuy` fires with the chosen id. */
  renderMeta(essence: number, rows: MetaRow[], onBuy: (id: string) => void) {
    const shop = this.q("#meta-shop");
    shop.innerHTML = `
      <div class="meta-head"><span>Essence Shop</span><span class="essence">✦ ${essence}</span></div>
      <div class="meta-grid">
        ${rows
          .map(
            (r) => `<button class="meta-card ${r.owned ? "owned" : r.affordable ? "" : "locked"}" data-id="${r.id}" ${r.owned ? "disabled" : ""}>
              <span class="m-name">${r.name}</span>
              <span class="m-desc">${r.desc}</span>
              <span class="m-cost">${r.owned ? "OWNED" : `✦ ${r.cost}`}</span>
            </button>`,
          )
          .join("")}
      </div>`;
    shop.querySelectorAll<HTMLButtonElement>(".meta-card").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        if (id) onBuy(id);
      });
    });
  }

  /**
   * Show the level-up picker. Cards deal in with a stagger; picking pulses the
   * chosen card and dismisses the rest before `onPick` resumes the game.
   */
  showLevelUp(info: LevelUpInfo) {
    const overlay = this.q("#overlay-levelup");
    overlay.classList.remove("hidden");
    this.q("#lvl-num").textContent = info.level ? `Lv ${info.level}` : "";
    this.renderLevelCards(info);
    // replay the title/burst pop each time it opens (incl. rerolls)
    const burst = this.q("#lvl-burst");
    burst.classList.remove("go");
    void burst.offsetWidth; // reflow to restart the animation
    burst.classList.add("go");
  }

  /** (Re)render just the cards + reroll button — used on open and on reroll. */
  private renderLevelCards(info: LevelUpInfo) {
    const wrap = this.q("#levelup-cards");
    wrap.innerHTML = info.cards
      .map(
        (c, i) => `<button class="card ${c.tier}" data-id="${c.id}" style="--accent:${c.color}; --i:${i}">
          <span class="c-tier">${c.tier}</span>
          <span class="c-key">${i + 1}</span>
          <span class="c-icon">${c.icon}</span>
          <span class="c-name">${c.name}</span>
          <span class="c-desc">${c.desc}</span>
          <span class="c-stats">${c.deltas
            .map((d) => `<span class="c-stat"><b>${d.label}</b> ${d.from} <i>→</i> <em>${d.to}</em></span>`)
            .join("")}</span>
        </button>`,
      )
      .join("");

    const lock = () => wrap.classList.contains("locked");
    wrap.classList.remove("locked");
    wrap.querySelectorAll<HTMLButtonElement>(".card").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (lock()) return;
        const id = btn.dataset.id;
        if (!id) return;
        // selection juice: chosen card pops, the others fall away
        wrap.classList.add("locked");
        btn.classList.add("chosen");
        wrap.querySelectorAll(".card").forEach((o) => o !== btn && o.classList.add("gone"));
        info.onPick(id);
      });
    });

    const rr = this.q("#btn-reroll") as HTMLButtonElement;
    rr.classList.toggle("disabled", !info.canReroll);
    this.q("#rr-label").textContent = info.rerollCost > 0 ? `Reroll · ${info.rerollCost} pts` : "Reroll";
    rr.onclick = () => {
      if (!info.canReroll || lock()) return;
      info.onReroll();
    };
  }

  /** Pick a card by index (keyboard 1/2/3). Returns the chosen id or null. */
  pickLevelByIndex(i: number): boolean {
    const cards = this.q("#levelup-cards").querySelectorAll<HTMLButtonElement>(".card");
    const btn = cards[i];
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  }
  triggerReroll() {
    const rr = this.q("#btn-reroll") as HTMLButtonElement;
    if (!rr.classList.contains("disabled")) rr.click();
  }
  hideLevelUp() {
    this.q("#overlay-levelup").classList.add("hidden");
    this.q("#levelup-cards").classList.remove("locked");
  }

  /** Boss health bar (0 = hide). */
  setBoss(name: string, frac: number) {
    const el = this.q("#hud-boss");
    el.classList.remove("hidden");
    this.q("#hud-boss-name").textContent = name;
    this.q("#hud-boss-fill").style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
  }
  hideBoss() {
    this.q("#hud-boss").classList.add("hidden");
  }
  onJoin(cb: (code: string) => void) {
    this.q("#btn-join").addEventListener("click", () => {
      cb((this.q("#join-code") as HTMLInputElement).value);
    });
  }
  setLobbyStatus(msg: string) {
    this.q("#lobby-status").textContent = msg;
  }
  showRoomCode(code: string) {
    this.q("#hud-room-code").textContent = code;
    this.q("#hud-room").classList.remove("hidden");
  }
  hideRoomCode() {
    this.q("#hud-room").classList.add("hidden");
  }

  setRound(n: number) {
    this.roundEl.textContent = String(n);
  }
  setPoints(p: number) {
    this.pointsEl.textContent = String(p);
  }
  setHealth(hp: number, max: number) {
    const pct = Math.max(0, Math.min(1, hp / max));
    this.healthFill.style.width = `${pct * 100}%`;
    this.healthFill.classList.toggle("low", pct < 0.35);
  }
  /** Show the kill-combo multiplier (0 = hide). `frac` drains the bar. */
  setCombo(mult: number, frac: number) {
    const el = this.q("#hud-combo");
    if (mult <= 1) {
      el.classList.remove("show");
      return;
    }
    el.classList.add("show");
    this.q("#hud-combo-x").textContent = `x${mult % 1 === 0 ? mult : mult.toFixed(2).replace(/0$/, "")}`;
    this.q("#hud-combo-fill").style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
  }
  setPowerups(list: ActiveGum[]) {
    this.powerupsEl.innerHTML = list
      .map((a) => {
        const c = `#${a.def.color.toString(16).padStart(6, "0")}`;
        return `<span class="gum" style="--gc:${c}">${a.def.short} <b>${Math.ceil(a.remaining)}s</b></span>`;
      })
      .join("");
  }
  setWeapon(name: string, ammo: number, reserve: string, reloading: boolean) {
    this.weaponName.textContent = name;
    this.weaponAmmo.textContent = String(ammo);
    this.q("#hud-reserve").textContent = reserve;
    this.q("#hud-reloading").textContent = reloading ? "RELOADING…" : "";
  }

  showPrompt(text: string, affordable: boolean) {
    this.promptEl.textContent = text;
    this.promptEl.classList.add("show");
    this.promptEl.classList.toggle("cant", !affordable);
  }
  hidePrompt() {
    this.promptEl.classList.remove("show");
  }

  toast(msg: string) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add("show");
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove("show"), 1400);
  }

  showStart() {
    this.startOverlay.classList.remove("hidden");
  }
  hideStart() {
    this.startOverlay.classList.add("hidden");
  }

  showGameOver(round: number, points: number, essenceEarned: number, newBest: boolean) {
    this.overStats.innerHTML = `
      ${newBest ? '<p class="stat newbest">★ NEW BEST ★</p>' : ""}
      <p class="stat">Reached Round ${round}</p>
      <p class="stat">${points} points banked</p>
      <p class="stat essence-earn">+${essenceEarned} ✦ Essence earned</p>`;
    this.overOverlay.classList.remove("hidden");
  }
  hideGameOver() {
    this.overOverlay.classList.add("hidden");
  }
}
