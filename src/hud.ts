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

/** A cosmetic skin row for the skins tab. */
export interface SkinRow {
  id: string;
  name: string;
  body: number;
  head: number;
  cost: number;
  owned: boolean;
  equipped: boolean;
  affordable: boolean;
}

/** A challenge row for the challenges tab. */
export interface ChallengeRow {
  name: string;
  desc: string;
  reward: number;
  progress: number;
  goal: number;
  done: boolean;
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
  // Cached last-rendered values so the per-frame HUD updates skip redundant
  // string building + DOM writes (these methods are called every frame).
  private _cPoints = NaN;
  private _cHpPct = -1;
  private _cWeapon = "";
  private _cAmmo = -1;
  private _cReserve = "";
  private _cReloading = false;
  private _cComboMult = -1;
  private _cComboFrac = -1;
  private _cPowerSig = "";

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
      <div id="island-bar" class="hidden">
        <span class="island-tip">🏝️ Walk up to a glowing pad · <b>E</b> to use</span>
        <button class="coop-btn" id="btn-leave-island">Leave Island</button>
      </div>
      <div id="build-bar" class="hidden"></div>

      <div class="overlay" id="overlay-start">
        <h1>TINY <span class="dead">DEAD</span></h1>
        <p>A cozy little world. Ten flavors of undead — from shamblers to
           armored hulks and the Abomination. Clear rubble, spin for wild guns,
           chew Bubblegum, and grab the loot the dead drop. Every run earns
           <b>Essence</b> — spend it below to come back stronger.</p>
        <div class="bestline" id="best-line"></div>
        <div class="shop">
          <div class="shop-bar">
            <div class="shop-tabs">
              <button class="shop-tab active" data-tab="upgrades">Upgrades</button>
              <button class="shop-tab" data-tab="skins">Skins</button>
              <button class="shop-tab" data-tab="challenges">Challenges</button>
              <button class="shop-tab" data-tab="market">Market</button>
              <button class="shop-tab" data-tab="pets">Pets</button>
            </div>
            <span class="shop-essence">✦ <span id="essence-bal">0</span></span>
          </div>
          <div class="tab" id="tab-upgrades"></div>
          <div class="tab hidden" id="tab-skins"></div>
          <div class="tab hidden" id="tab-challenges"></div>
          <div class="tab hidden" id="tab-market"></div>
          <div class="tab hidden" id="tab-pets"></div>
        </div>
        <div class="controls">
          <span class="k">WASD</span><span>Move</span>
          <span class="k">Mouse</span><span>Aim</span>
          <span class="k">Click</span><span>Fire</span>
          <span class="k">R</span><span>Reload</span>
          <span class="k">E</span><span>Buy / interact</span>
          <span class="k">Q</span><span>Swap weapon</span>
          <span class="k">P</span><span>Pause</span>
          <span class="k">M</span><span>Mute</span>
          <span class="k">F</span><span>Nuke (when charged)</span>
          <span class="k">T</span><span>Emote (island)</span>
          <span class="k">R</span><span>Rotate part (build)</span>
          <span class="k">Z</span><span>Undo (build)</span>
        </div>
        <button class="play" id="btn-island">🏝️ Enter Island</button>
        <button class="play secondary" id="btn-start">Play Solo</button>
        <div class="coop">
          <button class="coop-btn" id="btn-host">Host Co-op</button>
          <div class="join-row">
            <input id="join-code" maxlength="4" placeholder="CODE" autocomplete="off" />
            <button class="coop-btn" id="btn-join">Join</button>
          </div>
        </div>
        <div class="lobby-status" id="lobby-status"></div>
        <div class="wallet-row">
          <button class="coop-btn wallet" id="btn-wallet">Connect Wallet</button>
          <span class="wallet-bal" id="wallet-bal"></span>
        </div>
        <div class="wallet-row claim-row hidden" id="claim-row">
          <button class="coop-btn" id="btn-claim">Claim $TOKEN</button>
          <button class="link-btn" id="btn-token-api" title="Token reward backend">⚙</button>
          <span class="wallet-bal" id="claim-status"></span>
        </div>
        <button class="link-btn" id="btn-server">⚙ Co-op server</button>
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

    // menu shop tab switching
    this.root.querySelectorAll<HTMLButtonElement>(".shop-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.tab!;
        this.root.querySelectorAll(".shop-tab").forEach((b) => b.classList.toggle("active", b === btn));
        for (const name of ["upgrades", "skins", "challenges", "market", "pets"]) {
          this.q(`#tab-${name}`).classList.toggle("hidden", name !== tab);
        }
      });
    });
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
  onIsland(cb: () => void) {
    this.q("#btn-island").addEventListener("click", cb);
  }
  /** Toggle the on-island HUD affordances (a small "leave island" control). */
  setIslandMode(on: boolean) {
    this.q("#island-bar").classList.toggle("hidden", !on);
  }
  onLeaveIsland(cb: () => void) {
    this.q("#btn-leave-island").addEventListener("click", cb);
  }
  /** Bring the menu/shop overlay back up (used by the island Shop pad). */
  openShop() {
    this.startOverlay.classList.remove("hidden");
  }
  /** Full build UI: category tabs + part chips + colour swatches + a tool row
   *  (rotate / paint / undo / done). Everything is an on-screen button so it
   *  works on touch as well as keyboard. */
  showBuildBar(opts: {
    cats: { id: string; label: string }[];
    parts: { kind: string; label: string; color: number; cat: string }[];
    swatches: number[];
    activeCat: string;
    activePart: string;
    activeColor: number | null;
    paint: boolean;
    onPickCat: (id: string) => void;
    onPickPart: (kind: string) => void;
    onPickColor: (color: number | null) => void;
    onRotate: () => void;
    onTogglePaint: () => void;
    onUndo: () => void;
    onDone: () => void;
  }) {
    const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
    const bar = this.q("#build-bar");
    bar.classList.remove("hidden");
    const tabs = opts.cats
      .map((c) => `<button class="build-tab ${c.id === opts.activeCat ? "active" : ""}" data-cat="${c.id}">${c.label}</button>`)
      .join("");
    const chips = opts.parts
      .filter((p) => p.cat === opts.activeCat)
      .map(
        (p) => `<button class="build-swatch ${p.kind === opts.activePart ? "active" : ""}" data-kind="${p.kind}"><span class="sw" style="background:${hex(p.color)}"></span>${p.label}</button>`,
      )
      .join("");
    const swatches =
      `<button class="build-color ${opts.activeColor === null ? "active" : ""}" data-color="auto" title="default colour">auto</button>` +
      opts.swatches
        .map((c) => `<button class="build-color ${c === opts.activeColor ? "active" : ""}" data-color="${c}" style="background:${hex(c)}"></button>`)
        .join("");
    const tools =
      `<button class="build-tool" data-tool="rotate">\u27f3 Rotate (R)</button>` +
      `<button class="build-tool ${opts.paint ? "active" : ""}" data-tool="paint">Paint</button>` +
      `<button class="build-tool" data-tool="undo">Undo</button>` +
      `<button class="build-tool done" data-tool="done">Done</button>`;
    bar.innerHTML =
      `<div class="build-tabs">${tabs}</div>` +
      `<div class="build-chips">${chips}</div>` +
      `<div class="build-colors">${swatches}</div>` +
      `<div class="build-tools">${tools}</div>`;
    bar.querySelectorAll<HTMLButtonElement>(".build-tab").forEach((b) =>
      b.addEventListener("click", () => opts.onPickCat(b.dataset.cat!)),
    );
    bar.querySelectorAll<HTMLButtonElement>(".build-swatch").forEach((b) =>
      b.addEventListener("click", () => { if (b.dataset.kind) opts.onPickPart(b.dataset.kind); }),
    );
    bar.querySelectorAll<HTMLButtonElement>(".build-color").forEach((b) =>
      b.addEventListener("click", () => opts.onPickColor(b.dataset.color === "auto" ? null : Number(b.dataset.color))),
    );
    bar.querySelectorAll<HTMLButtonElement>(".build-tool").forEach((b) =>
      b.addEventListener("click", () => {
        const t = b.dataset.tool;
        if (t === "rotate") opts.onRotate();
        else if (t === "paint") opts.onTogglePaint();
        else if (t === "undo") opts.onUndo();
        else if (t === "done") opts.onDone();
      }),
    );
  }
  hideBuildBar() {
    this.q("#build-bar").classList.add("hidden");
  }

  /** Pet picker for the "Pet Perch" part. */
  showPetPicker(pets: { id: string; name: string; color: string }[], active: string, onPick: (id: string) => void) {
    let box = document.getElementById("pet-picker");
    if (!box) {
      box = document.createElement("div");
      box.id = "pet-picker";
      this.root.appendChild(box);
    }
    box.style.display = "block";
    box.innerHTML =
      `<div class="pet-picker-title">Display pet</div>` +
      `<div class="pet-picker-row">` +
      pets
        .map((p) => `<button class="pet-pick ${p.id === active ? "active" : ""}" data-id="${p.id}" style="--chip:${p.color}">${p.name}</button>`)
        .join("") +
      `</div>`;
    box.querySelectorAll<HTMLButtonElement>(".pet-pick").forEach((b) =>
      b.addEventListener("click", () => {
        box!.querySelectorAll(".pet-pick").forEach((o) => o.classList.toggle("active", o === b));
        if (b.dataset.id) onPick(b.dataset.id);
      }),
    );
  }
  hidePetPicker() {
    const box = document.getElementById("pet-picker");
    if (box) box.style.display = "none";
  }

  /** "Tiny Home Academy" results card shown when leaving build mode. */
  showHouseRating(
    r: { score: number; grade: string; breakdown: { label: string; score: number; max: number; note: string }[] },
    onClose: () => void,
  ) {
    let ov = document.getElementById("house-rating");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "house-rating";
      this.root.appendChild(ov);
    }
    const lines = r.breakdown
      .map((b) => `<div class="hr-line"><span>${b.label}</span><b>${b.score}/${b.max}</b><small>${b.note}</small></div>`)
      .join("");
    ov.style.display = "flex";
    ov.innerHTML =
      `<div class="hr-card"><div class="hr-title">Tiny Home Academy</div>` +
      `<div class="hr-grade hr-${r.grade}">${r.grade}</div>` +
      `<div class="hr-score">${r.score} / 100</div>` +
      `<div class="hr-lines">${lines}</div>` +
      `<button class="hr-close">Nice!</button></div>`;
    (ov.querySelector(".hr-close") as HTMLButtonElement).addEventListener("click", () => {
      this.hideHouseRating();
      onClose();
    });
  }
  hideHouseRating() {
    const ov = document.getElementById("house-rating");
    if (ov) ov.style.display = "none";
  }

  /** "Likes/visits" chip shown while visiting a neighbour's plot. */
  showPlotMeta(likes: number, visits: number) {
    let el = document.getElementById("plot-meta");
    if (!el) {
      el = document.createElement("div");
      el.id = "plot-meta";
      this.root.appendChild(el);
    }
    el.style.display = "block";
    el.textContent = `\u2764 ${likes} \u00b7 ${visits} ${visits === 1 ? "visit" : "visits"} \u00b7 [L] like`;
  }
  hidePlotMeta() {
    const el = document.getElementById("plot-meta");
    if (el) el.style.display = "none";
  }

  /** Render the persistent best-run line on the menu. */
  setBest(round: number, score: number) {
    const el = this.q("#best-line");
    el.innerHTML = round > 0 ? `Best run · <b>Round ${round}</b> · ${score} pts` : "No runs yet — go make a mess.";
  }

  private setEssenceBalance(essence: number) {
    this.q("#essence-bal").textContent = String(essence);
  }

  /** Render the meta-upgrade shop tab. `onBuy` fires with the chosen id. */
  renderMeta(essence: number, rows: MetaRow[], onBuy: (id: string) => void) {
    this.setEssenceBalance(essence);
    const tab = this.q("#tab-upgrades");
    tab.innerHTML = `<div class="meta-grid">
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
    tab.querySelectorAll<HTMLButtonElement>(".meta-card").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        if (id) onBuy(id);
      });
    });
  }

  /** Render the cosmetic skins tab. Click = equip (if owned) or buy. */
  renderSkins(essence: number, rows: SkinRow[], onSelect: (id: string) => void) {
    this.setEssenceBalance(essence);
    const tab = this.q("#tab-skins");
    tab.innerHTML = `<div class="skin-grid">
        ${rows
          .map((r) => {
            const cls = r.equipped ? "equipped" : r.owned ? "owned" : r.affordable ? "" : "locked";
            const tag = r.equipped ? "EQUIPPED" : r.owned ? "EQUIP" : `✦ ${r.cost}`;
            const b = `#${r.body.toString(16).padStart(6, "0")}`;
            const h = `#${r.head.toString(16).padStart(6, "0")}`;
            return `<button class="skin-card ${cls}" data-id="${r.id}">
                <span class="skin-fig"><span class="skin-head" style="background:${h}"></span><span class="skin-body" style="background:${b}"></span></span>
                <span class="skin-name">${r.name}</span>
                <span class="skin-tag">${tag}</span>
              </button>`;
          })
          .join("")}
      </div>`;
    tab.querySelectorAll<HTMLButtonElement>(".skin-card").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        if (id) onSelect(id);
      });
    });
  }

  /** Render the challenges tab (read-only progress list). */
  renderChallenges(essence: number, rows: ChallengeRow[]) {
    this.setEssenceBalance(essence);
    this.q("#tab-challenges").innerHTML = `<div class="chal-list">
        ${rows
          .map((r) => {
            const pct = Math.max(0, Math.min(1, r.progress / r.goal)) * 100;
            return `<div class="chal ${r.done ? "done" : ""}">
                <div class="chal-top"><span class="chal-name">${r.name}</span><span class="chal-reward">${r.done ? "✓ CLAIMED" : `✦ ${r.reward}`}</span></div>
                <div class="chal-desc">${r.desc}</div>
                <div class="chal-bar"><div class="chal-fill" style="width:${pct}%"></div></div>
                <div class="chal-prog">${Math.min(r.progress, r.goal)} / ${r.goal}</div>
              </div>`;
          })
          .join("")}
      </div>`;
  }

  /** Market tab: sell tradable loot for gold. */
  renderMarket(
    gold: number,
    items: { id: string; name: string; rarity: string; gold: number; color: string }[],
    onSell: (id: string) => void,
    onSellAll: () => void,
  ) {
    const total = items.reduce((s, i) => s + i.gold, 0);
    const list = items.length
      ? items
          .map(
            (it) => `<button class="mkt-item" data-id="${it.id}" style="--rc:${it.color}">
              <span class="mkt-dot"></span>
              <span class="mkt-name">${it.name}</span>
              <span class="mkt-rar">${it.rarity}</span>
              <span class="mkt-gold">⛀ ${it.gold}</span>
            </button>`,
          )
          .join("")
      : `<div class="mkt-empty">No loot yet — kill zombies & bosses to find tradable items.</div>`;
    this.q("#tab-market").innerHTML = `
      <div class="mkt-head">
        <span>Gold: <b>⛀ ${gold}</b></span>
        ${items.length ? `<button class="mkt-sellall" id="mkt-sellall">Sell all (⛀ ${total})</button>` : ""}
      </div>
      <div class="mkt-list">${list}</div>
      <div class="mkt-note">Gold will be tradable for $TOKEN at launch.</div>`;
    this.q("#tab-market").querySelectorAll<HTMLButtonElement>(".mkt-item").forEach((btn) => {
      btn.addEventListener("click", () => onSell(btn.dataset.id!));
    });
    const sa = this.root.querySelector("#mkt-sellall");
    if (sa) sa.addEventListener("click", () => onSellAll());
  }

  /** Pets tab: buy companion pets with gold. */
  renderPets(
    gold: number,
    rows: { id: string; name: string; desc: string; cost: number; color: string; owned: boolean; level: number; upCost: number; affordable: boolean; rarity: string; rarityColor: string; ability?: string; trial?: { label: string; cur: number; goal: number; done: boolean }[] }[],
    onAction: (id: string) => void,
  ) {
    const order = ["common", "uncommon", "rare", "epic", "legendary", "mythic"];
    const label = (r: string) => r.charAt(0).toUpperCase() + r.slice(1);
    const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : `${n}`);
    const card = (r: (typeof rows)[number]) => {
      const cls = r.affordable ? "" : "locked";
      const action = r.owned ? `Lv ${r.level} → ⛀ ${r.upCost}` : `⛀ ${r.cost}`;
      const lvlBadge = r.owned ? `<span class="pet-lvl">Lv ${r.level}</span>` : "";
      const abilityTag = r.ability ? `<span class="pet-ability">✦ ${r.ability}</span>` : "";
      let trialBlock = "";
      if (r.trial && r.trial.length) {
        const allDone = r.trial.every((t) => t.done);
        const goals = r.trial
          .map((t) => {
            const pct = Math.max(0, Math.min(100, (t.cur / t.goal) * 100));
            return `<div class="pet-goal ${t.done ? "done" : ""}">
              <span class="pet-goal-row"><span>${t.done ? "✓" : "◦"} ${t.label}</span><span>${fmt(t.cur)}/${fmt(t.goal)}</span></span>
              <span class="pet-goal-bar"><span style="width:${pct}%"></span></span>
            </div>`;
          })
          .join("");
        trialBlock = `<div class="pet-trial ${allDone ? "ready" : ""}">
          <span class="pet-trial-head">${allDone ? "✦ EVOLUTION READY" : "Evolution Trial"}</span>${goals}
        </div>`;
      }
      return `<button class="pet-card ${r.owned ? "owned" : ""} ${cls}" data-id="${r.id}" style="--pc:${r.color};--rc:${r.rarityColor}">
        <span class="pet-dot"></span>${lvlBadge}
        <span class="pet-name">${r.name}</span>
        <span class="pet-desc">${r.desc}</span>
        ${abilityTag}
        <span class="pet-cost">${action}</span>
        ${trialBlock}
      </button>`;
    };
    // Group into rarity sections so a deep roster stays browsable.
    const ownedCount = rows.filter((r) => r.owned).length;
    const sections = order
      .map((rar) => ({ rar, items: rows.filter((r) => (r.rarity || "common") === rar) }))
      .filter((g) => g.items.length)
      .map(
        (g) => `
        <div class="pet-rarity-head" style="--rc:${g.items[0].rarityColor}">${label(g.rar)}
          <span class="pet-rarity-count">${g.items.filter((i) => i.owned).length}/${g.items.length}</span>
        </div>
        <div class="pets-grid">${g.items.map(card).join("")}</div>`,
      )
      .join("");
    this.q("#tab-pets").innerHTML = `
      <div class="mkt-head"><span>Gold: <b>⛀ ${gold}</b></span><span class="pets-hint">Collected ${ownedCount}/${rows.length} · level up with gold</span></div>
      ${sections}`;
    this.q("#tab-pets").querySelectorAll<HTMLButtonElement>(".pet-card").forEach((btn) => {
      btn.addEventListener("click", () => onAction(btn.dataset.id!));
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
  onServer(cb: () => void) {
    this.q("#btn-server").addEventListener("click", cb);
  }
  onWallet(cb: () => void) {
    this.q("#btn-wallet").addEventListener("click", cb);
  }
  /** Wire the Claim button + the token-backend config gear. */
  onClaim(onClaim: () => void, onConfig: () => void) {
    this.q("#btn-claim").addEventListener("click", onClaim);
    this.q("#btn-token-api").addEventListener("click", onConfig);
  }
  setClaimStatus(text: string) {
    this.q("#claim-status").textContent = text;
  }
  /** Reflect wallet connection state on the menu button + balance chip. */
  setWallet(connected: boolean, short: string, balanceLabel: string) {
    this.q("#btn-wallet").textContent = connected ? short : "Connect Wallet";
    this.q("#btn-wallet").classList.toggle("connected", connected);
    this.q("#wallet-bal").textContent = connected ? balanceLabel : "";
    // the claim row only makes sense once a wallet is linked
    this.q("#claim-row").classList.toggle("hidden", !connected);
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
    if (p === this._cPoints) return;
    this._cPoints = p;
    this.pointsEl.textContent = String(p);
  }
  setHealth(hp: number, max: number) {
    const pct = Math.max(0, Math.min(1, hp / max));
    if (Math.abs(pct - this._cHpPct) < 0.005) return; // skip sub-pixel changes
    this._cHpPct = pct;
    this.healthFill.style.width = `${pct * 100}%`;
    this.healthFill.classList.toggle("low", pct < 0.35);
  }
  /** Show the kill-combo multiplier (0 = hide). `frac` drains the bar. */
  setCombo(mult: number, frac: number) {
    if (mult <= 1) {
      if (this._cComboMult !== 0) {
        this._cComboMult = 0;
        this.q("#hud-combo").classList.remove("show");
      }
      return;
    }
    if (mult !== this._cComboMult) {
      this._cComboMult = mult;
      this.q("#hud-combo").classList.add("show");
      this.q("#hud-combo-x").textContent = `x${mult % 1 === 0 ? mult : mult.toFixed(2).replace(/0$/, "")}`;
    }
    const fr = Math.round(frac * 50); // ~2% steps — avoid a DOM write every frame
    if (fr !== this._cComboFrac) {
      this._cComboFrac = fr;
      this.q("#hud-combo-fill").style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
    }
  }
  setPowerups(list: ActiveGum[]) {
    // signature = ids + whole seconds remaining; only rebuild when it changes
    let sig = "";
    for (const a of list) sig += a.def.short + Math.ceil(a.remaining) + ",";
    if (sig === this._cPowerSig) return;
    this._cPowerSig = sig;
    this.powerupsEl.innerHTML = list
      .map((a) => {
        const c = `#${a.def.color.toString(16).padStart(6, "0")}`;
        return `<span class="gum" style="--gc:${c}">${a.def.short} <b>${Math.ceil(a.remaining)}s</b></span>`;
      })
      .join("");
  }
  setWeapon(name: string, ammo: number, reserve: string, reloading: boolean) {
    if (name === this._cWeapon && ammo === this._cAmmo && reserve === this._cReserve && reloading === this._cReloading) return;
    if (name !== this._cWeapon) {
      this._cWeapon = name;
      this.weaponName.textContent = name;
    }
    if (ammo !== this._cAmmo) {
      this._cAmmo = ammo;
      this.weaponAmmo.textContent = String(ammo);
    }
    if (reserve !== this._cReserve) {
      this._cReserve = reserve;
      this.q("#hud-reserve").textContent = reserve;
    }
    if (reloading !== this._cReloading) {
      this._cReloading = reloading;
      this.q("#hud-reloading").textContent = reloading ? "RELOADING…" : "";
    }
  }

  showPrompt(text: string, affordable: boolean) {
    this.promptEl.textContent = text;
    this.promptEl.classList.add("show");
    this.promptEl.classList.toggle("cant", !affordable);
  }
  hidePrompt() {
    this.promptEl.classList.remove("show");
  }

  private popEl?: HTMLElement;
  /** "N players here" social chip on the island; pass <= 0 to hide it. */
  setIslandPopulation(n: number) {
    if (!this.popEl) {
      this.popEl = document.createElement("div");
      this.popEl.className = "island-pop";
      this.root.appendChild(this.popEl);
    }
    if (n <= 0) {
      this.popEl.style.display = "none";
      return;
    }
    this.popEl.style.display = "block";
    this.popEl.textContent = `🟢 ${n} ${n === 1 ? "player" : "players"} here`;
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

  /**
   * Co-op spectator overlay shown to a GUEST whose player has died while the
   * run continues on the host (the host-only gameOver never fires for them, so
   * without this they're stuck in "playing" with no UI and no way out).
   *
   * Idempotent — safe to call every frame while down; only (re)wires the exit
   * button on first show. `onExit` should tear down the net session and return
   * to the menu. Pair with hideGuestDown() when the guest revives or leaves.
   */
  showGuestDown(onExit: () => void) {
    let ov = document.getElementById("guest-down");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "guest-down";
      ov.style.cssText =
        "position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;" +
        "justify-content:center;gap:18px;background:rgba(8,10,16,0.62);z-index:50;" +
        "font-family:inherit;color:#f4f4f4;text-align:center;pointer-events:auto;";
      ov.innerHTML =
        `<div style="font-size:34px;font-weight:800;letter-spacing:1px;">You're down</div>` +
        `<div style="opacity:0.85;">Spectating your team — hang tight or bail out.</div>` +
        `<button id="btn-guest-exit" style="margin-top:6px;padding:12px 26px;font:inherit;` +
        `font-weight:700;cursor:pointer;border:none;border-radius:10px;` +
        `background:#e06a4a;color:#fff;">Exit to menu</button>`;
      this.root.appendChild(ov);
      (ov.querySelector("#btn-guest-exit") as HTMLButtonElement).addEventListener("click", () => {
        this.hideGuestDown();
        onExit();
      });
    }
    ov.style.display = "flex";
  }
  hideGuestDown() {
    const ov = document.getElementById("guest-down");
    if (ov) ov.style.display = "none";
  }

  // ── special-round banner + curse slider (added at end of class) ──
  private bannerEl?: HTMLElement;
  private bannerTimer?: number;
  /**
   * Loud, centered round banner for special rounds / difficulty tiers. `color`
   * is any CSS color (used for the glow + underline). Auto-dismisses after a
   * couple seconds; calling again retriggers the pop.
   */
  showRoundBanner(name: string, color: string) {
    if (!this.bannerEl) {
      this.bannerEl = document.createElement("div");
      this.bannerEl.id = "round-banner";
      this.root.appendChild(this.bannerEl);
    }
    const el = this.bannerEl;
    el.style.cssText =
      "position:fixed;left:0;right:0;top:22%;text-align:center;z-index:40;pointer-events:none;" +
      "font-family:inherit;font-weight:900;font-size:min(11vw,84px);letter-spacing:3px;" +
      `color:${color};text-shadow:0 0 18px ${color},0 3px 0 rgba(0,0,0,0.55);` +
      "transition:opacity .25s,transform .25s;opacity:0;transform:scale(0.82);";
    el.textContent = name;
    // force a reflow so the entrance transition fires on retrigger
    void el.offsetWidth;
    el.style.opacity = "1";
    el.style.transform = "scale(1)";
    if (this.bannerTimer) clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "scale(1.12)";
    }, 1900);
  }

  private tintEl?: HTMLElement;
  /** Full-screen mood tint for special rounds (pass null to clear). A soft
   *  radial vignette in the given CSS color — cheap, no shader work. */
  setScreenTint(color: string | null) {
    if (!this.tintEl) {
      this.tintEl = document.createElement("div");
      this.tintEl.id = "round-tint";
      this.tintEl.style.cssText =
        "position:fixed;inset:0;z-index:5;pointer-events:none;opacity:0;" +
        "transition:opacity .6s;mix-blend-mode:multiply;";
      this.root.appendChild(this.tintEl);
    }
    if (!color) {
      this.tintEl.style.opacity = "0";
      return;
    }
    this.tintEl.style.background = `radial-gradient(ellipse at center, transparent 38%, ${color} 140%)`;
    this.tintEl.style.opacity = "0.55";
  }

  private curseValEl?: HTMLElement;
  private curseCb?: (dir: number) => void;
  /**
   * Risk→reward Curse slider, shown in the in-game HUD (top area, by the round
   * pill). `onAdjust(dir)` fires with -1/+1 when the player nudges it between
   * rounds; the game clamps + reflects the new value via setCurse().
   */
  buildCurseSlider(onAdjust: (dir: number) => void) {
    this.curseCb = onAdjust;
    let box = document.getElementById("curse-slider");
    if (!box) {
      box = document.createElement("div");
      box.id = "curse-slider";
      box.style.cssText =
        "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:12;" +
        "display:none;align-items:center;gap:6px;font-family:inherit;font-weight:700;" +
        "background:rgba(18,12,20,0.62);border:1px solid #c0452f;border-radius:999px;" +
        "padding:4px 8px;color:#ffb3a3;font-size:13px;";
      box.innerHTML =
        `<button id="curse-dn" style="width:22px;height:22px;border:none;border-radius:50%;` +
        `cursor:pointer;font:inherit;font-weight:900;background:#3a2228;color:#ffb3a3;">−</button>` +
        `<span style="opacity:0.85;">☠ Curse</span><span id="curse-val">1.0×</span>` +
        `<button id="curse-up" style="width:22px;height:22px;border:none;border-radius:50%;` +
        `cursor:pointer;font:inherit;font-weight:900;background:#5a1f1f;color:#ffd0c0;">+</button>`;
      this.root.appendChild(box);
      (box.querySelector("#curse-dn") as HTMLButtonElement).addEventListener("click", () => this.curseCb?.(-1));
      (box.querySelector("#curse-up") as HTMLButtonElement).addEventListener("click", () => this.curseCb?.(1));
    }
    this.curseValEl = box.querySelector("#curse-val") as HTMLElement;
  }
  /** Reflect the current curse value + reward multiplier on the slider chip. */
  setCurse(value: number, rewardMul: number) {
    if (this.curseValEl) this.curseValEl.textContent = `${value.toFixed(2)}× · +${Math.round((rewardMul - 1) * 100)}%`;
  }
  /** Show/hide the curse slider (shown during intermissions / pre-round only). */
  setCurseVisible(on: boolean) {
    const box = document.getElementById("curse-slider");
    if (box) box.style.display = on ? "flex" : "none";
  }
}
